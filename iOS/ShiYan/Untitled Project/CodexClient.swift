import Foundation
import UIKit
import Security
import CryptoKit

 
struct CodexHistoryTurn {
    let role: String
    let text: String
}

struct CodexFileUpload {
    let data: Data
    let filename: String
}

struct CodexImageUpload {
    let data: Data
    let suffix: String
    static func photo(_ image: UIImage, quality: CGFloat = 0.95) -> CodexImageUpload? {
        guard let data = image.jpegData(compressionQuality: quality) else { return nil }
        return CodexImageUpload(data: data, suffix: ".jpg")
    }
    static func png(_ image: UIImage) -> CodexImageUpload? {
        guard let data = image.pngData() else { return nil }
        return CodexImageUpload(data: data, suffix: ".png")
    }
}

struct CodexTurnResult {
    let text: String
    let images: [UIImage]
    let threadId: String?
    var image: UIImage? { images.last }
}

enum AgentClientError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case let .message(value) = self { return value }; return nil }
}

struct AgentRemoteAsset: Decodable {
    let id: String
    let filename: String
    let mimeType: String
    let bytes: Int?
}

 
indirect enum AgentJSON: Codable {
    case object([String: AgentJSON]), array([AgentJSON]), string(String), number(Double), bool(Bool), null
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode([String: AgentJSON].self) { self = .object(v) }
        else { self = .array(try c.decode([AgentJSON].self)) }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .object(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        case .null: try c.encodeNil()
        }
    }
    var pretty: String {
        let e = JSONEncoder(); e.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return (try? e.encode(self)).flatMap { String(data: $0, encoding: .utf8) } ?? ""
    }
}

struct AgentEvent: Decodable {
    let seq: Int
    let type: String
    var phase: String?
    var label: String?
    var text: String?
    var error: String?
    var threadId: String?
    var reasoning: String?
    var asset: AgentRemoteAsset?
    var data: String?
    var dataMimeType: String?
    var dataFilename: String?
    var assets: [AgentRemoteAsset]?
    var items: AgentJSON?
    var displayItems: [AgentSyncValue]?
    var fileChanges: [AgentSyncValue]?
    var usage: [String: AgentSyncValue]?
    var isTerminal: Bool { ["completed", "failed", "cancelled", "interrupted"].contains(type) }
}

@MainActor
final class CodexClient {
    static let shared = CodexClient()
    private var enrolled = false
    private let host = "129.226.81.110"

