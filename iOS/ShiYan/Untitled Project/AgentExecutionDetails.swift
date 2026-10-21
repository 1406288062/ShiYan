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


struct AgentExecutionHistoryView: View {
    let messages: [AgentMessage]
    @Environment(\.dismiss) private var dismiss
    @ScaledMetric(relativeTo: .body) private var rowHeight: CGFloat = 44
    @State private var selectedID: UUID?
    @State private var choosingRound = false
    private var rounds: [AgentMessage] { messages.filter { $0.role == .assistant } }
    private var selection: AgentMessage? { rounds.first { $0.id == selectedID } ?? rounds.last }
    private var selectedIndex: Int { rounds.firstIndex { $0.id == selection?.id } ?? 0 }
    private func messageName(for round: AgentMessage) -> String {
        guard let index = messages.firstIndex(where: { $0.id == round.id }),
              let prompt = messages[..<index].last(where: { $0.role == .user }) else { return "" }
        let title = prompt.text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        return title.isEmpty ? (prompt.assets.first?.filename ?? "附件消息") : title
    }

    private func roundLabel(_ round: AgentMessage, index: Int) -> some View {
        HStack(spacing: 10) {
            Text("第 \(index + 1) 轮").fixedSize()
            Text(messageName(for: round))
                .foregroundStyle(.secondary)
                .lineLimit(1).truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    var body: some View {
        NavigationStack {
            GeometryReader { geometry in
                VStack(alignment: .leading, spacing: 12) {
                    Button { choosingRound.toggle() } label: {
                        HStack {
                            if let round = selection {
                                roundLabel(round, index: selectedIndex)
                            } else {
                                Text("暂无执行轮次")
                                Spacer()
                            }
                            Image(systemName: choosingRound ? "chevron.up" : "chevron.down")
                        }
                        .font(.subheadline).padding(.horizontal, 12).frame(minHeight: rowHeight)
                        .background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 12))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(rounds.isEmpty)
                    .accessibilityIdentifier("execution-round-picker")
                    if choosingRound {
                        ScrollViewReader { proxy in
                            ScrollView(showsIndicators: false) {
                                LazyVStack(spacing: 0) {
                                    ForEach(Array(rounds.enumerated()), id: \.element.id) { index, message in
                                        Button {
                                            selectedID = message.id; choosingRound = false
                                        } label: {
                                            HStack {
                                                roundLabel(message, index: index)
                                                if message.id == selection?.id { Image(systemName: "checkmark") }
                                            }
                                            .font(.body).padding(.horizontal, 12).frame(height: rowHeight)
                                            .contentShape(Rectangle())
                                        }
                                        .buttonStyle(.plain).id(message.id)
                                    }
                                }
                            }
                            .frame(height: min(CGFloat(min(rounds.count, 10)) * rowHeight, max(rowHeight, geometry.size.height * 0.45)))
                            .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 12))
                            .onAppear { if let id = selection?.id { proxy.scrollTo(id, anchor: .center) } }
                        }
                        .accessibilityIdentifier("execution-round-list")
                    }
                    ScrollView(showsIndicators: false) {
                        if let message = selection {
                            if AgentExecutionDetails.hasDetails(message) {
                                AgentExecutionDetails(message: message, initiallyExpanded: true).id(message.id)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            } else {
                                Text(message.isWorking ? "等待执行记录…" : "本轮暂无执行记录")
                                    .font(.subheadline).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                    }
                }
                .padding(20)
            }
            .navigationTitle("执行过程").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { ShiyanCloseButton(action: { dismiss() }, inToolbar: true) }
            }
        }
        .presentationDetents([.large])
    }
}
