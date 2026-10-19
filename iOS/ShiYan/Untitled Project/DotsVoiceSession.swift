import Foundation
import Combine
import Speech
import AVFoundation
import UIKit

extension Notification.Name {
    static let dotsVoiceWillStart = Notification.Name("ShiYanDotsVoiceWillStart")
}

enum DotsVoicePhase: String {
    case idle, listening, sending, waiting, starting, speaking, muted, paused

    var title: String {
        switch self {
        case .idle: return "语音通话"
        case .listening: return "正在聆听"
        case .sending: return "正在发送"
        case .waiting: return "等待回复"
        case .starting: return "准备语音"
        case .speaking: return "正在播报"
        case .muted: return "麦克风已静音"
        case .paused: return "聆听已暂停"
        }
    }
}

// The session belongs to the app, rather than DotsView. Moving to another
// conversation only moves its controls; it does not stop the call.
@MainActor
final class DotsVoiceSession: NSObject, ObservableObject, AVSpeechSynthesizerDelegate {
    private static var instance: DotsVoiceSession?
    static var shared: DotsVoiceSession {
        if let instance { return instance }
        let value = DotsVoiceSession(store: .shared); instance = value; return value
    }
    static func resetAccount() { instance?.end(); instance = nil }

    @Published private(set) var active = false
    @Published private(set) var phase: DotsVoicePhase = .idle
    @Published private(set) var muted = false
    @Published private(set) var level: Double = 0
    @Published private(set) var partial = ""
    @Published private(set) var startedAt: Date?
    @Published private(set) var errorMessage: String?

    private let store: DotsStore
    private let synthesizer = AVSpeechSynthesizer()
    private var subscriptions = Set<AnyCancellable>()
    private var generation = UUID()
    private var recognitionToken = UUID()
    private var engine: AVAudioEngine?
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var recognition: SFSpeechRecognitionTask?
    private var tapInstalled = false
    private var accumulator = SpeechTranscriptAccumulator()
    private var permissionsReady = false
    private var paused = false
    private var lastSpeechEnergyAt: TimeInterval = 0
    private var lastTranscriptAt: TimeInterval = 0
    private var listenStartedAt: TimeInterval = 0
    private var pendingMessageID: Int?
    private var outboundRequestID: String?
    private var retryUtterance: (text: String, requestID: String)?
    private var replyQueue = DotsVoiceReplyQueue()
    private var utterance: AVSpeechUtterance?
    private var speakingMessageID: Int?
    private var listenTask: Task<Void, Never>?
    private var silenceTask: Task<Void, Never>?
    private var waitTask: Task<Void, Never>?
    private var playbackStartTask: Task<Void, Never>?
    private var playbackLevelTask: Task<Void, Never>?

    init(store: DotsStore) {
        self.store = store
        super.init()
        synthesizer.delegate = self
        store.$state.sink { [weak self] state in
            // @Published emits before the store's property is assigned. Use the
            // emitted snapshot on the next actor turn, never read stale state.
            Task { @MainActor [weak self] in self?.observe(state) }
        }.store(in: &subscriptions)
        NotificationCenter.default.publisher(for: UIApplication.didEnterBackgroundNotification)
            .sink { [weak self] _ in Task { @MainActor in self?.end() } }
            .store(in: &subscriptions)
        NotificationCenter.default.publisher(for: AVAudioSession.interruptionNotification)
            .sink { [weak self] notification in
                guard let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                      AVAudioSession.InterruptionType(rawValue: raw) == .began else { return }
                Task { @MainActor in self?.end() }
            }.store(in: &subscriptions)
        NotificationCenter.default.publisher(for: AVAudioSession.mediaServicesWereResetNotification)
            .sink { [weak self] _ in Task { @MainActor in self?.end() } }
            .store(in: &subscriptions)
        NotificationCenter.default.publisher(for: AVAudioSession.routeChangeNotification)
            .sink { [weak self] notification in
                guard let raw = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
                      AVAudioSession.RouteChangeReason(rawValue: raw) == .oldDeviceUnavailable else { return }
                Task { @MainActor in self?.end() }
            }.store(in: &subscriptions)
    }

    func elapsedText(at date: Date = Date()) -> String {
        let seconds = max(0, Int(date.timeIntervalSince(startedAt ?? date)))
        return String(format: "%02d:%02d", seconds / 60, seconds % 60)
    }

    func toggle() async {
        if active { end() } else { await start() }
    }

    func dismissError() { errorMessage = nil }

