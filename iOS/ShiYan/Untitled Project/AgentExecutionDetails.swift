import SwiftUI
import UIKit

 
struct AgentExecutionDetails: View {
    let message: AgentMessage
    var onSelectionChanged: ((Bool) -> Void)?
    var initiallyExpanded = false
    @State private var expanded = false
    @State private var rawExpanded = false
    @State private var loadedDetails: AgentExecutionPayload?
    @State private var loadingDetails = false
    @State private var detailsError: String?
    private var remoteDetailsAvailable: Bool { message.syncMetadata?["executionDetailsAvailable"]?.boolean == true }
    private var rawText: String? { loadedDetails?.fullJSON ?? message.rawResult }
    private var items: [AgentExecutionPresentation.Item] {
        AgentExecutionPresentation.items(displayItems: message.displayItems, rawResult: message.rawResult)
    }
    private var files: [AgentExecutionPresentation.File] { AgentExecutionPresentation.files(message) }
    static func hasDetails(_ message: AgentMessage) -> Bool {
        message.syncMetadata?["executionDetailsAvailable"]?.boolean == true || !(message.displayItems ?? []).isEmpty || !(message.fileChanges ?? []).isEmpty ||
            !AgentExecutionPresentation.usage(message.usage).isEmpty || AgentExecutionPresentation.hasRaw(message.rawResult)
    }
    var body: some View {
        if Self.hasDetails(message) {
            DisclosureGroup(isExpanded: $expanded) {
                if expanded {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(items) { item in
                        if item.type != "file_change" || files.isEmpty { activity(item) }
                    }
                    if !files.isEmpty { fileList(files) }
                    let usage = AgentExecutionPresentation.usage(message.usage)
                    if !usage.isEmpty {
                        Text(usage.map { "\($0.label) \($0.count.formatted())" }.joined(separator: " · ") + " tokens")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    if remoteDetailsAvailable || AgentExecutionPresentation.hasRaw(rawText) {
                        DisclosureGroup(isExpanded: $rawExpanded) {
                            if rawExpanded { rawDetailsBody }
                        } label: {
                            Text(remoteDetailsAvailable ? "完整执行记录" : "原始返回数据")
                        }
                        .task(id: rawExpanded) {
                            guard rawExpanded, remoteDetailsAvailable, loadedDetails == nil else { return }
                            loadingDetails = true; detailsError = nil
                            defer { loadingDetails = false }
                            do { loadedDetails = try await CodexClient.shared.executionDetails(messageID: message.id) }
                            catch { if !Task.isCancelled { detailsError = error.localizedDescription } }
                        }
                        .font(.caption).foregroundStyle(.secondary)
                    }
                }.padding(.top, 8)
                }
            } label: {
                HStack(spacing: 6) {
                    Text("处理过程")
                    if expanded, let plan = items.last(where: { $0.type == "todo_list" }), !plan.tasks.isEmpty {
                        Text(plan.subtitle).monospacedDigit()
                    }
                }.font(.footnote).foregroundStyle(.secondary)
            }
            .onAppear { if initiallyExpanded { expanded = true } }
            .onChange(of: expanded) { _, open in
                if !open { rawExpanded = false; loadedDetails = nil; detailsError = nil }
            }
            .accessibilityIdentifier("agent-execution-\(message.id.uuidString)")
        }
    }
    @ViewBuilder private var rawDetailsBody: some View {
        if loadingDetails { ProgressView("加载完整执行记录") }
        else if let error = detailsError { Text(error).foregroundStyle(.red) }
        else if let raw = rawText {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Spacer()
                    Button { UIPasteboard.general.string = raw } label: { Label { Text("复制") } icon: { Image(uiImage: AgentCopyStyle.menuImage) } }
                        .buttonStyle(.plain).accessibilityLabel("复制完整执行记录")
                }
                let preview = String(decoding: raw.utf8.prefix(16000), as: UTF8.self)
                selectable(preview + (raw.utf8.count > 16000 ? "\n…（显示已截取，复制可获取完整数据）" : ""), monospaced: true, suffix: "raw")
            }
        }
    }
    @ViewBuilder private func activity(_ item: AgentExecutionPresentation.Item) -> some View {
        if item.hasBody && item.tasks.isEmpty {
            AgentLazyExecutionDisclosure {
                VStack(alignment: .leading, spacing: 8) {
                    if item.type == "command_execution", !item.subtitle.isEmpty {
                        selectable(item.subtitle, monospaced: true, suffix: item.id + "-command")
                    }
                    if !item.body.isEmpty {
                        selectable(item.body, monospaced: item.type == "command_execution", suffix: item.id)
                    }
                    if !item.files.isEmpty { fileList(item.files) }
                }.padding(.top, 6)
            } label: { activityLabel(item) }
        } else {
            VStack(alignment: .leading, spacing: 6) {
                activityLabel(item)
                ForEach(Array(item.tasks.enumerated()), id: \.offset) { index, task in
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: task.completed ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(.secondary).accessibilityLabel(task.completed ? "已完成" : "待完成")
                        selectable(task.text, suffix: item.id + "-task-\(index)")
                    }
                }
            }
        }
    }
    private func activityLabel(_ item: AgentExecutionPresentation.Item) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: statusSymbol(item.status)).foregroundStyle(item.status == "failed" ? Color.red : Color.secondary)
                .accessibilityLabel(statusLabel(item.status))
            VStack(alignment: .leading, spacing: 3) {
                Text(item.title).font(.footnote)
                if !item.subtitle.isEmpty {
                    Text(item.subtitle).font(.system(.caption, design: item.type == "command_execution" ? .monospaced : .default))
                        .foregroundStyle(.secondary).lineLimit(2)
                }
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
    private func fileList(_ values: [AgentExecutionPresentation.File]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(values) { file in
                if file.diff.isEmpty { fileLabel(file) }
                else {
                    AgentLazyExecutionDisclosure {
                        selectable(file.diff, monospaced: true, suffix: "diff-" + file.path)
                            .padding(10).background(Color.primary.opacity(0.055), in: RoundedRectangle(cornerRadius: 10))
                    } label: { fileLabel(file) }
                }
            }
        }
    }
    private func fileLabel(_ file: AgentExecutionPresentation.File) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .top, spacing: 6) {
                Image(systemName: "doc.text")
                Text(file.path).fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
                if let added = file.added { Text("+\(added)").foregroundStyle(.green) }
                if let removed = file.removed { Text("−\(removed)").foregroundStyle(.red) }
                if !file.kind.isEmpty { Text(file.kind).foregroundStyle(.secondary) }
            }.font(.caption)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
    private func selectable(_ text: String, monospaced: Bool = false, suffix: String) -> some View {
        AgentSelectableText(text: text, monospaced: monospaced,
                            identifier: "activity-\(message.id.uuidString)-\(suffix)", onSelectionChanged: onSelectionChanged)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
    private func statusSymbol(_ status: String) -> String {
        switch status {
        case "completed": return "checkmark.circle"
        case "failed": return "exclamationmark.circle"
        case "in_progress", "running": return "clock"
        case "cancelled", "interrupted": return "stop.circle"
        default: return "circle.dotted"
        }
    }
    private func statusLabel(_ status: String) -> String {
        switch status {
        case "completed": return "已完成"
        case "failed": return "失败"
        case "in_progress", "running": return "进行中"
        case "cancelled", "interrupted": return "已停止"
        default: return "处理记录"
        }
    }
}

 
struct AgentFileChangeCard: View {
    let files: [AgentExecutionPresentation.File]
    let messageID: UUID
    var onSelectionChanged: ((Bool) -> Void)?
    @State private var expanded = false
    private var hasDiff: Bool { files.contains { !$0.diff.isEmpty } }
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: "doc.text")
                    .font(.system(size: 20, weight: .medium)).foregroundStyle(.secondary)
                Text("已编辑 \(files.count) 个文件").font(.subheadline.weight(.medium))
                Spacer(minLength: 6)
                if hasDiff {
                    Button(expanded ? "收起变更" : "查看变更") { expanded.toggle() }
                        .font(.caption.weight(.medium)).buttonStyle(.plain)
                        .frame(minHeight: 44).contentShape(Rectangle())
                }
            }.padding(.horizontal, 12).padding(.vertical, hasDiff ? 2 : 12)
            Divider()
            VStack(alignment: .leading, spacing: 12) {
                ForEach(files) { file in
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(alignment: .top, spacing: 8) {
                            Text(file.path).font(.caption).foregroundStyle(.primary)
                                .fixedSize(horizontal: false, vertical: true)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .textSelection(.enabled)
                            HStack(spacing: 4) {
                                if let added = file.added { Text("+\(added)").foregroundStyle(.green) }
                                if let removed = file.removed { Text("−\(removed)").foregroundStyle(.red) }
                            }.font(.caption).monospacedDigit().fixedSize()
                        }
                        if expanded, !file.diff.isEmpty {
                            AgentSelectableText(text: file.diff, monospaced: true,
                                                identifier: "change-\(messageID.uuidString)-\(file.path)",
                                                onSelectionChanged: onSelectionChanged)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(8).background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
                        }
                    }
                }
            }.padding(12)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.primary.opacity(0.025), in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Color.primary.opacity(0.10), lineWidth: 1))
        .accessibilityIdentifier("agent-file-changes-\(messageID.uuidString)")
    }
}

