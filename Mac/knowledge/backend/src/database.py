"""SQLite persistence and small query helpers.

SQLite stores business metadata and audit information. Chroma stores only the
vector index; every vector is linked back to a chunk in this database.
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, Iterable

from config import DB_PATH, ensure_runtime_dirs


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


@contextmanager
def get_conn():
    ensure_runtime_dirs()
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def _ensure_columns(conn: sqlite3.Connection, table: str, columns: dict[str, str]) -> None:
    existing = _columns(conn, table)
    for name, definition in columns.items():
        if name not in existing:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {definition}")


def init_db() -> None:
    with get_conn() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                email TEXT NOT NULL UNIQUE COLLATE NOCASE,
                display_name TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS spaces (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                owner_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS space_members (
                space_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'viewer',
                created_at TEXT NOT NULL,
                PRIMARY KEY(space_id, user_id),
                FOREIGN KEY(space_id) REFERENCES spaces(id) ON DELETE CASCADE,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS knowledge_bases (
                id TEXT PRIMARY KEY,
                space_id TEXT NOT NULL,
                name TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                is_pinned INTEGER NOT NULL DEFAULT 0,
                created_by TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(space_id, name),
                FOREIGN KEY(space_id) REFERENCES spaces(id) ON DELETE CASCADE,
                FOREIGN KEY(created_by) REFERENCES users(id)
            );

            CREATE TABLE IF NOT EXISTS documents (
                id TEXT PRIMARY KEY,
                knowledge_base_id TEXT NOT NULL,
                title TEXT NOT NULL,
                filename TEXT NOT NULL,
                stored_path TEXT NOT NULL,
                mime_type TEXT NOT NULL DEFAULT 'application/pdf',
                source_type TEXT NOT NULL DEFAULT 'pdf',
                status TEXT NOT NULL DEFAULT 'processing',
                page_count INTEGER NOT NULL DEFAULT 0,
                extraction_json TEXT NOT NULL DEFAULT '{}',
                summary TEXT NOT NULL DEFAULT '',
                tags_json TEXT NOT NULL DEFAULT '[]',
                knowledge_json TEXT,
                created_by TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(knowledge_base_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE,
                FOREIGN KEY(created_by) REFERENCES users(id)
            );

            CREATE TABLE IF NOT EXISTS document_versions (
                id TEXT PRIMARY KEY,
                document_id TEXT NOT NULL,
                version_no INTEGER NOT NULL,
                content_hash TEXT NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE(document_id, version_no),
                FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS chunks (
                id TEXT PRIMARY KEY,
                document_version_id TEXT NOT NULL,
                document_id TEXT NOT NULL,
                knowledge_base_id TEXT NOT NULL,
                chunk_index INTEGER NOT NULL,
                content TEXT NOT NULL,
                page_start INTEGER,
                page_end INTEGER,
                heading TEXT NOT NULL DEFAULT '',
                metadata_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                UNIQUE(document_version_id, chunk_index),
                FOREIGN KEY(document_version_id) REFERENCES document_versions(id) ON DELETE CASCADE,
                FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE,
                FOREIGN KEY(knowledge_base_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id TEXT UNIQUE NOT NULL,
                task_type TEXT NOT NULL DEFAULT 'document_ingestion',
                user_id TEXT,
                knowledge_base_id TEXT,
                document_id TEXT,
                domain TEXT,
                file_path TEXT,
                status TEXT NOT NULL DEFAULT 'queued',
                progress INTEGER NOT NULL DEFAULT 0,
                stage TEXT NOT NULL DEFAULT 'queued',
                stage_done INTEGER NOT NULL DEFAULT 0,
                stage_total INTEGER NOT NULL DEFAULT 0,
                active_workers INTEGER NOT NULL DEFAULT 0,
                attempts INTEGER NOT NULL DEFAULT 0,
                json_path TEXT,
                json_content TEXT,
                error_code TEXT,
                error_message TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS agent_runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id TEXT UNIQUE NOT NULL,
                user_id TEXT NOT NULL,
                knowledge_base_id TEXT NOT NULL,
                action TEXT NOT NULL,
                state TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'running',
                input_json TEXT NOT NULL DEFAULT '{}',
                output_json TEXT,
                error_message TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(id),
                FOREIGN KEY(knowledge_base_id) REFERENCES knowledge_bases(id)
            );

            CREATE TABLE IF NOT EXISTS chat_conversations (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                knowledge_base_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(user_id, knowledge_base_id),
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY(knowledge_base_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS chat_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id TEXT NOT NULL,
                role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
                content TEXT NOT NULL,
                citations_json TEXT NOT NULL DEFAULT '[]',
                status TEXT,
                mode TEXT,
                used_tools_json TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL,
                FOREIGN KEY(conversation_id) REFERENCES chat_conversations(id) ON DELETE CASCADE
            );


            CREATE TABLE IF NOT EXISTS audit_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT,
                action TEXT NOT NULL,
                resource_type TEXT NOT NULL,
                resource_id TEXT,
                payload_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(id)
            );

            """
        )

        # Migrate databases created by the original prototype in place.
        _ensure_columns(
            conn,
            "tasks",
            {
                "task_type": "TEXT NOT NULL DEFAULT 'document_ingestion'",
                "user_id": "TEXT",
                "knowledge_base_id": "TEXT",
                "document_id": "TEXT",
                "progress": "INTEGER NOT NULL DEFAULT 0",
                "stage": "TEXT NOT NULL DEFAULT 'queued'",
                "stage_done": "INTEGER NOT NULL DEFAULT 0",
                "stage_total": "INTEGER NOT NULL DEFAULT 0",
                "active_workers": "INTEGER NOT NULL DEFAULT 0",
                "attempts": "INTEGER NOT NULL DEFAULT 0",
                "error_code": "TEXT",
                "updated_at": "TEXT",
            },
        )
        _ensure_columns(
            conn,
            "documents",
            {
                "page_count": "INTEGER NOT NULL DEFAULT 0",
                "extraction_json": "TEXT NOT NULL DEFAULT '{}'",
            },
        )
        _ensure_columns(
            conn,
            "knowledge_bases",
            {
                "is_pinned": "INTEGER NOT NULL DEFAULT 0",
            },
        )
        # Create indexes after the in-place migration so legacy databases
        # can receive columns before indexes reference them.
        conn.executescript(
            """
            CREATE INDEX IF NOT EXISTS idx_space_members_user ON space_members(user_id);
            CREATE INDEX IF NOT EXISTS idx_kb_space ON knowledge_bases(space_id);
            CREATE INDEX IF NOT EXISTS idx_documents_kb ON documents(knowledge_base_id, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_chunks_kb ON chunks(knowledge_base_id);
            CREATE INDEX IF NOT EXISTS idx_tasks_kb ON tasks(knowledge_base_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_chat_conversations_user_kb ON chat_conversations(user_id, knowledge_base_id);
            CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation ON chat_messages(conversation_id, id);
            """
        )
        conn.execute(
            """
            CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts
            USING fts5(chunk_id UNINDEXED, knowledge_base_id UNINDEXED, content, title)
            """
        )


