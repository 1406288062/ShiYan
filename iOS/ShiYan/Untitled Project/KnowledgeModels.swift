import Foundation

nonisolated struct KnowledgeSpace: Decodable, Identifiable, Sendable {
    let id: String
    let name: String
    let knowledge_base_count: Int?
}

nonisolated struct KnowledgeBase: Decodable, Identifiable, Sendable {
    let id: String
    let space_id: String
    let name: String
    let description: String?
}

nonisolated struct KnowledgeChunk: Decodable, Identifiable, Sendable {
    let id: String
    let content: String
    let page_start: Int?
    let page_end: Int?
    let heading: String?
}

nonisolated struct KnowledgeDocument: Decodable, Identifiable, Sendable {
    let id: String
    let title: String?
    let filename: String
    let status: String
    let page_count: Int?
    let summary: String?
    let tags: [String]?
    let chunks: [KnowledgeChunk]?
    var displayName: String { title?.isEmpty == false ? title! : filename }
    var statusLabel: String {
        switch status {
        case "ready", "completed", "indexed": "可检索"
        case "failed", "error": "处理失败"
        case "queued": "等待处理"
        case "processing": "正在处理"
        default: "处理中"
        }
    }
}

nonisolated struct KnowledgeUpload: Decodable, Sendable {
    let task_id: String
    let document_id: String
    let knowledge_base_id: String
    let status: String
}

nonisolated struct KnowledgeTask: Decodable, Identifiable, Sendable {
    let task_id: String
    let document_id: String
    let knowledge_base_id: String
    let status: String
    let stage: String
    let progress: Double
    let stage_done: Int?
    let stage_total: Int?
    let queue_ahead: Int?
    let error: String?
    var id: String { task_id }
    var isFinished: Bool { ["completed", "succeeded", "failed", "cancelled", "error"].contains(status) }
    var label: String {
        if status == "failed" || status == "error" { return "文档处理失败" }
        if status == "completed" || status == "succeeded" { return "文档已就绪" }
        if status == "queued" { return (queue_ahead ?? 0) > 0 ? "前面还有 \(queue_ahead!) 份文档" : "等待处理" }
        switch stage {
        case "extract", "extracting", "parse", "parsing", "ocr": return "正在读取文档"
        case "chunk", "chunking": return "正在整理段落"
        case "embed", "embedding", "index", "indexing": return "正在建立索引"
        case "knowledge", "graph", "knowledge_extraction": return "正在整理知识"
        default: return "正在处理文档"
        }
    }
}

nonisolated struct KnowledgeCitation: Decodable, Sendable {
    let document_id: String?
    let document_name: String?
    let page_start: Int?
    let page_end: Int?
    let quote: String?
    let source: String?
    let url: String?
    let score: Double?
    var pageLabel: String? {
        guard let start = page_start else { return nil }
        if let end = page_end, end != start { return "第 \(start)–\(end) 页" }
        return "第 \(start) 页"
    }
}

nonisolated struct KnowledgeChatMessage: Decodable, Identifiable, Sendable {
    let id: UUID
    let type: String
    let content: String
    let citations: [KnowledgeCitation]?
    let status: String?
    let mode: String?
    init(type: String, content: String, citations: [KnowledgeCitation]? = nil, status: String? = nil, mode: String? = nil) {
        id = UUID(); self.type = type; self.content = content; self.citations = citations; self.status = status; self.mode = mode
    }
    private enum CodingKeys: String, CodingKey { case type, content, citations, status, mode }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = UUID(); type = try c.decode(String.self, forKey: .type); content = try c.decode(String.self, forKey: .content)
        citations = try c.decodeIfPresent([KnowledgeCitation].self, forKey: .citations)
        status = try c.decodeIfPresent(String.self, forKey: .status); mode = try c.decodeIfPresent(String.self, forKey: .mode)
    }
}

nonisolated struct KnowledgeHistory: Decodable, Sendable {
    let conversation_id: String?
    let messages: [KnowledgeChatMessage]
}

nonisolated struct KnowledgeAnswer: Decodable, Sendable {
    let conversation_id: String?
    let answer: String
    let citations: [KnowledgeCitation]?
    let status: String?
    let mode: String?
}

nonisolated struct KnowledgeGraph: Decodable, Sendable {
    let title: String?
    let document_count: Int?
    let module_count: Int?
    let relation_count: Int?
    let structure: KnowledgeStructure?
    var topics: [KnowledgeTopic] { structure?.level1?.points ?? [] }
    var readingTopics: [KnowledgeTopic] { KnowledgeTopic.inReadingOrder(topics) }
}
nonisolated struct KnowledgeStructure: Decodable, Sendable { let level1: KnowledgeTopic? }
nonisolated struct KnowledgeTopic: Decodable, Identifiable, Sendable {
    let id: String
    let title: String
    let summary: String?
    let sources: [KnowledgeCitation]?
    let support_count: Int?
    let level2: [KnowledgeTopic]?
    let level3: [KnowledgeTopic]?
    let children: [KnowledgeTopic]?
    var points: [KnowledgeTopic] {
        [level2, level3, children].compactMap { $0 }.first(where: { !$0.isEmpty }) ?? []
    }
    var readingPoints: [KnowledgeTopic] { Self.inReadingOrder(points) }
    private var readingPageBounds: (start: Int, end: Int)? {
        let own = (sources ?? []).compactMap { source -> (Int, Int)? in
            guard let start = source.page_start, start > 0 else { return nil }
            return (start, max(start, source.page_end ?? start))
        }
        let ranges = own + points.compactMap { $0.readingPageBounds }
        guard let start = ranges.map({ $0.0 }).min(), let end = ranges.map({ $0.1 }).max() else { return nil }
        return (start, end)
    }
    var readingPageLabel: String? {
        guard let bounds = readingPageBounds else { return nil }
        return bounds.start == bounds.end ? "第 \(bounds.start) 页" : "第 \(bounds.start)–\(bounds.end) 页"
    }
    static func inReadingOrder(_ topics: [KnowledgeTopic]) -> [KnowledgeTopic] {
        topics.enumerated().sorted { left, right in
            let leftPage = left.element.readingPageBounds?.start ?? Int.max
            let rightPage = right.element.readingPageBounds?.start ?? Int.max
            return leftPage == rightPage ? left.offset < right.offset : leftPage < rightPage
        }.map(\.element)
    }
}
