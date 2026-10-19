import Foundation
import Combine

@MainActor
final class KnowledgeStore: ObservableObject {
    @Published private(set) var spaces: [KnowledgeSpace] = []
    @Published private(set) var bases: [KnowledgeBase] = []
    @Published private(set) var documents: [KnowledgeDocument] = []
    @Published private(set) var graph: KnowledgeGraph?
    @Published private(set) var messages: [KnowledgeChatMessage] = []
    @Published private(set) var tasks: [KnowledgeTask] = []
    @Published private(set) var selectedSpaceID: String?
    @Published private(set) var selectedBaseID: String?
    @Published private(set) var graphLoading = false
    @Published private(set) var graphError: String?
    @Published private(set) var loading = false
    @Published private(set) var submitting = false
    @Published private(set) var uploading = false
    @Published private(set) var mutating = false
    @Published private(set) var retryQuestion: String?
    @Published var error: String?
    private var conversationID: String?
    private var navigationID = UUID()
    private var queryTask: Task<Void, Never>?
    private var graphTask: Task<Void, Never>?
    private var graphRequestID = UUID()
    private var watchedTasks = Set<String>()
    private let client = CodexClient.shared
    private let accountGeneration = ShiyanAccountStorage.generation

    var selectedSpace: KnowledgeSpace? { spaces.first { $0.id == selectedSpaceID } }
    var selectedBase: KnowledgeBase? { bases.first { $0.id == selectedBaseID } }
    var busy: Bool { loading || submitting || uploading || mutating }

    func load() async {
        guard !loading else { return }
        loading = true; error = nil
        defer { loading = false }
        do {
            let values = try await client.knowledgeSpaces()
            guard accountGeneration == ShiyanAccountStorage.generation, !Task.isCancelled else { return }
            spaces = values
            let id = spaces.first(where: { $0.id == selectedSpaceID })?.id ?? spaces.first?.id
            if let id { try await loadSpace(id) }
            else { resetSelection() }
        } catch { report(error) }
    }

    func selectSpace(_ id: String) async {
        guard !busy else { return }
        loading = true; error = nil
        defer { loading = false }
        do { try await loadSpace(id) } catch { report(error) }
    }

    private func loadSpace(_ id: String) async throws {
        queryTask?.cancel(); navigationID = UUID()
        cancelGraph()
        selectedSpaceID = id; selectedBaseID = nil
        documents = []; graph = nil; messages = []; tasks = []; watchedTasks = []; conversationID = nil
        let navigation = navigationID
        let values = try await client.knowledgeBases(spaceID: id)
        guard isCurrent(navigation) else { return }
        bases = values
        if let first = bases.first { try await loadBase(first.id) }
    }

    func selectBase(_ id: String) async {
        guard !busy else { return }
        loading = true; error = nil
        defer { loading = false }
        do { try await loadBase(id) } catch { report(error) }
    }

    private func loadBase(_ id: String) async throws {
        queryTask?.cancel(); navigationID = UUID()
        cancelGraph()
        selectedBaseID = id; documents = []; graph = nil; messages = []; tasks = []; watchedTasks = []; conversationID = nil
        try await refreshBase(includeHistory: true)
    }

    func refresh() async {
        guard !busy else { return }
        guard selectedBaseID != nil else { await load(); return }
        loading = true; error = nil
        defer { loading = false }
        do { try await refreshBase(includeHistory: true) } catch { report(error) }
    }

    private func refreshBase(includeHistory: Bool) async throws {
        guard let id = selectedBaseID else { return }
        let navigation = navigationID
        async let docs = client.knowledgeDocuments(baseID: id)
        async let active = client.knowledgeActiveTask(baseID: id)
        let values = try await (docs, active)
        guard isCurrent(navigation) else { return }
        documents = values.0
        if let task = values.1, !tasks.contains(where: { $0.id == task.id }) { tasks.append(task); watchedTasks.insert(task.id) }
        refreshKnowledge(force: true)
        if includeHistory {
            let history = try await client.knowledgeHistory(baseID: id)
            guard isCurrent(navigation) else { return }
            messages = history.messages; conversationID = history.conversation_id
        }
    }

    func refreshKnowledge(force: Bool = false) {
        guard let id = selectedBaseID, !graphLoading || force else { return }
        graphTask?.cancel()
        let navigation = navigationID, request = UUID()
        graphRequestID = request; graphLoading = true; graphError = nil
        graphTask = Task {
            defer { if navigation == navigationID, request == graphRequestID { graphLoading = false } }
            do {
                let value = try await client.knowledgeGraph(baseID: id)
                guard isCurrent(navigation), request == graphRequestID else { return }
                graph = value
            } catch {
                guard isCurrent(navigation), request == graphRequestID, !(error is CancellationError) else { return }
                graphError = message(for: error, timeout: "知识内容加载超时，请重试。文档和问答仍可使用。")
            }
        }
    }

    private func cancelGraph() {
        graphRequestID = UUID()
        graphTask?.cancel(); graphTask = nil
        graphLoading = false; graphError = nil
    }

    private func isCurrent(_ navigation: UUID) -> Bool {
        navigation == navigationID && accountGeneration == ShiyanAccountStorage.generation && !Task.isCancelled
    }

    func createSpace(name: String) async -> Bool {
        guard !busy else { return false }
        mutating = true; error = nil
        defer { mutating = false }
        do {
            let space = try await client.knowledgeCreateSpace(name: name)
            spaces = try await client.knowledgeSpaces()
            try await loadSpace(space.id)
            return true
        } catch { report(error); return false }
    }