def fetch_one(sql: str, params: Iterable[Any] = ()) -> dict[str, Any] | None:
    with get_conn() as conn:
        row = conn.execute(sql, tuple(params)).fetchone()
        return dict(row) if row else None


def fetch_all(sql: str, params: Iterable[Any] = ()) -> list[dict[str, Any]]:
    with get_conn() as conn:
        return [dict(row) for row in conn.execute(sql, tuple(params)).fetchall()]


def execute(sql: str, params: Iterable[Any] = ()) -> int:
    with get_conn() as conn:
        cursor = conn.execute(sql, tuple(params))
        return cursor.lastrowid


def get_or_create_chat_conversation(
    user_id: str,
    knowledge_base_id: str,
    conversation_id: str | None = None,
) -> dict[str, Any]:
    """Return the user's single persistent conversation for one knowledge base."""
    with get_conn() as conn:
        row = None
        if conversation_id:
            row = conn.execute(
                """
                SELECT * FROM chat_conversations
                WHERE id = ? AND user_id = ? AND knowledge_base_id = ?
                """,
                (conversation_id, user_id, knowledge_base_id),
            ).fetchone()
        if row is None:
            row = conn.execute(
                """
                SELECT * FROM chat_conversations
                WHERE user_id = ? AND knowledge_base_id = ?
                """,
                (user_id, knowledge_base_id),
            ).fetchone()
        if row is None:
            now = utc_now()
            new_id = str(uuid.uuid4())
            conn.execute(
                """
                INSERT OR IGNORE INTO chat_conversations(id, user_id, knowledge_base_id, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (new_id, user_id, knowledge_base_id, now, now),
            )
            row = conn.execute("SELECT * FROM chat_conversations WHERE id = ?", (new_id,)).fetchone()
            if row is None:
                row = conn.execute(
                    """
                    SELECT * FROM chat_conversations
                    WHERE user_id = ? AND knowledge_base_id = ?
                    """,
                    (user_id, knowledge_base_id),
                ).fetchone()
        return dict(row)


def list_chat_messages(conversation_id: str, limit: int = 200) -> list[dict[str, Any]]:
    safe_limit = max(1, min(int(limit), 500))
    rows = fetch_all(
        """
        SELECT id, conversation_id, role, content, citations_json, status, mode, used_tools_json, created_at
        FROM chat_messages
        WHERE conversation_id = ?
        ORDER BY id DESC
        LIMIT ?
        """,
        (conversation_id, safe_limit),
    )
    return list(reversed(rows))


def append_chat_turn(
    conversation_id: str,
    question: str,
    answer: str,
    citations: list[dict[str, Any]] | None = None,
    status: str | None = None,
    mode: str | None = None,
    used_tools: list[str] | None = None,
) -> None:
    now = utc_now()
    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO chat_messages(conversation_id, role, content, citations_json, created_at)
            VALUES (?, 'user', ?, '[]', ?)
            """,
            (conversation_id, question.strip(), now),
        )
        conn.execute(
            """
            INSERT INTO chat_messages(
                conversation_id, role, content, citations_json, status, mode, used_tools_json, created_at
            )
            VALUES (?, 'assistant', ?, ?, ?, ?, ?, ?)
            """,
            (
                conversation_id,
                answer,
                json.dumps(citations or [], ensure_ascii=False),
                status,
                mode,
                json.dumps(used_tools or [], ensure_ascii=False),
                now,
            ),
        )
        conn.execute(
            "UPDATE chat_conversations SET updated_at = ? WHERE id = ?",
            (now, conversation_id),
        )


