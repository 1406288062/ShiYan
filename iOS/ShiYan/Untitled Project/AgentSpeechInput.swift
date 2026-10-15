import Foundation
import Speech
import AVFoundation
import Combine

@MainActor
final class AgentSpeechInput: ObservableObject {
    @Published private(set) var isRecording = false
    @Published private(set) var transcript = ""
    @Published var errorMessage: String?
    private let engine = AVAudioEngine()
    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "zh-CN"))
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var recognition: SFSpeechRecognitionTask?
    private var installedTap = false
    @Published private(set) var isStarting = false
    private var recognitionToken = UUID()
    private var accumulator = SpeechTranscriptAccumulator()

    func start() async {
        guard !isRecording && !isStarting else { return }
        isStarting = true
        let token = UUID()
        recognitionToken = token
        defer { if recognitionToken == token { isStarting = false } }
#if DEBUG
        if ProcessInfo.processInfo.environment["SHIYAN_UI_TEST_CHAT_REPAIR"] == "speech-long" {
            accumulator.reset(); transcript = ""; isRecording = true
            var cumulative = ""
            for (index, phrase) in AgentRepairFixtures.longSpeechPhrases.enumerated() {
                guard recognitionToken == token else { return }
                let from = TimeInterval(index * 3)
                cumulative += phrase
                publishHypothesis(phrase, start: from, end: from + 2.4, isFinal: false)
                 
                 
                publishHypothesis(phrase, start: from + 0.03, end: from + 2.5, isFinal: false)
                if index.isMultiple(of: 7) {
                    publishHypothesis(cumulative, start: 0.01, end: from + 2.5, isFinal: false)
                }
                try? await Task.sleep(for: .seconds(3))
            }
            if recognitionToken == token {
                publishHypothesis(cumulative, start: 0, end: 180, isFinal: true)
                isRecording = false
            }
            return
        }
        if ProcessInfo.processInfo.environment["SHIYAN_UI_TEST_CHAT_REPAIR"] == "speech" {
            accumulator.reset(); transcript = ""; isRecording = true
            for sample in AgentRepairFixtures.speechSamples {
                guard recognitionToken == token else { return }
                publishHypothesis(sample.text, start: sample.start, end: sample.end, isFinal: sample.final)
                try? await Task.sleep(for: .milliseconds(450))
            }
            if recognitionToken == token { isRecording = false }
            return
        }
#endif

        errorMessage = nil
        let speechAllowed = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0 == .authorized) }
        }
        guard recognitionToken == token else { return }
        guard speechAllowed else { errorMessage = "请在系统设置中允许拾燕使用语音识别"; return }
        let micAllowed = await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { continuation.resume(returning: $0) }
        }
        guard recognitionToken == token else { return }
        guard micAllowed else { errorMessage = "请在系统设置中允许拾燕使用麦克风"; return }
        guard let recognizer, recognizer.isAvailable else { errorMessage = "语音识别暂不可用，请稍后再试"; return }

        do {
            recognition?.cancel()
            recognition = nil
            accumulator.reset()
            transcript = ""

            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)

            let req = SFSpeechAudioBufferRecognitionRequest()
            req.shouldReportPartialResults = true
            if recognizer.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
            request = req

            let node = engine.inputNode
            let format = node.outputFormat(forBus: 0)
            guard format.sampleRate > 0, format.channelCount > 0 else { throw AgentClientError.message("未检测到可用麦克风") }
            if installedTap { node.removeTap(onBus: 0) }
            node.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in req.append(buffer) }
            installedTap = true

            recognition = recognizer.recognitionTask(with: req) { [weak self] result, error in
                Task { @MainActor in
                    guard let self, self.recognitionToken == token else { return }
                    if let result {
                        let segments = result.bestTranscription.segments
                        self.publishHypothesis(result.bestTranscription.formattedString,
                            start: segments.first?.timestamp,
                            end: segments.last.map { $0.timestamp + $0.duration },
                            isFinal: result.isFinal)
                    }
                    if result?.isFinal == true { self.stop() }
                    if let error, self.isRecording {
                        self.errorMessage = error.localizedDescription
                        self.stop()
                    }
                }
            }
            engine.prepare()
            try engine.start()
            isRecording = true
        } catch {
            errorMessage = error.localizedDescription
            stop()
        }
    }

    private func publishHypothesis(_ text: String, start: TimeInterval?, end: TimeInterval?, isFinal: Bool) {
        let merged = accumulator.accept(text, firstSegmentTime: start, lastSegmentEndTime: end, isFinal: isFinal)
        if merged != transcript { transcript = merged }
    }

    func stop() {
        if isStarting { recognitionToken = UUID(); isStarting = false }
        engine.stop()
        if installedTap { engine.inputNode.removeTap(onBus: 0); installedTap = false }
        request?.endAudio()
        request = nil
        isRecording = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    func cancel() {
         
        recognitionToken = UUID()
        isStarting = false
        stop()
        recognition?.cancel()
        recognition = nil
    }
}
