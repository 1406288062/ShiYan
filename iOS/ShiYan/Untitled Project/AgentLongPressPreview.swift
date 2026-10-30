import SwiftUI

/// 长按消息：短消息保持原样（气泡本身浮起）；长消息的预览只显示开头，底部边缘渐隐模糊，并提示“显示更多”。
struct AgentLongPressMenu<MenuContent: View, PreviewContent: View>: ViewModifier {
    let isLong: Bool
    @ViewBuilder let menu: () -> MenuContent
    @ViewBuilder let preview: () -> PreviewContent
    func body(content: Content) -> some View {
        if isLong {
            content.contextMenu { menu() } preview: { AgentCollapsedPreview(content: preview) }
        } else {
            content.contextMenu { menu() }
        }
    }
}

extension View {
    func agentLongPressMenu<M: View, P: View>(isLong: Bool, @ViewBuilder menu: @escaping () -> M, @ViewBuilder preview: @escaping () -> P) -> some View {
        modifier(AgentLongPressMenu(isLong: isLong, menu: menu, preview: preview))
    }
}

enum AgentLongMessage {
    /// 超过这个长度或行数，长按预览就折叠。
    static func isLong(_ text: String) -> Bool {
        text.count > 260 || text.split(separator: "\n", omittingEmptySubsequences: false).count > 9
    }
}

struct AgentCollapsedPreview<Content: View>: View {
    let content: () -> Content
    private var width: CGFloat { min(UIScreen.main.bounds.width - 48, 360) }
    var body: some View {
        ZStack(alignment: .bottom) {
            content()
                .frame(width: width, alignment: .topLeading)
                .frame(height: 300, alignment: .top)
                .clipped()
                .mask(LinearGradient(stops: [.init(color: .black, location: 0), .init(color: .black, location: 0.62), .init(color: .black.opacity(0), location: 1)],
                                     startPoint: .top, endPoint: .bottom))
            Label("显示更多", systemImage: "chevron.down")
                .font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
                .labelStyle(.titleAndIcon)
                .padding(.horizontal, 12).padding(.vertical, 6)
                .background(.ultraThinMaterial, in: Capsule())
                .padding(.bottom, 12)
        }
        .frame(width: width, height: 300)
        .background(Color(uiColor: .systemBackground))
    }
}