private struct AgentLazyExecutionDisclosure<Content: View, Label: View>: View {
    @State private var expanded = false
    private let content: () -> Content
    private let label: () -> Label
    init(@ViewBuilder content: @escaping () -> Content, @ViewBuilder label: @escaping () -> Label) {
        self.content = content; self.label = label
    }
    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            if expanded { content() }
        } label: { label() }
    }
}


/// 执行过程：先列出我发过的消息（太长只留开头）、这一轮在干嘛和时间；点一条进入步骤详情。
struct AgentExecutionHistoryView: View {
    let messages: [AgentMessage]
    @Environment(\.dismiss) private var dismiss
    @State private var doing: [String: String] = [:]
    private struct Round: Identifiable { var prompt: AgentMessage?; var reply: AgentMessage; var id: UUID { reply.id } }
    private var rounds: [Round] {
        messages.enumerated().compactMap { index, message in
            guard message.role == .assistant else { return nil }
            return Round(prompt: messages[..<index].last(where: { $0.role == .user }), reply: message)
        }.reversed()
    }
    private func promptText(_ prompt: AgentMessage?) -> String {
        guard let prompt else { return "（没有对应的消息）" }
        let text = prompt.text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        return text.isEmpty ? (prompt.assets.first?.filename ?? "附件消息") : text
    }
    private func timeText(_ date: Date) -> String {
        Calendar.current.isDateInToday(date) ? date.formatted(date: .omitted, time: .shortened) : date.formatted(.dateTime.month().day().hour().minute())
    }

