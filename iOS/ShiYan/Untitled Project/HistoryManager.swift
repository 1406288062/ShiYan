import SwiftUI
import Photos
import Combine
import ImageIO

 
 
enum ShiyanEnhancedFilename {
    static func jpegName(_ filename: String, modelName: String) -> String {
        let leaf = (filename as NSString).lastPathComponent
        let stem = (leaf as NSString).deletingPathExtension
        let base = stem.isEmpty ? "ShiYan" : stem
        let needsMarker = modelName == "动漫增强" && !base.lowercased().hasSuffix("_anime")
        return base + (needsMarker ? "_anime" : "") + ".jpg"
    }
}

 
struct HistoryEntry: Identifiable, Codable, Equatable {
    let id: UUID
    let filename: String
    let modelName: String
    let createdAt: Date
    let imageWidth: Int
    let imageHeight: Int

    var downloadFilename: String {
        ShiyanEnhancedFilename.jpegName(filename, modelName: modelName)
    }

    var fileURL: URL {
        HistoryManager.documentsDir.appendingPathComponent("\(id.uuidString).jpg")
    }

    var image: CGImage? {
        guard let data = try? Data(contentsOf: fileURL),
              let provider = CGDataProvider(data: data as CFData),
              let cg = CGImage(jpegDataProviderSource: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)
        else { return nil }
        return cg
    }

