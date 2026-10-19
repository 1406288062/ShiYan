"""Explicit, auditable Agent state machine for knowledge retrieval."""

from __future__ import annotations

import json
import re
import uuid
from typing import Any

from database import execute, fetch_one, utc_now, write_audit
from services.llm_service import llm_service
from services.retrieval_service import retrieval_service


_CITATION = re.compile(r"\[(?:来源|source)\s*(\d+)\]", re.IGNORECASE)
_UNSUPPORTED_CLAIM = re.compile(
    r"资料中没有足够依据|(?:当前|现有)知识库.{0,30}没有.{0,20}依据|"
    r"没有(?:找到|检索到).{0,30}(?:足够|相关).{0,15}(?:依据|证据|资料)|"
    r"问题.{0,40}(?:不完整|不明确|没有完整|缺少)|"
    r"(?:请|需要).{0,15}(?:补充|明确).{0,20}(?:问题|上下文|具体)|"
    r"(?:本问题|该问题|当前问题).{0,12}资料不足|insufficient (?:evidence|information)|not enough (?:evidence|information)",
    re.IGNORECASE,
)


def _without_legacy_reference_tail(text: str) -> str:
    """Remove only the recognizable bibliography previously appended by us."""
    match = re.search(r"\n\n引用：\n([\s\S]+)\Z", text)
    if not match:
        return text
    lines = [line.strip() for line in match.group(1).splitlines() if line.strip()]
    metadata = re.compile(r"\[(?:来源|source)\s*\d+\]\s+.+(?:第\s*[\d未知-]+\s*页|（网页）)\s*\Z", re.IGNORECASE)
    if lines and all(metadata.fullmatch(line) for line in lines):
        return text[:match.start()].rstrip()
    return text


def select_answer_citations(answer: dict[str, Any], candidates: list[dict[str, Any]]) -> dict[str, Any]:
    """Project only evidence actually cited by supported answer statements.

    Retrieval ranking produces candidates, not a bibliography. This projection
    is also safe to apply while reading old chat rows; it never edits storage.
    """
    result = dict(answer)
    text = _without_legacy_reference_tail(str(result.get("answer") or ""))
    no_answer = result.get("status") in {"no_context", "needs_clarification", "insufficient_evidence"}
    selected: list[dict[str, Any]] = []
    positions: dict[tuple[Any, ...], int] = {}

    def replace(match: re.Match[str]) -> str:
        index = int(match.group(1))
        if no_answer or not 1 <= index <= len(candidates):
            return ""
        prefix = _CITATION.sub("", text[:match.start()]).rstrip().rstrip("。.!！?？;；")
        claim = re.split(r"[。.!！?？;；\n]", prefix)[-1]
        if _UNSUPPORTED_CLAIM.search(claim):
            return ""
        item = candidates[index - 1]
        if not isinstance(item, dict):
            return ""
        key = (item.get("source", "knowledge_base"), item.get("document_id") or item.get("filename") or item.get("document_name"),
            item.get("url"), item.get("page_start"), item.get("page_end") or item.get("page_start"))
        position = positions.get(key)
        if position is None:
            selected.append(dict(item))
            position = len(selected)
            positions[key] = position
        else:
            current = selected[position - 1]
            quote = str(item.get("quote") or "").strip()
            existing = str(current.get("quote") or "").strip()
            if quote and re.sub(r"\s+", " ", quote) not in re.sub(r"\s+", " ", existing):
                current["quote"] = (existing + "\n\n" + quote).strip()
        return f"[来源{position}]"

    result["answer"] = _CITATION.sub(replace, text).strip()
    result["answer"] = re.sub(r"(\[来源\d+\])(?:\s*\1)+", r"\1", result["answer"])
    result["citations"] = selected
    return result


class AgentService:
    def create_run(self, user_id: str, knowledge_base_id: str, action: str, payload: dict[str, Any]) -> str:
        run_id = str(uuid.uuid4())
        now = utc_now()
        execute(
            """
            INSERT INTO agent_runs(run_id, user_id, knowledge_base_id, action, state, status, input_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'PLAN', 'running', ?, ?, ?)
            """,
            (run_id, user_id, knowledge_base_id, action, json.dumps(payload, ensure_ascii=False), now, now),
        )
        try:
            write_audit(user_id, "agent.run.created", "agent_run", run_id, {"action": action})
        except Exception:
            pass
        return run_id

    def _transition(
        self,
        run_id: str,
        state: str,
        status: str = "running",
        output: dict[str, Any] | None = None,
        error: str | None = None,
    ) -> None:
        execute(
            "UPDATE agent_runs SET state = ?, status = ?, output_json = ?, error_message = ?, updated_at = ? WHERE run_id = ?",
            (state, status, json.dumps(output, ensure_ascii=False) if output is not None else None, error, utc_now(), run_id),
        )

    def run_query(
        self,
        run_id: str,
        question: str,
        history: list[dict] | None = None,
        allow_web: bool = False,
    ) -> dict[str, Any]:
        run = fetch_one("SELECT * FROM agent_runs WHERE run_id = ?", (run_id,))
        if not run:
            raise ValueError("Agent run 不存在")
        try:
            self._transition(run_id, "RETRIEVE")
            citations = retrieval_service.search(run["knowledge_base_id"], question, limit=8)
            tools = ["search_knowledge"]
            if allow_web and not citations:
                self._transition(run_id, "SEARCH")
                web = llm_service.web_search(question)
                if web.get("results"):
                    citations.extend(
                        {
                            "document_id": None,
                            "document_name": item.get("title", "外部搜索结果"),
                            "page_start": None,
                            "page_end": None,
                            "quote": item.get("snippet", ""),
                            "source": "web",
                            "url": item.get("url"),
                            "score": 0,
                        }
                        for item in web["results"][:5]
                    )
                    tools.append("web_search")
            context = retrieval_service.context(citations)
            self._transition(run_id, "DRAFT")
            knowledge_base = fetch_one("SELECT name FROM knowledge_bases WHERE id = ?", (run["knowledge_base_id"],))
            answer = llm_service.answer_question(
                question,
                context,
                knowledge_base["name"] if knowledge_base else "知识库",
                history,
                citations,
            )
            self._transition(run_id, "VERIFY")
            output = select_answer_citations({**answer, "used_tools": tools}, citations)
            self._transition(run_id, "COMPLETED", "completed", output)
            return output
        except Exception as exc:
            self._transition(run_id, "FAILED", "failed", error=str(exc))
            raise





agent_service = AgentService()