    func start() async {
        guard !active else { return }
        guard !["paused", "cancelled"].contains(store.manager?.status ?? "") else {
            errorMessage = "请先继续 Dots，再开启语音通话。"
            return
        }
        let savedVoice = store.state.pending.flatMap { operation -> (text: String, requestID: String)? in
            guard operation.route == "manager/messages", operation.draftKey == nil,
                  (operation.attachments ?? []).isEmpty, let text = operation.text else { return nil }
            return (text, operation.requestId)
        }
        guard !store.hasPending || savedVoice != nil else {
            errorMessage = "上一条消息尚未确认，请先重试原请求。"
            return
        }
        NotificationCenter.default.post(name: .dotsVoiceWillStart, object: self)
        generation = UUID()
        active = true
        paused = false
        muted = false
        permissionsReady = false
        pendingMessageID = nil
        outboundRequestID = nil
        errorMessage = nil
        partial = ""
        level = 0
        startedAt = Date()
        replyQueue.begin(history: voiceMessages(store.messages), at: startedAt!.timeIntervalSince1970)
        store.startMonitoring()
        if let retry = savedVoice ?? retryUtterance {
            submitUtterance(retry.text, requestID: retry.requestID)
        } else {
            resume()
        }
    }

    func end() { finish(error: nil, keepUnsent: false) }

    private func finish(error: String?, keepUnsent: Bool) {
        // Invalidate tokens before cancelling native work, since cancellation
        // itself can deliver recognizer / synthesizer callbacks.
        generation = UUID()
        active = false
        phase = .idle
        pendingMessageID = nil
        outboundRequestID = nil
        paused = false
        muted = false
        permissionsReady = false
        startedAt = nil
        waitTask?.cancel(); waitTask = nil
        stopCapture()
        utterance = nil
        playbackStartTask?.cancel(); playbackStartTask = nil
        playbackLevelTask?.cancel(); playbackLevelTask = nil
        synthesizer.stopSpeaking(at: .immediate)
        deactivateAudio()
        replyQueue.reset()
        speakingMessageID = nil
        level = 0
        if !keepUnsent { partial = ""; retryUtterance = nil }
        errorMessage = error
        // A request already durably handed to DotsStore continues to settle.
        // Ending audio must not cancel it or invent a second request ID.
    }

    func toggleMute() {
        guard active else { return }
        muted.toggle()
        if muted, engine != nil || listenTask != nil {
            stopCapture()
            partial = ""
            phase = pendingMessageID == nil && !replyQueue.hasOpenStreams ? .muted : .waiting
        } else if !muted, phase == .muted {
            resume()
        }
        _ = flushReply()
    }

    func interrupt() {
        guard active else { return }
        if utterance != nil || phase == .speaking || (phase == .waiting && replyQueue.hasOpenStreams) {
            utterance = nil
            playbackStartTask?.cancel(); playbackStartTask = nil
            playbackLevelTask?.cancel(); playbackLevelTask = nil
            let interruptedRequests = replyQueue.discardPending(including: speakingMessageID)
            speakingMessageID = nil
            if let pendingMessageID, interruptedRequests.contains(pendingMessageID) {
                self.pendingMessageID = nil
                waitTask?.cancel(); waitTask = nil
            }
            synthesizer.stopSpeaking(at: .immediate)
            deactivateAudio()
            level = 0
            paused = false
            resume()
        } else if phase == .listening || (phase == .starting && listenTask != nil) {
            paused = true
            stopCapture()
            partial = ""
            phase = .paused
        } else if phase == .paused {
            paused = false
            resume()
        }
    }

    private func voiceMessages(_ messages: [DotsManagerMessage]) -> [DotsVoiceReplyQueue.Message] {
        messages.map {
            .init(id: $0.id, role: $0.role, text: $0.content,
                  respondsTo: $0.respondsToMessageIds ?? [], createdAt: $0.createdAt,
                  deliveryState: $0.deliveryState, revision: $0.revision)
        }
    }

