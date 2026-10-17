import Foundation

// Each reply keeps one durable message ID while its cumulative text grows.
// Raw offsets, rather than the repeatedly rendered Markdown, prevent replay.
struct DotsVoiceReplyQueue {
    struct Message {
        var id: Int
        var role: String
        var text: String
        var respondsTo: [Int] = []
        var createdAt: TimeInterval?
        var deliveryState: String?
        var revision: Int?
        var completed: Bool { deliveryState == nil || deliveryState == "completed" }
        var terminal: Bool { completed || ["failed", "cancelled"].contains(deliveryState ?? "") }
    }
    struct Reply: Equatable {
        var id: Int
        var text: String
    }
    private struct Stream {
        var raw = ""
        var consumed = 0
        var revision = -1
        var terminal = false
        var respondsTo = Set<Int>()
    }

    private var floor = 0
    private var startedAt: TimeInterval = 0
    private var streams: [Int: Stream] = [:]
    private var suppressed = Set<Int>()
    private(set) var replies: [Reply] = []
    var hasOpenStreams: Bool { streams.contains { !suppressed.contains($0.key) && !$0.value.terminal } }

    mutating func begin(history: [Message], at date: TimeInterval) {
        reset()
        // An already-running stream belongs to history too. Joining a call
        // must not pick up the second half of an earlier conversation.
        floor = history.map(\.id).max() ?? 0
        startedAt = date
    }

    @discardableResult
    mutating func observe(_ messages: [Message], pendingMessageID: Int?) -> Bool {
        var answered = false
        for message in messages.sorted(by: { $0.id < $1.id }) where message.role == "assistant" && message.id > 0 {
            let related = pendingMessageID.map { message.respondsTo.contains($0) } ?? false
            if message.id <= floor || suppressed.contains(message.id) {
                // A cached retry may settle without replaying history.
                if related && message.terminal { answered = true }
                continue
            }
            let stamp = message.createdAt.map { $0 > 1_000_000_000_000 ? $0 / 1000 : $0 }
            if !related, let stamp, stamp > 0, stamp < startedAt - 1 { continue }
            var stream = streams[message.id] ?? Stream()
            let revision = message.revision ?? 0
            guard revision >= stream.revision else { continue }
            if message.deliveryState == nil, stream.revision >= 0, !stream.terminal { continue }
            if stream.terminal {
                if related { answered = true }
                continue
            }
            // Only committed raw text is immutable for playback. A newer
            // snapshot may repair an unspoken tail without replaying a sentence
            // already queued; a rewrite of committed text is safely suppressed.
            let committedPrefix = String(stream.raw.prefix(stream.consumed))
            guard message.text.utf8.starts(with: committedPrefix.utf8) else {
                suppressed.insert(message.id)
                replies.removeAll { $0.id == message.id }
                if related && message.terminal { answered = true }
                continue
            }
            let result = Self.readyChunks(message.text, from: stream.consumed, flushTail: message.completed)
            for text in result.chunks { replies.append(Reply(id: message.id, text: text)) }
            stream.raw = message.text
            stream.consumed = result.consumed
            stream.revision = revision
            stream.terminal = message.terminal
            stream.respondsTo.formUnion(message.respondsTo)
            streams[message.id] = stream
            if related && message.terminal { answered = true }
        }
        // Preserve sentence order within each stable message ID as new chunks
        // arrive around independent worker reports.
        replies = replies.enumerated().sorted {
            $0.element.id == $1.element.id ? $0.offset < $1.offset : $0.element.id < $1.element.id
        }.map(\.element)
        return answered
    }

    mutating func popFirst() -> Reply? {
        replies.isEmpty ? nil : replies.removeFirst()
    }

    // Suppress the entire in-flight reply, including future deltas. Otherwise
    // the next SSE update would resume speech immediately after interruption.
    @discardableResult
    mutating func discardPending(including currentMessageID: Int? = nil) -> Set<Int> {
        var discarded = Set(streams.filter { !$0.value.terminal }.map(\.key))
        discarded.formUnion(replies.map(\.id))
        if let currentMessageID { discarded.insert(currentMessageID) }
        suppressed.formUnion(discarded)
        let answeredRequests = discarded.reduce(into: Set<Int>()) { result, id in
            result.formUnion(streams[id]?.respondsTo ?? [])
        }
        replies.removeAll()
        return answeredRequests
    }

    mutating func reset() {
        replies.removeAll()
        streams.removeAll()
        suppressed.removeAll()
        floor = 0
        startedAt = 0
    }

    // Only consume complete sentences (or a completed reply's final tail).
    // Fenced code remains visible in chat but is omitted from speech. An open
    // fence is left unconsumed until later snapshots supply its closing line.
    private static func readyChunks(_ raw: String, from offset: Int, flushTail: Bool) -> (chunks: [String], consumed: Int) {
        let chars = Array(raw)
        var index = min(offset, chars.count), consumed = min(offset, chars.count)
        var chunks: [String] = [], text = ""
        var fence: (marker: Character, count: Int)?
        let closers: Set<Character> = ["”", "’", "」", "』", "）", ")", "]", "\""]

        func fenceAt(_ position: Int) -> (marker: Character, count: Int)? {
            guard position < chars.count, chars[position] == "`" || chars[position] == "~" else { return nil }
            var lineStart = position
            while lineStart > 0 && chars[lineStart - 1] != "\n" { lineStart -= 1 }
            guard position - lineStart <= 3,
                  chars[lineStart..<position].allSatisfy({ $0 == " " || $0 == "\t" }) else { return nil }
            let marker = chars[position]
            var end = position
            while end < chars.count && chars[end] == marker { end += 1 }
            return end - position >= 3 ? (marker, end - position) : nil
        }
        func nextLine(after position: Int) -> Int {
            var end = position
            while end < chars.count && chars[end] != "\n" { end += 1 }
            return end < chars.count ? end + 1 : end
        }
        func commit() {
            let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !value.isEmpty { chunks.append(value) }
            text = ""
            consumed = index
        }

        while index < chars.count {
            if let current = fence {
                if let closing = fenceAt(index), closing.marker == current.marker, closing.count >= current.count {
                    index = nextLine(after: index + closing.count)
                    fence = nil
                    if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { consumed = index; text = "" }
                } else { index += 1 }
                continue
            }
            if let opening = fenceAt(index) {
                fence = opening
                index = nextLine(after: index + opening.count)
                continue
            }
            let char = chars[index]
            text.append(char)
            index += 1
            // A dot needs its following whitespace so decimals, hostnames and
            // incomplete English tokens do not become separate utterances.
            let dotBoundary = char == "." && index < chars.count && chars[index].isWhitespace
            if "。！？!?；;\n".contains(char) || dotBoundary {
                while index < chars.count && closers.contains(chars[index]) { text.append(chars[index]); index += 1 }
                commit()
            }
        }
        if flushTail && fence == nil { commit() }
        return (chunks, consumed)
    }
}