    private func request(method: String, route: String, object: [String: Any]? = nil) throws -> URLRequest {
        let data = try object.map { try JSONSerialization.data(withJSONObject: $0, options: [.sortedKeys, .withoutEscapingSlashes]) } ?? Data()
        let fullPath = "/shiyan/v1/" + route
        guard let url = URL(string: "https://\(host)\(fullPath)") else { throw AgentClientError.message("服务地址无效") }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.httpBody = data.isEmpty ? nil : data
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("mobile", forHTTPHeaderField: "X-Shiyan-Sync-Profile")
        for (key, value) in try AgentIdentity.shared.headers(method: method, path: fullPath, body: data) { req.setValue(value, forHTTPHeaderField: key) }
        return req
    }
    private func response(_ request: URLRequest, timeout: TimeInterval = 35, rejectDotsErrors: Bool = false, rejectScheduleErrors: Bool = false) async throws -> PinnedHTTPSResponse {
        guard let url = request.url else { throw AgentClientError.message("服务地址无效") }
        let route = url.path + (url.query.map { "?" + $0 } ?? "")
        let result = try await PinnedHTTPSClient.shared.request(host: host, method: request.httpMethod ?? "GET", path: route,
            headers: request.allHTTPHeaderFields ?? [:], body: request.httpBody, maxResponseBytes: 40 * 1024 * 1024,
            timeout: route.hasSuffix("/cancel") ? 10 : timeout)
        guard (200...299).contains(result.statusCode) else {
#if DEBUG
            NSLog("[ShiyanHTTPFailure] path=%@ status=%d contentType=%@ response=%@", route, result.statusCode,
                  result.headers["content-type"] ?? "", String(data: result.body.prefix(160), encoding: .utf8) ?? "binary")
#endif
            if result.statusCode == 401 { enrolled = false }
            let message = (try? JSONSerialization.jsonObject(with: result.body) as? [String: Any])?["error"] as? String
            let rejectionCode = (try? JSONSerialization.jsonObject(with: result.body) as? [String: Any])?["code"] as? String
            if rejectScheduleErrors && [400, 403, 404, 409, 422].contains(result.statusCode) {
                throw ScheduledTaskRejected(status: result.statusCode, message: message ?? "服务器未接受此修改（\(result.statusCode)）")
            }
            if rejectDotsErrors && [400, 403, 404, 409, 422].contains(result.statusCode) && rejectionCode != "action_uncertain" {
                throw DotsRejectedRequest(status: result.statusCode, message: message ?? "服务器未接受此操作（\(result.statusCode)）")
            }
            throw AgentClientError.message(message ?? "服务暂不可用（\(result.statusCode)）")
        }
        return result
    }
    private func send(_ request: URLRequest) async throws -> Data { try await response(request).body }
    func sync(after: Int, mutations: [AgentSyncMutation]? = nil) async throws -> AgentSyncResponse {
        try await prepareConnection()
        if let mutations {
            let encoded = try JSONEncoder().encode(mutations)
            let object = try JSONSerialization.jsonObject(with: encoded)
            let bytes = try await send(request(method: "POST", route: "sync", object: ["after": after, "mutations": object]))
            return try await Self.decodeSync(bytes)
        }
        let bytes = try await send(request(method: "GET", route: "sync?after=\(after)&limit=200"))
        return try await Self.decodeSync(bytes)
    }
    nonisolated private static func decodeSync(_ bytes: Data) async throws -> AgentSyncResponse {
        try await Task.detached(priority: .utility) { try JSONDecoder().decode(AgentSyncResponse.self, from: bytes) }.value
    }
    func scheduledTaskListing() async throws -> ScheduledTaskListing {
        try await prepareConnection()
        let bytes = try await send(request(method: "GET", route: "sync/schedules"))
        return try JSONDecoder().decode(ScheduledTaskListing.self, from: bytes)
    }
    func scheduledTaskMutate(_ operation: ScheduledTaskPending) async throws -> ScheduledTaskMutationReply {
        try await prepareConnection()
        var object: [String: Any] = ["requestId": operation.requestId, "id": operation.id, "revision": operation.revision]
        if let task = operation.task { object["task"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(task)) }
        let bytes = try await response(request(method: operation.method, route: operation.route, object: object), rejectScheduleErrors: true).body
        return try JSONDecoder().decode(ScheduledTaskMutationReply.self, from: bytes)
    }
    func memorySettings() async throws -> ShiyanMemorySettings {
        try await prepareConnection()
        let bytes = try await send(request(method: "GET", route: "memory/settings"))
        return try JSONDecoder().decode(ShiyanMemorySettings.self, from: bytes)
    }
    func setMemoryEnabled(_ enabled: Bool) async throws -> ShiyanMemorySettings {
        try await prepareConnection()
        let bytes = try await send(request(method: "PATCH", route: "memory/settings", object: ["enabled": enabled]))
        return try JSONDecoder().decode(ShiyanMemorySettings.self, from: bytes)
    }

    func accountQuota() async throws -> CodexQuota {
        try await prepareConnection()
        let bytes = try await response(request(method: "GET", route: "account/quota"), timeout: 20).body
        return try JSONDecoder().decode(CodexQuotaResponse.self, from: bytes).quota
    }

