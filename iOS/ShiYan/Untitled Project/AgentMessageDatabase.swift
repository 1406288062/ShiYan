import Foundation
import SQLite3

 
nonisolated final class AgentMessageDatabase: @unchecked Sendable {
    static let pageSize = 40
    struct Summary: Sendable { var count: Int; var hasUser: Bool; var preview: String; var latestWorking: Bool; var hasCompletedReply: Bool }
    struct DirtyBatch: Sendable { var conversations: [AgentConversation]; var generations: [String: Int] }
    private let queue = DispatchQueue(label: "com.shiyan.messages", qos: .utility)
    private let url: URL
    private var connection: OpaquePointer?
    init(directory: URL) { url = directory.appendingPathComponent("messages.sqlite3") }
    private func database() throws -> OpaquePointer {
        if let connection { return connection }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        var db: OpaquePointer?
        guard sqlite3_open_v2(url.path, &db, SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK, let db else {
            if let db { sqlite3_close(db) }; throw failure("无法打开消息数据库")
        }
        sqlite3_busy_timeout(db, 5000)
        connection = db
        do { try execute("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, conversation TEXT NOT NULL, time REAL NOT NULL, role INTEGER NOT NULL, request TEXT, orderTime REAL NOT NULL, turn INTEGER NOT NULL DEFAULT 0, text TEXT NOT NULL, payload BLOB NOT NULL, sequence INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS messages_page ON messages(conversation,orderTime,turn,role,time,sequence); CREATE INDEX IF NOT EXISTS messages_sequence ON messages(sequence); CREATE INDEX IF NOT EXISTS messages_request ON messages(conversation,request,role); CREATE TABLE IF NOT EXISTS local_dirty(id TEXT PRIMARY KEY,generation INTEGER NOT NULL DEFAULT 1); CREATE TABLE IF NOT EXISTS message_assets(id TEXT NOT NULL,message TEXT NOT NULL,payload BLOB NOT NULL,PRIMARY KEY(id,message)); CREATE INDEX IF NOT EXISTS asset_messages ON message_assets(message); CREATE TABLE IF NOT EXISTS sync_baselines(key TEXT PRIMARY KEY,payload BLOB NOT NULL);", db: db)
            let info = try statement("PRAGMA table_info(local_dirty)", db: db)
            var hasGeneration = false
            while try next(info, db: db) { if string(info, at: 1) == "generation" { hasGeneration = true } }
            sqlite3_finalize(info)
            if !hasGeneration { try execute("ALTER TABLE local_dirty ADD COLUMN generation INTEGER NOT NULL DEFAULT 1", db: db) }
        } catch { connection = nil; sqlite3_close(db); throw error }
        guard sqlite3_create_function_v2(db, "shiyan_contains", 2, SQLITE_UTF8 | SQLITE_DETERMINISTIC, nil, { context, count, values in
            guard count == 2, let values, let lhs = sqlite3_value_text(values[0]), let rhs = sqlite3_value_text(values[1]) else {
                sqlite3_result_int(context, 0); return
            }
            let matches = String(cString: lhs).localizedCaseInsensitiveContains(String(cString: rhs))
            sqlite3_result_int(context, matches ? 1 : 0)
        }, nil, nil, nil) == SQLITE_OK else { connection = nil; sqlite3_close(db); throw failure("全文搜索初始化失败") }
        return db
    }
    private func failure(_ text: String) -> NSError { NSError(domain: "ShiyanMessages", code: 1, userInfo: [NSLocalizedDescriptionKey: text]) }
    private func execute(_ sql: String, db: OpaquePointer) throws {
        guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else { throw failure(String(cString: sqlite3_errmsg(db))) }
    }
    private func statement(_ sql: String, db: OpaquePointer) throws -> OpaquePointer {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else { throw failure(String(cString: sqlite3_errmsg(db))) }
        return stmt
    }
    private func bind(_ text: String, at index: Int32, to stmt: OpaquePointer) {
        _ = text.withCString { sqlite3_bind_text(stmt, index, $0, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self)) }
    }
    private func bind(_ data: Data, at index: Int32, to stmt: OpaquePointer) {
        _ = data.withUnsafeBytes { sqlite3_bind_blob(stmt, index, $0.baseAddress, Int32($0.count), unsafeBitCast(-1, to: sqlite3_destructor_type.self)) }
    }
    private func next(_ stmt: OpaquePointer, db: OpaquePointer) throws -> Bool {
        let result = sqlite3_step(stmt)
        if result == SQLITE_ROW { return true }
        if result == SQLITE_DONE { return false }
        throw failure(String(cString: sqlite3_errmsg(db)))
    }
    private func data(_ stmt: OpaquePointer, at index: Int32 = 0) -> Data {
        guard let bytes = sqlite3_column_blob(stmt, index) else { return Data() }
        return Data(bytes: bytes, count: Int(sqlite3_column_bytes(stmt, index)))
    }
    private func string(_ stmt: OpaquePointer, at index: Int32 = 0) -> String {
        sqlite3_column_text(stmt, index).map { String(cString: $0) } ?? ""
    }
    private func run<T: Sendable>(_ body: @escaping @Sendable (AgentMessageDatabase, OpaquePointer) throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { continuation in
            queue.async { [self] in
                do { continuation.resume(returning: try body(self, database())) }
                catch { continuation.resume(throwing: error) }
            }
        }
    }
    func save(_ conversations: [AgentConversation], deleting ids: Set<UUID> = [], locallyChanged: Set<UUID> = []) async throws {
        try await run { this, db in
            try this.execute("BEGIN IMMEDIATE; CREATE TEMP TABLE IF NOT EXISTS changed_messages(id TEXT PRIMARY KEY); DELETE FROM changed_messages", db: db)
            do {
                let changed = try this.statement("INSERT OR IGNORE INTO changed_messages VALUES(?)", db: db)
                defer { sqlite3_finalize(changed) }
                let insert = try this.statement("INSERT INTO messages(id,conversation,time,role,request,orderTime,turn,text,payload,sequence) VALUES(?,?,?,?,?,?,COALESCE((SELECT sequence FROM messages WHERE id=?),(SELECT COALESCE(MAX(sequence),0)+1 FROM messages)),?,?,COALESCE((SELECT sequence FROM messages WHERE id=?),(SELECT COALESCE(MAX(sequence),0)+1 FROM messages))) ON CONFLICT(id) DO UPDATE SET conversation=excluded.conversation,time=excluded.time,role=excluded.role,request=excluded.request,orderTime=excluded.orderTime,text=excluded.text,payload=excluded.payload", db: db)
                defer { sqlite3_finalize(insert) }
                for conversation in conversations {
                    for message in conversation.messages {
                        sqlite3_reset(insert); sqlite3_clear_bindings(insert)
                        let id = message.id.uuidString.lowercased()
                        sqlite3_reset(changed); this.bind(id, at: 1, to: changed)
                        guard sqlite3_step(changed) == SQLITE_DONE else { throw this.failure("消息顺序索引保存失败") }
                        this.bind(id, at: 1, to: insert); this.bind(conversation.id.uuidString.lowercased(), at: 2, to: insert)
                        sqlite3_bind_double(insert, 3, message.createdAt.timeIntervalSince1970)
                        sqlite3_bind_int(insert, 4, message.role == .user ? 0 : 1)
                        if let request = message.requestID { this.bind(request.lowercased(), at: 5, to: insert) }
                        sqlite3_bind_double(insert, 6, message.createdAt.timeIntervalSince1970)
                        this.bind(id, at: 7, to: insert); this.bind(message.text, at: 8, to: insert)
                        this.bind(try JSONEncoder().encode(message), at: 9, to: insert); this.bind(id, at: 10, to: insert)
                        guard sqlite3_step(insert) == SQLITE_DONE else { throw this.failure(String(cString: sqlite3_errmsg(db))) }
                        let clearAssets = try this.statement("DELETE FROM message_assets WHERE message=?", db: db)
                        this.bind(id, at: 1, to: clearAssets); defer { sqlite3_finalize(clearAssets) }
                        guard sqlite3_step(clearAssets) == SQLITE_DONE else { throw this.failure("附件索引保存失败") }
                        for asset in message.assets {
                            let a = try this.statement("INSERT OR REPLACE INTO message_assets VALUES(?,?,?)", db: db)
                            defer { sqlite3_finalize(a) }
                            this.bind(asset.syncAssetID ?? asset.id.uuidString.lowercased(), at: 1, to: a)
                            this.bind(id, at: 2, to: a); this.bind(try JSONEncoder().encode(asset), at: 3, to: a)
                            guard sqlite3_step(a) == SQLITE_DONE else { throw this.failure("附件索引保存失败") }
                        }

                    }
                }
                for id in locallyChanged.subtracting(ids) {
                    let dirty = try this.statement("INSERT INTO local_dirty(id,generation) VALUES(?,1) ON CONFLICT(id) DO UPDATE SET generation=generation+1", db: db)
                    this.bind(id.uuidString.lowercased(), at: 1, to: dirty)
                    guard sqlite3_step(dirty) == SQLITE_DONE else { sqlite3_finalize(dirty); throw this.failure("离线修改保存失败") }; sqlite3_finalize(dirty)
                }
                for id in ids { try this.remove(id: id.uuidString.lowercased(), column: "id", db: db) }
                 
                try this.execute("UPDATE messages AS m SET orderTime=COALESCE((SELECT p.time FROM messages p WHERE m.role=1 AND p.conversation=m.conversation AND p.request=m.request AND p.role=0 ORDER BY p.time,p.sequence LIMIT 1),m.time),turn=COALESCE((SELECT p.sequence FROM messages p WHERE m.role=1 AND p.conversation=m.conversation AND p.request=m.request AND p.role=0 ORDER BY p.time,p.sequence LIMIT 1),m.sequence) WHERE m.id IN (SELECT id FROM changed_messages) OR (m.conversation,m.request) IN (SELECT conversation,request FROM messages WHERE id IN (SELECT id FROM changed_messages))", db: db)
                try this.execute("COMMIT", db: db)
            } catch { try? this.execute("ROLLBACK", db: db); throw error }
        }
    }
    private static let order = "orderTime,turn,role,time,sequence"
    func page(conversation id: UUID, before: UUID? = nil, limit: Int = pageSize) async throws -> [AgentMessage] {
        try await run { this, db in
            let cursor = before == nil ? "" : " AND (\(Self.order)) < (SELECT \(Self.order) FROM messages WHERE id=?)"
            let stmt = try this.statement("SELECT payload FROM messages WHERE conversation=?\(cursor) ORDER BY orderTime DESC,turn DESC,role DESC,time DESC,sequence DESC LIMIT ?", db: db)
            defer { sqlite3_finalize(stmt) }
            this.bind(id.uuidString.lowercased(), at: 1, to: stmt)
            if let before { this.bind(before.uuidString.lowercased(), at: 2, to: stmt) }
            sqlite3_bind_int(stmt, before == nil ? 2 : 3, Int32(max(1, limit)))
            var messages: [AgentMessage] = []
            while try this.next(stmt, db: db) { messages.append(try JSONDecoder().decode(AgentMessage.self, from: this.data(stmt))) }
            return messages.reversed()
        }
    }
    func message(_ id: UUID) async throws -> AgentMessage? {
        try await run { this, db in
            let stmt = try this.statement("SELECT payload FROM messages WHERE id=?", db: db); defer { sqlite3_finalize(stmt) }
            this.bind(id.uuidString.lowercased(), at: 1, to: stmt)
            return try this.next(stmt, db: db) ? try JSONDecoder().decode(AgentMessage.self, from: this.data(stmt)) : nil
        }
    }
    func summaries() async throws -> [UUID: Summary] {
        try await run { this, db in
            let stmt = try this.statement("SELECT conversation,COUNT(*),MIN(role),COALESCE((SELECT substr(p.text,1,240) FROM messages p WHERE p.conversation=m.conversation AND p.text<>'' ORDER BY p.orderTime DESC,p.turn DESC,p.role DESC,p.time DESC,p.sequence DESC LIMIT 1),''),COALESCE((SELECT json_extract(CAST(p.payload AS TEXT),'$.state') FROM messages p WHERE p.conversation=m.conversation ORDER BY p.orderTime DESC,p.turn DESC,p.role DESC,p.time DESC,p.sequence DESC LIMIT 1),'completed'),EXISTS(SELECT 1 FROM messages p WHERE p.conversation=m.conversation AND p.role=1 AND json_extract(CAST(p.payload AS TEXT),'$.state')='completed') FROM messages m GROUP BY conversation", db: db); defer { sqlite3_finalize(stmt) }
            var result: [UUID: Summary] = [:]
            while try this.next(stmt, db: db) {
                if let id = UUID(uuidString: this.string(stmt)) { result[id] = Summary(count: Int(sqlite3_column_int(stmt, 1)), hasUser: sqlite3_column_int(stmt, 2) == 0, preview: this.string(stmt, at: 3), latestWorking: ["submitting", "running", "reconnecting"].contains(this.string(stmt, at: 4)), hasCompletedReply: sqlite3_column_int(stmt, 5) != 0) }
            }; return result
        }
    }
    func search(_ query: String) async throws -> Set<UUID> {
        try await run { this, db in
            let stmt = try this.statement("SELECT DISTINCT conversation FROM messages WHERE shiyan_contains(text,?)=1", db: db); defer { sqlite3_finalize(stmt) }
            this.bind(query, at: 1, to: stmt); var ids = Set<UUID>()
            while try this.next(stmt, db: db) { if let id = UUID(uuidString: this.string(stmt)) { ids.insert(id) } }; return ids
        }
    }
    func ids(conversation id: UUID) async throws -> [UUID] {
        try await run { this, db in
            let stmt = try this.statement("SELECT id FROM messages WHERE conversation=?", db: db); defer { sqlite3_finalize(stmt) }
            this.bind(id.uuidString.lowercased(), at: 1, to: stmt); var ids: [UUID] = []
            while try this.next(stmt, db: db) { if let id = UUID(uuidString: this.string(stmt)) { ids.append(id) } }; return ids
        }
    }
    func prompts(conversation id: UUID, before message: UUID) async throws -> [String] {
        try await run { this, db in
            let stmt = try this.statement("SELECT text FROM messages WHERE conversation=? AND role=0 AND (\(Self.order)) < (SELECT \(Self.order) FROM messages WHERE id=?) ORDER BY \(Self.order)", db: db); defer { sqlite3_finalize(stmt) }
            this.bind(id.uuidString.lowercased(), at: 1, to: stmt); this.bind(message.uuidString.lowercased(), at: 2, to: stmt)
            var values: [String] = []; while try this.next(stmt, db: db) { values.append(this.string(stmt)) }; return values
        }
    }
    private func remove(id: String, column: String, db: OpaquePointer) throws {
        for sql in ["DELETE FROM message_assets WHERE message IN (SELECT id FROM messages WHERE \(column)=?)", "DELETE FROM local_dirty WHERE id IN (SELECT id FROM messages WHERE \(column)=?)"] {
            let cleanup = try statement(sql, db: db); defer { sqlite3_finalize(cleanup) }
            bind(id, at: 1, to: cleanup)
            guard sqlite3_step(cleanup) == SQLITE_DONE else { throw failure("消息索引删除失败") }
        }
        let stmt = try statement("DELETE FROM messages WHERE \(column)=?", db: db); defer { sqlite3_finalize(stmt) }
        bind(id, at: 1, to: stmt)
        guard sqlite3_step(stmt) == SQLITE_DONE else { throw failure("消息删除保存失败") }
    }
    func delete(message: UUID) async throws { try await run { this, db in try this.remove(id: message.uuidString.lowercased(), column: "id", db: db) } }
    func delete(conversation: UUID) async throws { try await run { this, db in try this.remove(id: conversation.uuidString.lowercased(), column: "conversation", db: db) } }

    func dirtyBatch(limit: Int = 100) async throws -> DirtyBatch {
        try await run { this, db in
            let stmt = try this.statement("SELECT m.conversation,m.payload,d.generation,m.id FROM messages m JOIN local_dirty d ON d.id=m.id ORDER BY m.sequence DESC LIMIT ?", db: db)
            defer { sqlite3_finalize(stmt) }; sqlite3_bind_int(stmt, 1, Int32(limit))
            var result: [AgentConversation] = [], generations: [String: Int] = [:]
            while try this.next(stmt, db: db) {
                guard let id = UUID(uuidString: this.string(stmt)) else { continue }
                var c = AgentConversation(id: id)
                c.messages = [try JSONDecoder().decode(AgentMessage.self, from: this.data(stmt, at: 1))]; result.append(c)
                generations[this.string(stmt, at: 3)] = Int(sqlite3_column_int64(stmt, 2))
            }; return DirtyBatch(conversations: result, generations: generations)
        }
    }
    func dirtyMessages(limit: Int = 100) async throws -> [AgentConversation] {
        try await dirtyBatch(limit: limit).conversations
    }
    func clearDirty(_ generations: [String: Int]) async throws {
        try await run { this, db in
            try this.execute("BEGIN IMMEDIATE", db: db)
            do {
                let stmt = try this.statement("DELETE FROM local_dirty WHERE id=? AND generation=?", db: db); defer { sqlite3_finalize(stmt) }
                for (id, generation) in generations {
                    sqlite3_reset(stmt); sqlite3_clear_bindings(stmt); this.bind(id, at: 1, to: stmt)
                    sqlite3_bind_int64(stmt, 2, Int64(generation))
                    guard sqlite3_step(stmt) == SQLITE_DONE else { throw this.failure("离线索引更新失败") }
                }; try this.execute("COMMIT", db: db)
            } catch { try? this.execute("ROLLBACK", db: db); throw error }
        }
    }
    func assets(assistantOnly: Bool = false) async throws -> [AgentAsset] {
        try await run { this, db in
            let sql = assistantOnly ? "SELECT a.payload FROM message_assets a JOIN messages m ON a.message=m.id WHERE m.role=1 GROUP BY a.id" : "SELECT payload FROM message_assets GROUP BY id"
            let stmt = try this.statement(sql, db: db); defer { sqlite3_finalize(stmt) }
            var result: [AgentAsset] = []
            while try this.next(stmt, db: db) { result.append(try JSONDecoder().decode(AgentAsset.self, from: this.data(stmt))) }; return result
        }
    }
    func saveBaselines(_ values: [String: [String: AgentSyncValue]]) async throws {
        guard !values.isEmpty else { return }
        try await run { this, db in
            try this.execute("BEGIN IMMEDIATE", db: db)
            do {
                let stmt = try this.statement("INSERT OR REPLACE INTO sync_baselines VALUES(?,?)", db: db); defer { sqlite3_finalize(stmt) }
                for (key, value) in values {
                    sqlite3_reset(stmt); sqlite3_clear_bindings(stmt); this.bind(key, at: 1, to: stmt)
                    this.bind(try JSONEncoder().encode(value), at: 2, to: stmt)
                    guard sqlite3_step(stmt) == SQLITE_DONE else { throw this.failure("同步基线保存失败") }
                }; try this.execute("COMMIT", db: db)
            } catch { try? this.execute("ROLLBACK", db: db); throw error }
        }
    }
    func baseline(_ key: String) async throws -> [String: AgentSyncValue]? {
        try await run { this, db in
            let stmt = try this.statement("SELECT payload FROM sync_baselines WHERE key=?", db: db); defer { sqlite3_finalize(stmt) }
            this.bind(key, at: 1, to: stmt)
            return try this.next(stmt, db: db) ? try JSONDecoder().decode([String: AgentSyncValue].self, from: this.data(stmt)) : nil
        }
    }
}
