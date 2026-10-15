import Foundation

 
enum AgentComposerLayout {
    static let gutter: CGFloat = 15
    static func bottomGap(windowBottom: CGFloat, windowSafeBottom: CGFloat, viewportBottom: CGFloat) -> CGFloat {
        let nativeOcclusion = max(0, windowBottom - viewportBottom)
        return max(gutter, windowSafeBottom - nativeOcclusion)
    }
    static func shortModelName(id: String, displayName: String) -> String {
        let value = id.hasPrefix("gpt-") ? String(id.dropFirst(4)) : id
        let parts = value.split(separator: "-")
        guard let number = parts.first, number.contains(where: { $0.isNumber }),
              number.allSatisfy({ $0.isNumber || $0 == "." }) else { return displayName }
        guard parts.count > 1 else { return String(number) }
        return String(number) + "-" + parts.dropFirst().map { $0.capitalized }.joined(separator: "-")
    }
}
