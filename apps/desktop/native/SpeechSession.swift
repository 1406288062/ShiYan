import Foundation

struct SpeechSession {
    private(set) var token = UUID()
    private(set) var sessionID: String?
    private var accumulator = SpeechTranscriptAccumulator()
    var text: String { accumulator.text }

    mutating func begin(sessionID: String = UUID().uuidString) -> UUID {
        token = UUID()
        self.sessionID = sessionID
        accumulator.reset()
        return token
    }

    mutating func cancel() {
        token = UUID()
        sessionID = nil
        accumulator.reset()
    }

    func isCurrent(_ candidate: UUID) -> Bool { candidate == token }
    func matches(_ candidate: String) -> Bool { sessionID == candidate }

    func event(_ detail: [String: Any]) -> [String: Any]? {
        guard let sessionID = sessionID else { return nil }
        var payload = detail
        payload["sessionId"] = sessionID
        return payload
    }

    mutating func accept(_ raw: String, token candidate: UUID,
                         firstSegmentTime: TimeInterval? = nil,
                         lastSegmentEndTime: TimeInterval? = nil) -> String? {
        guard isCurrent(candidate) else { return nil }
        return accumulator.accept(raw, firstSegmentTime: firstSegmentTime,
                                  lastSegmentEndTime: lastSegmentEndTime)
    }
}
