import SwiftUI
import Combine
import Security
import CryptoKit

struct ShiyanUser: Codable, Identifiable, Equatable {
    let id: String
    let username: String
    let email: String?
    let displayName: String?
    let role: String
    let status: String
    let serverAccess: Bool
    let owner: String
    let revision: Int?
    var name: String { displayName?.isEmpty == false ? displayName! : (email?.isEmpty == false ? email! : username) }
    var isAdmin: Bool { role == "admin" && status == "active" }
    var canAccessServer: Bool { isAdmin && serverAccess }
}

struct ShiyanAuthStatus: Decodable {
    let registrationEnabled: Bool
    let bootstrapRequired: Bool
    let canBootstrap: Bool
}

private struct ShiyanAuthResponse: Decodable {
    let token: String
    let user: ShiyanUser
}
private struct ShiyanUserResponse: Decodable { let user: ShiyanUser }

// Keep filesystem namespaces independent of actor context, including background image decoding.
nonisolated enum ShiyanAccountStorage {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var currentOwner = "signed-out"
    nonisolated(unsafe) private static var currentGeneration = UUID()
    static var owner: String { lock.withLock { currentOwner } }
    static var generation: UUID { lock.withLock { currentGeneration } }
    static func activate(_ owner: String) { lock.withLock { currentOwner = owner; currentGeneration = UUID() } }
    static func directory(_ name: String, domain: FileManager.SearchPathDirectory = .documentDirectory, owner: String? = nil) -> URL {
        let identity = owner ?? self.owner
        var root = FileManager.default.urls(for: domain, in: .userDomainMask)[0]
        if identity != "shiyan-private-owner" {
            let key = SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined()
            root = root.appendingPathComponent("ShiyanAccounts", isDirectory: true).appendingPathComponent(key, isDirectory: true)
        }
        let result = root.appendingPathComponent(name, isDirectory: true)
        try? FileManager.default.createDirectory(at: result, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700, .protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        return result
    }
    static func preference(_ key: String) -> String {
        owner == "shiyan-private-owner" ? key : key + "." + SHA256.hash(data: Data(owner.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

@MainActor
final class ShiyanAccount: ObservableObject {
    static let shared = ShiyanAccount()
    @Published private(set) var user: ShiyanUser?
    @Published private(set) var checking = true
    @Published private(set) var busy = false
    @Published private(set) var status: ShiyanAuthStatus?
    @Published var error: String?
    private(set) var token: String?
    private let service = "com.shiyan.account.session"
    private var started = false
    private var validating = false
    var canAccessServer: Bool { user?.canAccessServer == true }
    var canUseAI: Bool { user?.status == "active" && token != nil }

    private var keychainQuery: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
         kSecAttrAccount as String: "session-v1"]
    }
    private func saveToken(_ value: String?) throws {
        let query = keychainQuery
        guard let value else { SecItemDelete(query as CFDictionary); return }
        let update = [kSecValueData as String: Data(value.utf8)]
        var result = SecItemUpdate(query as CFDictionary, update as CFDictionary)
        if result == errSecItemNotFound {
            var add = query
            add[kSecValueData as String] = Data(value.utf8)
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            result = SecItemAdd(add as CFDictionary, nil)
        }
        guard result == errSecSuccess else { throw AgentClientError.message("无法安全保存登录状态，请解锁设备后重试") }
    }
    func start() async {
        guard !started else { return }
        started = true
        var query = keychainQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: CFTypeRef?
        if SecItemCopyMatching(query as CFDictionary, &value) == errSecSuccess, let data = value as? Data {
            token = String(data: data, encoding: .utf8)
        }
        if token != nil { await validate(retryTransientFailure: true) }
        checking = false
        // The login form does not wait for device/bootstrap status.
        if user == nil { Task { await refreshStatus() } }
    }
    func refreshStatus() async {
        let generation = ShiyanAccountStorage.generation
        do {
            let value = try JSONDecoder().decode(ShiyanAuthStatus.self,
                from: await CodexClient.shared.authRequest(route: "auth/status", method: "GET"))
            guard ShiyanAccountStorage.generation == generation else { return }
            status = value
        } catch {
            guard ShiyanAccountStorage.generation == generation, user == nil, !checking else { return }
            self.error = error.localizedDescription
        }
    }
    func validate(retryTransientFailure: Bool = false) async {
        guard token != nil, !validating else { return }
        validating = true
        let checkedToken = token
        defer { validating = false }
        let attempts = retryTransientFailure ? ShiyanAuthRecovery.maximumAttempts : 1
        for attempt in 0..<attempts {
            do {
                let value = try JSONDecoder().decode(ShiyanUserResponse.self,
                    from: await CodexClient.shared.authRequest(route: "auth/me", method: "GET")).user
                guard token == checkedToken else { return }
                guard value.status == "active" else { invalidate(); return }
                if user == nil { activate(value) }
                else if user?.role != value.role || user?.serverAccess != value.serverAccess || user?.owner != value.owner {
                    clearStores(); activate(value)
                } else if user != value { user = value }
                error = nil
                return
            } catch {
                guard token == checkedToken, !Task.isCancelled else { return }
                if attempt + 1 < attempts, ShiyanAuthRecovery.canRetry(error) {
                    do { try await Task.sleep(for: .milliseconds(200)) } catch { return }
                    continue
                }
                // Keep the saved token on network failure, without exposing account caches.
                self.error = error.localizedDescription
                return
            }
        }
    }
    func requestRegistrationCode(email: String) async -> Int? {
        await requestEmailCode(email: email, resettingPassword: false)
    }
    func requestPasswordResetCode(email: String) async -> Int? {
        await requestEmailCode(email: email, resettingPassword: true)
    }
    private func requestEmailCode(email: String, resettingPassword: Bool) async -> Int? {
        guard !busy else { return nil }
        busy = true; error = nil
        defer { busy = false }
        do {
            let data = try await CodexClient.shared.authRequest(route: resettingPassword ? "auth/password-reset-code" : "auth/register-code", method: "POST",
                object: ["email": email.trimmingCharacters(in: .whitespacesAndNewlines)])
            struct Result: Decodable { let resendAfter: Int }
            return try JSONDecoder().decode(Result.self, from: data).resendAfter
        } catch { self.error = error.localizedDescription; return nil }
    }
    func resetPassword(email: String, password: String, confirmation: String, verificationCode: String) async -> Bool {
        guard !busy else { return false }
        busy = true; error = nil
        defer { busy = false }
        do {
            _ = try await CodexClient.shared.authRequest(route: "auth/password-reset", method: "POST",
                object: ["email": email.trimmingCharacters(in: .whitespacesAndNewlines), "password": password,
                         "confirmPassword": confirmation, "verificationCode": verificationCode])
            return true
        } catch { self.error = error.localizedDescription; return false }
    }
    func authenticate(email: String, password: String, displayName: String, register: Bool, bootstrap: Bool, verificationCode: String = "") async {
        guard !busy else { return }
        busy = true; error = nil
        defer { busy = false }
        do {
            if register && status == nil {
                await refreshStatus()
                guard status != nil else { throw AgentClientError.message(error ?? "无法读取注册状态，请稍后重试") }
            }
            let bindingOwner = bootstrap || (register && status?.bootstrapRequired == true && status?.canBootstrap == true)
            let route = bindingOwner ? "auth/bootstrap" : register ? "auth/register" : "auth/login"
            let fields: [String: Any] = register || bootstrap
                ? ["email": email.trimmingCharacters(in: .whitespacesAndNewlines), "password": password, "displayName": displayName, "verificationCode": verificationCode]
                : ["identifier": email.trimmingCharacters(in: .whitespacesAndNewlines), "password": password]
            let result = try JSONDecoder().decode(ShiyanAuthResponse.self,
                from: await CodexClient.shared.authRequest(route: route, method: "POST", object: fields))
            guard result.user.status == "active" else { throw AgentClientError.message("此账户已停用") }
            try saveToken(result.token)
            token = result.token
            clearStores(); activate(result.user)
        } catch { self.error = error.localizedDescription }
    }
    private func activate(_ value: ShiyanUser) {
        ShiyanAccountStorage.activate(value.owner)
        CodexClient.resetAccount()
        user = value
        ShiyanAvatarStore.shared.activate(owner: value.owner)
    }
    private func clearStores() {
        ShiyanAvatarStore.shared.reset()
        KnowledgeReadingCache.clear(ShiyanAccountStorage.owner)
        DotsVoiceSession.resetAccount()
        DotsStore.resetAccount()
        AgentStore.resetAccount()
        ScheduledTaskStore.resetAccount()
    }
    func invalidate() {
        clearStores()
        user = nil; token = nil
        ShiyanAccountStorage.activate("signed-out")
        CodexClient.resetAccount()
        try? saveToken(nil)
    }
    func logout() async {
        guard !busy, token != nil else { return }
        busy = true
        let previous = token
        invalidate()
        busy = false
        _ = try? await CodexClient.shared.authRequest(route: "auth/logout", method: "POST", bearer: previous)
        if user == nil { await refreshStatus() }
    }
}

struct ShiyanAccountRoot: View {
    @ObservedObject private var account = ShiyanAccount.shared
    @State private var loginRequest: ShiyanDesktopLoginRequest?
    @Environment(\.scenePhase) private var scenePhase
    var body: some View {
        Group {
            if account.checking {
                if let image = UIImage(named: "LaunchImage"), let cgImage = image.cgImage {
                    Image(decorative: cgImage, scale: 1)
                        .resizable()
                        .scaledToFill()
                        .ignoresSafeArea()
                } else {
                    Color(.systemBackground).ignoresSafeArea()
                }
            } else if let user = account.user { ContentView().id(user.id + ":" + ShiyanAccountStorage.generation.uuidString) }
            else { ShiyanLoginView() }
        }
        .sheet(item: $loginRequest) { request in
            ShiyanLoginApproval(request: request) { loginRequest = nil }
        }
        .onChange(of: account.user?.id) { _, _ in loginRequest = nil }
        .task(id: "avatar:\(account.user?.id ?? ""):\(scenePhase == .active):\(ShiyanAccountStorage.generation)") {
            guard account.user != nil, scenePhase == .active else { return }
            await ShiyanAvatarStore.shared.observe()
        }
        .task(id: "\(account.user?.id ?? ""):\(scenePhase == .active):\(ShiyanAccountStorage.generation)") {
            guard account.user != nil, scenePhase == .active else { return }
            let generation = ShiyanAccountStorage.generation
            while !Task.isCancelled && generation == ShiyanAccountStorage.generation {
                if loginRequest == nil {
                    do {
                        let data = try await CodexClient.shared.authRequest(route: "auth/device/requests", method: "GET")
                        guard !Task.isCancelled, generation == ShiyanAccountStorage.generation else { return }
                        let inbox = try JSONDecoder().decode(ShiyanDesktopLoginInbox.self, from: data)
                        loginRequest = inbox.requests.first { $0.expiresAt > Date().timeIntervalSince1970 * 1000 }
                    } catch { /* A transient network failure must not open an approval dialog. */ }
                }
                do { try await Task.sleep(for: .seconds(3)) } catch { return }
            }
        }
        .task {
            await account.start()
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(30)) } catch { break }
                if scenePhase == .active { await account.validate() }
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await account.validate() } }
        }
    }
}
