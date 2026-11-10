import Foundation

struct DotsProfile: Codable {
    var name: String?
    var petId: String?
    var accent: String?
    var avatarData: Data?
}
struct DotsProfileResponse: Decodable { var profile: DotsProfile }

struct DotsAttachment: Codable, Identifiable, Equatable {
    var id: String
    var filename: String
    var mimeType: String
    var bytes: Int
    var sha256: String
}
struct DotsAttachmentResponse: Decodable { var attachment: DotsAttachment }

struct DotsRejectedRequest: LocalizedError {
    let status: Int
    let message: String
    var errorDescription: String? { message }
}

struct DotsGoal: Codable, Identifiable {
    let id: Int
    var title: String?
    var instruction: String?
    var status: String?
    var created_at: Double?
    var updated_at: Double?
    var next_wake_at: Double?
    var last_summary: String?
    var run_count: Int?
    var conversationId: String?
    var originHost: String?
    var timeline: [DotsTimelineItem]?
    var outputs: [DotsOutput]?
    var approvals: [DotsApproval]?
    var events: [DotsInputEvent]?
    var displayTitle: String { title?.isEmpty == false ? title! : "未命名目标" }
    var statusText: String {
        switch status {
        case "active": return "已排队"
        case "running": return "处理中"
        case "paused": return "已暂停"
        case "completed", "done": return "已完成"
        case "blocked": return "需要补充信息"
        case "cancelled": return "已取消"
        case "failed": return "处理失败"
        case "awaiting_approval", "waiting_approval", "needs_approval": return "需要你批准操作"
        default: return status ?? "等待更新"
        }
    }
    var isEnded: Bool { ["completed", "done", "cancelled", "failed"].contains(status ?? "") }
    var canAppend: Bool { ["active", "running"].contains(status ?? "") }
    var canResume: Bool { ["paused", "blocked"].contains(status ?? "") }
    var allowedActions: [String] {
        switch status {
        case "active", "running": return ["pause", "wake", "cancel"]
        case "paused", "blocked": return ["resume", "cancel"]
        case "waiting_approval", "awaiting_approval", "needs_approval": return ["pause", "cancel"]
        default: return []
        }
    }
}

struct DotsTimelineItem: Codable, Identifiable {
    let id: Int
    var kind: String?
    var message: String?
    var data: AgentSyncValue?
    var created_at: Double?
}
struct DotsInputEvent: Codable, Identifiable {
    let id: Int
    var type: String?
    var payload: String?
    var created_at: Double?
}

struct DotsOutput: Codable, Identifiable {
    let id: Int
    var goal_id: Int?
    var run_number: Int?
    var status: String?
    var summary: String?
    var notification: String?
    var created_at: Double?
    var raw_result: String?
}

struct DotsApproval: Codable, Identifiable {
    let id: Int
    var goal_id: Int?
    var command: String?
    var reason: String?
    var status: String?
    var created_at: Double?
    /// 批准时可选择授权范围的“动作类型”，如 git push；为空表示只能逐次批准。
    var grant_labels: [String]?
    var isPending: Bool { ["pending", "requested", "awaiting_approval", "waiting_approval", "needs_approval"].contains(status ?? "") }
    var canApproveCommand: Bool {
        guard let command, !command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        return command.range(of: #"\bssh\b[^\n]*<[^>]+>"#, options: [.regularExpression, .caseInsensitive]) == nil
    }
}

struct DotsEvent: Codable, Identifiable {
    let seq: Int
    var eventId: String?
    var type: String?
    var goalId: Int?
    var createdAt: Double?
    var payload: AgentJSON?
    var id: Int { seq }

