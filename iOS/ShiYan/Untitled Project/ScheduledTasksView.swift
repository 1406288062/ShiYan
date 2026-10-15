import SwiftUI

private enum ScheduledTaskTab: String, CaseIterable {
    case active, paused, completed
    var title: String {
        switch self {
        case .active: "已开启"
        case .paused: "已暂停"
        case .completed: "已完成"
        }
    }
}

private struct ScheduledTaskPreset: Identifiable {
    let id: String
    let emoji: String
    let title: String
    let prompt: String
    var repeatType = "daily"

    var draft: ScheduledTask {
        var task = ScheduledTask()
        task.title = title
        task.prompt = prompt
        task.emoji = emoji
        task.repeatType = repeatType
        return task
    }

    static let all: [ScheduledTaskPreset] = [
        .init(id: "plan", emoji: "💻", title: "ChatGPT Plus 套餐变化", prompt: "只要 Plus 的语音额度、价格或升级 Pro 规则有实质变化，就提醒我。"),
        .init(id: "project", emoji: "🤖", title: "aiagent 项目状态", prompt: "每周汇总 aiagent 的进展、回归风险和下一步，重点盯住关键链路。", repeatType: "weekly"),
        .init(id: "interview", emoji: "📚", title: "Agent 面试日练", prompt: "每天给我一组面试题，帮我按既定 Agent 学习路线逐步推进。"),
        .init(id: "meal", emoji: "🥗", title: "每周饮食计划", prompt: "规划一周的餐食，并列出食材采购清单。", repeatType: "weekly"),
        .init(id: "sleep", emoji: "😴", title: "睡眠指导", prompt: "跟踪我的睡眠质量，并帮助我改善生活习惯。"),
        .init(id: "finance", emoji: "💰", title: "每周财务状况更新", prompt: "回顾我最近的支出，看看有什么需要注意。", repeatType: "weekly")
    ]
}

private struct ScheduledTaskEditorItem: Identifiable {
    var task: ScheduledTask
    var isNew: Bool
    var id: String { task.id }
}

