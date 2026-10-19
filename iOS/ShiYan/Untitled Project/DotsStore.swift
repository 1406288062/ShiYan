import Foundation
import Combine
import UniformTypeIdentifiers

@MainActor
final class DotsStore: ObservableObject {
    private static var instance: DotsStore?
    static var shared: DotsStore {
        if let instance { return instance }
        let value = DotsStore(); instance = value; return value
    }
    static func resetAccount() { instance?.stopMonitoring(); instance = nil }
    @Published private(set) var state = DotsSavedState(identity: "")
    @Published private(set) var loading = false
    @Published private(set) var sending = false
    @Published private(set) var uploading = false
    @Published private(set) var loadingEarlier = false
    @Published private(set) var approvalNotice: String?
    @Published private var checkingApproval: String?
    private var loadingApprovals = false
    private var approvalVersions: [Int: (version: String, time: Date)] = [:]
    private var historyChecked = false
    @Published private(set) var connection = ""
    @Published var notice: String?
    @Published private(set) var relationship: DotsRelationship?
    @Published private(set) var relationshipLoading = false
    @Published private(set) var relationshipSaving = false
    @Published private(set) var relationshipNotice: String?
    private let accountGeneration = ShiyanAccountStorage.generation
    private let client: any DotsTransport
    private var stateURL: URL?
    private var liveTask: Task<Void, Never>?
    private var recoveryTask: Task<Void, Never>?
    private var refreshTask: Task<Void, Never>?
    private var streamSaveTask: Task<Void, Never>?
    private var acknowledgementTask: Task<Void, Never>?
    private var durableEventCursor = 0
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
    var approvalGoals: [DotsGoal] {
        var ids = Set(currentTasks.filter(\.requiresApproval).map(\.id))
        if let operation = pendingApproval, let id = operation.goalId { ids.insert(id) }
        return ids.sorted().compactMap { id in
            state.details[String(id)] ?? goals.first { $0.id == id }
        }
    }
    private var pendingApproval: DotsPendingOperation? {
        guard let operation = state.pending, operation.route.contains("/approvals/"),
              operation.route.hasSuffix("/decision") else { return nil }
        return operation
    }
    var approvalStatus: String? {
        if checkingApproval != nil || (sending && pendingApproval != nil) { return "正在提交你的决定…" }
        if pendingApproval != nil { return "审批决定结果未知，请重试原决定" }
        if currentTasks.contains(where: \.requiresApproval) { return "需要你批准操作" }
        if currentTasks.contains(where: { task in
            state.details[String(task.id)]?.approvals?.contains(where: { $0.status == "executing" }) == true
        }) { return "正在执行已批准的操作…" }
        return nil
    }
    func pendingApprovalDecision(goalId: Int, approvalId: Int) -> String? {
        guard let operation = pendingApproval,
              operation.route == "goals/\(goalId)/approvals/\(approvalId)/decision" else { return nil }
        return operation.decision
    }
    func isSubmittingApproval(goalId: Int, approvalId: Int) -> Bool {
        checkingApproval == "\(goalId):\(approvalId)" ||
            (sending && pendingApprovalDecision(goalId: goalId, approvalId: approvalId) != nil)
    }
    var hasMoreMessages: Bool { state.managerHasMoreMessages ?? false }
    var selected: DotsGoal? {
        guard let id = state.selectedGoalId else { return nil }
        return state.details[String(id)] ?? state.goals.first { $0.id == id }
    }
    var draftKey: String { "manager" }
    var draft: String { state.drafts[draftKey] ?? "" }
    var attachments: [DotsAttachment] { state.draftAttachments ?? [] }
    var hasPending: Bool { state.pending != nil }
    var hasPendingVoice: Bool {
        guard let operation = state.pending else { return false }
        return operation.route == "manager/messages" && operation.draftKey == nil &&
            (operation.attachments ?? []).isEmpty && !(operation.text ?? "").isEmpty
    }
    var canStartVoice: Bool { !sending && !uploading && (!hasPending || hasPendingVoice) }
    var canSend: Bool {
        available && !sending && !uploading && !hasPending &&
            (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty)
    }

