import SwiftUI
import Combine

nonisolated struct ShiyanMemory: Identifiable, Decodable, Sendable {
    let id: String
    let category: String
    let content: String
    let scope: String
    var projectId: String?
    var conversationId: String?
    let source: String
    let createdAt: Double
    let updatedAt: Double
    var expiresAt: Double?
    let revision: Int

    var categoryTitle: String {
        switch category {
        case "preference": "偏好"
        case "profile": "背景"
        case "project": "长期项目"
        default: "相关细节"
        }
    }
    var sourceTitle: String {
        switch source {
        case "manual": "手动添加"
        case "dots": "Dots"
        default: "聊天"
        }
    }
    var scopeTitle: String {
        switch scope {
        case "project": "当前项目"
        case "conversation": "当前会话"
        default: "所有会话"
        }
    }
}

nonisolated struct ShiyanMemoryListing: Decodable, Sendable {
    let ok: Bool
    let enabled: Bool
    let memories: [ShiyanMemory]
    let revision: Int
}

nonisolated struct ShiyanMemoryConflict: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

@MainActor
private final class ShiyanMemoryStore: ObservableObject {
    @Published private(set) var enabled = true
    @Published private(set) var memories: [ShiyanMemory] = []
    @Published private(set) var isLoading = false
    @Published private(set) var isMutating = false
    @Published var error: String?
    private var loadVersion = 0

    func refresh() async {
        loadVersion += 1
        let version = loadVersion
        isLoading = true
        defer { if version == loadVersion { isLoading = false } }
        do {
            let result = try await CodexClient.shared.memoryListing()
            guard version == loadVersion else { return }
            enabled = result.enabled
            memories = result.memories.sorted { $0.updatedAt > $1.updatedAt }
            error = nil
        } catch {
            guard version == loadVersion else { return }
            self.error = error.localizedDescription
        }
    }

    func performMutation(_ operation: @MainActor () async throws -> Void) async throws {
        guard !isMutating else { throw AgentClientError.message("正在保存，请稍后重试") }
        isMutating = true
        error = nil
        defer { isMutating = false }
        do {
            try await operation()
            await refresh()
        } catch {
            self.error = error.localizedDescription
            throw error
        }
    }

    func mutate(_ operation: @MainActor () async throws -> Void) async -> Bool {
        do { try await performMutation(operation); return true }
        catch { return false }
    }
}

private struct ShiyanMemoryEditorItem: Identifiable {
    let id = UUID()
    var memory: ShiyanMemory?
}

struct MemoryView: View {
    let topInset: CGFloat
    let bottomInset: CGFloat
    let hasUnread: Bool
    let onSidebar: () -> Void
    let onBack: () -> Void
    @StateObject private var store = ShiyanMemoryStore()
    @Environment(\.scenePhase) private var scenePhase
    @State private var editor: ShiyanMemoryEditorItem?
    @State private var deleteTarget: ShiyanMemory?
    @State private var confirmingClear = false
    @State private var query = ""

