import Foundation
import Combine
import UniformTypeIdentifiers

@MainActor
final class DotsStore: ObservableObject {
    static let shared = DotsStore()
    @Published private(set) var state = DotsSavedState(identity: "")
    @Published private(set) var loading = false
    @Published private(set) var sending = false
    @Published private(set) var uploading = false
    @Published private(set) var loadingEarlier = false
    private var historyChecked = false
    @Published private(set) var connection = ""
    @Published var notice: String?
    private let client: any DotsTransport
    private var stateURL: URL?
    private var liveTask: Task<Void, Never>?
    private var recoveryTask: Task<Void, Never>?
    private var refreshTask: Task<Void, Never>?
    private var available = true
    private var refreshing = false
    private var refreshingIdentity = false
    private var active = false
    private var readingLatest = false
    @Published private(set) var taskConversation: [DotsConversationMessage] = []
    var panelActivities: [DotsPanelActivity] { state.panel?.activities ?? [] }
    var panelOutputs: [DotsPanelOutput] { state.panel?.outputs ?? [] }
    var goals: [DotsGoal] { state.goals }
    var displayName: String { state.profile?.name ?? "Dots" }
    var unreadCount: Int { state.readState?.unreadIds.count ?? 0 }
    var avatarData: Data? { state.profile?.avatarData }
    var manager: DotsManager? { state.manager }
    var messages: [DotsManagerMessage] { state.managerMessages ?? [] }
    var tasks: [DotsManagerTask] { state.managerTasks ?? [] }
    // Imported goals stay in task history, not in the manager's live status.
    var currentTasks: [DotsManagerTask] { tasks.filter { $0.legacyImported != true } }
    var hasMoreMessages: Bool { state.managerHasMoreMessages ?? false }
    var selected: DotsGoal? {
        guard let id = state.selectedGoalId else { return nil }
        return state.details[String(id)] ?? state.goals.first { $0.id == id }
    }
    var draftKey: String { "manager" }
    var draft: String { state.drafts[draftKey] ?? "" }
    var attachments: [DotsAttachment] { state.draftAttachments ?? [] }
    var hasPending: Bool { state.pending != nil }
    var canSend: Bool {
        available && !sending && !uploading && !hasPending &&
            (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty)
    }

    init(client: (any DotsTransport)? = nil, stateURL: URL? = nil, identity: String? = nil) {
        self.client = client ?? CodexClient.shared
        if let stateURL, let identity { load(url: stateURL, identity: identity) }
    }
    private func configure() throws {
        guard stateURL == nil else { return }
        let identity = try AgentIdentity.shared.enrollment()["deviceID"] ?? ""
        guard !identity.isEmpty else { throw AgentClientError.message("设备身份暂不可用") }
        let folder = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("ShiyanDots", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        load(url: folder.appendingPathComponent("state-\(identity).json"), identity: identity)
    }
    private func load(url: URL, identity: String) {
        stateURL = url
        if let bytes = try? Data(contentsOf: url),
           let cached = try? JSONDecoder().decode(DotsSavedState.self, from: bytes),
           cached.version == 1, cached.identity == identity { state = cached }
        else { state = DotsSavedState(identity: identity) }
        if state.readState == nil, let latest = state.managerMessages?.map(\.id).max() {
            state.readState = DotsMessageReadState(baseline: latest)
        }
    }
    private func save() throws {
        try configure()
        guard let stateURL else { throw AgentClientError.message("无法保存目标状态") }
        try JSONEncoder().encode(state).write(to: stateURL, options: .atomic)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: stateURL.path)
    }
    func setDraft(_ value: String) {
        guard !hasPending else { return }
        do { try configure(); state.drafts[draftKey] = value; try save() }
        catch { notice = "草稿保存失败：" + error.localizedDescription }
    }
    func removeAttachment(_ id: String) {
        guard !hasPending, !uploading else { return }
        let before = state
        state.draftAttachments = attachments.filter { $0.id != id }
        do { try save() } catch { state = before; notice = "附件保存失败，请重试" }
    }
    func addFiles(_ urls: [URL]) async {
        guard !uploading, !sending, !hasPending else { return }
        uploading = true; notice = nil
        defer { uploading = false }
        for url in urls {
            do {
                try configure()
                guard attachments.count < 8 else { throw AgentClientError.message("最多添加 8 个文件") }
                let data = try await Task.detached(priority: .userInitiated) {
                    let access = url.startAccessingSecurityScopedResource()
                    defer { if access { url.stopAccessingSecurityScopedResource() } }
                    let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                    guard size > 0, size <= 20 * 1024 * 1024 else { throw AgentClientError.message("文件不能为空，单个文件不能超过 20 MB") }
                    return try Data(contentsOf: url, options: .mappedIfSafe)
                }.value
                let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
                let attachment = try await client.dotsUploadAttachment(id: UUID().uuidString.lowercased(), filename: url.lastPathComponent, mimeType: mime, data: data)
                state.draftAttachments = attachments + [attachment]
                try save()
            } catch { notice = url.lastPathComponent + "：" + error.localizedDescription }
        }
    }
    func select(_ id: Int?) {
        do { try configure(); state.selectedGoalId = id; try save() }
        catch { notice = error.localizedDescription }
        taskConversation = []
        if let id { Task {
            await refresh()
            do {
                let value = try await client.dotsRead("goals/\(id)/conversation", as: DotsConversationResponse.self)
                if state.selectedGoalId == id { taskConversation = value.messages }
            } catch { notice = "对话暂不可用，请重试" }
        } }
    }
     
