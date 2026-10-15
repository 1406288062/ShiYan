import Foundation

 
 
 
enum AgentResultPresentation {
    static func text(_ raw: String, hasVerifiedOutputImage: Bool) -> String {
        guard hasVerifiedOutputImage else { return raw }
        return raw.components(separatedBy: "\n\n").map { paragraph in
            let value = paragraph.trimmingCharacters(in: .whitespacesAndNewlines)
            if isMissingImageStatus(value) { return "图片已生成。" }
            return paragraph
        }.joined(separator: "\n\n")
    }
    static func error(_ raw: String?, hasVerifiedOutputImage: Bool) -> String? {
        guard let raw else { return nil }
        guard hasVerifiedOutputImage else { return raw }
        if isMissingImageStatus(raw) { return nil }
         
        return "图片已收到，但后续处理未完成：" + raw
    }
    private static func isMissingImageStatus(_ value: String) -> Bool {
        let prefixes = ["图片生成没有返回可展示的结果", "图片生成未返回可展示的结果", "本轮已结束，未返回可展示内容"]
        return prefixes.contains { value.hasPrefix($0) }
    }
}
