import Foundation
import SwiftUI
import Combine
import UIKit

@MainActor
final class CodexQuotaStore: ObservableObject {
    typealias Loader = @MainActor () async throws -> CodexQuota
    @Published private(set) var snapshot: CodexQuota?
    @Published private(set) var lastAvailableQuota: CodexQuota?
    @Published private(set) var isLoading = false
    @Published private(set) var requestError: String?
    private let loader: Loader
    private var refreshID: UUID?

    init(loader: @escaping Loader = { try await CodexClient.shared.accountQuota() }) {
        self.loader = loader
    }

    var windowSnapshot: CodexQuota? {
        snapshot?.available == true ? snapshot : lastAvailableQuota
    }
    var windowsAreStale: Bool {
        windowSnapshot != nil && (requestError != nil || snapshot?.available != true)
    }

    func refresh() async {
        guard !Task.isCancelled else { return }
        let id = UUID()
        refreshID = id
        isLoading = true
        defer {
            if refreshID == id { isLoading = false; refreshID = nil }
        }
        do {
            let result = try await loader()
            try Task.checkCancellation()
            guard refreshID == id else { return }
            snapshot = result
            if result.available { lastAvailableQuota = result }
            requestError = nil
        } catch is CancellationError {
            // Leaving this page must not turn cancellation into a network error.
        } catch {
            guard refreshID == id, !Task.isCancelled else { return }
            requestError = error.localizedDescription
        }
    }
}

struct CodexQuotaView: View {
    let topInset: CGFloat
    let bottomInset: CGFloat
    let hasUnread: Bool
    let onSidebar: () -> Void
    let onBack: () -> Void
    let onClose: () -> Void
    @StateObject private var store = CodexQuotaStore()

    private var background: Color { Color(uiColor: .systemGroupedBackground) }

