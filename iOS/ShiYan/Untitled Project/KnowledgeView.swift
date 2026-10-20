import SwiftUI
import UniformTypeIdentifiers

private enum KnowledgeTab: String, CaseIterable {
    case documents = "文档", topics = "知识", chat = "问答"
}
private enum KnowledgeEditor: String, Identifiable {
    case space, base, editBase
    var id: String { rawValue }
    var title: String { self == .space ? "新建空间" : self == .base ? "新建知识库" : "编辑知识库" }
}

struct KnowledgeView: View {
    let topInset: CGFloat
    let bottomInset: CGFloat
    let hasUnread: Bool
    let onSidebar: () -> Void
    @StateObject private var store = KnowledgeStore()
    @Environment(\.colorScheme) private var scheme
    @Environment(\.scenePhase) private var scenePhase
    @State private var tab = KnowledgeTab.topics
    @State private var importing = false
    @State private var editor: KnowledgeEditor?
    @State private var deleteDocument: KnowledgeDocument?
    @State private var deleteBase = false
    @State private var clearingHistory = false
    @State private var previewDocument: KnowledgeDocument?
    @State private var question = ""
    @State private var topicPath: [String] = []
    @FocusState private var questionFocused: Bool
    private let pageInset: CGFloat = 20
    private var background: Color { KnowledgeTheme.background }

