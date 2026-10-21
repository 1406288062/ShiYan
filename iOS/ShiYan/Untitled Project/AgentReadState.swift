import Foundation
import CryptoKit

 
nonisolated struct AgentUnreadContent: Codable, Equatable, Sendable {
    let text: String
    let attachmentIDs: [String]
    let state: String
    let error: String?

    var version: String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
         
        let data = try! encoder.encode(self)
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    func isUnread(comparedTo previous: AgentUnreadContent?, readVersion: String?,
                  lastReadAt: Date?, contentDate: Date, isWorking: Bool) -> Bool {
        if readVersion == version { return false }
        if previous == self { return false }
         
         
        if previous != nil { return true }
        if !isWorking, let lastReadAt, contentDate <= lastReadAt { return false }
        return true
    }
}

nonisolated struct AgentReadReceipt: Codable, Sendable {
    var readAt: Date
    var versions: [String: String]
}
