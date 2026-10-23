import Foundation
import Combine
import UIKit
import ImageIO
import UniformTypeIdentifiers

nonisolated struct ShiyanAccountAvatar: Codable, Sendable {
    let data: String?
    let mimeType: String
    let revision: Int
    let updatedAt: Double?
}

nonisolated struct ShiyanAccountAvatarResponse: Decodable, Sendable {
    let avatar: ShiyanAccountAvatar
}

/// One account-owned image shared by settings and remembered device login.
@MainActor
final class ShiyanAvatarStore: ObservableObject {
    static let shared = ShiyanAvatarStore()
    @Published private(set) var image: UIImage?
    @Published private(set) var saving = false
    private var revision = -1
    private var owner: String?
    private var generation: UUID?
    private var legacyImage: Data?

    private init() {}

    func reset() {
        image = nil
        revision = -1
        owner = nil
        generation = nil
        legacyImage = nil
        saving = false
    }

    func activate(owner: String) {
        reset()
        self.owner = owner
        generation = ShiyanAccountStorage.generation
        let folder = ShiyanAccountStorage.directory("Profile", owner: owner)
        let cache = folder.appendingPathComponent("avatar.json")
        if let bytes = try? Data(contentsOf: cache), bytes.count <= 3 * 1024 * 1024,
           let value = try? JSONDecoder().decode(ShiyanAccountAvatar.self, from: bytes),
           let decoded = try? Self.decodedImage(value) {
            image = decoded.image
            revision = value.revision
        } else if !FileManager.default.fileExists(atPath: cache.path),
                  let bytes = try? Data(contentsOf: folder.appendingPathComponent("avatar.jpg")),
                  bytes.count <= 2 * 1024 * 1024, let decoded = UIImage(data: bytes) {
            image = decoded
            legacyImage = bytes
        }
    }

    private func matches(_ expectedGeneration: UUID) -> Bool {
        generation == expectedGeneration && ShiyanAccountStorage.generation == expectedGeneration
            && owner == ShiyanAccount.shared.user?.owner && ShiyanAccount.shared.token != nil
    }

    /// The scene task owns this subscription. Reconnects occur only after a broken stream.
    func observe() async {
        guard let expectedGeneration = generation, matches(expectedGeneration) else { return }
        let client = CodexClient.shared
        var retryDelay = 1
        while !Task.isCancelled && matches(expectedGeneration) {
            do {
                let value = try await client.accountAvatar()
                guard !Task.isCancelled, matches(expectedGeneration) else { return }
                try await reconcile(value, client: client, generation: expectedGeneration)
                let stream = try await client.accountAvatarEvents()
                for try await bytes in stream {
                    guard !Task.isCancelled, matches(expectedGeneration) else { return }
                    let response = try JSONDecoder().decode(ShiyanAccountAvatarResponse.self, from: bytes)
                    try await reconcile(response.avatar, client: client, generation: expectedGeneration)
                    retryDelay = 1
                }
            } catch {
                guard !Task.isCancelled, matches(expectedGeneration) else { return }
            }
            // This is connection recovery, never a timer that repeatedly fetches profile data.
            do { try await Task.sleep(for: .seconds(retryDelay)) } catch { return }
            retryDelay = min(retryDelay * 2, 30)
        }
    }

    private func reconcile(_ value: ShiyanAccountAvatar, client: CodexClient, generation expected: UUID) async throws {
        guard matches(expected), !Task.isCancelled else { return }
        if value.revision == 0, value.data == nil, let legacyImage, !saving {
            let jpeg = try await Task.detached(priority: .utility) { try Self.jpeg(legacyImage) }.value
            guard matches(expected), !Task.isCancelled else { return }
            do {
                let migrated = try await client.updateAccountAvatar(data: jpeg, expectedRevision: 0)
                guard matches(expected), !Task.isCancelled else { return }
                try apply(migrated)
            } catch let error as ShiyanAvatarHTTPFailure where error.status == 409 {
                // A different device already chose an avatar; the central value wins.
                let latest = try await client.accountAvatar()
                guard matches(expected), !Task.isCancelled else { return }
                try apply(latest)
            }
        } else if value.revision != 0 || legacyImage == nil {
            try apply(value)
        }
    }