    var body: some View {
        NavigationStack {
            List {
                if rounds.isEmpty {
                    Text("这个对话还没有执行记录").foregroundStyle(.secondary).listRowSeparator(.hidden)
                }
                ForEach(rounds) { round in
                    NavigationLink {
                        AgentStepsPage(status: round.reply.isWorking ? .running : (round.reply.error?.isEmpty == false ? .failed : .done),
                                       title: String(promptText(round.prompt).prefix(80)) + (promptText(round.prompt).count > 80 ? "…" : ""),
                                       time: round.reply.completedAt ?? round.reply.createdAt,
                                       result: round.reply.text, prompt: round.prompt?.text ?? "",
                                       steps: AgentExecutionPresentation.steps(AgentExecutionPresentation.items(displayItems: round.reply.displayItems, rawResult: round.reply.rawResult)))
                            .navigationTitle("").navigationBarTitleDisplayMode(.inline)
                    } label: {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(promptText(round.prompt)).font(.system(size: 17)).foregroundStyle(.primary).lineLimit(3)
                            HStack(spacing: 6) {
                                if let text = doing[round.reply.id.uuidString] { Text(text).lineLimit(1) }
                                else if round.reply.isWorking { Text("正在执行") }
                                Text(timeText(round.reply.completedAt ?? round.reply.createdAt)).foregroundStyle(.tertiary)
                            }.font(.system(size: 14)).foregroundStyle(.secondary)
                        }.padding(.vertical, 6)
                    }
                    .listRowBackground(Color(uiColor: .systemBackground))
                }
            }
            .listStyle(.plain)
            .navigationTitle("执行过程").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { ShiyanCloseButton(action: { dismiss() }, inToolbar: true) } }
            .task { await loadDoing() }
        }
        .presentationDetents([.large])
    }
    private func loadDoing() async {
        let items = rounds.prefix(40).map { (id: $0.reply.id.uuidString, prompt: $0.prompt?.text ?? "", reply: $0.reply.text) }
        guard !items.isEmpty, let values = try? await AgentRoundSummaries.shared.load(items) else { return }
        withAnimation(.easeOut(duration: 0.2)) { doing = values.mapValues(\.doing) }
    }
}

