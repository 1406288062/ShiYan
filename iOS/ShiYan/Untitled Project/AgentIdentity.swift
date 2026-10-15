import Foundation
import CryptoKit
import Security

 
 
@MainActor
final class AgentIdentity {
    static let shared = AgentIdentity()
    private var cachedKey: Curve25519.Signing.PrivateKey?
    private let service = "com.shiyan.enhancer.device"
    private let account = "signing-key-v1"

    private func key() throws -> Curve25519.Signing.PrivateKey {
        if let cachedKey { return cachedKey }
#if targetEnvironment(simulator)
         
         
        let folder = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("ShiyanSimulatorIdentity", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let file = folder.appendingPathComponent("device-signing-key")
        let value: Curve25519.Signing.PrivateKey
        if FileManager.default.fileExists(atPath: file.path) {
            value = try Curve25519.Signing.PrivateKey(rawRepresentation: Data(contentsOf: file))
        } else {
            value = Curve25519.Signing.PrivateKey()
            try value.rawRepresentation.write(to: file, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        }
        cachedKey = value
        return value
#else
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
#if DEBUG
        NSLog("[ShiyanIdentity] keychain status=%d", status)
#endif
        if status == errSecSuccess, let data = result as? Data {
            let value = try Curve25519.Signing.PrivateKey(rawRepresentation: data)
            cachedKey = value
            return value
        }
        guard status == errSecItemNotFound else { throw AgentClientError.message("设备安全存储暂不可用，请解锁设备后重试") }
        let value = Curve25519.Signing.PrivateKey()
        let add: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecValueData as String: value.rawRepresentation
        ]
        let addStatus = SecItemAdd(add as CFDictionary, nil)
#if DEBUG
        NSLog("[ShiyanIdentity] keychain add status=%d", addStatus)
#endif
        guard addStatus == errSecSuccess else { throw AgentClientError.message("设备安全存储初始化失败") }
        cachedKey = value
        return value
#endif
    }

    func enrollment() throws -> [String: String] {
        let publicKey = try key().publicKey.rawRepresentation
        let result = ["publicKey": publicKey.base64EncodedString(), "deviceID": Self.digest(publicKey)]
#if DEBUG
         
        let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("shiyan-device-public.json")
        try JSONSerialization.data(withJSONObject: result).write(to: url, options: .atomic)
#endif
        return result
    }

    func headers(method: String, path: String, body: Data) throws -> [String: String] {
        let value = try key()
        let timestamp = String(Int64(Date().timeIntervalSince1970 * 1000))
        let nonce = UUID().uuidString
        let bodyHash = Self.digest(body)
        let signed = [method, path, timestamp, nonce, bodyHash].joined(separator: "\n")
        return [
            "X-Shiyan-Device": Self.digest(value.publicKey.rawRepresentation),
            "X-Shiyan-Time": timestamp,
            "X-Shiyan-Nonce": nonce,
            "X-Shiyan-Body-Sha": bodyHash,
            "X-Shiyan-Signature": try value.signature(for: Data(signed.utf8)).base64EncodedString()
        ]
    }

    static func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
}