struct ScheduledTasksView: View {
    let topInset: CGFloat
    let bottomInset: CGFloat
    let hasUnread: Bool
    let onSidebar: () -> Void
    @ObservedObject private var store = ScheduledTaskStore.shared
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.scenePhase) private var scenePhase
    @State private var selectedTab = ScheduledTaskTab.active
    @State private var editor: ScheduledTaskEditorItem?
    @State private var deleteTarget: ScheduledTask?
    @State private var operationError: String?
    @State private var busyTasks = Set<String>()

    private var visibleTasks: [ScheduledTask] {
        store.tasks.filter { $0.status == selectedTab.rawValue }
    }
    private var background: Color { colorScheme == .dark ? Color(white: 0.065) : .white }
    private var border: Color { Color.primary.opacity(colorScheme == .dark ? 0.13 : 0.09) }

    var body: some View {
        ZStack(alignment: .top) {
            background
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if let error = store.lastError, store.tasks.isEmpty {
                        Text(error).font(.subheadline).foregroundStyle(.secondary)
                            .padding(.horizontal, 8).padding(.vertical, 12)
                        Button("重新加载") { Task { await store.refresh() } }
                            .buttonStyle(.plain).padding(.horizontal, 8)
                    } else if store.isLoading && store.tasks.isEmpty {
                        ProgressView().frame(maxWidth: .infinity).padding(.vertical, 28)
                    } else if visibleTasks.isEmpty {
                        Text(selectedTab == .active ? "还没有开启的定时任务" : selectedTab == .paused ? "没有暂停的定时任务" : "没有已完成的定时任务")
                            .font(.subheadline).foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity).padding(.vertical, 28)
                    }
                    ForEach(visibleTasks) { task in taskCard(task) }
                    Text("推荐").font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(.secondary).padding(.leading, 24)
                        .padding(.top, 28).padding(.bottom, 2)
                    ForEach(ScheduledTaskPreset.all) { preset in presetCard(preset) }
                }
                .padding(.horizontal, 16)
                .padding(.top, topInset + 147)
                .padding(.bottom, bottomInset + 92)
            }
            .scrollIndicators(.hidden)
            .refreshable { await store.refresh() }
            VStack(spacing: 26) {
                ZStack {
                    Text("定时任务").font(.system(size: 18, weight: .semibold))
                    HStack {
                        AgentSidebarButton(hasUnread: hasUnread, diameter: 46, action: onSidebar)
                            .accessibilityIdentifier("feature-open-sidebar-scheduled")
                        Spacer()
                    }
                }
                .frame(height: 46)
                HStack(spacing: 4) {
                    ForEach(ScheduledTaskTab.allCases, id: \.self) { tab in
                        Button {
                            withAnimation(.easeInOut(duration: 0.18)) { selectedTab = tab }
                        } label: {
                            Text(tab.title).font(.system(size: 17, weight: selectedTab == tab ? .semibold : .medium))
                                .foregroundStyle(selectedTab == tab ? Color.primary : Color.secondary)
                                .frame(maxWidth: .infinity).frame(height: 44)
                                .background(selectedTab == tab ? Color.primary.opacity(0.045) : .clear, in: Capsule())
                                .contentShape(Capsule())
                        }.buttonStyle(.plain)
                            .accessibilityAddTraits(selectedTab == tab ? .isSelected : [])
                    }
                }
            }
            .padding(.horizontal, 16).padding(.top, topInset + 3).padding(.bottom, 16)
            .background(background)

            VStack {
                Spacer()
                HStack {
                    Spacer()
                    Button { editor = .init(task: ScheduledTask(), isNew: true) } label: {
                        Text("新建任务").font(.system(size: 17, weight: .semibold))
                            .padding(.horizontal, 25).frame(height: 49)
                            .foregroundStyle(.white)
                            .background(Color(red: 0.23, green: 0.35, blue: 0.91), in: Capsule())
                            .overlay(Capsule().stroke(.white.opacity(0.18), lineWidth: 1))
                            .shadow(color: .black.opacity(0.07), radius: 7, y: 3)
                    }.buttonStyle(.plain).accessibilityIdentifier("scheduled-new-task")
                }.padding(.horizontal, 28).padding(.bottom, bottomInset + 13)
            }
        }
        .accessibilityIdentifier("scheduled-tasks-page")
        .sheet(item: $editor) { item in
            ScheduledTaskEditor(task: item.task, isNew: item.isNew)
                .presentationDetents([.large]).presentationDragIndicator(.hidden)
        }
        .alert("删除定时任务？", isPresented: Binding(get: { deleteTarget != nil }, set: { if !$0 { deleteTarget = nil } })) {
            Button("取消", role: .cancel) { deleteTarget = nil }
            Button("删除", role: .destructive) {
                guard let task = deleteTarget else { return }
                deleteTarget = nil
                perform(task.id) { try await store.delete(taskId: task.id) }
            }
        } message: { Text("删除后不再按此安排执行。已有对话记录会保留。") }
        .alert("操作未完成", isPresented: Binding(get: { operationError != nil }, set: { if !$0 { operationError = nil } })) {
            Button("好", role: .cancel) { operationError = nil }
        } message: { Text(operationError ?? "请稍后重试") }
        .task {
            await store.refresh()
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(6)) } catch { break }
                if scenePhase == .active { await store.refresh() }
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await store.refresh() } }
        }
    }

    private func taskCard(_ task: ScheduledTask) -> some View {
        HStack(spacing: 14) {
            Button { editor = .init(task: task, isNew: false) } label: {
                HStack(spacing: 16) {
                    Text(task.emoji.isEmpty ? "🕘" : task.emoji).font(.system(size: 25)).frame(width: 31)
                    VStack(alignment: .leading, spacing: 5) {
                        Text(task.title).font(.system(size: 18, weight: .medium)).foregroundStyle(.primary).lineLimit(1)
                        Text(subtitle(task)).font(.system(size: 13)).foregroundStyle(.secondary).lineLimit(1)
                    }
                    Spacer(minLength: 0)
                }.contentShape(Rectangle())
            }.buttonStyle(.plain)
            Menu {
                if task.status != "completed" {
                    Button(task.enabled ? "暂停" : "继续", systemImage: task.enabled ? "pause.circle" : "play.circle") {
                        perform(task.id) { try await store.setPaused(taskId: task.id, paused: task.enabled) }
                    }
                }
                Button("删除", systemImage: "trash", role: .destructive) { deleteTarget = task }
            } label: {
                ShiyanMoreButtonLabel(isLoading: busyTasks.contains(task.id), hasGlass: false)
            }.buttonStyle(.plain).disabled(busyTasks.contains(task.id))
                .accessibilityLabel("\(task.title) 更多选项")
        }
        .padding(.leading, 20).padding(.trailing, 15).padding(.vertical, 19)
        .background(background, in: RoundedRectangle(cornerRadius: 27, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 27, style: .continuous).stroke(border, lineWidth: 1))
        .accessibilityIdentifier("scheduled-task-\(task.id)")
    }

    private func presetCard(_ preset: ScheduledTaskPreset) -> some View {
        Button { editor = .init(task: preset.draft, isNew: true) } label: {
            HStack(spacing: 16) {
                Text(preset.emoji).font(.system(size: 25)).frame(width: 31)
                VStack(alignment: .leading, spacing: 5) {
                    Text(preset.title).font(.system(size: 18, weight: .medium)).foregroundStyle(.primary)
                    Text(preset.prompt).font(.system(size: 13)).foregroundStyle(.secondary).lineLimit(3)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 20).padding(.vertical, 19)
            .frame(maxWidth: .infinity, minHeight: 82, alignment: .leading)
            .overlay(RoundedRectangle(cornerRadius: 25, style: .continuous).stroke(border, style: StrokeStyle(lineWidth: 1, dash: [7, 7])))
            .contentShape(RoundedRectangle(cornerRadius: 25, style: .continuous))
        }.buttonStyle(.plain).accessibilityIdentifier("scheduled-preset-\(preset.id)")
    }

    private func subtitle(_ task: ScheduledTask) -> String {
        let repeatText = ScheduledTaskEditor.repeatTitle(task.repeatType)
        if task.status == "completed" { return "已完成" + (task.lastRun.map { " · " + dateText($0, zone: task.timeZone) } ?? "") }
        if !task.enabled { return "已暂停 · " + repeatText }
        return (task.nextRun.map { dateText($0, zone: task.timeZone) } ?? task.time) + " · " + repeatText
    }

    private func dateText(_ date: Date, zone: String) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: zone) ?? .current
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.timeZone = calendar.timeZone
        formatter.dateFormat = calendar.isDateInToday(date) ? "今天 HH:mm" : "M月d日 HH:mm"
        return formatter.string(from: date)
    }

    private func perform(_ id: String, operation: @escaping @MainActor () async throws -> Void) {
        guard !busyTasks.contains(id) else { return }
        busyTasks.insert(id)
        Task {
            defer { busyTasks.remove(id) }
            do { try await operation() } catch { operationError = error.localizedDescription }
        }
    }
}