    // Delta events carry a cumulative, versioned snapshot of the same reply.
    var managerMessage: DotsManagerMessage? {
        guard type == "update", case .object(let payload)? = payload,
              case .object(let activity)? = payload["activity"],
              case .string(let kind)? = activity["kind"],
              ["assistant_delta", "assistant_message", "user_message"].contains(kind),
              case .object(let data)? = activity["data"], let raw = data["message"],
              let bytes = try? JSONEncoder().encode(raw),
              let message = try? JSONDecoder().decode(DotsManagerMessage.self, from: bytes),
              message.id > 0, message.role == (kind == "user_message" ? "user" : "assistant") else { return nil }
        return message
    }
    var assistantMessage: DotsManagerMessage? {
        guard let message = managerMessage, message.role == "assistant" else { return nil }
        return message
    }
    var isAssistantDelta: Bool {
        guard case .object(let payload)? = payload,
              case .object(let activity)? = payload["activity"],
              case .string(let kind)? = activity["kind"] else { return false }
        return kind == "assistant_delta"
    }
}

struct DotsCapabilities: Decodable {
    var available: Bool?
    var realtime: Bool?
    var events: Bool?
}
struct DotsGoalList: Decodable {
    var goals: [DotsGoal]
    var cursor: Int?
    var hasMore: Bool?
}
struct DotsDetail: Decodable {
    var goal: DotsGoal
    var timeline: [DotsTimelineItem]?
    var outputs: [DotsOutput]?
    var approvals: [DotsApproval]?
    var events: [DotsInputEvent]?
    var merged: DotsGoal {
        var value = goal
        if let timeline { value.timeline = timeline }
        if let outputs { value.outputs = outputs }
        if let approvals { value.approvals = approvals }
        if let events { value.events = events }
        return value
    }
}
struct DotsEventBatch: Decodable {
    var events: [DotsEvent]
    var cursor: Int
    var hasMore: Bool?
}
struct DotsOutputDetail: Decodable { var output: DotsOutput }

 
struct DotsPendingOperation: Codable, Equatable {
    var requestId: String
    var route: String
    var goalId: Int?
    var conversationId: String?
    var title: String?
    var text: String?
    var action: String?
    var decision: String?
    var confirmedCommand: String?
    var scope: String? = nil
    var draftKey: String?
    var attachments: [DotsAttachment]?
    var schedule: DotsSchedule?
    /// 待发队列里的文字消息：发送失败后保留内容，允许点按重试。
    var sendFailed: Bool? = nil
    var sendError: String? = nil
    var body: [String: Any] {
        var value: [String: Any] = ["requestId": requestId]
        if let conversationId { value["conversationId"] = conversationId }
        if let title { value["title"] = title }
        if let text { value[route == "goals" ? "instruction" : "message"] = text }
        if route == "goals" { value["runNow"] = true; value["host"] = "shiyan_mobile" }
        if route == "manager/messages" { value["host"] = "shiyan_mobile"; if let goalId { value["taskId"] = goalId } }
        if let attachments, !attachments.isEmpty { value["attachments"] = attachments.map(\.id) }
        if let action { value["action"] = action }
        if let decision { value["decision"] = decision }
        if let confirmedCommand { value["confirmedCommand"] = confirmedCommand }
        if let scope { value["scope"] = scope }
        if let schedule, let bytes = try? JSONEncoder().encode(schedule), let fields = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] {
            value.merge(fields) { _, new in new }; value["endDate"] = (schedule.endDate as Any?) ?? NSNull()
        }
        return value
    }
}

 
struct DotsMessageReadState: Codable {
    var readThrough: Int
    var observedThrough: Int
    var unreadIds: [Int] = []

    init(baseline: Int) {
        readThrough = baseline
        observedThrough = baseline
    }
    mutating func observe(_ messages: [DotsManagerMessage], advanceObservation: Bool) {
        let replies = messages.filter { $0.role == "assistant" && $0.id > readThrough }.map(\.id)
        unreadIds = Array(Set(unreadIds + replies)).sorted()
        if advanceObservation, let latest = messages.map(\.id).max() {
            observedThrough = max(observedThrough, latest)
        }
    }
    mutating func markRead(through latest: Int) {
        readThrough = max(readThrough, latest)
        unreadIds.removeAll { $0 <= readThrough }
    }
}

struct DotsSavedState: Codable {
    var version = 1
    var identity: String
    var goals: [DotsGoal] = []
    var details: [String: DotsGoal] = [:]
    var drafts: [String: String] = [:]
    var events: [DotsEvent] = []
    var cursor = 0
    var manager: DotsManager?
    var managerMessages: [DotsManagerMessage]?
    var managerTasks: [DotsManagerTask]?
    var managerHasMoreMessages: Bool?
    var readState: DotsMessageReadState?
    var selectedGoalId: Int?
    var pending: DotsPendingOperation?
    var draftAttachments: [DotsAttachment]?
    var profile: DotsProfile?
    var panel: DotsPanelResponse?
    /// 与网页端 pending.managerMessages 对应：每条文字消息独立入队、独立发送。
    var managerQueue: [DotsPendingOperation]?