    private var background: Color { Color(uiColor: .systemGroupedBackground) }
    private var cardBackground: Color { Color(uiColor: .secondarySystemGroupedBackground) }
    private var busy: Bool { store.isLoading || store.isMutating }
    private var filteredMemories: [ShiyanMemory] {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return store.memories }
        return store.memories.filter {
            [$0.content, $0.categoryTitle, $0.sourceTitle, $0.scopeTitle]
                .contains { $0.localizedStandardContains(text) }
        }
    }

    var body: some View {
        ZStack(alignment: .top) {
            background.ignoresSafeArea()
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 24) {
                    Text("拾燕会选择性保留聊天中的偏好、背景和长期项目信息，并随后续聊天更新。")
                        .font(.subheadline).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)

                    VStack(alignment: .leading, spacing: 10) {
                        Toggle("使用记忆", isOn: Binding(
                            get: { store.enabled },
                            set: { value in Task { _ = await store.mutate { try await CodexClient.shared.setMemoryEnabled(value) } } }
                        ))
                        .font(.body.weight(.medium))
                        .disabled(busy)
                        .accessibilityIdentifier("memory-enabled")
                        Text(store.enabled ? "自动整理重要信息，用于个性化回复。" : "已暂停自动整理和使用，已保存的记忆仍可管理。")
                            .font(.footnote).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(20)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(cardBackground, in: RoundedRectangle(cornerRadius: 16, style: .continuous))

                    if let error = store.error {
                        VStack(alignment: .leading, spacing: 12) {
                            Text(error).font(.subheadline).foregroundStyle(.secondary)
                            Button("重新加载") { Task { await store.refresh() } }.disabled(busy)
                        }
                        .padding(20)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(cardBackground, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                        .accessibilityIdentifier("memory-error")
                    }

                    VStack(alignment: .leading, spacing: 12) {
                        HStack(spacing: 12) {
                            HStack(spacing: 10) {
                                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                                    .accessibilityHidden(true)
                                TextField("搜索记忆", text: $query)
                                    .font(.body)
                                    .textInputAutocapitalization(.never)
                                    .autocorrectionDisabled()
                                    .accessibilityIdentifier("memory-search")
                            }
                            .padding(.horizontal, 16)
                            .frame(minHeight: ShiyanPreviewLayout.controlDiameter)
                            .background(cardBackground, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                            AgentRoundButton(symbol: "plus", label: "添加记忆", diameter: ShiyanPreviewLayout.controlDiameter) {
                                editor = ShiyanMemoryEditorItem()
                            }
                            .disabled(busy)
                            .accessibilityIdentifier("memory-add")
                        }
                        HStack(alignment: .firstTextBaseline, spacing: 12) {
                            Text("已保存的记忆").font(.footnote.weight(.medium))
                            Spacer(minLength: 8)
                            if busy { ProgressView().controlSize(.small).accessibilityLabel("正在加载记忆") }
                            else { Text(query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "\(store.memories.count) 条" : "\(filteredMemories.count) / \(store.memories.count) 条").font(.footnote) }
                        }
                        .foregroundStyle(.secondary)
                    }

                    LazyVStack(alignment: .leading, spacing: 12) {
                        if store.memories.isEmpty && !store.isLoading && store.error == nil {
                            Text("还没有保存的记忆。日常聊天中的重要信息会自动整理，你也可以手动添加。")
                                .font(.subheadline).foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity, alignment: .leading).padding(20)
                                .background(cardBackground, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                                .accessibilityIdentifier("memory-empty")
                        }
                        if !store.memories.isEmpty && filteredMemories.isEmpty {
                            Text("没有找到匹配的记忆")
                                .font(.subheadline).foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity, alignment: .leading).padding(20)
                                .background(cardBackground, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                        }
                        ForEach(filteredMemories) { memory in memoryCard(memory) }
                    }
                }
                .padding(.horizontal, 20)
                .padding(.top, topInset + 98)
                .padding(.bottom, bottomInset + 28)
            }
            .scrollIndicators(.hidden)
            .refreshable { await store.refresh() }

            ShiyanFeatureHeader(page: .settings, topInset: topInset, hasUnread: hasUnread,
                                onSidebar: onSidebar, onBack: onBack, backLabel: "返回设置") {
                ShiyanMoreMenu {
                    Button("添加记忆", systemImage: "plus") { editor = ShiyanMemoryEditorItem() }.disabled(busy)
                    Button("刷新", systemImage: "arrow.clockwise") { Task { await store.refresh() } }.disabled(busy)
                    Divider()
                    Button("清空记忆", systemImage: "trash", role: .destructive) { confirmingClear = true }
                        .disabled(busy || store.memories.isEmpty)
                }
            }
            .overlay(alignment: .top) {
                Text("记忆").font(.system(size: 18, weight: .semibold))
                    .frame(height: ShiyanPreviewLayout.controlDiameter)
                    .padding(.top, topInset + 3)
                    .allowsHitTesting(false)
            }
            .background(background)
        }
        .foregroundStyle(.primary)
        .accessibilityIdentifier("memory-page")
        .task { await store.refresh() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await store.refresh() } }
        }
        .sheet(item: $editor) { item in
            ShiyanMemoryEditor(memory: item.memory) { current, content, category in
                try await store.performMutation {
                    if let current { try await CodexClient.shared.updateMemory(current, content: content) }
                    else { try await CodexClient.shared.addMemory(content: content, category: category) }
                }
            }
        }
        .alert("删除这条记忆？", isPresented: Binding(
            get: { deleteTarget != nil }, set: { if !$0 { deleteTarget = nil } }
        )) {
            Button("取消", role: .cancel) { deleteTarget = nil }
            Button("删除", role: .destructive) {
                if let memory = deleteTarget {
                    deleteTarget = nil
                    Task { _ = await store.mutate { try await CodexClient.shared.deleteMemory(memory.id) } }
                }
            }
        } message: { Text("删除后，这条信息将不再用于个性化回复。") }
        .alert("清空全部记忆？", isPresented: $confirmingClear) {
            Button("取消", role: .cancel) { }
            Button("清空", role: .destructive) { Task { _ = await store.mutate { try await CodexClient.shared.clearMemories() } } }
        } message: { Text("已保存的记忆会被删除，聊天记录会保留。") }
    }

    private func memoryCard(_ memory: ShiyanMemory) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                Text(memory.categoryTitle).font(.footnote.weight(.medium)).foregroundStyle(.secondary)
                Spacer(minLength: 8)
                ShiyanMoreMenu {
                    Button("编辑", systemImage: "pencil") { editor = ShiyanMemoryEditorItem(memory: memory) }
                    Button("删除", systemImage: "trash", role: .destructive) { deleteTarget = memory }
                }
                .disabled(busy)
                .accessibilityLabel("记忆操作")
            }
            Text(memory.content).font(.body).textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text("\(memory.sourceTitle) · \(memory.scopeTitle) · \(Date(timeIntervalSince1970: memory.updatedAt / 1000).formatted(date: .abbreviated, time: .shortened))")
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(cardBackground, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .accessibilityIdentifier("memory-item-\(memory.id)")
    }
}