def clear_chat_messages(conversation_id: str) -> None:
    with get_conn() as conn:
        conn.execute("DELETE FROM chat_messages WHERE conversation_id = ?", (conversation_id,))
        conn.execute(
            "UPDATE chat_conversations SET updated_at = ? WHERE id = ?",
            (utc_now(), conversation_id),
        )


def write_audit(
    user_id: str | None,
    action: str,
    resource_type: str,
    resource_id: str | None,
    payload: dict[str, Any] | None = None,
) -> None:
    execute(
        """
        INSERT INTO audit_logs(user_id, action, resource_type, resource_id, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (user_id, action, resource_type, resource_id, json.dumps(payload or {}, ensure_ascii=False), utc_now()),
    )


def create_user(email: str, display_name: str, password_hash: str) -> dict[str, Any]:
    user_id = str(uuid.uuid4())
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO users(id, email, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
            (user_id, email.strip().lower(), display_name.strip() or email.split("@")[0], password_hash, utc_now()),
        )
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    return dict(row)


def create_space_for_user(user_id: str, name: str = "个人空间") -> dict[str, Any]:
    """Create the private API container without inventing a knowledge base.

    Knowledge bases are user-facing objects, so creating one remains an
    explicit user action. The space stays an internal ownership boundary until
    collaboration is exposed in the product.
    """
    now = utc_now()
    space_id = str(uuid.uuid4())
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO spaces(id, name, owner_id, created_at) VALUES (?, ?, ?, ?)",
            (space_id, name.strip() or "个人空间", user_id, now),
        )
        conn.execute(
            "INSERT INTO space_members(space_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)",
            (space_id, user_id, now),
        )
        row = conn.execute("SELECT * FROM spaces WHERE id = ?", (space_id,)).fetchone()
    return dict(row)
