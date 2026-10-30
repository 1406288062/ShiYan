import CoreImage
import SwiftUI
import UIKit
import UniformTypeIdentifiers
import QuickLook

struct DotsIdentityIcon: View {
    @ObservedObject private var store = DotsStore.shared
    var body: some View {
        if let data = store.avatarData, let image = UIImage(data: data) {
            Image(uiImage: image).renderingMode(.original).resizable().scaledToFit()
        } else {
            Image("dotsPersonalIcon").renderingMode(.template).resizable().scaledToFit()
        }
    }
}
private struct DotsBottomPreference: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}
private struct DotsApprovalContext: Identifiable {
    let goalId: Int
    let title: String
    let approval: DotsApproval
    var id: String { "\(goalId):\(approval.id)" }
}

struct DotsView: View {
    let topInset: CGFloat
    let bottomInset: CGFloat
    let hasUnread: Bool
    let isConversationVisible: Bool
    let onSidebar: () -> Void
    var onTaskSheetPresented: (Bool) -> Void = { _ in }
    @StateObject private var store = DotsStore.shared
    @ObservedObject private var voice = DotsVoiceSession.shared
    @ObservedObject private var voicePresentation = DotsVoicePresentation.shared
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var showTasks = false
    @State private var showSubscriptions = false
    @State private var showConnectors = false
    @State private var showSettings = false
    @State private var showFiles = false
    @State private var attachmentPreview: URL?
    @State private var approval: DotsApprovalContext?
    @State private var outputPreview: DotsOutput?
    @State private var processExpanded = false
    @State private var historyExpanded = false
    @State private var outputsExpanded = false
    @State private var editingSchedule: DotsSchedule?
    @State private var schedulePresented = false
    @State private var atBottom = true
    @State private var initialPosition = true
    @State private var composerHeight: CGFloat = 80
    @State private var headerHeight: CGFloat = 0
    @State private var needsApprovalReveal = false
    @State private var replyTarget: DotsManagerMessage?
    @State private var approvalScopes: [String: String] = [:]
    @State private var selectingText: DotsSelectionText?
    /// Highest message id at the moment of sending; the thinking state stays
    /// until an assistant message after it carries text.
    @State private var sentAfterId: Int?
    @FocusState private var inputFocused: Bool

