import SwiftUI

struct AgentStepSummary: Decodable, Equatable {
    var id: String
    var title: String
    var summary: String
    var detail: String
}
struct AgentStepSummaryResponse: Decodable { var steps: [AgentStepSummary] }

/// 执行过程页：状态、标题、结果，下面是逐步列表，点一步进入详情。普通对话和 Dots 任务共用。
struct AgentStepsPage: View {
    enum Status {
        case done, running, failed, waiting
        var label: String { switch self { case .done: "已完成"; case .running: "进行中"; case .failed: "未完成"; case .waiting: "等待确认" } }
        var color: Color { switch self { case .done: .green; case .running: .blue; case .failed: .red; case .waiting: .orange } }
    }
    var status: Status
    var title: String
    var summary: String? = nil
    var time: Date? = nil
    var result: String? = nil
    var steps: [AgentExecutionPresentation.Item]
    @State private var ai: [String: AgentStepSummary] = [:]
    @State private var resultExpanded = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                header.padding(.horizontal, 20).padding(.bottom, 20)
                if let text = cleanResult, !text.isEmpty {
                    Divider()
                    Button { withAnimation(.easeInOut(duration: 0.2)) { resultExpanded.toggle() } } label: {
                        Text(text).font(.system(size: 17)).foregroundStyle(.secondary)
                            .lineLimit(resultExpanded ? nil : 6).multilineTextAlignment(.leading)
                            .frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
                    }.buttonStyle(.plain).padding(20)
                }
                Divider()
                Text("执行步骤").font(.system(.subheadline, design: .monospaced).weight(.semibold))
                    .padding(.horizontal, 20).padding(.top, 22).padding(.bottom, 14)
                if steps.isEmpty {
                    Text(status == .running ? "正在执行…" : "这次没有调用工具").font(.subheadline).foregroundStyle(.secondary).padding(.horizontal, 20)
                }
                ForEach(Array(steps.enumerated()), id: \.element.id) { index, step in
                    NavigationLink { AgentStepDetailView(step: step, ai: ai[step.id]) } label: { row(step, last: index == steps.count - 1) }
                        .buttonStyle(.plain)
                }
            }.padding(.vertical, 8)
        }
        .scrollIndicators(.hidden)
        .task(id: steps.map(\.id).joined(separator: ",")) { await loadSummaries() }
    }
    private var cleanResult: String? {
        guard let result else { return nil }
        let text = result.replacingOccurrences(of: "**", with: "").replacingOccurrences(of: "`", with: "")
            .replacingOccurrences(of: #"(?m)^#{1,6}\s*"#, with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? nil : String(text.prefix(4000))
    }
    private var header: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(status.label).font(.system(size: 15, weight: .medium)).foregroundStyle(status.color)
                .padding(.horizontal, 10).padding(.vertical, 5)
                .background(status.color.opacity(0.12), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            Text(title).font(.system(size: 22, weight: .bold)).fixedSize(horizontal: false, vertical: true)
            if let summary, !summary.isEmpty { Text(summary).font(.system(size: 17)) }
            if let time {
                Text(Calendar.current.isDateInToday(time) ? time.formatted(date: .omitted, time: .shortened) : time.formatted(.dateTime.month().day().hour().minute()))
                    .font(.system(size: 15)).foregroundStyle(.secondary)
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
    private func row(_ step: AgentExecutionPresentation.Item, last: Bool) -> some View {
        let info = ai[step.id]
        let subtitle = info?.summary ?? step.subtitle
        return HStack(alignment: .top, spacing: 12) {
            VStack(spacing: 0) {
                Image(systemName: Self.symbol(step.status)).font(.system(size: 21)).foregroundStyle(Self.color(step.status))
                    .frame(width: 24, height: 24)
                if !last {
                    AgentStepConnector().stroke(style: StrokeStyle(lineWidth: 1.2, lineCap: .round, dash: [2, 4]))
                        .foregroundStyle(Color.secondary.opacity(0.5)).frame(width: 2).frame(maxHeight: .infinity).padding(.vertical, 4)
                }
            }.frame(width: 24)
            VStack(alignment: .leading, spacing: 4) {
                Text(info?.title ?? step.title).font(.system(size: 17, weight: .semibold)).foregroundStyle(.primary)
                    .multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                if !subtitle.isEmpty {
                    Text(subtitle).font(.system(size: 15, design: info == nil && step.type == "command_execution" ? .monospaced : .default))
                        .foregroundStyle(.secondary).lineLimit(3).multilineTextAlignment(.leading)
                }
            }.padding(.bottom, last ? 8 : 24).frame(maxWidth: .infinity, alignment: .leading)
            Image(systemName: "chevron.right").font(.system(size: 14, weight: .medium)).foregroundStyle(.tertiary).padding(.top, 4)
        }.padding(.horizontal, 20).contentShape(Rectangle())
    }
    static func symbol(_ status: String) -> String {
        switch status {
        case "failed": "exclamationmark.circle"
        case "in_progress", "running": "circle.dotted"
        case "cancelled", "interrupted": "stop.circle"
        default: "checkmark.circle"
        }
    }
    static func color(_ status: String) -> Color {
        switch status {
        case "failed": .red
        case "in_progress", "running": .blue
        case "cancelled", "interrupted": .secondary
        default: .green
        }
    }
    private func loadSummaries() async {
        guard !steps.isEmpty else { return }
        do {
            let values = try await CodexClient.shared.stepSummaries(steps)
            guard !Task.isCancelled else { return }
            withAnimation(.easeOut(duration: 0.2)) { ai = Dictionary(values.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a }) }
        } catch {}
    }
}

private struct AgentStepConnector: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path(); path.move(to: CGPoint(x: rect.midX, y: rect.minY)); path.addLine(to: CGPoint(x: rect.midX, y: rect.maxY)); return path
    }
}

