import SwiftUI
import UIKit

// Mirrors Vue-agent/src/assets/index.css; only dimensions adapt to iPhone.
enum KnowledgeTheme {
    static let background = adaptive(light: 0xf7f8fa, dark: 0x101218)
    static let panel = adaptive(light: 0xffffff, dark: 0x191c25)
    static let sidebarPanel = adaptive(light: 0xffffff, dark: 0x151820)
    static let text = adaptive(light: 0x181b23, dark: 0xf2f3f5)
    static let muted = adaptive(light: 0x69707d, dark: 0x8e95a3)
    static let border = adaptive(light: 0xe1e4e9, dark: 0x282d38)
    static let hover = adaptive(light: 0xeceef2, dark: 0x1b1f28)
    static let accent = adaptive(light: 0x6257e7, dark: 0x8178f2)
    static let cyan = adaptive(light: 0x1e9e96, dark: 0x48b9b1)
    static let warm = adaptive(light: 0xb8862f, dark: 0xd6a85f)
    static let danger = adaptive(light: 0xd95f6d, dark: 0xe37b87)
    // AiChatModal.vue's final send-button override uses this gradient in both themes.
    static let sendGradient = LinearGradient(colors: [color(0x8178f2), color(0x5c52df)], startPoint: .topLeading, endPoint: .bottomTrailing)

    private static func adaptive(light: Int, dark: Int) -> Color {
        Color(uiColor: UIColor { traits in
            let value = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: CGFloat((value >> 16) & 255) / 255,
                           green: CGFloat((value >> 8) & 255) / 255,
                           blue: CGFloat(value & 255) / 255, alpha: 1)
        })
    }
    private static func color(_ value: Int) -> Color {
        Color(red: Double((value >> 16) & 255) / 255,
              green: Double((value >> 8) & 255) / 255,
              blue: Double(value & 255) / 255)
    }
}

struct KnowledgePrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(.white).padding(.horizontal, 17).frame(minHeight: 44)
            .background(KnowledgeTheme.accent, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .opacity(enabled ? (configuration.isPressed ? 0.85 : 1) : 0.45)
    }
}

struct KnowledgeChatSurface: ViewModifier {
    let user: Bool
    @Environment(\.colorScheme) private var scheme
    func body(content: Content) -> some View {
        content
            .background {
                UnevenRoundedRectangle(topLeadingRadius: user ? 16 : 6, bottomLeadingRadius: 16,
                                       bottomTrailingRadius: 16, topTrailingRadius: user ? 6 : 16)
                    .fill(KnowledgeTheme.panel)
                    .overlay {
                        UnevenRoundedRectangle(topLeadingRadius: user ? 16 : 6, bottomLeadingRadius: 16,
                                               bottomTrailingRadius: 16, topTrailingRadius: user ? 6 : 16)
                            .fill(LinearGradient(colors: [KnowledgeTheme.accent.opacity(user ? (scheme == .dark ? 0.20 : 0.13) : 0.07),
                                                          KnowledgeTheme.cyan.opacity(user ? 0.06 : 0.035)],
                                                 startPoint: .topLeading, endPoint: .bottomTrailing))
                    }
            }
            .overlay {
                UnevenRoundedRectangle(topLeadingRadius: user ? 16 : 6, bottomLeadingRadius: 16,
                                       bottomTrailingRadius: 16, topTrailingRadius: user ? 6 : 16)
                    .stroke(KnowledgeTheme.accent.opacity(user ? 0.25 : 0.18), lineWidth: 1)
            }
            .overlay(alignment: .leading) {
                if !user { RoundedRectangle(cornerRadius: 1).fill(KnowledgeTheme.warm).frame(width: 2).padding(.vertical, 6) }
            }
    }
}

struct KnowledgeModalBackground: View {
    var body: some View {
        ZStack {
            KnowledgeTheme.background
            RadialGradient(colors: [KnowledgeTheme.accent.opacity(0.14), .clear], center: .topTrailing, startRadius: 0, endRadius: 400)
            RadialGradient(colors: [KnowledgeTheme.cyan.opacity(0.08), .clear], center: .bottomLeading, startRadius: 0, endRadius: 400)
        }.ignoresSafeArea()
    }
}

extension View {
    func knowledgeCard(radius: CGFloat = 16, tint: Color = .clear, border: Color = KnowledgeTheme.border) -> some View {
        background {
            RoundedRectangle(cornerRadius: radius, style: .continuous).fill(KnowledgeTheme.panel)
                .overlay { RoundedRectangle(cornerRadius: radius, style: .continuous).fill(tint) }
        }
        .overlay { RoundedRectangle(cornerRadius: radius, style: .continuous).stroke(border, lineWidth: 1) }
    }
}
