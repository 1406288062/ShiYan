import SwiftUI

 
struct AgentConversationSearch: View {
    @ObservedObject var store: AgentStore
    let onSelect: (UUID) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var historicalMatches = Set<UUID>()
    @State private var completedQuery = ""
    @FocusState private var focused: Bool
    private var results: [AgentConversation] {
        let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return store.conversations.filter {
            $0.hasSentMessage && (term.isEmpty || $0.title.localizedCaseInsensitiveContains(term) || (completedQuery == term && historicalMatches.contains($0.id)) || $0.messages.contains { $0.text.localizedCaseInsensitiveContains(term) })
        }.sorted { ($0.lastOpenedAt ?? $0.updatedAt) > ($1.lastOpenedAt ?? $1.updatedAt) }
    }
    var body: some View {
        GeometryReader { geometry in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 24) {
                    Text(query.isEmpty ? "最近打开" : "搜索结果").font(.title3.weight(.semibold))
                        .padding(.bottom, 2).accessibilityIdentifier("conversation-search-heading")
                    ForEach(results) { conversation in
                        Button {
                            focused = false; dismiss(); onSelect(conversation.id)
                        } label: {
                            HStack(alignment: .center, spacing: 16) {
                                AgentConversationBubble().stroke(.primary, style: StrokeStyle(lineWidth: 1.9, lineCap: .round, lineJoin: .round))
                                    .frame(width: 24, height: 24).frame(width: 42, height: 42)
                                    .overlay(RoundedRectangle(cornerRadius: 11).stroke(Color.primary.opacity(0.10), lineWidth: 1))
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(conversation.title).font(.body).foregroundStyle(.primary).lineLimit(1)
                                    Text(conversation.lastContent.isEmpty ? "尚未发送消息" : conversation.lastContent).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                                }.frame(maxWidth: .infinity, alignment: .leading)
                            }.contentShape(Rectangle())
                        }.buttonStyle(.plain).accessibilityIdentifier("search-result-\(conversation.id.uuidString)")
                            .agentEdgeFade(space: "searchViewport", topGone: -20, topClear: 10,
                                bottomClear: geometry.size.height - 115, bottomGone: geometry.size.height - 25)
                    }
                    if results.isEmpty && !query.isEmpty { Text("没有匹配的会话").font(.subheadline).foregroundStyle(.secondary) }
                }.padding(.horizontal, 18).padding(.top, 24).padding(.bottom, 20)
            }
            .scrollIndicators(.hidden).scrollDismissesKeyboard(.interactively).scrollEdgeEffectHidden(true)
            .coordinateSpace(name: "searchViewport")
        }
        .task(id: query) {
            let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
            do { try await Task.sleep(for: .milliseconds(200)) } catch { return }
            let ids = await store.searchMessageHistory(term)
            guard !Task.isCancelled else { return }
            historicalMatches = ids; completedQuery = term
        }
        .background(Color(uiColor: .systemBackground))
        .safeAreaInset(edge: .bottom, spacing: 0) {
            HStack(spacing: 12) {
                HStack(spacing: 10) {
                    Image(systemName: "magnifyingglass").font(.system(size: 21, weight: .medium))
                    TextField("搜索", text: $query).focused($focused).submitLabel(.search)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .accessibilityIdentifier("session-search")
                    if !query.isEmpty {
                        Button { query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
                            .buttonStyle(.plain).accessibilityLabel("清除搜索")
                    }
                }.padding(.horizontal, 17).frame(height: 52)
                    .shiyanGlass(in: Capsule(), tint: .white.opacity(0.10))
                AgentRoundButton(symbol: "xmark", label: "关闭搜索", diameter: 52) { focused = false; dismiss() }
            }.padding(.horizontal, 14).padding(.top, 10).padding(.bottom, 12)
        }
    }
}
