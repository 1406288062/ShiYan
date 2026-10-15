import Foundation
import CryptoKit
import Security

enum IdentityError: Error, CustomStringConvertible {
    case keychain(OSStatus), invalidCommand, invalidInput
    var description: String {
        switch self {
        case .keychain(let status):
            return "Keychain error \(status): \(SecCopyErrorMessageString(status, nil) as String? ?? "unavailable")"
        case .invalidCommand: return "Usage: ShiYanIdentity identity | sign"
        case .invalidInput: return "Signing input must be valid UTF-8 and at most 1 MiB."
        }
    }
}

func signingKey() throws -> Curve25519.Signing.PrivateKey {
    let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "com.shiyan.enhancer.macos.device",
        kSecAttrAccount as String: "signing-key-v1",
        kSecReturnData as String: true,
        kSecMatchLimit as String: kSecMatchLimitOne
    ]
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecSuccess, let data = item as? Data {
        return try Curve25519.Signing.PrivateKey(rawRepresentation: data)
    }
    guard status == errSecItemNotFound else { throw IdentityError.keychain(status) }
    let key = Curve25519.Signing.PrivateKey()
    let insert: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "com.shiyan.enhancer.macos.device",
        kSecAttrAccount as String: "signing-key-v1",
        kSecAttrLabel as String: "拾燕 Mac 设备签名",
        kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        kSecValueData as String: key.rawRepresentation
    ]
    let added = SecItemAdd(insert as CFDictionary, nil)
    if added == errSecDuplicateItem { return try signingKey() }
    guard added == errSecSuccess else { throw IdentityError.keychain(added) }
    return key
}

func output(_ object: [String: String]) throws {
    let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
}

do {
    guard CommandLine.arguments.count == 2 else { throw IdentityError.invalidCommand }
    let command = CommandLine.arguments[1]
    guard command == "identity" || command == "sign" else { throw IdentityError.invalidCommand }
    let key = try signingKey()
    if command == "identity" {
        let publicKey = key.publicKey.rawRepresentation
        let deviceID = SHA256.hash(data: publicKey).map { String(format: "%02x", $0) }.joined()
        try output(["deviceID": deviceID, "publicKey": publicKey.base64EncodedString()])
    } else {
        let data = FileHandle.standardInput.readDataToEndOfFile()
        guard data.count <= 1_048_576, String(data: data, encoding: .utf8) != nil else {
            throw IdentityError.invalidInput
        }
        try output(["signature": try key.signature(for: data).base64EncodedString()])
    }
} catch {
    let message = "ShiYanIdentity: \(error)\n"
    FileHandle.standardError.write(Data(message.utf8))
    exit(1)
}