    var body: some View {
        ZStack(alignment: .top) {
            background.ignoresSafeArea()
            VStack(spacing: 0) {
                Color.clear.frame(height: topInset + 77)
                selectors
                tabs.padding(.horizontal, pageInset).padding(.top, 12).padding(.bottom, 10)
                content
            }
            ShiyanFeatureHeader(page: .knowledge, topInset: topInset, hasUnread: hasUnread, onSidebar: onSidebar) {
                ShiyanMoreMenu {
                    Button("导入 PDF", systemImage: "doc.badge.plus") { importing = true }
                        .disabled(store.selectedBaseID == nil || store.busy)
                    Button("新建知识库", systemImage: "folder.badge.plus") { editor = .base }
                        .disabled(store.selectedSpaceID == nil || store.busy)
                    Button("新建空间", systemImage: "square.stack.3d.up.badge.plus") { editor = .space }.disabled(store.busy)
                    Divider()
                    Button("刷新", systemImage: "arrow.clockwise") { Task { await store.refresh() } }.disabled(store.busy)
                    if store.selectedBaseID != nil {
                        Button("编辑知识库", systemImage: "pencil") { editor = .editBase }.disabled(store.busy)
                        Button("清空问答", systemImage: "bubble.left.and.bubble.right", role: .destructive) { clearingHistory = true }
                            .disabled(store.busy || store.messages.isEmpty)
                        Button("删除知识库", systemImage: "trash", role: .destructive) { deleteBase = true }.disabled(store.busy)
                    }
                }
                .accessibilityIdentifier("knowledge-more-menu")
            }
            .overlay(alignment: .top) {
                Text("知识库").font(.system(size: 18, weight: .semibold))
                    .frame(height: ShiyanPreviewLayout.controlDiameter).padding(.top, topInset + 3).allowsHitTesting(false)
            }
            .background(background)
        }
        .foregroundStyle(KnowledgeTheme.text)
        .tint(KnowledgeTheme.accent)
        .accessibilityIdentifier("knowledge-page")
        .fileImporter(isPresented: $importing, allowedContentTypes: [.pdf], allowsMultipleSelection: true) { result in
            switch result {
            case .success(let urls): Task { await store.upload(urls) }
            case .failure(let error): store.error = error.localizedDescription
            }
        }
        .sheet(item: $editor) { item in
            KnowledgeEditorView(editor: item, store: store)
        }
        .sheet(item: $previewDocument) { document in
            KnowledgeDocumentView(document: document, store: store)
        }
        .alert("删除文档？", isPresented: Binding(get: { deleteDocument != nil }, set: { if !$0 { deleteDocument = nil } })) {
            Button("取消", role: .cancel) { deleteDocument = nil }
            Button("删除", role: .destructive) {
                if let document = deleteDocument { Task { await store.deleteDocument(document) } }
                deleteDocument = nil
            }
        } message: { Text("文档及其知识索引将从当前知识库移除。") }
        .alert("删除知识库？", isPresented: $deleteBase) {
            Button("取消", role: .cancel) {}
            Button("删除", role: .destructive) { Task { await store.deleteBase() } }
        } message: { Text("“\(store.selectedBase?.name ?? "知识库")”中的文档、知识和问答记录将一并删除。") }
        .alert("清空问答记录？", isPresented: $clearingHistory) {
            Button("取消", role: .cancel) {}
            Button("清空", role: .destructive) { Task { await store.clearHistory() } }
        } message: { Text("当前知识库的问答记录将被删除。") }
        .task {
            if store.spaces.isEmpty { await store.load() }
            else { await store.refresh() }
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(3)) } catch { break }
                if scenePhase == .active { await store.poll() }
            }
        }
        .onDisappear { store.stop() }
        .onChange(of: store.selectedBaseID) { _, _ in topicPath = [] }
        .onChange(of: store.retryQuestion) { _, value in
            if let value, question.isEmpty { question = value }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await store.refresh() } }
        }
    }

    private var tabs: some View {
        HStack(spacing: 0) {
            ForEach(KnowledgeTab.allCases, id: \.self) { item in
                Button { tab = item } label: {
                    Text(item.rawValue).font(.system(size: 15, weight: tab == item ? .semibold : .medium))
                        .foregroundStyle(tab == item ? KnowledgeTheme.accent : KnowledgeTheme.muted)
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .overlay(alignment: .bottom) {
                            if tab == item { Rectangle().fill(KnowledgeTheme.accent).frame(height: 2) }
                        }
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(tab == item ? .isSelected : [])
            }
        }
        .overlay(alignment: .bottom) { Rectangle().fill(KnowledgeTheme.border).frame(height: 1).offset(y: 1) }
    }

    private var selectors: some View {
        HStack(spacing: 10) {
            if store.spaces.count > 1 {
                Menu {
                    ForEach(store.spaces) { space in
                        Button { Task { await store.selectSpace(space.id) } } label: {
                            if space.id == store.selectedSpaceID { Label(space.name, systemImage: "checkmark") } else { Text(space.name) }
                        }
                    }
                    Divider()
                    Button("新建空间", systemImage: "plus") { editor = .space }
                } label: {
                    selectorLabel(store.selectedSpace?.name ?? "选择空间", symbol: "square.stack")
                }
                .disabled(store.busy).accessibilityIdentifier("knowledge-space-picker")
            }
            Menu {
                ForEach(store.bases) { base in
                    Button { Task { await store.selectBase(base.id) } } label: {
                        if base.id == store.selectedBaseID { Label(base.name, systemImage: "checkmark") } else { Text(base.name) }
                    }
                }
                Divider()
                Button("新建知识库", systemImage: "plus") { editor = .base }
            } label: {
                selectorLabel(store.selectedBase?.name ?? "选择知识库", symbol: "books.vertical")
            }
            .disabled(store.busy || store.selectedSpaceID == nil).accessibilityIdentifier("knowledge-base-picker")
        }
        .buttonStyle(.plain).padding(.horizontal, pageInset)
    }

    private func selectorLabel(_ title: String, symbol: String) -> some View {
        HStack(spacing: 7) {
            Image(systemName: symbol).foregroundStyle(KnowledgeTheme.accent)
            Text(title).font(.subheadline.weight(.medium)).lineLimit(1)
            Spacer(minLength: 2)
            Image(systemName: "chevron.down").font(.caption2).foregroundStyle(KnowledgeTheme.muted)
        }
        .padding(.horizontal, 12).frame(maxWidth: .infinity, minHeight: 44)
        .knowledgeCard(radius: 10)
    }

    @ViewBuilder private var content: some View {
        if store.loading && store.documents.isEmpty && store.messages.isEmpty {
            ProgressView("正在加载…").font(.subheadline).frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if store.selectedBaseID == nil {
            ScrollView {
                VStack(spacing: 18) {
                    errorNotice
                    Image(systemName: "books.vertical").font(.system(size: 42)).foregroundStyle(KnowledgeTheme.muted)
                    Text(store.spaces.isEmpty ? "建立你的知识空间" : "还没有知识库").font(.headline)
                    Text("导入 PDF，随时查找内容、整理知识和提问。")
                        .font(.subheadline).foregroundStyle(KnowledgeTheme.muted).multilineTextAlignment(.center)
                    Button(store.spaces.isEmpty ? "新建空间" : "新建知识库") { editor = store.spaces.isEmpty ? .space : .base }
                        .buttonStyle(KnowledgePrimaryButtonStyle()).disabled(store.busy)
                    if store.error != nil { Button("重新加载") { Task { await store.load() } } }
                }
                .padding(28).padding(.top, 50)
            }
        } else {
            switch tab {
            case .documents: documentList
            case .topics: topicList
            case .chat: chat
            }
        }
    }

    @ViewBuilder private var errorNotice: some View {
        if let error = store.error {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "exclamationmark.circle").foregroundStyle(KnowledgeTheme.danger)
                Text(error).font(.footnote).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                Button { store.error = nil } label: { Image(systemName: "xmark").font(.caption) }.buttonStyle(.plain).accessibilityLabel("关闭提示")
            }
            .padding(14).knowledgeCard(radius: 12, border: KnowledgeTheme.danger.opacity(0.35))
            .accessibilityIdentifier("knowledge-error")
        }
    }

    private var documentList: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                errorNotice
                if let description = store.selectedBase?.description, !description.isEmpty {
                    Text(description).font(.subheadline).foregroundStyle(KnowledgeTheme.muted).padding(.horizontal, 4)
                }
                if store.uploading { ProgressView("正在上传 PDF…").font(.subheadline).padding(12) }
                ForEach(store.tasks) { task in
                    VStack(alignment: .leading, spacing: 9) {
                        HStack {
                            Text(task.label).font(.subheadline.weight(.medium))
                            Spacer()
                            if !task.isFinished { Text("\(Int(min(100, max(0, task.progress))))%").font(.caption).foregroundStyle(KnowledgeTheme.muted) }
                        }
                        if !task.isFinished { ProgressView(value: min(100, max(0, task.progress)), total: 100).tint(KnowledgeTheme.accent) }
                        if let error = task.error, !error.isEmpty { Text(error).font(.footnote).foregroundStyle(KnowledgeTheme.muted) }
                    }
                    .padding(16).knowledgeCard(radius: 12)
                }
                HStack {
                    Text("\(store.documents.count) 份文档").font(.subheadline).foregroundStyle(KnowledgeTheme.muted)
                    Spacer()
                    Button("导入 PDF", systemImage: "plus") { importing = true }.disabled(store.busy)
                }.padding(.horizontal, 4).padding(.top, 4)
                if store.documents.isEmpty {
                    Text("导入第一份 PDF，开始建立知识库。")
                        .font(.subheadline).foregroundStyle(KnowledgeTheme.muted).frame(maxWidth: .infinity).padding(.vertical, 50)
                }
                ForEach(store.documents) { document in
                    HStack(alignment: .top, spacing: 14) {
                        Button { previewDocument = document } label: {
                            HStack(alignment: .top, spacing: 14) {
                                Image(systemName: "doc.text").font(.system(size: 24)).foregroundStyle(KnowledgeTheme.accent).frame(width: 28).padding(.top, 3)
                                VStack(alignment: .leading, spacing: 7) {
                                    Text(document.displayName).font(.system(size: 17, weight: .medium)).lineLimit(2)
                                    HStack(spacing: 8) {
                                        Text(document.statusLabel)
                                        if let pages = document.page_count { Text("\(pages) 页") }
                                    }.font(.caption).foregroundStyle(KnowledgeTheme.muted)
                                    if let summary = document.summary, !summary.isEmpty { Text(summary).font(.footnote).foregroundStyle(KnowledgeTheme.muted).lineLimit(2) }
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                            }.contentShape(Rectangle())
                        }.buttonStyle(.plain)
                        Menu {
                            Button("查看文档", systemImage: "doc.text.magnifyingglass") { previewDocument = document }
                            Button("删除", systemImage: "trash", role: .destructive) { deleteDocument = document }
                        } label: { ShiyanMoreButtonLabel(hasGlass: false) }
                            .buttonStyle(.plain).disabled(store.busy).accessibilityLabel("\(document.displayName) 更多选项")
                    }
                    .padding(.leading, 18).padding(.trailing, 9).padding(.vertical, 18)
                    .knowledgeCard(radius: 16)
                    .accessibilityIdentifier("knowledge-document-\(document.id)")
                }
            }
            .padding(.horizontal, pageInset).padding(.top, 10).padding(.bottom, bottomInset + 28)
        }
        .scrollIndicators(.hidden).refreshable { await store.refresh() }
    }

    private var topicList: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                errorNotice
                if store.graphLoading {
                    ProgressView("正在加载知识内容…").font(.subheadline)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 12)
                        .accessibilityIdentifier("knowledge-content-loading")
                }
                if let error = store.graphError {
                    VStack(alignment: .leading, spacing: 10) {
                        Text(error).font(.footnote).foregroundStyle(KnowledgeTheme.muted)
                        Button("重新加载知识内容") { store.refreshKnowledge() }.disabled(store.graphLoading)
                    }.padding(14).knowledgeCard(radius: 12)
                        .accessibilityIdentifier("knowledge-content-error")
                }
                if let graph = store.graph {
                    knowledgeReadingHeader(graph)
                    if readingTopics.isEmpty && readingTopic == nil {
                        Text("文档处理完成后，知识主题会显示在这里。")
                            .font(.subheadline).foregroundStyle(KnowledgeTheme.muted).frame(maxWidth: .infinity).padding(.vertical, 50)
                    }
                    ForEach(Array(readingTopics.enumerated()), id: \.element.id) { index, topic in
                        Button { topicPath = readingTrail.map(\.id) + [topic.id] } label: {
                            KnowledgeReadingRow(topic: topic, order: index + 1)
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("knowledge-topic-\(topic.id)")
                        .accessibilityHint(topic.points.isEmpty ? "阅读知识点和参考来源" : "展开下级知识")
                    }
                    if let topic = readingTopic, let sources = topic.sources, !sources.isEmpty {
                        KnowledgeCitationList(citations: sources).padding(.top, 8)
                    }
                }
            }
            .padding(.horizontal, pageInset).padding(.top, 10).padding(.bottom, bottomInset + 28)
        }
        .id("knowledge-reading-" + (store.selectedBaseID ?? "") + topicPath.joined(separator: "/"))
        .scrollIndicators(.hidden).refreshable { await store.refresh() }
    }

    // Store only IDs; refreshed graph data remains the source of truth.
    private var readingTrail: [KnowledgeTopic] {
        var result: [KnowledgeTopic] = []
        var children = store.graph?.readingTopics ?? []
        for id in topicPath {
            guard let topic = children.first(where: { $0.id == id }) else { break }
            result.append(topic)
            children = topic.readingPoints
        }
        return result
    }
    private var readingTopic: KnowledgeTopic? { readingTrail.last }
    private var readingTopics: [KnowledgeTopic] { readingTopic?.readingPoints ?? store.graph?.readingTopics ?? [] }

    @ViewBuilder private func knowledgeReadingHeader(_ graph: KnowledgeGraph) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            if !readingTrail.isEmpty {
                HStack {
                    Button {
                        topicPath = Array(readingTrail.dropLast().map(\.id))
                    } label: {
                        Label("返回", systemImage: "chevron.left").font(.subheadline)
                            .frame(minHeight: 44)
                    }.buttonStyle(.plain).accessibilityLabel("返回上一级知识")
                    Spacer()
                    Button("全部主题") { topicPath = [] }.font(.subheadline).frame(minHeight: 44)
                        .buttonStyle(.plain)
                }
                if readingTrail.count > 1 {
                    Text(readingTrail.dropLast().map(\.title).joined(separator: " › "))
                        .font(.caption).foregroundStyle(KnowledgeTheme.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Text(readingTopic?.title ?? store.selectedBase?.name ?? "知识导读")
                .font(.title3.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            if let topic = readingTopic {
                HStack(spacing: 12) {
                    Text(topic.points.isEmpty ? "知识点" : "\(topic.points.count) 项内容")
                    if let pages = topic.readingPageLabel { Text(pages) }
                }.font(.caption).foregroundStyle(KnowledgeTheme.muted)
                if let summary = topic.summary, !summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Text(summary).font(.body).lineSpacing(6).textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } else {
                Text("\(graph.document_count ?? store.documents.count) 份文档 · \(graph.readingTopics.count) 个主题")
                    .font(.subheadline).foregroundStyle(KnowledgeTheme.muted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 8)
        .accessibilityIdentifier("knowledge-reading-heading")
    }

    private var chat: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 24) {
                        errorNotice
                        if store.messages.isEmpty {
                            VStack(spacing: 12) {
                                Image(systemName: "text.bubble").font(.system(size: 36)).foregroundStyle(KnowledgeTheme.muted)
                                Text("向知识库提问").font(.headline)
                                Text("回答附有文档引用，可展开查看原文和页码。")
                                    .font(.subheadline).foregroundStyle(KnowledgeTheme.muted).multilineTextAlignment(.center)
                            }.frame(maxWidth: .infinity).padding(.vertical, 42)
                        }
                        ForEach(store.messages) { message in
                            VStack(alignment: .leading, spacing: 12) {
                                if message.type == "user" {
                                    HStack {
                                        Spacer(minLength: 32)
                                        VStack(alignment: .trailing, spacing: 7) {
                                            Text("你的问题").font(.caption).foregroundStyle(KnowledgeTheme.cyan)
                                            Text(message.content).font(.system(size: 15)).padding(16)
                                                .modifier(KnowledgeChatSurface(user: true))
                                        }
                                    }
                                } else {
                                    Text("AI 回复").font(.caption).foregroundStyle(KnowledgeTheme.muted)
                                    Text(message.content).font(.system(size: 15)).lineSpacing(5).textSelection(.enabled)
                                        .frame(maxWidth: .infinity, alignment: .leading).padding(17)
                                        .modifier(KnowledgeChatSurface(user: false))
                                    if let citations = message.citations, !citations.isEmpty { KnowledgeCitationList(citations: citations) }
                                }
                            }.id(message.id)
                        }
                        if store.submitting { ProgressView("正在查找并整理回答…").font(.subheadline).padding(.vertical, 12) }
                        Color.clear.frame(height: 1).id("knowledge-chat-bottom")
                    }
                    .padding(.horizontal, pageInset).padding(.vertical, 16)
                }
                .scrollIndicators(.hidden).scrollDismissesKeyboard(.interactively)
                .onChange(of: store.messages.count) { _, _ in
                    withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("knowledge-chat-bottom", anchor: .bottom) }
                }
                .onAppear { proxy.scrollTo("knowledge-chat-bottom", anchor: .bottom) }
            }
            HStack(alignment: .bottom, spacing: 12) {
                TextField("总结、比较、定位原文……", text: $question, axis: .vertical)
                    .lineLimit(1...6).frame(minHeight: 44, alignment: .center)
                    .focused($questionFocused).disabled(store.submitting)
                    .onChange(of: question) { _, value in if value.count > 4000 { question = String(value.prefix(4000)) } }
                    .accessibilityIdentifier("knowledge-question-input")
                Button {
                    let value = question.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !value.isEmpty, !store.busy else { return }
                    questionFocused = false; store.ask(value); question = ""
                } label: {
                    Image(systemName: "paperplane.fill").rotationEffect(.degrees(45))
                        .font(.system(size: 17, weight: .medium)).foregroundStyle(.white)
                        .frame(width: 36, height: 36)
                        .background(KnowledgeTheme.sendGradient, in: RoundedRectangle(cornerRadius: 12))
                        .frame(width: 44, height: 44).contentShape(Rectangle())
                        .opacity(question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.busy ? 0.28 : 1)
                }
                .buttonStyle(.plain).disabled(question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.busy)
                .accessibilityLabel("发送问题").accessibilityIdentifier("knowledge-send-question")
            }
            .padding(.leading, 14).padding(.trailing, 10).padding(.vertical, 5)
            .knowledgeCard(radius: 15, tint: KnowledgeTheme.accent.opacity(0.055), border: KnowledgeTheme.accent.opacity(questionFocused ? 0.62 : 0.24))
            .padding(.horizontal, pageInset).padding(.bottom, max(bottomInset, 12))
        }
    }
}