struct AgentRoundSummary: Decodable, Equatable { var id: String; var doing: String; var result: String }
struct AgentRoundSummaryResponse: Decodable { var rounds: [AgentRoundSummary] }

/// 每轮“在干嘛 / 结果总结”的内存缓存，避免反复请求。
@MainActor final class AgentRoundSummaries {
    static let shared = AgentRoundSummaries()
    private var cache: [String: AgentRoundSummary] = [:]
    func load(_ items: [(id: String, prompt: String, reply: String)]) async throws -> [String: AgentRoundSummary] {
        let missing = items.filter { cache[$0.id] == nil && !($0.prompt.isEmpty && $0.reply.isEmpty) }
        if !missing.isEmpty {
            for value in try await CodexClient.shared.roundSummaries(missing) { cache[value.id] = value }
        }
        return cache.filter { key, _ in items.contains { $0.id == key } }
    }
}

// MARK: - 执行过程时间线 + 思考链（聊天气泡内）

/// 进行中：展开，显示当前步骤和实时思考；完成后：收起为一行摘要，可展开查看完整时间线。
struct AgentProcessTimeline: View {
    let message: AgentMessage
    var onSelectionChanged: ((Bool) -> Void)?
    @State private var expanded = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var items: [AgentExecutionPresentation.Item] {
        AgentExecutionPresentation.items(displayItems: message.displayItems, rawResult: nil)
    }