    var body: some View {
        GeometryReader { viewport in
            let window = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
                .flatMap(\.windows).first(where: \.isKeyWindow)
            let viewportBottom = viewport.frame(in: .global).maxY
            let keyboardShown = (window?.bounds.maxY ?? viewportBottom) - viewportBottom > max(bottomInset, 30)
            let composerBottom = keyboardShown ? CGFloat(8) : bottomInset
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 24) {
                            if store.hasMoreMessages {
                                Button {
                                    Task {
                                        let anchor = store.messages.first?.id
                                        await store.loadEarlier()
                                        if let anchor { proxy.scrollTo(anchor, anchor: .top) }
                                    }
                                } label: {
                                    if store.loadingEarlier { ProgressView() }
                                    else { Text("查看更早消息").font(.footnote).foregroundStyle(.secondary) }
                                }.buttonStyle(.plain).disabled(store.loadingEarlier)
                                    .frame(maxWidth: .infinity).accessibilityIdentifier("dots-earlier-messages")
                            }
                            ForEach(store.messages) { item in
                                VStack(alignment: .leading, spacing: 16) {
                                    if item.role == "user" || item.origin == "proactive",
                                       let timestamp = managerTimestamp(item.createdAt) {
                                        Text(timestamp).font(.system(size: 11)).foregroundStyle(.secondary)
                                            .frame(maxWidth: .infinity, alignment: .center)
                                            .accessibilityIdentifier("dots-message-time-\(item.id)")
                                    }
                                    if !isBlankReply(item) {
                                        managerMessage(item)
                                            .modifier(DotsSwipeToReply(enabled: item.role != "system" && !item.isStreaming) {
                                                beginReply(item)
                                            })
                                            .transition(.opacity.combined(with: .offset(y: 6)))
                                    }
                                    if let card = item.card, card.type == "subscription" {
                                        DotsSubscriptionCardView(card: card, messageId: item.id)
                                    }
                                }.id(item.id)
                            }
                            if let operation = store.state.pending, store.sending,
                               operation.route == "manager/messages", let text = operation.text,
                               !store.messages.contains(where: { $0.requestId == operation.requestId }) {
                                // The sent message shows on the tap frame; the server copy replaces it.
                                managerMessage(DotsManagerMessage(id: -1, role: "user", content: text,
                                    attachments: operation.attachments, requestId: operation.requestId))
                                    .opacity(0.72)
                                    .id("dots-optimistic-\(operation.requestId)")
                                    .transition(.opacity.combined(with: .scale(scale: 0.96, anchor: .bottomTrailing)))
                            }
                            if awaitingReply {
                                DotsThinkingIndicator()
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .id("dots-thinking")
                                    .transition(.asymmetric(insertion: .identity, removal: .opacity))
                            }
                            ForEach(pendingApprovals) { context in
                                approvalCard(context.approval, goalId: context.goalId, title: context.title)
                                    .id("dots-approval-\(context.id)")
                            }
                            if let operation = unresolvedApprovalOperation {
                                pendingApprovalCard(operation).id("dots-approval-pending-\(operation.requestId)")
                            }
                            if pendingApprovals.isEmpty && hasApprovalTasks && store.approvalStatus == "需要你批准操作" {
                                VStack(alignment: .leading, spacing: 12) {
                                    Label("有操作需要你批准", systemImage: "hand.raised")
                                        .font(.subheadline.weight(.semibold))
                                    Text(store.approvalNotice ?? "正在读取具体命令和原因…")
                                        .font(.subheadline).foregroundStyle(.secondary)
                                    Button("重新读取") { Task { await store.refreshApprovals() } }
                                        .disabled(store.loading || store.sending)
                                }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
                                    .background(Color.primary.opacity(0.025), in: RoundedRectangle(cornerRadius: 18))
                                    .accessibilityIdentifier("dots-approval-loading")
                            }
                            Color.clear.frame(height: 1).id("dots-bottom")
                                .background(GeometryReader { geo in
                                    Color.clear.preference(key: DotsBottomPreference.self,
                                        value: geo.frame(in: .named("dots-chat-scroll")).minY)
                                })
                        }.padding(.horizontal, 24)
                            .padding(.top, (headerHeight > 0 ? headerHeight : topInset + 111) + 16)
                            .padding(.bottom, 20)
                            .opacity(voicePresentation.immersive ? 0 : 1)
                            .allowsHitTesting(!voicePresentation.immersive)
                            .accessibilityHidden(voicePresentation.immersive)
                    }
                    .coordinateSpace(name: "dots-chat-scroll")
                    .defaultScrollAnchor(.bottom, for: .initialOffset)
                    .onPreferenceChange(DotsBottomPreference.self) { y in
                        atBottom = y <= viewport.size.height + 70
                        updateReadingVisibility()
                    }
                    .scrollDisabled(voicePresentation.immersive)
                    .scrollIndicators(.hidden).scrollDismissesKeyboard(.interactively)
                    .scrollEdgeEffectStyle(.soft, for: .top)
                    // Keep the same native blur, limited to the system row and controls.
                    .safeAreaBar(edge: .top, spacing: -(topInset + 49)) {
                        Color.clear.frame(height: topInset + 49)
                            .background(alignment: .bottom) {
                                Text("X")
                                    .font(.system(size: 12))
                                    .blendMode(.sourceAtop)
                                    .allowsHitTesting(false)
                                    .accessibilityHidden(true)
                            }
                            .allowsHitTesting(false)
                    }
                    .scrollEdgeEffectStyle(.soft, for: .bottom)
                    .safeAreaBar(edge: .bottom, spacing: 0) {
                        composer(bottomGap: composerBottom).onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height in
                            if abs(height - composerHeight) > 0.5 { composerHeight = height }
                        }
                    }
                    .refreshable { await store.refresh() }
                    .onChange(of: store.messages.map(\.id)) { before, after in
                        if initialPosition || (atBottom && before.last != after.last) {
                            proxy.scrollTo("dots-bottom", anchor: .bottom); initialPosition = false
                        }
                    }
                    .onChange(of: store.messages.map(\.content)) { _, _ in
                        if let base = sentAfterId, store.messages.contains(where: {
                            $0.id > base && $0.role == "assistant" && !$0.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        }) { withAnimation(.easeOut(duration: 0.22)) { sentAfterId = nil } }
                        if atBottom && !voicePresentation.immersive {
                            proxy.scrollTo("dots-bottom", anchor: .bottom)
                        }
                    }
                    .onChange(of: awaitingReply) { _, waiting in
                        if waiting && !voicePresentation.immersive {
                            withAnimation(.spring(response: 0.4, dampingFraction: 0.86)) {
                                proxy.scrollTo("dots-bottom", anchor: .bottom)
                            }
                        }
                    }
                    .onChange(of: store.notice) { _, notice in
                        if notice != nil { withAnimation(.easeOut(duration: 0.2)) { sentAfterId = nil } }
                    }
                    .onChange(of: pendingApprovals.map(\.id)) { before, after in
                        if !Set(after).subtracting(before).isEmpty { scheduleApprovalReveal() }
                        if atBottom && !voicePresentation.immersive {
                            proxy.scrollTo("dots-bottom", anchor: .bottom)
                        }
                    }
                    .onChange(of: unresolvedApprovalOperation?.requestId) { _, requestId in
                        if requestId != nil { scheduleApprovalReveal() }
                    }
                    .overlay(alignment: .bottom) {
                        let showsBottomButton = !atBottom
                        Button { proxy.scrollTo("dots-bottom", anchor: .bottom) } label: {
                            Image(systemName: "arrow.down").font(.system(size: 16, weight: .medium))
                                .frame(width: 36, height: 36).shiyanGlass(in: Circle())
                                .contentShape(Circle())
                        }.buttonStyle(.plain).padding(.bottom, composerHeight + 8)
                            .accessibilityLabel("查看最新消息")
                            .opacity(showsBottomButton ? 1 : 0)
                        .offset(y: reduceMotion || showsBottomButton ? 0 : 8)
                        .allowsHitTesting(showsBottomButton)
                        .accessibilityHidden(!showsBottomButton)
                        .animation(reduceMotion ? .easeOut(duration: 0.16) : .easeInOut(duration: 0.28), value: showsBottomButton)
                    }
                }
                .overlay {
                    DotsVoiceScene(presentation: voicePresentation,
                                   composerTop: viewport.size.height - composerHeight + 8,
                                   topInset: max(headerHeight + 12, topInset + 90))
                }
        }
        .overlay(alignment: .top) {
            assistantHeader
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height in
                    if abs(height - headerHeight) > 0.5 { headerHeight = height }
                }
        }
        .background(scheme == .dark ? Color(white: 0.065) : Color.white)
        .task {
            if scenePhase == .active { store.activate() }
            scheduleApprovalReveal()
            updateReadingVisibility()
        }
        .onDisappear { store.deactivate(); onTaskSheetPresented(false) }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { store.activate() } else { store.deactivate() }
            updateReadingVisibility()
        }
        .fileImporter(isPresented: $showFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            switch result {
            case .success(let urls): Task { await store.addFiles(urls) }
            case .failure(let error): store.notice = error.localizedDescription
            }
        }
        .quickLookPreview($attachmentPreview)
        .sheet(isPresented: $showTasks) { taskSheet }
        .sheet(isPresented: $showSubscriptions) { DotsSubscriptionsView() }
        .sheet(isPresented: $showConnectors) {
            DotsConnectorsView { prompt in
                // Hand the connection to Dots: it replies in chat with the credential card.
                store.setDraft(prompt)
                withAnimation(.spring(response: 0.34, dampingFraction: 0.8)) { sentAfterId = store.messages.map(\.id).max() ?? 0 }
                Task { await store.submit() }
            }
        }
        .sheet(isPresented: $showSettings) { DotsSettingsView() }
        .sheet(item: $selectingText) { DotsSelectTextSheet(text: $0.text) }
        .onChange(of: showTasks) { _, visible in
            onTaskSheetPresented(visible)
            if !visible { store.select(nil) }
            voicePresentation.setVisible(isConversationVisible && !visible && !showFiles && attachmentPreview == nil)
            revealApprovalsIfNeeded()
            updateReadingVisibility()
        }
        .onChange(of: isConversationVisible) { _, visible in
            updateReadingVisibility()
            voicePresentation.setVisible(visible && !showTasks && !showFiles && attachmentPreview == nil)
            if visible { scheduleApprovalReveal() }
        }
        .onChange(of: voicePresentation.immersive) { _, _ in updateReadingVisibility() }
        .onChange(of: voicePresentation.form) { _, form in
            if form == .dragging { inputFocused = false }
            if form == .orb { revealApprovalsIfNeeded() }
        }
        .onChange(of: hasApprovalTasks) { _, waiting in
            if waiting { scheduleApprovalReveal() }
        }
        .onChange(of: voicePresentation.active) { _, active in
            if active { scheduleApprovalReveal() }
        }
        .onChange(of: voice.active) { _, active in
            if active { inputFocused = false }
            updateReadingVisibility()
        }
        .onChange(of: showFiles) { _, visible in
            updateReadingVisibility()
            voicePresentation.setVisible(isConversationVisible && !showTasks && !visible && attachmentPreview == nil)
            revealApprovalsIfNeeded()
        }
        .onChange(of: attachmentPreview) { _, preview in
            updateReadingVisibility()
            voicePresentation.setVisible(isConversationVisible && !showTasks && !showFiles && preview == nil)
            revealApprovalsIfNeeded()
        }
        .accessibilityIdentifier("dots-manager-page")
    }
    private func updateReadingVisibility() {
        store.setReadingLatest(scenePhase == .active && isConversationVisible && atBottom &&
            !voicePresentation.immersive && !showTasks && !showFiles && attachmentPreview == nil)
    }
    private func scheduleApprovalReveal() {
        needsApprovalReveal = !pendingApprovals.isEmpty || hasApprovalTasks || pendingApprovalOperation != nil
        revealApprovalsIfNeeded()
    }
    private func revealApprovalsIfNeeded() {
        guard !pendingApprovals.isEmpty || hasApprovalTasks || pendingApprovalOperation != nil else { needsApprovalReveal = false; return }
        guard needsApprovalReveal, isConversationVisible, !showTasks, !showFiles, attachmentPreview == nil,
              voicePresentation.active, voicePresentation.visible, voicePresentation.form == .orb else { return }
        needsApprovalReveal = false
        // Reveal the decision in the conversation without ending or pausing the call.
        voicePresentation.collapse()
    }
    private var assistantMenu: some View {
        ShiyanMoreMenu {
            Button("连接器", systemImage: "point.3.connected.trianglepath.dotted") {
                inputFocused = false; showConnectors = true
            }
            Button("事件订阅", systemImage: "bell.badge") {
                inputFocused = false; showSubscriptions = true
            }
            Button("Dots 设置", systemImage: "gearshape") {
                inputFocused = false; showSettings = true
            }
            Button("任务", systemImage: "list.bullet.rectangle") {
                inputFocused = false; showTasks = true
            }
            Button(store.manager?.status == "active" ? "暂停" : "继续",
                   systemImage: store.manager?.status == "active" ? "pause" : "play") {
                Task { await store.managerControl(store.manager?.status == "active" ? "pause" : "resume") }
            }
            Button("停止全部任务", systemImage: "stop", role: .destructive) {
                Task { await store.managerControl("cancel") }
            }
            Divider()
            Button("刷新", systemImage: "arrow.clockwise") { Task { await store.refresh() } }
        }
        .accessibilityIdentifier("dots-more-menu")
    }
    private var assistantHeader: some View {
        ZStack(alignment: .top) {
            ShiyanFeatureHeader(page: .dots, topInset: 0, hasUnread: hasUnread,
                                onSidebar: onSidebar) { assistantMenu }
            if !voice.active {
                assistantIdentity.padding(.top, 3).padding(.bottom, 8)
            }
        }
        .padding(.top, topInset)
    }
    private var assistantIdentity: some View {
        VStack(spacing: -8) {
            // The sprite includes transparent padding: this gives the reference's
            // roughly 50 × 56 pt visible pet, without changing the animation art.
            DotsLivePet().frame(width: 64, height: 68)
                .allowsHitTesting(false)
            HStack(spacing: 6) {
                Text(managerStatus ?? store.displayName)
                    .font(managerStatus == nil ? .body.weight(.semibold) : .subheadline.weight(.medium))
                    .foregroundStyle(.primary)
                    .multilineTextAlignment(.center).lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                if store.hasPending {
                    Button { Task {
                        if store.hasPendingVoice { await voice.start() }
                        else { await store.retryPending() }
                    } } label: {
                        Group {
                            if store.sending { ProgressView() }
                            else { Image(systemName: "arrow.clockwise") }
                        }.frame(width: 28, height: 28).contentShape(Rectangle())
                    }.buttonStyle(.plain).disabled(store.sending)
                        .accessibilityLabel("重试").accessibilityIdentifier("dots-retry-pending")
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 6)
            .frame(minWidth: 44, minHeight: 40)
            .shiyanGlass(in: Capsule(), tint: .white.opacity(0.04))
            .accessibilityIdentifier("dots-identity-status")
        }
        .frame(maxWidth: 240)
    }
    private var managerStatus: String? {
        if let notice = store.notice, !notice.isEmpty { return notice }
        if !store.connection.isEmpty && !["定时同步", "已连接"].contains(store.connection) { return store.connection }
        if store.uploading { return "正在上传…" }
        if let status = store.approvalStatus { return status }
        if store.sending { return "正在发送…" }
        if store.hasPending { return "发送结果未知，请重试" }
        if store.manager?.status == "paused" { return "已暂停" }
        if store.manager?.status == "cancelled" { return "已停止" }
        if store.messages.last?.role == "assistant" && store.messages.last?.isStreaming == true { return "正在回复…" }
        if (store.manager?.runningWorkers ?? 0) > 0 || store.currentTasks.contains(where: { $0.status == "running" }) {
            return "正在处理事项…"
        }
        if store.currentTasks.contains(where: { ["waiting_approval", "awaiting_approval", "needs_approval"].contains($0.status ?? "") }) {
            return "需要你批准操作"
        }
        if store.currentTasks.contains(where: { $0.status == "done" && $0.acceptanceStatus == "pending" && $0.legacyImported != true }) {
            return "正在验收…"
        }
        if store.currentTasks.contains(where: { ["active", "pending", "queued"].contains($0.status ?? "") }) { return "等待执行" }
        if store.currentTasks.first?.status == "failed" { return "处理失败" }
        if store.loading && store.messages.isEmpty { return "正在加载…" }
        if store.messages.last?.role == "user" { return "正在回复…" }
        return nil
    }
    private func managerTimestamp(_ value: Double?) -> String? {
        guard let value, value.isFinite, value > 0 else { return nil }
        let date = Date(timeIntervalSince1970: value > 1e12 ? value / 1000 : value)
        let calendar = Calendar.current
        let now = Date()
        let prefix: String
        if calendar.isDate(date, inSameDayAs: now) { prefix = "今天" }
        else if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) { prefix = "昨天" }
        else {
            let day = calendar.component(.day, from: date), month = calendar.component(.month, from: date)
            let year = calendar.component(.year, from: date)
            prefix = calendar.component(.year, from: now) == year ? "\(month)月\(day)日" : "\(year)年\(month)月\(day)日"
        }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN"); formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone; formatter.dateFormat = "HH:mm"
        return prefix + " " + formatter.string(from: date)
    }
    private func managerMessage(_ item: DotsManagerMessage) -> some View {
        HStack(alignment: .top) {
            if item.role == "user" { Spacer(minLength: 28) }
            VStack(alignment: .leading, spacing: 8) {
                if item.role == "system" {
                    Text("状态").font(.caption).foregroundStyle(.secondary)
                }
                if item.role == "user" {
                    let parts = DotsQuote.split(item.content)
                    if let quote = parts.quote { DotsQuoteBlock(text: quote) }
                    Text(parts.body).font(.body).lineSpacing(5)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("dots-user-bubble-\(item.id)")
                } else {
                    AgentMarkdown(text: item.content, identifier: "dots-manager-message-\(item.id)")
                }
                ForEach(item.attachments ?? []) { attachment in
                    Button {
                        Task {
                            do { attachmentPreview = try await CodexClient.shared.dotsAttachmentFile(attachment) }
                            catch { store.notice = error.localizedDescription }
                        }
                    } label: {
                        Label(attachment.filename, systemImage: "doc")
                            .font(.subheadline).lineLimit(2).padding(10)
                            .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 12))
                    }.buttonStyle(.plain).foregroundStyle(.primary)
                }
            }
            .padding(item.role == "system" ? 0 : 14)
            .background { if item.role != "system" { DotsBubbleBackground(isUser: item.role == "user") } }
            .contentShape(.contextMenuPreview, RoundedRectangle(cornerRadius: 20, style: .continuous))
            .contextMenu {
                if item.role != "system" {
                    Button("回复", systemImage: "arrowshape.turn.up.left") { beginReply(item) }
                }
                Button {
                    UIPasteboard.general.string = item.role == "user" ? DotsQuote.split(item.content).body : item.content
                    UINotificationFeedbackGenerator().notificationOccurred(.success)
                } label: { Label { Text("复制") } icon: { Image(uiImage: AgentCopyStyle.menuImage) } }
                Button("选择文本", systemImage: "selection.pin.in.out") {
                    selectingText = DotsSelectionText(text: item.role == "user" ? DotsQuote.split(item.content).body : item.content)
                }
                if item.isProactive {
                    Divider()
                    Button(item.feedback == "useful" ? "已标记有用" : "有用", systemImage: item.feedback == "useful" ? "hand.thumbsup.fill" : "hand.thumbsup") {
                        sendFeedback(item, item.feedback == "useful" ? "clear" : "useful")
                    }
                    Button(item.feedback == "not_useful" ? "已标记没用" : "没用，以后少推这类", systemImage: item.feedback == "not_useful" ? "hand.thumbsdown.fill" : "hand.thumbsdown") {
                        sendFeedback(item, item.feedback == "not_useful" ? "clear" : "not_useful")
                    }
                }
            }
            .overlay(alignment: .bottomTrailing) {
                if item.isProactive, let feedback = item.feedback {
                    Image(systemName: feedback == "useful" ? "hand.thumbsup.fill" : "hand.thumbsdown.fill")
                        .font(.system(size: 10, weight: .semibold)).foregroundStyle(.white)
                        .frame(width: 20, height: 20).background(Color.accentColor, in: Circle())
                        .offset(x: 6, y: 6).transition(.scale.combined(with: .opacity))
                }
            }
            if item.role == "user" { EmptyView() } else { Spacer(minLength: 28) }
        }
    }
    private func sendFeedback(_ item: DotsManagerMessage, _ value: String) {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        Task {
            do { try await CodexClient.shared.dotsMessageFeedback(item.id, value: value); await store.refresh() }
            catch { store.notice = error.localizedDescription }
        }
    }
    private func isBlankReply(_ item: DotsManagerMessage) -> Bool {
        item.role == "assistant" && (item.attachments ?? []).isEmpty && item.card == nil &&
            item.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    private func beginReply(_ item: DotsManagerMessage) {
        withAnimation(.spring(response: 0.34, dampingFraction: 0.82)) { replyTarget = item }
        inputFocused = true
    }
    /// True from the tap on send until the first words of the reply arrive.
    private var awaitingReply: Bool {
        if voice.active { return false }
        if store.hasPending && !store.sending { return false }
        if let base = sentAfterId {
            return !store.messages.contains { $0.id > base && $0.role == "assistant" && !isBlankReply($0) }
        }
        if store.sending { return true }
        guard let last = store.messages.last else { return false }
        if last.role == "assistant" { return last.isStreaming && isBlankReply(last) }
        guard last.role == "user", !["paused", "cancelled"].contains(store.manager?.status ?? ""),
              let created = last.createdAt else { return false }
        let seconds = created > 1e12 ? created / 1000 : created
        return Date().timeIntervalSince1970 - seconds < 300
    }
    private func composer(bottomGap: CGFloat) -> some View {
        // Use the arriving glass's progress for the native editor and controls.
        let amount = voicePresentation.active && voicePresentation.visible
            ? voicePresentation.material.materialAmount : 0
        let controlInk = Color.primary.mix(with: scheme == .dark
            ? Color(red: 189/255, green: 199/255, blue: 245/255)
            : Color(red: 93/255, green: 98/255, blue: 169/255), by: amount, in: .device)
        let promptInk = Color(uiColor: .placeholderText).mix(with: scheme == .dark
            ? Color(red: 197/255, green: 201/255, blue: 232/255)
            : Color(red: 85/255, green: 93/255, blue: 137/255), by: amount, in: .device)
        let inputInk = Color.primary.mix(with: scheme == .dark ? .white : .black,
                                         by: amount, in: .device)
        let sendBase = voiceButtonMode && voice.active ? Color.red : Color.accentColor
        let sendFill = LinearGradient(colors: [
            sendBase.mix(with: Color(red: 98/255, green: 91/255, blue: 209/255), by: amount, in: .device),
            sendBase.mix(with: Color(red: 129/255, green: 98/255, blue: 185/255), by: amount, in: .device)
        ], startPoint: .topLeading, endPoint: .bottomTrailing)
        return VStack(alignment: .leading, spacing: 8) {
            if let reply = replyTarget {
                HStack(spacing: 10) {
                    Capsule().fill(Color.accentColor).frame(width: 3)
                    VStack(alignment: .leading, spacing: 2) {
                        Label(reply.role == "user" ? "回复自己" : "回复 \(store.displayName)",
                              systemImage: "arrowshape.turn.up.left.fill")
                            .font(.caption.weight(.semibold)).foregroundStyle(Color.accentColor)
                            .labelStyle(.titleAndIcon)
                        Text(DotsQuote.excerpt(reply.content)).font(.caption).foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                    Spacer(minLength: 4)
                    Button {
                        withAnimation(.spring(response: 0.3, dampingFraction: 0.85)) { replyTarget = nil }
                    } label: {
                        Image(systemName: "xmark.circle.fill").font(.system(size: 18))
                            .foregroundStyle(.secondary).frame(width: 30, height: 30).contentShape(Rectangle())
                    }.buttonStyle(.plain).accessibilityLabel("取消回复")
                }
                .fixedSize(horizontal: false, vertical: true)
                .padding(.leading, 10).padding(.trailing, 4).padding(.vertical, 6)
                .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 15, style: .continuous))
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .accessibilityIdentifier("dots-reply-preview")
            }
            if !store.attachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(store.attachments) { attachment in
                            HStack(spacing: 6) {
                                Image(systemName: "doc")
                                Text(attachment.filename).font(.caption).lineLimit(1)
                                Button { store.removeAttachment(attachment.id) } label: {
                                    Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                                }.disabled(store.hasPending || store.uploading)
                                    .accessibilityLabel("移除 " + attachment.filename)
                            }.padding(8).background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 12))
                        }
                    }
                }
            }
        HStack(alignment: .bottom, spacing: 12) {
            Button { inputFocused = false; showFiles = true } label: {
                Group {
                    if store.uploading { ProgressView() }
                    else { Image(systemName: "plus").font(.system(size: 22)) }
                }.frame(width: 34, height: 36).contentShape(Rectangle())
            }.buttonStyle(.plain).foregroundStyle(controlInk).tint(controlInk)
                .disabled(store.hasPending || store.sending || store.uploading)
                .accessibilityLabel("添加文件").accessibilityIdentifier("dots-add-attachment")
            TextField("交给我…", text: Binding(get: { store.draft }, set: store.setDraft),
                      prompt: Text("交给我…").foregroundColor(promptInk), axis: .vertical)
                .lineLimit(1...(inputFocused ? 6 : 1)).font(.body).focused($inputFocused)
                .foregroundStyle(inputInk)
                .frame(minHeight: 36)
                .disabled(store.hasPending).accessibilityIdentifier("dots-composer")
            Button {
                inputFocused = false
                if voiceButtonMode { Task { await voice.toggle() } }
                else {
                    // Show the thinking state on the same frame as the tap.
                    let quote = replyTarget.map { DotsQuote.excerpt($0.content) }
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    withAnimation(.spring(response: 0.34, dampingFraction: 0.8)) {
                        sentAfterId = store.messages.map(\.id).max() ?? 0
                        replyTarget = nil
                    }
                    Task { await store.submit(quote: quote) }
                }
            } label: {
                Group {
                    if store.sending && !voiceButtonMode { ProgressView() }
                    else {
                        Image(systemName: voiceButtonMode ? (voice.active ? "stop.fill" : "waveform") : "arrow.up")
                            .font(.system(size: 19, weight: .bold))
                    }
                }.foregroundStyle(.white)
                    .frame(width: 36, height: 36)
                    .background(sendFill, in: Circle())
            }
            .buttonStyle(.plain)
            .disabled(voiceButtonMode ? (!voice.active && !store.canStartVoice) : !store.canSend)
            .accessibilityLabel(voiceButtonMode ? (voice.active ? "结束语音聊天" : "语音实时聊天") : "发送")
            .accessibilityIdentifier("dots-send")
        }
        }.padding(10)
            .background { DotsVoiceComposerMaterial(presentation: voicePresentation, cornerRadius: 25) }
            .agentComposerSurface(cornerRadius: 25)
            .overlay(alignment: .top) {
                DotsVoiceFlowHandle(presentation: voicePresentation,
                                    travel: max(175, UIScreen.main.bounds.height * 0.38))
                    .offset(y: -12)
            }
            .frame(maxWidth: inputFocused || replyTarget != nil || !store.draft.isEmpty || !store.attachments.isEmpty ? .infinity : 325)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 16).padding(.bottom, bottomGap).padding(.top, 8)
    }
    private var voiceButtonMode: Bool {
        store.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && store.attachments.isEmpty
    }
    private var taskSheet: some View {
        GeometryReader { geometry in
            NavigationStack {
                ScrollView {
                    VStack(alignment: .leading, spacing: 24) {
                        if let goal = store.selected { taskDetail(goal) }
                        else {
                            activityPanel

                        }
                    }.padding(24).frame(maxWidth: .infinity, alignment: .leading)
                }.scrollIndicators(.hidden).refreshable { await store.loadActivity() }
                    .navigationTitle(voice.active ? "" : "任务")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        if voice.active {
                            ToolbarItem(placement: .principal) {
                                DotsVoiceCallCard()
                                    .frame(width: DotsVoiceCallLayout.width(in: geometry.size.width))
                            }
                            .sharedBackgroundVisibility(.hidden)
                        }
                        ToolbarItem(placement: .topBarLeading) {
                            if store.selected != nil { ShiyanCloseButton(action: { showTasks = false }, inToolbar: true) }
                        }
                        ToolbarItem(placement: .topBarTrailing) {
                            if let goal = store.selected { taskMoreMenu(goal) }
                            else { ShiyanCloseButton(action: { showTasks = false }, inToolbar: true) }
                        }
                        .sharedBackgroundVisibility(store.selected == nil ? .automatic : .hidden)
                    }
            }
        }
        .task { store.select(nil); processExpanded = false; await store.loadActivity() }
        .onChange(of: store.state.selectedGoalId) { _, _ in processExpanded = false }
        .quickLookPreview($attachmentPreview)
        .sheet(isPresented: $schedulePresented) { scheduleEditor }
        .sheet(item: $approval) { item in approvalPreview(item) }
        .sheet(item: $outputPreview) { item in fullOutput(item) }
    }
    private var activityPanel: some View {
        VStack(alignment: .leading, spacing: 22) {
            HStack(spacing: 14) {
                if !voice.active { DotsIdentityIcon().frame(width: 66, height: 72) }
                VStack(alignment: .leading, spacing: 8) {
                    Text(store.displayName).font(.title2.weight(.semibold))
                    Text(lastActiveText).font(.subheadline).foregroundStyle(.secondary)
                }
            }.padding(.bottom, 4)
            HStack {
                Text("最近活动").foregroundStyle(.secondary)
                Spacer()
                Button { editingSchedule = DotsSchedule(startDate: Date().formatted(.iso8601.year().month().day().dateSeparator(.dash))); schedulePresented = true } label: {
                    Image(systemName: "plus").foregroundStyle(.secondary)
                }.accessibilityLabel("新建定时任务")
            }
            VStack(spacing: 2) {
                ForEach(historyExpanded ? store.panelActivities : Array(store.panelActivities.prefix(5))) { item in
                    Button {
                        if item.type == "schedule" { editingSchedule = item.schedule; schedulePresented = true }
                        else if let id = item.taskId { processExpanded = false; store.select(id) }
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: item.type == "schedule" ? "clock" : "bubble.left").foregroundStyle(.secondary).frame(width: 22)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(item.title ?? "未命名任务").lineLimit(1)
                                if let schedule = item.schedule {
                                    Text(schedule.enabled ? "\(repeatLabel(schedule.repeat)) · \(schedule.time)" : "已暂停").font(.caption).foregroundStyle(.secondary)
                                }
                            }
                            Spacer(minLength: 4)
                            if item.unread == true { Circle().fill(Color.accentColor).frame(width: 6, height: 6) }
                        }.padding(.horizontal, 10).padding(.vertical, 9).contentShape(Capsule())
                    }.buttonStyle(DotsActivityRowStyle())
                }
                if store.panelActivities.isEmpty { Text("还没有活动").foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading) }
                if store.panelActivities.count > 5 { moreButton(expanded: $historyExpanded) }
            }
            Text("输出内容").foregroundStyle(.secondary).padding(.top, 8)
            VStack(spacing: 2) {
                ForEach(outputsExpanded ? store.panelOutputs : Array(store.panelOutputs.prefix(3))) { item in
                    Button {
                        Task {
                            do { attachmentPreview = try await CodexClient.shared.dotsPanelFile(item) }
                            catch { store.notice = "文件暂不可用，请重试" }
                        }
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: (item.mimeType ?? "").hasPrefix("image/") ? "photo" : "doc").foregroundStyle(.secondary).frame(width: 22)
                            Text(item.filename ?? "任务结果").lineLimit(1)
                            Spacer(minLength: 0)
                        }.padding(.horizontal, 10).padding(.vertical, 9).contentShape(Capsule())
                    }.buttonStyle(DotsActivityRowStyle())
                }
                if store.panelOutputs.isEmpty { Text("任务产出会显示在这里").font(.subheadline).foregroundStyle(.secondary) }
                if store.panelOutputs.count > 3 { moreButton(expanded: $outputsExpanded) }
            }
        }
    }
    private var lastActiveText: String {
        guard let value = store.panelActivities.compactMap(\.updatedAt).max() else { return "上次活跃：暂无活动" }
        let date = Date(timeIntervalSince1970: value > 1e12 ? value / 1000 : value)
        return "上次活跃：" + RelativeDateTimeFormatter().localizedString(for: date, relativeTo: Date())
    }
    private func moreButton(expanded: Binding<Bool>) -> some View {
        Button { expanded.wrappedValue.toggle() } label: {
            HStack(spacing: 12) {
                Image(systemName: expanded.wrappedValue ? "chevron.up" : "chevron.down").frame(width: 22)
                Text(expanded.wrappedValue ? "收起" : "显示更多")
                Spacer()
            }.foregroundStyle(.secondary).padding(10)
        }.buttonStyle(.plain)
    }
    private func repeatLabel(_ value: String) -> String {
        ["once":"不重复", "daily":"每天", "weekdays":"工作日", "weekly":"每周", "monthly":"每月"][value] ?? value
    }
    private var scheduleEditor: some View {
        NavigationStack {
            if let value = editingSchedule {
                Form {
                    TextField("任务名称", text: scheduleBinding(\.title))
                    TextEditor(text: scheduleBinding(\.instruction)).frame(minHeight: 130)
                    Toggle("启用任务", isOn: scheduleBinding(\.enabled))
                    Picker("重复", selection: scheduleBinding(\.repeat)) {
                        ForEach(["once", "daily", "weekdays", "weekly", "monthly"], id: \.self) { Text(repeatLabel($0)).tag($0) }
                    }
                    TextField("执行时间（HH:mm）", text: scheduleBinding(\.time))
                    Picker("时区", selection: scheduleBinding(\.timezone)) {
                        ForEach(Array(Set(["Asia/Shanghai", "Asia/Singapore", "UTC", value.timezone])).sorted(), id: \.self) { Text($0).tag($0) }
                    }
                    TextField("开始日期（YYYY-MM-DD）", text: scheduleBinding(\.startDate))
                    TextField("结束日期（留空为永不）", text: Binding(get: { editingSchedule?.endDate ?? "" }, set: { editingSchedule?.endDate = $0.isEmpty ? nil : $0 }))
                    Button(store.hasPending ? "重试保存" : "保存") {
                        guard let current = editingSchedule else { return }
                        Task {
                            if store.hasPending { await store.retryPending(); await store.loadActivity() }
                            else { await store.saveSchedule(current) }
                            if !store.hasPending && store.notice == nil { schedulePresented = false }
                        }
                    }.disabled(store.sending || value.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || value.instruction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    if let notice = store.notice { Text(notice).foregroundStyle(.red) }
                }.disabled(store.sending)
                    .navigationTitle(value.id == nil ? "新建定时任务" : "编辑任务")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar { ToolbarItem(placement: .topBarTrailing) { ShiyanCloseButton(action: { schedulePresented = false }, inToolbar: true) } }
            }
        }
    }
    private func scheduleBinding<T>(_ keyPath: WritableKeyPath<DotsSchedule, T>) -> Binding<T> {
        Binding(get: { (editingSchedule ?? DotsSchedule())[keyPath: keyPath] }, set: { editingSchedule?[keyPath: keyPath] = $0 })
    }
    private func taskRow(id: Int, title: String, status: String) -> some View {
        Button { processExpanded = false; store.select(id) } label: {
            HStack {
                VStack(alignment: .leading, spacing: 6) {
                    Text(title).font(.body.weight(.medium)).lineLimit(2)
                    Text(status).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: "chevron.right").font(.caption).foregroundStyle(.secondary)
            }.contentShape(Rectangle())
        }.buttonStyle(.plain).foregroundStyle(.primary).accessibilityIdentifier("dots-task-\(id)")
    }
    private func taskMoreMenu(_ goal: DotsGoal) -> some View {
        ShiyanMoreMenu(inToolbar: true) {
            Button("返回任务列表", systemImage: "list.bullet") { store.select(nil); processExpanded = false }
            ForEach(goal.allowedActions, id: \.self) { action in
                Button(action == "pause" ? "暂停任务" : action == "resume" ? "继续任务" : action == "cancel" ? "停止任务" : "立即检查") {
                    Task { await store.control(action) }
                }.disabled(store.sending || store.hasPending)
            }
        }
    }
    private func taskDetail(_ goal: DotsGoal) -> some View {
        VStack(alignment: .leading, spacing: 22) {
            Text(goal.displayTitle).font(.title2.weight(.semibold))
            HStack {
                Text(goal.statusText).font(.subheadline).foregroundStyle(.secondary)
                Spacer()

            }
            ForEach(store.taskConversation) { message in
                HStack {
                    if message.role == "user" { Spacer(minLength: 40) }
                    AgentMarkdown(text: message.content, identifier: "dots-worker-" + message.id)
                        .padding(message.role == "user" ? 12 : 0)
                        .background(message.role == "user" ? Color.primary.opacity(0.06) : .clear, in: RoundedRectangle(cornerRadius: 18))
                    if message.role != "user" { Spacer(minLength: 0) }
                }
            }
            if store.taskConversation.isEmpty, let summary = goal.last_summary, !summary.isEmpty {
                AgentMarkdown(text: summary, identifier: "dots-task-summary-\(goal.id)")
            }
            ForEach((goal.approvals ?? []).filter(\.isPending)) { item in
                Button { approval = DotsApprovalContext(goalId: goal.id, title: goal.displayTitle, approval: item) } label: {
                    Label("需要你批准操作", systemImage: "hand.raised")
                }.buttonStyle(.plain)
            }
            ForEach(store.taskConversation.isEmpty ? (goal.outputs ?? []) : []) { output in
                VStack(alignment: .leading, spacing: 10) {
                    AgentMarkdown(text: output.summary ?? output.notification ?? "结果已保存", identifier: "dots-task-output-\(output.id)")
                    Button("查看完整结果") {
                        Task {
                            do { outputPreview = try await store.output(output.id) }
                            catch { store.notice = "结果暂不可用，请重试" }
                        }
                    }.font(.footnote).buttonStyle(.plain).foregroundStyle(.secondary)
                }
            }
            DisclosureGroup("处理过程", isExpanded: $processExpanded) {
                VStack(alignment: .leading, spacing: 14) {
                    ForEach(goal.timeline ?? []) { item in
                        Text(item.message ?? item.kind ?? "状态已更新").font(.subheadline).textSelection(.enabled)
                    }
                }.padding(.top, 12)
            }.tint(.secondary).accessibilityIdentifier("dots-process")
        }
    }
    private func fullOutput(_ output: DotsOutput) -> some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    AgentMarkdown(text: output.summary ?? "", identifier: "dots-full-output-\(output.id)")
                    if let raw = output.raw_result, !raw.isEmpty {
                        DisclosureGroup("原始数据") {
                            Text(String(raw.prefix(16000))).font(.system(.footnote, design: .monospaced)).textSelection(.enabled)
                            Button("复制完整数据") { UIPasteboard.general.string = raw }
                        }
                    }
                }.padding(24)
            }.navigationTitle("执行结果").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .topBarTrailing) { ShiyanCloseButton(action: { outputPreview = nil }, inToolbar: true) } }
        }
    }
    private var pendingApprovals: [DotsApprovalContext] {
        store.approvalGoals.flatMap { goal in
            (goal.approvals ?? []).filter(\.isPending).map {
                DotsApprovalContext(goalId: goal.id, title: goal.displayTitle, approval: $0)
            }
        }
    }
    private var hasApprovalTasks: Bool {
        store.currentTasks.contains { ["waiting_approval", "awaiting_approval", "needs_approval"].contains($0.status ?? "") }
    }
    private var pendingApprovalOperation: DotsPendingOperation? {
        guard let operation = store.state.pending, operation.route.contains("/approvals/"),
              operation.route.hasSuffix("/decision"), operation.goalId != nil,
              ["approve", "reject"].contains(operation.decision ?? "") else { return nil }
        return operation
    }
    private var unresolvedApprovalOperation: DotsPendingOperation? {
        guard let operation = pendingApprovalOperation else { return nil }
        let hasOriginalCard = pendingApprovals.contains { context in
            operation.route == "goals/\(context.goalId)/approvals/\(context.approval.id)/decision" &&
                operation.confirmedCommand == context.approval.command
        }
        return hasOriginalCard ? nil : operation
    }
    private func pendingApprovalCard(_ operation: DotsPendingOperation) -> some View {
        let goalId = operation.goalId ?? 0
        let goal = store.state.details[String(goalId)] ?? store.goals.first { $0.id == goalId }
        return VStack(alignment: .leading, spacing: 14) {
            Label(store.sending ? "正在提交你的决定…" : "操作决定结果未知", systemImage: "hand.raised")
                .font(.subheadline.weight(.semibold))
            Text(goal?.displayTitle ?? "待核实的操作").font(.body.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
            Text(operation.decision == "approve" ? "你已提交批准，以下是当时确认的命令。" : "你已提交拒绝，以下是当时显示的命令。")
                .font(.subheadline).foregroundStyle(.secondary)
            Text(operation.confirmedCommand ?? "命令尚未提供")
                .font(.system(.footnote, design: .monospaced)).textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading).padding(12)
                .background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 12))
            if store.sending {
                ProgressView().accessibilityLabel("正在提交你的决定")
            } else {
                Text("请重试原决定以核实结果。")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            Button(operation.decision == "approve" ? "重试批准" : "重试拒绝") {
                Task { await store.retryPending() }
            }.buttonStyle(.borderedProminent).disabled(store.sending)
                .accessibilityIdentifier("dots-approval-retry-pending")
        }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.primary.opacity(0.025), in: RoundedRectangle(cornerRadius: 18))
            .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(Color.primary.opacity(0.09)))
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("dots-approval-pending-result")
    }
    static let approvalScopeOptions: [(String, String)] = [("once", "仅这一次"), ("task", "这个任务内都允许"), ("hour", "1 小时内都允许"), ("day", "24 小时内都允许"), ("always", "以后一直允许")]
    private func approvalCard(_ item: DotsApproval, goalId: Int, title: String) -> some View {
        let originalCommandShown = pendingApprovalOperation?.confirmedCommand == item.command
        let priorDecision = originalCommandShown ? store.pendingApprovalDecision(goalId: goalId, approvalId: item.id) : nil
        let submitting = originalCommandShown && store.isSubmittingApproval(goalId: goalId, approvalId: item.id)
        let available = item.isPending && !store.sending && (!store.hasPending || priorDecision != nil)
        return VStack(alignment: .leading, spacing: 14) {
            Label(item.isPending ? "需要你批准操作" : item.status == "executing" ? "正在执行已批准的操作…" : "操作已处理",
                  systemImage: item.isPending ? "hand.raised" : "checkmark.circle")
                .font(.subheadline.weight(.semibold))
            Text(title).font(.body.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
            Text(item.reason?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
                 ? item.reason! : "请核对以下实际命令后决定是否执行。")
                .font(.subheadline).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Text(item.command?.isEmpty == false ? item.command! : "命令尚未提供")
                .font(.system(.footnote, design: .monospaced))
                .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading).padding(12)
                .background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 12))
                .accessibilityIdentifier("dots-approval-command-\(goalId)-\(item.id)")
            if item.isPending, item.canApproveCommand, let labels = item.grant_labels, !labels.isEmpty {
                let key = "\(goalId):\(item.id)", scope = approvalScopes[key] ?? "once"
                VStack(alignment: .leading, spacing: 4) {
                    Menu {
                        Picker("批准范围", selection: Binding(get: { approvalScopes[key] ?? "once" }, set: { approvalScopes[key] = $0; UISelectionFeedbackGenerator().selectionChanged() })) {
                            ForEach(Self.approvalScopeOptions, id: \.0) { Text($0.1).tag($0.0) }
                        }
                    } label: {
                        HStack(spacing: 6) {
                            Text("批准范围").foregroundStyle(.secondary)
                            Text(Self.approvalScopeOptions.first { $0.0 == scope }?.1 ?? "仅这一次").foregroundStyle(.primary)
                            Image(systemName: "chevron.up.chevron.down").font(.caption2).foregroundStyle(.secondary)
                        }.font(.subheadline)
                    }.disabled(!available)
                    Text(scope == "once" ? "只执行上面这条命令。" : "同类操作（\(labels.joined(separator: "、"))）之后自动执行，可在 Dots 设置里撤销。")
                        .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            }
            if !item.canApproveCommand {
                Text("命令尚未完整，无法批准；可以拒绝并让 Dots 重新评估。")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            if submitting {
                HStack(spacing: 8) {
                    ProgressView()
                    Text("正在提交你的决定…").font(.footnote).foregroundStyle(.secondary)
                }
            } else if priorDecision != nil {
                Text("操作决定结果未知，请重试原决定以核实结果。")
                    .font(.footnote).foregroundStyle(.secondary)
            } else if store.hasPending {
                Text("请先处理尚未确认的请求。")
                    .font(.footnote).foregroundStyle(.secondary)
            } else if !item.isPending {
                Text(item.status == "executing" ? "正在执行已批准的操作…" : "这项操作已处理")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            if item.isPending { HStack(spacing: 16) {
                Button(priorDecision == "approve" ? "重试批准" : "批准此命令") {
                    Task { await store.decide(item, goalId: goalId, approve: true, scope: approvalScopes["\(goalId):\(item.id)"] ?? "once") }
                }.buttonStyle(.borderedProminent)
                    .disabled(!available || !item.canApproveCommand || (priorDecision != nil && priorDecision != "approve"))
                    .accessibilityIdentifier("dots-approval-approve-\(goalId)-\(item.id)")
                Button(priorDecision == "reject" ? "重试拒绝" : "拒绝", role: .destructive) {
                    Task { await store.decide(item, goalId: goalId, approve: false) }
                }.buttonStyle(.bordered)
                    .disabled(!available || (priorDecision != nil && priorDecision != "reject"))
                    .accessibilityIdentifier("dots-approval-reject-\(goalId)-\(item.id)")
            } }
        }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.primary.opacity(0.025), in: RoundedRectangle(cornerRadius: 18))
            .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(Color.primary.opacity(0.09)))
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("dots-approval-card-\(goalId)-\(item.id)")
    }
    private func approvalPreview(_ context: DotsApprovalContext) -> some View {
        let currentGoal = store.state.details[String(context.goalId)] ?? store.goals.first { $0.id == context.goalId }
        let item: DotsApproval? = currentGoal == nil ? context.approval
            : currentGoal?.approvals?.first { $0.id == context.approval.id }
        return NavigationStack {
            ScrollView {
                if let item {
                    approvalCard(item, goalId: context.goalId, title: currentGoal?.displayTitle ?? context.title)
                        .padding(24)
                } else {
                    Label("这项操作已处理", systemImage: "checkmark.circle")
                        .foregroundStyle(.secondary).padding(24)
                }
            }.navigationTitle("批准操作").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .topBarTrailing) { ShiyanCloseButton(action: { approval = nil }, inToolbar: true) } }
        }
    }
}

