import SwiftUI
import Combine

nonisolated struct ShiyanMemorySettings: Decodable, Sendable {
    let ok: Bool
    let enabled: Bool
    let revision: Int
}

@MainActor
private final class ShiyanMemoryStore: ObservableObject {
    private let client = CodexClient.shared
    @Published private(set) var enabled = true
    @Published private(set) var isLoaded = false
    @Published private(set) var isLoading = false
    @Published private(set) var isSaving = false
    @Published private(set) var error: String?

    func refresh() async {
        guard !isLoading, !isSaving else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let settings = try await client.memorySettings()
            guard !Task.isCancelled else { return }
            enabled = settings.enabled
            isLoaded = true
            error = nil
        } catch {
            guard !Task.isCancelled else { return }
            self.error = error.localizedDescription
        }
    }

    func setEnabled(_ value: Bool) async {
        guard isLoaded, !isLoading, !isSaving, value != enabled else { return }
        let previous = enabled
        enabled = value
        isSaving = true
        error = nil
        defer { isSaving = false }
        do {
            let settings = try await client.setMemoryEnabled(value)
            enabled = settings.enabled
        } catch {
            enabled = previous
            self.error = error.localizedDescription
        }
    }
}

struct MemoryView: View {
    let topInset: CGFloat
    let bottomInset: CGFloat
    let hasUnread: Bool
    let onSidebar: () -> Void
    let onBack: () -> Void
    @StateObject private var store = ShiyanMemoryStore()
    @Environment(\.scenePhase) private var scenePhase

    private var background: Color { Color(uiColor: .systemGroupedBackground) }
    private var cardBackground: Color { Color(uiColor: .secondarySystemGroupedBackground) }
    private var busy: Bool { store.isLoading || store.isSaving }

    var body: some View {
        ZStack(alignment: .top) {
            background.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    VStack(alignment: .leading, spacing: 10) {
                        Toggle("使用记忆", isOn: Binding(
                            get: { store.enabled },
                            set: { value in Task {
                                await store.setEnabled(value)
                            } }
                        ))
                        .font(.body.weight(.medium))
                        .disabled(busy || !store.isLoaded)
                        .accessibilityIdentifier("memory-enabled")
                        Text(store.enabled ? "自动记住重要信息，让回复更贴合你。" : "已暂停自动记录和使用记忆，已保存的信息会保留。")
                            .font(.footnote).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                        if busy {
                            HStack(spacing: 8) {
                                ProgressView().controlSize(.small)
                                Text(store.isSaving ? "正在保存设置" : "正在加载设置")
                                    .font(.footnote).foregroundStyle(.secondary)
                            }
                            .accessibilityElement(children: .combine)
                        }
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
                    if store.isLoaded && store.enabled {
                        ShiyanMemoryEntriesSection(cardBackground: cardBackground)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.top, topInset + 98)
                .padding(.bottom, bottomInset + 28)
            }
            .scrollIndicators(.hidden)

            ShiyanFeatureHeader(page: .settings, topInset: topInset, hasUnread: hasUnread,
                                onSidebar: onSidebar, onBack: onBack, backLabel: "返回设置") {
                Color.clear.frame(width: ShiyanPreviewLayout.controlDiameter, height: ShiyanPreviewLayout.controlDiameter)
                    .allowsHitTesting(false).accessibilityHidden(true)
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
    }
}

private struct DotsRelationshipTopicEditor: View {
    @ObservedObject var store: DotsStore
    let topic: DotsRelationshipTopic
    @Environment(\.dismiss) private var dismiss
    @State private var title: String
    @State private var summary: String
    @State private var openQuestion: String
    @State private var confirmingDelete = false

    init(store: DotsStore, topic: DotsRelationshipTopic) {
        self.store = store
        self.topic = topic
        _title = State(initialValue: topic.title)
        _summary = State(initialValue: topic.summary)
        _openQuestion = State(initialValue: topic.openQuestion ?? "")
    }
    private var busy: Bool { store.relationshipLoading || store.relationshipSaving }
    private var valid: Bool {
        !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        !summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        title.utf16.count <= 200 && summary.utf16.count <= 4000 && openQuestion.utf16.count <= 2000
    }
    private func limited(_ value: Binding<String>, to limit: Int) -> Binding<String> {
        Binding(get: { value.wrappedValue }, set: { text in
            var result = "", length = 0
            for character in text {
                let part = String(character)
                guard length + part.utf16.count <= limit else { break }
                result += part; length += part.utf16.count
            }
            value.wrappedValue = result
        })
    }
    var body: some View {
        Form {
            if topic.needsReview {
                Text("请确认这段记忆").font(.subheadline).foregroundStyle(.secondary)
            }
            Section("话题") {
                TextField("标题", text: limited($title, to: 200))
                TextField("共同聊过的内容", text: limited($summary, to: 4000), axis: .vertical).lineLimit(3...10)
            }
            Section("尚未聊完") {
                TextField("可留空", text: limited($openQuestion, to: 2000), axis: .vertical).lineLimit(2...6)
            }
            .disabled(busy)
            if let error = store.relationshipNotice {
                Text(error).font(.footnote).foregroundStyle(.secondary)
            }
            Section {
                Button("删除这个话题", role: .destructive) { confirmingDelete = true }.disabled(busy)
            } footer: {
                Text("删除后不会再使用这段记忆，聊天记录仍会保留。")
            }
        }
        .disabled(busy)
        .navigationTitle("共同话题")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("保存") {
                    Task {
                        let saved = await store.updateRelationship(.editTopic(id: topic.id, revision: topic.revision,
                            title: title.trimmingCharacters(in: .whitespacesAndNewlines),
                            summary: summary.trimmingCharacters(in: .whitespacesAndNewlines),
                            openQuestion: openQuestion.trimmingCharacters(in: .whitespacesAndNewlines)))
                        if saved { dismiss() }
                    }
                }.disabled(busy || !valid)
            }
        }
        .confirmationDialog("删除这个共同话题？", isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button("删除", role: .destructive) {
                Task { if await store.updateRelationship(.deleteTopic(id: topic.id)) { dismiss() } }
            }
        }
        .accessibilityIdentifier("dots-relationship-topic-editor")
    }
}

