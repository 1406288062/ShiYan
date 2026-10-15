import Foundation

 
 
struct AgentHTTPDecoder {
    enum Mode { case headers, fixed(Int), chunkSize, chunkData(Int), chunkEnd, trailers, eof, done }
    private var mode: Mode = .headers
    private var buffer = Data()
    private var cursor = 0
    private(set) var status = 0
    private(set) var headers: [String: String] = [:]
    private(set) var bodyBytes = 0
    let maximumBodyBytes: Int
    var isComplete: Bool { if case .done = mode { return true }; return false }
    var hasHeaders: Bool { status != 0 }
    private var remaining: Int { buffer.count - cursor }
    private func index(_ n: Int) -> Data.Index { buffer.index(buffer.startIndex, offsetBy: n) }
    private func delimiter(_ text: String) -> Range<Data.Index>? {
        buffer.range(of: Data(text.utf8), in: index(cursor)..<buffer.endIndex)
    }
    private mutating func advance(_ n: Int) { cursor += n }
    mutating func feed(_ bytes: Data, deliver: (Data) throws -> Void) throws {
        buffer.append(bytes)
        while true {
            switch mode {
            case .headers:
                guard let end = delimiter("\r\n\r\n") else {
                    if remaining > 65536 { throw URLError(.cannotParseResponse) }; compact(); return
                }
                let head = String(decoding: buffer[index(cursor)..<end.lowerBound], as: UTF8.self)
                let lines = head.components(separatedBy: "\r\n")
                guard let first = lines.first, first.hasPrefix("HTTP/1."),
                      let code = Int(first.split(separator: " ").dropFirst().first ?? "") else { throw URLError(.cannotParseResponse) }
                cursor = buffer.distance(from: buffer.startIndex, to: end.upperBound)
                if (100..<200).contains(code) && code != 101 { continue }
                status = code; headers = [:]
                for line in lines.dropFirst() {
                    guard let colon = line.firstIndex(of: ":") else { throw URLError(.cannotParseResponse) }
                    let key = line[..<colon].lowercased().trimmingCharacters(in: .whitespaces)
                    let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
                    if key == "content-length", let old = headers[key], old != value { throw URLError(.cannotParseResponse) }
                    headers[key] = value
                }
                if code == 204 || code == 304 { mode = .done }
                else if headers["transfer-encoding"]?.lowercased().contains("chunked") == true { mode = .chunkSize }
                else if let value = headers["content-length"] {
                    guard let size = Int(value), size >= 0, size <= maximumBodyBytes else { throw URLError(.dataLengthExceedsMaximum) }
                    mode = size == 0 ? .done : .fixed(size)
                } else { mode = .eof }
            case .fixed(let count):
                guard remaining > 0 else { compact(); return }
                let n = min(count, remaining); try emit(n, deliver)
                mode = n == count ? .done : .fixed(count - n)
            case .chunkSize:
                guard let end = delimiter("\r\n") else {
                    if remaining > 1024 { throw URLError(.cannotParseResponse) }; compact(); return
                }
                let line = String(decoding: buffer[index(cursor)..<end.lowerBound], as: UTF8.self)
                guard let size = Int(line.split(separator: ";").first?.trimmingCharacters(in: .whitespaces) ?? "", radix: 16), size >= 0,
                      size <= maximumBodyBytes - bodyBytes else { throw URLError(.cannotParseResponse) }
                cursor = buffer.distance(from: buffer.startIndex, to: end.upperBound)
                mode = size == 0 ? .trailers : .chunkData(size)
            case .chunkData(let count):
                guard remaining > 0 else { compact(); return }
                let n = min(remaining, count); try emit(n, deliver)
                mode = n == count ? .chunkEnd : .chunkData(count - n)
            case .chunkEnd:
                guard remaining >= 2 else { compact(); return }
                guard buffer[index(cursor)] == 13, buffer[index(cursor+1)] == 10 else { throw URLError(.cannotParseResponse) }
                advance(2); mode = .chunkSize
            case .trailers:
                guard let end = delimiter("\r\n") else {
                    if remaining > 65536 { throw URLError(.cannotParseResponse) }; compact(); return
                }
                let empty = end.lowerBound == index(cursor)
                cursor = buffer.distance(from: buffer.startIndex, to: end.upperBound)
                if empty { mode = .done }
            case .eof:
                if remaining > 0 { try emit(remaining, deliver) }; compact(); return
            case .done: compact(); return
            }
        }
    }
    mutating func finishEOF() throws {
        switch mode { case .eof: mode = .done; case .done: break; default: throw URLError(.networkConnectionLost) }
    }
    private mutating func emit(_ n: Int, _ deliver: (Data) throws -> Void) throws {
        guard n <= maximumBodyBytes - bodyBytes else { throw URLError(.dataLengthExceedsMaximum) }
        let data = Data(buffer[index(cursor)..<index(cursor+n)])
        advance(n); bodyBytes += n; try deliver(data)
    }
    private mutating func compact() {
        if cursor == buffer.count { buffer.removeAll(keepingCapacity: true); cursor = 0 }
        else if cursor >= 65536 { buffer = Data(buffer.dropFirst(cursor)); cursor = 0 }
    }
}

 
struct AgentSSEDecoder {
    private var line = Data()
    private var fields = [Data]()
    private var eventBytes = 0
    mutating func feed(_ data: Data, deliver: (Data) throws -> Void) throws {
        for byte in data {
            if byte == 10 {
                if line.last == 13 { line.removeLast() }
                if line.isEmpty {
                    if !fields.isEmpty {
                        var result = Data()
                        for (i, field) in fields.enumerated() { if i > 0 { result.append(10) }; result.append(field) }
                        try deliver(result)
                    }
                    fields.removeAll(keepingCapacity: true); eventBytes = 0
                } else if line.starts(with: [100, 97, 116, 97, 58]) {
                    var value = line.dropFirst(5); if value.first == 32 { value = value.dropFirst() }
                    fields.append(Data(value))
                }
                line.removeAll(keepingCapacity: true)
            } else { line.append(byte); eventBytes += 1 }
            guard eventBytes <= 40 * 1024 * 1024 else { throw URLError(.dataLengthExceedsMaximum) }
        }
    }
}
