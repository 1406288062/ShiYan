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
        case "active": return "等待执行"
        case "running": return "处理中"
        case "paused": return "已暂停"
        case "completed", "done": return "已完成"
        case "blocked": return "需要补充信息"
        case "cancelled": return "已取消"
        case "failed": return "处理失败"
        case "awaiting_approval", "waiting_approval", "needs_approval": return "等待确认"
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
    var isPending: Bool { ["pending", "awaiting_approval"].contains(status ?? "") }
}

struct DotsEvent: Codable, Identifiable {
    let seq: Int
    var eventId: String?
    var type: String?
    var goalId: Int?
    var createdAt: Double?
    var payload: AgentJSON?
    var id: Int { seq }
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
    var draftKey: String?
    var attachments: [DotsAttachment]?
    var schedule: DotsSchedule?
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

    mutating func accept(_ event: DotsEvent) {
        guard event.seq > cursor else { return }
        events.append(event)
        if events.count > 200 { events.removeFirst(events.count - 200) }
        cursor = event.seq
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
    func dotsUploadAttachment(id: String, filename: String, mimeType: String, data: Data) async throws -> DotsAttachment
    func dotsMutate(_ operation: DotsPendingOperation) async throws -> Int?
    func dotsAcknowledge(consumerId: String, cursor: Int) async throws
    func dotsEvents(after: Int) -> AsyncThrowingStream<DotsEvent, Error>
}


extension DotsTransport {
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
struct DotsManagerMessage: Codable, Identifiable {
    let id: Int
    var role: String
    var content: String
    var attachments: [DotsAttachment]?
    var taskId: Int?
    var requestId: String?
    var createdAt: Double?
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
    var displayTitle: String { title?.isEmpty == false ? title! : "未命名任务" }
    var statusText: String {
        if legacyImported != true && status == "done" && acceptanceStatus == "pending" { return "待总管验收" }
        switch status {
        case "running": return "处理中"
        case "active", "pending", "queued": return "等待执行"
        case "paused": return "已暂停"
        case "done", "completed": return "已完成"
        case "cancelled": return "已取消"
        case "waiting_approval": return "等待确认"
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