private struct KnowledgeCitationList: View {
    let citations: [KnowledgeCitation]
    var body: some View {
        DisclosureGroup {

            VStack(alignment: .leading, spacing: 16) {
                ForEach(Array(citations.enumerated()), id: \.offset) { index, citation in
                    HStack(alignment: .top, spacing: 10) {
                        Text(String(format: "[%02d]", index + 1)).font(.system(size: 12, design: .monospaced))
                            .foregroundStyle(KnowledgeTheme.warm).frame(width: 33, alignment: .leading)
                        VStack(alignment: .leading, spacing: 5) {
                            Text(citation.document_name ?? "文档").font(.system(size: 14, weight: .semibold))
                            if let pages = citation.pageLabel { Text(pages).font(.caption).foregroundStyle(KnowledgeTheme.cyan) }
                            if let quote = citation.quote, !quote.isEmpty { Text(quote).font(.footnote).foregroundStyle(KnowledgeTheme.muted).textSelection(.enabled) }
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding(.vertical, 8)
                    .overlay(alignment: .bottom) { Rectangle().fill(KnowledgeTheme.accent.opacity(0.13)).frame(height: 1) }
                }
            }.padding(.top, 10)
        } label: {
            Text("参考来源 · \(citations.count)").font(.subheadline.weight(.medium)).foregroundStyle(KnowledgeTheme.warm)
        }
        .font(.subheadline).tint(KnowledgeTheme.accent)
    }
}

private struct KnowledgeReadingRow: View {
    let topic: KnowledgeTopic
    let order: Int
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Text(String(format: "%02d", order))
                .font(.caption.monospacedDigit()).foregroundStyle(KnowledgeTheme.muted)
                .frame(minWidth: 22, alignment: .leading).padding(.top, 4)
            VStack(alignment: .leading, spacing: 10) {
                Text(topic.title).font(.headline).foregroundStyle(KnowledgeTheme.text)
                    .fixedSize(horizontal: false, vertical: true)
                if let summary = topic.summary, !summary.isEmpty {
                    Text(summary).font(.subheadline).foregroundStyle(KnowledgeTheme.muted)
                        .lineSpacing(4).lineLimit(3)
                }
                HStack(spacing: 12) {
                    Text(topic.points.isEmpty ? "知识点" : "\(topic.points.count) 项内容")
                    if let pages = topic.readingPageLabel { Text(pages) }
                }.font(.caption).foregroundStyle(KnowledgeTheme.muted)
            }.frame(maxWidth: .infinity, alignment: .leading)
            Image(systemName: "chevron.right").font(.caption.weight(.medium))
                .foregroundStyle(KnowledgeTheme.muted).padding(.top, 5)
        }
        .padding(17).frame(maxWidth: .infinity, alignment: .leading)
        .knowledgeCard(radius: 16)
        .contentShape(RoundedRectangle(cornerRadius: 16))
        .accessibilityElement(children: .combine)
    }
}

