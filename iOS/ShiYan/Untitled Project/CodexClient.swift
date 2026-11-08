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

nonisolated struct ShiyanAvatarHTTPFailure: LocalizedError {
    let status: Int
    let message: String
    var errorDescription: String? { message }
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

struct DigitalPerson: Decodable, Identifiable, Sendable {
    let id: String
    let name: String
    let relationship: String
    let summary: String
    let createdAt: Int64
    let updatedAt: Int64
    var active: Bool?
    var learnedAt: Int64?
    var learnError: String?
    var personMessages: Int?
}
struct DigitalPersonList: Decodable, Sendable { let people: [DigitalPerson]; var activePersonId: String? }
struct DigitalPersonMessage: Decodable, Identifiable, Sendable {
    let id: Int
    let role: String
    let content: String
    let createdAt: Int64
    var memoryRefs: [String]?
}
struct DigitalPersonMessages: Decodable, Sendable { let messages: [DigitalPersonMessage] }
struct DigitalPersonMemory: Decodable, Identifiable, Sendable {
    let id: String
    let category: String
    let content: String
    let evidence: String
    let sourceMessageIds: [String]
    let occurredAt: Int64?
    let createdAt: Int64
}
struct DigitalPersonMemories: Decodable, Sendable { let memories: [DigitalPersonMemory] }
struct DigitalPersonMessageReply: Decodable, Sendable { let message: DigitalPersonMessage }
struct DigitalPersonImportMessage: Encodable, Sendable {
    let sourceId: String
    let speaker: String
    let speakerName: String
    let content: String
    let timestamp: Int64
}
struct DigitalPersonImportReply: Decodable, Sendable {
    let accepted: Int
    let importedMessages: Int
    let status: String
    let memoryCount: Int
    var learnError: String?
}

@MainActor
final class CodexClient {
    private static var instance: CodexClient?
    static var shared: CodexClient {
        if let instance { return instance }
        let value = CodexClient(); instance = value; return value
    }
    static func resetAccount() { instance = nil }
    private let accountGeneration = ShiyanAccountStorage.generation
    private var enrolled = false
    private let host = "129.226.81.110"

    private func request(method: String, route: String, object: [String: Any]? = nil, rawBody: Data? = nil, contentType: String? = nil) throws -> URLRequest {
        try Task.checkCancellation()
        if !route.hasPrefix("auth/") {
            guard ShiyanAccount.shared.token != nil, accountGeneration == ShiyanAccountStorage.generation else {
                throw AgentClientError.message("请重新登录")
            }
        }
        let data: Data
        if let rawBody { data = rawBody }
        else { data = try object.map { try JSONSerialization.data(withJSONObject: $0, options: [.sortedKeys, .withoutEscapingSlashes]) } ?? Data() }
        let fullPath = "/shiyan/v1/" + route
        guard let url = URL(string: "https://\(host)\(fullPath)") else { throw AgentClientError.message("服务地址无效") }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.httpBody = data.isEmpty ? nil : data
        req.setValue(contentType ?? "application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("mobile", forHTTPHeaderField: "X-Shiyan-Sync-Profile")
        req.setValue("ios", forHTTPHeaderField: "X-Shiyan-Platform")
        for (key, value) in try AgentIdentity.shared.headers(method: method, path: fullPath, body: data) { req.setValue(value, forHTTPHeaderField: key) }
        if let token = ShiyanAccount.shared.token { req.setValue("Bearer " + token, forHTTPHeaderField: "Authorization") }
        return req
    }
    func authRequest(route: String, method: String, object: [String: Any]? = nil, bearer: String? = nil) async throws -> Data {
        var req = try request(method: method, route: route, object: object)
        if let bearer { req.setValue("Bearer " + bearer, forHTTPHeaderField: "Authorization") }
        let timeout: TimeInterval = ["auth/me", "auth/status", "auth/logout"].contains(route) ? 8 : 35
        return try await response(req, timeout: timeout).body
    }
    private func response(_ request: URLRequest, timeout: TimeInterval = 35, idleTimeout: TimeInterval? = nil, rejectDotsErrors: Bool = false, rejectScheduleErrors: Bool = false, rejectAvatarErrors: Bool = false) async throws -> PinnedHTTPSResponse {
        guard let url = request.url else { throw AgentClientError.message("服务地址无效") }
        let route = url.path + (url.query.map { "?" + $0 } ?? "")
        let result = try await PinnedHTTPSClient.shared.request(host: host, method: request.httpMethod ?? "GET", path: route,
            headers: request.allHTTPHeaderFields ?? [:], body: request.httpBody, maxResponseBytes: 40 * 1024 * 1024,
            timeout: route.hasSuffix("/cancel") ? 10 : timeout, idleTimeout: idleTimeout)
        try Task.checkCancellation()
        if url.path.hasSuffix("/auth/me") {
            guard request.value(forHTTPHeaderField: "Authorization") == ShiyanAccount.shared.token.map({ "Bearer " + $0 }) else { throw CancellationError() }
        }
        if !url.path.contains("/auth/") {
            guard accountGeneration == ShiyanAccountStorage.generation,
                  request.value(forHTTPHeaderField: "Authorization") == ShiyanAccount.shared.token.map({ "Bearer " + $0 }) else { throw CancellationError() }
        }
        guard (200...299).contains(result.statusCode) else {
#if DEBUG
            NSLog("[ShiyanHTTPFailure] path=%@ status=%d contentType=%@ response=%@", route, result.statusCode,
                  result.headers["content-type"] ?? "", String(data: result.body.prefix(160), encoding: .utf8) ?? "binary")
#endif
            if result.statusCode == 401 {
                enrolled = false
                if request.value(forHTTPHeaderField: "Authorization") == ShiyanAccount.shared.token.map({ "Bearer " + $0 }),
                   !url.path.hasSuffix("/login"), !url.path.hasSuffix("/register"), !url.path.hasSuffix("/bootstrap") {
                    ShiyanAccount.shared.invalidate()
                }
            }
            let message = (try? JSONSerialization.jsonObject(with: result.body) as? [String: Any])?["error"] as? String
            let rejectionCode = (try? JSONSerialization.jsonObject(with: result.body) as? [String: Any])?["code"] as? String
            if url.path.hasSuffix("/auth/me") {
                if result.statusCode == 403,
                   request.value(forHTTPHeaderField: "Authorization") == ShiyanAccount.shared.token.map({ "Bearer " + $0 }) {
                    ShiyanAccount.shared.invalidate()
                }
                throw ShiyanAuthHTTPFailure(status: result.statusCode, message: message ?? "登录验证暂不可用（\(result.statusCode)）")
            }
            if rejectScheduleErrors && [400, 403, 404, 409, 422].contains(result.statusCode) {
                throw ScheduledTaskRejected(status: result.statusCode, message: message ?? "服务器未接受此修改（\(result.statusCode)）")
            }
            if rejectDotsErrors && [400, 403, 404, 409, 422].contains(result.statusCode) && rejectionCode != "action_uncertain" {
                throw DotsRejectedRequest(status: result.statusCode, message: message ?? "服务器未接受此操作（\(result.statusCode)）")
            }
            if rejectAvatarErrors {
                throw ShiyanAvatarHTTPFailure(status: result.statusCode, message: message ?? "头像操作暂不可用（\(result.statusCode)）")
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
    func memories(query: String = "") async throws -> [ShiyanMemoryEntry] {
        try await prepareConnection()
        let bytes = try await send(request(method: "GET", route: "memory"))
        let all = try JSONDecoder().decode(ShiyanMemoryList.self, from: bytes).memories
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        return needle.isEmpty ? all : all.filter { ($0.content + " " + ($0.category ?? "")).lowercased().contains(needle) }
    }
    func memorySummary() async throws -> ShiyanMemorySummary {
        try await prepareConnection()
        let bytes = try await send(request(method: "GET", route: "memory/summary"))
        return try JSONDecoder().decode(ShiyanMemorySummary.self, from: bytes)
    }
    func updateMemory(_ id: String, content: String, revision: Int) async throws {
        try await prepareConnection()
        _ = try await send(request(method: "PATCH", route: "memory/" + id, object: ["content": content, "revision": revision]))
    }
    func deleteMemory(_ id: String) async throws {
        try await prepareConnection()
        _ = try await send(request(method: "DELETE", route: "memory/" + id, object: [String: Any]()))
    }
    func dotsMessageFeedback(_ messageId: Int, value: String) async throws {
        try await prepareConnection()
        _ = try await response(request(method: "POST", route: "dots/manager/messages/\(messageId)/feedback", object: ["value": value]), rejectDotsErrors: true)
    }
    func setMemoryEnabled(_ enabled: Bool) async throws -> ShiyanMemorySettings {
        try await prepareConnection()
        let bytes = try await send(request(method: "PATCH", route: "memory/settings", object: ["enabled": enabled]))
        return try JSONDecoder().decode(ShiyanMemorySettings.self, from: bytes)
    }

    func digitalPeople() async throws -> [DigitalPerson] {
        try await prepareConnection()
        let bytes = try await response(request(method: "GET", route: "dots/people"), rejectDotsErrors: true).body
        return try JSONDecoder().decode(DigitalPersonList.self, from: bytes).people
    }
    func digitalPeopleList() async throws -> DigitalPersonList {
        try await prepareConnection()
        let bytes = try await response(request(method: "GET", route: "dots/people"), rejectDotsErrors: true).body
        return try JSONDecoder().decode(DigitalPersonList.self, from: bytes)
    }
    /// 启用后 Dots 主页对话用这个人的方式回复；同一时间只启用一个人。
    func setDigitalPersonActive(_ id: String, active: Bool) async throws {
        try await prepareConnection()
        _ = try await response(request(method: "PATCH", route: "dots/people/" + id, object: ["active": active]), rejectDotsErrors: true)
    }
    /// 用已导入的聊天记录重新学习说话方式，返回学习失败时的提示。
    func relearnDigitalPerson(_ id: String) async throws -> String? {
        try await prepareConnection()
        let bytes = try await response(request(method: "PATCH", route: "dots/people/" + id, object: ["relearn": true]), timeout: 240, rejectDotsErrors: true).body
        struct Reply: Decodable { let learnError: String? }
        return try? JSONDecoder().decode(Reply.self, from: bytes).learnError
    }
    func createDigitalPerson(name: String, relationship: String) async throws -> DigitalPerson {
        try await prepareConnection()
        let bytes = try await response(request(method: "POST", route: "dots/people", object: ["name": name, "relationship": relationship]), rejectDotsErrors: true).body
        struct Reply: Decodable { let person: DigitalPerson }
        return try JSONDecoder().decode(Reply.self, from: bytes).person
    }
    func updateDigitalPerson(_ id: String, name: String, relationship: String) async throws -> DigitalPerson {
        try await prepareConnection()
        let bytes = try await response(request(method: "PATCH", route: "dots/people/" + id, object: ["name": name, "relationship": relationship]), rejectDotsErrors: true).body
        struct Reply: Decodable { let person: DigitalPerson }
        return try JSONDecoder().decode(Reply.self, from: bytes).person
    }
    func deleteDigitalPerson(_ id: String) async throws {
        try await prepareConnection()
        _ = try await response(request(method: "DELETE", route: "dots/people/" + id, object: [String: Any]()), rejectDotsErrors: true)
    }
    func digitalPersonMessages(_ id: String) async throws -> [DigitalPersonMessage] {
        try await prepareConnection()
        let bytes = try await response(request(method: "GET", route: "dots/people/" + id + "/messages?limit=200"), rejectDotsErrors: true).body
        return try JSONDecoder().decode(DigitalPersonMessages.self, from: bytes).messages
    }
    func sendDigitalPersonMessage(_ id: String, requestId: String, message: String) async throws -> DigitalPersonMessage {
        try await prepareConnection()
        let bytes = try await response(request(method: "POST", route: "dots/people/" + id + "/messages", object: ["requestId": requestId, "message": message]), timeout: 240, rejectDotsErrors: true).body
        return try JSONDecoder().decode(DigitalPersonMessageReply.self, from: bytes).message
    }
    func digitalPersonMemories(_ id: String) async throws -> [DigitalPersonMemory] {
        try await prepareConnection()
        let bytes = try await response(request(method: "GET", route: "dots/people/" + id + "/memories"), rejectDotsErrors: true).body
        return try JSONDecoder().decode(DigitalPersonMemories.self, from: bytes).memories
    }
    func updateDigitalPersonMemory(_ personId: String, memoryId: String, content: String) async throws {
        try await prepareConnection()
        _ = try await response(request(method: "PATCH", route: "dots/people/" + personId + "/memories/" + memoryId, object: ["content": content]), rejectDotsErrors: true)
    }
    func deleteDigitalPersonMemory(_ personId: String, memoryId: String) async throws {
        try await prepareConnection()
        _ = try await response(request(method: "DELETE", route: "dots/people/" + personId + "/memories/" + memoryId, object: [String: Any]()), rejectDotsErrors: true)
    }
    func importDigitalPersonBatch(_ personId: String, importId: String, format: String,
                                  messages: [DigitalPersonImportMessage], final: Bool) async throws -> DigitalPersonImportReply {
        try await prepareConnection()
        let encoded = try JSONEncoder().encode(messages)
        let values = try JSONSerialization.jsonObject(with: encoded)
        let object: [String: Any] = ["importId": importId, "source": "wechat", "format": format,
                                     "messages": values, "final": final]
        let bytes = try await response(request(method: "POST", route: "dots/people/" + personId + "/import", object: object), timeout: 240, rejectDotsErrors: true).body
        return try JSONDecoder().decode(DigitalPersonImportReply.self, from: bytes)
    }

    func accountQuota() async throws -> CodexQuota {
        try await prepareConnection()
        let bytes = try await response(request(method: "GET", route: "account/quota"), timeout: 20).body
        return try JSONDecoder().decode(CodexQuotaResponse.self, from: bytes).quota
    }

    private func decodeAccountAvatar(_ bytes: Data) throws -> ShiyanAccountAvatar {
        guard bytes.count <= 1_400_000 else { throw AgentClientError.message("头像响应过大") }
        let value = try JSONDecoder().decode(ShiyanAccountAvatarResponse.self, from: bytes).avatar
        guard value.revision >= 0, value.mimeType == "image/jpeg" else {
            throw AgentClientError.message("头像响应无效")
        }
        if let encoded = value.data {
            guard encoded.utf8.count <= 1_398_104,
                  let image = Data(base64Encoded: encoded), !image.isEmpty,
                  image.count <= 1_048_576 else { throw AgentClientError.message("头像图片无效") }
        }
        return value
    }

    func accountAvatar() async throws -> ShiyanAccountAvatar {
        try await prepareConnection()
        let bytes = try await response(request(method: "GET", route: "account/avatar"),
                                       timeout: 20, rejectAvatarErrors: true).body
        return try decodeAccountAvatar(bytes)
    }

    func updateAccountAvatar(data: Data, expectedRevision: Int? = nil) async throws -> ShiyanAccountAvatar {
        try await prepareConnection()
        guard !data.isEmpty, data.count <= 1_048_576 else { throw AgentClientError.message("头像图片过大，请重新选择") }
        var object: [String: Any] = ["data": data.base64EncodedString()]
        if let expectedRevision {
            guard expectedRevision >= 0 else { throw AgentClientError.message("头像版本无效") }
            object["expectedRevision"] = expectedRevision
        }
        let bytes = try await response(request(method: "PUT", route: "account/avatar", object: object),
                                       timeout: 25, rejectAvatarErrors: true).body
        return try decodeAccountAvatar(bytes)
    }

    func accountAvatarEvents() async throws -> AsyncThrowingStream<Data, Error> {
        try await prepareConnection()
        var req = try request(method: "GET", route: "account/avatar/events")
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        guard let url = req.url,
              let authorization = req.value(forHTTPHeaderField: "Authorization"),
              let file = Bundle.main.url(forResource: "boss-codex", withExtension: "cer"),
              let certificate = try? Data(contentsOf: file) else { throw AgentClientError.message("服务证书不可用") }
        let path = url.path + (url.query.map { "?" + $0 } ?? "")
        let headers = req.allHTTPHeaderFields ?? [:]
        return AsyncThrowingStream(bufferingPolicy: .bufferingNewest(1)) { continuation in
            let worker = Task { @MainActor in
                do {
                    try Task.checkCancellation()
                    guard accountGeneration == ShiyanAccountStorage.generation,
                          authorization == ShiyanAccount.shared.token.map({ "Bearer " + $0 }) else { throw CancellationError() }
                    let raw = AsyncThrowingStream<Data, Error>(bufferingPolicy: .bufferingNewest(1)) { output in
                        let transport = AgentEventTransport(host: host, path: path, headers: headers,
                                                            certificate: certificate, continuation: output)
                        output.onTermination = { _ in transport.cancel() }
                        transport.start()
                    }
                    for try await bytes in raw {
                        try Task.checkCancellation()
                        guard accountGeneration == ShiyanAccountStorage.generation,
                              authorization == ShiyanAccount.shared.token.map({ "Bearer " + $0 }) else { throw CancellationError() }
                        // The shared transport parses SSE data frames and ignores heartbeat comments.
                        _ = try decodeAccountAvatar(bytes)
                        continuation.yield(bytes)
                    }
                    continuation.finish()
                } catch { continuation.finish(throwing: error) }
            }
            continuation.onTermination = { _ in worker.cancel() }
        }
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
        try Task.checkCancellation()
        guard ShiyanAccount.shared.token != nil, accountGeneration == ShiyanAccountStorage.generation else {
            throw AgentClientError.message("请先登录")
        }
    }
     
     
    var capabilitiesCacheScope: String? {
        guard let identity = try? AgentIdentity.shared.enrollment()["deviceID"] else { return nil }
        return "https://\(host)/shiyan/v1|\(identity)|\(ShiyanAccountStorage.owner)"
    }
    func capabilities() async throws -> AgentCapabilities {
        try await prepareConnection()
        let data = try await send(request(method: "GET", route: "capabilities"))
        return try JSONDecoder().decode(AgentCapabilities.self, from: data)
    }
    private func liveInputRoute(jobID: String, requestID: String? = nil) throws -> String {
        let identifiers = [jobID] + (requestID.map { [$0] } ?? [])
        guard identifiers.allSatisfy({ $0.range(of: "^[A-Za-z0-9_-]{1,160}$", options: .regularExpression) != nil }) else {
            throw AgentClientError.message("选择请求无效，请刷新当前会话")
        }
        return "jobs/\(jobID)/questions" + (requestID.map { "/\($0)/answer" } ?? "")
    }
    func liveInputRequests(jobID: String) async throws -> [AgentLiveInputRequest] {
        let bytes = try await send(request(method: "GET", route: liveInputRoute(jobID: jobID)))
        return try JSONDecoder().decode(AgentLiveInputListing.self, from: bytes).pendingQuestions
    }
    func answerLiveInput(jobID: String, requestID: String, answers: [String: [String: [String]]]) async throws -> AgentLiveInputRequest {
        let bytes = try await send(request(method: "POST", route: liveInputRoute(jobID: jobID, requestID: requestID), object: ["answers": answers]))
        return try JSONDecoder().decode(AgentLiveInputAnswer.self, from: bytes).request
    }
    func createJob(prompt: String, uploads: [CodexImageUpload], conversationID: String,
                   requestID: String, reasoning: String, model: String? = nil, history: [CodexHistoryTurn] = [], files: [CodexFileUpload] = [],
                   syncConversationID: UUID? = nil, userMessageID: UUID? = nil, assistantMessageID: UUID? = nil) async throws -> String {
        try await prepareConnection()
        var payload: [String: Any] = [
            "prompt": prompt,  
            "conversationId": conversationID, "requestId": requestID, "reasoning": reasoning,
            "images": uploads.map { ["data": $0.data.base64EncodedString(), "suffix": $0.suffix] }
        ]
        if !files.isEmpty { payload["files"] = files.map { ["data": $0.data.base64EncodedString(), "filename": $0.filename] } }
        if let syncConversationID { payload["syncConversationId"] = syncConversationID.uuidString.lowercased() }
        if let userMessageID { payload["userMessageId"] = userMessageID.uuidString.lowercased() }
        if let assistantMessageID { payload["assistantMessageId"] = assistantMessageID.uuidString.lowercased() }
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
        if !retainedPrompts.isEmpty && (threadID ?? "").isEmpty && result["historyRetained"] as? Bool != true {
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
                        guard accountGeneration == ShiyanAccountStorage.generation else { throw CancellationError() }
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
        try Task.checkCancellation()
        guard accountGeneration == ShiyanAccountStorage.generation else { throw CancellationError() }
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
        let folder = ShiyanAccountStorage.directory("ShiyanTransfers", domain: .cachesDirectory).appendingPathComponent(key, isDirectory: true)
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
        let directory = ShiyanAccountStorage.directory("ShiyanDotsFiles", domain: .cachesDirectory).appendingPathComponent(attachment.id)
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
        let folder = ShiyanAccountStorage.directory("DotsOutputs", domain: .cachesDirectory).appendingPathComponent(UUID().uuidString)
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
    func dotsBrowserTicket() async throws -> String {
        try await prepareConnection()
        let bytes = try await response(request(method: "POST", route: "dots/browser/session", object: [:]), rejectDotsErrors: true).body
        guard let payload = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              let ticket = payload["ticket"] as? String, !ticket.isEmpty else {
            throw AgentClientError.message("服务器没有返回电脑入口凭证")
        }
        return ticket
    }
    func dotsSubscriptions(_ provider: String? = nil, method: String = "GET", fields: [String: Any]? = nil) async throws -> DotsSubscriptionsResponse {
        try await prepareConnection()
        guard provider == nil || ["github", "email", "google-calendar", "rss"].contains(provider!) else {
            throw AgentClientError.message("不支持的订阅类型")
        }
        let route = "dots/subscriptions" + (provider.map { "/" + $0 } ?? "")
        let bytes = try await response(request(method: method, route: route, object: fields), rejectDotsErrors: true).body
        return try JSONDecoder().decode(DotsSubscriptionsResponse.self, from: bytes)
    }
    func dotsConnectors() async throws -> DotsConnectorsResponse {
        try await prepareConnection()
        let bytes = try await response(request(method: "GET", route: "dots/connectors"), rejectDotsErrors: true).body
        return try JSONDecoder().decode(DotsConnectorsResponse.self, from: bytes)
    }
    /// 连接一个 MCP：常用插件传 catalogId（可带 token），自定义传 name/url（可带 token）。需要授权时返回 authorizeUrl。
    func dotsConnectMCP(_ fields: [String: Any]) async throws -> DotsMCPConnectResult {
        try await prepareConnection()
        let bytes = try await response(request(method: "POST", route: "dots/connectors/mcp", object: fields), rejectDotsErrors: true).body
        return try JSONDecoder().decode(DotsMCPConnectResult.self, from: bytes)
    }
    /// action: remove / refresh
    func dotsMCP(_ id: String, action: String) async throws {
        try await prepareConnection()
        let safe = id.filter { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }
        if action == "remove" { _ = try await response(request(method: "DELETE", route: "dots/connectors/mcp/\(safe)"), rejectDotsErrors: true) }
        else { _ = try await response(request(method: "POST", route: "dots/connectors/mcp/\(safe)/refresh", object: [:]), rejectDotsErrors: true) }
    }
    /// action: status / login / verify / push / unbind
    func dotsWeixin(_ action: String, fields: [String: Any]? = nil) async throws -> DotsWeixinStatus {
        try await prepareConnection()
        let (method, route): (String, String) = switch action {
        case "login": ("POST", "dots/weixin/login")
        case "verify": ("POST", "dots/weixin/verify")
        case "push": ("PATCH", "dots/weixin")
        case "unbind": ("DELETE", "dots/weixin")
        default: ("GET", "dots/weixin")
        }
        let bytes = try await response(request(method: method, route: route, object: fields ?? (method == "GET" ? nil : [String: Any]())),
                                       rejectDotsErrors: true).body
        return try JSONDecoder().decode(DotsWeixinStatus.self, from: bytes)
    }
    func dotsSettings(update: [String: Any]? = nil) async throws -> DotsSettingsResponse {
        try await prepareConnection()
        let bytes = try await response(request(method: update == nil ? "GET" : "PATCH", route: "dots/settings", object: update),
                                       rejectDotsErrors: true).body
        return try JSONDecoder().decode(DotsSettingsResponse.self, from: bytes)
    }
    /// 每轮“在干嘛”和结果的简短总结（服务端按内容缓存）。
    func roundSummaries(_ items: [(id: String, prompt: String, reply: String)]) async throws -> [AgentRoundSummary] {
        try await prepareConnection()
        let payload: [[String: Any]] = items.prefix(40).map { ["id": $0.id, "prompt": String($0.prompt.prefix(1200)), "reply": String($0.reply.prefix(2500))] }
        let bytes = try await response(request(method: "POST", route: "dots/rounds/summary", object: ["rounds": payload]), rejectDotsErrors: true).body
        return try JSONDecoder().decode(AgentRoundSummaryResponse.self, from: bytes).rounds
    }
    /// 执行步骤的标题和说明（服务端按步骤内容缓存）。
    func stepSummaries(_ steps: [AgentExecutionPresentation.Item]) async throws -> [AgentStepSummary] {
        try await prepareConnection()
        let payload: [[String: Any]] = steps.prefix(60).map {
            ["id": $0.id, "type": $0.type, "title": $0.title, "status": $0.status,
             "input": String($0.subtitle.prefix(1500)), "output": String($0.body.prefix(2000))]
        }
        let bytes = try await response(request(method: "POST", route: "dots/steps/summary", object: ["steps": payload]), rejectDotsErrors: true).body
        return try JSONDecoder().decode(AgentStepSummaryResponse.self, from: bytes).steps
    }
    func dotsGrants() async throws -> DotsGrantsResponse {
        try await prepareConnection()
        let bytes = try await response(request(method: "GET", route: "dots/approval-grants"), rejectDotsErrors: true).body
        return try JSONDecoder().decode(DotsGrantsResponse.self, from: bytes)
    }
    func dotsRevokeGrant(_ id: Int) async throws {
        try await prepareConnection()
        _ = try await response(request(method: "DELETE", route: "dots/approval-grants/\(id)"), rejectDotsErrors: true)
    }
    func dotsAudit(category: String?, before: Double?) async throws -> DotsAuditResponse {
        try await prepareConnection()
        var query = ["limit=50"]
        if let category, !category.isEmpty { query.append("category=" + category) }
        if let before { query.append("before=\(Int(before))") }
        let bytes = try await response(request(method: "GET", route: "dots/audit?" + query.joined(separator: "&")), rejectDotsErrors: true).body
        return try JSONDecoder().decode(DotsAuditResponse.self, from: bytes)
    }
    func dotsRelationship(_ change: DotsRelationshipChange) async throws -> DotsRelationshipResponse {
        try await prepareConnection()
        let data = try await response(request(method: change.method, route: "dots/" + change.route,
                                             object: change.body), rejectDotsErrors: true).body
        return try JSONDecoder().decode(DotsRelationshipResponse.self, from: data)
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
                        guard accountGeneration == ShiyanAccountStorage.generation else { throw CancellationError() }
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

// Knowledge uses the same account, signed requests and pinned transport as chat.
extension CodexClient {
    private func knowledgeKey(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))) ?? value
    }
    private func knowledgeBytes(method: String = "GET", route: String, object: [String: Any]? = nil,
                                body: Data? = nil, contentType: String? = nil) async throws -> Data {
        let owner = ShiyanAccountStorage.owner
        let mutation = method != "GET" && ["spaces", "knowledge-bases", "documents"].contains(route.components(separatedBy: "/").first ?? "")
        if mutation { await Task.detached(priority: .utility) { KnowledgeReadingCache.clear(owner) }.value }
        let cacheEpoch = KnowledgeReadingCache.epoch(owner)
        try await prepareConnection()
        let req = try request(method: method, route: "knowledge/" + route, object: object, rawBody: body, contentType: contentType)
        // Graphs and answers may wait for upstream work before their first byte.
        // Other requests retain the transport's normal 20-second idle limit.
        let waitsForContent = route == "query" || route.hasSuffix("/knowledge")
        let data = try await response(req, timeout: 250, idleTimeout: waitsForContent ? 250 : nil).body
        guard accountGeneration == ShiyanAccountStorage.generation else { throw CancellationError() }
        await Task.detached(priority: .utility) {
            if method == "GET" { KnowledgeReadingCache.write(data, route: route, owner: owner, epoch: cacheEpoch) }
            else if mutation { KnowledgeReadingCache.clear(owner) }
        }.value
        return data
    }
    func cachedKnowledge<T: Decodable & Sendable>(_ type: T.Type, route: String) async -> T? {
        let owner = ShiyanAccountStorage.owner
        let value: T? = await Task.detached(priority: .utility) {
            guard let data = KnowledgeReadingCache.read(route, owner: owner) else { return nil }
            return try? JSONDecoder().decode(type, from: data)
        }.value
        guard accountGeneration == ShiyanAccountStorage.generation else { return nil }
        return value
    }
    private func knowledgeDecode<T: Decodable>(_ type: T.Type, method: String = "GET", route: String, object: [String: Any]? = nil) async throws -> T {
        try JSONDecoder().decode(type, from: await knowledgeBytes(method: method, route: route, object: object))
    }
    func knowledgeSpaces() async throws -> [KnowledgeSpace] {
        try await knowledgeDecode([KnowledgeSpace].self, route: "spaces")
    }
    func knowledgeCreateSpace(name: String) async throws -> KnowledgeSpace {
        try await knowledgeDecode(KnowledgeSpace.self, method: "POST", route: "spaces", object: ["name": name])
    }
    func knowledgeBases(spaceID: String) async throws -> [KnowledgeBase] {
        try await knowledgeDecode([KnowledgeBase].self, route: "spaces/\(knowledgeKey(spaceID))/knowledge-bases")
    }
    func knowledgeCreateBase(spaceID: String, name: String, description: String) async throws -> KnowledgeBase {
        try await knowledgeDecode(KnowledgeBase.self, method: "POST", route: "spaces/\(knowledgeKey(spaceID))/knowledge-bases", object: ["name": name, "description": description])
    }
    func knowledgeUpdateBase(id: String, name: String) async throws -> KnowledgeBase {
        try await knowledgeDecode(KnowledgeBase.self, method: "PATCH", route: "knowledge-bases/\(knowledgeKey(id))", object: ["name": name])
    }
    func knowledgeDeleteBase(id: String) async throws {
        _ = try await knowledgeBytes(method: "DELETE", route: "knowledge-bases/\(knowledgeKey(id))")
    }
    func knowledgeDocuments(baseID: String) async throws -> [KnowledgeDocument] {
        try await knowledgeDecode([KnowledgeDocument].self, route: "knowledge-bases/\(knowledgeKey(baseID))/documents")
    }
    func knowledgeDocument(id: String) async throws -> KnowledgeDocument {
        try await knowledgeDecode(KnowledgeDocument.self, route: "documents/\(knowledgeKey(id))")
    }
    func knowledgeDeleteDocument(id: String) async throws {
        _ = try await knowledgeBytes(method: "DELETE", route: "documents/\(knowledgeKey(id))")
    }
    func knowledgeGraph(baseID: String) async throws -> KnowledgeGraph {
        try await knowledgeDecode(KnowledgeGraph.self, route: "knowledge-bases/\(knowledgeKey(baseID))/knowledge")
    }
    func knowledgeActiveTask(baseID: String) async throws -> KnowledgeTask? {
        try await knowledgeDecode(KnowledgeTask?.self, route: "knowledge-bases/\(knowledgeKey(baseID))/tasks/active")
    }
    func knowledgeTask(id: String) async throws -> KnowledgeTask {
        try await knowledgeDecode(KnowledgeTask.self, route: "tasks/\(knowledgeKey(id))")
    }
    func knowledgeHistory(baseID: String) async throws -> KnowledgeHistory {
        try await knowledgeDecode(KnowledgeHistory.self, route: "chat/history?knowledge_base_id=\(knowledgeKey(baseID))")
    }
    func knowledgeClearHistory(baseID: String) async throws {
        _ = try await knowledgeBytes(method: "DELETE", route: "chat/history?knowledge_base_id=\(knowledgeKey(baseID))")
    }
    func knowledgeAsk(baseID: String, question: String, conversationID: String?, history: [[String: String]]) async throws -> KnowledgeAnswer {
        var object: [String: Any] = ["knowledge_base_id": baseID, "question": question, "history": history, "allow_web": false]
        if let conversationID { object["conversation_id"] = conversationID }
        return try await knowledgeDecode(KnowledgeAnswer.self, method: "POST", route: "query", object: object)
    }
    func knowledgeUpload(baseID: String, filename: String, data: Data) async throws -> KnowledgeUpload {
        guard data.count <= 50 * 1024 * 1024 else { throw AgentClientError.message("PDF 不能超过 50 MB") }
        let boundary = "ShiyanKnowledge-" + UUID().uuidString
        let safeFilename = filename.replacingOccurrences(of: "\r", with: "_").replacingOccurrences(of: "\n", with: "_").replacingOccurrences(of: "\"", with: "_")
        var body = Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(safeFilename)\"\r\nContent-Type: application/pdf\r\n\r\n".utf8)
        body.append(data); body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        let bytes = try await knowledgeBytes(method: "POST", route: "knowledge-bases/\(knowledgeKey(baseID))/documents", body: body, contentType: "multipart/form-data; boundary=\(boundary)")
        return try JSONDecoder().decode(KnowledgeUpload.self, from: bytes)
    }
}

// Local reading copies only; source documents and AI answers are not cached here.
nonisolated enum KnowledgeReadingCache {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var epochs: [String: Int] = [:]
    private static let maxAge: TimeInterval = 24 * 60 * 60
    private static let maxBytes = 32 * 1024 * 1024
    private static func folder(_ owner: String) -> URL {
        ShiyanAccountStorage.directory("KnowledgeReading-v1", domain: .cachesDirectory, owner: owner)
    }
    private static func file(_ route: String, _ owner: String) -> URL {
        let key = SHA256.hash(data: Data(route.utf8)).map { String(format: "%02x", $0) }.joined()
        return folder(owner).appendingPathComponent(key + ".json")
    }
    static func eligible(_ route: String) -> Bool {
        route.range(of: #"^(spaces(/[^/]+/knowledge-bases)?|knowledge-bases/[^/]+/(documents|knowledge)|documents/[^/]+)$"#, options: .regularExpression) != nil
    }
    static func epoch(_ owner: String) -> Int { lock.withLock { epochs[owner, default: 0] } }
    static func clear(_ owner: String) {
        lock.withLock {
            epochs[owner, default: 0] += 1
            try? FileManager.default.removeItem(at: folder(owner))
        }
    }
    static func read(_ route: String, owner: String) -> Data? {
        guard owner != "signed-out", eligible(route) else { return nil }
        return lock.withLock {
            let url = file(route, owner)
            guard let date = try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate,
                  Date().timeIntervalSince(date) >= 0, Date().timeIntervalSince(date) < maxAge,
                  let data = try? Data(contentsOf: url), data.count <= 8 * 1024 * 1024,
                  (try? JSONSerialization.jsonObject(with: data)) != nil else { try? FileManager.default.removeItem(at: url); return nil }
            return data
        }
    }
    static func write(_ data: Data, route: String, owner: String, epoch: Int) {
        guard owner != "signed-out", eligible(route), data.count <= 8 * 1024 * 1024,
              (try? JSONSerialization.jsonObject(with: data)) != nil else { return }
        lock.withLock {
            guard epochs[owner, default: 0] == epoch else { return }
            let url = file(route, owner), fm = FileManager.default
            try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            try? fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
            let files = (try? fm.contentsOfDirectory(at: folder(owner), includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey])) ?? []
            let entries = files.compactMap { f -> (URL, Int, Date)? in
                guard let v = try? f.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey]) else { return nil }
                return (f, v.fileSize ?? 0, v.contentModificationDate ?? .distantPast)
            }.sorted { $0.2 < $1.2 }
            var total = entries.reduce(0) { $0 + $1.1 }, count = entries.count
            for e in entries {
                guard total > maxBytes || count > 64 || Date().timeIntervalSince(e.2) > maxAge else { continue }
                try? fm.removeItem(at: e.0); total -= e.1; count -= 1
            }
        }
    }
}