private struct DotsActivityRowStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.foregroundStyle(.primary)
            .background(configuration.isPressed ? Color.primary.opacity(0.07) : .clear, in: Capsule())
    }
}

struct DotsLivePet: View {
    @ObservedObject private var store = DotsStore.shared
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var phase
    private var motion: (row: Int, frames: Int, fps: Double) {
        if store.manager?.status == "paused" || store.manager?.status == "cancelled" { return (6,6,8) }
        if store.sending || store.uploading || (store.manager?.runningWorkers ?? 0) > 0 ||
            store.currentTasks.contains(where: { $0.status == "running" }) { return (7,6,8) }
        if store.currentTasks.contains(where: { ["waiting_approval", "awaiting_approval", "needs_approval", "blocked"].contains($0.status ?? "") ||
            $0.acceptanceStatus == "pending" && $0.status == "done" }) { return (8,6,8) }
        if store.currentTasks.first?.status == "failed" { return (5,8,8) }
        return (0,6,6)
    }
    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 8, paused: reduceMotion || phase != .active)) { tick in
            if let image = DotsPetFrames.frame(id: store.state.profile?.petId ?? "", row: motion.row,
                column: reduceMotion ? 0 : Int(tick.date.timeIntervalSince1970 * motion.fps) % motion.frames) {
                Image(uiImage: image).resizable().scaledToFit()
            } else { DotsIdentityIcon() }
        }.accessibilityLabel("Dots 宠物")
    }
}
private enum DotsPetFrames {
    static let frames = NSCache<NSString, UIImage>()
    static var sheets: [String: UIImage] = [:]
    static func frame(id: String, row: Int, column: Int) -> UIImage? {
        let key = "\(id):\(row):\(column)" as NSString
        if let cached = frames.object(forKey: key) { return cached }
        guard id.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil else { return nil }
        if sheets[id] == nil, let url = Bundle.main.url(forResource: "dots-sprite-" + id, withExtension: "png"), let image = UIImage(contentsOfFile: url.path) { sheets[id] = image }
        guard let sheet = sheets[id]?.cgImage else { return nil }
        let width = sheet.width / 8, height = 208
        guard let crop = sheet.cropping(to: CGRect(x: column * width, y: row * height, width: width, height: height)) else { return nil }
        let image = UIImage(cgImage: crop);frames.setObject(image, forKey: key);return image
    }
}


