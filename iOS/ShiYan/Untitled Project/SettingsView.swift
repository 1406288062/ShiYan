import SwiftUI
import PhotosUI
import ImageIO
import UniformTypeIdentifiers

struct SettingsView: View {
    let topInset: CGFloat
    let bottomInset: CGFloat
    let hasUnread: Bool
    let onSidebar: () -> Void
    let onClose: () -> Void
    @ObservedObject private var account = ShiyanAccount.shared
    @State private var showingUsers = false
    @State private var showingMemory = false
    @State private var showingCodexQuota = false
    @State private var showingScanner = false
    @State private var selectedAvatar: PhotosPickerItem?
    @State private var avatarImage: UIImage?
    @State private var loadingAvatar = false
    @State private var avatarError: String?
    @ScaledMetric(relativeTo: .body) private var rowHeight: CGFloat = 56

    private var background: Color { Color(uiColor: .systemGroupedBackground) }
    private var groupBackground: Color { Color(uiColor: .secondarySystemGroupedBackground) }

    var body: some View {
        Group {
            if showingUsers && account.user?.isAdmin == true {
                ShiyanUserManagementView(topInset: topInset, bottomInset: bottomInset, hasUnread: hasUnread,
                    onSidebar: onSidebar, onBack: { showingUsers = false })
            } else if showingCodexQuota && account.canAccessServer {
                CodexQuotaView(topInset: topInset, bottomInset: bottomInset, hasUnread: hasUnread,
                               onSidebar: onSidebar, onBack: { showingCodexQuota = false }, onClose: onClose)
            } else if showingMemory {
                MemoryView(topInset: topInset, bottomInset: bottomInset, hasUnread: hasUnread,
                           onSidebar: onSidebar, onBack: { showingMemory = false })
            } else {
                GeometryReader { geometry in
                    ZStack(alignment: .top) {
                        background.ignoresSafeArea()
                        ScrollView {
                            VStack(alignment: .leading, spacing: 0) {
                                profileHeader
                                    .padding(.bottom, 30)
                                sectionLabel("个性化")
                                VStack(spacing: 0) {
                                    settingsRow("记忆", detail: "自动记住重要信息，让回复更贴合你。", symbol: "book.closed") {
                                        showingMemory = true
                                    }
                                    .accessibilityIdentifier("settings-memory")
                                    rowDivider
                                    settingsRow("扫一扫", detail: "扫描二维码登录拾燕桌面端。", symbol: "qrcode.viewfinder") {
                                        showingScanner = true
                                    }
                                    .accessibilityIdentifier("settings-qr-scanner")
                                }
                                .background(groupBackground, in: RoundedRectangle(cornerRadius: 24))

                                sectionLabel("账户").padding(.top, 28)
                                VStack(spacing: 0) {
                                    accountRow("邮箱", value: account.user?.email ?? "未设置", symbol: "envelope")
                                    rowDivider
                                    accountRow("角色", value: account.user?.isAdmin == true ? "管理员" : "普通用户", symbol: "person")
                                    if account.canAccessServer {
                                        rowDivider
                                        settingsRow("额度与重置卡", detail: "查看额度剩余、重置时间与可用重置卡。", symbol: "gauge.with.dots.needle.50percent") {
                                            showingCodexQuota = true
                                        }
                                        .accessibilityIdentifier("settings-codex-quota")
                                    }
                                    if account.user?.isAdmin == true {
                                        rowDivider
                                        settingsRow("用户权限管理", detail: "管理账户、角色和服务器访问权限。", symbol: "person.2") {
                                            showingUsers = true
                                        }
                                        .accessibilityIdentifier("settings-users")
                                    }
                                }
                                .background(groupBackground, in: RoundedRectangle(cornerRadius: 24))

                                Spacer(minLength: 36)
                                logoutButton
                            }
                            .frame(maxWidth: 640, minHeight: max(0, geometry.size.height - topInset - 82 - bottomInset - 24), alignment: .topLeading)
                            .padding(.horizontal, 18)
                            .padding(.top, topInset + 82)
                            .padding(.bottom, bottomInset + 24)
                            .frame(maxWidth: .infinity)
                        }
                        .scrollIndicators(.hidden)
                        ShiyanFeatureHeader(page: .settings, topInset: topInset,
                                            hasUnread: hasUnread, onSidebar: onSidebar) {
                            ShiyanCloseButton(action: onClose, diameter: ShiyanPreviewLayout.controlDiameter)
                        }
                        .overlay(alignment: .top) {
                            Text("设置").font(.system(size: 17, weight: .semibold))
                                .frame(height: ShiyanPreviewLayout.controlDiameter)
                                .padding(.top, topInset + 3)
                                .allowsHitTesting(false)
                        }
                        .background(background)
                    }
                }
                .foregroundStyle(.primary)
                .accessibilityIdentifier("settings-page")
                .fullScreenCover(isPresented: $showingScanner) { ShiyanQRScanner() }
                .task(id: account.user?.id) { loadSavedAvatar() }
                .task(id: selectedAvatar) { await updateAvatar() }
                .alert("无法更新头像", isPresented: Binding(
                    get: { avatarError != nil }, set: { if !$0 { avatarError = nil } })) {
                    Button("好", role: .cancel) { avatarError = nil }
                } message: { Text(avatarError ?? "请重新选择照片。") }
            }
        }
    }

