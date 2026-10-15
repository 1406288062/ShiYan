import Foundation

struct ScheduledTask: Identifiable, Codable, Equatable {
    var id = UUID().uuidString.lowercased()
    var title = ""
    var prompt = ""
    var emoji = "🕘"
    var enabled = true
    var repeatType = "daily"
    var time = "09:00"
    var timeZone = "Asia/Shanghai"
    var startDate = ScheduledTask.day(Date(), zone: "Asia/Shanghai")
    var endDate: Date?
    var notificationMode = "important"
    var runLocally = true
    var newChatEachRun = false
    var model = "gpt-6.1-sol"
    var reasoning = "medium"
    var projectId: String?
    var nextRun: Date?
    var lastRun: Date?
    var conversationId: String?
    var executorDeviceId: String?
    var lastError: String?
    var rawStatus = "pending"
    var revision = 0

    var status: String { rawStatus == "completed" ? "completed" : enabled ? "active" : "paused" }
    var notifyWhenComplete: Bool {
        get { notificationMode != "none" }
        set { if newValue { if notificationMode == "none" { notificationMode = "important" } } else { notificationMode = "none" } }
    }
    var awaitingMac: Bool { rawStatus == "pending" || executorDeviceId == nil }
    static func day(_ date: Date, zone: String) -> String {
        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: zone) ?? .current; formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }
    static func parse(_ text: String?) -> Date? {
        guard let text else { return nil }
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }
    static func inferredEmoji(_ title: String) -> String {
        if title.contains("壁纸") || title.contains("图片") { return title.contains("准备") || title.contains("创作") ? "🎨" : "🖼️" }
        if title.contains("知识") || title.contains("面试") { return "📚" }
        if title.contains("夜间") { return "🌙" }
        if title.contains("回顾") || title.contains("汇报") { return "📋" }
        if title.contains("饮食") { return "🥗" }
        if title.contains("财务") { return "💰" }
        return "🕘"
    }
    enum CodingKeys: String, CodingKey {
        case id,title,emoji,enabled,time,startDate,endDate,notificationMode,runLocally,newChatEachRun,model,reasoning,projectId,conversationId,executorDeviceId,lastError,revision
        case prompt = "instruction", repeatType = "repeat", timeZone = "timezone", nextRun = "nextRunAt", lastRun = "lastRunAt", rawStatus = "status"
    }
    init() {}
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.decode(String.self, forKey: .title); prompt = try c.decode(String.self, forKey: .prompt)
        emoji = try c.decodeIfPresent(String.self, forKey: .emoji) ?? Self.inferredEmoji(title)
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
        repeatType = try c.decodeIfPresent(String.self, forKey: .repeatType) ?? "daily"
        time = try c.decodeIfPresent(String.self, forKey: .time) ?? "09:00"
        timeZone = try c.decodeIfPresent(String.self, forKey: .timeZone) ?? "Asia/Shanghai"
        startDate = try c.decodeIfPresent(String.self, forKey: .startDate) ?? Self.day(Date(), zone: timeZone)
        if let day = try c.decodeIfPresent(String.self, forKey: .endDate) {
            let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = TimeZone(identifier: timeZone); f.dateFormat = "yyyy-MM-dd"
            endDate = f.date(from: day)
        }
        notificationMode = try c.decodeIfPresent(String.self, forKey: .notificationMode) ?? "important"
        runLocally = try c.decodeIfPresent(Bool.self, forKey: .runLocally) ?? true
        newChatEachRun = try c.decodeIfPresent(Bool.self, forKey: .newChatEachRun) ?? false
        model = try c.decodeIfPresent(String.self, forKey: .model) ?? "gpt-6.1-sol"
        reasoning = try c.decodeIfPresent(String.self, forKey: .reasoning) ?? "medium"
        projectId = try c.decodeIfPresent(String.self, forKey: .projectId)
        nextRun = Self.parse(try c.decodeIfPresent(String.self, forKey: .nextRun))
        lastRun = Self.parse(try c.decodeIfPresent(String.self, forKey: .lastRun))
        conversationId = try c.decodeIfPresent(String.self, forKey: .conversationId)
        executorDeviceId = try c.decodeIfPresent(String.self, forKey: .executorDeviceId)
        lastError = try c.decodeIfPresent(String.self, forKey: .lastError)
        rawStatus = try c.decodeIfPresent(String.self, forKey: .rawStatus) ?? "pending"
        revision = try c.decodeIfPresent(Int.self, forKey: .revision) ?? 0
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id); try c.encode(title, forKey: .title); try c.encode(prompt, forKey: .prompt)
        try c.encode(emoji, forKey: .emoji); try c.encode(enabled, forKey: .enabled); try c.encode(repeatType, forKey: .repeatType)
        try c.encode(time, forKey: .time); try c.encode(timeZone, forKey: .timeZone); try c.encode(startDate, forKey: .startDate)
        try c.encode(endDate.map { Self.day($0, zone: timeZone) }, forKey: .endDate)
        try c.encode(notificationMode, forKey: .notificationMode); try c.encode(runLocally, forKey: .runLocally)
        try c.encode(newChatEachRun, forKey: .newChatEachRun); try c.encode(model, forKey: .model); try c.encode(reasoning, forKey: .reasoning)
        try c.encode(projectId, forKey: .projectId); try c.encode(conversationId, forKey: .conversationId)
        try c.encode(executorDeviceId, forKey: .executorDeviceId); try c.encode(lastError, forKey: .lastError)
        try c.encode(nextRun.map { ISO8601DateFormatter().string(from: $0) }, forKey: .nextRun)
        try c.encode(lastRun.map { ISO8601DateFormatter().string(from: $0) }, forKey: .lastRun)
        try c.encode(rawStatus, forKey: .rawStatus); try c.encode(revision, forKey: .revision)
    }
}

struct ScheduledTaskHost: Codable {
    struct Model: Codable { var id: String; var name: String; var reasoningEfforts: [String]; var defaultReasoning: String }
    var deviceId: String; var online: Bool; var local: [Model]; var cloud: [Model]; var defaultModel: String?
}
struct ScheduledTaskListing: Decodable { var tasks: [ScheduledTask]; var host: ScheduledTaskHost? }
struct ScheduledTaskMutationReply: Decodable { var task: ScheduledTask?; var deleted: Bool? }
struct ScheduledTaskPending: Codable {
    var requestId: String; var id: String; var revision: Int; var method: String; var route: String; var task: ScheduledTask?
}
struct ScheduledTaskRejected: LocalizedError {
    var status: Int; var message: String
    var errorDescription: String? { message }
}