    var body: some View {
        ZStack(alignment: .top) {
            background.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text("额度与重置卡").font(.title2.weight(.semibold))
                    if store.isLoading {
                        HStack(spacing: 10) {
                            ProgressView()
                            Text(store.snapshot == nil ? "正在获取账户信息…" : "正在刷新，当前显示上次查询结果…")
                                .font(.subheadline).foregroundStyle(.secondary)
                        }
                        .accessibilityIdentifier("codex-quota-loading")
                    }
                    if let error = store.requestError, !store.isLoading {
                        statusMessage(store.snapshot == nil ? "暂时无法获取账户信息" : "刷新失败，以下为上次查询结果",
                                      detail: error, symbol: "exclamationmark.circle")
                            .accessibilityIdentifier("codex-quota-error")
                    }
                    quotaSection
                    resetCreditsSection
                    if let date = store.snapshot?.fetchedDate {
                        Text("查询时间：" + CodexQuotaFormat.dateText(date))
                            .font(.footnote).foregroundStyle(.secondary)
                            .accessibilityIdentifier("codex-quota-fetched-at")
                    }
                }
                .padding(.horizontal, 20)
                .padding(.top, topInset + 98)
                .padding(.bottom, bottomInset + 28)
            }
            .scrollIndicators(.hidden)
            ShiyanFeatureHeader(page: .settings, topInset: topInset, hasUnread: hasUnread,
                                onSidebar: onSidebar, onBack: onBack, backLabel: "返回设置") {
                ShiyanCloseButton(action: onClose, diameter: ShiyanPreviewLayout.controlDiameter)
                    .accessibilityLabel("关闭设置")
                    .accessibilityIdentifier("codex-quota-close")
            }
            .overlay(alignment: .top) {
                Text("Codex").font(.system(size: 18, weight: .semibold))
                    .frame(height: ShiyanPreviewLayout.controlDiameter)
                    .padding(.top, topInset + 3)
                    .allowsHitTesting(false)
            }
            .background(background)
        }
        .foregroundStyle(.primary)
        .accessibilityIdentifier("codex-quota-page")
        .task { await store.refresh() }
    }

    private var quotaSection: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("额度剩余").font(.headline)
            if store.snapshot?.available == false {
                Text(CodexQuotaFormat.nonempty(store.snapshot?.error) ?? "当前服务暂未提供额度信息。")
                    .font(.subheadline).foregroundStyle(.secondary)
            }
            if store.windowsAreStale {
                Text("以下额度为上次查询结果。")
                    .font(.footnote).foregroundStyle(.secondary)
                    .accessibilityIdentifier("codex-quota-stale-windows")
            }
            let windows = store.windowSnapshot?.windows ?? []
            if !windows.contains(where: \.isWeekly) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("周额度").font(.subheadline.weight(.semibold))
                    Text(store.isLoading && store.snapshot == nil ? "正在查询…" : "暂未提供周额度剩余情况")
                        .font(.subheadline).foregroundStyle(.secondary)
                }
                .accessibilityIdentifier("codex-quota-weekly-unavailable")
            }
            let ordered = windows.enumerated().sorted {
                if $0.element.isWeekly != $1.element.isWeekly { return $0.element.isWeekly }
                return $0.offset < $1.offset
            }
            ForEach(ordered, id: \.offset) { item in
                windowRow(item.element)
                    .accessibilityIdentifier("codex-quota-window-\(item.offset)")
            }
            if windows.isEmpty && store.snapshot?.available == true {
                Text("当前账户暂未提供其他周期额度。")
                    .font(.subheadline).foregroundStyle(.secondary)
            }
            if store.windowsAreStale, let date = store.windowSnapshot?.fetchedDate {
                Text("额度查询时间：" + CodexQuotaFormat.dateText(date))
                    .font(.footnote).foregroundStyle(.secondary)
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(uiColor: .secondarySystemGroupedBackground),
                    in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private func windowRow(_ window: CodexQuotaWindow) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text(window.title).font(.subheadline.weight(.semibold))
                Spacer(minLength: 0)
                Text(window.remainingText).font(.subheadline.monospacedDigit())
                    .accessibilityIdentifier(window.isWeekly ? "codex-quota-weekly-remaining" : "codex-quota-period-remaining")
            }
            if let remaining = window.remainingValue {
                ProgressView(value: remaining, total: 100)
                    .tint(.accentColor)
                    .accessibilityLabel(window.title + "剩余")
                    .accessibilityValue(window.remainingText)
            }
            if let bucket = CodexQuotaFormat.nonempty(window.bucket) {
                Text(bucket).font(.caption).foregroundStyle(.secondary)
            }
            Text(window.resetDate.map { "重置时间：" + CodexQuotaFormat.dateText($0) } ?? "未提供重置时间")
                .font(.footnote).foregroundStyle(.secondary)
                .accessibilityIdentifier(window.isWeekly ? "codex-quota-weekly-resets-at" : "codex-quota-period-resets-at")
        }
        .padding(.vertical, 4)
    }

    private var resetCreditsSection: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("重置卡").font(.headline)
            if let reset = store.snapshot?.resetCredits {
                Text(reset.countText).font(.title3.weight(.semibold)).monospacedDigit()
                    .accessibilityIdentifier("codex-reset-credits-count")
                if let credits = reset.credits {
                    if credits.isEmpty {
                        Text("当前未返回重置卡明细。")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                    ForEach(Array(credits.enumerated()), id: \.offset) { item in
                        if item.offset > 0 { Divider() }
                        creditRow(item.element)
                            .accessibilityIdentifier("codex-reset-credit-\(item.offset)")
                    }
                } else {
                    Text("当前服务暂未提供重置卡明细。")
                        .font(.subheadline).foregroundStyle(.secondary)
                }
            } else {
                Text(store.isLoading && store.snapshot == nil ? "正在查询…" : "当前服务暂未提供重置卡信息。")
                    .font(.subheadline).foregroundStyle(.secondary)
                    .accessibilityIdentifier("codex-reset-credits-unavailable")
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(uiColor: .secondarySystemGroupedBackground),
                    in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private func creditRow(_ credit: CodexResetCredit) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text(credit.displayTitle).font(.subheadline.weight(.semibold))
                    Spacer(minLength: 0)
                    Text(credit.statusText).font(.subheadline).foregroundStyle(.secondary)
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text(credit.displayTitle).font(.subheadline.weight(.semibold))
                    Text(credit.statusText).font(.subheadline).foregroundStyle(.secondary)
                }
            }
            if let description = CodexQuotaFormat.nonempty(credit.description) {
                Text(description).font(.subheadline).foregroundStyle(.secondary)
            }
            detailRow("重置范围", value: credit.resetTypeText)
            detailRow("发放时间", value: credit.grantedDate.map(CodexQuotaFormat.dateText) ?? "未提供")
            detailRow("到期时间", value: credit.expiryText)
            if let id = CodexQuotaFormat.nonempty(credit.id) {
                detailRow("卡片编号", value: id)
            }
        }
        .padding(.vertical, 4)
    }

    private func detailRow(_ label: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.subheadline).textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func statusMessage(_ title: String, detail: String, symbol: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(title, systemImage: symbol).font(.subheadline.weight(.medium))
            Text(detail).font(.footnote).foregroundStyle(.secondary)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.accentColor.opacity(0.08), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}