struct DotsSubscriptionsResponse: Decodable {
    let subscriptions: [DotsSubscription]
}
struct DotsSubscription: Decodable, Identifiable {
    let provider: String
    let configured: Bool
    let enabled: Bool
    let status: String?
    let credentialsConfigured: Bool?
    let repository: String?
    let address: String?
    let calendarId: String?
    let accountKey: String?
    var id: String { provider }
}

/// 连接器和事件订阅共用的一行：图标 · 名称 · 一行说明 · 右侧内容。
struct DotsSourceRow<Trailing: View>: View {
    var symbol: String
    var name: String
    var subtitle: String?
    var active = false
    @ViewBuilder var trailing: () -> Trailing
    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: symbol)
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(active ? Color.accentColor : Color.primary)
                .frame(width: 32, height: 32)
                .background((active ? Color.accentColor : Color.primary).opacity(active ? 0.12 : 0.06),
                            in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(name).font(.body.weight(.semibold))
                if let subtitle, !subtitle.isEmpty {
                    Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            trailing()
        }
        .padding(.vertical, 2)
    }
}
struct DotsSourceState: View {
    var text: String
    var state: String
    private var color: Color {
        switch state { case "connected": return .green; case "error": return .red; case "paused": return .orange; default: return .secondary }
    }
    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(color).frame(width: 6, height: 6)
            Text(text).font(.caption).foregroundStyle(.secondary)
        }.fixedSize()
    }
}