    mutating func accept(_ event: DotsEvent) {
        guard event.seq > cursor else { return }
        // The current message already contains cumulative delta text. Keeping
        // 200 copies of a growing long reply would multiply cache writes.
        if !event.isAssistantDelta {
            events.append(event)
            if events.count > 200 { events.removeFirst(events.count - 200) }
        }
        cursor = event.seq
        if let message = event.managerMessage {
            mergeManagerMessages([message])
            readState?.observe([message], advanceObservation: false)
        }
    }
    mutating func mergeManagerMessages(_ incoming: [DotsManagerMessage]) {
        var merged = Dictionary((managerMessages ?? []).map { ($0.id, $0) }, uniquingKeysWith: { _, new in new })
        for message in incoming {
            if let current = merged[message.id], !message.canReplace(current) { continue }
            merged[message.id] = message
        }
        managerMessages = merged.values.sorted { $0.id < $1.id }
        pruneManagerQueue()
    }
    mutating func enqueueManagerMessage(_ operation: DotsPendingOperation) {
        managerQueue = (managerQueue ?? []) + [operation]
    }
    mutating func completeManagerMessage(_ requestId: String) {
        managerQueue?.removeAll { $0.requestId == requestId }
        if managerQueue?.isEmpty == true { managerQueue = nil }
    }
    mutating func markManagerMessage(_ requestId: String, failed: Bool, error: String?) {
        guard let index = managerQueue?.firstIndex(where: { $0.requestId == requestId }) else { return }
        managerQueue?[index].sendFailed = failed
        managerQueue?[index].sendError = error
    }
    /// 服务端已经收到（同一 requestId 的消息出现在对话里）后，移出队列。
    mutating func pruneManagerQueue() {
        guard let queue = managerQueue, !queue.isEmpty else { return }
        let delivered = Set((managerMessages ?? []).compactMap(\.requestId))
        let rest = queue.filter { !delivered.contains($0.requestId) }
        managerQueue = rest.isEmpty ? nil : rest
    }
    mutating func acknowledged(_ operation: DotsPendingOperation) {
        guard pending?.requestId == operation.requestId else { return }
        if let key = operation.draftKey, drafts[key] == operation.text { drafts[key] = "" }
        if operation.route == "manager/messages" {
            let sent = Set((operation.attachments ?? []).map(\.id))
            draftAttachments = (draftAttachments ?? []).filter { !sent.contains($0.id) }
        }
        pending = nil
    }
}

@MainActor
protocol DotsTransport: AnyObject {
    func dotsRead<T: Decodable>(_ route: String, as type: T.Type) async throws -> T
    func dotsRelationship(_ change: DotsRelationshipChange) async throws -> DotsRelationshipResponse
    func dotsUploadAttachment(id: String, filename: String, mimeType: String, data: Data) async throws -> DotsAttachment
    func dotsMutate(_ operation: DotsPendingOperation) async throws -> Int?
    func dotsAcknowledge(consumerId: String, cursor: Int) async throws
    func dotsEvents(after: Int) -> AsyncThrowingStream<DotsEvent, Error>
}


extension DotsTransport {
    func dotsRelationship(_ change: DotsRelationshipChange) async throws -> DotsRelationshipResponse {
        throw AgentClientError.message("共同话题暂不可用")
    }
    func dotsUploadAttachment(id: String, filename: String, mimeType: String, data: Data) async throws -> DotsAttachment {
        throw AgentClientError.message("文件上传暂不可用")
    }
}

 
struct DotsManager: Codable, Identifiable {
    let id: String
    var name: String?
    var status: String?
    var controlRevision: Int?
    var lastSummary: String?
    var runningWorkers: Int?
    var workerLimit: Int?
    var hasMoreMessages: Bool?
    var oldestMessageId: Int?
    var activityCursor: Int?
}
struct DotsSubscriptionCard: Codable, Equatable {
    struct Field: Codable, Equatable {
        let key: String
        let label: String
        var value: String?
        var secret: Bool?
        var optional: Bool?
    }
    let type: String
    let provider: String
    let action: String
    var fields: [Field]?
    var state: String
    var note: String?
}
struct DotsManagerMessage: Codable, Identifiable {
    let id: Int
    var role: String
    var content: String
    var attachments: [DotsAttachment]?
    var taskId: Int?
    var requestId: String?
    var createdAt: Double?
    var respondsToMessageIds: [Int]?
    var deliveryState: String?
    var revision: Int?
    var origin: String?
    var topicId: String?
    var proactiveReason: String?
    /// 对话订阅卡片：Dots 在对话里请用户补充凭据或确认取消。
    var card: DotsSubscriptionCard?
    /// useful / not_useful — 用户对主动消息的反馈。
    var feedback: String?
    var isStreaming: Bool { deliveryState == "streaming" }
    var isProactive: Bool { role == "assistant" && origin == "proactive" }