    var body: some View {
        let steps = items
        if message.isWorking {
            VStack(alignment: .leading, spacing: 10) {
                liveHeader(steps)
                if !steps.isEmpty { timeline(Array(steps.suffix(6)), live: true) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier("agent-process-live")
        } else if !steps.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Button {
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    withAnimation(reduceMotion ? nil : .spring(response: 0.32, dampingFraction: 0.86)) { expanded.toggle() }
                } label: { summary(steps) }
                .buttonStyle(.plain)
                if expanded {
                    timeline(steps, live: false)
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier("agent-process-\(message.id.uuidString)")
        }
    }

    // —— 头部 ——
    private func liveLabel(_ steps: [AgentExecutionPresentation.Item]) -> String {
        switch steps.last?.type {
        case nil, "reasoning": return "正在思考"
        case "command_execution": return "正在运行命令"
        case "web_search": return "正在搜索网页"
        case "mcp_tool_call": return "正在使用工具"
        case "todo_list": return "正在规划"
        case "file_change": return "正在修改文件"
        case "image_generation": return "正在生成图片"
        default: return "正在处理"
        }
    }
    private func liveHeader(_ steps: [AgentExecutionPresentation.Item]) -> some View {
        TimelineView(.animation(minimumInterval: 1 / 30, paused: reduceMotion)) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            let pulse = reduceMotion ? 0 : (t.truncatingRemainder(dividingBy: 1.6)) / 1.6
            let sweep = reduceMotion ? 0.5 : (t.truncatingRemainder(dividingBy: 2.4)) / 2.4
            HStack(spacing: 9) {
                ZStack {
                    Circle().fill(Color.accentColor.opacity(0.35 * (1 - pulse))).frame(width: 8 + 12 * pulse, height: 8 + 12 * pulse)
                    Circle().fill(Color.accentColor).frame(width: 8, height: 8)
                }.frame(width: 18, height: 18)
                Text(liveLabel(steps))
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(LinearGradient(colors: [.secondary, .primary, .secondary],
                        startPoint: UnitPoint(x: sweep * 2.4 - 1.2, y: 0.5), endPoint: UnitPoint(x: sweep * 2.4 - 0.2, y: 0.5)))
                let count = steps.filter { $0.type != "reasoning" }.count
                if count > 0 { Text("\(count) 步").font(.caption).foregroundStyle(.tertiary).monospacedDigit() }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(liveLabel(steps))
    }
    private func summary(_ steps: [AgentExecutionPresentation.Item]) -> some View {
        let thoughts = steps.contains { $0.type == "reasoning" }
        let count = steps.filter { !["reasoning", "todo_list"].contains($0.type) }.count
        let failed = steps.filter { $0.status == "failed" }.count
        return HStack(spacing: 7) {
            Image(systemName: "checkmark").font(.system(size: 9, weight: .bold)).foregroundStyle(.green)
                .frame(width: 17, height: 17).background(Color.green.opacity(0.14), in: Circle())
            Text([thoughts ? "已思考" : nil, count > 0 ? "执行 \(count) 步" : nil].compactMap { $0 }.joined(separator: " · ").ifEmpty("处理过程"))
                .foregroundStyle(.secondary)
            if failed > 0 { Text("· \(failed) 步失败").foregroundStyle(.red) }
            Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold)).foregroundStyle(.tertiary)
                .rotationEffect(.degrees(expanded ? 90 : 0))
        }
        .font(.footnote)
        .padding(.vertical, 4).padding(.leading, 2).padding(.trailing, 8)
        .contentShape(Rectangle())
        .accessibilityLabel("执行过程，" + (expanded ? "已展开" : "已收起"))
    }

    // —— 时间线 ——
    private func timeline(_ steps: [AgentExecutionPresentation.Item], live: Bool) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(steps.enumerated()), id: \.element.id) { index, step in
                let isLast = index == steps.count - 1
                let state = step.status == "failed" ? "failed" : (live && isLast) || ["in_progress", "running"].contains(step.status) ? "running" : "done"
                HStack(alignment: .top, spacing: 10) {
                    VStack(spacing: 0) {
                        node(step.type, state: state)
                        if !isLast { Rectangle().fill(Color.primary.opacity(0.09)).frame(width: 1).frame(maxHeight: .infinity).padding(.vertical, 3) }
                    }.frame(width: 24)
                    VStack(alignment: .leading, spacing: 5) {
                        HStack(spacing: 6) {
                            Text(title(step)).font(.footnote.weight(.medium))
                            if state == "failed" { Text("失败").font(.caption2).foregroundStyle(.red) }
                        }.padding(.top, 3)
                        if !live || isLast || state == "failed" { stepBody(step, live: live && isLast) }
                    }
                    .padding(.bottom, isLast ? 0 : 12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }
    private func node(_ type: String, state: String) -> some View {
        let tint: Color = state == "failed" ? .red : state == "running" ? .accentColor : type == "reasoning" ? Color(red: 0.55, green: 0.42, blue: 0.94) : .secondary
        return Image(systemName: symbol(type))
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(tint)
            .frame(width: 24, height: 24)
            .background(tint.opacity(state == "done" && type != "reasoning" ? 0.08 : 0.13), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
    private func symbol(_ type: String) -> String {
        switch type {
        case "reasoning": return "sparkles"
        case "command_execution": return "terminal"
        case "web_search": return "magnifyingglass"
        case "mcp_tool_call": return "powerplug"
        case "todo_list": return "checklist"
        case "file_change": return "doc.text"
        case "collab_tool_call": return "person.2"
        case "image_generation": return "photo"
        case "error": return "exclamationmark.triangle"
        default: return "circle"
        }
    }
    private func title(_ step: AgentExecutionPresentation.Item) -> String {
        switch step.type {
        case "reasoning": return "思考"
        case "command_execution": return "运行命令"
        case "web_search": return "搜索网页"
        case "mcp_tool_call": return step.subtitle.isEmpty ? "使用工具" : "使用工具 · " + step.subtitle.replacingOccurrences(of: "shiyan-input.", with: "向你确认 / ")
        case "todo_list": return "制定计划"
        case "file_change": return step.files.isEmpty ? "修改文件" : "修改 \(step.files.count) 个文件"
        case "collab_tool_call": return "分派协作任务"
        case "image_generation": return "生成图片"
        case "error": return "遇到问题"
        default: return step.title
        }
    }
    @ViewBuilder private func stepBody(_ step: AgentExecutionPresentation.Item, live: Bool) -> some View {
        switch step.type {
        case "reasoning":
            AgentThoughtText(text: step.body, live: live)
        case "command_execution":
            Text(step.subtitle).font(.system(.caption, design: .monospaced))
                .lineLimit(3).padding(.horizontal, 9).padding(.vertical, 6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            if !step.body.isEmpty { AgentFoldText(label: "输出", text: step.body, monospaced: true) }
        case "web_search":
            if !step.subtitle.isEmpty { Text("“\(step.subtitle)”").font(.caption).foregroundStyle(.secondary) }
        case "mcp_tool_call":
            if !step.body.isEmpty {
                if step.status == "failed" { Text(step.body).font(.caption).foregroundStyle(.red).lineLimit(4) }
                else { AgentFoldText(label: "结果", text: step.body, monospaced: false) }
            }
        case "todo_list":
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(step.tasks.enumerated()), id: \.offset) { _, task in
                    HStack(alignment: .firstTextBaseline, spacing: 7) {
                        Image(systemName: task.completed ? "checkmark.circle.fill" : "circle")
                            .font(.system(size: 11)).foregroundStyle(task.completed ? Color.green : Color.secondary.opacity(0.6))
                        Text(task.text).font(.caption).foregroundStyle(task.completed ? .secondary : .primary)
                            .strikethrough(task.completed, color: .secondary.opacity(0.5))
                    }
                }
            }
        case "file_change":
            VStack(alignment: .leading, spacing: 3) {
                ForEach(step.files.prefix(12)) { file in
                    HStack {
                        Text(file.path.split(separator: "/").suffix(2).joined(separator: "/"))
                            .font(.system(.caption2, design: .monospaced)).lineLimit(1).truncationMode(.head)
                        Spacer(minLength: 8)
                        Text(["add": "新增", "delete": "删除"][file.kind] ?? "修改").font(.caption2)
                            .foregroundStyle(file.kind == "add" ? Color.green : file.kind == "delete" ? Color.red : Color.secondary)
                    }
                }
            }
        case "error":
            Text(step.body).font(.caption).foregroundStyle(.red)
        default:
            if !step.subtitle.isEmpty { Text(step.subtitle).font(.caption).foregroundStyle(.secondary) }
        }
    }
}

/// 思考文字：完成后默认三行，点按展开；进行中显示最新的几行。
private struct AgentThoughtText: View {
    let text: String
    let live: Bool
    @State private var expanded = false
    var body: some View {
        let shown = live && text.count > 360 ? "…" + String(text.suffix(360)) : text
        Text(shown)
            .font(.caption).foregroundStyle(.secondary).lineSpacing(3)
            .lineLimit(live ? 4 : (expanded ? nil : 3))
            .fixedSize(horizontal: false, vertical: true)
            .padding(.leading, 10)
            .overlay(alignment: .leading) {
                Capsule().fill(Color(red: 0.55, green: 0.42, blue: 0.94).opacity(0.35)).frame(width: 2)
            }
            .mask(LinearGradient(stops: live ? [.init(color: .black.opacity(0.25), location: 0), .init(color: .black, location: 0.3)]
                                 : [.init(color: .black, location: 0), .init(color: .black, location: 1)], startPoint: .top, endPoint: .bottom))
            .contentShape(Rectangle())
            .onTapGesture { if !live { withAnimation(.easeInOut(duration: 0.22)) { expanded.toggle() } } }
            .contextMenu { Button("复制思考内容", systemImage: "doc.on.doc") { UIPasteboard.general.string = text } }
            .accessibilityLabel("思考内容：" + text)
    }
}

private struct AgentFoldText: View {
    let label: String
    let text: String
    let monospaced: Bool
    @State private var open = false
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button { withAnimation(.easeInOut(duration: 0.2)) { open.toggle() } } label: {
                HStack(spacing: 3) {
                    Image(systemName: "chevron.right").font(.system(size: 8, weight: .bold)).rotationEffect(.degrees(open ? 90 : 0))
                    Text(label)
                }.font(.caption2).foregroundStyle(.secondary)
            }.buttonStyle(.plain)
            if open {
                ScrollView {
                    Text(text).font(monospaced ? .system(.caption2, design: .monospaced) : .caption2)
                        .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 180)
                .padding(8).background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
        }
    }
}

private extension String {
    func ifEmpty(_ fallback: String) -> String { isEmpty ? fallback : self }
}