/// 事件订阅：只列出已订阅的来源；新增订阅在 Dots 对话里完成。
private struct DotsSubscriptionsView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var subscriptions: [DotsSubscription] = []
    @State private var error: String?
    @State private var loading = true
    @State private var removing: DotsSubscription?
    @State private var client = CodexClient()
    private let titles = ["github": "GitHub", "email": "邮箱", "google-calendar": "Google 日历", "rss": "RSS"]
    private let symbols = ["github": "chevron.left.forwardslash.chevron.right", "email": "envelope", "google-calendar": "calendar", "rss": "dot.radiowaves.up.forward"]
    private func state(_ item: DotsSubscription) -> (String, String) {
        if !item.enabled { return ("已暂停", "paused") }
        if ["backoff", "error", "failed", "waiting_authorization"].contains(item.status ?? "") { return ("需要处理", "error") }
        return ("接收中", "connected")
    }
    var body: some View {
        NavigationStack {
            List {
                let active = subscriptions.filter { $0.configured }
                Section {
                    if loading && active.isEmpty { ProgressView().frame(maxWidth: .infinity) }
                    if !loading && active.isEmpty { Text("还没有订阅").foregroundStyle(.secondary) }
                    ForEach(active) { item in
                        let s = state(item)
                        DotsSourceRow(symbol: symbols[item.provider] ?? "bell", name: titles[item.provider] ?? item.provider,
                                      subtitle: item.repository ?? item.address ?? (item.calendarId == "primary" ? nil : item.calendarId),
                                      active: s.1 == "connected") {
                            DotsSourceState(text: s.0, state: s.1)
                        }
                        .swipeActions { Button("取消订阅", role: .destructive) { removing = item } }
                        .contextMenu { Button("取消订阅", systemImage: "xmark.circle", role: .destructive) { removing = item } }
                    }
                } footer: { Text("在对话里告诉 Dots 想订阅什么。左滑可取消订阅。") }
                if let error { Text(error).font(.footnote).foregroundStyle(.red) }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("事件订阅").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { ShiyanCloseButton(action: { dismiss() }, inToolbar: true) } }
            .confirmationDialog("取消这项订阅？", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible) {
                Button("取消订阅", role: .destructive) {
                    guard let item = removing else { return }
                    Task { @MainActor in
                        do { subscriptions = try await client.dotsSubscriptions(item.provider, method: "DELETE").subscriptions }
                        catch { self.error = error.localizedDescription }
                    }
                }
            } message: { Text("之后可以随时重新订阅。") }
            .task {
                defer { loading = false }
                do { subscriptions = try await client.dotsSubscriptions().subscriptions }
                catch { self.error = error.localizedDescription }
            }
        }
        .presentationDragIndicator(.visible)
    }
}

