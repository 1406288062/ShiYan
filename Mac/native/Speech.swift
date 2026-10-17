import Foundation
import AVFoundation
import Speech

 
 
 
 
struct SpeechHypothesisSegment {
    let text: String
    let range: NSRange
    let start: TimeInterval
    let duration: TimeInterval
    let confidence: Float
}

struct SpeechHypothesisSnapshot {
    private(set) var text = ""
    private(set) var revision = 0
    private(set) var overlappingSegmentsRemoved = 0
    private var finished = false

    mutating func reset() { self = SpeechHypothesisSnapshot() }

    mutating func accept(_ raw: String, segments: [SpeechHypothesisSegment], isFinal: Bool) -> String {
        guard !finished else { return text }
        revision += 1; overlappingSegmentsRemoved = 0
        defer { if isFinal { finished = true } }
        guard !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return text }
        let original = raw as NSString
        let rangesValid = segments.allSatisfy { segment in
            let range = segment.range
            return range.location != NSNotFound && range.location >= 0 && range.length > 0
                && range.location <= original.length && range.length <= original.length - range.location
                && Self.normalized(original.substring(with: range)) == Self.normalized(segment.text)
        }
        guard rangesValid else { text = raw.trimmingCharacters(in: .whitespacesAndNewlines); return text }
        var kept: [Int] = [], removed: [NSRange] = []
        for index in segments.indices.sorted(by: { segments[$0].range.location < segments[$1].range.location }) {
            let candidate = segments[index]
            if let slot = kept.firstIndex(where: { Self.sameAudio(candidate, segments[$0]) }) {
                let previous = segments[kept[slot]]
                if candidate.confidence > previous.confidence {
                    removed.append(previous.range); kept[slot] = index
                } else { removed.append(candidate.range) }
            } else { kept.append(index) }
        }
        let result = NSMutableString(string: raw)
        for range in removed.sorted(by: { $0.location > $1.location }) { result.deleteCharacters(in: range) }
        overlappingSegmentsRemoved = removed.count
        text = (result as String).trimmingCharacters(in: .whitespacesAndNewlines)
        return text
    }

    private static func sameAudio(_ left: SpeechHypothesisSegment, _ right: SpeechHypothesisSegment) -> Bool {
        guard !normalized(left.text).isEmpty, normalized(left.text) == normalized(right.text),
              left.start.isFinite, right.start.isFinite, left.duration.isFinite, right.duration.isFinite,
              left.duration > 0.05, right.duration > 0.05,
              NSIntersectionRange(left.range, right.range).length == 0 else { return false }
        let intersection = max(0, min(left.start + left.duration, right.start + right.duration) - max(left.start, right.start))
        let union = max(left.start + left.duration, right.start + right.duration) - min(left.start, right.start)
        return union > 0 && intersection / union >= 0.85
    }

    private static func normalized(_ text: String) -> String {
        let ignored = CharacterSet.whitespacesAndNewlines.union(.punctuationCharacters)
        return String(String.UnicodeScalarView(text.unicodeScalars.filter { !ignored.contains($0) }))
    }
}

final class SpeechController {
    var emit: (([String: Any]) -> Void)?
    private var engine: AVAudioEngine?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var recognizer: SFSpeechRecognizer?
    private var session = SpeechSession()
    private var voiceHypothesis = SpeechHypothesisSnapshot()
    private var hypothesisMetadata: [String: Any] = [:]
    private var lastText = ""
    private var starting = false
    private var finishing = false
    private var finishWork: DispatchWorkItem?
    private var silenceWork: DispatchWorkItem?
    private var listenLimitWork: DispatchWorkItem?
    private var autoStopAfterSilence: TimeInterval?

