"""Knowledge Base Agent API.

The API is intentionally a modular monolith for the first production-shaped
version: authentication, spaces, ingestion, retrieval and Agent workflows are
separated by service boundaries while remaining easy to deploy in one image.
"""

from __future__ import annotations

import json
import re
import sys
import threading
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, File, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field

# Support both `python src/main.py` and `uvicorn src.main:app`.
SRC_DIR = Path(__file__).resolve().parent
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from services.agent_service import agent_service, select_answer_citations
from auth_service import create_access_token, decode_access_token, hash_password, verify_password
from config import (
    ALLOWED_ORIGINS,
    KNOWLEDGE_DIR,
    KNOWLEDGE_WORKERS,
    MAX_UPLOAD_BYTES,
    PDF_VISION_WORKERS,
    UPLOAD_DIR,
    ensure_runtime_dirs,
)
from database import (
    append_chat_turn,
    clear_chat_messages,
    create_space_for_user,
    create_user,
    execute,
    fetch_all,
    fetch_one,
    get_or_create_chat_conversation,
    get_conn,
    init_db,
    list_chat_messages,
    utc_now,
    write_audit,
)
from services.llm_service import DeepSeekError, llm_service
from services.knowledge_graph_service import build_knowledge_graph
from services.pdf_service import (
    build_knowledge_context,
    content_hash,
    extract_pdf_document,
    split_pages_into_chunks,
)
from services.vector_service import EmbeddingError, vector_service
from services.mac_compute import owner_context, owner_for_ingestion


ensure_runtime_dirs()
init_db()

_worker_stop = threading.Event()
_worker_wakeup = threading.Event()
_worker_thread: threading.Thread | None = None


def _claim_next_ingestion_task() -> dict[str, Any] | None:
    """Atomically claim one queued ingestion task."""
    with get_conn() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            """
            SELECT * FROM tasks
            WHERE task_type = 'document_ingestion' AND status = 'queued'
            ORDER BY created_at, id
            LIMIT 1
            """
        ).fetchone()
        if not row:
            return None
        claimed = conn.execute(
            """
            UPDATE tasks
            SET status = 'processing', stage = 'starting', attempts = attempts + 1, updated_at = ?
            WHERE task_id = ? AND status = 'queued'
            """,
            (utc_now(), row["task_id"]),
        )
        return dict(row) if claimed.rowcount == 1 else None


def _recover_ingestion_tasks() -> None:
    """Requeue interrupted work and reconcile tasks completed before a crash."""
    tasks = fetch_all(
        "SELECT * FROM tasks WHERE task_type = 'document_ingestion' AND status IN ('queued', 'processing')"
    )
    for task in tasks:
        document = fetch_one("SELECT status FROM documents WHERE id = ?", (task.get("document_id"),))
        if not document:
            _update_task(
                task["task_id"],
                status="failed",
                stage="failed",
                error_code="MissingDocument",
                error_message="文档记录不存在",
            )
            continue
        if document["status"] in {"completed", "duplicate"}:
            _update_task(task["task_id"], status="completed", stage="completed", progress=100)
            continue
        file_path = Path(str(task.get("file_path") or ""))
        if file_path.is_file():
            _update_task(
                task["task_id"],
                status="queued",
                stage="queued",
                progress=min(int(task.get("progress") or 0), 5),
                error_code=None,
                error_message=None,
            )
            execute(
                "UPDATE documents SET status = 'processing', updated_at = ? WHERE id = ?",
                (utc_now(), task["document_id"]),
            )
        else:
            _update_task(
                task["task_id"],
                status="failed",
                stage="failed",
                error_code="MissingFile",
                error_message="上传文件不存在，无法恢复任务",
            )
            execute(
                "UPDATE documents SET status = 'failed', updated_at = ? WHERE id = ?",
                (utc_now(), task["document_id"]),
            )


def _ingestion_worker_loop() -> None:
    while not _worker_stop.is_set():
        try:
            task = _claim_next_ingestion_task()
        except Exception:
            _worker_stop.wait(1)
            continue
        if not task:
            _worker_wakeup.wait(1)
            _worker_wakeup.clear()
            continue
        process_document_task(
            task["task_id"],
            task.get("user_id") or "",
            task.get("knowledge_base_id") or "",
            task.get("document_id") or "",
            task.get("file_path") or "",
        )


def _wake_ingestion_worker() -> None:
    _worker_wakeup.set()


@asynccontextmanager
async def lifespan(_: FastAPI):
    global _worker_thread
    _recover_ingestion_tasks()
    _worker_stop.clear()
    _worker_thread = threading.Thread(
        target=_ingestion_worker_loop,
        name="document-ingestion-worker",
        daemon=True,
    )
    _worker_thread.start()
    _wake_ingestion_worker()
    try:
        yield
    finally:
        _worker_stop.set()
        _worker_wakeup.set()
        _worker_thread.join(timeout=3)
        _worker_thread = None