    func executionDetails(messageID: UUID) async throws -> AgentExecutionPayload {
        try await prepareConnection()
        let bytes = try await response(request(method: "GET", route: "sync/messages/" + messageID.uuidString.lowercased() + "/details"), timeout: 90).body
        return try await Task.detached(priority: .utility) {
            var value = try JSONDecoder().decode(AgentExecutionPayload.self, from: bytes)
            value.fullJSON = value.rawResult ?? String(data: bytes, encoding: .utf8)
            return value
        }.value
    }
    func uploadSyncAsset(id: String, asset: AgentAsset) async throws {
        let bytes = try Data(contentsOf: asset.url)
        _ = try await send(request(method: "POST", route: "sync/assets", object: ["id": id, "filename": asset.filename, "mimeType": asset.mimeType, "data": bytes.base64EncodedString()]))
    }
    func syncAsset(id: String) async throws -> Data {
        try await prepareConnection()
        let result = try await receiveArtifact(route: "sync/assets/" + id, onProgress: nil)
        if let expected = result.headers["x-content-sha256"] {
            let actual = SHA256.hash(data: result.body).map { String(format: "%02x", $0) }.joined()
            guard expected == actual else { throw AgentClientError.message("图片校验失败，请重试") }
        }
        return result.body
    }
    func prepareConnection() async throws {
        guard !enrolled else { return }
        let values = try AgentIdentity.shared.enrollment()
        let data = try await send(request(method: "POST", route: "enroll", object: values))
        let result = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        enrolled = result?["approved"] as? Bool == true
        if !enrolled { throw AgentClientError.message("此设备尚未获得服务器授权，请批准设备后重试") }
    }
     
     
    var capabilitiesCacheScope: String? {
        guard let identity = try? AgentIdentity.shared.enrollment()["deviceID"] else { return nil }
        return "https://\(host)/shiyan/v1|\(identity)"
    }
    func capabilities() async throws -> AgentCapabilities {
        try await prepareConnection()
        let data = try await send(request(method: "GET", route: "capabilities"))
        return try JSONDecoder().decode(AgentCapabilities.self, from: data)
    }
    func createJob(prompt: String, uploads: [CodexImageUpload], conversationID: String,
                   requestID: String, reasoning: String, model: String? = nil, history: [CodexHistoryTurn] = [], files: [CodexFileUpload] = []) async throws -> String {
        try await prepareConnection()
        var payload: [String: Any] = [
            "prompt": prompt,  
            "conversationId": conversationID, "requestId": requestID, "reasoning": reasoning,
            "images": uploads.map { ["data": $0.data.base64EncodedString(), "suffix": $0.suffix] }
        ]
        if !files.isEmpty { payload["files"] = files.map { ["data": $0.data.base64EncodedString(), "filename": $0.filename] } }
        if let model { payload["model"] = model }
        if !history.isEmpty {
            payload["history"] = history.map { ["role": $0.role, "text": $0.text] }
        }
        let data = try await send(request(method: "POST", route: "jobs", object: payload))
        guard let result = try JSONSerialization.jsonObject(with: data) as? [String: Any], let id = result["jobId"] as? String else {
            throw AgentClientError.message("任务响应无效")
        }
        return id
    }
     
    func forkConversation(sourceID: String, targetID: String,
                          retainedPrompts: [String], replacedPrompt: String) async throws -> String? {
        try await prepareConnection()
        let payload: [String: Any] = [
            "sourceConversationId": sourceID,
            "targetConversationId": targetID,
            "retainedPrompts": retainedPrompts,
            "replacedPrompt": replacedPrompt
        ]
        let bytes = try await response(request(method: "POST", route: "conversations/fork", object: payload), timeout: 65).body
        guard let result = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              result["ok"] as? Bool == true else {
            throw AgentClientError.message("无法创建编辑分支")
        }
        let threadID = result["threadId"] as? String
        if !retainedPrompts.isEmpty && (threadID ?? "").isEmpty {
            throw AgentClientError.message("云端未能保留编辑位置之前的上下文")
        }
        return threadID
    }

