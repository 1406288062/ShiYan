import Foundation

enum AgentMarkdownAlignment: Equatable { case leading, center, trailing }

struct AgentMarkdownBlock: Identifiable, Equatable {
    enum Kind: Equatable {
        case prose
        case code(language: String)
        case heading(level: Int)
        case quote
        case listItem(marker: String, indentation: Int, checked: Bool?)
        case table(rows: [[String]], alignments: [AgentMarkdownAlignment])
        case rule
    }
    var id: Int
    var content: String
    var kind: Kind
}

 
enum AgentMarkdownParser {
    private final class CachedBlocks: NSObject {
        let value: [AgentMarkdownBlock]
        init(_ value: [AgentMarkdownBlock]) { self.value = value }
    }
    private static let cache: NSCache<NSString, CachedBlocks> = {
        let cache = NSCache<NSString, CachedBlocks>()
        cache.countLimit = 64; cache.totalCostLimit = 2_000_000
        return cache
    }()
    private struct Fence { var character: Character; var count: Int; var language: String }
    static func blocks(_ text: String) -> [AgentMarkdownBlock] {
        if let cached = cache.object(forKey: text as NSString) { return cached.value }
        let result = parse(text)
        cache.setObject(CachedBlocks(result), forKey: text as NSString, cost: text.utf8.count)
        return result
    }
    private static func parse(_ text: String) -> [AgentMarkdownBlock] {
        let lines = text.replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n").components(separatedBy: "\n")
        var blocks: [AgentMarkdownBlock] = [], prose: [String] = []
        var index = 0
        func append(_ content: String, _ kind: AgentMarkdownBlock.Kind) {
            blocks.append(AgentMarkdownBlock(id: blocks.count, content: content, kind: kind))
        }
        func flush() {
            if !prose.isEmpty {
                let content = prose.joined(separator: "\n").trimmingCharacters(in: .newlines)
                if !content.isEmpty { append(content, .prose) }
                prose.removeAll()
            }
        }
        while index < lines.count {
            let line = lines[index]
            if let fence = openingFence(line) {
                flush()
                index += 1
                var code: [String] = []
                while index < lines.count, !closesFence(lines[index], fence: fence) {
                    code.append(lines[index]); index += 1
                }
                 
                append(code.joined(separator: "\n"), .code(language: fence.language))
                if index < lines.count { index += 1 }
                continue
            }
            let cells = AgentTableParser.cells(line)
            if index + 1 < lines.count, AgentTableParser.hasDelimiter(line),
               let alignments = AgentTableParser.alignments(lines[index + 1], columns: cells.count) {
                flush()
                var rows = [cells]
                index += 2
                while index < lines.count, AgentTableParser.hasDelimiter(lines[index]),
                      !lines[index].trimmingCharacters(in: .whitespaces).isEmpty {
                    let row = AgentTableParser.cells(lines[index])
                    rows.append(Array((row + Array(repeating: "", count: cells.count)).prefix(cells.count)))
                    index += 1
                }
                append("", .table(rows: rows, alignments: alignments))
                continue
            }
            if let heading = atxHeading(line) {
                flush(); append(heading.text, .heading(level: heading.level)); index += 1; continue
            }
            if index + 1 < lines.count, !line.trimmingCharacters(in: .whitespaces).isEmpty,
               quoteText(line) == nil, listItem(line) == nil, !isRule(line),
               let level = setextLevel(lines[index + 1]) {
                flush(); append(line.trimmingCharacters(in: .whitespaces), .heading(level: level))
                index += 2; continue
            }
            if isRule(line) {
                flush(); append("", .rule); index += 1; continue
            }
            if let quoted = quoteText(line) {
                flush()
                var quote = [quoted]
                index += 1
                while index < lines.count, let next = quoteText(lines[index]) {
                    quote.append(next); index += 1
                }
                append(quote.joined(separator: "\n"), .quote)
                continue
            }
            if let item = listItem(line) {
                flush()
                var content = [item.text]
                index += 1
                while index < lines.count, !lines[index].trimmingCharacters(in: .whitespaces).isEmpty,
                      listItem(lines[index]) == nil, openingFence(lines[index]) == nil,
                      leadingSpaces(lines[index]) >= item.contentIndent {
                    content.append(String(lines[index].dropFirst(item.contentIndent))); index += 1
                }
                append(content.joined(separator: "\n"), .listItem(marker: item.marker, indentation: item.indentation, checked: item.checked))
                continue
            }
            if line.trimmingCharacters(in: .whitespaces).isEmpty {
                flush(); index += 1; continue
            }
            prose.append(line); index += 1
        }
        flush()
        return blocks
    }
    private static func leadingSpaces(_ line: String) -> Int { line.prefix { $0 == " " }.count }
    private static func openingFence(_ line: String) -> Fence? {
        let indentation = leadingSpaces(line)
        guard indentation <= 3 else { return nil }
        let source = String(line.dropFirst(indentation))
        guard let character = source.first, character == "\u{0060}" || character == "~" else { return nil }
        let count = source.prefix { $0 == character }.count
        guard count >= 3 else { return nil }
        let info = String(source.dropFirst(count)).trimmingCharacters(in: .whitespaces)
        if character == "\u{0060}", info.contains("\u{0060}") { return nil }
        return Fence(character: character, count: count, language: info.split(whereSeparator: { $0.isWhitespace }).first.map(String.init) ?? "")
    }
    private static func closesFence(_ line: String, fence: Fence) -> Bool {
        let indentation = leadingSpaces(line)
        guard indentation <= 3 else { return false }
        let source = String(line.dropFirst(indentation))
        let count = source.prefix { $0 == fence.character }.count
        return count >= fence.count && source.dropFirst(count).allSatisfy { $0.isWhitespace }
    }
    private static func atxHeading(_ line: String) -> (level: Int, text: String)? {
        let indentation = leadingSpaces(line)
        guard indentation <= 3 else { return nil }
        let source = String(line.dropFirst(indentation))
        let level = source.prefix { $0 == "#" }.count
        guard (1...6).contains(level), source.count == level || source.dropFirst(level).first?.isWhitespace == true else { return nil }
        var content = String(source.dropFirst(level)).trimmingCharacters(in: .whitespaces)
        if let range = content.range(of: #"\s+#+\s*$"#, options: .regularExpression) { content.removeSubrange(range) }
        return (level, content)
    }
    private static func setextLevel(_ line: String) -> Int? {
        guard leadingSpaces(line) <= 3 else { return nil }
        let value = line.trimmingCharacters(in: .whitespaces)
        guard !value.isEmpty else { return nil }
        if value.allSatisfy({ $0 == "=" }) { return 1 }
        if value.allSatisfy({ $0 == "-" }) { return 2 }
        return nil
    }
    private static func isRule(_ line: String) -> Bool {
        guard leadingSpaces(line) <= 3 else { return false }
        let value = line.filter { !$0.isWhitespace }
        guard value.count >= 3, let first = value.first, ["-", "*", "_"].contains(String(first)) else { return false }
        return value.allSatisfy { $0 == first }
    }
    private static func quoteText(_ line: String) -> String? {
        let indentation = leadingSpaces(line)
        guard indentation <= 3 else { return nil }
        let source = line.dropFirst(indentation)
        guard source.first == ">" else { return nil }
        var content = String(source.dropFirst())
        if content.hasPrefix(" ") { content.removeFirst() }
        return content
    }
    private static func listItem(_ line: String) -> (marker: String, indentation: Int, contentIndent: Int, checked: Bool?, text: String)? {
        let indentation = leadingSpaces(line)
        let source = String(line.dropFirst(indentation))
        guard let match = source.range(of: #"^(?:[-+*]|\d{1,9}[.)])[ \t]+"#, options: .regularExpression) else { return nil }
        let prefix = String(source[match])
        let originalMarker = prefix.trimmingCharacters(in: .whitespaces)
        var text = String(source[match.upperBound...])
        var checked: Bool?
        if let box = text.range(of: #"^\[[ xX]\][ \t]+"#, options: .regularExpression) {
            checked = text[text.index(after: text.startIndex)] != " "
            text.removeSubrange(box)
        }
        let marker = ["-", "+", "*"].contains(originalMarker) ? "•" : originalMarker
        return (marker, indentation, indentation + prefix.count, checked, text)
    }
}

 
enum AgentTableParser {
    private static func split(_ line: String) -> (cells: [String], delimiters: Int) {
        let source = Array(line.trimmingCharacters(in: .whitespaces))
        var result: [String] = [], cell = "", index = 0, codeLength = 0, delimiters = 0, lastWasDelimiter = false
        func matchingCodeRun(after start: Int, count: Int) -> Bool {
            var position = start
            while position < source.count {
                if source[position] == "\\" { position += 2; continue }
                if source[position] == "\u{0060}" {
                    var end = position + 1
                    while end < source.count, source[end] == "\u{0060}" { end += 1 }
                    if end - position == count { return true }
                    position = end
                } else { position += 1 }
            }
            return false
        }
        while index < source.count {
            let character = source[index]
            lastWasDelimiter = false
            if character == "\\", index + 1 < source.count {
                 
                cell.append(character); cell.append(source[index + 1]); index += 2; continue
            }
            if character == "\u{0060}" {
                var end = index + 1
                while end < source.count, source[end] == "\u{0060}" { end += 1 }
                let count = end - index
                if codeLength == count { codeLength = 0 }
                else if codeLength == 0, matchingCodeRun(after: end, count: count) { codeLength = count }
                cell += String(repeating: "\u{0060}", count: count); index = end; continue
            }
            if character == "|", codeLength == 0 {
                result.append(cell.trimmingCharacters(in: .whitespaces)); cell = ""
                delimiters += 1; lastWasDelimiter = true
            } else { cell.append(character) }
            index += 1
        }
        result.append(cell.trimmingCharacters(in: .whitespaces))
        if source.first == "|", result.first == "" { result.removeFirst() }
        if lastWasDelimiter, result.last == "" { result.removeLast() }
        return (result, delimiters)
    }
    static func cells(_ line: String) -> [String] { split(line).cells }
    static func hasDelimiter(_ line: String) -> Bool { split(line).delimiters > 0 }
    static func isSeparator(_ line: String, columns: Int) -> Bool { alignments(line, columns: columns) != nil }
    static func alignments(_ line: String, columns: Int) -> [AgentMarkdownAlignment]? {
        let values = cells(line)
        guard columns > 0, values.count == columns,
              values.allSatisfy({ $0.range(of: "^:?-{3,}:?$", options: .regularExpression) != nil }) else { return nil }
        return values.map {
            if $0.hasPrefix(":"), $0.hasSuffix(":") { return .center }
            return $0.hasSuffix(":") ? .trailing : .leading
        }
    }
}


 
enum AgentCodeSizing {
    static func preview(_ text: String) -> String {
        var bytes: [UInt8] = []; bytes.reserveCapacity(32768)
        var lines = 0
        for byte in text.utf8 {
            if bytes.count >= 32768 || lines >= 200 { break }
            bytes.append(byte)
            if byte == 10 { lines += 1 }
        }
        return String(decoding: bytes, as: UTF8.self)
    }
    static func width(_ text: String, pointSize: Double) -> Double {
        let maximum = 2048.0, glyph = max(1, pointSize * 0.64)
        var columns = 0, longest = 0, scanned = 0
        for scalar in text.unicodeScalars {
            scanned += 1
            if scanned > 16384 { return maximum }
            if scalar.value == 10 || scalar.value == 13 { longest = max(longest, columns); columns = 0 }
            else if scalar.value == 9 { columns += 4 - columns % 4 }
            else { columns += scalar.value > 255 ? 2 : 1 }
            if Double(columns) * glyph + 8 >= maximum { return maximum }
        }
        return min(maximum, max(36, ceil(Double(max(longest, columns)) * glyph + 8)))
    }
}