private struct ScheduledTaskEditor: View {
    @State var task: ScheduledTask
    let isNew: Bool
    @ObservedObject private var store = ScheduledTaskStore.shared
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var saving = false
    @State private var hasEndDate = false
    @State private var selectedEndDate = Date()
    @State private var errorMessage: String?
    @State private var confirmingDelete = false
    @State private var customRepeat = false

    private var background: Color { colorScheme == .dark ? Color(white: 0.065) : .white }
    private var border: Color { Color.primary.opacity(colorScheme == .dark ? 0.14 : 0.10) }
    private let repeats = ["once", "daily", "weekdays", "weekly", "monthly", "hourly"]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    titleField
                    instructionField
                    notificationField
                    repeatField
                    timeField
                    startDateField
                    endRepeatField
                    saveField
                }
                .padding(.horizontal, 16).padding(.top, 24).padding(.bottom, 28)
            }
            .scrollIndicators(.hidden).scrollDismissesKeyboard(.interactively)
            .background(background).navigationTitle(isNew ? "新建任务" : "编辑任务")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    ShiyanCloseButton(action: { dismiss() }, inToolbar: true)
                }
                if !isNew {
                    ToolbarItem(placement: .topBarTrailing) {
                        ShiyanMoreMenu(inToolbar: true) {
                            if !isNew {
                                if task.status != "completed" {
                                    Button(task.enabled ? "暂停" : "继续", systemImage: task.enabled ? "pause.circle" : "play.circle") {
                                        updatePaused()
                                    }.disabled(saving)
                                }
                                Button("删除", systemImage: "trash", role: .destructive) { confirmingDelete = true }
                                    .disabled(saving)
                            }
                            Button(isNew ? "创建任务" : "保存修改", systemImage: "checkmark") { save() }
                                .disabled(saving || task.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        }
                    }
                    .sharedBackgroundVisibility(.hidden)
                }
            }
            .alert("操作未完成", isPresented: Binding(get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } })) {
                Button("好", role: .cancel) { errorMessage = nil }
            } message: { Text(errorMessage ?? "请稍后重试") }
            .alert("删除定时任务？", isPresented: $confirmingDelete) {
                Button("取消", role: .cancel) {}
                Button("删除", role: .destructive) { delete() }
            } message: { Text("已有对话记录会保留。") }
        }
        .onAppear {
            hasEndDate = task.endDate != nil
            selectedEndDate = task.endDate ?? max(Date(), startDateBinding.wrappedValue)
        }
        .interactiveDismissDisabled(saving)
    }

    private var titleField: some View {
        HStack(spacing: 18) {
            Text(task.emoji.isEmpty ? "🕘" : task.emoji).font(.system(size: 26)).frame(width: 30)
            TextField("任务名称", text: $task.title).font(.system(size: 18))
                .accessibilityIdentifier("scheduled-editor-title")
        }.padding(.horizontal, 22).frame(minHeight: 57).modifier(ScheduledTaskFieldSurface(border: border))
    }

    private var instructionField: some View {
        TextField("说明…", text: $task.prompt, axis: .vertical)
            .font(.system(size: 18)).lineSpacing(4).lineLimit(6...1000)
            .padding(.horizontal, 22).padding(.vertical, 16)
            .modifier(ScheduledTaskFieldSurface(border: border))
            .accessibilityIdentifier("scheduled-editor-instruction")
    }

    private var notificationField: some View {
        Toggle("完成时通知", isOn: $task.notifyWhenComplete)
            .font(.system(size: 17)).tint(.accentColor)
            .padding(.horizontal, 22).frame(minHeight: 57)
            .modifier(ScheduledTaskFieldSurface(border: border))
    }

    private var repeatField: some View {
        VStack(spacing: 0) {
            HStack {
                Text("重复")
                Spacer()
                Menu {
                    ForEach(repeats, id: \.self) { value in
                        Button(Self.repeatTitle(value)) { task.repeatType = value; customRepeat = false }
                    }
                    Button("自定义") { customRepeat = true }
                } label: {
                    HStack(spacing: 9) {
                        Text(customRepeat ? "自定义" : Self.repeatTitle(task.repeatType)).foregroundStyle(.secondary)
                        Image(systemName: "chevron.up.chevron.down").font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
                    }
                }.buttonStyle(.plain)
            }.padding(.horizontal, 22).frame(minHeight: 57)
            if customRepeat {
                Divider().padding(.horizontal, 1)
                NavigationLink {
                    repeatOptions
                } label: {
                    HStack {
                        Text(Self.repeatTitle(task.repeatType)).foregroundStyle(.secondary)
                        Spacer()
                        Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(.secondary)
                    }.padding(.horizontal, 22).frame(minHeight: 56)
                }.buttonStyle(.plain)
            }
        }.font(.system(size: 17)).modifier(ScheduledTaskFieldSurface(border: border))
    }

    private var timeField: some View {
        HStack {
            Text("时间")
            Spacer()
            DatePicker("时间", selection: timeBinding, displayedComponents: .hourAndMinute)
                .labelsHidden().datePickerStyle(.compact).environment(\.locale, Locale(identifier: "zh_CN"))
                .environment(\.timeZone, calendar.timeZone)
        }.font(.system(size: 17)).padding(.horizontal, 22).frame(minHeight: 57)
            .modifier(ScheduledTaskFieldSurface(border: border))
    }

    @ViewBuilder
    private var startDateField: some View {
        if task.repeatType == "once" || task.repeatType == "weekly" || task.repeatType == "monthly" {
            HStack {
                Text(task.repeatType == "weekly" ? "开始日期 / 星期" : "开始日期")
                Spacer()
                DatePicker("开始日期", selection: startDateBinding, displayedComponents: .date)
                    .labelsHidden().datePickerStyle(.compact).environment(\.locale, Locale(identifier: "zh_CN"))
                    .environment(\.timeZone, calendar.timeZone)
            }.font(.system(size: 17)).padding(.horizontal, 22).frame(minHeight: 57)
                .modifier(ScheduledTaskFieldSurface(border: border))
        }
    }

    private var endRepeatField: some View {
        VStack(spacing: 0) {
            HStack {
                Text("结束重复")
                Spacer()
                Menu {
                    Button("永不") { hasEndDate = false }
                    Button("选择日期") { hasEndDate = true }
                } label: {
                    HStack(spacing: 9) {
                        Text(hasEndDate ? "指定日期" : "永不").foregroundStyle(.secondary)
                        Image(systemName: "chevron.up.chevron.down").font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
                    }
                }.buttonStyle(.plain)
            }.padding(.horizontal, 22).frame(minHeight: 57)
            if hasEndDate {
                Divider()
                DatePicker("结束日期", selection: $selectedEndDate, in: startDateBinding.wrappedValue..., displayedComponents: .date)
                    .font(.system(size: 17)).datePickerStyle(.compact)
                    .environment(\.locale, Locale(identifier: "zh_CN"))
                    .environment(\.timeZone, calendar.timeZone)
                    .padding(.horizontal, 22).frame(minHeight: 57)
            }
        }.font(.system(size: 17)).modifier(ScheduledTaskFieldSurface(border: border))
    }

    private var saveField: some View {
        Button(action: save) {
            Group {
                if saving { ProgressView().tint(.white) }
                else { Text(isNew ? "创建" : "保存").font(.system(size: 17, weight: .semibold)) }
            }
            .frame(maxWidth: .infinity).frame(height: 49)
            .foregroundStyle(.white).background(Color.accentColor, in: Capsule())
        }.buttonStyle(.plain).disabled(saving || task.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .opacity(task.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0.45 : 1)
            .accessibilityIdentifier("scheduled-editor-save")
    }


    private var repeatOptions: some View {
        List {
            ForEach(repeats, id: \.self) { value in
                Button {
                    task.repeatType = value
                } label: {
                    HStack {
                        Text(Self.repeatTitle(value)).foregroundStyle(.primary)
                        Spacer()
                        if task.repeatType == value { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
                    }
                }
            }
        }.navigationTitle("自定义重复").navigationBarTitleDisplayMode(.inline)
    }

    static func repeatTitle(_ value: String) -> String {
        ["once": "不重复", "daily": "每天", "weekdays": "工作日", "weekly": "每周", "monthly": "每月", "hourly": "每小时"][value] ?? "自定义"
    }

    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: task.timeZone) ?? .current
        return calendar
    }

    private var timeBinding: Binding<Date> {
        Binding(get: {
            let parts = task.time.split(separator: ":").compactMap { Int($0) }
            return calendar.date(bySettingHour: parts.first ?? 9, minute: parts.count > 1 ? parts[1] : 0, second: 0, of: Date()) ?? Date()
        }, set: { value in
            let parts = calendar.dateComponents([.hour, .minute], from: value)
            task.time = String(format: "%02d:%02d", parts.hour ?? 9, parts.minute ?? 0)
        })
    }

    private var startDateBinding: Binding<Date> {
        Binding(get: {
            let formatter = DateFormatter()
            formatter.dateFormat = "yyyy-MM-dd"; formatter.timeZone = calendar.timeZone
            return formatter.date(from: task.startDate) ?? Date()
        }, set: { value in
            let formatter = DateFormatter()
            formatter.dateFormat = "yyyy-MM-dd"; formatter.timeZone = calendar.timeZone
            task.startDate = formatter.string(from: value)
        })
    }

    private func save() {
        guard !saving else { return }
        saving = true
        task.endDate = hasEndDate ? selectedEndDate : nil
        Task {
            defer { saving = false }
            do { try await store.save(task); dismiss() }
            catch { errorMessage = error.localizedDescription }
        }
    }

    private func updatePaused() {
        guard !saving else { return }
        saving = true
        Task {
            defer { saving = false }
            do { try await store.setPaused(taskId: task.id, paused: task.enabled); dismiss() }
            catch { errorMessage = error.localizedDescription }
        }
    }

    private func delete() {
        guard !saving else { return }
        saving = true
        Task {
            defer { saving = false }
            do { try await store.delete(taskId: task.id); dismiss() }
            catch { errorMessage = error.localizedDescription }
        }
    }
}

private struct ScheduledTaskFieldSurface: ViewModifier {
    let border: Color
    func body(content: Content) -> some View {
        content.overlay(RoundedRectangle(cornerRadius: 26, style: .continuous).stroke(border, lineWidth: 1))
    }
}