    func events(jobID: String, after: Int) -> AsyncThrowingStream<AgentEvent, Error> {
        AsyncThrowingStream { continuation in
            let worker = Task { @MainActor in
                do {
                    try await prepareConnection()
                    var req = try request(method: "GET", route: "jobs/\(jobID)/events?after=\(after)&transport=metadata")
                    req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    guard let url = req.url,
                          let file = Bundle.main.url(forResource: "boss-codex", withExtension: "cer"),
                          let certificate = try? Data(contentsOf: file) else { throw AgentClientError.message("服务证书不可用") }
                    let path = url.path + (url.query.map { "?" + $0 } ?? "")
                    let raw = AsyncThrowingStream<Data, Error> { output in
                        let transport = AgentEventTransport(host: host, path: path, headers: req.allHTTPHeaderFields ?? [:], certificate: certificate, continuation: output)
                        output.onTermination = { _ in transport.cancel() }
                        transport.start()
                    }
                    for try await data in raw {
                        try Task.checkCancellation()
                        let event = try JSONDecoder().decode(AgentEvent.self, from: data)
                        continuation.yield(event)
                        if event.isTerminal { continuation.finish(); return }
                    }
                    continuation.finish()
                } catch { continuation.finish(throwing: error) }
            }
            continuation.onTermination = { _ in worker.cancel() }
        }
    }
    func download(_ asset: AgentRemoteAsset, inlineData: String? = nil, dataMimeType: String? = nil, dataFilename: String? = nil,
                  onProgress: ((Int, Int) -> Void)? = nil) async throws -> AgentAsset {
        try Task.checkCancellation()
        let data: Data
        var mime = dataMimeType ?? asset.mimeType
        var filename = dataFilename ?? asset.filename
        if let inlineData {
            guard let decoded = Data(base64Encoded: inlineData) else { throw AgentClientError.message("结果数据不完整") }
            data = decoded
        } else {
            let route = "artifacts/\(asset.id)" + (asset.mimeType.hasPrefix("image/") ? "?display=1" : "")
            let result = try await receiveArtifact(route: route, onProgress: onProgress)
            data = result.body
            mime = result.headers["content-type"]?.components(separatedBy: ";").first ?? asset.mimeType
            if let expected = result.headers["x-content-sha256"] {
                let actual = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
                guard actual == expected else { throw AgentClientError.message("结果校验失败，请重新接收") }
            }
            if mime == "image/jpeg", !filename.lowercased().hasSuffix(".jpg") && !filename.lowercased().hasSuffix(".jpeg") {
                filename = (filename as NSString).deletingPathExtension + ".jpg"
            }
        }
        try Task.checkCancellation()
        guard !mime.hasPrefix("image/") || UIImage(data: data) != nil else { throw AgentClientError.message("图片暂未加载完整") }
        return try AgentMedia.save(data, filename: filename, mimeType: mime, remoteID: asset.id)
    }
     
     
    private func receiveArtifact(route: String, onProgress: ((Int, Int) -> Void)?) async throws -> PinnedHTTPSResponse {
        let partSize = 64 * 1024
        let separator = route.contains("?") ? "&" : "?"
        let first = try await response(request(method: "GET", route: route + separator + "offset=0&length=\(partSize)"), timeout: 40)
        if first.statusCode == 200 { onProgress?(first.body.count, first.body.count); return first }
        guard first.statusCode == 206,
              let range = first.headers["content-range"], let totalText = range.split(separator: "/").last,
              let total = Int(totalText), total > 0, total <= 32 * 1024 * 1024,
              let expected = first.headers["x-content-sha256"], expected.count == 64,
              first.body.count == min(total, partSize) else { throw AgentClientError.message("图片分段信息无效") }
        let key = SHA256.hash(data: Data((route + expected).utf8)).map { String(format: "%02x", $0) }.joined()
        let folder = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("ShiyanTransfers", isDirectory: true).appendingPathComponent(key, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        var assembled = Data(count: total), received = first.body.count
        assembled.replaceSubrange(0..<first.body.count, with: first.body)
        var pending: [Int] = []
        for offset in stride(from: partSize, to: total, by: partSize) {
            let length = min(partSize, total - offset), file = folder.appendingPathComponent("\(offset).part")
            if let cached = try? Data(contentsOf: file), cached.count == length {
                assembled.replaceSubrange(offset..<(offset+length), with: cached); received += cached.count
            } else { pending.append(offset) }
        }
        onProgress?(received, total)
        try await withThrowingTaskGroup(of: (Int, Data).self) { group in
            var next = 0
            for _ in 0..<min(3, pending.count) {
                let offset = pending[next]; next += 1
                group.addTask { try await self.artifactPart(route: route, offset: offset, length: min(partSize, total-offset), expected: expected) }
            }
            while let (offset, bytes) = try await group.next() {
                try Task.checkCancellation()
                assembled.replaceSubrange(offset..<(offset+bytes.count), with: bytes)
                try? bytes.write(to: folder.appendingPathComponent("\(offset).part"), options: .atomic)
                received += bytes.count; onProgress?(received, total)
                if next < pending.count {
                    let offset = pending[next]; next += 1
                    group.addTask { try await self.artifactPart(route: route, offset: offset, length: min(partSize, total-offset), expected: expected) }
                }
            }
        }
        let actual = SHA256.hash(data: assembled).map { String(format: "%02x", $0) }.joined()
        guard actual == expected else {
            try? FileManager.default.removeItem(at: folder)
            throw AgentClientError.message("结果校验失败，请重新接收")
        }
        try? FileManager.default.removeItem(at: folder)
        var headers = first.headers; headers["content-length"] = String(total); headers.removeValue(forKey: "content-range")
        return PinnedHTTPSResponse(statusCode: 200, headers: headers, body: assembled)
    }
    private func artifactPart(route: String, offset: Int, length: Int, expected: String) async throws -> (Int, Data) {
        var last: Error = URLError(.networkConnectionLost)
        for attempt in 0..<3 {
            do {
                try Task.checkCancellation()
                let separator = route.contains("?") ? "&" : "?"
                let response = try await response(request(method: "GET", route: route + separator + "offset=\(offset)&length=\(length)"), timeout: 40)
                guard response.statusCode == 206, response.body.count == length,
                      response.headers["x-content-sha256"] == expected,
                      response.headers["content-range"]?.hasPrefix("bytes \(offset)-") == true else { throw AgentClientError.message("图片分段校验失败") }
                return (offset, response.body)
            } catch is CancellationError { throw CancellationError() }
            catch { last = error; if attempt < 2 { try await Task.sleep(for: .seconds(Double(attempt+1))) } }
        }
        throw last
    }

    func title(conversationID: String) async throws -> String? {
        let data = try await send(request(method: "POST", route: "title", object: ["conversationId": conversationID]))
        return (try JSONSerialization.jsonObject(with: data) as? [String: Any])?["title"] as? String
    }
    @discardableResult func cancel(jobID: String) async throws -> String {
        try await cancellationResponse(route: "jobs/\(jobID)/cancel")
    }
    @discardableResult func cancel(requestID: String) async throws -> String {
        try await cancellationResponse(route: "requests/\(requestID)/cancel")
    }
    private func cancellationResponse(route: String) async throws -> String {
        let data = try await send(request(method: "POST", route: route, object: [:]))
        let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        guard object?["ok"] as? Bool == true, let status = object?["status"] as? String,
              ["cancelled", "completed", "failed", "interrupted"].contains(status) else { throw AgentClientError.message("服务器尚未确认停止") }
        return status
    }

     
    func run(prompt: String, uploads: [CodexImageUpload] = [], threadKey: String, threadId: String? = nil,
             reasoning: String = "low", onProgress: ((String) -> Void)? = nil) async throws -> CodexTurnResult {
        let requestID = UUID().uuidString
        return try await withTaskCancellationHandler {
            let id = try await createJob(prompt: prompt, uploads: uploads, conversationID: threadKey, requestID: requestID, reasoning: reasoning)
            var text = "", thread: String?, images: [UIImage] = [], seen = Set<String>(), after = 0
            var lastError: Error = AgentClientError.message("连接已中断，请重试")
            for retry in 0..<3 {
                do {
                    for try await event in events(jobID: id, after: after) {
                        try Task.checkCancellation()
                        if let label = event.label { onProgress?(label) }
                        if let value = event.text { text = value }
                        if let value = event.threadId { thread = value }
                        for asset in ([event.asset].compactMap { $0 } + (event.assets ?? [])) where !seen.contains(asset.id) {
                            onProgress?("接收结果中")
                            let stored = try await download(asset, inlineData: event.asset?.id == asset.id ? event.data : nil, dataMimeType: event.dataMimeType, dataFilename: event.dataFilename,
                                onProgress: { count, total in onProgress?("接收图片 \(count / 1024) / \(max(1, total / 1024)) KB") })
                            seen.insert(asset.id)
                            if stored.isImage, let image = UIImage(contentsOfFile: stored.url.path) { images.append(image) }
                        }
                        after = event.seq
                        if event.type == "cancelled" { throw CancellationError() }
                        if ["failed", "interrupted"].contains(event.type) { throw AgentClientError.message(event.error ?? "处理未完成") }
                        if event.type == "completed" { return CodexTurnResult(text: text, images: images, threadId: thread) }
                    }
                } catch is CancellationError { throw CancellationError() }
                catch { lastError = error }
                onProgress?("连接中断，正在重新接收")
                try await Task.sleep(for: .seconds(Double(retry+1)))
            }
            throw lastError
        } onCancel: {
             
            Task { @MainActor in _ = try? await self.cancel(requestID: requestID) }
        }
    }
}

 
extension CodexClient: DotsTransport {
    func dotsUploadAttachment(id: String, filename: String, mimeType: String, data: Data) async throws -> DotsAttachment {
        try await prepareConnection()
        let payload: [String: Any] = ["id": id, "filename": filename, "mimeType": mimeType, "data": data.base64EncodedString()]
        let bytes = try await response(request(method: "POST", route: "dots/attachments", object: payload), timeout: 120, rejectDotsErrors: true).body
        return try JSONDecoder().decode(DotsAttachmentResponse.self, from: bytes).attachment
    }
    func dotsAttachmentFile(_ attachment: DotsAttachment) async throws -> URL {
        try await prepareConnection()
        let bytes = try await response(request(method: "GET", route: "dots/attachments/" + attachment.id), timeout: 120).body
        guard bytes.count == attachment.bytes,
              SHA256.hash(data: bytes).map({ String(format: "%02x", $0) }).joined() == attachment.sha256 else {
            throw AgentClientError.message("附件校验失败，请重试")
        }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("ShiyanDotsFiles").appendingPathComponent(attachment.id)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let destination = directory.appendingPathComponent((attachment.filename as NSString).lastPathComponent)
        try bytes.write(to: destination, options: .atomic)
        return destination
    }

