import Foundation

 
 
struct SpeechTranscriptAccumulator {
    private(set) var text = ""
    private var completed = ""
    private var currentHypothesis = ""
    private var currentStartTime: TimeInterval?
    private var currentEndTime: TimeInterval?

    mutating func reset() {
        text = ""
        completed = ""
        currentHypothesis = ""
        currentStartTime = nil
        currentEndTime = nil
    }

    @discardableResult
    mutating func accept(
        _ raw: String,
        firstSegmentTime: TimeInterval? = nil,
        lastSegmentEndTime: TimeInterval? = nil
    ) -> String {
        let next = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !next.isEmpty else { return text }

         
         
        let startsNewAudio: Bool
        if let firstSegmentTime, let currentEndTime {
            startsNewAudio = firstSegmentTime > currentEndTime + 0.6
        } else {
             
            startsNewAudio = false
        }

        var newUtterance = false
        if currentHypothesis.isEmpty {
            currentHypothesis = next
            newUtterance = true
        } else if next == text && !completed.isEmpty {
             
        } else if !completed.isEmpty && next.hasPrefix(text) {
            completed = ""
            currentHypothesis = next
            currentStartTime = firstSegmentTime
        } else if !completed.isEmpty && Self.normalized(next) == Self.normalized(text) {
            completed = ""
            currentHypothesis = next
            currentStartTime = firstSegmentTime
        } else if Self.normalized(next) == Self.normalized(currentHypothesis) {
             
            if startsNewAudio {
                completed = Self.join(completed, currentHypothesis)
                currentHypothesis = next
                newUtterance = true
            } else {
                currentHypothesis = next
            }
        } else if next.hasPrefix(currentHypothesis) {
             
            currentHypothesis = next
        } else if currentHypothesis.hasPrefix(next) && !startsNewAudio {
             
        } else if startsNewAudio {
            completed = Self.join(completed, currentHypothesis)
            currentHypothesis = next
            newUtterance = true
        } else {
            let shared = currentHypothesis.commonPrefix(with: next)
            let shorter = min(currentHypothesis.count, next.count)
            if !shared.isEmpty && shared.count * 2 >= shorter {
                 
                currentHypothesis = next
            } else {
                let overlap = Self.suffixPrefixOverlap(currentHypothesis, next)
                if overlap >= 2 {
                    currentHypothesis += String(next.dropFirst(overlap))
                } else {
                     
                    completed = Self.join(completed, currentHypothesis)
                    currentHypothesis = next
                    newUtterance = true
                }
            }
        }

        if newUtterance {
            currentStartTime = firstSegmentTime
            currentEndTime = lastSegmentEndTime
        } else if let lastSegmentEndTime {
            currentEndTime = max(currentEndTime ?? lastSegmentEndTime, lastSegmentEndTime)
        }
        text = Self.join(completed, currentHypothesis)
        return text
    }

    private static func normalized(_ value: String) -> String {
        let ignored = CharacterSet.whitespacesAndNewlines.union(.punctuationCharacters)
        return String(String.UnicodeScalarView(value.unicodeScalars.filter { !ignored.contains($0) }))
    }

    private static func suffixPrefixOverlap(_ previous: String, _ next: String) -> Int {
        let a = Array(previous)
        let b = Array(next)
        for count in stride(from: min(a.count, b.count), through: 1, by: -1) {
            if a.suffix(count).elementsEqual(b.prefix(count)) { return count }
        }
        return 0
    }

    private static func join(_ previous: String, _ next: String) -> String {
        guard !previous.isEmpty else { return next }
        guard !next.isEmpty else { return previous }
        let needsSpace = previous.last?.isASCII == true && next.first?.isASCII == true
            && previous.last?.isLetter == true && next.first?.isLetter == true
        return previous + (needsSpace ? " " : "") + next
    }
}
