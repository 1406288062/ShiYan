import Foundation
import UIKit
import ImageIO

 
nonisolated struct AgentConversation: Identifiable, Codable, Equatable, Sendable {
    var id = UUID()
    var projectID: UUID?
    var syncMetadata: [String: AgentSyncValue]?
    var title = "新聊天"
    var titleIsManual = false
    var titleWasGenerated: Bool?
    var isPinned = false
    var hasUnread = false
    var unreadMessageIDs: Set<String>?  
    var createdAt = Date()
    var updatedAt = Date()
    var lastOpenedAt: Date?
    var model: String?  
    var reasoning = "low"
    var draft = ""
    var draftAssets: [AgentAsset] = []
    var activeImageID: UUID?
     
    var storedMessageCount: Int?
    var storedHasSentMessage: Bool?
    var storedLastContent: String?
    var storedIsBusy: Bool?
    var storedHasCompletedReply: Bool?
    var messages: [AgentMessage] = []
    var pendingJobID: String?
    var pendingMessageID: UUID?
    var lastEventID = 0
    var threadID: String?
     
     
    var remoteConversationID: String?
    var hasSentMessage: Bool { storedHasSentMessage == true || messages.contains { $0.role == .user } }
    var isBusy: Bool { pendingJobID != nil || storedIsBusy == true || messages.last?.isWorking == true }
    var lastContent: String {
        messages.last(where: { !$0.text.isEmpty })?.text ?? storedLastContent ?? (messages.contains(where: { !$0.assets.isEmpty }) ? "图片" : "")
    }
    var latestAssets: [AgentAsset] { messages.last(where: { !$0.assets.isEmpty })?.assets ?? [] }
}

nonisolated struct AgentMessage: Identifiable, Codable, Equatable, Sendable {
    enum Role: String, Codable, Sendable { case user, assistant }
    enum State: String, Codable, Sendable { case submitting, running, completed, failed, cancelled, reconnecting }
    var id = UUID()
    var role: Role
    var text: String
    var assets: [AgentAsset] = []
    var createdAt = Date()
    var state: State = .completed
    var phase = ""
    var error: String?
    var requestID: String?
    var reasoning: String?
    var model: String?
    var rawResult: String?
    var displayItems: [AgentSyncValue]?
    var fileChanges: [AgentSyncValue]?
    var usage: [String: AgentSyncValue]?
    var remoteJobID: String?
    var completedAt: Date?
    var syncMetadata: [String: AgentSyncValue]?
    var unreadContent: AgentUnreadContent {
        AgentUnreadContent(text: text,
                           attachmentIDs: assets.map { $0.syncAssetID ?? $0.id.uuidString.lowercased() },
                           state: isWorking ? "working" : state.rawValue,
                           error: state == .failed ? error : nil)
    }
    var isWorking: Bool { [.submitting, .running, .reconnecting].contains(state) }
    var canRetryConnection: Bool {
        guard role == .assistant, let error, !error.isEmpty else { return false }
        if state == .reconnecting { return true }
        guard state == .failed else { return false }
        let value = error.lowercased()
        return ["连接中断", "检查网络", "网络连接", "无法连接", "接收中断", "connection", "network", "timed out"].contains { value.contains($0) }
    }

}

nonisolated struct AgentAsset: Identifiable, Codable, Equatable, Sendable {
    var id = UUID()
    var remoteID: String?
    var filename: String
    var mimeType: String
    var relativePath: String
    var syncAssetID: String?
    var isImage: Bool { mimeType.hasPrefix("image/") }
    var url: URL { AgentMedia.directory.appendingPathComponent(relativePath) }
}

struct AgentModelOption: Codable, Identifiable, Equatable, Sendable {
    var id: String
    var displayName: String
    var reasoningEfforts: [String]
    var defaultReasoning: String
}

 
enum AgentIOSModelPolicy {
    static func isHidden(_ id: String) -> Bool {
        let normalized = id.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
         
        return normalized != "gpt-5.6-sol"
            && (normalized == "gpt-5.6" || normalized.hasPrefix("gpt-5.6-"))
    }
    static func replacement(for id: String) -> [String]? {
        switch id.lowercased().trimmingCharacters(in: .whitespacesAndNewlines) {
        case "gpt-5.6-luna": return ["gpt-6-luna"]
        case "gpt-5.6-sol": return ["gpt-6-sol", "gpt-6.1-sol"]
        default: return nil
        }
    }
}

struct AgentCapabilities: Codable, Equatable, Sendable {
    var model: String
    var reasoningEfforts: [String]
    var defaultReasoning: String
    var maxUploadImages: Int
    var models: [AgentModelOption]?
    var availableModels: [AgentModelOption] {
        let verified = (models ?? []).filter { !$0.reasoningEfforts.isEmpty && $0.reasoningEfforts.contains($0.defaultReasoning) }
        let visible = verified.filter { !AgentIOSModelPolicy.isHidden($0.id) }
        if !visible.isEmpty { return visible }
        if !AgentIOSModelPolicy.isHidden(model) {
            return [AgentModelOption(id: model, displayName: model, reasoningEfforts: reasoningEfforts, defaultReasoning: defaultReasoning)]
        }
         
         
        return AgentCapabilities.fallback.availableModels
    }
     
     
     