app = FastAPI(title="Knowledge Base Agent", version="2.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)

auth_scheme = HTTPBearer(auto_error=False)


class RegisterRequest(BaseModel):
    email: str = Field(min_length=3, max_length=255)
    password: str = Field(min_length=8, max_length=128)
    display_name: str = Field(default="", max_length=80)


class LoginRequest(BaseModel):
    email: str
    password: str


class NameRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=500)


class KnowledgeBaseUpdateRequest(BaseModel):
    name: str | None = Field(default=None, max_length=120)
    is_pinned: bool | None = None


class QueryRequest(BaseModel):
    knowledge_base_id: str
    question: str = Field(min_length=1, max_length=4000)
    conversation_id: str | None = None
    history: list[dict[str, Any]] = Field(default_factory=list)
    allow_web: bool = False






def _public_user(user: dict[str, Any]) -> dict[str, Any]:
    return {"id": user["id"], "email": user["email"], "display_name": user["display_name"]}


def _json_list(value: Any) -> list[Any]:
    if not value:
        return []
    try:
        parsed = json.loads(value) if isinstance(value, str) else value
    except (TypeError, ValueError):
        return []
    return parsed if isinstance(parsed, list) else []


def _serialize_chat_message(message: dict[str, Any]) -> dict[str, Any]:
    is_assistant = message.get("role") == "assistant"
    result = {
        "type": "ai" if is_assistant else "user",
        "content": message.get("content") or "",
        "citations": _json_list(message.get("citations_json")),
        "status": message.get("status"),
        "mode": message.get("mode"),
        "usedTools": _json_list(message.get("used_tools_json")),
    }
    if is_assistant:
        projected = select_answer_citations({"answer": result["content"], "status": result["status"]}, result["citations"])
        result.update(content=projected["answer"], citations=projected["citations"])
    return result


def current_user(credentials: HTTPAuthorizationCredentials | None = Depends(auth_scheme)) -> dict[str, Any]:
    if not credentials:
        raise HTTPException(status_code=401, detail="需要登录")
    try:
        payload = decode_access_token(credentials.credentials)
    except ValueError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    user = fetch_one("SELECT * FROM users WHERE id = ?", (payload["sub"],))
    if not user:
        raise HTTPException(status_code=401, detail="用户不存在")
    return user


def _validate_email(email: str) -> str:
    normalized = email.strip().lower()
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", normalized):
        raise HTTPException(status_code=400, detail="邮箱格式不正确")
    return normalized


def _clean_name(value: str, label: str) -> str:
    normalized = value.strip()
    if not normalized:
        raise HTTPException(status_code=400, detail=f"{label}不能为空")
    return normalized


def _unlink_files(*paths: str | Path) -> None:
    """Remove generated files without masking the operation being handled."""
    for raw_path in paths:
        try:
            Path(raw_path).unlink(missing_ok=True)
        except OSError:
            pass


def _space_for_user(space_id: str, user_id: str, write: bool = False) -> dict[str, Any]:
    row = fetch_one(
        """
        SELECT s.*, sm.role FROM spaces s
        JOIN space_members sm ON sm.space_id = s.id
        WHERE s.id = ? AND sm.user_id = ?
        """,
        (space_id, user_id),
    )
    if not row or (write and row["role"] not in {"owner", "editor"}):
        raise HTTPException(status_code=403, detail="没有访问该空间的权限")
    return row


def _kb_for_user(kb_id: str, user_id: str, write: bool = False) -> dict[str, Any]:
    row = fetch_one(
        """
        SELECT kb.*, sm.role, s.name AS space_name
        FROM knowledge_bases kb
        JOIN spaces s ON s.id = kb.space_id
        JOIN space_members sm ON sm.space_id = s.id
        WHERE kb.id = ? AND sm.user_id = ?
        """,
        (kb_id, user_id),
    )
    if not row or (write and row["role"] not in {"owner", "editor"}):
        raise HTTPException(status_code=403, detail="没有访问该知识库的权限")
    return row


def _serialize_document(row: dict[str, Any], include_knowledge: bool = False) -> dict[str, Any]:
    result = dict(row)
    try:
        tags = json.loads(result.pop("tags_json", "[]") or "[]")
    except (TypeError, json.JSONDecodeError):
        tags = []
    if not isinstance(tags, list):
        tags = []
    result["tags"] = list(dict.fromkeys(tag.strip() for tag in tags if isinstance(tag, str) and tag.strip()))[:8]
    try:
        extraction = json.loads(result.pop("extraction_json", "{}") or "{}")
    except (TypeError, json.JSONDecodeError):
        extraction = {}
    result["extraction"] = extraction if isinstance(extraction, dict) else {}
    if include_knowledge:
        raw_knowledge = result.pop("knowledge_json", None)
        try:
            knowledge = json.loads(raw_knowledge or "{}")
        except (TypeError, json.JSONDecodeError):
            knowledge = {}
        result["_knowledge"] = knowledge if isinstance(knowledge, dict) else {}
    else:
        result.pop("knowledge_json", None)
    result.pop("stored_path", None)
    return result