    func saveBase(name: String, description: String, editing: Bool) async -> Bool {
        guard !busy, let spaceID = selectedSpaceID else { return false }
        mutating = true; error = nil
        defer { mutating = false }
        do {
            let base: KnowledgeBase
            if editing, let id = selectedBaseID { base = try await client.knowledgeUpdateBase(id: id, name: name) }
            else { base = try await client.knowledgeCreateBase(spaceID: spaceID, name: name, description: description) }
            bases = try await client.knowledgeBases(spaceID: spaceID)
            try await loadBase(base.id)
            return true
        } catch { report(error); return false }
    }

    func deleteBase() async {
        guard !busy, let id = selectedBaseID, let spaceID = selectedSpaceID else { return }
        mutating = true; error = nil
        defer { mutating = false }
        do {
            try await client.knowledgeDeleteBase(id: id)
            try await loadSpace(spaceID)
        } catch { report(error) }
    }

    func deleteDocument(_ document: KnowledgeDocument) async {
        guard !busy else { return }
        mutating = true; error = nil
        defer { mutating = false }
        do {
            try await client.knowledgeDeleteDocument(id: document.id)
            let removedTasks = tasks.filter { $0.document_id == document.id }.map(\.id)
            watchedTasks.subtract(removedTasks)
            tasks.removeAll { $0.document_id == document.id }
            try await refreshBase(includeHistory: false)
        } catch { report(error) }
    }

    func upload(_ urls: [URL]) async {
        guard !busy, let id = selectedBaseID else { return }
        uploading = true; error = nil
        defer { uploading = false }
        do {
            for url in urls {
                try Task.checkCancellation()
                let access = url.startAccessingSecurityScopedResource()
                defer { if access { url.stopAccessingSecurityScopedResource() } }
                let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                guard url.pathExtension.lowercased() == "pdf" else { throw AgentClientError.message("请选择 PDF 文件") }
                guard size <= 50 * 1024 * 1024 else { throw AgentClientError.message("PDF 不能超过 50 MB") }
                let data = try await Task.detached(priority: .utility) { try Data(contentsOf: url, options: .mappedIfSafe) }.value
                guard data.starts(with: Data("%PDF-".utf8)) else { throw AgentClientError.message("这不是有效的 PDF 文件") }
                let result = try await client.knowledgeUpload(baseID: id, filename: url.lastPathComponent, data: data)
                watchedTasks.insert(result.task_id)
            }
            try await refreshBase(includeHistory: false)
        } catch { report(error) }
    }

    func poll() async {
        guard !watchedTasks.isEmpty, !loading, !mutating else { return }
        let navigation = navigationID
        do {
            var completed = false
            for id in Array(watchedTasks) {
                let task = try await client.knowledgeTask(id: id)
                guard isCurrent(navigation) else { return }
                if let index = tasks.firstIndex(where: { $0.id == id }) { tasks[index] = task } else { tasks.append(task) }
                if task.isFinished {
                    watchedTasks.remove(id); completed = true
                    if let message = task.error, !message.isEmpty { error = message }
                }
            }
            if completed { try await refreshBase(includeHistory: false) }
        } catch { report(error) }
    }

    func ask(_ question: String) {
        guard !busy, let id = selectedBaseID else { return }
        let text = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.count <= 4000 else { return }
        let history = messages.suffix(20).map { ["role": $0.type == "user" ? "user" : "assistant", "content": $0.content] }
        let navigation = navigationID
        let previousMessages = messages
        submitting = true; error = nil; retryQuestion = nil
        messages.append(.init(type: "user", content: text))
        queryTask = Task {
            defer { if navigation == navigationID { submitting = false } }
            do {
                let answer = try await client.knowledgeAsk(baseID: id, question: text, conversationID: conversationID, history: history)
                guard isCurrent(navigation) else { return }
                conversationID = answer.conversation_id
                messages.append(.init(type: "ai", content: answer.answer, citations: answer.citations, status: answer.status, mode: answer.mode))
            } catch {
                guard isCurrent(navigation) else { return }
                messages = previousMessages
                if !(error is CancellationError) { retryQuestion = text }
                report(error, timeout: "回答等待超时，问题已保留，可以重试。")
            }
        }
    }

    func clearHistory() async {
        guard !busy, let id = selectedBaseID else { return }
        mutating = true; error = nil
        defer { mutating = false }
        do { try await client.knowledgeClearHistory(baseID: id); messages = []; conversationID = nil } catch { report(error) }
    }

    // Removal also occurs on logout/account-generation changes at ShiyanAccountRoot.
    func stop() {
        navigationID = UUID()
        queryTask?.cancel()
        queryTask = nil
        cancelGraph()
        if accountGeneration == ShiyanAccountStorage.generation {
            if submitting, let pending = messages.last, pending.type == "user" {
                messages.removeLast()
                retryQuestion = pending.content
            }
            submitting = false
            return
        }
        watchedTasks = []
        spaces = []; bases = []; documents = []; graph = nil
        messages = []; tasks = []; conversationID = nil
        selectedSpaceID = nil; selectedBaseID = nil
        loading = false; submitting = false; uploading = false; mutating = false
        retryQuestion = nil; error = nil
    }

    func documentDetail(_ id: String) async throws -> KnowledgeDocument { try await client.knowledgeDocument(id: id) }
    private func resetSelection() { cancelGraph(); selectedSpaceID = nil; selectedBaseID = nil; bases = []; documents = []; graph = nil; messages = []; tasks = []; watchedTasks = [] }
    private func message(for error: Error, timeout: String) -> String {
        let value = error as NSError
        if value.domain == NSURLErrorDomain, value.code == URLError.timedOut.rawValue { return timeout }
        return error.localizedDescription
    }
    private func report(_ error: Error, timeout: String = "连接超时，请重试。") {
        if !(error is CancellationError) { self.error = message(for: error, timeout: timeout) }
    }
}