private struct KnowledgeEditorView: View {
    let editor: KnowledgeEditor
    @ObservedObject var store: KnowledgeStore
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var description = ""
    private var valid: Bool { !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && name.count <= 120 && description.count <= 2000 && !store.busy }
    var body: some View {
        NavigationStack {
            Form {
                TextField(editor == .space ? "空间名称" : "知识库名称", text: $name).listRowBackground(KnowledgeTheme.panel)
                if editor == .base { TextField("简介（选填）", text: $description, axis: .vertical).lineLimit(3...6).listRowBackground(KnowledgeTheme.panel) }
                if let error = store.error { Text(error).font(.footnote).foregroundStyle(KnowledgeTheme.muted) }
            }
            .scrollContentBackground(.hidden).background(KnowledgeModalBackground())
            .foregroundStyle(KnowledgeTheme.text).tint(KnowledgeTheme.accent)
            .toolbarBackground(KnowledgeTheme.sidebarPanel, for: .navigationBar)
            .navigationTitle(editor.title).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { ShiyanCloseButton(action: { dismiss() }, inToolbar: true).disabled(store.mutating) }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("保存") {
                        Task {
                            let clean = name.trimmingCharacters(in: .whitespacesAndNewlines)
                            let saved = editor == .space ? await store.createSpace(name: clean) : await store.saveBase(name: clean, description: description, editing: editor == .editBase)
                            if saved { dismiss() }
                        }
                    }.disabled(!valid)
                }
            }
            .onAppear {
                if editor == .editBase { name = store.selectedBase?.name ?? ""; description = store.selectedBase?.description ?? "" }
            }
            .interactiveDismissDisabled(store.mutating)
        }
    }
}

