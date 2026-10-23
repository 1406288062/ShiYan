import Foundation
import AVFoundation
import Darwin

/// A Dots call owns playback; presentation changes never own its lifetime.
/// MLX stays in the interview project's Python environment, outside the app's
/// bundled Python. Utterance interruption keeps it warm within a call; ending
/// the call tears it down immediately, including while Metal is generating.
final class QwenVoicePlaybackController {
    var emit: (([String: Any]) -> Void)?
    private var worker: Process?
    private var input: Pipe?
    private var output: Pipe?
    private var errors: Pipe?
    private let ioQueue = DispatchQueue(label: "shiyan.qwen.protocol")
    private var sessionID: String?
    private var requestID: String?
    private var engine: AVAudioEngine?
    private var player: AVAudioPlayerNode?
    private var scheduled = 0
    private var synthesisDone = false
    private var didStart = false
    private var timeout: DispatchWorkItem?
    private var idleRelease: DispatchWorkItem?
    private var lastLevelTime: TimeInterval = 0

    func prepare() {
        do {
            let started = try ensureWorker()
            if started { send(["action": "warmup"]) }
            scheduleIdleRelease()
        } catch {
            // Report configuration errors through speak(), which has a session
            // to receive them; preparing must not disrupt microphone capture.
        }
    }

    func speak(_ text: String, sessionID: String) {
        cancel()
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else {
            emit?(["type": "voicePlaybackState", "sessionId": sessionID,
                   "state": "finished", "isSpeaking": false])
            return
        }
        self.sessionID = sessionID
        let identifier = UUID().uuidString
        requestID = identifier
        synthesisDone = false
        do {
            _ = try ensureWorker()
            idleRelease?.cancel(); idleRelease = nil
            emitState("preparing", speaking: false)
            armTimeout(seconds: 120, identifier: identifier)
            send(["action": "speak", "id": identifier, "text": String(clean.prefix(20_000))])
        } catch {
            fail(error.localizedDescription)
        }
    }

    func cancel(sessionID expected: String? = nil) {
        if let expected = expected, expected != sessionID { return }
        let previous = sessionID
        let previousRequest = requestID
        requestID = nil; sessionID = nil
        stopAudio()
        if let previousRequest = previousRequest { send(["action": "cancel", "id": previousRequest]) }
        if let previous = previous {
            emit?(["type": "voicePlaybackLevel", "sessionId": previous, "level": 0.0])
            emit?(["type": "voicePlaybackState", "sessionId": previous,
                   "state": "cancelled", "isSpeaking": false])
        }
        scheduleIdleRelease()
    }

    func shutdown(waitForExit: Bool = false) {
        cancel()
        stopWorker(waitForExit: waitForExit)
    }

