import Foundation
import Network
import Security

struct PinnedHTTPSResponse: Sendable {
    let statusCode: Int
    let headers: [String: String]
    let body: Data
}

enum PinnedHTTPSError: LocalizedError {
    case missingPinnedCertificate, invalidPort, connection(String), responseTooLarge, malformedResponse, invalidChunkedBody
    var errorDescription: String? {
        switch self {
        case .missingPinnedCertificate: "缺少服务器证书"
        case .invalidPort: "服务器端口无效"
        case .connection(let text): text
        case .responseTooLarge: "服务器响应过大"
        case .malformedResponse: "服务器响应格式无效"
        case .invalidChunkedBody: "服务器分块响应格式无效"
        }
    }
}

 
private final class AgentCancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    private var action: (@Sendable () -> Void)?
    func install(_ value: @escaping @Sendable () -> Void) {
        lock.lock(); action = value; let run = cancelled; lock.unlock()
        if run { value() }
    }
    func cancel() {
        lock.lock(); cancelled = true; let value = action; lock.unlock(); value?()
    }
}

nonisolated struct PinnedHTTPSDeadline: Sendable {
    let total: TimeInterval
    let idle: TimeInterval
    init(timeout: TimeInterval, idleTimeout: TimeInterval? = nil, requestBytes: Int = 0) {
        total = requestBytes > 256 * 1024 ? max(timeout, 120) : timeout
        idle = min(total, idleTimeout ?? 20)
    }
    func isExpired(elapsed: TimeInterval, idleElapsed: TimeInterval) -> Bool {
        elapsed > total || idleElapsed > idle
    }
}

final class PinnedHTTPSClient: @unchecked Sendable {
    static let shared = PinnedHTTPSClient()
    private init() {}
    func request(host: String, port: UInt16 = 443, method: String, path: String,
                 headers: [String: String] = [:], body: Data? = nil,
                 maxResponseBytes: Int = 32 * 1024 * 1024, timeout: TimeInterval = 35, idleTimeout: TimeInterval? = nil) async throws -> PinnedHTTPSResponse {
        guard let certificateURL = Bundle.main.url(forResource: "boss-codex", withExtension: "cer"),
              let certificate = try? Data(contentsOf: certificateURL) else { throw PinnedHTTPSError.missingPinnedCertificate }
        guard let nwPort = NWEndpoint.Port(rawValue: port) else { throw PinnedHTTPSError.invalidPort }
        let bytes = try Self.makeRequest(host: host, method: method, path: path, headers: headers, body: body)
        let cancellation = AgentCancellation()
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                let operation = AgentHTTPSOperation(host: host, port: nwPort, certificate: certificate,
                    request: bytes, limit: maxResponseBytes, timeout: timeout, idleTimeout: idleTimeout, continuation: continuation)
                cancellation.install { operation.cancel() }
                operation.start()
            }
        } onCancel: { cancellation.cancel() }
    }
    static func makeRequest(host: String, method: String, path: String, headers: [String: String], body: Data?) throws -> Data {
        guard ![host, method, path].contains(where: { $0.contains("\r") || $0.contains("\n") }) else { throw PinnedHTTPSError.malformedResponse }
        var fields: [String: String] = ["host": host, "accept": "application/json", "connection": "close", "accept-encoding": "identity"]
        for (key, value) in headers {
            guard !key.contains("\n"), !key.contains("\r"), !value.contains("\n"), !value.contains("\r") else { throw PinnedHTTPSError.malformedResponse }
            if !["host", "connection", "content-length", "transfer-encoding"].contains(key.lowercased()) { fields[key.lowercased()] = value }
        }
        if body != nil || ["POST", "PUT", "PATCH"].contains(method.uppercased()) { fields["content-length"] = String(body?.count ?? 0) }
        var lines = ["\(method) \(path.hasPrefix("/") ? path : "/"+path) HTTP/1.1"]
        lines += fields.sorted { $0.key < $1.key }.map { "\($0.key): \($0.value)" }
        var result = Data((lines.joined(separator: "\r\n") + "\r\n\r\n").utf8)
        if let body { result.append(body) }; return result
    }
}