    func dotsPanelFile(_ item: DotsPanelOutput) async throws -> URL {
        guard let path = item.downloadPath, path.hasPrefix("/v1/dots/"), !path.contains("..") else { throw AgentClientError.message("文件暂不可用") }
        try await prepareConnection()
        let bytes = try await send(request(method: "GET", route: "dots/" + String(path.dropFirst(9))))
        guard bytes.count <= 32 * 1024 * 1024 else { throw AgentClientError.message("文件过大") }
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("DotsOutputs").appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let file = folder.appendingPathComponent(((item.filename ?? "任务结果.txt") as NSString).lastPathComponent)
        try bytes.write(to: file, options: .atomic)
        return file
    }

    func dotsRead<T: Decodable>(_ route: String, as type: T.Type) async throws -> T {
        try await prepareConnection()
        let data = try await send(request(method: "GET", route: "dots/" + route))
        return try JSONDecoder().decode(type, from: data)
    }
    func dotsMutate(_ operation: DotsPendingOperation) async throws -> Int? {
        try await prepareConnection()
        let bytes = try await response(request(method: operation.schedule?.id == nil ? "POST" : "PATCH", route: "dots/" + operation.route, object: operation.body), rejectDotsErrors: true).body
        let result = try JSONSerialization.jsonObject(with: bytes) as? [String: Any]
        if operation.route == "manager/messages" {
            guard result?["accepted"] as? Bool == true,
                  let message = result?["message"] as? [String: Any],
                  let id = message["id"] as? Int, id > 0 else {
                throw AgentClientError.message("消息接收尚未确认，请重试原请求")
            }
            return id
        }
        let goal = result?["goal"] as? [String: Any]
        return (goal?["id"] as? Int) ?? (result?["goalId"] as? Int)
    }
    func dotsAcknowledge(consumerId: String, cursor: Int) async throws {
        try await prepareConnection()
        _ = try await send(request(method: "POST", route: "dots/notifications/ack", object: ["consumerId": consumerId, "cursor": cursor]))
    }
    func dotsEvents(after: Int) -> AsyncThrowingStream<DotsEvent, Error> {
        AsyncThrowingStream { continuation in
            let worker = Task { @MainActor in
                do {
                    try await prepareConnection()
                    let req = try request(method: "GET", route: "dots/events?after=\(after)")
                    guard let url = req.url,
                          let file = Bundle.main.url(forResource: "boss-codex", withExtension: "cer"),
                          let certificate = try? Data(contentsOf: file) else { throw AgentClientError.message("服务证书不可用") }
                    let path = url.path + (url.query.map { "?" + $0 } ?? "")
                    let raw = AsyncThrowingStream<Data, Error> { output in
                        let transport = AgentEventTransport(host: host, path: path, headers: req.allHTTPHeaderFields ?? [:], certificate: certificate, continuation: output)
                        output.onTermination = { _ in transport.cancel() }
                        transport.start()
                    }
                    for try await bytes in raw {
                        try Task.checkCancellation()
                        let event = try JSONDecoder().decode(DotsEvent.self, from: bytes)
                        continuation.yield(event)
                    }
                    continuation.finish()
                } catch { continuation.finish(throwing: error) }
            }
            continuation.onTermination = { _ in worker.cancel() }
        }
    }
}

struct AgentExecutionPayload: Decodable, Sendable {
    var revision: Int
    var rawResult: String?
    var fileChanges: [AgentSyncValue]?
    var displayItems: [AgentSyncValue]?
    var fullJSON: String?
}