/// 单个步骤的详情：说明 + 输入 + 输出。
struct AgentStepDetailView: View {
    let step: AgentExecutionPresentation.Item
    let ai: AgentStepSummary?
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text(ai?.title ?? step.title).font(.system(size: 22, weight: .bold)).fixedSize(horizontal: false, vertical: true)
                if let detail = ai?.detail, !detail.isEmpty {
                    AgentMarkdown(text: detail, identifier: "step-detail-" + step.id)
                } else if let summary = ai?.summary, !summary.isEmpty {
                    Text(summary).font(.system(size: 17))
                }
                if !step.subtitle.isEmpty { block(step.type == "command_execution" ? "命令" : "输入", step.subtitle) }
                if !step.tasks.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(Array(step.tasks.enumerated()), id: \.offset) { _, task in
                            Label(task.text, systemImage: task.completed ? "checkmark.circle.fill" : "circle").font(.subheadline)
                        }
                    }
                }
                ForEach(step.files) { file in
                    block(file.path + [file.added.map { " +\($0)" }, file.removed.map { " −\($0)" }].compactMap { $0 }.joined(), file.diff.isEmpty ? file.kind : file.diff)
                }
                if !step.body.isEmpty { block(step.status == "failed" ? "错误" : "输出", step.body) }
            }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollIndicators(.hidden)
        .navigationTitle("").navigationBarTitleDisplayMode(.inline)
    }
    private func block(_ label: String, _ text: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label).font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
            Text(text).font(.system(.footnote, design: .monospaced)).textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading).padding(12)
                .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
    }
}

extension AgentExecutionPresentation {
    /// 执行过程页里展示的步骤：不含思考和计划。
    static func steps(_ items: [Item]) -> [Item] {
        items.filter { !["reasoning", "todo_list"].contains($0.type) }
    }
}

extension DotsGoal {
    var stepsStatus: AgentStepsPage.Status {
        switch status ?? "" {
        case "done", "completed": .done
        case "failed", "blocked", "cancelled": .failed
        case "needs_approval", "waiting_approval", "awaiting_approval": .waiting
        default: .running
        }
    }
    /// 从任务时间线还原执行步骤：工具调用、命令、已批准的操作。
    var executionSteps: [AgentExecutionPresentation.Item] {
        var out: [AgentExecutionPresentation.Item] = []
        for entry in timeline ?? [] {
            let kind = entry.kind ?? ""
            guard ["tool_action", "tool_error", "approval_executed", "approval_failed", "approval_unknown"].contains(kind) else { continue }
            var object: [String: AgentSyncValue] = [:]
            if case .string(let raw)? = entry.data, let parsed = try? JSONDecoder().decode(AgentSyncValue.self, from: Data(raw.utf8)) { object = parsed.object }
            else if let value = entry.data { object = value.object }
            let id = "t\(entry.id)"
            if kind.hasPrefix("approval_") {
                out.append(.init(id: id, type: "approval", title: "执行已批准的操作", subtitle: entry.message ?? "",
                                 status: kind == "approval_executed" ? "completed" : "failed", body: String((object["output"]?.string ?? "").prefix(4000))))
                continue
            }
            if object["type"]?.string == "mcp_tool_call", object["result_text"] == nil,
               let text = object["result"]?.object["content"]?.array.first?.object["text"]?.string { object["result_text"] = .string(text) }
            object["id"] = .string(id)
            if let item = AgentExecutionPresentation.items(displayItems: [.object(object)], rawResult: nil).first {
                if !["reasoning", "todo_list"].contains(item.type) { out.append(item) }
                continue
            }
            let type = object["type"]?.string ?? "action"
            let ok = object["ok"]?.boolean ?? (kind != "tool_error")
            let names = ["mac_codex": "在 Mac 上执行", "host_command": "执行命令", "write_file": "写入文件", "append_file": "追加文件",
                         "mkdir": "创建目录", "delete_file": "删除文件", "run_command": "执行命令", "inspect_host": "检查运行环境"]
            out.append(.init(id: id, type: type, title: names[type] ?? (entry.message ?? type),
                             subtitle: object["reason"]?.string ?? object["command"]?.string ?? "",
                             status: ok ? "completed" : "failed",
                             body: String((object["detail"]?.string ?? object["output"]?.string ?? "").prefix(4000))))
        }
        return Array(out.suffix(60))
    }
}
