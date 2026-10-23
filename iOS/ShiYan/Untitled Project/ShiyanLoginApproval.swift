import SwiftUI
import UIKit

struct ShiyanDesktopLoginRequest: Decodable, Identifiable {
    let id: String
    let code: String
    let expiresAt: Double
    let device: String
}
struct ShiyanDesktopLoginInbox: Decodable { let requests: [ShiyanDesktopLoginRequest] }

struct ShiyanLoginApproval: View {
    let request: ShiyanDesktopLoginRequest
    let onDone: () -> Void
    @ObservedObject private var account = ShiyanAccount.shared
    @State private var busy = false
    @State private var message: String?
    @State private var generation = ShiyanAccountStorage.generation
    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "desktopcomputer").font(.system(size: 38)).foregroundStyle(.secondary)
            Text("确认电脑登录").font(.title2.bold())
            Text(request.device).foregroundStyle(.secondary)
            Text("确认后将以“\(account.user?.name ?? "")”登录。").multilineTextAlignment(.center).foregroundStyle(.secondary)
            if let message { Text(message).foregroundStyle(.red).multilineTextAlignment(.center) }
            Button { Task { await respond(true) } } label: {
                HStack { if busy { ProgressView() }; Text("确认登录") }.frame(maxWidth: .infinity, minHeight: 44)
            }.buttonStyle(.borderedProminent).disabled(busy)
            Button("拒绝登录", role: .destructive) { Task { await respond(false) } }.disabled(busy)
        }
        .padding(28)
        .presentationDetents([.medium, .large])
        .interactiveDismissDisabled()
    }
    private func respond(_ approve: Bool) async {
        guard !busy, generation == ShiyanAccountStorage.generation, account.user != nil else { onDone(); return }
        busy = true; message = nil
        defer { busy = false }
        do {
            guard request.expiresAt > Date().timeIntervalSince1970 * 1000 else {
                message = "请求已过期，请在电脑上重新发起。"
                if !approve { onDone() }; return
            }
            _ = try await CodexClient.shared.authRequest(route: "auth/device/approve", method: "POST", object: ["id":request.id,"approve":approve])
            guard generation == ShiyanAccountStorage.generation else { return }
            onDone()
        } catch {
            guard generation == ShiyanAccountStorage.generation else { return }
            message = error.localizedDescription
            if !approve { onDone() }
        }
    }
}

// Only a small account avatar is shared for the remembered desktop login entry.
@MainActor
func shiyanLoginAvatar() -> String? {
    guard ShiyanAccount.shared.user != nil,
          let image = ShiyanAvatarStore.shared.image else { return nil }
    let format = UIGraphicsImageRendererFormat(); format.scale = 1; format.opaque = true
    let resized = UIGraphicsImageRenderer(size: CGSize(width: 64, height: 64), format: format).image { _ in
        UIColor.white.setFill(); UIRectFill(CGRect(x: 0, y: 0, width: 64, height: 64))
        image.draw(in: CGRect(x: 0, y: 0, width: 64, height: 64))
    }
    guard let jpeg = resized.jpegData(compressionQuality: 0.55), jpeg.count <= 6144 else { return nil }
    return jpeg.base64EncodedString()
}
