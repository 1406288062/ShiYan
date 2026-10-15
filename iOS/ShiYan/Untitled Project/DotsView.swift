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

struct DotsView: View {
    let topInset: CGFloat
    let bottomInset: CGFloat
    let hasUnread: Bool
    let isConversationVisible: Bool
    let onSidebar: () -> Void
    @StateObject private var store = DotsStore.shared
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.colorScheme) private var scheme
    @State private var showTasks = false
    @State private var showFiles = false
    @State private var attachmentPreview: URL?
    @State private var approval: DotsApproval?
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
                                    if item.role == "user", let timestamp = managerTimestamp(item.createdAt) {
                                        Text(timestamp).font(.system(size: 11)).foregroundStyle(.secondary)
                                            .frame(maxWidth: .infinity, alignment: .center)
                                            .accessibilityIdentifier("dots-message-time-\(item.id)")
                                    }
                                    managerMessage(item)
                                }.id(item.id)
                            }
                            Color.clear.frame(height: 1).id("dots-bottom")
                                .background(GeometryReader { geo in
                                    Color.clear.preference(key: DotsBottomPreference.self,
                                        value: geo.frame(in: .named("dots-chat-scroll")).minY)
                                })
                        }.padding(.horizontal, 24)
                            .padding(.top, (headerHeight > 0 ? headerHeight : topInset + 111) + 16)
                            .padding(.bottom, 20)
                    }
                    .coordinateSpace(name: "dots-chat-scroll")
                    .defaultScrollAnchor(.bottom, for: .initialOffset)
                    .onPreferenceChange(DotsBottomPreference.self) { y in
                        atBottom = y <= viewport.size.height + 70
                        updateReadingVisibility()
                    }
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
                    .overlay(alignment: .bottomTrailing) {
                        if !atBottom {
                            Button { proxy.scrollTo("dots-bottom", anchor: .bottom) } label: {
                                Image(systemName: "arrow.down").frame(width: 38, height: 38)
                                    .background(.regularMaterial, in: Circle())
                            }.buttonStyle(.plain).padding(16).padding(.bottom, composerHeight)
                                .accessibilityLabel("回到底部")
                        }
                    }
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
            updateReadingVisibility()
        }
        .onDisappear { store.deactivate() }
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
        .onChange(of: showTasks) { _, visible in
            if !visible { store.select(nil) }
            updateReadingVisibility()
        }
        .onChange(of: isConversationVisible) { _, _ in updateReadingVisibility() }
        .onChange(of: showFiles) { _, _ in updateReadingVisibility() }
        .onChange(of: attachmentPreview) { _, _ in updateReadingVisibility() }
        .accessibilityIdentifier("dots-manager-page")
    }
    private func updateReadingVisibility() {
        store.setReadingLatest(scenePhase == .active && isConversationVisible && atBottom &&
            !showTasks && !showFiles && attachmentPreview == nil)
    }
    private var assistantMenu: some View {
        ShiyanMoreMenu {
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
            assistantIdentity
                .padding(.top, 3).padding(.bottom, 8)
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
                    Button { Task { await store.retryPending() } } label: {
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
        if !store.connection.isEmpty && store.connection != "定时同步" { return store.connection }
        if store.uploading { return "正在上传…" }
        if store.sending { return "正在发送…" }
        if store.hasPending { return "发送结果待确认" }
        if store.manager?.status == "paused" { return "已暂停" }
        if store.manager?.status == "cancelled" { return "已停止" }
        if (store.manager?.runningWorkers ?? 0) > 0 || store.currentTasks.contains(where: { $0.status == "running" }) {
            return "Thinking"
        }
        if store.currentTasks.contains(where: { $0.status == "waiting_approval" }) { return "等待确认" }
        if store.currentTasks.contains(where: { $0.status == "done" && $0.acceptanceStatus == "pending" && $0.legacyImported != true }) {
            return "正在验收…"
        }
        if store.currentTasks.contains(where: { $0.status == "blocked" }) { return "任务受阻" }
        if store.currentTasks.contains(where: { ["active", "pending", "queued"].contains($0.status ?? "") }) { return "等待执行" }
        if store.currentTasks.first?.status == "failed" { return "处理失败" }
        if store.loading && store.messages.isEmpty { return "正在加载…" }
        if store.messages.last?.role == "user" { return "Thinking" }
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
                    Text(item.content).font(.body).lineSpacing(5)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
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
            .padding(item.role == "user" ? 14 : 0)
            .background(item.role == "user" ? Color.primary.opacity(0.045) : Color.clear,
                        in: RoundedRectangle(cornerRadius: 20))
            if item.role != "user" { Spacer(minLength: 0) }
        }
    }
    private func composer(bottomGap: CGFloat) -> some View {
        VStack(alignment: .leading, spacing: 8) {
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
            }.buttonStyle(.plain).foregroundStyle(.primary)
                .disabled(store.hasPending || store.sending || store.uploading)
                .accessibilityLabel("添加文件").accessibilityIdentifier("dots-add-attachment")
            TextField("交给我…", text: Binding(get: { store.draft }, set: store.setDraft), axis: .vertical)
                .lineLimit(1...(inputFocused ? 6 : 1)).font(.body).focused($inputFocused)
                .frame(minHeight: 36)
                .disabled(store.hasPending).accessibilityIdentifier("dots-composer")
            Button {
                inputFocused = false
                Task { await store.submit() }
            } label: {
                Group {
                    if store.sending { ProgressView().tint(.white) }
                    else { Image(systemName: "arrow.up").font(.system(size: 19, weight: .bold)) }
                }.foregroundStyle(.white)
                    .frame(width: 36, height: 36)
                    .background(Color.accentColor, in: Circle())
            }.buttonStyle(.plain).disabled(!store.canSend).accessibilityLabel("发送")
                .overlay {
                    if store.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && store.attachments.isEmpty && !store.sending {
                        ZStack {
                            Circle().fill(Color(.sRGB, red: 158.0 / 255, green: 200.0 / 255, blue: 238.0 / 255, opacity: 1))
                            Image(systemName: "arrow.up").font(.system(size: 19, weight: .bold))
                                .foregroundStyle(Color(.sRGB, red: 244.0 / 255, green: 248.0 / 255, blue: 253.0 / 255, opacity: 1))
                        }.frame(width: 36, height: 36).allowsHitTesting(false).accessibilityHidden(true)
                    }
                }
                .accessibilityIdentifier("dots-send")
        }
        }.padding(10)
            .agentComposerSurface(cornerRadius: 25)
            .frame(maxWidth: inputFocused || !store.draft.isEmpty || !store.attachments.isEmpty ? .infinity : 325)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 16).padding(.bottom, bottomGap).padding(.top, 8)
    }
    private var taskSheet: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    if let goal = store.selected { taskDetail(goal) }
                    else {
                        activityPanel

                    }
                }.padding(24).frame(maxWidth: .infinity, alignment: .leading)
            }.scrollIndicators(.hidden).refreshable { await store.loadActivity() }
                .navigationTitle("任务")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
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
                DotsIdentityIcon().frame(width: 66, height: 72)
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
                ForEach(outputsExpanded ? store.panelOutputs : Array(store.panelOutputs.prefix(5))) { item in
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
                if store.panelOutputs.count > 5 { moreButton(expanded: $outputsExpanded) }
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
                Button { approval = item } label: {
                    Label("需要确认", systemImage: "hand.raised")
                }.buttonStyle(.plain).disabled(store.sending || store.hasPending)
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
    private func approvalPreview(_ item: DotsApproval) -> some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text(item.reason ?? "此步骤需要你的许可。")
                    Text("将执行以下命令").font(.subheadline).foregroundStyle(.secondary)
                    Text(item.command ?? "").font(.system(.body, design: .monospaced)).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(16)
                        .background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 14))
                    Button("确认执行") { approval = nil; Task { await store.decide(item, approve: true) } }
                        .buttonStyle(.borderedProminent)
                        .disabled(store.sending || store.hasPending || (item.command ?? "").isEmpty)
                    Button("拒绝执行", role: .destructive) { approval = nil; Task { await store.decide(item, approve: false) } }
                        .disabled(store.sending || store.hasPending)
                }.padding(24)
            }.navigationTitle("确认命令").navigationBarTitleDisplayMode(.inline)
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

private struct DotsLivePet: View {
    @ObservedObject private var store = DotsStore.shared
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var phase
    private var motion: (row: Int, frames: Int, fps: Double) {
        if store.manager?.status == "paused" || store.manager?.status == "cancelled" { return (6,6,8) }
        if store.sending || store.uploading || (store.manager?.runningWorkers ?? 0) > 0 ||
            store.currentTasks.contains(where: { $0.status == "running" }) { return (7,6,8) }
        if store.currentTasks.contains(where: { $0.status == "waiting_approval" || $0.status == "blocked" ||
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