    private static func spokenText(_ content: String) -> String {
        let text: String
        if let markdown = try? AttributedString(markdown: content) {
            text = String(markdown.characters)
        } else {
            text = content
        }
        return String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(20_000))
    }

    private func observe(_ state: DotsSavedState) {
        guard active else { return }
        if ["paused", "cancelled"].contains(state.manager?.status ?? "") {
            finish(error: "Dots 已暂停或停止，语音通话已结束。", keepUnsent: false)
            return
        }
        // A retry from the existing pending-message UI can settle independently
        // of the call's own send task. Recover the same accepted user message.
        if pendingMessageID == nil, let requestID = outboundRequestID,
           let accepted = state.managerMessages?.first(where: { $0.role == "user" && $0.requestId == requestID }) {
            outboundRequestID = nil
            retryUtterance = nil
            pendingMessageID = accepted.id
            if phase == .sending { phase = .waiting }
            beginWaitTimeout(for: accepted.id)
        }
        let messages = state.managerMessages ?? []
        let answered = replyQueue.observe(voiceMessages(messages), pendingMessageID: pendingMessageID)
        if answered {
            pendingMessageID = nil
            waitTask?.cancel(); waitTask = nil
        }
        if !flushReply(), phase == .waiting, pendingMessageID == nil, !replyQueue.hasOpenStreams { resume() }
    }

    private func resume() {
        guard active, utterance == nil else { return }
        stopCapture()
        partial = ""
        level = 0
        let waiting = pendingMessageID != nil || replyQueue.hasOpenStreams
        phase = waiting ? .waiting : muted ? .muted : paused ? .paused : .listening
        if flushReply() { return }
        guard !waiting, !muted, !paused else { return }
        let epoch = generation
        phase = .starting
        listenTask?.cancel()
        listenTask = Task { [weak self] in await self?.beginListening(epoch: epoch) }
    }

    private func authorize(epoch: UUID, token: UUID) async throws {
        let speech = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0 == .authorized) }
        }
        try Task.checkCancellation()
        guard active, generation == epoch, recognitionToken == token else { throw CancellationError() }
        guard speech else { throw AgentClientError.message("请在系统设置中允许拾燕使用语音识别。") }
        let microphone = await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { continuation.resume(returning: $0) }
        }
        try Task.checkCancellation()
        guard active, generation == epoch, recognitionToken == token else { throw CancellationError() }
        guard microphone else { throw AgentClientError.message("请在系统设置中允许拾燕使用麦克风。") }
    }

    private func beginListening(epoch: UUID) async {
        guard active, generation == epoch, !Task.isCancelled, !muted, !paused, pendingMessageID == nil else { return }
        let token = UUID()
        recognitionToken = token
        do {
            if !permissionsReady { try await authorize(epoch: epoch, token: token) }
            guard active, generation == epoch, recognitionToken == token, !Task.isCancelled,
                  !muted, !paused, pendingMessageID == nil else { return }
            permissionsReady = true
            guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "zh-CN")), recognizer.isAvailable else {
                throw AgentClientError.message("语音识别暂不可用，请稍后再试。")
            }
            self.recognizer = recognizer
            let audioSession = AVAudioSession.sharedInstance()
            try audioSession.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetoothHFP])
            try audioSession.setActive(true)
            let inputEngine = AVAudioEngine()
            engine = inputEngine
            let node = inputEngine.inputNode
            let format = node.outputFormat(forBus: 0)
            guard format.sampleRate > 0, format.channelCount > 0 else {
                throw AgentClientError.message("未检测到可用麦克风。")
            }
            let audioRequest = SFSpeechAudioBufferRecognitionRequest()
            audioRequest.shouldReportPartialResults = true
            if recognizer.supportsOnDeviceRecognition { audioRequest.requiresOnDeviceRecognition = true }
            request = audioRequest
            accumulator.reset()
            partial = ""
            lastSpeechEnergyAt = 0
            lastTranscriptAt = 0
            listenStartedAt = Date.timeIntervalSinceReferenceDate
            node.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
                audioRequest.append(buffer)
                guard let samples = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return }
                var squared: Float = 0
                for index in 0..<Int(buffer.frameLength) { squared += samples[index] * samples[index] }
                let value = min(1, Double(sqrt(squared / Float(buffer.frameLength))) * 8)
                Task { @MainActor [weak self] in
                    guard let self, self.active, self.generation == epoch, self.recognitionToken == token else { return }
                    self.level = self.level * 0.35 + value * 0.65
                    if value > 0.065 { self.lastSpeechEnergyAt = Date.timeIntervalSinceReferenceDate }
                }
            }
            tapInstalled = true
            recognition = recognizer.recognitionTask(with: audioRequest) { [weak self] result, error in
                Task { @MainActor [weak self] in
                    guard let self, self.active, self.generation == epoch, self.recognitionToken == token else { return }
                    if let result {
                        let segments = result.bestTranscription.segments
                        let text = self.accumulator.accept(result.bestTranscription.formattedString,
                            firstSegmentTime: segments.first?.timestamp,
                            lastSegmentEndTime: segments.last.map { $0.timestamp + $0.duration },
                            isFinal: result.isFinal)
                        if self.partial != text {
                            self.partial = text
                            self.lastTranscriptAt = Date.timeIntervalSinceReferenceDate
                        }
                        if result.isFinal { self.finishUtterance(); return }
                    }
                    if let error {
                        // The recognizer may finish a natural silence with its
                        // no-speech code. Keep the call alive and rotate capture.
                        if (error as NSError).code == 1110 { self.finishUtterance() }
                        else { self.finish(error: error.localizedDescription, keepUnsent: false) }
                    }
                }
            }
            inputEngine.prepare()
            try inputEngine.start()
            listenTask = nil
            phase = .listening
            silenceTask?.cancel()
            silenceTask = Task { [weak self] in
                while !Task.isCancelled {
                    do { try await Task.sleep(nanoseconds: 100_000_000) } catch { return }
                    guard let self, self.active, self.generation == epoch, self.recognitionToken == token else { return }
                    let now = Date.timeIntervalSinceReferenceDate
                    let activity = max(self.lastSpeechEnergyAt, self.lastTranscriptAt)
                    if (!self.partial.isEmpty && activity > 0 && now - activity >= 1.4) || now - self.listenStartedAt >= 50 {
                        self.finishUtterance()
                        return
                    }
                    _ = self.flushReply()
                }
            }
            _ = flushReply()
        } catch {
            guard active, generation == epoch, recognitionToken == token, !Task.isCancelled else { return }
            finish(error: error.localizedDescription, keepUnsent: false)
        }
    }

    private func stopCapture() {
        recognitionToken = UUID()
        listenTask?.cancel(); listenTask = nil
        silenceTask?.cancel(); silenceTask = nil
        engine?.stop()
        if tapInstalled { engine?.inputNode.removeTap(onBus: 0); tapInstalled = false }
        request?.endAudio(); request = nil
        recognition?.cancel(); recognition = nil
        recognizer = nil
        engine = nil
        level = 0
        lastSpeechEnergyAt = 0
        lastTranscriptAt = 0
        if utterance == nil { deactivateAudio() }
    }

    private func finishUtterance() {
        guard active, phase == .listening, !muted, !paused else { return }
        let text = partial.trimmingCharacters(in: .whitespacesAndNewlines)
        stopCapture()
        level = 0
        if text.isEmpty { resume() }
        else { submitUtterance(text, requestID: UUID().uuidString.lowercased()) }
    }

    private func submitUtterance(_ text: String, requestID: String) {
        let epoch = generation
        retryUtterance = (text, requestID)
        outboundRequestID = requestID
        phase = .sending
        partial = text
        Task { [weak self] in
            guard let self else { return }
            do {
                // A typed message / upload can finish while the user speaks.
                // Wait briefly for that same store, retaining the exact voice
                // text and request ID instead of creating a competing sender.
                let deadline = Date().addingTimeInterval(30)
                while self.store.sending || self.store.uploading {
                    guard self.active, self.generation == epoch else { return }
                    guard Date() < deadline else { throw AgentClientError.message("上一条消息仍在发送，请重新开启语音重试。") }
                    try await Task.sleep(nanoseconds: 100_000_000)
                }
                guard self.active, self.generation == epoch else { return }
                let id = try await self.store.submitVoice(text, requestID: requestID)
                guard self.active, self.generation == epoch else { return }
                // A live-state update can confirm and answer this request
                // before its HTTP call returns. Never rewind that newer state
                // (or a subsequent utterance) back into waiting / capture.
                guard self.outboundRequestID == requestID else { return }
                self.outboundRequestID = nil
                self.retryUtterance = nil
                self.pendingMessageID = id
                self.partial = ""
                if self.phase == .sending { self.phase = .waiting }
                self.beginWaitTimeout(for: id)
                self.observe(self.store.state)
            } catch {
                guard self.active, self.generation == epoch, self.outboundRequestID == requestID else { return }
                let rejected = error is DotsRejectedRequest
                self.finish(error: rejected ? error.localizedDescription : "语音消息尚未确认，内容已保留。重新开启语音可重试原请求。", keepUnsent: !rejected)
            }
        }
    }

    private func beginWaitTimeout(for id: Int) {
        let epoch = generation
        waitTask?.cancel()
        waitTask = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 300_000_000_000) } catch { return }
            guard let self, self.active, self.generation == epoch, self.pendingMessageID == id else { return }
            self.finish(error: "Dots 仍在处理，语音通话已结束；文字回复会继续同步。", keepUnsent: false)
        }
    }

    private func preferredMandarinVoice() -> AVSpeechSynthesisVoice? {
        let fallback = AVSpeechSynthesisVoice(language: "zh-CN")
        // Language-only selection can return a compact voice even when a better
        // local voice is installed. Query again for each reply so a newly
        // downloaded voice takes effect without restarting the app.
        let installed = AVSpeechSynthesisVoice.speechVoices().filter {
            $0.language.replacingOccurrences(of: "_", with: "-").lowercased() == "zh-cn"
                && !$0.voiceTraits.contains(.isNoveltyVoice)
                && !$0.voiceTraits.contains(.isPersonalVoice)
        }
        return installed.sorted { lhs, rhs in
            if lhs.quality != rhs.quality { return lhs.quality.rawValue > rhs.quality.rawValue }
            // Within a quality tier, retain the system default where possible.
            let leftDefault = lhs.identifier == fallback?.identifier
            let rightDefault = rhs.identifier == fallback?.identifier
            if leftDefault != rightDefault { return leftDefault }
            return lhs.identifier < rhs.identifier
        }.first ?? fallback
    }

    @discardableResult
    private func flushReply() -> Bool {
        guard active, !paused, utterance == nil, ![.sending, .starting, .speaking].contains(phase),
              !replyQueue.replies.isEmpty else { return false }
        if phase == .listening,
           !partial.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
            (lastSpeechEnergyAt > 0 && Date.timeIntervalSinceReferenceDate - lastSpeechEnergyAt < 0.7) { return false }
        var nextReply: DotsVoiceReplyQueue.Reply?
        while let raw = replyQueue.popFirst() {
            let text = Self.spokenText(raw.text)
            if !text.isEmpty { nextReply = .init(id: raw.id, text: text); break }
        }
        guard let reply = nextReply else { return false }
        speakingMessageID = reply.id
        if engine != nil || listenTask != nil || recognition != nil { stopCapture() }
        partial = ""
        level = 0
        phase = .starting
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .spokenAudio, options: .duckOthers)
            try session.setActive(true)
            let next = AVSpeechUtterance(string: reply.text)
            next.voice = preferredMandarinVoice()
            next.rate = AVSpeechUtteranceDefaultSpeechRate * 0.94
            next.preUtteranceDelay = 0.04
            next.postUtteranceDelay = 0.08
            utterance = next
            synthesizer.speak(next)
            let epoch = generation
            playbackStartTask?.cancel()
            playbackStartTask = Task { [weak self] in
                do { try await Task.sleep(nanoseconds: 20_000_000_000) } catch { return }
                guard let self, self.active, self.generation == epoch,
                      self.utterance === next, self.phase == .starting else { return }
                self.finish(error: "语音播放未启动，请重新开启通话。", keepUnsent: false)
            }
        } catch {
            finish(error: "语音播放暂不可用：" + error.localizedDescription, keepUnsent: false)
        }
        return true
    }

    private func deactivateAudio() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        let utteranceID = ObjectIdentifier(utterance)
        Task { @MainActor [weak self] in
            guard let self, self.active, self.utterance.map(ObjectIdentifier.init) == utteranceID else { return }
            self.playbackStartTask?.cancel(); self.playbackStartTask = nil
            self.phase = .speaking
            let epoch = self.generation
            let start = Date.timeIntervalSinceReferenceDate
            self.playbackLevelTask?.cancel()
            self.playbackLevelTask = Task { [weak self] in
                while !Task.isCancelled {
                    guard let self, self.active, self.generation == epoch,
                          self.utterance.map(ObjectIdentifier.init) == utteranceID else { return }
                    let elapsed = Date.timeIntervalSinceReferenceDate - start
                    self.level = 0.18 + 0.25 * abs(sin(elapsed * 5.2)) + 0.12 * abs(sin(elapsed * 9.1))
                    do { try await Task.sleep(nanoseconds: 60_000_000) } catch { return }
                }
            }
        }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        let utteranceID = ObjectIdentifier(utterance)
        Task { @MainActor [weak self] in self?.playbackFinished(utteranceID) }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        let utteranceID = ObjectIdentifier(utterance)
        Task { @MainActor [weak self] in
            guard let self, self.active, self.utterance.map(ObjectIdentifier.init) == utteranceID else { return }
            self.finish(error: "语音播放已中断，请重新开启通话。", keepUnsent: false)
        }
    }

    private func playbackFinished(_ finishedID: ObjectIdentifier) {
        guard active, utterance.map(ObjectIdentifier.init) == finishedID else { return }
        utterance = nil
        speakingMessageID = nil
        playbackStartTask?.cancel(); playbackStartTask = nil
        playbackLevelTask?.cancel(); playbackLevelTask = nil
        level = 0
        phase = .waiting
        // Already-generated sentences share the active playback session. Only
        // release audio when there is an actual gap or the reply has ended.
        if flushReply() { return }
        deactivateAudio()
        resume()
    }
}
