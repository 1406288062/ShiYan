import Foundation

nonisolated struct CodexQuotaResponse: Decodable, Sendable {
    let quota: CodexQuota
}

/// Account limits are supplied by the server; per-message token usage is unrelated.
nonisolated struct CodexQuota: Decodable, Sendable {
    let available: Bool
    let windows: [CodexQuotaWindow]
    let resetCredits: CodexResetCredits?
    /// Milliseconds since the Unix epoch, unlike the timestamps inside each item.
    let fetchedAt: Double?
    let error: String?
    let claude: ClaudeQuota?

    private enum CodingKeys: String, CodingKey { case available, windows, resetCredits, fetchedAt, error, claude }
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        available = try container.decodeIfPresent(Bool.self, forKey: .available) ?? false
        windows = try container.decodeIfPresent([CodexQuotaWindow].self, forKey: .windows) ?? []
        resetCredits = try container.decodeIfPresent(CodexResetCredits.self, forKey: .resetCredits)
        fetchedAt = try container.decodeIfPresent(Double.self, forKey: .fetchedAt)
        error = try container.decodeIfPresent(String.self, forKey: .error)
        claude = try? container.decodeIfPresent(ClaudeQuota.self, forKey: .claude)
    }

    var fetchedDate: Date? { CodexQuotaFormat.date(milliseconds: fetchedAt) }
}

/// Claude 订阅（5 小时 / 每周）额度，由服务器读取 Claude CLI 登录状态获得。
nonisolated struct ClaudeQuota: Decodable, Sendable {
    let available: Bool
    let plan: String?
    let windows: [CodexQuotaWindow]
    let error: String?

    private enum CodingKeys: String, CodingKey { case available, plan, windows, error }
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        available = try container.decodeIfPresent(Bool.self, forKey: .available) ?? false
        plan = try container.decodeIfPresent(String.self, forKey: .plan)
        windows = (try? container.decodeIfPresent([CodexQuotaWindow].self, forKey: .windows)) ?? []
        error = try container.decodeIfPresent(String.self, forKey: .error)
    }
}

nonisolated struct CodexQuotaWindow: Decodable, Sendable {
    let bucket: String?
    let period: String?
    let remainingPercent: Double?
    /// Seconds since the Unix epoch.
    let resetsAt: Double?

    var isWeekly: Bool { period == "每周" }
    var title: String { isWeekly ? "周额度" : (CodexQuotaFormat.nonempty(period) ?? "当前周期") }
    var remainingValue: Double? {
        guard let remainingPercent, remainingPercent.isFinite, (0...100).contains(remainingPercent) else { return nil }
        return remainingPercent
    }
    var remainingText: String {
        guard let remainingValue else { return "未提供剩余比例" }
        return remainingValue.formatted(.number.precision(.fractionLength(0...1))) + "% 剩余"
    }
    var resetDate: Date? { CodexQuotaFormat.date(seconds: resetsAt) }
}

nonisolated struct CodexResetCredits: Decodable, Sendable {
    /// This count is authoritative. A missing detail list does not imply zero cards.
    let availableCount: Int?
    let credits: [CodexResetCredit]?

    var countText: String {
        guard let availableCount, availableCount >= 0 else { return "可用数量未提供" }
        return "\(availableCount) 张可用"
    }
}

nonisolated struct CodexResetCredit: Decodable, Sendable {
    let id: String?
    let resetType: String?
    let status: String?
    let grantedAt: Double?
    let expiresAt: Double?
    let title: String?
    let description: String?

    var displayTitle: String { CodexQuotaFormat.nonempty(title) ?? "Codex 重置卡" }
    var statusText: String {
        guard let status = CodexQuotaFormat.nonempty(status) else { return "状态未提供" }
        return ["available": "可用", "active": "可用", "unused": "未使用",
                "used": "已使用", "consumed": "已使用", "expired": "已过期",
                "revoked": "已撤销", "pending": "待生效"][status.lowercased()] ?? status
    }
    var resetTypeText: String {
        guard let resetType = CodexQuotaFormat.nonempty(resetType) else { return "未提供" }
        return ["codexratelimits": "Codex 额度", "weekly": "周额度",
                "daily": "日额度", "all": "全部额度"][resetType.lowercased()] ?? resetType
    }
    var grantedDate: Date? { CodexQuotaFormat.date(seconds: grantedAt) }
    var expiryText: String {
        guard let date = CodexQuotaFormat.date(seconds: expiresAt) else { return "未提供到期时间" }
        return CodexQuotaFormat.dateText(date)
    }
}

nonisolated enum CodexQuotaFormat {
    static func nonempty(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
    static func date(seconds: Double?) -> Date? {
        guard let seconds, seconds.isFinite else { return nil }
        return Date(timeIntervalSince1970: seconds)
    }
    static func date(milliseconds: Double?) -> Date? {
        guard let milliseconds, milliseconds.isFinite else { return nil }
        return Date(timeIntervalSince1970: milliseconds / 1000)
    }
    static func dateText(_ date: Date) -> String {
        date.formatted(.dateTime.year().month().day().hour().minute())
    }
}
