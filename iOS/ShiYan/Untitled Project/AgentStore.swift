import SwiftUI
import Combine
import UIKit

@MainActor
final class AgentStore: ObservableObject {
    private static var instance: AgentStore?
    private final class WeakTemporaryStore {
        weak var value: AgentStore?
        init(_ value: AgentStore) { self.value = value }
    }
    private static var temporaryStores: [WeakTemporaryStore] = []
    let isTemporarySession: Bool
    private var temporaryClosed = false
    static var shared: AgentStore {
        if let instance { return instance }
        let value = AgentStore(); instance = value; return value
    }
    static func resetAccount() {
        for value in temporaryStores.compactMap({ $0.value }) { value.closeTemporarySession() }
        temporaryStores.removeAll()
        guard let value = instance else { return }
        value.canSave = false
        value.bootstrap?.cancel(); value.persistenceTask?.cancel(); value.windowTask?.cancel(); value.readAcknowledgmentTask?.cancel()
        for task in value.tasks.values { task.cancel() }
        value.tasks.removeAll(); value.synchronizer.stop()
        for id in Array(value.backgroundTokens.keys) { value.endBackground(id) }
        instance = nil
    }
    private let client = CodexClient.shared
#if DEBUG
    private static var isChatRepairUITest: Bool {
        ProcessInfo.processInfo.environment["SHIYAN_UI_TEST_CHAT_REPAIR"] != nil
    }
    private static var isEditingUITest: Bool {
        ProcessInfo.processInfo.environment["SHIYAN_UI_TEST_EDIT_BRANCH"] == "1"
    }
#endif
    @Published private(set) var conversations: [AgentConversation] = []
    @Published private(set) var projects: [AgentProject] = []
    @Published var selectedID: UUID? {
        didSet {
            guard paginationReady, !isTemporarySession, selectedID != oldValue, let id = selectedID else { return }
            windowGeneration = UUID()
            windowTask?.cancel()
            historyLoading = true
            windowTask = Task { [weak self] in
                await Task.yield()
                guard !Task.isCancelled, self?.selectedID == id else { return }
                await self?.openMessageWindow(id)
            }
        }
    }
    @Published private(set) var historyLoading = true
    @Published private(set) var loadingEarlier = false
    private var paginationReady = false
    private var bootstrap: Task<Void, Never>?
    private var windowGeneration = UUID()
    private var windowTask: Task<Void, Never>?
    private var messageWindowVersions: [UUID: Int] = [:]
    private var windowDepth: [UUID: Int] = [:]
    private var stagedMessages: [UUID: (UUID, AgentMessage)] = [:]
    private var removedMessages = Set<UUID>()
    private var localDirtyMessages = Set<UUID>()
    private var persistenceTask: Task<Bool, Never>?
    private var pendingPersistence: PendingPersistence?
    lazy var messageDatabase = AgentMessageDatabase(directory: directory)
    @Published private(set) var capabilities = AgentCapabilities.fallback
    @Published var notice: String?
    @Published private(set) var answeringQuestions = Set<UUID>()
    var visibleConversationID: UUID?
    var viewingLatest = true
    private var tasks: [UUID: Task<Void, Never>] = [:]
    private var taskVersions: [UUID: UUID] = [:]
    private var recoveringSubmissions = false
    @Published private var blank = AgentConversation()
    nonisolated private struct StopIntent: Codable, Sendable { let conversationID: UUID; let messageID: UUID; let requestID: String; let jobID: String? }
    private var pendingStops: [String: StopIntent] = [:]
    private var history: HistoryManager?
    private var canSave = true
    private var titleRequests = Set<UUID>()
    private var backgroundTokens: [UUID: UIBackgroundTaskIdentifier] = [:]
    private let directory = ShiyanAccountStorage.directory("AgentSessions")
    private lazy var synchronizer = AgentSyncCoordinator(store: self, directory: directory)
    private var readReceipts: [String: AgentReadReceipt] = [:]
    private var readReceiptsWritable = true
    private var pendingReadAcknowledgments = Set<UUID>()
    private struct VisibleRead {
        var version: Int
        var readAt: Date
        var observed: [String: AgentUnreadContent]
        var unreadIDs: Set<String>
    }
    private var pendingVisibleReads: [UUID: VisibleRead] = [:]
    private var readAcknowledgmentTask: Task<Void, Never>?
    private var acknowledgedWindowVersions: [UUID: Int] = [:]
    nonisolated private struct DiskState: Codable, Sendable { var version = 2; var selectedID: UUID?; var conversations: [AgentConversation]; var stops: [String: StopIntent]?; var projects: [AgentProject]? }

    // Only a not-yet-started batch is mutable. Keep at most one queued snapshot
    // behind the current write, while retaining every dirty message and deletion.
    private final class PendingPersistence {
        var snapshot: DiskState
        var messages: [UUID: (UUID, AgentMessage)] = [:]
        var order: [UUID] = []
        var deletions = Set<UUID>()
        var locallyChanged = Set<UUID>()

        init(snapshot: DiskState) { self.snapshot = snapshot }

        func merge(snapshot: DiskState, writes: [AgentConversation], deleting: Set<UUID>, locallyChanged: Set<UUID>) {
            self.snapshot = snapshot
            for conversation in writes {
                for message in conversation.messages {
                    if messages[message.id] == nil { order.append(message.id) }
                    messages[message.id] = (conversation.id, message)
                    deletions.remove(message.id)
                }
            }
            self.locallyChanged.formUnion(locallyChanged)
            for id in deleting { messages.removeValue(forKey: id) }
            deletions.formUnion(deleting)
            self.locallyChanged.subtract(deletions)
        }

        var writes: [AgentConversation] {
            var seen = Set<UUID>()
            let ordered = order.filter { seen.insert($0).inserted }.compactMap { messages[$0] }
            return Dictionary(grouping: ordered, by: { $0.0 }).map { id, values in
                var conversation = AgentConversation(id: id)
                conversation.messages = values.map { $0.1 }
                return conversation
            }
        }
    }

    private struct CapabilitySnapshot: Codable {
        let scope: String
        let verifiedAt: Date
        let values: AgentCapabilities
    }
    private var lastVerifiedCapabilityScope: String?
    private var lastCapabilityCheck: Date?

    private func loadVerifiedCapabilitiesCache() {
        guard let scope = client.capabilitiesCacheScope,
              let data = try? Data(contentsOf: directory.appendingPathComponent("capabilities-verified.json")),
              let snapshot = try? JSONDecoder().decode(CapabilitySnapshot.self, from: data),
              snapshot.scope == scope, snapshot.values.isVerified else { return }
        capabilities = snapshot.values
        lastVerifiedCapabilityScope = scope
         
    }

