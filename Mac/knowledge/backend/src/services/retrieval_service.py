"""Hybrid lexical/vector retrieval with citation-ready results."""

from __future__ import annotations

import re
from typing import Any

from database import fetch_all
from services.vector_service import EmbeddingError, vector_service


def _terms(query: str) -> list[str]:
    terms: list[str] = []
    for token in re.findall(r"[A-Za-z0-9_]+|[\u4e00-\u9fff]+", query.lower()):
        if re.fullmatch(r"[\u4e00-\u9fff]+", token):
            terms.extend(token[index : index + 2] for index in range(max(1, len(token) - 1)))
        elif len(token) > 1:
            terms.append(token)
    return list(dict.fromkeys(terms))[:32]


class RetrievalService:
    def search(self, knowledge_base_id: str, query: str, limit: int = 8) -> list[dict[str, Any]]:
        rows = fetch_all(
            """
            SELECT c.id AS chunk_id, c.content, c.document_id, c.page_start, c.page_end,
                   c.heading, d.title, d.filename
            FROM chunks c
            JOIN documents d ON d.id = c.document_id
            WHERE c.knowledge_base_id = ? AND d.status = 'completed'
            """,
            (knowledge_base_id,),
        )
        if not rows:
            return []

        terms = _terms(query)
        lexical: dict[str, float] = {}
        for row in rows:
            haystack = f"{row['title']} {row['heading']} {row['content']}".lower()
            matches = sum(haystack.count(term) for term in terms)
            if matches:
                lexical[row["chunk_id"]] = float(matches)

        lexical_rank = {chunk_id: rank for rank, (chunk_id, _) in enumerate(sorted(lexical.items(), key=lambda item: item[1], reverse=True), 1)}
        try:
            vector_results = vector_service.query(knowledge_base_id, query, max(limit * 2, 12))
        except EmbeddingError:
            # A lexical hit is still a trustworthy source when the remote
            # embedding service is temporarily unavailable. Do not turn a
            # recoverable retrieval degradation into a failed chat request.
            vector_results = []
        vector_rank = {item["chunk_id"]: rank for rank, item in enumerate(vector_results, 1)}
        vector_by_id = {item["chunk_id"]: item for item in vector_results}
        rows_by_id = {row["chunk_id"]: row for row in rows}

        candidate_ids = set(lexical_rank) | set(vector_rank)
        scored: list[tuple[float, str]] = []
        for chunk_id in candidate_ids:
            # Reciprocal rank fusion is stable across different score scales.
            score = 0.0
            if chunk_id in lexical_rank:
                score += 1.0 / (60 + lexical_rank[chunk_id])
            if chunk_id in vector_rank:
                score += 1.0 / (60 + vector_rank[chunk_id])
            scored.append((score, chunk_id))

        # If a short query has no lexical hit, vector candidates still work.
        if not scored:
            scored = [(1.0 / (60 + index), item["chunk_id"]) for index, item in enumerate(vector_results, 1)]
        scored.sort(reverse=True)

        citations = []
        for score, chunk_id in scored[:limit]:
            row = rows_by_id.get(chunk_id)
            if not row:
                continue
            citations.append(
                {
                    "chunk_id": chunk_id,
                    "document_id": row["document_id"],
                    "document_name": row["title"] or row["filename"],
                    "filename": row["filename"],
                    "page_start": row["page_start"],
                    "page_end": row["page_end"],
                    "quote": row["content"][:900],
                    "heading": row["heading"],
                    "score": round(score, 6),
                    "retrieval": {
                        "lexical_rank": lexical_rank.get(chunk_id),
                        "vector_rank": vector_rank.get(chunk_id),
                        "vector_distance": vector_by_id.get(chunk_id, {}).get("vector_distance"),
                    },
                    "source": "knowledge_base",
                }
            )
        return citations

    @staticmethod
    def context(citations: list[dict[str, Any]]) -> str:
        blocks = []
        for index, item in enumerate(citations, 1):
            if item.get("source") == "web":
                source = f"[来源 {index}] {item.get('document_name', '外部资料')}（网页）"
            else:
                page_start = item.get("page_start") or "未知"
                page_end = item.get("page_end") or page_start
                source = f"[来源 {index}] {item.get('document_name', '未命名文档')} 第 {page_start}-{page_end} 页"
            blocks.append(f"{source}\n{item.get('quote', '')}")
        return "\n\n".join(blocks)


retrieval_service = RetrievalService()