// MARK: - Memory entries (shared by normal chat and Dots)

struct ShiyanMemoryList: Decodable { var memories: [ShiyanMemoryEntry] }
struct ShiyanMemoryEntry: Decodable, Identifiable, Equatable {
    var id: String
    var category: String?
    var content: String
    var scope: String?
    var updatedAt: Double?
    var revision: Int
}

struct ShiyanMemoryEntriesSection: View {
    var cardBackground: Color
    @State private var entries: [ShiyanMemoryEntry] = []
    @State private var query = ""
    @State private var loaded = false
    @State private var editing: ShiyanMemoryEntry?
    @State private var deleting: ShiyanMemoryEntry?
    @State private var notice: String?
    private let categories = ["preference": "偏好", "profile": "个人信息", "project": "项目", "fact": "事实", "instruction": "习惯"]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("记住的内容").font(.headline)
                Spacer()
                if loaded { Text("\(entries.count) 条").font(.footnote).foregroundStyle(.secondary) }
            }
            Text("普通对话和 Dots 共用这些记忆。也可以直接在对话里说“记住……”或“忘掉……”。")
                .font(.footnote).foregroundStyle(.secondary)
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("搜索记忆", text: $query).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .onSubmit { Task { await load() } }
            }
            .padding(.horizontal, 12).padding(.vertical, 9)
            .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
            if !loaded {
                ProgressView().frame(maxWidth: .infinity)
            } else if entries.isEmpty {
                Text(query.isEmpty ? "还没有记住任何内容。" : "没有找到相关记忆。")
                    .font(.subheadline).foregroundStyle(.secondary).frame(maxWidth: .infinity).padding(.vertical, 8)
            } else {
                VStack(spacing: 0) {
                    ForEach(entries) { entry in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(entry.content).font(.subheadline).fixedSize(horizontal: false, vertical: true)
                            Text([categories[entry.category ?? ""] ?? "记忆", entry.scope == "project" ? "项目" : nil].compactMap { $0 }.joined(separator: " · "))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 10)
                        .contentShape(Rectangle())
                        .contextMenu {
                            Button("修改", systemImage: "pencil") { editing = entry }
                            Button("复制", systemImage: "doc.on.doc") { UIPasteboard.general.string = entry.content }
                            Button("删除", systemImage: "trash", role: .destructive) { deleting = entry }
                        }
                        .transition(.asymmetric(insertion: .opacity, removal: .move(edge: .trailing).combined(with: .opacity)))
                        if entry.id != entries.last?.id { Divider() }
                    }
                }
                .animation(.spring(response: 0.3, dampingFraction: 0.85), value: entries)
                Text("长按一条记忆可以修改或删除。").font(.caption2).foregroundStyle(.tertiary)
            }
            if let notice { Text(notice).font(.footnote).foregroundStyle(.secondary) }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(cardBackground, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .task { await load() }
        .onChange(of: query) { _, value in if value.isEmpty { Task { await load() } } }
        .confirmationDialog("删除这条记忆？", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
            Button("删除", role: .destructive) { if let entry = deleting { Task { await remove(entry) } } }
        } message: { Text(deleting?.content ?? "") }
        .sheet(item: $editing) { entry in ShiyanMemoryEditor(entry: entry) { content in await save(entry, content) } }
        .accessibilityIdentifier("memory-entries")
    }
    private func load() async {
        do { entries = try await CodexClient.shared.memories(query: query.trimmingCharacters(in: .whitespaces)); notice = nil }
        catch { notice = error.localizedDescription }
        loaded = true
    }
    private func remove(_ entry: ShiyanMemoryEntry) async {
        do {
            try await CodexClient.shared.deleteMemory(entry.id)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            withAnimation { entries.removeAll { $0.id == entry.id } }
            notice = "已删除。普通对话和 Dots 都不会再用到它。"
        } catch { notice = error.localizedDescription }
    }
    private func save(_ entry: ShiyanMemoryEntry, _ content: String) async -> String? {
        do { try await CodexClient.shared.updateMemory(entry.id, content: content, revision: entry.revision); await load(); return nil }
        catch { return error.localizedDescription }
    }
}

private struct ShiyanMemoryEditor: View {
    let entry: ShiyanMemoryEntry
    let onSave: (String) async -> String?
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var error: String?
    @State private var saving = false
    var body: some View {
        NavigationStack {
            Form {
                Section { TextEditor(text: $text).frame(minHeight: 120) } footer: { Text("\(text.count) / 1200") }
                if let error { Text(error).foregroundStyle(.red).font(.footnote) }
            }
            .navigationTitle("修改记忆").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") {
                        saving = true
                        Task { error = await onSave(text.trimmingCharacters(in: .whitespacesAndNewlines)); saving = false; if error == nil { dismiss() } }
                    }.disabled(saving || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || text.count > 1200)
                }
            }
            .onAppear { text = entry.content }
        }
        .presentationDetents([.medium])
    }
}
