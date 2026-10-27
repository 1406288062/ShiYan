import Foundation

 
enum AgentExecutionPresentation {
    struct Task: Equatable { var text: String; var completed: Bool }
    struct File: Identifiable, Equatable {
        var id: String { path }
        var path: String; var kind: String; var diff: String
        var added: Int?; var removed: Int?
        var beforeSha256: String? = nil
    }
    struct Item: Identifiable, Equatable {
        var id: String; var type: String; var title: String; var subtitle: String
        var status: String; var body: String; var tasks: [Task] = []; var files: [File] = []
        var hasBody: Bool { !body.isEmpty || !tasks.isEmpty || !files.isEmpty }
    }
    static func items(displayItems: [AgentSyncValue]?, rawResult: String?) -> [Item] {
        let values: [AgentSyncValue]
        if let displayItems, !displayItems.isEmpty { values = displayItems }
        else if let rawResult, rawResult.utf8.count <= 262_144,
                let data = rawResult.data(using: .utf8),
                let decoded = try? JSONDecoder().decode(AgentSyncValue.self, from: data) {
            values = decoded.array.isEmpty ? decoded.object["items"]?.array ?? [] : decoded.array
        } else { values = [] }
        return values.prefix(80).enumerated().compactMap { index, value in
            let object = value.object
            let type = object["type"]?.string ?? ""
            var item = Item(id: object["id"]?.string ?? "\(index)-\(type)", type: type,
                            title: "", subtitle: "", status: clipped(object["status"], 80), body: "")
            switch type {
            case "command_execution":
                item.title = "执行命令"; item.subtitle = clipped(object["command"], 1000)
                item.body = clipped(object["aggregated_output"], 4000)
                if let code = integer(object["exit_code"]), code != 0 {
                    item.status = "failed"
                    item.body += (item.body.isEmpty ? "" : "\n") + "退出码：\(code)"
                }
            case "mcp_tool_call":
                item.title = "工具调用"
                item.subtitle = [clipped(object["server"], 120), clipped(object["tool"], 160)].filter { !$0.isEmpty }.joined(separator: ".")
                item.body = clipped(object["result_text"], 4000)
                let error = clipped(object["error"]?.object["message"], 1000)
                if !error.isEmpty { item.status = "failed"; item.body += (item.body.isEmpty ? "" : "\n") + error }
            case "todo_list":
                item.title = "计划"
                item.tasks = (object["items"]?.array ?? []).prefix(32).compactMap {
                    let task = $0.object, text = clipped(task["text"], 500)
                    guard !text.isEmpty else { return nil }
                    return Task(text: text, completed: task["completed"]?.boolean == true)
                }
                item.subtitle = "\(item.tasks.filter(\.completed).count)/\(item.tasks.count)"
            case "web_search":
                item.title = "搜索网页"; item.subtitle = clipped(object["query"], 1000)
            case "file_change":
                item.title = "文件变更"
                item.files = files(object["changes"]?.array)
                item.subtitle = "\(item.files.count) 个文件"
            case "collab_tool_call":
                item.title = "协作"; item.subtitle = clipped(object["tool"], 160)
                if let count = integer(object["count"] ?? object["agents_count"]) { item.subtitle += " · \(count) 个代理" }
                if let statuses = object["agents_status"] {
                    item.body = statuses.object.sorted { $0.key < $1.key }.prefix(12).map {
                        let status = $0.value.string ?? $0.value.object["status"]?.string ?? ""
                        return String($0.key.prefix(16)) + ": " + String(status.prefix(120))
                    }.joined(separator: "\n")
                }
            case "error":
                item.title = "运行提示"; item.status = "failed"; item.body = clipped(object["message"], 2000)
            case "image_generation":
                item.title = "生成图片"
            default: return nil
            }
            return item
        }
    }
    static func files(_ values: [AgentSyncValue]?) -> [File] {
        var seen = Set<String>()
        return (values ?? []).compactMap { value in
            let object = value.object, path = clipped(object["path"], 1000)
            guard !path.isEmpty, seen.insert(path).inserted else { return nil }
            return File(path: path, kind: clipped(object["kind"], 80), diff: clipped(object["diff"], 12000),
                        added: integer(object["added"]), removed: integer(object["removed"]),
                        beforeSha256: object["beforeSha256"]?.string)
        }
    }
     
     
    static func files(_ message: AgentMessage) -> [File] {
        var result = files(message.fileChanges)
        var indices = Dictionary(uniqueKeysWithValues: result.enumerated().map { ($0.element.path, $0.offset) })
        let values: [AgentSyncValue]
        if let displayItems = message.displayItems, !displayItems.isEmpty { values = displayItems }
        else if result.isEmpty, let raw = message.rawResult, raw.utf8.count <= 262_144,
                let data = raw.data(using: .utf8),
                let decoded = try? JSONDecoder().decode(AgentSyncValue.self, from: data) {
            values = decoded.array.isEmpty ? decoded.object["items"]?.array ?? [] : decoded.array
        } else { values = [] }
        for value in values where value.object["type"]?.string == "file_change" {
            let status = value.object["status"]?.string
            guard status == nil || status == "completed" else { continue }
            for file in files(value.object["changes"]?.array) {
                if let index = indices[file.path] {
                    if result[index].diff.isEmpty { result[index].diff = file.diff }
                    if result[index].added == nil { result[index].added = file.added }
                    if result[index].removed == nil { result[index].removed = file.removed }
                    if result[index].kind.isEmpty { result[index].kind = file.kind }
                    if result[index].beforeSha256 == nil { result[index].beforeSha256 = file.beforeSha256 }
                } else {
                    indices[file.path] = result.count
                    result.append(file)
                }
            }
        }
        return result.filter { !isImageOutput($0, in: message) }
    }
    private static func isImageOutput(_ file: File, in message: AgentMessage) -> Bool {
        let kind = file.kind.lowercased()
        guard ["", "add", "create"].contains(kind), file.beforeSha256 == nil,
              !kind.isEmpty || file.diff.isEmpty else { return false }
        let name = file.path.replacingOccurrences(of: "\\", with: "/").components(separatedBy: "/").last ?? ""
        let ext = (name as NSString).pathExtension.lowercased()
        guard ["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff", "heic", "heif", "avif", "svg"].contains(ext) else { return false }
        return message.assets.contains { asset in
            guard asset.isImage else { return false }
            let output = asset.filename.replacingOccurrences(of: "\\", with: "/").components(separatedBy: "/").last ?? ""
            if output == name { return true }
            // The cloud may deliver a JPEG display copy of the generated original.
            return ["png", "jpg", "jpeg", "webp", "bmp"].contains(ext)
                && ["jpg", "jpeg"].contains((output as NSString).pathExtension.lowercased())
                && (name as NSString).deletingPathExtension == (output as NSString).deletingPathExtension
        }
    }
    static func usage(_ value: [String: AgentSyncValue]?) -> [(label: String, count: Int)] {
        [("input_tokens", "输入"), ("cached_input_tokens", "缓存"), ("output_tokens", "输出")].compactMap { key, label in
            guard let count = integer(value?[key]), count >= 0 else { return nil }
            return (label, count)
        }
    }
    static func hasRaw(_ raw: String?) -> Bool {
        guard let raw else { return false }
        return raw != "[]" && raw.contains { !$0.isWhitespace }
    }
    private static func clipped(_ value: AgentSyncValue?, _ count: Int) -> String {
        guard let string = value?.string else { return "" }
        return string.count > count ? String(string.prefix(count)) + "\n…" : string
    }
    private static func integer(_ value: AgentSyncValue?) -> Int? {
        guard case .number(let number) = value, number.isFinite,
              number >= Double(Int.min), number < Double(Int.max) else { return nil }
        return Int(number)
    }
}