    func startMonitoring() {
        guard !active else { return }
        do { try configure() } catch { return }
        active = true
        liveTask = Task { [weak self] in await self?.connect() }
    }
    func stopMonitoring() {
        active = false
        readingLatest = false
        liveTask?.cancel(); liveTask = nil
        recoveryTask?.cancel(); recoveryTask = nil
        refreshTask?.cancel(); refreshTask = nil
        connection = ""
    }
    func activate() {
        startMonitoring()
        if state.selectedGoalId != nil {
            state.selectedGoalId = nil
            try? save()
        }
    }
    func deactivate() { readingLatest = false }
    func setReadingLatest(_ visible: Bool) {
        readingLatest = visible
        if visible { markLatestRead() }
    }
    private func markLatestRead() {
        guard readingLatest, let latest = messages.last?.id,
              let current = state.readState,
              current.readThrough < latest || !current.unreadIds.isEmpty else { return }
        let before = state
        state.readState?.markRead(through: latest)
        do { try save() } catch { state = before }
    }
    func refreshIdentity() async {
        guard !refreshingIdentity else { return }
        refreshingIdentity = true
        defer { refreshingIdentity = false }
        do {
            try configure()
            let response = try await client.dotsRead("profile", as: DotsProfileResponse.self)
            try Task.checkCancellation()
            if let data = response.profile.avatarData, data.count > 256 * 1024 { return }
            state.profile = response.profile
            try save()
        } catch {   }
    }
    func refresh() async {
        guard !refreshing else { return }
        refreshing = true; loading = state.manager == nil
        defer { refreshing = false; loading = false }
        do {
            try configure()
            await refreshIdentity()
            let response = try await client.dotsRead("manager", as: DotsManagerResponse.self)
            try Task.checkCancellation()
            let fresh = (response.activityCursor ?? response.manager.activityCursor ?? 0) >= (state.manager?.activityCursor ?? 0)
            if fresh {
                state.manager = response.manager
                let cachedOldest = messages.first?.id ?? Int.max
                let remoteOldest = response.messages.map(\.id).min() ?? Int.max
                if !historyChecked || cachedOldest >= remoteOldest {
                    state.managerHasMoreMessages = response.hasMoreMessages ?? response.manager.hasMoreMessages ?? false
                }
                state.managerTasks = response.tasks
            }
            mergeMessages(response.messages)
            try await observeLatestMessages(response.messages,
                hasMore: response.hasMoreMessages ?? response.manager.hasMoreMessages ?? false)
            markLatestRead()
             
             
            if let id = state.selectedGoalId {
                let detail = try await client.dotsRead("goals/\(id)", as: DotsDetail.self)
                try Task.checkCancellation()
                state.details[String(id)] = detail.merged
            }
            try save()
        } catch is CancellationError { }
        catch { connection = "连接暂不可用，可下拉重试" }
    }
    private func connect() async {
        var retry: UInt64 = 1
        while active && !Task.isCancelled {
            do {
                try configure()
                let caps = try await client.dotsRead("capabilities", as: DotsCapabilities.self)
                available = caps.available != false
                guard available else {
                    connection = "Dots 暂时不可用"
                    try await Task.sleep(nanoseconds: 10_000_000_000)
                    continue
                }
                await refresh()
                try await recoverEvents()
                if caps.events == false {
                    connection = "定时同步"
                    try await Task.sleep(nanoseconds: 8_000_000_000)
                    continue
                }
                connection = ""
                recoveryTask?.cancel()
                recoveryTask = Task { [weak self] in
                    while !Task.isCancelled {
                        do { try await Task.sleep(nanoseconds: 10_000_000_000) } catch { return }
                        await self?.refresh()
                    }
                }
                retry = 1
                for try await event in client.dotsEvents(after: state.cursor) {
                    try Task.checkCancellation()
                    try await accept(event)
                    scheduleRefresh()
                }
                if active { connection = "正在重新连接…" }
            } catch is CancellationError { return }
            catch {
                guard active && !Task.isCancelled else { return }
                connection = "连接中断，正在重连…"
                await refresh()
            }
            do { try await Task.sleep(nanoseconds: retry * 1_000_000_000) } catch { return }
            retry = min(retry * 2, 20)
        }
    }
    private func recoverEvents() async throws {
        for _ in 0..<100 {
            let batch = try await client.dotsRead("notifications?after=\(state.cursor)&limit=100", as: DotsEventBatch.self)
            let previous = state
            let before = state.cursor
            for event in batch.events.sorted(by: { $0.seq < $1.seq }) { state.accept(event) }
             
            if state.cursor > before {
                do { try save() } catch { state = previous; throw error }
            }
            if state.cursor > 0 { try await client.dotsAcknowledge(consumerId: consumerId, cursor: state.cursor) }
            guard batch.hasMore == true, state.cursor > before else { return }
        }
    }
    private var consumerId: String { "shiyan_mobile:" + state.identity }
    private func accept(_ event: DotsEvent) async throws {
        guard event.seq > state.cursor else { return }
        let before = state
        state.accept(event)
        do { try save() } catch { state = before; throw error }
        try await client.dotsAcknowledge(consumerId: consumerId, cursor: state.cursor)
    }
    private func scheduleRefresh() {
        guard refreshTask == nil else { return }
        refreshTask = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 500_000_000) } catch { return }
            await self?.refresh(); self?.refreshTask = nil
        }
    }
    func submit() async {
        guard canSend else { return }
        let operation = DotsPendingOperation(requestId: UUID().uuidString,
            route: "manager/messages", text: draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "请处理这些附件。" : draft, draftKey: draftKey, attachments: attachments)
        await perform(operation)
    }
    private func mergeMessages(_ incoming: [DotsManagerMessage]) {
        state.managerMessages = Array(Dictionary((messages + incoming).map { ($0.id, $0) }, uniquingKeysWith: { _, new in new }).values)
            .sorted { $0.id < $1.id }
    }
    private func observeLatestMessages(_ incoming: [DotsManagerMessage], hasMore: Bool) async throws {
        let newest = incoming.map(\.id).max() ?? 0
        if state.readState == nil {
             
            state.readState = DotsMessageReadState(baseline: newest)
            return
        }
        let observed = state.readState!.observedThrough
        state.readState?.observe(incoming, advanceObservation: false)
        if readingLatest { markLatestRead() }
         
        try save()
        if state.readState!.readThrough >= newest {
            state.readState?.observe(incoming, advanceObservation: true)
            return
        }
        if hasMore, var beforeId = incoming.map(\.id).min(), beforeId > observed {
            while beforeId > observed {
                try Task.checkCancellation()
                let page = try await client.dotsRead("manager/messages?before=\(beforeId)&limit=100", as: DotsManagerMessagePage.self)
                try Task.checkCancellation()
                 
                state.readState?.observe(page.messages, advanceObservation: false)
                if readingLatest { markLatestRead() }
                try save()
                guard page.hasMore else { break }
                guard let next = page.messages.map(\.id).min(), next < beforeId else {
                    throw AgentClientError.message("Dots 消息同步暂未完成")
                }
                beforeId = next
            }
        }
        state.readState?.observe(incoming, advanceObservation: true)
    }
    func loadEarlier() async {
        guard !loadingEarlier, let oldest = messages.first?.id else { return }
        loadingEarlier = true
        defer { loadingEarlier = false }
        do {
            let page = try await client.dotsRead("manager/messages?before=\(oldest)&limit=100", as: DotsManagerMessagePage.self)
            mergeMessages(page.messages)
            state.managerHasMoreMessages = page.hasMore
            historyChecked = true
            try save()
        } catch { notice = "历史消息暂不可用，请重试" }
    }
    func managerControl(_ action: String) async {
        guard ["pause", "resume", "cancel", "wake"].contains(action) else { return }
        await perform(DotsPendingOperation(requestId: UUID().uuidString, route: "manager/control", action: action))
    }
    func loadActivity() async {
        do {
            try configure()
            state.panel = try await client.dotsRead("activity?limit=500", as: DotsPanelResponse.self)
            var collected: [DotsGoal] = [], cursor = 0
            for _ in 0..<20 {
                let batch = try await client.dotsRead("goals?after=\(cursor)&limit=100", as: DotsGoalList.self)
                collected.append(contentsOf: batch.goals)
                guard batch.hasMore == true, let next = batch.cursor, next != cursor else { break }
                cursor = next
            }
            state.goals = Array(Dictionary(collected.map { ($0.id, $0) }, uniquingKeysWith: { _, new in new }).values)
                .sorted { ($0.updated_at ?? 0) > ($1.updated_at ?? 0) }
            try save()
            await refresh()
        } catch { notice = "任务暂不可用，请重试" }
    }
    func saveSchedule(_ value: DotsSchedule) async {
        await perform(DotsPendingOperation(requestId: UUID().uuidString,
            route: value.id.map { "schedules/" + $0 } ?? "schedules", schedule: value))
        await loadActivity()
    }
    func control(_ action: String) async {
        guard let id = state.selectedGoalId, selected?.allowedActions.contains(action) == true else { return }
        await perform(DotsPendingOperation(requestId: UUID().uuidString, route: "goals/\(id)/control", goalId: id, action: action))
    }
    func decide(_ approval: DotsApproval, approve: Bool) async {
        guard let goalId = state.selectedGoalId, approval.isPending, let command = approval.command, !command.isEmpty else { return }
        await perform(DotsPendingOperation(requestId: UUID().uuidString,
            route: "goals/\(goalId)/approvals/\(approval.id)/decision", goalId: goalId,
            decision: approve ? "approve" : "reject", confirmedCommand: command))
    }
    func retryPending() async { if let operation = state.pending { await perform(operation) } }
    func output(_ id: Int) async throws -> DotsOutput {
        try await client.dotsRead("outputs/\(id)", as: DotsOutputDetail.self).output
    }
    private func perform(_ operation: DotsPendingOperation) async {
        guard !sending, state.pending == nil || state.pending == operation else { return }
        sending = true; notice = nil
        defer { sending = false }
        do {
            try configure()
            state.pending = operation
            try save()
            let goalId = try await client.dotsMutate(operation)
            let pendingState = state
            state.acknowledged(operation)
            if operation.route == "goals", let goalId { state.selectedGoalId = goalId }
            do { try save() } catch { state = pendingState; throw error }
            await refresh()
        } catch is CancellationError { }
        catch let error as DotsRejectedRequest {
            let before = state
            if state.pending?.requestId == operation.requestId { state.pending = nil }
            do { try save() } catch { state = before }
            notice = error.localizedDescription
        }
        catch { notice = "未确认发送结果，内容已保留。请重试原请求。" }
    }
}