    private func ensureWorker() throws -> Bool {
        if worker?.isRunning == true { return false }
        let files = FileManager.default
        let home = files.homeDirectoryForCurrentUser
        let env = ProcessInfo.processInfo.environment
        let candidates = [env["SHIYAN_INTERVIEW_PROJECT"],
                          home.appendingPathComponent("claude code/resume-interview-coach").path,
                          home.appendingPathComponent("codex/resume-interview-coach").path,
                          home.appendingPathComponent("IdeaProjects/resume-interview-coach").path].compactMap { $0 }
        let project = candidates.first { files.isExecutableFile(atPath: $0 + "/server/.venv/bin/python") }
        let python = env["SHIYAN_TTS_PYTHON"] ?? project.map { $0 + "/server/.venv/bin/python" }
        guard let python = python, files.isExecutableFile(atPath: python) else {
            throw problem("未找到面试项目现有的 Qwen3-TTS 运行环境，请检查本地项目目录。")
        }
        let configuredScript = env["SHIYAN_TTS_WORKER"]
        let script = configuredScript.map { URL(fileURLWithPath: $0) }
            ?? Bundle.main.resourceURL?.appendingPathComponent("app/desktop_backend/qwen_tts_worker.py")
        guard let script = script, files.fileExists(atPath: script.path) else {
            throw problem("拾燕本地语音组件缺失，请重新安装当前版本。")
        }
        let process = Process()
        let stdin = Pipe(), stdout = Pipe(), stderr = Pipe()
        process.executableURL = URL(fileURLWithPath: python)
        process.arguments = ["-B", "-u", script.path]
        var environment = env
        environment.removeValue(forKey: "PYTHONHOME")
        environment.removeValue(forKey: "PYTHONPATH")
        environment["HF_HUB_OFFLINE"] = "1"
        environment["TRANSFORMERS_OFFLINE"] = "1"
        environment["TOKENIZERS_PARALLELISM"] = "false"
        if let project = project { environment["SHIYAN_INTERVIEW_PROJECT"] = project }
        process.environment = environment
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = stderr
        var received = Data()
        stdout.fileHandleForReading.readabilityHandler = { [weak self, weak process] handle in
            let bytes = handle.availableData
            guard !bytes.isEmpty, let self = self, let process = process else { return }
            self.ioQueue.async { [weak self, weak process] in
                guard let self = self, let process = process else { return }
                received.append(bytes)
                if received.count > 2_000_000 {
                    received.removeAll()
                    DispatchQueue.main.async { [weak self, weak process] in
                        guard let self = self, self.worker === process else { return }
                        self.fail("本地语音数据异常，请重试。")
                        self.stopWorker()
                    }
                    return
                }
                while let end = received.firstIndex(of: 10) {
                    let line = received.subdata(in: received.startIndex..<end)
                    received.removeSubrange(received.startIndex...end)
                    guard let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
                    DispatchQueue.main.async { [weak self, weak process] in
                        guard let self = self, self.worker === process else { return }
                        self.accept(object)
                    }
                }
            }
        }
        // Always drain MLX diagnostics so stderr cannot back-pressure audio.
        stderr.fileHandleForReading.readabilityHandler = { handle in _ = handle.availableData }
        process.terminationHandler = { [weak self] process in
            DispatchQueue.main.async {
                guard let self = self, self.worker === process else { return }
                self.worker = nil
                self.closePipes()
                if self.requestID != nil { self.fail("本地 Qwen3-TTS 已停止，请重试语音通话。") }
            }
        }
        worker = process; input = stdin; output = stdout; errors = stderr
        do { try process.run() }
        catch { worker = nil; closePipes(); throw problem("无法启动本地 Qwen3-TTS：\(error.localizedDescription)") }
        return true
    }