    func start(sessionID: String, autoStopAfterSilence: TimeInterval? = nil) {
        guard !session.matches(sessionID) else { return }
        cancel()
        self.autoStopAfterSilence = autoStopAfterSilence.map { min(3, max(0.8, $0)) }
        starting = true
        let token = session.begin(sessionID: sessionID)
        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            DispatchQueue.main.async {
                guard let self = self, self.session.isCurrent(token) else { return }
                guard status == .authorized else {
                    self.fail("请在系统设置 → 隐私与安全性 → 语音识别中允许拾燕使用语音识别。")
                    return
                }
                AVCaptureDevice.requestAccess(for: .audio) { granted in
                    DispatchQueue.main.async {
                        guard self.session.isCurrent(token) else { return }
                        guard granted else {
                            self.fail("请在系统设置 → 隐私与安全性 → 麦克风中允许拾燕使用麦克风。")
                            return
                        }
                        self.begin(token)
                    }
                }
            }
        }
    }

    private func begin(_ token: UUID) {
        guard session.isCurrent(token) else { return }
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "zh-CN")),
              recognizer.isAvailable || recognizer.supportsOnDeviceRecognition else {
            fail("中文语音识别暂时不可用，请检查系统语音服务后重试。")
            return
        }
        self.recognizer = recognizer
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            fail("没有可用的麦克风，请连接或选择音频输入设备。")
            return
        }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
        self.engine = engine
        self.request = request
        lastText = ""
        var levelSampleCount = 0
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            request.append(buffer)
            levelSampleCount += Int(buffer.frameLength)
            guard levelSampleCount >= Int(format.sampleRate / 20),
                  let samples = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return }
            levelSampleCount = 0
            var power: Float = 0
            for index in 0..<Int(buffer.frameLength) { power += samples[index] * samples[index] }
            let rms = sqrt(power / Float(buffer.frameLength))
            let level = min(1, max(0, (20 * log10(max(rms, 0.00001)) + 55) / 45))
            DispatchQueue.main.async {
                guard let self = self, self.session.isCurrent(token) else { return }
                self.send(["type": "speechLevel", "level": Double(level)])
            }
        }
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            DispatchQueue.main.async {
                guard let self = self, self.session.isCurrent(token) else { return }
                if let result = result {
                    let transcription = result.bestTranscription
                    let segments = transcription.segments
                    let raw = transcription.formattedString
                    let merged: String
                    if self.autoStopAfterSilence != nil {
                        merged = self.voiceHypothesis.accept(raw, segments: segments.map {
                            SpeechHypothesisSegment(text: $0.substring, range: $0.substringRange,
                                                    start: $0.timestamp, duration: $0.duration, confidence: $0.confidence)
                        }, isFinal: result.isFinal)
                    } else {
                        guard let accepted = self.session.accept(raw, token: token,
                            firstSegmentTime: segments.first?.timestamp,
                            lastSegmentEndTime: segments.last.map { $0.timestamp + $0.duration }) else { return }
                        merged = accepted
                    }
                    self.hypothesisMetadata = ["rawCharacterCount": raw.count,
                        "mergedCharacterCount": merged.count, "segmentCount": segments.count,
                        "hypothesisRevision": self.voiceHypothesis.revision,
                        "overlappingSegmentsRemoved": self.voiceHypothesis.overlappingSegmentsRemoved,
                        "segmentWindows": segments.prefix(24).enumerated().map { index, segment in
                            ["index": index, "startMS": Int(segment.timestamp * 1000),
                             "endMS": Int((segment.timestamp + segment.duration) * 1000),
                             "characterCount": segment.substring.count,
                             "confidence": Double(segment.confidence)] as [String: Any]
                        }]
                    let changed = self.lastText != merged
                    self.lastText = merged
                    if changed, !merged.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        self.scheduleSilenceStop(token)
                    }
                    self.send(self.hypothesisMetadata.merging(["type": "speech", "text": merged, "isFinal": result.isFinal]) { _, latest in latest })
                    if result.isFinal { self.completeRecognition(emitFinal: false); return }
                }
                if let error = error, !self.finishing, self.engine != nil {
                    self.fail("语音识别已停止：\(error.localizedDescription)")
                }
            }
        }
        engine.prepare()
        do {
            try engine.start()
            starting = false
            if autoStopAfterSilence != nil {
                let limit = DispatchWorkItem { [weak self] in
                    guard let self = self, self.session.isCurrent(token) else { return }
                    self.stop(sessionID: self.session.sessionID)
                }
                listenLimitWork = limit
                DispatchQueue.main.asyncAfter(deadline: .now() + 45, execute: limit)
            }
            send(["type": "speechState", "isRecording": true, "active": true,
                   "onDevice": recognizer.supportsOnDeviceRecognition])
        } catch {
            fail("无法启动麦克风：\(error.localizedDescription)")
        }
    }

     
     
    private func scheduleSilenceStop(_ token: UUID) {
        guard let delay = autoStopAfterSilence, !finishing else { return }
        silenceWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self = self, self.session.isCurrent(token), !self.finishing else { return }
            self.stop(sessionID: self.session.sessionID)
        }
        silenceWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    private func clearVoiceTimers() {
        silenceWork?.cancel(); silenceWork = nil
        listenLimitWork?.cancel(); listenLimitWork = nil
    }

    private func send(_ detail: [String: Any]) {
        if let payload = session.event(detail) { emit?(payload) }
    }

    private func endAudio() {
        if let engine = engine {
            engine.stop()
            engine.inputNode.removeTap(onBus: 0)
        }
        engine = nil
        request?.endAudio()
        request = nil
        starting = false
    }

     
     
    func stop(sessionID expected: String? = nil) {
        if let expected = expected, !session.matches(expected) { return }
        if starting && engine == nil { cancel(); return }
        guard !finishing else { return }
        guard engine != nil || task != nil else {
            send(["type": "speechState", "isRecording": false, "active": false])
            return
        }
        finishing = true
        clearVoiceTimers()
        endAudio()
        let token = session.token
        let work = DispatchWorkItem { [weak self] in
            guard let self = self, self.session.isCurrent(token), self.finishing else { return }
            self.completeRecognition(emitFinal: true)
        }
        finishWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5, execute: work)
    }

     
    func cancel(sessionID expected: String? = nil) {
        if let expected = expected, !session.matches(expected) { return }
        let wasActive = starting || finishing || engine != nil || task != nil
        let inactive = wasActive ? session.event(["type": "speechState", "isRecording": false, "active": false]) : nil
        session.cancel()
        voiceHypothesis.reset(); hypothesisMetadata = [:]
        clearVoiceTimers()
        autoStopAfterSilence = nil
        finishWork?.cancel()
        finishWork = nil
        finishing = false
        endAudio()
        task?.cancel()
        task = nil
        recognizer = nil
        lastText = ""
        if let inactive = inactive { emit?(inactive) }
    }

    private func completeRecognition(emitFinal: Bool) {
        clearVoiceTimers()
        autoStopAfterSilence = nil
        finishWork?.cancel()
        finishWork = nil
        if emitFinal { send(hypothesisMetadata.merging(["type": "speech", "text": lastText, "isFinal": true]) { _, latest in latest }) }
        let inactive = session.event(["type": "speechState", "isRecording": false, "active": false])
        session.cancel()
        finishing = false
        endAudio()
        task?.cancel()
        task = nil
        recognizer = nil
        if let inactive = inactive { emit?(inactive) }
        lastText = ""
    }

    private func fail(_ message: String) {
        send(["type": "speechError", "message": message])
        cancel()
    }
}


 
 