/// Dots 对话里的订阅卡片。凭据直接提交到订阅接口，不进模型、不进聊天记录。
private struct DotsSubscriptionCardView: View {
    let card: DotsSubscriptionCard
    let messageId: Int
    @State private var values: [String: String] = [:]
    @State private var busy = false
    @State private var done = false
    @State private var error: String?
    @State private var client = CodexClient()
    private var name: String { ["github": "GitHub", "email": "邮箱", "google-calendar": "Google 日历", "rss": "RSS"][card.provider] ?? card.provider }
    var body: some View {
        if card.state != "open" || done {
            Text(card.action == "unsubscribe" ? "已取消订阅 \(name)" : "已订阅 \(name)")
                .font(.footnote).foregroundStyle(.secondary)
                .padding(.horizontal, 12).padding(.vertical, 6)
                .background(.quaternary.opacity(0.5), in: Capsule())
        } else {
            VStack(alignment: .leading, spacing: 10) {
                if card.action == "subscribe" {
                    ForEach(card.fields ?? [], id: \.key) { field in
                        let binding = Binding(get: { values[field.key] ?? "" }, set: { values[field.key] = $0 })
                        VStack(alignment: .leading, spacing: 4) {
                            Text(field.label + (field.optional == true ? "（可选）" : "")).font(.footnote).foregroundStyle(.secondary)
                            Group {
                                if field.secret == true { SecureField("", text: binding) }
                                else { TextField("", text: binding).textInputAutocapitalization(.never).autocorrectionDisabled() }
                            }
                            .padding(.horizontal, 10).frame(height: 36)
                            .overlay(RoundedRectangle(cornerRadius: 9).stroke(.secondary.opacity(0.35)))
                        }
                    }
                    Text("只保存在服务器上，不会发给模型，也不会留在聊天记录里。").font(.caption).foregroundStyle(.secondary)
                }
                if let error { Text(error).font(.footnote).foregroundStyle(.red) }
                Button(card.action == "unsubscribe" ? "确认取消订阅" : "订阅 \(name)") { submit() }
                    .buttonStyle(.borderedProminent).disabled(busy || !ready)
            }
            .padding(14)
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(.secondary.opacity(0.3)))
            .onAppear { for field in card.fields ?? [] where field.secret != true { values[field.key] = values[field.key] ?? (field.value ?? "") } }
        }
    }
    private var ready: Bool {
        card.action == "unsubscribe" || (card.fields ?? []).allSatisfy { $0.optional == true || !(values[$0.key] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }
    private func submit() {
        busy = true; error = nil
        var payload: [String: Any] = ["enabled": true]
        for field in card.fields ?? [] {
            let text = (values[field.key] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty || field.secret != true { payload[field.key] = text }
        }
        Task { @MainActor in
            defer { busy = false }
            do {
                _ = try await client.dotsSubscriptions(card.provider, method: card.action == "unsubscribe" ? "DELETE" : "PATCH", fields: card.action == "unsubscribe" ? nil : payload)
                values = [:]; done = true
            } catch { self.error = error.localizedDescription }
        }
    }
}

// MARK: - Reply, thinking and selection

/// A reply is carried in the message text as a Markdown quote, so every
/// client and the model see the same thing without a protocol change.
enum DotsQuote {
    static func compose(quote: String, body: String) -> String {
        let lines = quote.split(separator: "\n", omittingEmptySubsequences: true).prefix(4)
            .map { "> " + $0.trimmingCharacters(in: .whitespaces) }
        return lines.joined(separator: "\n") + "\n\n" + body
    }
    static func excerpt(_ content: String) -> String {
        let plain = content.split(separator: "\n").map { line -> String in
            var value = String(line).trimmingCharacters(in: .whitespaces)
            while value.hasPrefix(">") { value = String(value.dropFirst()).trimmingCharacters(in: .whitespaces) }
            return value.trimmingCharacters(in: CharacterSet(charactersIn: "#*-` "))
        }.filter { !$0.isEmpty }.joined(separator: " ")
        return plain.count > 160 ? String(plain.prefix(160)) + "…" : plain
    }
    /// Splits a leading quote block from the rest of a user message.
    static func split(_ content: String) -> (quote: String?, body: String) {
        let lines = content.components(separatedBy: "\n")
        var quoted: [String] = []
        var index = 0
        while index < lines.count, lines[index].hasPrefix(">") {
            quoted.append(String(lines[index].dropFirst()).trimmingCharacters(in: .whitespaces)); index += 1
        }
        guard !quoted.isEmpty else { return (nil, content) }
        let rest = lines[index...].joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        return (quoted.joined(separator: "\n"), rest)
    }
}

struct DotsQuoteBlock: View {
    let text: String
    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Capsule().fill(Color.accentColor.opacity(0.7)).frame(width: 3)
            Text(text).font(.footnote).foregroundStyle(.secondary).lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)
        }
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityLabel("引用：" + text)
    }
}

/// Shown the instant a message is sent, until the first words of the reply arrive.
struct DotsThinkingIndicator: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var appeared = false
    private let start = Date()

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 60, paused: reduceMotion)) { context in
            let t = context.date.timeIntervalSince(start)
            HStack(spacing: 0) {
                HStack(spacing: 5) {
                    ForEach(0..<3, id: \.self) { index in
                        let wave = reduceMotion ? 0.6 : (sin(t * 5.4 - Double(index) * 0.8) + 1) / 2
                        Circle()
                            .fill(LinearGradient(colors: [Color(red: 0.43, green: 0.47, blue: 0.96),
                                                          Color(red: 0.67, green: 0.44, blue: 0.93)],
                                                 startPoint: .topLeading, endPoint: .bottomTrailing))
                            .frame(width: 7, height: 7)
                            .scaleEffect(0.72 + 0.4 * wave)
                            .opacity(0.38 + 0.62 * wave)
                            .offset(y: -3.5 * wave)
                    }
                }
            }
            .padding(.horizontal, 15).padding(.vertical, 12)
            .background(DotsBubbleBackground(isUser: false))
        }
        .scaleEffect(appeared || reduceMotion ? 1 : 0.82, anchor: .bottomLeading)
        .opacity(appeared ? 1 : 0)
        .onAppear { withAnimation(.spring(response: 0.34, dampingFraction: 0.74)) { appeared = true } }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Dots 正在思考")
        .accessibilityIdentifier("dots-thinking")
    }
}

/// Shared bubble surface so model replies, the thinking state and user
/// messages read as one family.
struct DotsBubbleBackground: View {
    let isUser: Bool
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 20, style: .continuous)
        if isUser {
            shape.fill(Color.primary.opacity(0.045))
        } else {
            shape.fill(scheme == .dark ? Color.white.opacity(0.06) : Color(red: 0.965, green: 0.968, blue: 0.985))
                .overlay(shape.strokeBorder(Color.primary.opacity(scheme == .dark ? 0.07 : 0.05), lineWidth: 0.5))
        }
    }
}

/// Right-swipe to reply. A UIKit pan that only begins for a clearly
/// horizontal, rightward drag, so vertical scrolling and the screen-edge
/// sidebar gesture keep working.
private struct DotsReplyPan: UIGestureRecognizerRepresentable {
    var enabled: Bool
    var onChange: (CGFloat) -> Void
    var onEnd: (CGFloat, CGFloat) -> Void

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator() }
    func makeUIGestureRecognizer(context: Context) -> UIPanGestureRecognizer {
        let pan = UIPanGestureRecognizer()
        pan.delegate = context.coordinator
        pan.maximumNumberOfTouches = 1
        return pan
    }
    func updateUIGestureRecognizer(_ recognizer: UIPanGestureRecognizer, context: Context) {
        recognizer.isEnabled = enabled
    }
    func handleUIGestureRecognizerAction(_ recognizer: UIPanGestureRecognizer, context: Context) {
        let x = recognizer.translation(in: recognizer.view).x
        switch recognizer.state {
        case .began, .changed: onChange(x)
        case .ended: onEnd(x, recognizer.velocity(in: recognizer.view).x)
        case .cancelled, .failed: onEnd(0, 0)
        default: break
        }
    }
    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
            guard let pan = recognizer as? UIPanGestureRecognizer else { return false }
            let velocity = pan.velocity(in: pan.view)
            let start = pan.location(in: pan.view?.window)
            return start.x > 30 && velocity.x > 0 && abs(velocity.x) > abs(velocity.y) * 1.5
        }
    }
}

struct DotsSwipeToReply: ViewModifier {
    let enabled: Bool
    let onReply: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var offset: CGFloat = 0
    @State private var armed = false
    private let threshold: CGFloat = 62

    func body(content: Content) -> some View {
        let progress = min(offset / threshold, 1)
        content
            .offset(x: offset)
            .background(alignment: .leading) {
                Image(systemName: "arrowshape.turn.up.left.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(armed ? Color.white : Color.secondary)
                    .frame(width: 30, height: 30)
                    .background(armed ? AnyShapeStyle(Color.accentColor) : AnyShapeStyle(.regularMaterial), in: Circle())
                    .scaleEffect(armed ? 1.06 : 0.55 + 0.45 * progress)
                    .opacity(Double(progress))
                    .offset(x: -22 + min(offset, threshold + 12) * 0.5)
                    .animation(.spring(response: 0.22, dampingFraction: 0.6), value: armed)
                    .accessibilityHidden(true)
            }
            .gesture(DotsReplyPan(enabled: enabled, onChange: { x in
                // Follow the finger, then resist past the threshold.
                let raw = max(0, x)
                let next = raw <= threshold ? raw : threshold + (raw - threshold) * 0.28
                offset = min(next, threshold + 34)
                let nowArmed = raw >= threshold
                if nowArmed != armed {
                    armed = nowArmed
                    if nowArmed { UIImpactFeedbackGenerator(style: .medium).impactOccurred(intensity: 0.85) }
                    else { UISelectionFeedbackGenerator().selectionChanged() }
                }
            }, onEnd: { x, velocity in
                let fire = armed || (x > threshold * 0.7 && velocity > 650)
                if fire && !armed { UIImpactFeedbackGenerator(style: .medium).impactOccurred(intensity: 0.85) }
                withAnimation(reduceMotion ? .easeOut(duration: 0.18) : .spring(response: 0.36, dampingFraction: 0.78)) {
                    offset = 0
                }
                armed = false
                if fire { onReply() }
            }))
    }
}

/// Free range selection of a message, opened from the long-press menu.
private struct DotsSelectableTextView: UIViewRepresentable {
    let text: String
    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.isEditable = false
        view.isSelectable = true
        view.backgroundColor = .clear
        view.font = .preferredFont(forTextStyle: .body)
        view.adjustsFontForContentSizeCategory = true
        view.textContainerInset = UIEdgeInsets(top: 8, left: 20, bottom: 24, right: 20)
        view.dataDetectorTypes = [.link]
        return view
    }
    func updateUIView(_ view: UITextView, context: Context) {
        if view.text != text {
            view.text = text
            DispatchQueue.main.async { view.selectAll(nil) }
        }
    }
}

struct DotsSelectTextSheet: View {
    let text: String
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            DotsSelectableTextView(text: text)
                .navigationTitle("选择文本")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } }
                }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
}

struct DotsSelectionText: Identifiable {
    let id = UUID()
    let text: String
}

// MARK: - Connectors

