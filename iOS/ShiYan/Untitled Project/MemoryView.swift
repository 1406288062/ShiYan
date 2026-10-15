import SwiftUI
import Combine

nonisolated struct ShiyanMemorySettings: Decodable, Sendable {
    let ok: Bool
    let enabled: Bool
    let revision: Int
}

@MainActor
private final class ShiyanMemoryStore: ObservableObject {
    @Published private(set) var enabled = true
    @Published private(set) var isLoaded = false
    @Published private(set) var isLoading = false
    @Published private(set) var isSaving = false
    @Published private(set) var error: String?

    func refresh() async {
        guard !isLoading, !isSaving else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let settings = try await CodexClient.shared.memorySettings()
            guard !Task.isCancelled else { return }
            enabled = settings.enabled
            isLoaded = true
            error = nil
        } catch {
            guard !Task.isCancelled else { return }
            self.error = error.localizedDescription
        }
    }

    func setEnabled(_ value: Bool) async {
        guard isLoaded, !isLoading, !isSaving, value != enabled else { return }
        let previous = enabled
        enabled = value
        isSaving = true
        error = nil
        defer { isSaving = false }
        do {
            let settings = try await CodexClient.shared.setMemoryEnabled(value)
            enabled = settings.enabled
        } catch {
            enabled = previous
            self.error = error.localizedDescription
        }
    }
}

struct MemoryView: View {
    let topInset: CGFloat
    let bottomInset: CGFloat
    let hasUnread: Bool
    let onSidebar: () -> Void
    let onBack: () -> Void
    @StateObject private var store = ShiyanMemoryStore()
    @Environment(\.scenePhase) private var scenePhase

    private var background: Color { Color(uiColor: .systemGroupedBackground) }
    private var cardBackground: Color { Color(uiColor: .secondarySystemGroupedBackground) }
    private var busy: Bool { store.isLoading || store.isSaving }

    var body: some View {
        ZStack(alignment: .top) {
            background.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    VStack(alignment: .leading, spacing: 10) {
                        Toggle("使用记忆", isOn: Binding(
                            get: { store.enabled },
                            set: { value in Task { await store.setEnabled(value) } }
                        ))
                        .font(.body.weight(.medium))
                        .disabled(busy || !store.isLoaded)
                        .accessibilityIdentifier("memory-enabled")
                        Text(store.enabled ? "自动记住重要信息，让回复更贴合你。" : "已暂停自动记录和使用记忆，已保存的信息会保留。")
                            .font(.footnote).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                        if busy {
                            HStack(spacing: 8) {
                                ProgressView().controlSize(.small)
                                Text(store.isSaving ? "正在保存设置" : "正在加载设置")
                                    .font(.footnote).foregroundStyle(.secondary)
                            }
                            .accessibilityElement(children: .combine)
                        }
                    }
                    .padding(20)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(cardBackground, in: RoundedRectangle(cornerRadius: 16, style: .continuous))

                    if let error = store.error {
                        VStack(alignment: .leading, spacing: 12) {
                            Text(error).font(.subheadline).foregroundStyle(.secondary)
                            Button("重新加载") { Task { await store.refresh() } }.disabled(busy)
                        }
                        .padding(20)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(cardBackground, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                        .accessibilityIdentifier("memory-error")
                    }
                }
                .padding(.horizontal, 20)
                .padding(.top, topInset + 98)
                .padding(.bottom, bottomInset + 28)
            }
            .scrollIndicators(.hidden)

            ShiyanFeatureHeader(page: .settings, topInset: topInset, hasUnread: hasUnread,
                                onSidebar: onSidebar, onBack: onBack, backLabel: "返回设置") {
                Color.clear.frame(width: ShiyanPreviewLayout.controlDiameter, height: ShiyanPreviewLayout.controlDiameter)
                    .allowsHitTesting(false).accessibilityHidden(true)
            }
            .overlay(alignment: .top) {
                Text("记忆").font(.system(size: 18, weight: .semibold))
                    .frame(height: ShiyanPreviewLayout.controlDiameter)
                    .padding(.top, topInset + 3)
                    .allowsHitTesting(false)
            }
            .background(background)
        }
        .foregroundStyle(.primary)
        .accessibilityIdentifier("memory-page")
        .task { await store.refresh() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await store.refresh() } }
        }
    }
}