    private func cacheVerifiedCapabilities(_ values: AgentCapabilities) {
        guard values.isVerified, let scope = client.capabilitiesCacheScope else { return }
        let snapshot = CapabilitySnapshot(scope: scope, verifiedAt: Date(), values: values)
        guard let bytes = try? JSONEncoder().encode(snapshot) else { return }
        let folder = directory
        Task.detached(priority: .utility) {
            do {
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true,
                                                        attributes: [.posixPermissions: 0o700])
                let file = folder.appendingPathComponent("capabilities-verified.json")
                try bytes.write(to: file, options: .atomic)
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
            } catch {
                 
            }
        }
    }

    private func fetchVerifiedCapabilities() async throws -> AgentCapabilities {
        let scope = client.capabilitiesCacheScope
        if capabilities.isVerified, let lastCapabilityCheck,
           scope == lastVerifiedCapabilityScope, Date().timeIntervalSince(lastCapabilityCheck) < 60 {
            try Task.checkCancellation()
            return capabilities
        }
        var lastError: Error = AgentClientError.message("模型能力尚未读取")
        for attempt in 0..<3 {
            try Task.checkCancellation()
            do {
                let values = try await client.capabilities()
                try Task.checkCancellation()
                guard values.isVerified else { throw AgentClientError.message("模型能力响应无效") }
                return values
            } catch {
                if Task.isCancelled || error is CancellationError { throw CancellationError() }
                lastError = error
                if attempt < 2 { try await Task.sleep(for: .milliseconds((attempt + 1) * 600)) }
            }
        }
        throw lastError
    }

    init(temporary: Bool = false) {
        isTemporarySession = temporary
        if temporary {
            let main = Self.shared
            capabilities = main.capabilities
            lastVerifiedCapabilityScope = main.lastVerifiedCapabilityScope
            lastCapabilityCheck = main.lastCapabilityCheck
            conversations = [blank]
            selectedID = blank.id
            historyLoading = false
            paginationReady = true
            Self.temporaryStores.removeAll { $0.value == nil }
            Self.temporaryStores.append(WeakTemporaryStore(self))
            return
        }
#if DEBUG
        if Self.isChatRepairUITest {
            if let json = ProcessInfo.processInfo.environment["SHIYAN_UI_TEST_MODELS"],
               let data = json.data(using: .utf8), let values = try? JSONDecoder().decode(AgentCapabilities.self, from: data) {
                capabilities = values
            }
            let fixture = AgentRepairFixtures.conversation()
            conversations = [fixture]; selectedID = fixture.id; canSave = false
            return
        }
         
        if Self.isEditingUITest {
            var fixture = AgentConversation()
            fixture.title = "编辑消息回归"
            fixture.titleIsManual = true
            fixture.threadID = "original-thread-preserved"
            fixture.messages = [
                AgentMessage(role: .user, text: "前文用户_应保留"),
                AgentMessage(role: .assistant, text: "前文回复_应保留"),
                AgentMessage(role: .user, text: "编辑目标_旧文本"),
                AgentMessage(role: .assistant, text: "被替换回复_应消失"),
                AgentMessage(role: .user, text: "旧分支后续消息_应消失"),
                AgentMessage(role: .assistant, text: "旧分支后续回复_应消失")
            ]
            conversations = [fixture]
            selectedID = fixture.id
            canSave = false
            return
        }
#endif
        loadVerifiedCapabilitiesCache()
        let receiptFile = directory.appendingPathComponent("read-receipts.json")
        if FileManager.default.fileExists(atPath: receiptFile.path) {
            do { readReceipts = try JSONDecoder().decode([String: AgentReadReceipt].self, from: Data(contentsOf: receiptFile)) }
            catch {
                readReceiptsWritable = false
                notice = "已读记录读取失败，原文件已保留"
            }
        }
        bootstrap = Task { [weak self] in await self?.loadPagedHistory() }
    }

    private func loadPagedHistory() async {
        let location = directory
        do {
            let state = try await Task.detached(priority: .utility) { () -> DiskState? in
                let index = location.appendingPathComponent("conversations-index.json")
                let legacy = location.appendingPathComponent("conversations.json")
                let file = FileManager.default.fileExists(atPath: index.path) ? index : legacy
                guard FileManager.default.fileExists(atPath: file.path) else { return nil }
                return try JSONDecoder().decode(DiskState.self, from: Data(contentsOf: file))
            }.value
            if let state {
                 
                 
                try await messageDatabase.save(state.conversations, locallyChanged: Set(state.conversations.flatMap(\.messages).map(\.id)))
                conversations = state.conversations.map { original in
                    var c = original
                    if c.hasUnread && c.unreadMessageIDs == nil {
                        c.unreadMessageIDs = Set(c.messages.filter { $0.role == .assistant }.map { $0.id.uuidString.lowercased() })
                    }
                    c.messages = []; return c
                }
                projects = state.projects ?? []; pendingStops = state.stops ?? [:]
                selectedID = state.selectedID
            }
            try await refreshMessageSummaries()
            if conversations.isEmpty { _ = newConversation() }
            if !conversations.contains(where: { $0.id == selectedID }) { selectedID = conversations.first?.id }
            for c in conversations where c.pendingJobID != nil || c.pendingMessageID != nil || c.storedIsBusy == true || c.id == selectedID || !(c.messageQueue ?? []).isEmpty {
                windowDepth[c.id] = AgentMessageDatabase.pageSize
                let page = try await messageDatabase.page(conversation: c.id)
                if let i = conversations.firstIndex(where: { $0.id == c.id }) { conversations[i].messages = page }
            }
            paginationReady = true
            _ = await persistDurably()
            await synchronizer.initialize()
            historyLoading = false
            if let id = selectedID { viewedLatest(id) }
        } catch {
            canSave = false; historyLoading = false
            notice = "会话记录读取失败，原文件已保留，未覆盖历史数据"
        }
    }
    private func refreshMessageSummaries() async throws {
        guard !isTemporarySession else { return }
        let summaries = try await messageDatabase.summaries()
        for i in conversations.indices {
            let value = summaries[conversations[i].id]
            conversations[i].storedMessageCount = value?.count ?? 0
            conversations[i].storedHasSentMessage = value?.hasUser ?? false
            conversations[i].storedLastContent = value?.preview ?? ""
            conversations[i].storedIsBusy = value?.latestWorking ?? false
            conversations[i].storedHasCompletedReply = value?.hasCompletedReply ?? false
        }
    }
    var hasEarlierMessages: Bool {
        guard let c = current else { return false }
        return (c.storedMessageCount ?? c.messages.count) > c.messages.count
    }
    func openMessageWindow(_ id: UUID) async {
        guard !isTemporarySession, !Task.isCancelled, selectedID == id else { return }
        let generation = UUID(); windowGeneration = generation
        historyLoading = true; loadingEarlier = false
        guard await persistDurably() else {
            if selectedID == id, windowGeneration == generation { historyLoading = false }
            return
        }
        guard !Task.isCancelled, selectedID == id, windowGeneration == generation else { return }
        do {
            let version = messageWindowVersions[id] ?? 0
            var page = try await messageDatabase.page(conversation: id)
            if messageWindowVersions[id] ?? 0 != version, let current = conversation(id) {
                var merged = Dictionary(uniqueKeysWithValues: page.map { ($0.id, $0) })
                for message in current.messages { merged[message.id] = message }
                page = Array(AgentMessageOrder.ordered(Array(merged.values)).suffix(AgentMessageDatabase.pageSize))
            }
            guard !Task.isCancelled, selectedID == id, windowGeneration == generation else { return }
            for i in conversations.indices where conversations[i].id != id && !conversations[i].isBusy && (conversations[i].messageQueue ?? []).isEmpty {
                conversations[i].messages = []; windowDepth.removeValue(forKey: conversations[i].id)
            }
            if let i = conversations.firstIndex(where: { $0.id == id }) { conversations[i].messages = page }
            windowDepth[id] = AgentMessageDatabase.pageSize; historyLoading = false
            viewedLatest(id)
            resumePending()
            Task { [weak self] in await self?.recoverInterruptedSubmissions() }
        } catch {
            guard !Task.isCancelled, selectedID == id, windowGeneration == generation else { return }
            historyLoading = false; notice = "历史消息读取失败，可稍后重试"
        }
    }
     
    func loadEarlierMessages() async -> UUID? {
        guard !isTemporarySession else { return nil }
        guard !historyLoading, !loadingEarlier, hasEarlierMessages,
              let c = current, let anchor = c.messages.first?.id else { return nil }
        let generation = windowGeneration
        loadingEarlier = true
        defer { if windowGeneration == generation { loadingEarlier = false } }
        do {
            let page = try await messageDatabase.page(conversation: c.id, before: anchor)
            guard selectedID == c.id, windowGeneration == generation,
                  let i = conversations.firstIndex(where: { $0.id == c.id }) else { return nil }
            let existing = Set(conversations[i].messages.map(\.id))
            conversations[i].messages.insert(contentsOf: page.filter { !existing.contains($0.id) }, at: 0)
            windowDepth[c.id] = conversations[i].messages.count
            return anchor
        } catch { notice = "更早消息读取失败，可重试"; return nil }
    }
    func refreshMessageWindowsAfterSync() async throws {
        guard !isTemporarySession else { return }
        try await refreshMessageSummaries()
        for i in conversations.indices where conversations[i].id != selectedID && !conversations[i].isBusy && (conversations[i].messageQueue ?? []).isEmpty {
            conversations[i].messages = []; windowDepth.removeValue(forKey: conversations[i].id)
        }
        for c in conversations where c.id == selectedID || c.isBusy || !(c.messageQueue ?? []).isEmpty {
            let version = messageWindowVersions[c.id] ?? 0
            let page = try await messageDatabase.page(conversation: c.id, limit: windowDepth[c.id] ?? AgentMessageDatabase.pageSize)
            guard (messageWindowVersions[c.id] ?? 0) == version,
                  c.id == selectedID || conversation(c.id)?.isBusy == true || !(conversation(c.id)?.messageQueue ?? []).isEmpty else { continue }
            if let i = conversations.firstIndex(where: { $0.id == c.id }) { conversations[i].messages = page }
        }
        Task { [weak self] in await self?.recoverInterruptedSubmissions() }
    }
    func searchMessageHistory(_ query: String) async -> Set<UUID> {
        if isTemporarySession { return Set(conversations.filter { $0.messages.contains { $0.text.localizedCaseInsensitiveContains(query) } }.map(\.id)) }
        guard !query.isEmpty else { return [] }
        do { return try await messageDatabase.search(query) }
        catch { notice = "历史搜索失败，请重试"; return [] }
    }

    var current: AgentConversation? { conversations.first { $0.id == selectedID } ?? (selectedID == blank.id ? blank : nil) }
    func attach(history: HistoryManager) {
        guard !isTemporarySession else { return }
        self.history = history
        Task { await collectGeneratedImages() }
    }
    func collectGeneratedImages() async {
        guard !isTemporarySession else { return }
        guard let history else { return }
        let archived = (try? await messageDatabase.assets(assistantOnly: true)) ?? []
        let visible = conversations.flatMap { $0.messages }.filter { $0.role == .assistant }.flatMap { $0.assets }
        var collected = Set<UUID>()
        for asset in archived + visible where asset.isImage && collected.insert(asset.id).inserted {
            await history.collectGeneratedImage(asset)
        }
    }
    func conversation(_ id: UUID) -> AgentConversation? { conversations.first { $0.id == id } ?? (blank.id == id ? blank : nil) }
    func persist() { _ = enqueuePersistence() }
    func persistDurably() async -> Bool { await enqueuePersistence(notifySync: false).value }
    @discardableResult
    private func enqueuePersistence(notifySync: Bool = true) -> Task<Bool, Never> {
        if isTemporarySession {
            localDirtyMessages.removeAll(); removedMessages.removeAll(); stagedMessages.removeAll()
            let open = !temporaryClosed
            return Task { open }
        }
        guard canSave, paginationReady else { return Task { !self.historyLoading && self.canSave } }
        var snapshot = DiskState(selectedID: selectedID, conversations: conversations, stops: pendingStops, projects: projects)
        var writes: [AgentConversation] = []
        for c in snapshot.conversations {
            let changed = c.messages.filter { localDirtyMessages.contains($0.id) }
            if !changed.isEmpty { var batch = AgentConversation(id: c.id); batch.messages = changed; writes.append(batch) }
        }
        for (conversationID, message) in stagedMessages.values {
            var c = AgentConversation(id: conversationID); c.messages = [message]; writes.append(c)
        }
        stagedMessages.removeAll()
        let deletions = removedMessages; removedMessages.removeAll()
        let locallyChanged = localDirtyMessages; localDirtyMessages.removeAll()
        for i in snapshot.conversations.indices { snapshot.conversations[i].messages = [] }
        if let pendingPersistence, let persistenceTask {
            pendingPersistence.merge(snapshot: snapshot, writes: writes, deleting: deletions, locallyChanged: locallyChanged)
            if notifySync { synchronizer.changed() }
            return persistenceTask
        }
        let batch = PendingPersistence(snapshot: snapshot)
        batch.merge(snapshot: snapshot, writes: writes, deleting: deletions, locallyChanged: locallyChanged)
        pendingPersistence = batch
        let previous = persistenceTask, database = messageDatabase, destination = directory
        let task = Task { [weak self, batch] () -> Bool in
            if let previous, !(await previous.value) {
                if self?.pendingPersistence === batch { self?.pendingPersistence = nil }
                self?.notice = "会话保存失败，已暂停后续写入以保留数据"; return false
            }
            if self?.pendingPersistence === batch { self?.pendingPersistence = nil }
            let writes = batch.writes, snapshot = batch.snapshot
            let deletions = batch.deletions, locallyChanged = batch.locallyChanged
            do {
                try await database.save(writes, deleting: deletions, locallyChanged: locallyChanged)
                try await Task.detached(priority: .utility) {
                    try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
                    try JSONEncoder().encode(snapshot).write(to: destination.appendingPathComponent("conversations-index.json"), options: .atomic)
                }.value
                return true
            } catch { self?.notice = "会话保存失败，请检查设备存储空间"; return false }
        }
        persistenceTask = task
        if notifySync { synchronizer.changed() }
        return task
    }
    private func unreadIDs(in conversation: AgentConversation) -> Set<String> {
        conversation.unreadMessageIDs ?? (conversation.hasUnread
            ? Set(conversation.messages.filter { $0.role == .assistant }.map { $0.id.uuidString.lowercased() })
            : [])
    }
    private func reconcileUnreadState(_ conversation: inout AgentConversation) {
        var ids = unreadIDs(in: conversation)
        let messages = conversation.messages.filter { $0.role == .assistant }
         
        if let receipt = readReceipts[conversation.id.uuidString.lowercased()] {
            for message in messages where ids.contains(message.id.uuidString.lowercased()) {
                if receipt.versions[message.id.uuidString.lowercased()] == message.unreadContent.version {
                    ids.remove(message.id.uuidString.lowercased())
                }
            }
        }
        conversation.unreadMessageIDs = ids
        conversation.hasUnread = !ids.isEmpty
    }
    private func saveReadReceipt(_ receipt: AgentReadReceipt, for id: UUID) async -> Bool {
        if isTemporarySession { readReceipts[id.uuidString.lowercased()] = receipt; return !temporaryClosed }
        let key = id.uuidString.lowercased()
        guard canSave else { readReceipts[key] = receipt; return true }
        guard readReceiptsWritable else { return false }
        var snapshot = readReceipts
        snapshot[key] = receipt
        let destination = directory
        do {
            try await Task.detached(priority: .utility) { [snapshot] in
                try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
                try JSONEncoder().encode(snapshot).write(to: destination.appendingPathComponent("read-receipts.json"), options: .atomic)
            }.value
            guard !Task.isCancelled else { return false }
            readReceipts = snapshot
            return true
        } catch {
            notice = "已读记录保存失败，请检查设备存储空间"
            return false
        }
    }
    private func markAssistantUnread(_ id: UUID, messageID: UUID) {
        guard visibleConversationID != id || !viewingLatest,
              let message = conversation(id)?.messages.first(where: { $0.id == messageID }),
              message.role == .assistant,
              readReceipts[id.uuidString.lowercased()]?.versions[messageID.uuidString.lowercased()] != message.unreadContent.version else { return }
        update(id) { conversation in
            var ids = self.unreadIDs(in: conversation)
            ids.insert(messageID.uuidString.lowercased())
            conversation.unreadMessageIDs = ids
            conversation.hasUnread = true
        }
    }
    private func recordSyncedUnread(at index: Int, previous: AgentMessage?, message: AgentMessage) {
        guard message.role == .assistant else { return }
        var conversation = conversations[index]
        var ids = unreadIDs(in: conversation)
        let key = message.id.uuidString.lowercased()
        let content = message.unreadContent
        let receipt = readReceipts[conversation.id.uuidString.lowercased()]
        let priorContent = previous?.role == .assistant ? previous?.unreadContent : nil
        if visibleConversationID == conversation.id && viewingLatest {
             
            if priorContent != content || receipt?.versions[key] != content.version || ids.contains(key) {
                pendingReadAcknowledgments.insert(conversation.id)
            }
        } else if receipt?.versions[key] == content.version {
            ids.remove(key)
        } else if content.isUnread(comparedTo: priorContent, readVersion: receipt?.versions[key],
                                   lastReadAt: receipt?.readAt ?? (conversation.hasUnread ? nil : conversation.lastOpenedAt),
                                   contentDate: message.completedAt ?? message.createdAt, isWorking: message.isWorking) {
            ids.insert(key)
        } else if previous == nil {
            ids.remove(key)
        }
        conversation.unreadMessageIDs = ids
        conversation.hasUnread = !ids.isEmpty
        conversations[index] = conversation
    }
    func confirmVisibleReadStateAfterSync() {
        guard let id = visibleConversationID, viewingLatest,
              pendingReadAcknowledgments.contains(id) || conversation(id)?.hasUnread == true else { return }
        viewedLatest(id)
    }
    private func update(_ id: UUID, _ body: (inout AgentConversation) -> Void) {
        guard !isTemporarySession || !temporaryClosed else { return }
        if id == blank.id && !conversations.contains(where: { $0.id == id }) {
            body(&blank)
            blank.storedHasSentMessage = blank.hasSentMessage
            blank.storedMessageCount = blank.messages.count
            if blank.messages.contains(where: { $0.role == .user }) { conversations.insert(blank, at: 0) }
            persist(); return
        }
        guard let i = conversations.firstIndex(where: { $0.id == id }) else { return }
        let previousCount = conversations[i].messages.count
        body(&conversations[i])
        conversations[i].storedMessageCount = max(0, (conversations[i].storedMessageCount ?? previousCount) + conversations[i].messages.count - previousCount)
        conversations[i].storedHasSentMessage = conversations[i].hasSentMessage
        if let last = conversations[i].messages.last { conversations[i].storedIsBusy = last.isWorking }
        if let latest = conversations[i].messages.last(where: { !$0.text.isEmpty }) {
            conversations[i].storedLastContent = String(latest.text.prefix(240))
        }
        messageWindowVersions[id, default: 0] += 1
        if !isTemporarySession { conversations[i].messages = Array(conversations[i].messages.suffix(windowDepth[id] ?? AgentMessageDatabase.pageSize)) }
        reconcileUnreadState(&conversations[i]); persist()
    }
    private func updateMessage(_ id: UUID, _ messageID: UUID, _ body: (inout AgentMessage) -> Void) {
        localDirtyMessages.insert(messageID)
        update(id) { conversation in
            if let i = conversation.messages.firstIndex(where: { $0.id == messageID }) { body(&conversation.messages[i]) }
        }
    }
    @discardableResult func newConversation(reuseExistingEmpty: Bool = false) -> UUID {
         
         
        if let item = current, item.messages.isEmpty, (item.storedMessageCount ?? 0) == 0, item.draft.isEmpty,
           item.draftAssets.isEmpty, !item.isPinned, !item.titleIsManual {
            viewingLatest = true
            return item.id
        }
         
         
        if reuseExistingEmpty, let item = conversations.first(where: { $0.messages.isEmpty && ($0.storedMessageCount ?? 0) == 0 && !$0.isBusy }) {
            select(item.id)
            return item.id
        }
         
         
        blank = AgentConversation()
        conversations.insert(blank, at: 0)
        selectedID = blank.id
        viewingLatest = true
        persist()
        return blank.id
    }
    func select(_ id: UUID) { selectedID = id; viewingLatest = true; update(id) { $0.lastOpenedAt = Date() } }
    func viewedLatest(_ id: UUID) {
        guard !isTemporarySession else { return }
        guard !historyLoading, visibleConversationID == id, viewingLatest, let conversation = conversation(id) else { return }
        guard acknowledgedWindowVersions[id] != (messageWindowVersions[id] ?? 0) ||
                conversation.hasUnread || pendingReadAcknowledgments.contains(id) else { return }
        pendingVisibleReads[id] = VisibleRead(version: messageWindowVersions[id] ?? 0, readAt: Date(),
            observed: Dictionary(uniqueKeysWithValues: conversation.messages.filter { $0.role == .assistant }
                .map { ($0.id.uuidString.lowercased(), $0.unreadContent) }), unreadIDs: unreadIDs(in: conversation))
        guard readAcknowledgmentTask == nil else { return }
        readAcknowledgmentTask = Task { [weak self] in await self?.acknowledgeVisibleReads() }
    }

    private func acknowledgeVisibleReads() async {
        defer { readAcknowledgmentTask = nil }
        while !pendingVisibleReads.isEmpty, !Task.isCancelled {
            // Geometry and streaming updates can request the same receipt repeatedly.
            // Coalesce them before hashing reply text and writing the receipt file.
            do { try await Task.sleep(for: .milliseconds(100)) } catch { return }
            let reads = pendingVisibleReads; pendingVisibleReads.removeAll()
            for (id, read) in reads {
                guard !Task.isCancelled, conversation(id) != nil else { continue }
                let version = read.version, observed = read.observed
                let computed = await Task.detached(priority: .utility) {
                    observed.mapValues { $0.version }
                }.value
                guard !Task.isCancelled else { return }
                var versions = readReceipts[id.uuidString.lowercased()]?.versions ?? [:]
                versions.merge(computed) { _, new in new }
                guard await saveReadReceipt(AgentReadReceipt(readAt: read.readAt, versions: versions), for: id) else { return }
                acknowledgedWindowVersions[id] = version
                if (messageWindowVersions[id] ?? 0) == version { pendingReadAcknowledgments.remove(id) }
                if let index = conversations.firstIndex(where: { $0.id == id }) {
                    var current = conversations[index]
                    var unread = unreadIDs(in: current)
                    if (messageWindowVersions[id] ?? 0) == version { unread.subtract(read.unreadIDs) }
                    for message in current.messages where message.role == .assistant {
                        let key = message.id.uuidString.lowercased()
                        if observed[key] == message.unreadContent { unread.remove(key) }
                    }
                    if current.unreadMessageIDs != unread || current.hasUnread != !unread.isEmpty {
                        current.unreadMessageIDs = unread; current.hasUnread = !unread.isEmpty
                        conversations[index] = current
                        persist()
                    }
                }
                if (messageWindowVersions[id] ?? 0) != version { viewedLatest(id) }
            }
        }
    }
    func setDraft(_ text: String) { if let id = selectedID { update(id) { $0.draft = text } } }
    func addDraftAssets(_ assets: [AgentAsset], to id: UUID) {
        update(id) { $0.draftAssets = Array(($0.draftAssets + assets).prefix(capabilities.maxUploadImages)) }
    }
    func setDraftAssets(_ assets: [AgentAsset], in id: UUID) { update(id) { $0.draftAssets = assets } }
    func removeDraftAsset(_ assetID: UUID, in id: UUID) { update(id) { $0.draftAssets.removeAll { $0.id == assetID } } }
    var selectedModel: AgentModelOption { capabilities.option(for: current?.model) }
    var reasoningEfforts: [String] { selectedModel.reasoningEfforts }
    func setModel(_ value: String) {
        guard let option = capabilities.availableModels.first(where: { $0.id == value }), let id = selectedID else { return }
        update(id) {
            $0.model = option.id
            if !option.reasoningEfforts.contains($0.reasoning) { $0.reasoning = option.defaultReasoning }
        }
    }
    func setReasoning(_ value: String) {
        guard reasoningEfforts.contains(value), let id = selectedID else { return }
        update(id) { $0.reasoning = value }
    }
    func togglePin(_ id: UUID) { update(id) { $0.isPinned.toggle() } }
    func rename(_ id: UUID, title: String) {
        let cleaned = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return }
        update(id) { $0.title = String(cleaned.prefix(100)); $0.titleIsManual = true }
    }
    func useImage(_ asset: AgentAsset, in id: UUID) {
        guard asset.isImage else { return }
         
         
        update(id) { $0.draftAssets = [asset] }
    }
    func clearImage() { if let id = selectedID { update(id) { $0.activeImageID = nil } } }
    func activeImage(in conversation: AgentConversation) -> AgentAsset? {
        guard let id = conversation.activeImageID else { return nil }
        return conversation.messages.reversed().flatMap(\.assets).first { $0.id == id }
    }
    func list(query: String, pinned: Bool) -> [AgentConversation] {
        let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return conversations.filter { item in
            item.hasSentMessage && item.isPinned == pinned && (term.isEmpty || item.title.localizedCaseInsensitiveContains(term) || item.messages.contains { $0.text.localizedCaseInsensitiveContains(term) })
        }.sorted { $0.updatedAt > $1.updatedAt }
    }
    func prepare() async {
        guard !temporaryClosed else { return }
        if isTemporarySession {
            do {
                let values = try await fetchVerifiedCapabilities()
                guard !temporaryClosed, !Task.isCancelled else { return }
                capabilities = values
                lastVerifiedCapabilityScope = client.capabilitiesCacheScope
                lastCapabilityCheck = Date()
                for intent in Array(pendingStops.values) { Task { [weak self] in await self?.confirmStop(intent) } }
            } catch { if !Task.isCancelled { notice = error.localizedDescription } }
            return
        }
#if DEBUG
        if Self.isEditingUITest || Self.isChatRepairUITest { return }
#endif
         
        await bootstrap?.value
        guard canSave, paginationReady else { return }
        synchronizer.start()
        resumePending()
        do {
            let values = try await fetchVerifiedCapabilities()
            try Task.checkCancellation()
            if capabilities != values { capabilities = values }
            lastVerifiedCapabilityScope = client.capabilitiesCacheScope
            lastCapabilityCheck = Date()
            cacheVerifiedCapabilities(values)
            for i in conversations.indices {
                let option = values.option(for: conversations[i].model)
                conversations[i].model = option.id
                if !option.reasoningEfforts.contains(conversations[i].reasoning) { conversations[i].reasoning = option.defaultReasoning }
            }
            let blankOption = values.option(for: blank.model)
            blank.model = blankOption.id
            if !blankOption.reasoningEfforts.contains(blank.reasoning) { blank.reasoning = blankOption.defaultReasoning }
            persist()
            for intent in Array(pendingStops.values) { Task { [weak self] in await self?.confirmStop(intent) } }
            let untitled = conversations.filter { !$0.titleIsManual && $0.titleWasGenerated != true && ($0.storedHasCompletedReply == true || $0.messages.contains(where: { $0.role == .assistant && $0.state == .completed })) }
            for item in untitled { Task { [weak self] in await self?.refreshTitle(item.id) } }
        } catch {
#if DEBUG
            NSLog("[ShiyanConnection] %@", error.localizedDescription)
#endif
        }
    }

     
     
    @discardableResult
    func send(text: String, attachments: [AgentAsset] = [], editingMessageID: UUID? = nil,
              preparedRemoteID: String? = nil, preparedThreadID: String? = nil,
              conversationID: UUID? = nil, queuedMessageID: UUID? = nil) -> Bool {
        guard !temporaryClosed, !historyLoading, var conversation = conversationID.flatMap({ self.conversation($0) }) ?? current,
              !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty else { return false }
        guard !capabilities.hasOnlyHiddenModels else {
            notice = "当前没有可用模型，请刷新后重试"
            return false
        }

        guard text.count <= 200_000 else { notice = "消息过长"; return false }

        if attachments.contains(where: { !$0.isImage }) {
            let totalSize = attachments.reduce(0) { total, asset in
                total + ((try? asset.url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
            }
            guard totalSize <= 24 * 1024 * 1024 else {
                notice = "附件总大小不能超过 24 MB"; return false
            }
        }

        if editingMessageID == nil && queuedMessageID == nil &&
            (conversation.isBusy || !(conversation.messageQueue ?? []).isEmpty || pendingStops.values.contains(where: { $0.conversationID == conversation.id })) {
            guard (conversation.messageQueue ?? []).count < 30 else {
                notice = "等待队列已满，请等待部分消息处理完成"; return false
            }
            let entry = AgentQueuedMessage(text: text, assets: attachments, model: conversation.model, reasoning: conversation.reasoning)
            update(conversation.id) {
                $0.messageQueue = ($0.messageQueue ?? []) + [entry]
                $0.draft = ""; $0.draftAssets = []
            }
            dispatchQueuedMessage(conversation.id)
            return true
        }
        guard !conversation.isBusy, !pendingStops.values.contains(where: { $0.conversationID == conversation.id }) else { return false }
        if let queuedMessageID, let entry = conversation.messageQueue?.first(where: { $0.id == queuedMessageID }) {
            conversation.model = entry.model; conversation.reasoning = entry.reasoning
        }

        let editIndex: Int?
        if let editingMessageID {
            guard preparedRemoteID != nil else {
                notice = "请通过编辑分支重新发送；原消息未修改"
                return false
            }
            guard let index = conversation.messages.firstIndex(where: {
                $0.id == editingMessageID && $0.role == .user
            }) else {
                notice = "待编辑的消息已不存在，请重新选择"
                return false
            }
            editIndex = index
        } else {
            editIndex = nil
        }

        let id = conversation.id
        let assets = attachments
         
        let remoteID = editIndex == nil
            ? (conversation.remoteConversationID ?? id.uuidString)
            : preparedRemoteID!
        var user = AgentMessage(role: .user, text: text, assets: assets)
        var reply = AgentMessage(role: .assistant, text: "", state: .submitting, phase: "发送中")
        reply.requestID = UUID().uuidString
        user.requestID = reply.requestID
        reply.reasoning = conversation.reasoning
        let model = capabilities.option(for: conversation.model).id
        reply.model = model == "Codex" ? nil : model

        localDirtyMessages.formUnion([user.id, reply.id])
        update(id) { item in
            if let editIndex {
                let discardedIDs = item.messages.dropFirst(editIndex).map(\.id)
                if !isTemporarySession { synchronizer.deleteMany(kind: "messages", ids: discardedIDs) }
                removedMessages.formUnion(discardedIDs)
                item.messages = Array(item.messages.prefix(editIndex))
                item.remoteConversationID = remoteID
                item.threadID = preparedThreadID
                 
                if editIndex == 0 && (item.storedMessageCount ?? item.messages.count) <= item.messages.count && !item.titleIsManual {
                    item.title = Self.provisionalTitle(text)
                    item.titleWasGenerated = false
                }
            }
            item.remoteConversationID = remoteID
            item.messages.append(contentsOf: [user, reply])
            if let queuedMessageID {
                item.messageQueue?.removeAll { $0.id == queuedMessageID }
                item.queueError = nil
            } else {
                item.draft = ""
                item.draftAssets = []
            }
            item.updatedAt = Date()
            item.pendingJobID = nil
            item.pendingMessageID = reply.id
            item.lastEventID = 0
             
            item.activeImageID = assets.last(where: \.isImage)?.id
                ?? item.messages.dropLast(2).reversed().flatMap(\.assets).first(where: \.isImage)?.id
            if item.title == "新聊天" { item.title = Self.provisionalTitle(text) }
        }

#if DEBUG
        if Self.isChatRepairUITest {
            if ProcessInfo.processInfo.environment["SHIYAN_UI_TEST_MODELS"] != nil,
               let data = try? JSONEncoder().encode(reply) {
                try? data.write(to: directory.deletingLastPathComponent().appendingPathComponent("model-picker-request.json"), options: .atomic)
            }
            tasks[id] = Task { [weak self] in
                guard let self else { return }
                self.update(id) { $0.pendingJobID = "ui-fixture-stream" }
                self.updateMessage(id, reply.id) { $0.state = .running }
                for index in 1...24 {
                    do { try await Task.sleep(for: .milliseconds(260)) } catch { return }
                    guard !Task.isCancelled else { return }
                    self.updateMessage(id, reply.id) {
                        $0.text += "模拟回复第\(index)段：这一段用于检查新内容增长后是否继续跟随。\n"
                    }
                }
                self.updateMessage(id, reply.id) { $0.text += "回复完成标记_CHAT_REPAIR_OK"; $0.state = .completed }
                self.update(id) { $0.pendingJobID = nil; $0.pendingMessageID = nil }
                self.tasks[id] = nil
                self.dispatchQueuedMessage(id)
            }
            return true
        }
        if Self.isEditingUITest { return true }
#endif
        startSubmission(id: id, reply: reply, text: text, assets: assets, remoteID: remoteID, reasoning: conversation.reasoning)
        return true
    }

    func prioritizeQueuedMessage(_ messageID: UUID, in id: UUID) {
        update(id) { item in
            guard var queue = item.messageQueue, let index = queue.firstIndex(where: { $0.id == messageID }) else { return }
            var entry = queue.remove(at: index); entry.urgent = true
            queue.insert(entry, at: 0); item.messageQueue = queue
        }
        dispatchQueuedMessage(id)
    }

    func removeQueuedMessage(_ messageID: UUID, in id: UUID) {
        update(id) { $0.messageQueue?.removeAll { $0.id == messageID } }
        dispatchQueuedMessage(id)
    }

    private func dispatchQueuedMessage(_ id: UUID) {
        guard (canSave || isTemporarySession), !temporaryClosed, !historyLoading, tasks[id] == nil,
              let item = conversation(id), !item.isBusy,
              !pendingStops.values.contains(where: { $0.conversationID == id }),
              let entry = item.messageQueue?.first else { return }
        // A failed submission may already exist remotely: resolve it before starting another turn.
        guard item.messages.last?.state != .failed else {
            update(id) { $0.queueError = "请先重试当前失败消息，再继续等待队列" }
            return
        }
        if !send(text: entry.text, attachments: entry.assets, conversationID: id, queuedMessageID: entry.id) {
            update(id) { $0.queueError = notice ?? "等待消息暂时无法发送，请稍后重试" }
        }
    }

    private func startSubmission(id: UUID, reply: AgentMessage, text: String, assets: [AgentAsset], remoteID: String, reasoning: String) {
        beginBackground(id)
        let version = UUID()
        taskVersions[id] = version
        tasks[id] = Task { [weak self] in
            guard let self else { return }
            defer { self.finishTask(id, version: version) }
            do {
                guard await self.persistDurably() else {
                    throw AgentClientError.message("消息保存失败，请重试")
                }
                let uploads = try assets.filter(\.isImage).map { asset -> CodexImageUpload in
                    let suffix = asset.mimeType == "image/png" ? ".png" : asset.mimeType == "image/webp" ? ".webp" : ".jpg"
                    return CodexImageUpload(data: try Data(contentsOf: asset.url), suffix: suffix)
                }
                let files = try assets.filter { !$0.isImage }.map {
                    CodexFileUpload(data: try Data(contentsOf: $0.url), filename: $0.filename)
                }
                let userMessageID = self.conversation(id)?.messages.last(where: { $0.role == .user && $0.requestID == reply.requestID })?.id
                guard isTemporarySession || userMessageID != nil else { throw AgentClientError.message("原始消息尚未加载，请重试") }
                let jobID = try await client.createJob(
                    prompt: text, uploads: uploads, conversationID: remoteID,
                    requestID: reply.requestID!, reasoning: reasoning, model: reply.model, files: files,
                    syncConversationID: isTemporarySession ? nil : id,
                    userMessageID: isTemporarySession ? nil : userMessageID,
                    assistantMessageID: isTemporarySession ? nil : reply.id
                )
                guard self.taskVersions[id] == version, self.conversation(id)?.pendingMessageID == reply.id else {
                    _ = try? await client.cancel(jobID: jobID)
                    return
                }
                self.update(id) { $0.pendingJobID = jobID }
                self.updateMessage(id, reply.id) {
                    $0.state = Task.isCancelled ? .reconnecting : .running
                    $0.phase = Task.isCancelled ? "正在恢复连接" : "请求已接收"
                    $0.remoteJobID = jobID
                }
                 
                 
                guard !Task.isCancelled else { return }
                await self.observe(id: id, jobID: jobID, messageID: reply.id)
            } catch {
                 
                 
                 
                guard self.taskVersions[id] == version,
                      self.conversation(id)?.pendingMessageID == reply.id else { return }
                self.updateMessage(id, reply.id) {
                    $0.state = .failed
                    $0.error = "消息提交中断，请检查网络后重试。" + (Task.isCancelled ? "" : error.localizedDescription)
                    $0.phase = ""
                    $0.completedAt = Date()
                }
                self.update(id) { $0.pendingJobID = nil; $0.pendingMessageID = nil }
            }
        }
    }

     
     
    @discardableResult
    func editAndResend(conversationID: UUID, messageID: UUID,
                       text: String, attachments: [AgentAsset]) async -> Bool {
#if DEBUG
        if Self.isEditingUITest {
             
            return send(text: text, attachments: attachments,
                        editingMessageID: messageID,
                        preparedRemoteID: UUID().uuidString,
                        preparedThreadID: "test-forked-thread")
        }
#endif
        guard canSave, let original = conversation(conversationID), !original.isBusy,
              let index = original.messages.firstIndex(where: { $0.id == messageID && $0.role == .user }),
              !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty else {
            notice = "当前无法编辑这条消息；原记录已保留"
            return false
        }
        guard await persistDurably() else { return false }
        let retained: [String]
        do {
            if isTemporarySession { retained = original.messages.prefix(index).filter { $0.role == .user }.map(\.text) }
            else { retained = try await messageDatabase.prompts(conversation: conversationID, before: messageID) }
        }
        catch { notice = "历史消息读取失败，原消息未修改"; return false }
        let originalText = original.messages[index].text
        let sourceRemoteID = original.remoteConversationID ?? original.id.uuidString
        let newRemoteID = UUID().uuidString
        do {
            let forkedThreadID = try await client.forkConversation(
                sourceID: sourceRemoteID, targetID: newRemoteID,
                retainedPrompts: retained, replacedPrompt: originalText)
            guard selectedID == conversationID,
                  let now = conversation(conversationID), !now.isBusy,
                  now.messages == original.messages,
                  (now.remoteConversationID ?? now.id.uuidString) == sourceRemoteID else {
                notice = "编辑过程中对话发生变化；原消息未修改"
                return false
            }
            return send(text: text, attachments: attachments, editingMessageID: messageID,
                        preparedRemoteID: newRemoteID, preparedThreadID: forkedThreadID)
        } catch {
            notice = "编辑未完成，旧消息已保留：" + error.localizedDescription
            return false
        }
    }

    func resumePending() {
        for item in conversations where !(item.messageQueue ?? []).isEmpty { dispatchQueuedMessage(item.id) }
        for item in conversations where item.pendingJobID != nil && tasks[item.id] == nil {
            guard let jobID = item.pendingJobID, let messageID = item.pendingMessageID else { continue }
            beginBackground(item.id)
            let version = UUID(); taskVersions[item.id] = version
            tasks[item.id] = Task { [weak self] in
                guard let self else { return }
                defer { self.finishTask(item.id, version: version) }
                await self.observe(id: item.id, jobID: jobID, messageID: messageID)
            }
        }
        Task { [weak self] in await self?.recoverInterruptedSubmissions() }
    }

     
     
    private func recoverInterruptedSubmissions() async {
        guard paginationReady, !recoveringSubmissions else { return }
        let candidates = conversations.compactMap { item -> (UUID, AgentMessage)? in
            guard tasks[item.id] == nil, item.pendingJobID == nil,
                  let reply = item.messages.last, reply.role == .assistant,
                  reply.state == .submitting, reply.remoteJobID == nil, reply.requestID != nil,
                  item.pendingMessageID == reply.id || Date().timeIntervalSince(reply.createdAt) > 120 else { return nil }
            return (item.id, reply)
        }
        guard !candidates.isEmpty else { return }
        recoveringSubmissions = true
        defer { recoveringSubmissions = false }
        let requests = Set(candidates.compactMap { $0.1.requestID?.lowercased() })
        var jobs: [String: String] = [:]
        var lookupFailure: String?
        do {
            var cursor = 0
            var finished = false
            let deadline = Date().addingTimeInterval(30)
            for _ in 0..<64 {
                try Task.checkCancellation()
                guard Date() < deadline else { throw AgentClientError.message("查询提交状态超时") }
                let response = try await client.sync(after: cursor)
                for change in response.changes where change.kind == "messages" && !change.deleted {
                    guard let data = change.data, data["role"]?.string == "assistant",
                          let requestID = data["requestId"]?.string?.lowercased(), requests.contains(requestID),
                          let jobID = data["remoteJobId"]?.string else { continue }
                    jobs[requestID] = jobID
                }
                if !response.hasMore || jobs.count == requests.count { finished = true; break }
                guard response.cursor > cursor else { throw AgentClientError.message("同步进度未推进") }
                cursor = response.cursor
            }
            if !finished { lookupFailure = "提交状态尚未确认，请检查网络后重试。" }
        } catch {
            lookupFailure = "提交状态暂无法确认，请检查网络后重试。"
        }
        for (id, original) in candidates {
            guard tasks[id] == nil, let item = conversation(id),
                  let reply = item.messages.first(where: { $0.id == original.id }),
                  reply.isWorking, reply.requestID == original.requestID else { continue }
            if let jobID = reply.remoteJobID ?? jobs[original.requestID!.lowercased()] {
                update(id) { $0.pendingJobID = jobID; $0.pendingMessageID = reply.id }
                updateMessage(id, reply.id) {
                    $0.remoteJobID = jobID; $0.state = .reconnecting
                    $0.phase = "正在恢复连接"; $0.error = nil
                }
            } else {
                updateMessage(id, reply.id) {
                    $0.state = .failed; $0.phase = ""; $0.completedAt = Date()
                    $0.error = lookupFailure ?? "消息未成功提交，请检查网络后重试。"
                }
                update(id) { $0.pendingJobID = nil; $0.pendingMessageID = nil }
            }
        }
        resumePending()
    }

    private func observe(id: UUID, jobID: String, messageID: UUID) async {
        for retry in 0..<3 {
            guard conversation(id)?.pendingJobID == jobID, !Task.isCancelled else { return }
            do {
                let after = conversation(id)?.lastEventID ?? 0
                for try await event in client.events(jobID: jobID, after: after) {
                    guard conversation(id)?.pendingJobID == jobID else { return }
                    if event.seq <= (conversation(id)?.lastEventID ?? 0) { continue }
                    for remote in ([event.asset].compactMap { $0 } + (event.assets ?? [])) {
                        let existing = conversation(id)?.messages.first { $0.id == messageID }?.assets ?? []
                        if existing.contains(where: { $0.remoteID == remote.id }) { continue }
                        updateMessage(id, messageID) { $0.phase = "接收结果中" }
                        let local = try await client.download(remote, inlineData: event.asset?.id == remote.id ? event.data : nil, dataMimeType: event.dataMimeType, dataFilename: event.dataFilename,
                            onProgress: { [weak self] count, total in
                                guard let self, self.conversation(id)?.pendingJobID == jobID else { return }
                                self.updateMessage(id, messageID) { $0.phase = "接收图片 \(count / 1024) / \(max(1, total / 1024)) KB" }
                            })
                        guard !Task.isCancelled, conversation(id)?.pendingJobID == jobID else { return }
                        updateMessage(id, messageID) { $0.assets.append(local) }
                        if local.isImage, let image = UIImage(contentsOfFile: local.url.path)?.normalizedCGImage {
                            if !isTemporarySession { await history?.collectGeneratedImage(local) }
                            let images = conversation(id)?.messages.first { $0.id == messageID }?.assets.filter(\.isImage) ?? []
                            update(id) { $0.activeImageID = images.count == 1 ? local.id : nil }
                        }
                        markAssistantUnread(id, messageID: messageID)
                    }
                    updateMessage(id, messageID) {
                        $0.error = nil
                        if let text = event.text { $0.text = text }
                        if let label = event.label { $0.phase = label }
                        if let reasoning = event.reasoning { $0.reasoning = reasoning }
                        if let raw = event.items { $0.rawResult = raw.pretty }
                        if let items = event.displayItems { $0.displayItems = items }
                        if let files = event.fileChanges { $0.fileChanges = files }
                        if let usage = event.usage { $0.usage = usage }
                        if event.isTerminal { $0.completedAt = Date() }
                        if event.type == "completed" { $0.state = .completed; $0.phase = ""; $0.completedAt = Date() }
                        else if ["failed", "interrupted"].contains(event.type) { $0.state = .failed; $0.error = event.error ?? "处理未完成"; $0.phase = "" }
                        else if event.type == "cancelled" { $0.state = .cancelled; $0.phase = "" }
                        else { $0.state = .running }
                    }
                    update(id) {
                        $0.lastEventID = event.seq
                        if let thread = event.threadId { $0.threadID = thread }
                        if event.isTerminal {
                            $0.pendingJobID = nil; $0.pendingMessageID = nil; $0.updatedAt = Date()
                        }
                    }
                    if event.isTerminal {
                        markAssistantUnread(id, messageID: messageID)
                        viewedLatest(id)
                        if event.type == "completed" { Task { [weak self] in await self?.refreshTitle(id) } }
                        return
                    }
                }
            } catch is CancellationError { return }
            catch {
                updateMessage(id, messageID) { $0.state = .reconnecting; $0.phase = "正在恢复连接" }
            }
             
            do { try await Task.sleep(for: .seconds(min(16, pow(2, Double(retry))))) } catch { return }
        }
        updateMessage(id, messageID) { $0.state = .reconnecting; $0.phase = "接收中断"; $0.error = "结果接收中断，点重新接收恢复；已生成的结果不会丢失" }
    }

    private func refreshTitle(_ id: UUID) async {
        guard !isTemporarySession else { return }
        guard let item = conversation(id), !item.titleIsManual, item.titleWasGenerated != true, !titleRequests.contains(id) else { return }
        titleRequests.insert(id)
        defer { titleRequests.remove(id) }
        let remoteID = item.remoteConversationID ?? id.uuidString
        guard let title = try? await client.title(conversationID: remoteID), !title.isEmpty else { return }
        update(id) {
            if !$0.titleIsManual && ($0.remoteConversationID ?? id.uuidString) == remoteID {
                $0.title = title
                $0.titleWasGenerated = true
            }
        }
    }
    func answerQuestions(_ questions: [AgentChoiceQuestion], answers: [String: String],
                         conversationID: UUID, messageID: UUID) async -> Bool {
        guard selectedID == conversationID, !historyLoading,
              !answeringQuestions.contains(conversationID),
              let item = conversation(conversationID), let message = item.messages.last,
              message.id == messageID, message.role == .assistant,
              let reply = AgentChoiceQuestion.reply(questions: questions, answers: answers),
              questions.allSatisfy({ AgentChoiceQuestion.parse(message.text).contains($0) }) else {
            notice = "这组选择已更新，请查看当前问题后重试"
            return false
        }
        answeringQuestions.insert(conversationID)
        defer { answeringQuestions.remove(conversationID) }

        // Reuse the authenticated stop/resume transport. Do not start a new turn
        // until the server has acknowledged stopping the current request.
        if item.isBusy {
            await stop(conversationID)
        } else if let requestID = message.requestID, let intent = pendingStops[requestID] {
            await confirmStop(intent)
        }
        if let requestID = message.requestID, pendingStops[requestID] != nil { return false }
        guard selectedID == conversationID, !historyLoading,
              let latest = conversation(conversationID), !latest.isBusy,
              latest.messages.last?.id == messageID else {
            notice = "会话已变化，选择尚未提交，请回到原问题重试"
            return false
        }
        // The answer is its own message, never the user's unfinished draft or files.
        let draft = latest.draft
        let assets = latest.draftAssets
        guard send(text: reply) else {
            if notice == nil { notice = "暂时无法提交选择，请重试" }
            return false
        }
        update(conversationID) { $0.draft = draft; $0.draftAssets = assets }
        return true
    }

    func stop(_ id: UUID) async {
        guard let item = conversation(id), let messageID = item.pendingMessageID,
              let message = item.messages.first(where: { $0.id == messageID }), let requestID = message.requestID else { return }
        let intent = StopIntent(conversationID: id, messageID: messageID, requestID: requestID, jobID: item.pendingJobID)
        pendingStops[requestID] = intent
         
        tasks.removeValue(forKey: id)?.cancel(); taskVersions.removeValue(forKey: id)
        endBackground(id)
        updateMessage(id, messageID) { $0.state = .cancelled; $0.phase = "正在确认停止…"; $0.error = nil }
        update(id) { $0.pendingJobID = nil; $0.pendingMessageID = nil }
        await confirmStop(intent)
    }
    private func confirmStop(_ intent: StopIntent) async {
        do {
            let status = try await client.cancel(requestID: intent.requestID)
            pendingStops.removeValue(forKey: intent.requestID)
            updateMessage(intent.conversationID, intent.messageID) {
                $0.state = .cancelled
                $0.phase = status == "completed" ? "已停止接收" : "已停止"
                $0.error = nil
            }
            persist()
            dispatchQueuedMessage(intent.conversationID)
        } catch {
            updateMessage(intent.conversationID, intent.messageID) {
                $0.state = .cancelled; $0.phase = "已停止接收"
                $0.error = "服务器停止尚未确认，恢复连接后将重试"
            }
            notice = "本地已停止接收；服务器停止尚未确认，请检查网络"
        }
    }
    func retryDelivery(_ id: UUID, messageID: UUID? = nil) {
        guard tasks[id] == nil, let item = conversation(id),
              let reply = item.messages.last, reply.role == .assistant,
              messageID == nil || messageID == reply.id, reply.canRetryConnection else { return }
        if let jobID = item.pendingJobID ?? reply.remoteJobID {
            update(id) { $0.pendingJobID = jobID; $0.pendingMessageID = reply.id }
            updateMessage(id, reply.id) { $0.state = .reconnecting; $0.error = nil; $0.phase = "正在恢复连接" }
            resumePending()
            return
        }
        guard !capabilities.hasOnlyHiddenModels else {
            notice = "当前没有可用模型，请刷新后重试"
            return
        }
        guard reply.requestID != nil,
              let user = item.messages.last(where: { $0.role == .user && $0.requestID == reply.requestID })
                ?? item.messages.dropLast().last(where: { $0.role == .user }) else { return }
        update(id) { $0.pendingMessageID = reply.id; $0.lastEventID = 0 }
        updateMessage(id, reply.id) { $0.state = .submitting; $0.error = nil; $0.phase = "重新发送中" }
         
        startSubmission(id: id, reply: reply, text: user.text, assets: user.assets,
                        remoteID: item.remoteConversationID ?? id.uuidString,
                        reasoning: reply.reasoning ?? item.reasoning)
    }
    func delete(_ id: UUID) async {
        if isTemporarySession {
            await stop(id)
            conversations.removeAll { $0.id == id }
            selectedID = conversations.first?.id
            if conversations.isEmpty && !temporaryClosed { _ = newConversation() }
            return
        }
        guard !historyLoading else { return }
        if conversation(id)?.pendingJobID != nil {
            await stop(id)
            guard conversation(id)?.pendingJobID == nil else { return }
        }
        guard !pendingStops.values.contains(where: { $0.conversationID == id }) else { notice = "请先确认服务器已停止，再删除会话"; return }
        tasks[id]?.cancel(); tasks[id] = nil; taskVersions.removeValue(forKey: id)
        guard await persistDurably() else { return }
        do {
            let ids = try await messageDatabase.ids(conversation: id)
            try await synchronizer.deleteConversation(id, messages: ids)
            try await messageDatabase.delete(conversation: id)
        } catch { notice = "删除未完成，历史记录已保留"; return }
        conversations.removeAll { $0.id == id }
        if selectedID == id { selectedID = conversations.first?.id }
        if conversations.isEmpty { _ = newConversation() }
        persist()
         
    }
    @discardableResult
    func createProject(name: String) -> UUID? {
        let clean = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return nil }
        let project = AgentProject(name: String(clean.prefix(100))); projects.append(project); persist(); return project.id
    }
    func renameProject(_ id: UUID, name: String) {
        let clean = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty, let i = projects.firstIndex(where: { $0.id == id }) else { return }
        projects[i].name = String(clean.prefix(100)); persist()
    }
    func setProject(_ project: UUID?, conversation id: UUID) { update(id) { $0.projectID = project } }
    func applySync(_ change: AgentSyncChange, id: UUID, assets: [AgentAsset]) async throws {
        guard !isTemporarySession else { return }
        if change.deleted {
            guard await persistDurably() else { throw NSError(domain: "ShiyanMessages", code: 2) }
            if change.kind == "projects" { projects.removeAll { $0.id == id }; for i in conversations.indices where conversations[i].projectID == id { conversations[i].projectID = nil } }
            else if change.kind == "conversations" {
                try await messageDatabase.delete(conversation: id)
                tasks.removeValue(forKey: id)?.cancel(); taskVersions.removeValue(forKey: id); endBackground(id)
                conversations.removeAll { $0.id == id }
                if selectedID == id { selectedID = conversations.first?.id ?? blank.id }
            } else if change.kind == "messages" {
                try await messageDatabase.delete(message: id)
                stagedMessages.removeValue(forKey: id)
                for i in conversations.indices {
                    conversations[i].messages.removeAll { $0.id == id }
                    conversations[i].unreadMessageIDs?.remove(id.uuidString.lowercased())
                    reconcileUnreadState(&conversations[i])
                }
            }
            return
        }
        guard let d = change.data else { return }
        if change.kind == "projects" {
            var value = projects.first(where: { $0.id == id }) ?? AgentProject(id: id, name: d["name"]?.string ?? "项目")
            value.name = d["name"]?.string ?? value.name; value.createdAt = AgentSyncCoordinator.date(d["createdAt"]) ?? value.createdAt
            value.isPinned = d["isPinned"]?.boolean ?? value.isPinned
            if let i = projects.firstIndex(where: { $0.id == id }) { projects[i] = value } else { projects.append(value) }
        } else if change.kind == "conversations" {
            var value = conversation(id) ?? AgentConversation(id: id)
            value.title = d["title"]?.string ?? value.title; value.titleIsManual = d["titleIsManual"]?.boolean ?? value.titleIsManual
            value.isPinned = d["isPinned"]?.boolean ?? value.isPinned; value.projectID = d["projectId"]?.string.flatMap(UUID.init(uuidString:))
            value.createdAt = AgentSyncCoordinator.date(d["createdAt"]) ?? value.createdAt; value.updatedAt = AgentSyncCoordinator.date(d["updatedAt"]) ?? value.updatedAt
            value.remoteConversationID = d["remoteConversationId"]?.string ?? value.remoteConversationID
            value.threadID = d["threadId"]?.string ?? value.threadID; value.syncMetadata = d
            if let i = conversations.firstIndex(where: { $0.id == id }) { conversations[i] = value } else { conversations.append(value) }
        } else if change.kind == "messages", let conversationID = d["conversationId"]?.string.flatMap(UUID.init(uuidString:)), let i = conversations.firstIndex(where: { $0.id == conversationID }), let role = AgentMessage.Role(rawValue: d["role"]?.string ?? "") {
            let cached = conversations[i].messages.first(where: { $0.id == id }) ?? stagedMessages[id]?.1
            let prior: AgentMessage?
            if let cached { prior = cached } else { prior = try await messageDatabase.message(id) }
            guard let i = conversations.firstIndex(where: { $0.id == conversationID }) else { return }
            messageWindowVersions[conversationID, default: 0] += 1
            var message = prior ?? AgentMessage(id: id, role: role, text: "")
            message.text = d["text"]?.string ?? message.text; message.assets = assets; message.syncMetadata = d
            message.createdAt = AgentSyncCoordinator.date(d["createdAt"]) ?? message.createdAt; message.completedAt = AgentSyncCoordinator.date(d["completedAt"])
            let rawState = d["state"]?.string ?? "completed"
            message.state = AgentMessage.State(rawValue: rawState) ?? (["queued", "pending", "thinking"].contains(rawState) ? .running : .failed)
            message.phase = message.isWorking ? (d["phase"]?.string ?? "") : ""; message.error = d["error"]?.string
            if d["rawResult"] != nil { message.rawResult = d["rawResult"]?.string }
            if let value = d["displayItems"] { message.displayItems = value.array }
            if let value = d["fileChanges"] { message.fileChanges = value.array }
            if let value = d["usage"] { message.usage = value.object }
            message.requestID = d["requestId"]?.string; message.remoteJobID = d["remoteJobId"]?.string
            message.reasoning = d["reasoning"]?.string; message.model = d["model"]?.string
             
            if let previous = prior, previous.role == .assistant, previous.state == .completed,
               message.isWorking {
                let sameJob: Bool
                if let oldJob = previous.remoteJobID, let newJob = message.remoteJobID {
                    sameJob = oldJob == newJob
                } else {
                    sameJob = previous.requestID != nil && previous.requestID == message.requestID
                }
                if sameJob { message = previous }
            }
             
             
             
            if let previous = prior, previous.role == .assistant,
               [.failed, .cancelled].contains(previous.state), message.state == .submitting,
               message.remoteJobID == nil, previous.requestID != nil,
               previous.requestID == message.requestID, tasks[conversationID] == nil {
                message = previous
            }
            stagedMessages[id] = (conversationID, message)
            conversations[i].storedHasSentMessage = conversations[i].hasSentMessage || role == .user
            if let j = conversations[i].messages.firstIndex(where: { $0.id == id }) {
                conversations[i].messages[j] = message
            } else if conversationID == selectedID || conversations[i].isBusy {
                if prior == nil && !viewingLatest { windowDepth[conversationID, default: AgentMessageDatabase.pageSize] += 1 }
                conversations[i].messages.append(message)
                conversations[i].messages = Array(AgentMessageOrder.ordered(conversations[i].messages).suffix(windowDepth[conversationID] ?? AgentMessageDatabase.pageSize))
            }
            recordSyncedUnread(at: i, previous: prior, message: message)
            if conversations[i].pendingMessageID == id && !message.isWorking {
                conversations[i].pendingMessageID = nil; conversations[i].pendingJobID = nil
            }
            if message.state == .submitting, message.remoteJobID == nil,
               tasks[conversationID] == nil, Date().timeIntervalSince(message.createdAt) > 120 {
                Task { [weak self] in await self?.recoverInterruptedSubmissions() }
            }
        }
    }
    private func beginBackground(_ id: UUID) {
        guard backgroundTokens[id] == nil else { return }
        backgroundTokens[id] = UIApplication.shared.beginBackgroundTask(withName: "Shiyan event delivery") { [weak self] in
            Task { @MainActor in
                self?.tasks[id]?.cancel()
                if let token = self?.backgroundTokens.removeValue(forKey: id), token != .invalid { UIApplication.shared.endBackgroundTask(token) }
            }
        }
    }
    private func finishTask(_ id: UUID, version: UUID) {
        guard taskVersions[id] == version else { return }
        tasks[id] = nil; taskVersions.removeValue(forKey: id)
        endBackground(id)
        dispatchQueuedMessage(id)
    }
    private func endBackground(_ id: UUID) {
        if let token = backgroundTokens.removeValue(forKey: id), token != .invalid { UIApplication.shared.endBackgroundTask(token) }
    }
    private static func provisionalTitle(_ text: String) -> String {
        let cleaned = text.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespacesAndNewlines)
        return cleaned.isEmpty ? "图片对话" : String(cleaned.prefix(20))
    }
}


extension AgentStore {
    func closeTemporarySession() {
        guard isTemporarySession, !temporaryClosed else { return }
        temporaryClosed = true; canSave = false
        let requests = Set(conversations.compactMap { c in
            c.messages.first(where: { $0.id == c.pendingMessageID })?.requestID
        } + Array(pendingStops.keys))
        for task in tasks.values { task.cancel() }
        tasks.removeAll(); taskVersions.removeAll()
        for id in Array(backgroundTokens.keys) { endBackground(id) }
        persistenceTask?.cancel(); bootstrap?.cancel(); windowTask?.cancel(); readAcknowledgmentTask?.cancel()
        conversations.removeAll(); selectedID = nil; blank = AgentConversation()
        stagedMessages.removeAll(); localDirtyMessages.removeAll(); removedMessages.removeAll()
        pendingStops.removeAll(); readReceipts.removeAll()
        Self.temporaryStores.removeAll { $0.value == nil || $0.value === self }
        let service = client
        Task { for request in requests { _ = try? await service.cancel(requestID: request) } }
    }
}