struct DotsConnectorsResponse: Decodable {
    var categories: [DotsConnectorCategory]
    var connectors: [DotsConnector]
    var summary: DotsConnectorSummary
}
struct DotsConnectorCategory: Decodable, Identifiable, Hashable { var id: String; var name: String }
struct DotsConnectorSummary: Decodable { var connected: Int; var total: Int }
struct DotsConnectorDevice: Decodable, Hashable { var name: String; var platform: String?; var online: Bool? }
struct DotsConnector: Decodable, Identifiable {
    var id: String
    var provider: String?
    var kind: String
    var category: String
    var name: String
    var icon: String?
    var summary: String?
    var detail: String?
    var capabilities: [String]?
    var prompt: String?
    var state: String
    var status: String
    var account: String?
    var devices: [DotsConnectorDevice]?
    var actions: [String]?
}
struct DotsSettings: Decodable, Equatable {
    var approvalMode: String
    var dailyBrief: Bool
    var dailyBriefTime: String
}
struct DotsGrant: Decodable, Identifiable, Equatable {
    let id: Int
    var labels: [String]?
    var signatures: [String]?
    var scope: String
    var expiresAt: Double?
    var uses: Int?
    var scopeText: String {
        switch scope {
        case "always": return "一直允许"
        case "task": return "仅限这个任务"
        default:
            guard let expiresAt else { return "" }
            return "到 " + Date(timeIntervalSince1970: expiresAt).formatted(.dateTime.month().day().hour().minute())
        }
    }
}
struct DotsGrantsResponse: Decodable { var grants: [DotsGrant] }
struct DotsAuditItem: Decodable, Identifiable {
    let id: String
    var category: String
    var title: String
    var summary: String?
    var detail: String?
    var ok: Bool?
    var goalTitle: String?
    var error: String?
    var at: Double
}
struct DotsAuditResponse: Decodable { var items: [DotsAuditItem]; var nextBefore: Double? }

/// 「做过的事」：Dots 以你的名义实际做过的事，按天分组。
struct DotsAuditView: View {
    @State private var items: [DotsAuditItem] = []
    @State private var next: Double?
    @State private var category = ""
    @State private var loading = false
    @State private var error: String?
    private let filters = [("", "全部"), ("action", "操作"), ("message", "消息")]
    private var days: [(String, [DotsAuditItem])] {
        var out: [(String, [DotsAuditItem])] = []
        for item in items {
            let date = Date(timeIntervalSince1970: item.at)
            let label = Calendar.current.isDateInToday(date) ? "今天" : Calendar.current.isDateInYesterday(date) ? "昨天" : date.formatted(.dateTime.month().day().weekday())
            if out.last?.0 == label { out[out.count - 1].1.append(item) } else { out.append((label, [item])) }
        }
        return out
    }
    var body: some View {
        List {
            Section {
                Picker("类别", selection: $category) { ForEach(filters, id: \.0) { Text($0.1).tag($0.0) } }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear).listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
            }
            if let error { Text(error).font(.footnote).foregroundStyle(.red) }
            ForEach(days, id: \.0) { day in
                Section(day.0) { ForEach(day.1) { row($0) } }
            }
            if items.isEmpty && !loading && error == nil {
                Text("这里还没有记录。").font(.subheadline).foregroundStyle(.secondary)
            }
            if loading { ProgressView().frame(maxWidth: .infinity) }
            else if next != nil {
                Button("加载更早的记录") { Task { await load(more: true) } }.frame(maxWidth: .infinity)
            }
        }
        .navigationTitle("做过的事").navigationBarTitleDisplayMode(.inline)
        .task(id: category) { await load(more: false) }
        .refreshable { await load(more: false) }
    }
    private func row(_ item: DotsAuditItem) -> some View {
        let failed = item.ok == false
        let symbol = failed ? "exclamationmark.triangle.fill" : ["action": "terminal", "message": "paperplane", "change": "gearshape"][item.category] ?? "circle"
        let tint: Color = failed ? .red : ["action": .accentColor, "message": .orange][item.category] ?? .secondary
        return HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol).font(.footnote.weight(.semibold)).foregroundStyle(tint)
                .frame(width: 28, height: 28).background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline) {
                    Text(item.title).font(.subheadline.weight(.semibold))
                    if failed { Text("失败").font(.caption2).foregroundStyle(.red) }
                    Spacer(minLength: 4)
                    Text(Date(timeIntervalSince1970: item.at).formatted(.dateTime.hour().minute())).font(.caption).foregroundStyle(.secondary).monospacedDigit()
                }
                if let summary = item.summary, !summary.isEmpty { Text(summary).font(.caption).foregroundStyle(.secondary) }
                if let detail = item.detail, !detail.isEmpty {
                    Text(detail).font(.system(.caption2, design: .monospaced)).lineLimit(4).padding(6)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 7))
                }
                if let goal = item.goalTitle { Text("任务：" + goal).font(.caption2).foregroundStyle(.secondary) }
                if let error = item.error, !error.isEmpty { Text(error).font(.caption2).foregroundStyle(.red) }
            }
        }.padding(.vertical, 2)
    }
    private func load(more: Bool) async {
        guard !loading else { return }
        loading = true; error = nil
        defer { loading = false }
        do {
            let data = try await CodexClient.shared.dotsAudit(category: category, before: more ? next : nil)
            items = more ? items + data.items : data.items
            next = data.nextBefore
        } catch { self.error = error.localizedDescription }
    }
}
struct DotsSettingsResponse: Decodable { var settings: DotsSettings }

struct DotsConnectorsView: View {
    var onConnect: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var data: DotsConnectorsResponse?
    @State private var expanded: String?
    @State private var error: String?
    @State private var working: String?
    @State private var showSpongeHelp = false
    @State private var showWeixin = false
    @State private var confirmDisconnect: DotsConnector?

    private var own: [DotsConnector] { (data?.connectors ?? []).filter { $0.kind != "builtin" && $0.kind != "planned" } }
    private var connected: [DotsConnector] { own.filter { ["connected", "paused", "error"].contains($0.state) } }
    private var available: [DotsConnector] { own.filter { $0.state == "available" } }
    private func names(_ kind: String) -> String { (data?.connectors ?? []).filter { $0.kind == kind }.map(\.name).joined(separator: " · ") }

    var body: some View {
        NavigationStack {
            List {
                if data == nil && error == nil { ProgressView().frame(maxWidth: .infinity) }
                if !connected.isEmpty {
                    Section("已连接") {
                        ForEach(connected) { item in connectedRow(item) }
                    }
                }
                if !available.isEmpty {
                    Section("可连接") {
                        ForEach(available) { item in
                            DotsSourceRow(symbol: item.icon ?? "puzzlepiece", name: item.name, subtitle: item.summary) {
                                Button("连接") { Task { await act(item, "connect") } }
                                    .buttonStyle(.borderedProminent).controlSize(.small).buttonBorderShape(.capsule)
                            }
                        }
                    }
                }
                if data != nil {
                    Section("内置") { Text(names("builtin")).font(.subheadline) }
                    Section("即将支持") { Text(names("planned")).font(.subheadline).foregroundStyle(.secondary) }
                }
                if let error { Text(error).font(.footnote).foregroundStyle(.red) }
            }
            .listStyle(.insetGrouped)
            .animation(.spring(response: 0.32, dampingFraction: 0.88), value: expanded)
            .navigationTitle("连接器").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { ShiyanCloseButton(action: { dismiss() }, inToolbar: true) } }
            .refreshable { await load() }
            .task { await load() }
            .sheet(isPresented: $showWeixin, onDismiss: { Task { await load() } }) { DotsWeixinLoginView { Task { await load() } } }
            .alert("连接海绵宝宝设备", isPresented: $showSpongeHelp) {
                Button("好") {}
            } message: { Text("在电脑上打开海绵宝宝客户端，用当前拾燕账号登录并配对。") }
            .confirmationDialog("断开\(confirmDisconnect?.name ?? "")？", isPresented: Binding(get: { confirmDisconnect != nil }, set: { if !$0 { confirmDisconnect = nil } }), titleVisibility: .visible) {
                Button("断开", role: .destructive) { if let item = confirmDisconnect { Task { await act(item, "disconnect") } } }
            } message: { Text("之后可以随时重新连接。") }
        }
        .presentationDragIndicator(.visible)
    }

    @ViewBuilder private func connectedRow(_ item: DotsConnector) -> some View {
        let open = expanded == item.id
        VStack(alignment: .leading, spacing: 10) {
            Button {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                expanded = open ? nil : item.id
            } label: {
                DotsSourceRow(symbol: item.icon ?? "puzzlepiece", name: item.name, subtitle: item.account?.isEmpty == false ? item.account : item.summary, active: item.state == "connected") {
                    HStack(spacing: 8) {
                        DotsSourceState(text: item.status, state: item.state)
                        Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
                            .rotationEffect(.degrees(open ? 90 : 0))
                    }
                }.contentShape(Rectangle())
            }.buttonStyle(.plain)
            if open {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(item.devices ?? [], id: \.self) { device in
                        HStack(spacing: 8) {
                            Circle().fill(device.online == true ? Color.green : Color.gray.opacity(0.5)).frame(width: 6, height: 6)
                            Text(device.name).font(.footnote)
                        }
                    }
                    if let detail = item.detail { Text(detail).font(.caption).foregroundStyle(.secondary) }
                    if let actions = item.actions, !actions.isEmpty {
                        HStack(spacing: 8) {
                            ForEach(actions, id: \.self) { action in actionButton(item, action) }
                            if working == item.id { ProgressView().controlSize(.small) }
                        }
                    }
                }
                .padding(.leading, 44)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .accessibilityIdentifier("dots-connector-\(item.id)")
    }
    @ViewBuilder private func actionButton(_ item: DotsConnector, _ action: String) -> some View {
        let label = ["configure": "修改", "pause": "暂停", "resume": "恢复", "disconnect": item.kind == "weixin" ? "解绑" : "断开", "manage": "管理设备",
                     "push_on": "提醒推送到微信", "push_off": "停止推送提醒"][action] ?? action
        Button(label, role: action == "disconnect" ? .destructive : nil) {
            if action == "disconnect" { confirmDisconnect = item } else { Task { await act(item, action) } }
        }.buttonStyle(.bordered).controlSize(.small).buttonBorderShape(.capsule).disabled(working != nil)
    }
    private func act(_ item: DotsConnector, _ action: String) async {
        if item.kind == "sponge" { showSpongeHelp = true; return }
        if item.kind == "weixin" {
            if action == "connect" { showWeixin = true; return }
            working = item.id; error = nil
            defer { working = nil }
            do {
                if action == "disconnect" { _ = try await CodexClient.shared.dotsWeixin("unbind") }
                else { _ = try await CodexClient.shared.dotsWeixin("push", fields: ["enabled": action == "push_on"]) }
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                await load()
            } catch { self.error = error.localizedDescription }
            return
        }
        if action == "connect" || action == "configure" {
            dismiss(); onConnect(item.prompt ?? "我想连接\(item.name)"); return
        }
        guard let provider = item.provider else { return }
        working = item.id; error = nil
        defer { working = nil }
        do {
            switch action {
            case "disconnect": _ = try await CodexClient.shared.dotsSubscriptions(provider, method: "DELETE")
            case "pause", "resume": _ = try await CodexClient.shared.dotsSubscriptions(provider, method: "PATCH", fields: ["enabled": action == "resume"])
            default: break
            }
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            await load()
        } catch { self.error = error.localizedDescription }
    }
    private func load() async {
        do { data = try await CodexClient.shared.dotsConnectors(); error = nil }
        catch { self.error = error.localizedDescription }
    }
}

