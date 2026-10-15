import Combine
import Foundation
import CryptoKit

nonisolated indirect enum AgentSyncValue: Codable, Equatable, Sendable {
    case object([String: AgentSyncValue]), array([AgentSyncValue]), string(String), number(Double), bool(Bool), null
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode([String: AgentSyncValue].self) { self = .object(v) }
        else { self = .array(try c.decode([AgentSyncValue].self)) }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .object(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        case .null: try c.encodeNil()
        }
    }
    var string: String? { if case .string(let s) = self { return s }; return nil }
    var boolean: Bool? { if case .bool(let b) = self { return b }; return nil }
    var array: [AgentSyncValue] { if case .array(let a) = self { return a }; return [] }
    var object: [String: AgentSyncValue] { if case .object(let d) = self { return d }; return [:] }
}
nonisolated struct AgentProject: Identifiable, Codable, Equatable {
    var id = UUID()
    var name: String
    var createdAt = Date()
    var isPinned = false
}
nonisolated struct AgentSyncChange: Codable, Sendable {
    var kind: String; var id: String; var revision: Int; var deleted: Bool
    var data: [String: AgentSyncValue]?
}
nonisolated struct AgentSyncMutation: Codable, Sendable {
    var mutationId = UUID().uuidString.lowercased()
    var kind: String; var id: String; var baseRevision: Int; var deleted: Bool
    var data: [String: AgentSyncValue]?
}
nonisolated struct AgentSyncResponse: Decodable, Sendable {
    struct Accepted: Decodable, Sendable { var mutationId: String; var kind: String; var id: String; var revision: Int }
    struct Conflict: Decodable, Sendable { var mutationId: String; var current: AgentSyncChange? }
    var ok: Bool; var cursor: Int; var hasMore: Bool; var changes: [AgentSyncChange]
    var accepted: [Accepted]?; var conflicts: [Conflict]?
}
nonisolated struct AgentSyncLedger: Codable, Sendable {
    var cursor = 0
    var mobileProjectionVersion: Int? = 2
    var revisions: [String: Int] = [:]
    var baseline: [String: [String: AgentSyncValue]] = [:]
    var fingerprints: [String: String] = [:]
    var pending: [AgentSyncMutation] = []
    var tombstones = Set<String>()
    var uploadedAssets = Set<String>()
    static func key(_ kind: String, _ id: String) -> String { kind + ":" + id }
    static func fingerprint(_ data: [String: AgentSyncValue]) -> String {
        let e = JSONEncoder(); e.outputFormatting = [.sortedKeys]
        guard let bytes = try? e.encode(data) else { return "" }
        return SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }
    mutating func stage(kind: String, id: String, data: [String: AgentSyncValue]) {
        let key = Self.key(kind, id), print = Self.fingerprint(data)
        guard !tombstones.contains(key), fingerprints[key] != print else { return }
        fingerprints[key] = print
        pending.removeAll { $0.kind == kind && $0.id == id }
        pending.append(AgentSyncMutation(kind: kind, id: id, baseRevision: revisions[key] ?? 0, deleted: false, data: data))
    }
    mutating func delete(kind: String, id: String) {
        let key = Self.key(kind, id)
        tombstones.insert(key); fingerprints.removeValue(forKey: key)
        pending.removeAll { $0.kind == kind && $0.id == id }
        pending.append(AgentSyncMutation(kind: kind, id: id, baseRevision: revisions[key] ?? 0, deleted: true, data: nil))
    }
    mutating func accept(_ receipt: AgentSyncResponse.Accepted) {
        let key = Self.key(receipt.kind, receipt.id)
        if let mutation = pending.first(where: { $0.mutationId == receipt.mutationId }) {
            if let data = mutation.data { baseline[key] = data }
            pending.removeAll { $0.mutationId == receipt.mutationId }
        }
        revisions[key] = max(revisions[key] ?? 0, receipt.revision)
    }
    mutating func absorb(_ change: AgentSyncChange) -> AgentSyncChange? {
        let key = Self.key(change.kind, change.id)
        guard change.revision >= (revisions[key] ?? 0) else { return nil }
        var applied = change
        let index = pending.firstIndex { $0.kind == change.kind && $0.id == change.id }
        if change.deleted {
            tombstones.insert(key); fingerprints.removeValue(forKey: key); baseline.removeValue(forKey: key)
            pending.removeAll { $0.kind == change.kind && $0.id == change.id }
        } else if let remote = change.data {
            if let i = index, pending[i].deleted {
                pending[i].baseRevision = change.revision; pending[i].mutationId = UUID().uuidString.lowercased()
                revisions[key] = change.revision; baseline[key] = remote
                return nil  
            }
            if let i = index, let desired = pending[i].data, let previous = baseline[key] {
                var merged = remote
                 
                if change.kind != "messages" || remote["role"]?.string != "assistant" {
                    for (field, value) in desired where previous[field] != value { merged[field] = value }
                }
                if merged != remote {
                    pending[i].data = merged; pending[i].baseRevision = change.revision
                    pending[i].mutationId = UUID().uuidString.lowercased(); applied.data = merged
                } else { pending.remove(at: i) }
            } else if let i = index { pending.remove(at: i) }  
            baseline[key] = remote; fingerprints[key] = Self.fingerprint(applied.data ?? remote)
        }
        revisions[key] = change.revision
        return applied
    }
}

 
private final class AgentSyncLedgerWriter: @unchecked Sendable {
    private let queue = DispatchQueue(label: "com.shiyan.sync-ledger", qos: .utility)
    private let lock = NSLock()
    private let file: URL
    private var latest: AgentSyncLedger?
    private var writing = false
    init(file: URL) { self.file = file }
    func save(_ snapshot: AgentSyncLedger, durable: Bool) {
        if durable { _ = queue.sync { self.write(snapshot) }; return }
        lock.lock(); latest = snapshot
        if writing { lock.unlock(); return }
        writing = true; lock.unlock()
        queue.async { [self] in
            while true {
                lock.lock()
                guard let next = latest else { writing = false; lock.unlock(); return }
                latest = nil; lock.unlock()
                write(next)
            }
        }
    }
    func flush(_ snapshot: AgentSyncLedger) async -> Bool {
        await withCheckedContinuation { continuation in
            queue.async { [self] in continuation.resume(returning: write(snapshot)) }
        }
    }
    @discardableResult private func write(_ snapshot: AgentSyncLedger) -> Bool {
        do {
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONEncoder().encode(snapshot).write(to: file, options: .atomic)
            return true
        } catch { return false }
    }
}

