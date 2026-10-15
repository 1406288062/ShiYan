import SwiftUI

struct SettingsView: View {
    let topInset: CGFloat
    let bottomInset: CGFloat
    let hasUnread: Bool
    let onSidebar: () -> Void
    let onClose: () -> Void
    @State private var showingMemory = false

    private var background: Color { Color(uiColor: .systemGroupedBackground) }

    var body: some View {
        Group {
            if showingMemory {
                MemoryView(topInset: topInset, bottomInset: bottomInset, hasUnread: hasUnread,
                           onSidebar: onSidebar, onBack: { showingMemory = false })
            } else {
                ZStack(alignment: .top) {
                    background.ignoresSafeArea()
                    ScrollView {
                        VStack(alignment: .leading, spacing: 12) {
                            Text("个性化").font(.subheadline.weight(.medium)).foregroundStyle(.secondary)
                                .padding(.horizontal, 20)
                            Button { showingMemory = true } label: {
                                HStack(spacing: 16) {
                                    Image(systemName: "book.closed")
                                        .font(.system(size: 24, weight: .regular))
                                        .frame(width: 30)
                                    Text("记忆").font(.system(size: 20))
                                    Spacer(minLength: 8)
                                    Image(systemName: "chevron.right")
                                        .font(.system(size: 14, weight: .semibold)).foregroundStyle(.secondary)
                                }
                                .padding(20)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(Color(uiColor: .secondarySystemGroupedBackground),
                                            in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                                .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("settings-memory")
                            Text("自动记住重要信息，让回复更贴合你。")
                                .font(.subheadline).foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                                .padding(.horizontal, 20)
                        }
                        .padding(.horizontal, 20)
                        .padding(.top, topInset + 98)
                        .padding(.bottom, bottomInset + 28)
                    }
                    .scrollIndicators(.hidden)
                    ShiyanFeatureHeader(page: .settings, topInset: topInset,
                                        hasUnread: hasUnread, onSidebar: onSidebar) {
                        ShiyanCloseButton(action: onClose, diameter: ShiyanPreviewLayout.controlDiameter)
                            .accessibilityLabel("关闭设置")
                            .accessibilityIdentifier("settings-close")
                    }
                    .overlay(alignment: .top) {
                        Text("设置").font(.system(size: 18, weight: .semibold))
                            .frame(height: ShiyanPreviewLayout.controlDiameter)
                            .padding(.top, topInset + 3)
                            .allowsHitTesting(false)
                    }
                    .background(background)
                }
                .foregroundStyle(.primary)
                .accessibilityIdentifier("settings-page")
            }
        }
    }
}