    private var profileHeader: some View {
        VStack(spacing: 12) {
            PhotosPicker(selection: $selectedAvatar, matching: .images, photoLibrary: .shared()) {
                ZStack {
                    if let avatarImage {
                        Image(uiImage: avatarImage).resizable().scaledToFill()
                    } else {
                        Image(systemName: "person.crop.circle.fill")
                            .resizable().scaledToFit().foregroundStyle(.secondary)
                    }
                    if loadingAvatar {
                        Color.black.opacity(0.2)
                        ProgressView().tint(.white)
                    }
                }
                .frame(width: 80, height: 80).clipShape(Circle())
                .overlay(alignment: .bottomTrailing) {
                    Image(systemName: "pencil")
                        .font(.system(size: 13, weight: .medium))
                        .frame(width: 28, height: 28)
                        .background(groupBackground, in: Circle())
                        .overlay(Circle().stroke(background, lineWidth: 2))
                }
                .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .disabled(loadingAvatar || account.user == nil)
            .accessibilityLabel(avatarImage == nil ? "上传头像" : "更换头像")
            .accessibilityIdentifier("settings-avatar-picker")
            Text(account.user?.name ?? "账户")
                .font(.system(size: 23, weight: .semibold))
                .multilineTextAlignment(.center)
                .textSelection(.enabled)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 8)
    }

    private func loadSavedAvatar() {
        avatarImage = nil
        guard account.user != nil else { return }
        let file = ShiyanAccountStorage.directory("Profile").appendingPathComponent("avatar.jpg")
        if let data = try? Data(contentsOf: file), data.count <= 2 * 1024 * 1024 {
            avatarImage = UIImage(data: data)
        }
    }

    private func updateAvatar() async {
        guard let selection = selectedAvatar, let userID = account.user?.id else { return }
        let generation = ShiyanAccountStorage.generation
        let owner = ShiyanAccountStorage.owner
        loadingAvatar = true
        defer { loadingAvatar = false; selectedAvatar = nil }
        do {
            guard let data = try await selection.loadTransferable(type: Data.self) else {
                throw AvatarFailure.invalidImage
            }
            guard !Task.isCancelled else { return }
            let jpeg = try await Task.detached(priority: .userInitiated) {
                try Self.avatarJPEG(data)
            }.value
            guard !Task.isCancelled, account.user?.id == userID,
                  ShiyanAccountStorage.generation == generation else { return }
            let file = ShiyanAccountStorage.directory("Profile", owner: owner).appendingPathComponent("avatar.jpg")
            try jpeg.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            avatarImage = UIImage(data: jpeg)
        } catch {
            guard !Task.isCancelled, account.user?.id == userID,
                  ShiyanAccountStorage.generation == generation else { return }
            avatarError = error.localizedDescription
        }
    }

    nonisolated private enum AvatarFailure: LocalizedError {
        case invalidImage
        var errorDescription: String? { "无法读取这张照片，请选择其他图片（不超过 20 MB）。" }
    }

    nonisolated private static func avatarJPEG(_ data: Data) throws -> Data {
        guard data.count <= 20 * 1024 * 1024,
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 512
              ] as CFDictionary) else { throw AvatarFailure.invalidImage }
        let side = min(image.width, image.height)
        let rect = CGRect(x: (image.width - side) / 2, y: (image.height - side) / 2, width: side, height: side)
        guard let cropped = image.cropping(to: rect) else { throw AvatarFailure.invalidImage }
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output, UTType.jpeg.identifier as CFString, 1, nil) else {
            throw AvatarFailure.invalidImage
        }
        CGImageDestinationAddImage(destination, cropped, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { throw AvatarFailure.invalidImage }
        return output as Data
    }

    private var logoutButton: some View {
        Button(role: .destructive) { Task { await account.logout() } } label: {
            HStack(spacing: 14) {
                Image(systemName: "rectangle.portrait.and.arrow.right")
                    .font(.system(size: 21)).frame(width: 26)
                Text("退出登录").font(.system(size: 17))
                Spacer(minLength: 0)
                if account.busy { ProgressView().tint(.red) }
            }
            .foregroundStyle(.red)
            .padding(.horizontal, 20)
            .frame(minHeight: rowHeight + 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(groupBackground, in: RoundedRectangle(cornerRadius: 24))
        .disabled(account.busy)
        .accessibilityIdentifier("settings-logout")
    }

    private var rowDivider: some View {
        Divider().padding(.leading, 60).padding(.trailing, 20)
    }

    private func sectionLabel(_ title: String) -> some View {
        Text(title).font(.system(size: 14, weight: .medium)).foregroundStyle(.secondary)
            .padding(.leading, 20).padding(.bottom, 10)
    }

    private func accountRow(_ title: String, value: String, symbol: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 14) {
            Image(systemName: symbol).font(.system(size: 21)).frame(width: 26)
                .accessibilityHidden(true)
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .firstTextBaseline, spacing: 16) {
                    Text(title)
                    Spacer(minLength: 8)
                    Text(value).foregroundStyle(.secondary)
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text(title)
                    Text(value).foregroundStyle(.secondary).textSelection(.enabled)
                }
            }
            .font(.system(size: 17))
        }
        .padding(.horizontal, 20).padding(.vertical, 14)
        .frame(maxWidth: .infinity, minHeight: rowHeight, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    private func settingsRow(_ title: String, detail: String, symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 14) {
                Image(systemName: symbol).font(.system(size: 21)).frame(width: 26)
                    .accessibilityHidden(true)
                Text(title).font(.system(size: 17))
                Spacer(minLength: 8)
                Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(.tertiary)
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, 20).padding(.vertical, 14)
            .frame(maxWidth: .infinity, minHeight: rowHeight, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint(detail)
    }
}