    private func send(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object),
              let input = input, let process = worker, process.isRunning else { return }
        ioQueue.async {
            guard process.isRunning else { return }
            do { try input.fileHandleForWriting.write(contentsOf: data + Data([10])) }
            catch { /* Process termination is handled by its termination handler. */ }
        }
    }

    private func accept(_ object: [String: Any]) {
        guard let identifier = object["id"] as? String, identifier == requestID else { return }
        switch object["type"] as? String {
        case "audio":
            guard let encoded = object["pcm"] as? String, encoded.count <= 300_000,
                  let bytes = Data(base64Encoded: encoded), bytes.count > 0, bytes.count % 2 == 0,
                  let rate = object["sampleRate"] as? Int, (8_000...96_000).contains(rate) else {
                fail("本地语音音频格式无效。")
                return
            }
            do { try schedule(bytes, rate: rate, identifier: identifier) }
            catch { fail("无法播放本地语音：\(error.localizedDescription)"); return }
            armTimeout(seconds: 45, identifier: identifier)
        case "done":
            synthesisDone = true
            timeout?.cancel(); timeout = nil
            finishIfDrained()
        case "error": fail(object["message"] as? String ?? "本地语音生成失败。")
        case "cancelled": break // Only local cancel changes the active UI state.
        default: break
        }
    }

    private func schedule(_ pcm: Data, rate: Int, identifier: String) throws {
        if engine == nil {
            let engine = AVAudioEngine()
            let player = AVAudioPlayerNode()
            guard let format = AVAudioFormat(standardFormatWithSampleRate: Double(rate), channels: 1) else {
                throw problem("不支持当前音频采样率。")
            }
            engine.attach(player)
            engine.connect(player, to: engine.mainMixerNode, format: format)
            lastLevelTime = 0
            player.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
                guard let samples = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return }
                var sum: Float = 0
                for i in 0..<Int(buffer.frameLength) { sum += samples[i] * samples[i] }
                let level = min(1.0, Double(sqrt(sum / Float(buffer.frameLength))) * 5.5)
                DispatchQueue.main.async { [weak self] in
                    guard let self = self, self.requestID == identifier, let id = self.sessionID else { return }
                    let now = Date.timeIntervalSinceReferenceDate
                    guard now - self.lastLevelTime >= 1.0 / 30.0 else { return }
                    self.lastLevelTime = now
                    self.emit?(["type": "voicePlaybackLevel", "sessionId": id, "level": level])
                }
            }
            engine.prepare()
            try engine.start()
            self.engine = engine; self.player = player
        }
        guard let player = player,
              let format = AVAudioFormat(standardFormatWithSampleRate: Double(rate), channels: 1),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(pcm.count / 2)),
              let destination = buffer.floatChannelData?[0] else { throw problem("无法创建语音缓冲。") }
        buffer.frameLength = buffer.frameCapacity
        pcm.withUnsafeBytes { raw in
            let bytes = raw.bindMemory(to: UInt8.self)
            for i in 0..<Int(buffer.frameLength) {
                let value = UInt16(bytes[i * 2]) | UInt16(bytes[i * 2 + 1]) << 8
                destination[i] = Float(Int16(bitPattern: value)) / 32768.0
            }
        }
        scheduled += 1
        player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            DispatchQueue.main.async { [weak self] in
                guard let self = self, self.requestID == identifier else { return }
                self.scheduled = max(0, self.scheduled - 1)
                self.send(["action": "consumed", "id": identifier])
                self.finishIfDrained()
            }
        }
        if !didStart {
            didStart = true
            player.play()
            emitState("speaking", speaking: true)
        }
    }

    private func finishIfDrained() {
        guard synthesisDone, scheduled == 0, requestID != nil else { return }
        if !didStart { fail("Qwen3-TTS 没有生成有效音频。"); return }
        let id = sessionID
        requestID = nil; sessionID = nil
        stopAudio()
        scheduleIdleRelease()
        if let id = id {
            emit?(["type": "voicePlaybackLevel", "sessionId": id, "level": 0.0])
            emitState("finished", speaking: false, session: id)
        }
    }

    private func emitState(_ state: String, speaking: Bool, message: String? = nil, session: String? = nil) {
        guard let id = session ?? sessionID else { return }
        var event: [String: Any] = ["type": "voicePlaybackState", "sessionId": id,
                                  "state": state, "isSpeaking": speaking,
                                  "voiceIdentifier": "Qwen3-TTS/Serena", "provider": "mlx-audio"]
        if let message = message { event["message"] = message }
        emit?(event)
    }

    private func fail(_ message: String) {
        if let identifier = requestID { send(["action": "cancel", "id": identifier]) }
        let id = sessionID
        requestID = nil; sessionID = nil
        stopAudio()
        scheduleIdleRelease()
        if let id = id {
            emit?(["type": "voicePlaybackLevel", "sessionId": id, "level": 0.0])
            emitState("failed", speaking: false, message: message, session: id)
        }
    }

    private func stopAudio() {
        timeout?.cancel(); timeout = nil
        player?.stop()
        if let player = player { player.removeTap(onBus: 0) }
        engine?.stop()
        player = nil; engine = nil
        scheduled = 0; synthesisDone = false; didStart = false
    }

    private func armTimeout(seconds: Double, identifier: String) {
        timeout?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self = self, self.requestID == identifier else { return }
            self.fail("本地语音生成超时，请重试语音通话。")
            self.stopWorker()
        }
        timeout = work
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
    }

    private func scheduleIdleRelease() {
        idleRelease?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self = self, self.requestID == nil else { return }
            self.stopWorker()
        }
        idleRelease = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 120, execute: work)
    }

    private func closePipes() {
        output?.fileHandleForReading.readabilityHandler = nil
        errors?.fileHandleForReading.readabilityHandler = nil
        try? input?.fileHandleForWriting.close()
        try? output?.fileHandleForReading.close()
        try? errors?.fileHandleForReading.close()
        input = nil; output = nil; errors = nil
    }

    private func stopWorker(waitForExit: Bool = false) {
        idleRelease?.cancel(); idleRelease = nil
        let previous = worker
        worker = nil
        closePipes()
        guard let previous = previous, previous.isRunning else { return }
        // A protocol shutdown alone waits for the next MLX yield, which can
        // leave the entire model in memory after hang-up. Terminate the owned
        // process now; bound cleanup even if a library traps SIGTERM.
        previous.terminate()
        let forceExit = {
            guard previous.isRunning else { return }
            kill(previous.processIdentifier, SIGKILL)
        }
        if waitForExit {
            // The app's main loop is about to stop; an async fallback would
            // never run. Keep this bounded so Quit cannot hang on inference.
            let deadline = Date().addingTimeInterval(0.2)
            while previous.isRunning && Date() < deadline {
                Thread.sleep(forTimeInterval: 0.01)
            }
            forceExit()
        } else {
            DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 0.2, execute: forceExit)
        }
    }

    private func problem(_ message: String) -> NSError {
        NSError(domain: "ShiYanQwenVoice", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
}
