"""Read-only, scoped integration API; all retrieval stays in Knowledge OS.

Run separately with uvicorn retrieval_app:app --app-dir src --port 8002.
No ingestion worker or changes to the existing authenticated application.
"""
from __future__ import annotations

import os
import secrets
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from database import fetch_one
from services.retrieval_service import _terms, retrieval_service

app = FastAPI(title="Knowledge OS Retrieval API", version="1.0.0")


class Search(BaseModel):
    model_config = ConfigDict(extra="forbid")
    knowledge_base_id: str = Field(min_length=1, max_length=80)
    query: str = Field(min_length=1, max_length=500)
    top_k: int = Field(default=4, ge=1, le=6)


def authorize(authorization: str, kb_id: str):
    key = os.getenv("RETRIEVAL_API_KEY", "")
    if not key or not secrets.compare_digest(authorization, "Bearer " + key):
        raise HTTPException(401, "Invalid integration credentials")
    allowed = {x.strip() for x in os.getenv("RETRIEVAL_ALLOWED_KB_IDS", "").split(",") if x.strip()}
    if kb_id not in allowed:
        raise HTTPException(403, "Knowledge base outside integration scope")
    if not fetch_one("SELECT id FROM knowledge_bases WHERE id=?", (kb_id,)):
        raise HTTPException(404, "Knowledge base not found")


def reliable(item: dict, query: str) -> bool:
    """RRF is a ranking score, never a confidence probability."""
    if not item.get("quote") or not item.get("page_start") or not item.get("document_id"):
        return False
    evidence = (item.get("heading", "") + " " + item["quote"]).lower()
    terms = _terms(query)
    matches = sum(term in evidence for term in terms)
    lexical = bool(terms) and matches >= min(2, len(terms))
    distance = item.get("retrieval", {}).get("vector_distance")
    # Conservative cosine-distance gate; deployments should evaluate this
    # threshold on their own corpus. Missing/degraded vectors need lexical hits.
    vector = isinstance(distance, (int, float)) and distance <= float(os.getenv("RETRIEVAL_MAX_DISTANCE", "0.45"))
    return lexical or vector


@app.get("/health")
def health():
    return {"status": "ok", "service": "knowledge-os-retrieval", "configured": bool(os.getenv("RETRIEVAL_API_KEY"))}


@app.post("/api/retrieval/search")
def search(request: Search, authorization: str = Header(default="")):
    authorize(authorization, request.knowledge_base_id)
    try:
        candidates = retrieval_service.search(request.knowledge_base_id, request.query, request.top_k)
    except Exception:
        raise HTTPException(503, "Retrieval temporarily unavailable") from None
    evidence = [dict(item, evidence_id=item["chunk_id"], trusted_as="evidence_only")
                for item in candidates if reliable(item, request.query)][:request.top_k]
    return {"knowledge_base_id": request.knowledge_base_id, "query": request.query,
            "evidence": evidence, "reliable": bool(evidence),
            "mode": "hybrid_rrf" if any(x["retrieval"].get("vector_rank") for x in evidence) else "lexical",
            "next_action": "answer_from_evidence" if evidence else "rephrase_or_handoff"}