private struct KnowledgeDocumentView: View {
    let document: KnowledgeDocument
    @ObservedObject var store: KnowledgeStore
    @Environment(\.dismiss) private var dismiss
    @State private var detail: KnowledgeDocument?
    @State private var error: String?
    @State private var loading = true
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text((detail ?? document).displayName).font(.title3.weight(.semibold)).textSelection(.enabled)
                    Text((detail ?? document).statusLabel).font(.subheadline).foregroundStyle(KnowledgeTheme.muted)
                    if let summary = (detail ?? document).summary, !summary.isEmpty { Text(summary).font(.body).textSelection(.enabled) }
                    if let tags = (detail ?? document).tags, !tags.isEmpty { Text(tags.joined(separator: " · ")).font(.footnote).foregroundStyle(KnowledgeTheme.muted) }
                    if loading { ProgressView("正在读取文档…") }
                    if let error { Text(error).font(.footnote).foregroundStyle(KnowledgeTheme.muted) }
                    ForEach(detail?.chunks ?? []) { chunk in
                        VStack(alignment: .leading, spacing: 10) {
                            if let heading = chunk.heading, !heading.isEmpty { Text(heading).font(.headline) }
                            if let start = chunk.page_start { Text(chunk.page_end != nil && chunk.page_end != start ? "第 \(start)–\(chunk.page_end!) 页" : "第 \(start) 页").font(.caption).foregroundStyle(KnowledgeTheme.muted) }
                            Text(chunk.content).font(.subheadline).textSelection(.enabled)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading).padding(16)
                        .knowledgeCard(radius: 12, tint: KnowledgeTheme.cyan.opacity(0.04), border: KnowledgeTheme.cyan.opacity(0.24))
                    }
                }.frame(maxWidth: .infinity, alignment: .leading).padding(20)
            }
            .background(KnowledgeModalBackground()).foregroundStyle(KnowledgeTheme.text).tint(KnowledgeTheme.accent)
            .toolbarBackground(KnowledgeTheme.sidebarPanel, for: .navigationBar)
            .navigationTitle("文档").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarLeading) { ShiyanCloseButton(action: { dismiss() }, inToolbar: true) } }
            .task {
                detail = await store.cachedDocumentDetail(document.id)
                if detail != nil { loading = false }
                do { detail = try await store.documentDetail(document.id) } catch { self.error = error.localizedDescription }
                loading = false
            }
        }
    }
}