    init(client: (any DotsTransport)? = nil, stateURL: URL? = nil, identity: String? = nil) {
        self.client = client ?? CodexClient.shared
        if let stateURL, let identity { load(url: stateURL, identity: identity) }
    }
    private func configure() throws {
        guard accountGeneration == ShiyanAccountStorage.generation else { throw CancellationError() }
        guard stateURL == nil else { return }
        let identity = try AgentIdentity.shared.enrollment()["deviceID"] ?? ""
        guard !identity.isEmpty else { throw AgentClientError.message("设备身份暂不可用") }
        let folder = ShiyanAccountStorage.directory("ShiyanDots", domain: .applicationSupportDirectory)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        load(url: folder.appendingPathComponent("state-\(identity).json"), identity: identity)
    }
    private func load(url: URL, identity: String) {
        stateURL = url
        if let bytes = try? Data(contentsOf: url),
           let cached = try? JSONDecoder().decode(DotsSavedState.self, from: bytes),
           cached.version == 1, cached.identity == identity { state = cached }
        else { state = DotsSavedState(identity: identity) }
        durableEventCursor = state.cursor
        if state.readState == nil, let latest = state.managerMessages?.map(\.id).max() {
            state.readState = DotsMessageReadState(baseline: latest)
        }
    }
    private func save() throws {
        try configure()
        guard let stateURL else { throw AgentClientError.message("无法保存目标状态") }
        try JSONEncoder().encode(state).write(to: stateURL, options: .atomic)
        durableEventCursor = max(durableEventCursor, state.cursor)
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
        guard ShiyanAccount.shared.canAccessServer, !active else { return }
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
        streamSaveTask?.cancel(); streamSaveTask = nil
        if state.cursor > durableEventCursor { try? save() }
        acknowledgementTask?.cancel(); acknowledgementTask = nil
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
            await refreshApprovals(force: false)
             
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
                    if !event.isAssistantDelta { scheduleRefresh() }
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
             
            if readingLatest, let latest = messages.last?.id { state.readState?.markRead(through: latest) }
            if state.cursor > before {
                streamSaveTask?.cancel(); streamSaveTask = nil
                do { try save() } catch { state = previous; throw error }
            }
            if state.cursor > 0 { try await client.dotsAcknowledge(consumerId: consumerId, cursor: state.cursor) }
            guard batch.hasMore == true, state.cursor > before else { return }
        }
    }
    private var consumerId: String { "shiyan_mobile:" + state.identity }
    func refreshApprovals(force: Bool = true) async {
        guard !loadingApprovals else { return }
        loadingApprovals = true
        defer { loadingApprovals = false }
        let waiting = currentTasks.filter(\.requiresApproval)
        approvalNotice = nil
        for task in waiting {
            let version = "\(task.status ?? ""):\(task.updatedAt ?? 0):\(manager?.activityCursor ?? 0)"
            if !force, let cached = approvalVersions[task.id], cached.version == version,
               Date().timeIntervalSince(cached.time) < 10 { continue }
            do {
                let detail = try await client.dotsRead("goals/\(task.id)", as: DotsDetail.self)
                try Task.checkCancellation()
                state.details[String(task.id)] = detail.merged
                approvalVersions[task.id] = (version, Date())
            } catch is CancellationError { return }
            catch { approvalNotice = "待批准操作的命令和原因暂时无法读取，请重新读取。" }
        }
    }
    private func accept(_ event: DotsEvent) async throws {
        guard event.seq > state.cursor else { return }
        let before = state
        state.accept(event)
        if readingLatest, let latest = messages.last?.id { state.readState?.markRead(through: latest) }
        if event.isAssistantDelta {
            // Publish now, coalesce disk work, then acknowledge only persisted
            // cursors. A crash before this save safely replays the snapshots.
            scheduleStreamSave()
            return
        }
        streamSaveTask?.cancel(); streamSaveTask = nil
        do { try save() } catch { state = before; throw error }
        scheduleAcknowledgement()
    }
    private func scheduleStreamSave() {
        guard streamSaveTask == nil else { return }
        streamSaveTask = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 150_000_000) } catch { return }
            guard let self else { return }
            self.streamSaveTask = nil
            do { try self.save(); self.scheduleAcknowledgement() }
            catch { /* Keep the cursor unacknowledged; replay / refresh recovers it. */ }
        }
    }
    private func scheduleAcknowledgement() {
        guard acknowledgementTask == nil else { return }
        acknowledgementTask = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 250_000_000) } catch { return }
            guard let self else { return }
            let cursor = self.durableEventCursor
            try? await self.client.dotsAcknowledge(consumerId: self.consumerId, cursor: cursor)
            guard !Task.isCancelled else { return }
            self.acknowledgementTask = nil
            if self.durableEventCursor > cursor { self.scheduleAcknowledgement() }
        }
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
    /// Voice uses the same durable request and transport as typed messages.
    /// Acknowledgement releases sending immediately; refresh is independent.
    func submitVoice(_ text: String, requestID: String) async throws -> Int {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard available, !text.isEmpty, text.count <= 20_000 else {
            throw AgentClientError.message("语音消息暂不可发送")
        }
        let operation = DotsPendingOperation(requestId: requestID,
            route: "manager/messages", text: text, attachments: [])
        guard !sending, !uploading, state.pending == nil || state.pending == operation else {
            throw AgentClientError.message("上一条消息尚未确认，请先重试原请求")
        }
        sending = true; notice = nil
        defer { sending = false }
        do {
            try configure()
            state.pending = operation
            try save()
            guard let id = try await client.dotsMutate(operation), id > 0 else {
                throw AgentClientError.message("语音消息接收尚未确认")
            }
            mergeAcceptedUserMessage(operation, id: id)
            let pendingState = state
            state.acknowledged(operation)
            do { try save() } catch { state = pendingState; throw error }
            scheduleRefresh()
            return id
        } catch let error as DotsRejectedRequest {
            let before = state
            if state.pending?.requestId == requestID { state.pending = nil }
            do { try save() } catch { state = before }
            notice = error.localizedDescription
            throw error
        } catch {
            notice = "未确认发送结果，语音内容已保留。请重试原请求。"
            throw error
        }
    }
    private func mergeMessages(_ incoming: [DotsManagerMessage]) {
        state.mergeManagerMessages(incoming)
    }
    private func mergeAcceptedUserMessage(_ operation: DotsPendingOperation, id: Int?) {
        guard operation.route == "manager/messages", let id, id > 0,
              !messages.contains(where: { $0.id == id }), let content = operation.text else { return }
        // Use only a server-confirmed ID. A later canonical event replaces this
        // same bubble; delayed history refresh must not hold the transcript back.
        mergeMessages([DotsManagerMessage(id: id, role: "user", content: content,
            attachments: operation.attachments, requestId: operation.requestId,
            createdAt: Date().timeIntervalSince1970 * 1000)])
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
    func loadRelationship() async {
        guard !relationshipLoading, !relationshipSaving else { return }
        relationshipLoading = true
        defer { relationshipLoading = false }
        do {
            let response = try await client.dotsRead("relationship", as: DotsRelationshipResponse.self)
            try Task.checkCancellation()
            guard response.ok else { throw AgentClientError.message("共同话题暂不可用") }
            relationship = response.relationship
            relationshipNotice = nil
        } catch is CancellationError { }
        catch { relationshipNotice = "无法读取共同话题，请重试。" }
    }
    @discardableResult
    func updateRelationship(_ change: DotsRelationshipChange) async -> Bool {
        guard !relationshipSaving, !relationshipLoading else { return false }
        relationshipSaving = true
        relationshipNotice = nil
        defer { relationshipSaving = false }
        do {
            let response = try await client.dotsRelationship(change)
            guard response.ok else { throw AgentClientError.message("话题修改未保存") }
            relationship = response.relationship
            return true
        } catch let rejection as DotsRejectedRequest {
            relationshipNotice = rejection.message
            return false
        } catch {
            relationshipNotice = "暂时无法确认更改结果，请重新读取后重试。"
            return false
        }
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
        guard let goalId = state.selectedGoalId else { return }
        await decide(approval, goalId: goalId, approve: approve)
    }
    func decide(_ approval: DotsApproval, goalId: Int, approve: Bool) async {
        guard !sending, checkingApproval == nil else { return }
        let route = "goals/\(goalId)/approvals/\(approval.id)/decision"
        let decision = approve ? "approve" : "reject", command = approval.command ?? ""
        if let pending = state.pending {
            guard pending.route == route, pending.decision == decision, pending.confirmedCommand == command else {
                notice = "上次操作的结果尚不明确，请重试原决定，不能改交其他决定。"; return
            }
            await perform(pending)
            return
        }
        guard goalId > 0, approval.id > 0, approval.isPending else { return }
        guard !approve || approval.canApproveCommand else {
            notice = "命令尚未完整，无法批准；请让 Dots 补全具体命令。"; return
        }
        checkingApproval = "\(goalId):\(approval.id)"; sending = true; notice = nil
        defer { checkingApproval = nil; sending = false }
        do {
            // Recheck the exact displayed command before creating a new decision.
            // An uncertain prior decision above always reuses its original ID.
            let detail = try await client.dotsRead("goals/\(goalId)", as: DotsDetail.self)
            let current = detail.merged
            state.details[String(goalId)] = current
            guard let latest = current.approvals?.first(where: { $0.id == approval.id }),
                  latest.isPending, (latest.command ?? "") == command else {
                notice = "该操作的状态或命令已更新，请查看最新内容后再决定。"; return
            }
            sending = false
            await perform(DotsPendingOperation(requestId: UUID().uuidString, route: route, goalId: goalId,
                decision: decision, confirmedCommand: command))
        } catch { notice = "无法核对待批准的操作，请重新读取后再决定。" }
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
            mergeAcceptedUserMessage(operation, id: goalId)
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