def _update_task(task_id: str, **values: Any) -> None:
    allowed = {"status", "stage", "progress", "stage_done", "stage_total", "active_workers", "json_path", "json_content", "error_code", "error_message"}
    values = {key: value for key, value in values.items() if key in allowed}
    if not values:
        return
    assignments = ", ".join(f"{key} = ?" for key in values)
    params = list(values.values()) + [utc_now(), task_id]
    execute(f"UPDATE tasks SET {assignments}, updated_at = ? WHERE task_id = ?", params)


def _safe_audit(
    user_id: str | None,
    action: str,
    resource_type: str,
    resource_id: str | None,
    payload: dict[str, Any] | None = None,
) -> None:
    try:
        write_audit(user_id, action, resource_type, resource_id, payload)
    except Exception:
        # Audit failures must not turn a completed business operation into a failure.
        pass


def process_document_task(task_id: str, user_id: str, kb_id: str, document_id: str, file_path: str) -> None:
    """Idempotently ingest one document through measurable progress stages."""
    knowledge_path = KNOWLEDGE_DIR / f"{document_id}.json"
    temporary_knowledge_path = knowledge_path.with_suffix(".json.tmp")
    progress_state = {"value": -1, "stage": ""}
    codex_thread_token = llm_service.push_thread_key(f"pdf:{document_id}")

    def set_progress(
        progress: int,
        stage: str,
        *,
        done: int = 0,
        total: int = 0,
        workers: int = 0,
    ) -> None:
        progress = max(0, min(int(progress), 99))
        detail = (int(done), int(total), int(workers))
        if (
            progress == progress_state["value"]
            and stage == progress_state["stage"]
            and detail == progress_state.get("detail")
        ):
            return
        progress_state.update(value=progress, stage=stage, detail=detail)
        _update_task(
            task_id,
            status="processing",
            stage=stage,
            progress=progress,
            stage_done=max(0, int(done)),
            stage_total=max(0, int(total)),
            active_workers=max(0, int(workers)),
        )

    try:
        set_progress(2, "starting")
        document = fetch_one("SELECT * FROM documents WHERE id = ?", (document_id,))
        if not document:
            raise ValueError("文档记录不存在")

        # A recovered task may have stopped after any storage step. Clearing
        # only this document's derived data makes every retry deterministic.
        vector_service.delete_document(kb_id, document_id)
        with get_conn() as conn:
            conn.execute(
                "DELETE FROM chunks_fts WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?)",
                (document_id,),
            )
            conn.execute("DELETE FROM document_versions WHERE document_id = ?", (document_id,))
            conn.execute(
                """
                UPDATE documents
                SET status = 'processing', summary = '', tags_json = '[]',
                    knowledge_json = NULL, page_count = 0, extraction_json = '{}', updated_at = ?
                WHERE id = ?
                """,
                (utc_now(), document_id),
            )
        _unlink_files(knowledge_path, temporary_knowledge_path)

        def on_pdf_progress(done: int, total: int, phase: str) -> None:
            ratio = done / max(total, 1)
            if phase == "inspect":
                set_progress(
                    3 + round(ratio * 7),
                    "inspecting",
                    done=done,
                    total=total,
                    workers=0,
                )
            else:
                set_progress(
                    10 + round(ratio * 20),
                    "extracting",
                    done=done,
                    total=total,
                    workers=min(PDF_VISION_WORKERS, max(total - done, 0)),
                )

        pdf_document = extract_pdf_document(
            file_path,
            vision_extractor=llm_service.extract_visual_page_ephemeral,
            progress_callback=on_pdf_progress,
        )
        set_progress(32, "chunking")
        chunks = split_pages_into_chunks(pdf_document.pages)
        if not chunks:
            raise ValueError("文档没有可索引的文本")
        extraction = {
            "total_pages": pdf_document.total_pages,
            "text_pages": pdf_document.text_pages,
            "vision_pages": pdf_document.vision_pages,
            "blank_pages": pdf_document.blank_pages,
            "warnings": pdf_document.warnings[:50],
        }
        execute(
            "UPDATE documents SET page_count = ?, extraction_json = ?, updated_at = ? WHERE id = ?",
            (
                pdf_document.total_pages,
                json.dumps(extraction, ensure_ascii=False),
                utc_now(),
                document_id,
            ),
        )

        digest = content_hash(chunks)
        duplicate = fetch_one(
            """
            SELECT d.id, d.knowledge_json, d.summary, d.tags_json
            FROM document_versions v JOIN documents d ON d.id = v.document_id
            WHERE d.knowledge_base_id = ? AND v.content_hash = ? AND d.status = 'completed'
            LIMIT 1
            """,
            (kb_id, digest),
        )
        reused_knowledge: dict[str, Any] | None = None
        if duplicate and duplicate.get("knowledge_json"):
            try:
                parsed_knowledge = json.loads(duplicate["knowledge_json"])
            except (TypeError, json.JSONDecodeError):
                parsed_knowledge = None
            if (
                isinstance(parsed_knowledge, dict)
                and isinstance(parsed_knowledge.get("structure"), dict)
                and str(parsed_knowledge.get("summary") or "").strip()
            ):
                reused_knowledge = parsed_knowledge

        version_id = str(uuid.uuid4())
        vector_chunks = []
        now = utc_now()
        with get_conn() as conn:
            conn.execute(
                "INSERT INTO document_versions(id, document_id, version_no, content_hash, created_at) VALUES (?, ?, 1, ?, ?)",
                (version_id, document_id, digest, now),
            )
            for index, chunk in enumerate(chunks):
                chunk_id = f"{document_id}_{version_id}_{index}"
                conn.execute(
                    """
                    INSERT INTO chunks(id, document_version_id, document_id, knowledge_base_id, chunk_index, content, page_start, page_end, heading, metadata_json, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        chunk_id,
                        version_id,
                        document_id,
                        kb_id,
                        index,
                        chunk["text"],
                        chunk["page_start"],
                        chunk["page_end"],
                        chunk.get("heading", ""),
                        json.dumps(
                            {
                                "source_type": "pdf",
                                "extraction_method": chunk.get("extraction_method", "text"),
                                "quality_flags": chunk.get("quality_flags", []),
                            },
                            ensure_ascii=False,
                        ),
                        now,
                    ),
                )
                conn.execute(
                    "INSERT INTO chunks_fts(chunk_id, knowledge_base_id, content, title) VALUES (?, ?, ?, ?)",
                    (chunk_id, kb_id, chunk["text"], document["title"]),
                )
                vector_chunks.append(
                    {
                        "id": chunk_id,
                        "document_id": document_id,
                        "title": document["title"],
                        **chunk,
                    }
                )

        set_progress(38, "indexing")

        def on_embedding_progress(done: int, total: int) -> None:
            set_progress(
                38 + round((done / max(total, 1)) * 35),
                "indexing",
                done=done,
                total=total,
                workers=0,
            )

        # Ingestion runs outside the HTTP context. Resolve its persisted,
        # authenticated RAG user and verify document access before Mac routing.
        with owner_context(owner_for_ingestion(user_id, kb_id, document_id)):
            vector_service.add_chunks(kb_id, vector_chunks, progress_callback=on_embedding_progress)
        set_progress(76, "mapping")

        def on_knowledge_progress(done: int, total: int) -> None:
            set_progress(
                76 + round((done / max(total, 1)) * 18),
                "mapping",
                done=done,
                total=total,
                workers=min(KNOWLEDGE_WORKERS, max(total - done, 0)),
            )

        context = build_knowledge_context(chunks)
        if reused_knowledge is not None:
            knowledge = reused_knowledge
            on_knowledge_progress(1, 1)
        else:
            knowledge = llm_service.generate_knowledge(
                context,
                document["title"],
                progress_callback=on_knowledge_progress,
            )
        set_progress(95, "saving")
        summary = str(knowledge["summary"]).strip()[:1200]
        tags = knowledge.get("tags", [])
        temporary_knowledge_path.write_text(
            json.dumps(knowledge, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        temporary_knowledge_path.replace(knowledge_path)

        execute(
            """
            UPDATE documents SET status = 'completed', summary = ?, tags_json = ?, knowledge_json = ?, updated_at = ?
            WHERE id = ?
            """,
            (summary, json.dumps(tags, ensure_ascii=False), json.dumps(knowledge, ensure_ascii=False), utc_now(), document_id),
        )
        _update_task(
            task_id,
            status="completed",
            stage="completed",
            progress=100,
            json_path=str(knowledge_path),
            json_content=json.dumps(knowledge, ensure_ascii=False),
        )
        audit_action = "document.duplicate.detected" if duplicate else "document.ingested"
        audit_payload = {
            "chunks": len(chunks),
            "pages": pdf_document.total_pages,
            "vision_pages": pdf_document.vision_pages,
        }
        if duplicate:
            audit_payload.update({"duplicate_of": duplicate["id"], "indexed_as_new_document": True})
        _safe_audit(
            user_id,
            audit_action,
            "document",
            document_id,
            audit_payload,
        )
    except Exception as exc:
        # Each cleanup operation is best-effort and independent. A failed vector
        # deletion must not prevent SQLite rows, task status, or the cache file
        # from being cleaned up and reported to the user.
        try:
            vector_service.delete_document(kb_id, document_id)
        except Exception:
            pass
        try:
            with get_conn() as conn:
                conn.execute(
                    "DELETE FROM chunks_fts WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?)",
                    (document_id,),
                )
                conn.execute("DELETE FROM document_versions WHERE document_id = ?", (document_id,))
        except Exception:
            pass
        _unlink_files(temporary_knowledge_path, knowledge_path)
        try:
            execute("UPDATE documents SET status = 'failed', updated_at = ? WHERE id = ?", (utc_now(), document_id))
        except Exception:
            pass
        try:
            _update_task(
                task_id,
                status="failed",
                stage="failed",
                error_code=type(exc).__name__,
                error_message=str(exc)[:1000],
            )
        except Exception:
            pass
        _safe_audit(user_id, "document.ingestion.failed", "document", document_id, {"error": str(exc)})
    finally:
        llm_service.pop_thread_key(codex_thread_token)


async def _save_pdf_upload(file: UploadFile) -> tuple[str, str]:
    filename = Path(file.filename or "document.pdf").name
    if not filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=415, detail="目前只支持 PDF 文件")
    stored_path = UPLOAD_DIR / f"{uuid.uuid4()}.pdf"
    total = 0
    first_bytes = b""
    try:
        with stored_path.open("wb") as output:
            while True:
                block = await file.read(1024 * 1024)
                if not block:
                    break
                if len(first_bytes) < 1024:
                    first_bytes += block[: 1024 - len(first_bytes)]
                total += len(block)
                if total > MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail=f"文件不能超过 {MAX_UPLOAD_BYTES // (1024 * 1024)} MB")
                output.write(block)
    except Exception:
        _unlink_files(stored_path)
        raise
    if b"%PDF-" not in first_bytes[:1024]:
        _unlink_files(stored_path)
        raise HTTPException(status_code=415, detail="文件不是有效的 PDF")
    return filename, str(stored_path)


async def _create_document_upload(
    kb: dict[str, Any], user: dict[str, Any], file: UploadFile
) -> dict[str, Any]:
    filename, file_path = await _save_pdf_upload(file)
    document_id = str(uuid.uuid4())
    task_id = str(uuid.uuid4())
    now = utc_now()
    title = Path(filename).stem[:180] or "未命名文档"
    try:
        with get_conn() as conn:
            conn.execute(
                """
                INSERT INTO documents(id, knowledge_base_id, title, filename, stored_path, mime_type, status, created_by, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)
                """,
                (document_id, kb["id"], title, filename, file_path, file.content_type or "application/pdf", user["id"], now, now),
            )
            conn.execute(
                """
                INSERT INTO tasks(task_id, task_type, user_id, knowledge_base_id, document_id, domain, file_path, status, progress, stage, created_at, updated_at)
                VALUES (?, 'document_ingestion', ?, ?, ?, ?, ?, 'queued', 0, 'queued', ?, ?)
                """,
                (task_id, user["id"], kb["id"], document_id, kb["name"], file_path, now, now),
            )
    except Exception:
        _unlink_files(file_path)
        raise
    _wake_ingestion_worker()
    _safe_audit(user["id"], "document.uploaded", "document", document_id, {"knowledge_base_id": kb["id"], "filename": filename})
    return {"task_id": task_id, "document_id": document_id, "knowledge_base_id": kb["id"], "status": "queued"}


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "knowledge-base-agent"}


@app.post("/api/auth/register", status_code=201)
async def register(payload: RegisterRequest) -> dict[str, Any]:
    email = _validate_email(payload.email)
    try:
        user = create_user(email, payload.display_name, hash_password(payload.password))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        if "UNIQUE" in str(exc).upper():
            raise HTTPException(status_code=409, detail="邮箱已经注册") from exc
        raise
    space = create_space_for_user(user["id"])
    token = create_access_token(user["id"], user["email"], user["display_name"])
    _safe_audit(user["id"], "auth.registered", "user", user["id"], {})
    return {"access_token": token, "token_type": "bearer", "user": _public_user(user), "space": space}


@app.post("/api/auth/login")
async def login(payload: LoginRequest) -> dict[str, Any]:
    user = fetch_one("SELECT * FROM users WHERE email = ?", (_validate_email(payload.email),))
    if not user or not verify_password(payload.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="邮箱或密码错误")
    token = create_access_token(user["id"], user["email"], user["display_name"])
    return {"access_token": token, "token_type": "bearer", "user": _public_user(user)}


@app.get("/api/auth/me")
async def me(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return {"user": _public_user(user)}


@app.get("/api/spaces")
async def list_spaces(user: dict[str, Any] = Depends(current_user)) -> list[dict[str, Any]]:
    spaces = fetch_all(
        """
        SELECT s.*, sm.role, COUNT(kb.id) AS knowledge_base_count
        FROM spaces s JOIN space_members sm ON sm.space_id = s.id
        LEFT JOIN knowledge_bases kb ON kb.space_id = s.id
        WHERE sm.user_id = ? GROUP BY s.id ORDER BY s.created_at
        """,
        (user["id"],),
    )
    return spaces


@app.post("/api/spaces", status_code=201)
async def create_space(payload: NameRequest, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    name = _clean_name(payload.name, "空间名称")
    space = create_space_for_user(user["id"], name)
    _safe_audit(user["id"], "space.created", "space", space["id"], {"name": name})
    return space


def _knowledge_base_name_exists(space_id: str, name: str, exclude_id: str | None = None) -> bool:
    wanted = name.strip().casefold()
    for row in fetch_all("SELECT id, name FROM knowledge_bases WHERE space_id = ?", (space_id,)):
        if exclude_id and row["id"] == exclude_id:
            continue
        if str(row["name"] or "").strip().casefold() == wanted:
            return True
    return False


@app.get("/api/spaces/{space_id}/knowledge-bases")
async def list_knowledge_bases(space_id: str, user: dict[str, Any] = Depends(current_user)) -> list[dict[str, Any]]:
    _space_for_user(space_id, user["id"])
    return fetch_all(
        "SELECT * FROM knowledge_bases WHERE space_id = ? ORDER BY is_pinned DESC, updated_at DESC, created_at DESC",
        (space_id,),
    )


@app.post("/api/spaces/{space_id}/knowledge-bases", status_code=201)
async def create_knowledge_base(
    space_id: str, payload: NameRequest, user: dict[str, Any] = Depends(current_user)
) -> dict[str, Any]:
    _space_for_user(space_id, user["id"], write=True)
    name = _clean_name(payload.name, "知识库名称")
    if _knowledge_base_name_exists(space_id, name):
        raise HTTPException(status_code=409, detail="知识库名称已存在")
    kb_id, now = str(uuid.uuid4()), utc_now()
    try:
        execute(
            "INSERT INTO knowledge_bases(id, space_id, name, description, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (kb_id, space_id, name, payload.description, user["id"], now, now),
        )
    except Exception as exc:
        if "UNIQUE" in str(exc).upper():
            raise HTTPException(status_code=409, detail="该空间中已经存在同名知识库") from exc
        raise
    _safe_audit(user["id"], "knowledge_base.created", "knowledge_base", kb_id, {"name": name})
    return fetch_one("SELECT * FROM knowledge_bases WHERE id = ?", (kb_id,)) or {}


@app.patch("/api/knowledge-bases/{kb_id}")
async def update_knowledge_base(
    kb_id: str,
    payload: KnowledgeBaseUpdateRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    knowledge_base = _kb_for_user(kb_id, user["id"], write=True)
    updates: list[str] = []
    params: list[Any] = []
    audit_payload: dict[str, Any] = {}

    if payload.name is not None:
        name = _clean_name(payload.name, "知识库名称")
        if name != knowledge_base["name"]:
            if _knowledge_base_name_exists(knowledge_base["space_id"], name, exclude_id=kb_id):
                raise HTTPException(status_code=409, detail="知识库名称已存在")
            updates.append("name = ?")
            params.append(name)
            audit_payload["name"] = name

    if payload.is_pinned is not None:
        is_pinned = int(payload.is_pinned)
        if is_pinned != int(knowledge_base.get("is_pinned") or 0):
            updates.append("is_pinned = ?")
            params.append(is_pinned)
            audit_payload["is_pinned"] = bool(is_pinned)

    if not updates:
        return knowledge_base

    updates.append("updated_at = ?")
    params.extend([utc_now(), kb_id])
    try:
        execute(f"UPDATE knowledge_bases SET {', '.join(updates)} WHERE id = ?", params)
    except Exception as exc:
        if "UNIQUE" in str(exc).upper():
            raise HTTPException(status_code=409, detail="该空间中已经存在同名知识库") from exc
        raise

    _safe_audit(user["id"], "knowledge_base.updated", "knowledge_base", kb_id, audit_payload)
    return fetch_one("SELECT * FROM knowledge_bases WHERE id = ?", (kb_id,)) or {}


@app.delete("/api/knowledge-bases/{kb_id}")
async def delete_knowledge_base(kb_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    knowledge_base = _kb_for_user(kb_id, user["id"], write=True)
    processing = fetch_one(
        "SELECT COUNT(*) AS count FROM documents WHERE knowledge_base_id = ? AND status IN ('queued', 'processing')",
        (kb_id,),
    )
    if processing and int(processing["count"]) > 0:
        raise HTTPException(status_code=409, detail="知识库中有文档正在处理或排队，请完成后再删除")

    documents = fetch_all(
        "SELECT id, stored_path FROM documents WHERE knowledge_base_id = ?",
        (kb_id,),
    )
    try:
        vector_service.delete_knowledge_base(kb_id)
    except Exception as exc:
        raise HTTPException(status_code=503, detail="向量索引清理暂时失败，知识库未删除，请稍后重试。") from exc

    with get_conn() as conn:
        conn.execute("DELETE FROM chunks_fts WHERE knowledge_base_id = ?", (kb_id,))
        conn.execute("DELETE FROM tasks WHERE knowledge_base_id = ?", (kb_id,))
        conn.execute("DELETE FROM agent_runs WHERE knowledge_base_id = ?", (kb_id,))
        conn.execute("DELETE FROM knowledge_bases WHERE id = ?", (kb_id,))

    for document in documents:
        _unlink_files(Path(document["stored_path"]), KNOWLEDGE_DIR / f"{document['id']}.json")

    _safe_audit(user["id"], "knowledge_base.deleted", "knowledge_base", kb_id, {"documents": len(documents), "name": knowledge_base["name"]})
    return {"knowledge_base_id": kb_id, "status": "deleted"}


@app.get("/api/knowledge-bases/{kb_id}/documents")
async def list_documents(kb_id: str, user: dict[str, Any] = Depends(current_user)) -> list[dict[str, Any]]:
    _kb_for_user(kb_id, user["id"])
    rows = fetch_all("SELECT * FROM documents WHERE knowledge_base_id = ? ORDER BY updated_at DESC", (kb_id,))
    return [_serialize_document(row) for row in rows]


@app.post("/api/knowledge-bases/{kb_id}/documents", status_code=202)
async def upload_document(
    kb_id: str,
    file: UploadFile = File(...),
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    kb = _kb_for_user(kb_id, user["id"], write=True)
    return await _create_document_upload(kb, user, file)


@app.get("/api/documents/{document_id}")
async def get_document(document_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    document = fetch_one("SELECT * FROM documents WHERE id = ?", (document_id,))
    if not document:
        raise HTTPException(status_code=404, detail="文档不存在")
    _kb_for_user(document["knowledge_base_id"], user["id"])
    result = _serialize_document(document)
    result["chunks"] = fetch_all(
        "SELECT id, content, page_start, page_end, heading FROM chunks WHERE document_id = ? ORDER BY chunk_index",
        (document_id,),
    )
    return result


@app.delete("/api/documents/{document_id}")
async def delete_document(document_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    document = fetch_one("SELECT * FROM documents WHERE id = ?", (document_id,))
    if not document:
        raise HTTPException(status_code=404, detail="文档不存在")
    _kb_for_user(document["knowledge_base_id"], user["id"], write=True)
    if document["status"] in {"queued", "processing"}:
        raise HTTPException(status_code=409, detail="文档正在处理或排队，请完成后再删除")

    try:
        vector_service.delete_document(document["knowledge_base_id"], document_id)
    except Exception as exc:
        raise HTTPException(status_code=503, detail="向量索引清理暂时失败，文档未删除，请稍后重试。") from exc

    stored_path = Path(document["stored_path"])
    knowledge_path = KNOWLEDGE_DIR / f"{document_id}.json"
    with get_conn() as conn:
        conn.execute(
            "DELETE FROM chunks_fts WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?)",
            (document_id,),
        )
        conn.execute("DELETE FROM tasks WHERE document_id = ?", (document_id,))
        conn.execute("DELETE FROM documents WHERE id = ?", (document_id,))

    _unlink_files(stored_path, knowledge_path)

    _safe_audit(user["id"], "document.deleted", "document", document_id, {"knowledge_base_id": document["knowledge_base_id"]})
    return {"document_id": document_id, "status": "deleted"}


@app.get("/api/knowledge-bases/{kb_id}/knowledge")
async def get_knowledge_graph(kb_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    kb = _kb_for_user(kb_id, user["id"])
    documents = [
        _serialize_document(row, include_knowledge=True)
        for row in fetch_all(
            "SELECT * FROM documents WHERE knowledge_base_id = ? AND status = 'completed' ORDER BY created_at, id",
            (kb_id,),
        )
    ]
    return await run_in_threadpool(build_knowledge_graph, kb, documents)


def _serialize_task(task: dict[str, Any]) -> dict[str, Any]:
    queue_ahead = 0
    if task.get("status") == "queued":
        row = fetch_one(
            """
            SELECT COUNT(*) AS count
            FROM tasks
            WHERE task_type = 'document_ingestion'
              AND (
                status = 'processing'
                OR (
                  status = 'queued'
                  AND (created_at < ? OR (created_at = ? AND id < ?))
                )
              )
            """,
            (task.get("created_at"), task.get("created_at"), task.get("id")),
        )
        queue_ahead = int((row or {}).get("count") or 0)

    return {
        "task_id": task["task_id"],
        "document_id": task.get("document_id"),
        "knowledge_base_id": task.get("knowledge_base_id"),
        "status": task["status"],
        "stage": task.get("stage") or task["status"],
        "progress": task.get("progress") or 0,
        "stage_done": task.get("stage_done") or 0,
        "stage_total": task.get("stage_total") or 0,
        "active_workers": task.get("active_workers") or 0,
        "queue_ahead": queue_ahead,
        "error": task.get("error_message"),
        "updated_at": task.get("updated_at"),
    }


@app.get("/api/knowledge-bases/{kb_id}/tasks/active")
async def get_active_task(
    kb_id: str, user: dict[str, Any] = Depends(current_user)
) -> dict[str, Any] | None:
    _kb_for_user(kb_id, user["id"])
    task = fetch_one(
        """
        SELECT * FROM tasks
        WHERE knowledge_base_id = ? AND status IN ('queued', 'processing')
        ORDER BY id DESC LIMIT 1
        """,
        (kb_id,),
    )
    return _serialize_task(task) if task else None


@app.get("/api/tasks/active")
async def get_user_active_task(
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any] | None:
    task = fetch_one(
        """
        SELECT * FROM tasks
        WHERE user_id = ? AND status IN ('queued', 'processing')
        ORDER BY id DESC LIMIT 1
        """,
        (user["id"],),
    )
    return _serialize_task(task) if task else None


@app.get("/api/tasks/{task_id}")
async def get_task(task_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    task = fetch_one("SELECT * FROM tasks WHERE task_id = ?", (task_id,))
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")
    if task.get("knowledge_base_id"):
        _kb_for_user(task["knowledge_base_id"], user["id"])
    elif task.get("user_id") != user["id"]:
        raise HTTPException(status_code=403, detail="没有访问该任务的权限")
    return _serialize_task(task)


@app.get("/api/chat/history")
async def get_chat_history(knowledge_base_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    _kb_for_user(knowledge_base_id, user["id"])
    conversation = fetch_one(
        """
        SELECT id FROM chat_conversations
        WHERE user_id = ? AND knowledge_base_id = ?
        """,
        (user["id"], knowledge_base_id),
    )
    if not conversation:
        return {"conversation_id": None, "messages": []}
    messages = list_chat_messages(conversation["id"])
    return {
        "conversation_id": conversation["id"],
        "messages": [_serialize_chat_message(message) for message in messages],
    }


@app.delete("/api/chat/history")
async def delete_chat_history(knowledge_base_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    _kb_for_user(knowledge_base_id, user["id"])
    conversation = fetch_one(
        """
        SELECT id FROM chat_conversations
        WHERE user_id = ? AND knowledge_base_id = ?
        """,
        (user["id"], knowledge_base_id),
    )
    if conversation:
        clear_chat_messages(conversation["id"])
    return {"conversation_id": conversation["id"] if conversation else None, "messages": []}


@app.post("/api/query")
async def query(payload: QueryRequest, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    question = payload.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="问题不能为空")
    _kb_for_user(payload.knowledge_base_id, user["id"])
    conversation = get_or_create_chat_conversation(
        user["id"], payload.knowledge_base_id, payload.conversation_id
    )
    run_id = agent_service.create_run(
        user["id"],
        payload.knowledge_base_id,
        "query",
        {"question": question, "conversation_id": conversation["id"], "allow_web": payload.allow_web},
    )
    try:
        result = await run_in_threadpool(
            agent_service.run_query, run_id, question, payload.history, payload.allow_web
        )
    except DeepSeekError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except EmbeddingError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=503, detail="问答服务暂时不可用，请稍后重试") from exc
    append_chat_turn(
        conversation["id"],
        question,
        result.get("answer") or "没有生成回答。",
        result.get("citations") or [],
        result.get("status"),
        result.get("mode"),
        result.get("used_tools") or [],
    )
    return {"run_id": run_id, "conversation_id": conversation["id"], "question": question, **result}

@app.get("/api/audit-logs")
async def list_audit_logs(limit: int = 100, user: dict[str, Any] = Depends(current_user)) -> list[dict[str, Any]]:
    limit = max(1, min(limit, 200))
    return fetch_all(
        """
        SELECT id, action, resource_type, resource_id, payload_json, created_at
        FROM audit_logs WHERE user_id = ? ORDER BY id DESC LIMIT ?
        """,
        (user["id"], limit),
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8001, reload=False)