final class VoicePlaybackController: NSObject, AVSpeechSynthesizerDelegate {
    var emit: (([String: Any]) -> Void)?
    private let synthesizer = AVSpeechSynthesizer()
    private var sessionID: String?
    private var current: AVSpeechUtterance?
    private var didStart = false
    private var startTimeout: DispatchWorkItem?

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    func speak(_ text: String, sessionID: String) {
        cancel()
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            emit?(["type": "voicePlaybackState", "sessionId": sessionID,
                   "state": "finished", "isSpeaking": false])
            return
        }
        let utterance = AVSpeechUtterance(string: trimmed)
        utterance.voice = Self.preferredVoice()
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        self.sessionID = sessionID
        current = utterance
        didStart = false
        let timeout = DispatchWorkItem { [weak self, weak utterance] in
            guard let self = self, let utterance = utterance,
                  self.current === utterance, !self.didStart else { return }
            self.failPlayback("语音播放未启动，请重试语音通话。")
        }
        startTimeout = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + 12, execute: timeout)
        synthesizer.speak(utterance)
    }

     
     
     
    static func preferredVoice(voices: [AVSpeechSynthesisVoice] = AVSpeechSynthesisVoice.speechVoices()) -> AVSpeechSynthesisVoice? {
        let candidates = voices.filter { $0.language == "zh-CN" }
        return candidates.sorted { left, right in
            if left.quality.rawValue != right.quality.rawValue {
                return left.quality.rawValue > right.quality.rawValue
            }
            let rank: (AVSpeechSynthesisVoice) -> Int = { voice in
                if voice.identifier.contains("siri.natural") { return 3 }
                if voice.identifier.contains("super-compact") { return 0 }
                if voice.identifier.contains("eloquence") { return -1 }
                return 1
            }
            if rank(left) != rank(right) { return rank(left) > rank(right) }
            return left.identifier < right.identifier
        }.first ?? AVSpeechSynthesisVoice(language: "zh-CN")
    }

    func cancel(sessionID expected: String? = nil) {
        if let expected = expected, expected != sessionID { return }
        let previous = sessionID
        sessionID = nil; current = nil; didStart = false
        startTimeout?.cancel(); startTimeout = nil
        synthesizer.stopSpeaking(at: .immediate)
        if let previous = previous {
            emit?(["type": "voicePlaybackState", "sessionId": previous,
                   "state": "cancelled", "isSpeaking": false])
        }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer,
                           didStart utterance: AVSpeechUtterance) {
        guard current === utterance, let id = sessionID else { return }
        didStart = true; startTimeout?.cancel(); startTimeout = nil
        emit?(["type": "voicePlaybackState", "sessionId": id,
               "state": "speaking", "isSpeaking": true,
               "voiceIdentifier": utterance.voice?.identifier ?? "",
               "voiceQuality": utterance.voice?.quality.rawValue ?? 0])
    }

    private func failPlayback(_ message: String) {
        guard let id = sessionID else { return }
        sessionID = nil; current = nil; didStart = false
        startTimeout?.cancel(); startTimeout = nil
        synthesizer.stopSpeaking(at: .immediate)
        emit?(["type": "voicePlaybackState", "sessionId": id,
               "state": "failed", "isSpeaking": false, "message": message])
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer,
                           didFinish utterance: AVSpeechUtterance) {
        finish(utterance, state: "finished")
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer,
                           didCancel utterance: AVSpeechUtterance) {
        finish(utterance, state: "cancelled")
    }

    private func finish(_ utterance: AVSpeechUtterance, state: String) {
        guard current === utterance, let id = sessionID else { return }
        if state == "finished" && !didStart {
            failPlayback("语音播放没有开始，请重试语音通话。")
            return
        }
        current = nil; sessionID = nil; didStart = false
        startTimeout?.cancel(); startTimeout = nil
        emit?(["type": "voicePlaybackState", "sessionId": id,
               "state": state, "isSpeaking": false])
    }
}