    var hasOnlyHiddenModels: Bool {
        let verified = (models ?? []).filter { !$0.reasoningEfforts.isEmpty && $0.reasoningEfforts.contains($0.defaultReasoning) }
        guard AgentIOSModelPolicy.isHidden(model) else { return false }
        if !verified.isEmpty { return verified.allSatisfy { AgentIOSModelPolicy.isHidden($0.id) } }
        return !reasoningEfforts.isEmpty && reasoningEfforts.contains(defaultReasoning)
    }
    func option(for id: String?) -> AgentModelOption {
        let visible = availableModels
        let requested = id ?? model
        if let exact = visible.first(where: { $0.id == requested }) { return exact }
        if let replacement = AgentIOSModelPolicy.replacement(for: requested),
           let equivalent = replacement.lazy.compactMap({ target in visible.first { $0.id == target } }).first {
            return equivalent
        }
        return visible.first { $0.id == model }
            ?? visible.first { $0.id.hasPrefix("gpt-6") }
            ?? visible[0]
    }
     
     
    var isVerified: Bool {
        guard model != "Codex", !reasoningEfforts.isEmpty,
              reasoningEfforts.contains(defaultReasoning) else { return false }
        let candidates = models ?? [AgentModelOption(id: model, displayName: model,
            reasoningEfforts: reasoningEfforts, defaultReasoning: defaultReasoning)]
        return !candidates.isEmpty
            && candidates.contains { $0.id == model }
            && Set(candidates.map(\.id)).count == candidates.count
            && candidates.allSatisfy { !$0.id.isEmpty && !$0.reasoningEfforts.isEmpty
                && $0.reasoningEfforts.contains($0.defaultReasoning) }
    }
    static let fallback = AgentCapabilities(model: "Codex", reasoningEfforts: ["low", "medium", "high"], defaultReasoning: "low", maxUploadImages: 8)
}

enum AgentMedia {
    nonisolated static var directory: URL {
        ShiyanAccountStorage.directory("AgentMedia")
    }
    private static let cache = NSCache<NSString, UIImage>()

    static func image(_ asset: AgentAsset, maxPixel: Int = 1200) -> UIImage? {
        guard asset.isImage else { return nil }
        let key = "\(ShiyanAccountStorage.owner)-\(asset.id)-\(maxPixel)" as NSString
        if let image = cache.object(forKey: key) { return image }
        guard let source = CGImageSourceCreateWithURL(asset.url as CFURL, nil),
              let cg = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceThumbnailMaxPixelSize: maxPixel,
                kCGImageSourceCreateThumbnailWithTransform: true
              ] as CFDictionary) else { return nil }
        let image = UIImage(cgImage: cg)
        cache.totalCostLimit = 80 * 1024 * 1024
        cache.setObject(image, forKey: key, cost: cg.width * cg.height * 4)
        return image
    }

    static func saveImage(_ image: UIImage) throws -> AgentAsset {
        guard let data = image.normalizedForEditing(maxDimension: 3000).jpegData(compressionQuality: 0.95) else {
            throw AgentClientError.message("图片读取失败")
        }
        return try save(data, filename: "图片.jpg", mimeType: "image/jpeg")
    }

    static func save(_ data: Data, filename: String, mimeType: String, remoteID: String? = nil) throws -> AgentAsset {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let id = UUID()
        let ext = URL(fileURLWithPath: filename).pathExtension.lowercased()
        let safeExtension = ext.isEmpty || ext.count > 12 ? "bin" : ext
        let relativePath = "\(id.uuidString).\(safeExtension)"
        try data.write(to: directory.appendingPathComponent(relativePath), options: .atomic)
        return AgentAsset(id: id, remoteID: remoteID, filename: filename, mimeType: mimeType, relativePath: relativePath)
    }
}

func reasoningTitle(_ value: String) -> String {
    switch value {
    case "minimal": return "最低"
    case "low": return "低"
    case "medium": return "中"
    case "high": return "高"
    case "xhigh": return "超高"
    case "max": return "最高"
    case "ultra": return "极致"
    default: return value
    }
}

extension AgentMessage {
    var hasVerifiedOutputImage: Bool {
        role == .assistant && assets.contains {
            $0.remoteID != nil && $0.isImage && AgentMedia.image($0) != nil
        }
    }
    var presentationText: String {
        AgentResultPresentation.text(text, hasVerifiedOutputImage: hasVerifiedOutputImage)
    }
    var presentationError: String? {
        AgentResultPresentation.error(error, hasVerifiedOutputImage: hasVerifiedOutputImage)
    }
}