    func upload(_ original: Data) async throws {
        guard let expected = generation, matches(expected), !saving else { throw CancellationError() }
        let client = CodexClient.shared
        saving = true
        defer { if matches(expected) { saving = false } }
        let jpeg = try await Task.detached(priority: .userInitiated) { try Self.jpeg(original) }.value
        try Task.checkCancellation()
        guard matches(expected) else { throw CancellationError() }
        let value = try await client.updateAccountAvatar(data: jpeg)
        try Task.checkCancellation()
        guard matches(expected) else { throw CancellationError() }
        try apply(value)
    }

    private func apply(_ value: ShiyanAccountAvatar) throws {
        guard value.revision > revision, let owner else { return }
        let decoded = try Self.decodedImage(value)
        // The server has accepted this revision. A local cache failure must not
        // turn a successful upload into an error or keep showing the old image.
        image = decoded.image
        revision = value.revision
        legacyImage = nil
        let folder = ShiyanAccountStorage.directory("Profile", owner: owner)
        let jpeg = folder.appendingPathComponent("avatar.jpg")
        // The versioned record also persists a deletion, preventing legacy re-import.
        if let cache = try? JSONEncoder().encode(value) {
            try? cache.write(to: folder.appendingPathComponent("avatar.json"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        }
        if let bytes = decoded.data {
            try? bytes.write(to: jpeg, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } else if FileManager.default.fileExists(atPath: jpeg.path) {
            try? FileManager.default.removeItem(at: jpeg)
        }
    }

    private static func decodedImage(_ value: ShiyanAccountAvatar) throws -> (image: UIImage?, data: Data?) {
        guard value.revision >= 0 else { throw AvatarFailure.invalidResponse }
        guard let encoded = value.data else { return (nil, nil) }
        guard value.mimeType == "image/jpeg", encoded.count <= 3 * 1024 * 1024,
              let data = Data(base64Encoded: encoded), data.count <= 2 * 1024 * 1024,
              let image = UIImage(data: data) else { throw AvatarFailure.invalidResponse }
        return (image, data)
    }

    nonisolated private enum AvatarFailure: LocalizedError {
        case invalidImage, invalidResponse
        var errorDescription: String? {
            switch self {
            case .invalidImage: "无法读取这张照片，请选择其他图片（不超过 20 MB）。"
            case .invalidResponse: "服务器头像数据无效，请稍后重试。"
            }
        }
    }

    nonisolated private static func jpeg(_ data: Data) throws -> Data {
        guard !data.isEmpty, data.count <= 20 * 1024 * 1024,
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let pixelWidth = properties[kCGImagePropertyPixelWidth] as? NSNumber,
              let pixelHeight = properties[kCGImagePropertyPixelHeight] as? NSNumber
        else { throw AvatarFailure.invalidImage }
        let width = pixelWidth.doubleValue, height = pixelHeight.doubleValue
        guard width.isFinite, height.isFinite, width > 0, height > 0 else { throw AvatarFailure.invalidImage }
        // Preserve 512 pixels on the short edge for ordinary photos. The long
        // edge cap bounds the decoded buffer for unusually wide panoramas.
        let maximumPixelSize = Int(min(4096, ceil(max(width, height) * min(1, 512 / min(width, height)))))
        guard
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: maximumPixelSize
              ] as CFDictionary) else { throw AvatarFailure.invalidImage }
        let side = min(512, min(image.width, image.height))
        let rect = CGRect(x: (image.width - side) / 2, y: (image.height - side) / 2, width: side, height: side)
        guard side > 0, let cropped = image.cropping(to: rect),
              let context = CGContext(data: nil, width: side, height: side, bitsPerComponent: 8,
                  bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
        else { throw AvatarFailure.invalidImage }
        let outputRect = CGRect(x: 0, y: 0, width: side, height: side)
        context.setFillColor(CGColor(gray: 1, alpha: 1))
        context.fill(outputRect)
        context.draw(cropped, in: outputRect)
        guard let flattened = context.makeImage() else { throw AvatarFailure.invalidImage }
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output, UTType.jpeg.identifier as CFString, 1, nil)
        else { throw AvatarFailure.invalidImage }
        CGImageDestinationAddImage(destination, flattened, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { throw AvatarFailure.invalidImage }
        return output as Data
    }
}