@MainActor
final class AgentSyncCoordinator {
    weak var store: AgentStore?
    private let file: URL
    private(set) var ledger = AgentSyncLedger()
    private var loop: Task<Void, Never>?
    private var transfers: Task<Void, Never>?
    private lazy var ledgerWriter = AgentSyncLedgerWriter(file: file)
    private var working = false
    private var uploadOffset = 0
    private var downloadOffset = 0
    private var dirty = true
    private var applying = false
    private var ledgerLoaded = false
    private var saveAllowed = true
    init(store: AgentStore, directory: URL) {
        self.store = store; file = directory.appendingPathComponent("sync-state.json")
    }
    func initialize() async { if !ledgerLoaded { await loadLedger() } }
    private func loadLedger() async {
        guard !ledgerLoaded else { return }
        defer { ledgerLoaded = true }
        let location = file
        guard FileManager.default.fileExists(atPath: location.path) else { return }
        do {
            var saved = try await Task.detached(priority: .utility) {
                var value = try JSONDecoder().decode(AgentSyncLedger.self, from: Data(contentsOf: location))
                for (key, print) in value.fingerprints where print.hasPrefix("{") {
                    value.fingerprints[key] = SHA256.hash(data: Data(print.utf8)).map { String(format: "%02x", $0) }.joined()
                }
                return value
            }.value
            if saved.mobileProjectionVersion != 2 {
                saved.cursor = 0; saved.mobileProjectionVersion = 2
            }
            if let store {
                try await store.messageDatabase.saveBaselines(saved.baseline)
                saved.baseline = saved.baseline.filter { key, _ in
                    saved.pending.contains { AgentSyncLedger.key($0.kind, $0.id) == key }
                }
                for mutation in saved.pending {
                    let key = AgentSyncLedger.key(mutation.kind, mutation.id)
                    if saved.baseline[key] == nil { saved.baseline[key] = try await store.messageDatabase.baseline(key) }
                }
            }
            ledger = saved
        } catch {
            saveAllowed = false
            store?.notice = "同步记录读取失败，离线修改已保留"
        }
    }
    private func archiveBaselines() async throws {
        guard let store else { return }
        try await store.messageDatabase.saveBaselines(ledger.baseline)
        let pendingKeys = Set(ledger.pending.map { AgentSyncLedger.key($0.kind, $0.id) })
        ledger.baseline = ledger.baseline.filter { pendingKeys.contains($0.key) }
    }
    func changed() { if !applying { dirty = true } }
    func delete(kind: String, id: UUID) { deleteMany(kind: kind, ids: [id]) }
    func deleteMany(kind: String, ids: [UUID]) {
        for id in ids { ledger.delete(kind: kind, id: id.uuidString.lowercased()) }
        save(durable: true); dirty = true
    }
    func deleteConversation(_ id: UUID, messages: [UUID]) async throws {
        ledger.delete(kind: "conversations", id: id.uuidString.lowercased())
        for message in messages { ledger.delete(kind: "messages", id: message.uuidString.lowercased()) }
        guard await ledgerWriter.flush(ledger) else { throw NSError(domain: "ShiyanSync", code: 1) }
        dirty = true
    }
    func start() {
        guard loop == nil, saveAllowed else { return }
        loop = Task { [weak self] in
            await self?.loadLedger()
            while !Task.isCancelled {
                await self?.cycle()
                do { try await Task.sleep(for: .seconds(4)) } catch { break }
            }
        }
    }
    private func save(durable: Bool = false) {
        guard saveAllowed else { return }
        ledgerWriter.save(ledger, durable: durable)
    }
    static func date(_ date: Date) -> AgentSyncValue {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return .string(f.string(from: date))
    }
    static func date(_ value: AgentSyncValue?) -> Date? {
        guard let text = value?.string else { return nil }
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }
    static func text(_ value: String?) -> AgentSyncValue { value.map(AgentSyncValue.string) ?? .null }
    static func asset(_ a: AgentAsset) -> [String: AgentSyncValue] {
        let id = a.syncAssetID ?? a.id.uuidString.lowercased()
        return ["id": .string(id), "syncAssetId": .string(id), "filename": .string(a.filename), "mimeType": .string(a.mimeType), "remoteId": text(a.remoteID)]
    }
    private func collect() async throws {
        guard let store else { return }
        var edited = false
        for p in store.projects {
            let id = p.id.uuidString.lowercased()
            edited = try await stage(kind: "projects", id: id, data: ["id": .string(id), "name": .string(p.name), "createdAt": Self.date(p.createdAt), "isPinned": .bool(p.isPinned)]) || edited
        }
        let dirtyBatch = try await store.messageDatabase.dirtyBatch()
        let diskDirty = dirtyBatch.conversations
        var candidates = store.conversations.map { original in var c = original; c.messages = []; return c }
        for archived in diskDirty {
            if let i = candidates.firstIndex(where: { $0.id == archived.id }) {
                let existing = Set(candidates[i].messages.map(\.id))
                candidates[i].messages.append(contentsOf: archived.messages.filter { !existing.contains($0.id) })
            }
        }
        for c in candidates {
            let id = c.id.uuidString.lowercased()
            if !c.hasSentMessage && (ledger.revisions[AgentSyncLedger.key("conversations", id)] ?? 0) == 0 { continue }
            var data = c.syncMetadata ?? [:]
            data.merge(["id": .string(id), "title": .string(c.title), "titleIsManual": .bool(c.titleIsManual), "isPinned": .bool(c.isPinned), "projectId": Self.text(c.projectID?.uuidString.lowercased()), "createdAt": Self.date(c.createdAt), "updatedAt": Self.date(c.updatedAt), "remoteConversationId": Self.text(c.remoteConversationID), "threadId": Self.text(c.threadID)]) { _, new in new }
            edited = try await stage(kind: "conversations", id: id, data: data) || edited
            for m in c.messages {
                var value = m.syncMetadata ?? [:]
                let messageID = m.id.uuidString.lowercased()
                value.merge(["id": .string(messageID), "conversationId": .string(id), "role": .string(m.role.rawValue), "text": .string(m.text), "assets": .array(m.assets.map { .object(Self.asset($0)) }), "createdAt": Self.date(m.createdAt), "completedAt": m.completedAt.map(Self.date) ?? .null, "state": .string(m.state.rawValue), "phase": .string(m.phase), "error": Self.text(m.error), "requestId": Self.text(m.requestID), "remoteJobId": Self.text(m.remoteJobID), "reasoning": Self.text(m.reasoning), "model": Self.text(m.model)]) { _, new in new }
                if let items = m.displayItems { value["displayItems"] = .array(items) }
                if let files = m.fileChanges { value["fileChanges"] = .array(files) }
                if let usage = m.usage { value["usage"] = .object(usage) }
                edited = try await stage(kind: "messages", id: messageID, data: value) || edited
            }
        }
        guard edited || !diskDirty.isEmpty else { return }
        guard await ledgerWriter.flush(ledger) else { throw NSError(domain: "ShiyanSync", code: 1) }
        try await store.messageDatabase.clearDirty(dirtyBatch.generations)
    }
    private func stage(kind: String, id: String, data: [String: AgentSyncValue]) async throws -> Bool {
        let key = AgentSyncLedger.key(kind, id)
        guard ledger.fingerprints[key] != AgentSyncLedger.fingerprint(data) else { return false }
        if ledger.baseline[key] == nil, let store {
            ledger.baseline[key] = try await store.messageDatabase.baseline(key)
        }
        ledger.stage(kind: kind, id: id, data: data)
        return true
    }
    func cycle() async {
        guard !working, saveAllowed, ledgerLoaded, store != nil else { return }
        working = true; defer { working = false }
        do {
            dirty = false; try await collect()
            var response = try await CodexClient.shared.sync(after: ledger.cursor)
            for _ in 0..<12 {
                guard try await apply(response) else { return }
                guard response.hasMore else { break }
                response = try await CodexClient.shared.sync(after: ledger.cursor)
            }
             
            await publishReadyMutations()
            startTransfersIfNeeded()


        } catch {
            NSLog("[ShiyanSync] cursor=%d error=%@", ledger.cursor, error.localizedDescription)
             
        }
    }
    private func startTransfersIfNeeded() {
        guard transfers == nil else { return }
        transfers = Task { [weak self] in
            guard let self else { return }
            defer { self.transfers = nil }
            let before = self.ledger.uploadedAssets
            await self.transferAssets()
            await self.cacheMissingAssets()
            await self.store?.collectGeneratedImages()
            if self.ledger.uploadedAssets != before { self.save() }
        }
    }
    private func transferAssets() async {
        guard let store else { return }
            if !ledger.pending.isEmpty {
                let needed = Set(ledger.pending.flatMap { $0.data?["assets"]?.array ?? [] }.compactMap { $0.object["syncAssetId"]?.string ?? $0.object["id"]?.string })
                var attempted = Set<String>()
                let candidates = ((try? await store.messageDatabase.assets()) ?? []).filter { needed.contains($0.syncAssetID ?? $0.id.uuidString.lowercased()) && !ledger.uploadedAssets.contains($0.syncAssetID ?? $0.id.uuidString.lowercased()) && FileManager.default.fileExists(atPath: $0.url.path) }
                let offset = candidates.isEmpty ? 0 : uploadOffset % candidates.count
                uploadOffset = offset + min(8, candidates.count)
                for asset in Array(candidates.dropFirst(offset)) + Array(candidates.prefix(offset)) {
                    let id = asset.syncAssetID ?? asset.id.uuidString.lowercased()
                    guard needed.contains(id), !ledger.uploadedAssets.contains(id), attempted.count < 8,
                          FileManager.default.fileExists(atPath: asset.url.path), attempted.insert(id).inserted else { continue }
                    do {
                        try await CodexClient.shared.uploadSyncAsset(id: id, asset: asset)
                        ledger.uploadedAssets.insert(id); save()
                    } catch { continue }  
                }
            }
    }
    private func publishReadyMutations() async {
        let batch = Array(ledger.pending.filter { mutation in
            mutation.deleted || (mutation.data?["assets"]?.array ?? []).allSatisfy { value in
                guard let id = value.object["syncAssetId"]?.string ?? value.object["id"]?.string else { return false }
                return ledger.uploadedAssets.contains(id)
            }
        }.prefix(100))
        guard !batch.isEmpty else { return }
        do {
            let posted = try await CodexClient.shared.sync(after: ledger.cursor, mutations: batch)
            for receipt in posted.accepted ?? [] { ledger.accept(receipt) }
            for conflict in posted.conflicts ?? [] {
                if let current = conflict.current, let merged = ledger.absorb(current) { try await importChange(merged) }
            }
            guard try await apply(posted) else { return }; try await archiveBaselines(); save()
        } catch {   }
    }
    private func apply(_ response: AgentSyncResponse) async throws -> Bool {
        if response.changes.isEmpty && response.cursor <= ledger.cursor { return true }
        applying = true; defer { applying = false }
        for change in response.changes {
            if let merged = ledger.absorb(change) { try await importChange(merged) }
        }
        store?.confirmVisibleReadStateAfterSync()
         
        applying = false
         
        guard let store, await store.persistDurably() else { return false }
        try await store.refreshMessageWindowsAfterSync()
        try await archiveBaselines()
        ledger.cursor = max(ledger.cursor, response.cursor)
        save()
        return true
    }
    private func importChange(_ change: AgentSyncChange) async throws {
        guard let store, let id = UUID(uuidString: change.id) else { return }
        if change.kind == "messages", let data = change.data {
            let cachedMessage = try await store.messageDatabase.message(id)
            var assets: [AgentAsset] = []
            for value in data["assets"]?.array ?? [] {
                let a = value.object
                guard let key = a["syncAssetId"]?.string ?? a["id"]?.string, let uuid = UUID(uuidString: key) else { continue }
                let existing = (cachedMessage?.assets ?? store.conversations.flatMap(\.messages).flatMap(\.assets)).first { ($0.syncAssetID ?? $0.id.uuidString.lowercased()) == key }
                var asset = existing ?? AgentAsset(id: uuid, filename: a["filename"]?.string ?? "附件", mimeType: a["mimeType"]?.string ?? "application/octet-stream", relativePath: "sync-" + uuid.uuidString.lowercased(), syncAssetID: key)
                asset.filename = a["filename"]?.string ?? asset.filename
                asset.mimeType = a["mimeType"]?.string ?? asset.mimeType
                asset.syncAssetID = key; asset.remoteID = a["remoteId"]?.string
                assets.append(asset)
            }
            try await store.applySync(change, id: id, assets: assets)
        } else { try await store.applySync(change, id: id, assets: []) }
    }
    private func cacheMissingAssets() async {
        guard let store else { return }
        var attempts = 0
        var downloaded = false
        defer { if downloaded { store.objectWillChange.send() } }
        let candidates = ((try? await store.messageDatabase.assets()) ?? []).filter { $0.syncAssetID != nil && !FileManager.default.fileExists(atPath: $0.url.path) }
        let offset = candidates.isEmpty ? 0 : downloadOffset % candidates.count
        downloadOffset = offset + min(8, candidates.count)
        for asset in Array(candidates.dropFirst(offset)) + Array(candidates.prefix(offset)) {
            guard attempts < 8 else { break }
            guard let id = asset.syncAssetID, !FileManager.default.fileExists(atPath: asset.url.path) else { continue }
            attempts += 1
            do {
                let bytes = try await CodexClient.shared.syncAsset(id: id)
                try FileManager.default.createDirectory(at: AgentMedia.directory, withIntermediateDirectories: true)
                try bytes.write(to: asset.url, options: .atomic)
                ledger.uploadedAssets.insert(id)
                downloaded = true
            } catch { continue }
        }
    }
}