private final class AgentHTTPSOperation: @unchecked Sendable {
    private let queue = DispatchQueue(label: "com.shiyan.https", qos: .userInitiated)
    private let host: String
    private let port: NWEndpoint.Port
    private let certificate: Data
    private let request: Data
    private let deadline: PinnedHTTPSDeadline
    private var parser: AgentHTTPDecoder
    private var responseBody = Data()
    private var connection: NWConnection?
    private var continuation: CheckedContinuation<PinnedHTTPSResponse, Error>?
    private var finished = false
    private var lastActivity = DispatchTime.now().uptimeNanoseconds
    private var started = DispatchTime.now().uptimeNanoseconds
    private var timer: DispatchSourceTimer?
    private var uploadOffset = 0
    private let uploadPartBytes = 64 * 1024

    init(host: String, port: NWEndpoint.Port, certificate: Data, request: Data, limit: Int, timeout: TimeInterval, idleTimeout: TimeInterval?,
         continuation: CheckedContinuation<PinnedHTTPSResponse, Error>) {
        self.host = host; self.port = port; self.certificate = certificate; self.request = request
         
         
        self.deadline = PinnedHTTPSDeadline(timeout: timeout, idleTimeout: idleTimeout, requestBytes: request.count)
        self.continuation = continuation; self.parser = AgentHTTPDecoder(maximumBodyBytes: limit)
    }
    func start() { queue.async { [self] in begin() } }
    func cancel() { queue.async { [self] in finish(.failure(CancellationError())) } }
    private func begin() {
        guard !finished else { return }
        started = DispatchTime.now().uptimeNanoseconds; lastActivity = started
        let tls = NWProtocolTLS.Options(), pinned = certificate
        sec_protocol_options_set_verify_block(tls.securityProtocolOptions, { _, trust, complete in
            let value = sec_trust_copy_ref(trust).takeRetainedValue()
            guard let cert = SecTrustGetCertificateAtIndex(value, 0) else { complete(false); return }
            complete((SecCertificateCopyData(cert) as Data) == pinned)
        }, queue)
        let tcp = NWProtocolTCP.Options(); tcp.noDelay = true
        let conn = NWConnection(host: NWEndpoint.Host(host), port: port, using: NWParameters(tls: tls, tcp: tcp))
        connection = conn
        conn.stateUpdateHandler = { [self] state in
            switch state {
            case .ready:
                lastActivity = DispatchTime.now().uptimeNanoseconds
                sendNextPart()
            case .failed(let error): finish(.failure(error))
            case .cancelled: finish(.failure(CancellationError()))
            default: break
            }
        }
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now()+1, repeating: 1)
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            let now = DispatchTime.now().uptimeNanoseconds
            if self.deadline.isExpired(elapsed: Double(now-self.started)/1e9, idleElapsed: Double(now-self.lastActivity)/1e9) {
                self.finish(.failure(URLError(.timedOut)))
            }
        }
        self.timer = timer; timer.resume(); conn.start(queue: queue)
    }
     
     
    private func sendNextPart() {
        guard !finished, let conn = connection else { return }
        guard uploadOffset < request.count else { receive(); return }
        let end = min(uploadOffset + uploadPartBytes, request.count)
        let part = request.subdata(in: uploadOffset..<end)
        conn.send(content: part, completion: .contentProcessed { [self] error in
            guard !finished else { return }
            if let error { finish(.failure(error)); return }
            uploadOffset = end
            lastActivity = DispatchTime.now().uptimeNanoseconds
            sendNextPart()
        })
    }
    private func receive() {
        guard !finished, let conn = connection else { return }
        conn.receive(minimumIncompleteLength: 1, maximumLength: 256 * 1024) { [self] data, _, eof, error in
            guard !finished else { return }
            do {
                if let data, !data.isEmpty {
                    lastActivity = DispatchTime.now().uptimeNanoseconds
                    var incoming = Data()
                    try parser.feed(data) { incoming.append($0) }
                    responseBody.append(incoming)
                }
                if parser.isComplete { finish(.success(PinnedHTTPSResponse(statusCode: parser.status, headers: parser.headers, body: responseBody))); return }
                if let error { throw error }
                if eof {
                    try parser.finishEOF()
                    finish(.success(PinnedHTTPSResponse(statusCode: parser.status, headers: parser.headers, body: responseBody))); return
                }
                receive()
            } catch { finish(.failure(error)) }
        }
    }
    private func finish(_ result: Result<PinnedHTTPSResponse, Error>) {
        guard !finished else { return }; finished = true
        timer?.setEventHandler {}; timer?.cancel(); timer = nil
        connection?.stateUpdateHandler = nil; connection?.cancel(); connection = nil
        let continuation = continuation; self.continuation = nil
        continuation?.resume(with: result)
    }
}