    func canReplace(_ current: DotsManagerMessage) -> Bool {
        // A legacy GET or a replay must never rewind a reply already advanced
        // by SSE. Nil fields retain compatibility with old completed history.
        if role == "assistant", current.role == "assistant" {
            if current.deliveryState != nil && deliveryState == nil { return false }
            if !current.isStreaming && isStreaming { return false }
            let incomingRevision = revision ?? 0, currentRevision = current.revision ?? 0
            if incomingRevision != currentRevision { return incomingRevision > currentRevision }
            if content.utf8.count < current.content.utf8.count { return false }
        }
        return true
    }
}
struct DotsManagerTask: Codable, Identifiable {
    let id: Int
    var title: String?
    var instruction: String?
    var status: String?
    var acceptanceStatus: String?
    var legacyImported: Bool?
    var dependencies: [Int]?
    var lastSummary: String?
    var updatedAt: Double?
    var requiresApproval: Bool {
        legacyImported != true && ["waiting_approval", "awaiting_approval", "needs_approval"].contains(status ?? "")
    }
    var displayTitle: String { title?.isEmpty == false ? title! : "未命名任务" }
    var statusText: String {
        if legacyImported != true && status == "done" && acceptanceStatus == "pending" { return "待总管验收" }
        switch status {
        case "running": return "处理中"
        case "active", "pending", "queued": return "已排队"
        case "paused": return "已暂停"
        case "done", "completed": return "已完成"
        case "cancelled": return "已取消"
        case "waiting_approval", "awaiting_approval", "needs_approval": return "需要你批准操作"
        case "blocked": return "需要补充信息"
        default: return status ?? "等待更新"
        }
    }
}
struct DotsManagerResponse: Decodable {
    var manager: DotsManager
    var messages: [DotsManagerMessage]
    var tasks: [DotsManagerTask]
    var hasMoreMessages: Bool?
    var oldestMessageId: Int?
    var activityCursor: Int?
    var cursor: Int?
}

struct DotsManagerMessagePage: Decodable {
    var messages: [DotsManagerMessage]
    var hasMore: Bool
    var nextBeforeId: Int?
}

struct DotsPanelActivity: Codable, Identifiable {
    var id: String
    var type: String
    var taskId: Int?
    var scheduleId: String?
    var title: String?
    var updatedAt: Double?
    var unread: Bool?
    var schedule: DotsSchedule?
    var lastSummary: String?
}
struct DotsPanelOutput: Codable, Identifiable {
    var id: String
    var outputId: Int?
    var filename: String?
    var mimeType: String?
    var downloadPath: String?
}
struct DotsPanelResponse: Codable {
    var activities: [DotsPanelActivity]
    var outputs: [DotsPanelOutput]
}
struct DotsSchedule: Codable, Identifiable, Equatable {
    var id: String?
    var title: String = ""
    var instruction: String = ""
    var enabled: Bool = true
    var `repeat`: String = "daily"
    var time: String = "21:00"
    var timezone: String = "Asia/Shanghai"
    var startDate: String = ""
    var endDate: String?
}
struct DotsConversationMessage: Decodable, Identifiable {
    var id: String
    var role: String
    var content: String
}
struct DotsConversationResponse: Decodable { var messages: [DotsConversationMessage] }

struct DotsRelationshipTopic: Decodable, Identifiable {
    var id: String
    var title: String
    var summary: String
    var openQuestion: String?
    var updatedAt: Double?
    var sourceMessageIds: [Int]?
    var revision: Int
    var needsReview: Bool

    private enum CodingKeys: String, CodingKey {
        case id, title, summary, openQuestion, updatedAt, sourceMessageIds, revision, needsReview
    }
    init(from decoder: Decoder) throws {
        let fields = try decoder.container(keyedBy: CodingKeys.self)
        id = try fields.decode(String.self, forKey: .id)
        title = try fields.decode(String.self, forKey: .title)
        summary = try fields.decode(String.self, forKey: .summary)
        openQuestion = try fields.decodeIfPresent(String.self, forKey: .openQuestion)
        updatedAt = try fields.decodeIfPresent(Double.self, forKey: .updatedAt)
        sourceMessageIds = try fields.decodeIfPresent([Int].self, forKey: .sourceMessageIds)
        revision = try fields.decodeIfPresent(Int.self, forKey: .revision) ?? 1
        needsReview = try fields.decodeIfPresent(Bool.self, forKey: .needsReview) ?? false
    }
}
struct DotsRelationship: Decodable {
    var revision: Int
    var topics: [DotsRelationshipTopic]
}
struct DotsRelationshipResponse: Decodable {
    var ok: Bool
    var relationship: DotsRelationship
}
enum DotsRelationshipChange {
    case editTopic(id: String, revision: Int, title: String, summary: String, openQuestion: String)
    case deleteTopic(id: String)

    var method: String {
        switch self {
        case .deleteTopic: return "DELETE"
        case .editTopic: return "PATCH"
        }
    }
    var route: String {
        switch self {
        case .editTopic(let id, _, _, _, _), .deleteTopic(let id):
            var allowed = CharacterSet.urlPathAllowed
            allowed.remove(charactersIn: "/?#%")
            return "relationship/topics/" + (id.addingPercentEncoding(withAllowedCharacters: allowed) ?? "")
        }
    }
    var body: [String: Any] {
        switch self {
        case .editTopic(_, let revision, let title, let summary, let openQuestion):
            return ["revision": revision, "title": title, "summary": summary, "openQuestion": openQuestion]
        case .deleteTopic: return [:]
        }
    }
}