struct DotsSettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var settings: DotsSettings?
    @State private var grants: [DotsGrant] = []
    @State private var error: String?
    private let modes: [(String, String, String, String)] = [
        ("smart", "智能审批", "只有删除、提权、重启、推送代码等高风险操作才需要你批准，其余自动执行。", "shield.lefthalf.filled"),
        ("auto", "全部自动", "除提权和灾难性命令外全部自动执行，最少打扰。", "bolt.fill"),
        ("ask", "每次都问", "每个需要审批的操作都等你确认。", "hand.raised.fill"),
    ]
    var body: some View {
        NavigationStack {
            Form {
                if let settings {
                    Section("审批方式") {
                        ForEach(modes, id: \.0) { mode in
                            Button { save(["approvalMode": mode.0]) { $0.approvalMode = mode.0 } } label: {
                                HStack(alignment: .top, spacing: 12) {
                                    Image(systemName: mode.3).foregroundStyle(Color.accentColor).frame(width: 24)
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(mode.1).foregroundStyle(.primary)
                                        Text(mode.2).font(.caption).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    if settings.approvalMode == mode.0 {
                                        Image(systemName: "checkmark").foregroundStyle(Color.accentColor).fontWeight(.semibold)
                                    }
                                }
                            }
                        }
                    }
                    Section {
                        if grants.isEmpty {
                            Text("批准操作时可选择授权范围，同类操作之后不再询问。")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                        ForEach(grants) { grant in
                            HStack {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text((grant.labels ?? grant.signatures ?? []).joined(separator: "、"))
                                        .font(.system(.subheadline, design: .monospaced).weight(.semibold))
                                    Text(grant.scopeText + ((grant.uses ?? 0) > 0 ? " · 已自动执行 \(grant.uses ?? 0) 次" : ""))
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Button("撤销", role: .destructive) { revoke(grant) }.buttonStyle(.borderless).font(.subheadline)
                            }
                        }
                        NavigationLink { DotsAuditView() } label: { Label("做过的事", systemImage: "clock.arrow.circlepath") }
                    } header: { Text("已授权的操作") }
                    Section {
                        Toggle("每天推送一份简报", isOn: Binding(get: { settings.dailyBrief }, set: { value in save(["dailyBrief": value]) { $0.dailyBrief = value } }))
                        DatePicker("推送时间", selection: Binding(get: { time(settings.dailyBriefTime) }, set: { date in
                            let text = Self.formatter.string(from: date); save(["dailyBriefTime": text]) { $0.dailyBriefTime = text }
                        }), displayedComponents: .hourAndMinute).disabled(!settings.dailyBrief)
                    } header: { Text("每日简报") } footer: { Text("汇总当天日程、进行中的任务和订阅动态。") }
                } else if error == nil {
                    ProgressView().frame(maxWidth: .infinity)
                }
                if let error { Text(error).foregroundStyle(.red).font(.footnote) }
            }
            .navigationTitle("Dots 设置").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { ShiyanCloseButton(action: { dismiss() }, inToolbar: true) } }
            .task {
                do { settings = try await CodexClient.shared.dotsSettings().settings }
                catch { self.error = error.localizedDescription }
                grants = (try? await CodexClient.shared.dotsGrants().grants) ?? []
            }
        }
        .presentationDetents([.medium, .large])
    }
    private func revoke(_ grant: DotsGrant) {
        Task {
            do { try await CodexClient.shared.dotsRevokeGrant(grant.id); withAnimation { grants.removeAll { $0.id == grant.id } }; UINotificationFeedbackGenerator().notificationOccurred(.success) }
            catch { self.error = error.localizedDescription }
        }
    }
    private static let formatter: DateFormatter = { let f = DateFormatter(); f.dateFormat = "HH:mm"; f.locale = Locale(identifier: "en_US_POSIX"); return f }()
    private func time(_ text: String) -> Date { Self.formatter.date(from: text) ?? Self.formatter.date(from: "09:00")! }
    private func save(_ patch: [String: Any], apply: (inout DotsSettings) -> Void) {
        guard var next = settings else { return }
        let before = settings
        apply(&next)
        guard next != settings else { return }
        settings = next
        UISelectionFeedbackGenerator().selectionChanged()
        Task {
            do { settings = try await CodexClient.shared.dotsSettings(update: patch).settings; error = nil }
            catch { settings = before; self.error = error.localizedDescription }
        }
    }
}

// MARK: - WeChat binding

struct DotsWeixinStatus: Decodable {
    var state: String
    var loginStatus: String?
    var message: String?
    var qrUrl: String?
    var needsVerifyCode: Bool?
    var pushProactive: Bool?
}

/// 扫码绑定个人微信。在手机上无法扫自己屏幕：提供“复制二维码图片 / 复制链接”，在微信里识别即可。
struct DotsWeixinLoginView: View {
    var onConnected: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var status: DotsWeixinStatus?
    @State private var error: String?
    @State private var code = ""
    @State private var copied: String?
    @State private var pollTask: Task<Void, Never>?

    private var connected: Bool { status?.state == "connected" }
    private var expired: Bool { status?.state == "login_expired" }
    private var scanned: Bool { ["scaned", "scaned_but_redirect"].contains(status?.loginStatus ?? "") }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 18) {
                    ZStack {
                        RoundedRectangle(cornerRadius: 22, style: .continuous).fill(Color.white)
                            .shadow(color: .black.opacity(connected ? 0 : 0.08), radius: 14, y: 6)
                        if connected {
                            Image(systemName: "checkmark").font(.system(size: 40, weight: .bold)).foregroundStyle(.white)
                                .frame(width: 88, height: 88).background(Color(red: 0.03, green: 0.76, blue: 0.38), in: Circle())
                                .transition(.scale.combined(with: .opacity))
                        } else if let url = status?.qrUrl, let image = Self.qrImage(url) {
                            Image(uiImage: image).interpolation(.none).resizable().scaledToFit().padding(14)
                                .blur(radius: scanned || expired ? 4 : 0).opacity(scanned || expired ? 0.35 : 1)
                            if expired { Button("刷新二维码") { Task { await start() } }.buttonStyle(.borderedProminent) }
                            if scanned { Image(systemName: "iphone.gen3.radiowaves.left.and.right").font(.system(size: 34)).foregroundStyle(.green) }
                        } else { ProgressView() }
                    }
                    .frame(width: 220, height: 220)
                    .animation(.spring(response: 0.4, dampingFraction: 0.8), value: connected)

                    VStack(spacing: 4) {
                        Text(headline).font(.headline)
                        if let message = status?.message, !message.isEmpty, !connected { Text(message).font(.footnote).foregroundStyle(.orange) }
                    }.multilineTextAlignment(.center)

                    if status?.needsVerifyCode == true {
                        HStack {
                            TextField("手机上显示的数字", text: $code).keyboardType(.numberPad).textContentType(.oneTimeCode)
                                .multilineTextAlignment(.center).font(.title3.monospacedDigit())
                                .padding(10).background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 12))
                            Button("确定") { Task { await verify() } }.buttonStyle(.borderedProminent).disabled(code.count < 2)
                        }.frame(maxWidth: 280)
                    }

                    if connected {
                        Text("现在可以在微信里直接给 Dots 发消息了。简报和提醒也会同步到微信，可以在连接器里关闭。")
                            .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
                        Button("完成") { dismiss() }.buttonStyle(.borderedProminent)
                    } else if let url = status?.qrUrl, !expired {
                        VStack(spacing: 10) {
                            HStack(spacing: 10) {
                                Button { copyImage(url) } label: { Label("复制二维码图片", systemImage: "qrcode") }
                                Button { UIPasteboard.general.string = url; flash("已复制链接") } label: { Label("复制链接", systemImage: "link") }
                            }.buttonStyle(.bordered).controlSize(.small)
                            if let copied { Text(copied).font(.caption).foregroundStyle(.green).transition(.opacity) }
                        }
                        VStack(alignment: .leading, spacing: 8) {
                            step(1, "用另一台设备显示这个二维码，或点“复制二维码图片”")
                            step(2, "在微信里扫码；或把图片发给“文件传输助手”，长按选“识别图中二维码”")
                            step(3, "在手机微信上点“确认”，绑定完成")
                        }.frame(maxWidth: 320, alignment: .leading)
                        Text("需要微信 8.0.70 及以上版本。只有你本人能和它对话，不能拉进群。")
                            .font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    }
                    if let error { Text(error).font(.footnote).foregroundStyle(.red) }
                }
                .padding(24).frame(maxWidth: .infinity)
            }
            .navigationTitle("连接微信").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { ShiyanCloseButton(action: { dismiss() }, inToolbar: true) } }
        }
        .task { await start() }
        .onDisappear { pollTask?.cancel() }
    }
    private var headline: String {
        if connected { return "绑定成功" }
        if expired { return "二维码已过期" }
        if scanned { return "已扫码，请在手机微信上点“确认”" }
        if status?.needsVerifyCode == true { return "请输入手机微信上显示的数字" }
        return "用微信扫一扫"
    }
    private func step(_ n: Int, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text("\(n)").font(.caption2.weight(.bold)).foregroundStyle(Color(red: 0.03, green: 0.65, blue: 0.33))
                .frame(width: 18, height: 18).background(Color.green.opacity(0.14), in: Circle())
            Text(text).font(.footnote).foregroundStyle(.secondary)
        }
    }
    private func flash(_ text: String) {
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        withAnimation { copied = text }
        Task { try? await Task.sleep(nanoseconds: 2_000_000_000); withAnimation { copied = nil } }
    }
    private func copyImage(_ url: String) {
        guard let image = Self.qrImage(url, scale: 12) else { return }
        UIPasteboard.general.image = image; flash("已复制二维码，去微信粘贴给“文件传输助手”")
    }
    static func qrImage(_ text: String, scale: CGFloat = 10) -> UIImage? {
        guard let filter = CIFilter(name: "CIQRCodeGenerator") else { return nil }
        filter.setValue(Data(text.utf8), forKey: "inputMessage"); filter.setValue("M", forKey: "inputCorrectionLevel")
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: scale, y: scale)),
              let cg = CIContext().createCGImage(output, from: output.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
    private func start() async {
        error = nil
        do { withAnimation { status = nil }; status = try await CodexClient.shared.dotsWeixin("login"); poll() }
        catch { self.error = error.localizedDescription }
    }
    private func verify() async {
        do { status = try await CodexClient.shared.dotsWeixin("verify", fields: ["code": code]); code = "" }
        catch { self.error = error.localizedDescription }
    }
    private func poll() {
        pollTask?.cancel()
        pollTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                guard !Task.isCancelled, let next = try? await CodexClient.shared.dotsWeixin("status") else { continue }
                await MainActor.run {
                    let wasScanned = scanned
                    withAnimation(.spring(response: 0.4, dampingFraction: 0.85)) { status = next }
                    if scanned && !wasScanned { UIImpactFeedbackGenerator(style: .medium).impactOccurred() }
                    if next.state == "connected" { UINotificationFeedbackGenerator().notificationOccurred(.success); onConnected() }
                }
                if next.state == "connected" || next.state == "login_expired" { return }
            }
        }
    }
}
