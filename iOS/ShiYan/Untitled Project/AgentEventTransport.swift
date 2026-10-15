import Foundation
import Network
import Security

 
 
final class AgentEventTransport: @unchecked Sendable {
    private let queue = DispatchQueue(label: "com.shiyan.events", qos: .userInitiated)
    private let certificate: Data
    private let request: Data
    private let host: String
    private let continuation: AsyncThrowingStream<Data, Error>.Continuation
    private var connection: NWConnection?
    private var http = AgentHTTPDecoder(maximumBodyBytes: 100 * 1024 * 1024)
    private var sse = AgentSSEDecoder()
    private var finished = false
    private var lastActivity = DispatchTime.now().uptimeNanoseconds
    private var timer: DispatchSourceTimer?

    init(host: String, path: String, headers: [String: String], certificate: Data,
         continuation: AsyncThrowingStream<Data, Error>.Continuation) {
        self.host = host; self.certificate = certificate; self.continuation = continuation
        var fields = headers; fields["Accept"] = "text/event-stream"
        self.request = (try? PinnedHTTPSClient.makeRequest(host: host, method: "GET", path: path, headers: fields, body: nil)) ?? Data()
    }
    func start() { queue.async { [self] in begin() } }
    func cancel() { queue.async { [self] in finish(CancellationError()) } }
    private func begin() {
        guard !finished, !request.isEmpty else { if !finished { finish(URLError(.badURL)) }; return }
        let tls = NWProtocolTLS.Options(), pinned = certificate
        sec_protocol_options_set_verify_block(tls.securityProtocolOptions, { _, trust, complete in
            let value = sec_trust_copy_ref(trust).takeRetainedValue()
            guard let cert = SecTrustGetCertificateAtIndex(value, 0) else { complete(false); return }
            complete((SecCertificateCopyData(cert) as Data) == pinned)
        }, queue)
        let tcp = NWProtocolTCP.Options(); tcp.noDelay = true
        let conn = NWConnection(host: NWEndpoint.Host(host), port: 443, using: NWParameters(tls: tls, tcp: tcp))
        connection = conn
        conn.stateUpdateHandler = { [self] state in
            switch state {
            case .ready:
                conn.send(content: request, completion: .contentProcessed { [self] error in
                    if let error { finish(error) } else { lastActivity = DispatchTime.now().uptimeNanoseconds; receive() }
                })
            case .failed(let error): finish(error)
            case .cancelled: finish(CancellationError())
            default: break
            }
        }
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now()+2, repeating: 2)
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            if Double(DispatchTime.now().uptimeNanoseconds-self.lastActivity)/1e9 > 25 { self.finish(URLError(.timedOut)) }
        }
        self.timer = timer; timer.resume(); conn.start(queue: queue)
    }
    private func receive() {
        guard !finished, let conn = connection else { return }
        conn.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [self] data, _, eof, error in
            guard !finished else { return }
            do {
                var chunks = [Data]()
                if let data, !data.isEmpty {
                    lastActivity = DispatchTime.now().uptimeNanoseconds
                    try http.feed(data) { chunks.append($0) }
                }
                if http.hasHeaders && http.status != 200 { throw AgentClientError.message("实时连接失败（\(http.status)）") }
                for chunk in chunks { try sse.feed(chunk) { continuation.yield($0) } }
                if let error { throw error }
                if http.isComplete { finish(nil); return }
                if eof { try http.finishEOF(); finish(nil); return }
                receive()
            } catch { finish(error) }
        }
    }
    private func finish(_ error: Error?) {
        guard !finished else { return }; finished = true
        timer?.setEventHandler {}; timer?.cancel(); timer = nil
        connection?.stateUpdateHandler = nil; connection?.cancel(); connection = nil
        if let error { continuation.finish(throwing: error) } else { continuation.finish() }
    }
}