    static func == (lhs: HistoryEntry, rhs: HistoryEntry) -> Bool { lhs.id == rhs.id }
}

 
@MainActor
final class HistoryManager: ObservableObject {
    nonisolated(unsafe) static let documentsDir: URL = {
        let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Enhanced")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()

    @Published var entries: [HistoryEntry] = []

    private let storageURL = documentsDir.appendingPathComponent("history.json")
    private var thumbnailCache: [UUID: CGImage] = [:]
    private let thumbnailMaxPixel = 240

    init() { load() }

     
    func thumbnail(for entry: HistoryEntry) async -> CGImage? {
        if let cached = thumbnailCache[entry.id] {
            return cached
        }

        let url = entry.fileURL
        let maxPixel = thumbnailMaxPixel
        let thumbnail = await Task.detached(priority: .utility) {
            Self.makeThumbnail(url: url, maxPixel: maxPixel)
        }.value
        guard let thumbnail else { return nil }

         
        if thumbnailCache.count >= 120, let firstKey = thumbnailCache.keys.first {
            thumbnailCache.removeValue(forKey: firstKey)
        }
        thumbnailCache[entry.id] = thumbnail
        return thumbnail
    }

    private nonisolated static func makeThumbnail(url: URL, maxPixel: Int) -> CGImage? {
        guard let data = try? Data(contentsOf: url),
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              let thumbnail = CGImageSourceCreateThumbnailAtIndex(
                source,
                0,
                [
                    kCGImageSourceCreateThumbnailFromImageAlways: true,
                    kCGImageSourceThumbnailMaxPixelSize: maxPixel,
                    kCGImageSourceCreateThumbnailWithTransform: true,
                    kCGImageSourceShouldCache: false
                ] as CFDictionary
              ) else {
            return nil
        }
        return thumbnail
    }

    @discardableResult
    func add(filename: String, modelName: String, image: CGImage) -> HistoryEntry {
        let id = UUID()
        let entry = HistoryEntry(
            id: id,
            filename: modelName == "动漫增强"
                ? ShiyanEnhancedFilename.jpegName(filename, modelName: modelName) : filename,
            modelName: modelName,
            createdAt: Date(),
            imageWidth: image.width,
            imageHeight: image.height
        )
         
        if let data = UIImage(cgImage: image).jpegData(compressionQuality: 0.95) {
            try? data.write(to: entry.fileURL)
        }
        entries.insert(entry, at: 0)
        save()
        return entry
    }

    func collectGeneratedImage(_ asset: AgentAsset) async {
        guard asset.isImage else { return }
        let key = asset.syncAssetID ?? asset.remoteID ?? asset.id.uuidString.lowercased()
        let preference = "spaceGeneratedImagesCollected"
        if Set(UserDefaults.standard.stringArray(forKey: preference) ?? []).contains(key) { return }
        let image = await Task.detached(priority: .utility) {
            Self.makeThumbnail(url: asset.url, maxPixel: 3000)
        }.value
        guard let image else { return }
        var seen = Set(UserDefaults.standard.stringArray(forKey: preference) ?? [])
        guard !seen.contains(key) else { return }
        if !entries.contains(where: { $0.modelName == "AI Agent" && $0.filename == asset.filename }) {
            let entry = add(filename: asset.filename, modelName: "AI Agent", image: image)
            guard FileManager.default.fileExists(atPath: entry.fileURL.path) else {
                entries.removeAll { $0.id == entry.id }; save(); return
            }
        }
        seen.insert(key)
        UserDefaults.standard.set(Array(seen), forKey: preference)
    }

    func remove(_ entry: HistoryEntry) {
        try? FileManager.default.removeItem(at: entry.fileURL)
        thumbnailCache.removeValue(forKey: entry.id)
        entries.removeAll(where: { $0.id == entry.id })
        save()
    }

     
    func remove(_ ids: Set<UUID>) {
        for entry in entries where ids.contains(entry.id) {
            try? FileManager.default.removeItem(at: entry.fileURL)
            thumbnailCache.removeValue(forKey: entry.id)
        }
        entries.removeAll(where: { ids.contains($0.id) })
        save()
    }

     
    func saveEntries(_ entries: [HistoryEntry]) async -> Int {
        var items: [(filename: String, data: Data)] = []
        for e in entries {
            guard let img = e.image else { continue }
            let ui = UIImage(cgImage: img)
            guard let jpeg = ui.jpegData(compressionQuality: 0.95) else { continue }
            items.append((e.downloadFilename, jpeg))
        }
        guard !items.isEmpty else { return 0 }

        let status = PHPhotoLibrary.authorizationStatus(for: .addOnly)
        let authorized: Bool
        if status == .notDetermined {
            authorized = await PHPhotoLibrary.requestAuthorization(for: .addOnly) == .authorized
        } else {
            authorized = status == .authorized || status == .limited
        }
        guard authorized else { return 0 }

        return await withCheckedContinuation { c in
            PHPhotoLibrary.shared().performChanges {
                for it in items {
                    let req = PHAssetCreationRequest.forAsset()
                    let opts = PHAssetResourceCreationOptions()
                    opts.originalFilename = it.filename
                    req.addResource(with: .photo, data: it.data, options: opts)
                }
            } completionHandler: { success, _ in
                c.resume(returning: success ? items.count : 0)
            }
        }
    }

    func saveEntry(_ entry: HistoryEntry, toPhotos: Bool = true) async -> Bool {
         
        let jpegData: Data? = await Task.detached(priority: .utility) { () -> Data? in
            guard let img = entry.image else { return nil }
            return UIImage(cgImage: img).jpegData(compressionQuality: 0.95)
        }.value
        guard let jpegData else { return false }

        let status = PHPhotoLibrary.authorizationStatus(for: .addOnly)
        let authorized: Bool
        if status == .notDetermined {
            authorized = await PHPhotoLibrary.requestAuthorization(for: .addOnly) == .authorized
        } else {
            authorized = status == .authorized || status == .limited
        }
        guard authorized else { return false }

        return await withCheckedContinuation { c in
            PHPhotoLibrary.shared().performChanges {
                let req = PHAssetCreationRequest.forAsset()
                let opts = PHAssetResourceCreationOptions()
                opts.originalFilename = entry.downloadFilename
                req.addResource(with: .photo, data: jpegData, options: opts)
            } completionHandler: { success, _ in c.resume(returning: success) }
        }
    }

    private func load() {
        if let data = try? Data(contentsOf: storageURL),
           let decoded = try? JSONDecoder().decode([HistoryEntry].self, from: data) {
            entries = decoded
        }
    }

    private func save() {
        if let data = try? JSONEncoder().encode(entries) {
            try? data.write(to: storageURL)
        }
    }
}