private struct ShiyanMemoryEditor: View {
    let save: (ShiyanMemory?, String, String) async throws -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var editBase: ShiyanMemory?
    @State private var content: String
    @State private var category: String
    @State private var saving = false
    @State private var resolving = false
    @State private var failure: String?
    @State private var conflict = false
    @State private var latest: ShiyanMemory?
    @State private var latestLoaded = false
    @State private var latestError: String?
    private let contentLimit = 1200

    init(memory: ShiyanMemory?, save: @escaping (ShiyanMemory?, String, String) async throws -> Void) {
        self.save = save
        _editBase = State(initialValue: memory)
        _content = State(initialValue: memory?.content ?? "")
        _category = State(initialValue: memory?.category ?? "preference")
    }

    private var trimmedContent: String { content.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var contentLength: Int { trimmedContent.utf16.count }
    private var busy: Bool { saving || resolving }
    private var canSave: Bool { !busy && !conflict && contentLength > 0 && contentLength <= contentLimit }

    var body: some View {
        NavigationStack {
            Form {
                Section("内容") {
                    TextEditor(text: $content)
                        .frame(minHeight: 160)
                        .accessibilityIdentifier("memory-editor-content")
                    HStack {
                        if contentLength > contentLimit { Text("内容超出长度限制，请缩短后保存") }
                        Spacer()
                        Text("\(contentLength) / \(contentLimit)")
                    }
                    .font(.caption)
                    .foregroundStyle(contentLength > contentLimit ? Color.red : Color.secondary)
                    .accessibilityIdentifier("memory-editor-length")
                }
                if editBase == nil {
                    Section {
                        Picker("分类", selection: $category) {
                            Text("偏好").tag("preference")
                            Text("背景").tag("profile")
                            Text("长期项目").tag("project")
                            Text("相关细节").tag("context")
                        }
                    }
                }
                if let failure {
                    Section {
                        Text(failure).font(.subheadline).foregroundStyle(.secondary)
                            .accessibilityIdentifier("memory-editor-error")
                    }
                }
                if conflict {
                    Section("另一端已更新这条记忆") {
                        Text("你的草稿已保留。请选择载入最新内容，或保留草稿并提交。")
                            .font(.subheadline).foregroundStyle(.secondary)
                        if resolving { ProgressView("正在读取最新内容…") }
                        if let latestError {
                            Text(latestError).font(.subheadline).foregroundStyle(.secondary)
                        }
                        if latestLoaded {
                            if let latest {
                                Text("最新内容").font(.caption).foregroundStyle(.secondary)
                                Text(latest.content).font(.subheadline).textSelection(.enabled)
                                Button("载入最新内容") {
                                    content = latest.content
                                    category = latest.category
                                    editBase = latest
                                    clearConflict()
                                }
                                .accessibilityIdentifier("memory-conflict-reload")
                                Button("保留草稿并提交") {
                                    editBase = latest
                                    clearConflict()
                                    submit()
                                }
                                .disabled(contentLength == 0 || contentLength > contentLimit)
                                .accessibilityIdentifier("memory-conflict-rebase")
                            } else {
                                Text("这条记忆已被删除，你可以将草稿保存为新记忆。")
                                    .font(.subheadline).foregroundStyle(.secondary)
                                Button("将草稿保存为新记忆") {
                                    editBase = nil
                                    clearConflict()
                                }
                                .accessibilityIdentifier("memory-conflict-new")
                            }
                        }
                        Button(latestLoaded ? "刷新最新内容" : "读取最新内容") { Task { await loadLatest() } }
                            .disabled(busy)
                    }
                    .accessibilityIdentifier("memory-editor-conflict")
                }
            }
            .disabled(busy)
            .navigationTitle(editBase == nil ? "添加记忆" : "编辑记忆")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    ShiyanCloseButton(action: { dismiss() }, inToolbar: true).disabled(busy)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(action: submit) {
                        if saving { ProgressView() } else { Text("保存") }
                    }
                    .disabled(!canSave)
                    .accessibilityIdentifier("memory-editor-save")
                }
            }
            .interactiveDismissDisabled(busy)
        }
    }

    private func clearConflict() {
        conflict = false
        latestLoaded = false
        latest = nil
        latestError = nil
        failure = nil
    }

    private func submit() {
        guard canSave else { return }
        saving = true
        failure = nil
        let draft = trimmedContent
        let base = editBase
        let draftCategory = category
        Task {
            do {
                try await save(base, draft, draftCategory)
                saving = false
                dismiss()
            } catch {
                saving = false
                failure = error.localizedDescription
                if error is ShiyanMemoryConflict {
                    conflict = true
                    await loadLatest()
                }
            }
        }
    }

    private func loadLatest() async {
        guard let id = editBase?.id, !resolving else { return }
        resolving = true
        latestError = nil
        defer { resolving = false }
        do {
            let result = try await CodexClient.shared.memoryListing()
            latest = result.memories.first { $0.id == id }
            latestLoaded = true
        } catch {
            latestError = error.localizedDescription
            latestLoaded = false
        }
    }
}
