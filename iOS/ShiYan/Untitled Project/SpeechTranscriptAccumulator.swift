import Foundation

 
 
struct SpeechTranscriptAccumulator {
    private struct Piece {
        var start: TimeInterval
        var end: TimeInterval
        var text: String
        var raw: String
    }
    private var pieces: [Piece] = []
    private var untimedCompleted = ""
    private var untimedCurrent = ""
    private(set) var text = ""

    mutating func reset() {
        pieces.removeAll()
        untimedCompleted = ""
        untimedCurrent = ""
        text = ""
    }

    @discardableResult
    mutating func accept(_ raw: String, firstSegmentTime: TimeInterval? = nil,
                         lastSegmentEndTime: TimeInterval? = nil, isFinal: Bool = false) -> String {
        let next = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !next.isEmpty else { return text }
        guard let start = firstSegmentTime, let end = lastSegmentEndTime,
              start.isFinite, end.isFinite, start >= 0, end > start else {
            return acceptUntimed(next, isFinal: isFinal)
        }

        if pieces.isEmpty {
            pieces = [.init(start: start, end: end, text: next, raw: next)]
            untimedCompleted = ""
            untimedCurrent = ""
        } else {
            let current = pieces.map(\.text).reduce("", Self.join)
            let last = pieces[pieces.count - 1]
            let overlaps = pieces.indices.filter { start < pieces[$0].end && end > pieces[$0].start }

            if next.hasPrefix(current) && next.count > current.count {
                 
                 
                pieces = [.init(start: min(start, pieces[0].start),
                                end: max(end, last.end), text: next, raw: next)]
            } else if next == current && pieces.count > 1 {
                 
            } else if let first = overlaps.first, let final = overlaps.last {
                let previous = pieces[first...final].map(\.text).reduce("", Self.join)
                let before = pieces[..<first].map(\.text).reduce("", Self.join)
                let overlap = Self.suffixPrefixOverlap(before, next)
                let replacement = overlap >= 2 ? String(next.dropFirst(overlap)) : next
                 
                let resolved = !isFinal && previous.hasPrefix(replacement) && replacement.count < previous.count
                    ? previous : replacement
                pieces.replaceSubrange(first...final, with: [
                    .init(start: min(start, pieces[first].start),
                          end: max(end, pieces[final].end), text: resolved, raw: next)
                ])
            } else if start >= last.end {
                let gap = start - last.end
                if next == last.raw || next == last.text {
                    if gap >= 0.65 {
                         
                        pieces.append(.init(start: start, end: end, text: next, raw: next))
                    } else {
                         
                        pieces[pieces.count - 1].end = max(last.end, end)
                    }
                } else {
                    let overlap = Self.suffixPrefixOverlap(current, next)
                    let suffix = overlap >= 2 ? String(next.dropFirst(overlap)) : next
                    if !suffix.isEmpty {
                        pieces.append(.init(start: start, end: end, text: suffix, raw: next))
                    }
                }
            } else {
                 
                 
                return text
            }
        }
        text = pieces.map(\.text).reduce("", Self.join)
        return text
    }

    private mutating func acceptUntimed(_ next: String, isFinal: Bool) -> String {
        if !pieces.isEmpty {
            if Self.normalized(next) == Self.normalized(text) { return text }
            if next.hasPrefix(text) {
                pieces = [.init(start: pieces.first!.start, end: pieces.last!.end, text: next, raw: next)]
                text = next
            } else if let last = pieces.last {
                let previous = last.text
                let before = pieces.dropLast().map(\.text).reduce("", Self.join)
                let overlap = Self.suffixPrefixOverlap(before, next)
                let replacement = overlap >= 2 ? String(next.dropFirst(overlap)) : next
                let resolved = !isFinal && previous.hasPrefix(replacement) && replacement.count < previous.count
                    ? previous : replacement
                pieces[pieces.count-1].text = resolved
                pieces[pieces.count-1].raw = next
                text = pieces.map(\.text).reduce("", Self.join)
            }
            return text
        }
        if untimedCurrent.isEmpty {
            untimedCurrent = next
        } else if Self.normalized(next) == Self.normalized(text) || next.hasPrefix(text) {
            untimedCompleted = ""; untimedCurrent = next
        } else if Self.normalized(next) == Self.normalized(untimedCurrent) || next.hasPrefix(untimedCurrent) {
            untimedCurrent = next
        } else if untimedCurrent.hasPrefix(next) && !isFinal {
             
        } else {
            let shared = untimedCurrent.commonPrefix(with: next)
            if !shared.isEmpty && shared.count * 2 >= min(untimedCurrent.count, next.count) {
                untimedCurrent = next
            } else {
                let overlap = Self.suffixPrefixOverlap(untimedCurrent, next)
                if overlap >= 2 { untimedCurrent += String(next.dropFirst(overlap)) }
                else { untimedCompleted = Self.join(untimedCompleted, untimedCurrent); untimedCurrent = next }
            }
        }
        text = Self.join(untimedCompleted, untimedCurrent)
        return text
    }

    private static func normalized(_ value: String) -> String {
        let ignored = CharacterSet.whitespacesAndNewlines.union(.punctuationCharacters)
        return String(String.UnicodeScalarView(value.unicodeScalars.filter { !ignored.contains($0) }))
    }
    private static func suffixPrefixOverlap(_ a: String, _ b: String) -> Int {
        let lhs = Array(a), rhs = Array(b)
        guard !lhs.isEmpty && !rhs.isEmpty else { return 0 }
        for n in stride(from: min(lhs.count, rhs.count), through: 2, by: -1) {
            if lhs.suffix(n).elementsEqual(rhs.prefix(n)) { return n }
        }
        return 0
    }
    private static func join(_ a: String, _ b: String) -> String {
        guard !a.isEmpty else { return b }
        guard !b.isEmpty else { return a }
        let space = a.last?.isASCII == true && b.first?.isASCII == true && a.last?.isLetter == true && b.first?.isLetter == true
        return a + (space ? " " : "") + b
    }
}
