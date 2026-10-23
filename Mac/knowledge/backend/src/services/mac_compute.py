"""Route only a trusted ShiYan owner's Qwen vector work to their Mac."""

from __future__ import annotations

import hashlib
import json
import math
import os
import stat
import sys
import time
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path
from typing import Callable

# The knowledge service has its own import root and Python environment.
for _parent in Path(__file__).resolve().parents:
    if (_parent / "shared" / "paths.py").is_file():
        if str(_parent) not in sys.path:
            sys.path.insert(0, str(_parent))
        break


class MacEmbeddingError(RuntimeError):
    """Safe failure; a bound owner's job must never fall back to server CPU."""


_trusted_owner: ContextVar[str | None] = ContextVar("shiyan_rag_compute_owner", default=None)
_owner_user_map: dict[str, str] = {}


def configure_owner_mapping(mapping: dict[str, str]) -> None:
    """Called only by the authenticated, private OwnerBridge at startup."""
    global _owner_user_map
    _owner_user_map = dict(mapping)


@contextmanager
def owner_context(owner: str | None):
    token = _trusted_owner.set(owner)
    try:
        yield
    finally:
        _trusted_owner.reset(token)


def _client_type():
    from shared.compute.client import MacComputeClient
    return MacComputeClient


def _configured_owners() -> list[str]:
    path = os.environ.get("SHIYAN_MAC_COMPUTE_CONFIG", "")
    if not path:
        return []
    try:
        config_path = Path(path).expanduser()
        if stat.S_IMODE(config_path.stat().st_mode) & 0o077:
            raise ValueError("private config required")
        config = json.loads(config_path.read_text(encoding="utf-8"))
        owners = config.get("owners")
        if not isinstance(owners, list) or any(not isinstance(owner, str) or not owner for owner in owners):
            raise ValueError("invalid owner binding")
        return owners
    except (OSError, ValueError, TypeError) as error:
        raise MacEmbeddingError("Mac 向量计算配置不可用，请联系管理员。") from error


def owner_for_ingestion(user_id: str, knowledge_base_id: str, document_id: str) -> str | None:
    """Resolve a persisted task's RAG user, never a client-supplied owner field."""
    candidates = []
    for owner in _configured_owners():
        mapped_user = _owner_user_map.get(owner) or (
            "shiyan-" + hashlib.sha256(owner.encode("utf-8")).hexdigest()[:40]
        )
        if mapped_user == user_id:
            candidates.append(owner)
    if not candidates:
        return None
    if len(candidates) != 1:
        raise MacEmbeddingError("知识库账号的 Mac 计算授权不明确。")

    # Validate the server-owned persisted task against its document and current
    # membership before sending any text to an authorized device.
    from database import fetch_one
    document = fetch_one(
        """
        SELECT d.id FROM documents d
        JOIN knowledge_bases kb ON kb.id = d.knowledge_base_id
        JOIN space_members sm ON sm.space_id = kb.space_id
        WHERE d.id = ? AND kb.id = ? AND d.created_by = ?
          AND sm.user_id = ? AND sm.role IN ('owner', 'editor')
        """,
        (document_id, knowledge_base_id, user_id, user_id),
    )
    if not document:
        raise MacEmbeddingError("文档的 Mac 计算授权已失效。")
    return candidates[0]


def current_mac_owner() -> str | None:
    owner = _trusted_owner.get()
    if not owner or not os.environ.get("SHIYAN_MAC_COMPUTE_CONFIG"):
        return None
    try:
        return owner if _client_type().enabled_for(owner) else None
    except Exception as error:
        raise MacEmbeddingError("Mac 向量计算配置不可用，请联系管理员。") from error


def _batches(texts: list[str]):
    batch: list[str] = []
    characters = 0
    for text in texts:
        if len(text) > 16384:
            raise MacEmbeddingError("单个向量文本块过长，无法提交到 Mac。")
        if batch and (len(batch) == 8 or characters + len(text) > 65536):
            yield batch
            batch, characters = [], 0
        batch.append(text)
        characters += len(text)
    if batch:
        yield batch


def embed_on_mac(
    owner: str,
    texts: list[str],
    operation: str,
    instruction: str,
    progress_callback: Callable[[int, int], None] | None = None,
) -> list[list[float]]:
    """Use the existing Qwen model, instruction, dimensions and token pooling."""
    task_id = None
    client = None
    try:
        client = _client_type()()
        total = len(texts)
        embeddings: list[list[float]] = []
        if progress_callback:
            progress_callback(0, total)
        for batch in _batches(texts):
            fingerprint = json.dumps(
                {"texts": batch, "operation": operation, "instruction": instruction},
                ensure_ascii=False, sort_keys=True, separators=(",", ":"),
            )
            request_id = "rag-qwen-" + hashlib.sha256(fingerprint.encode("utf-8")).hexdigest()
            task = client.submit_embed(owner, request_id, batch, operation, instruction)
            # Completed batches survive a RAG restart. An explicit later retry
            # can replace a failed/cancelled attempt without changing its input.
            if task["state"] in {"failed", "cancelled"}:
                task = client.submit_embed(owner, request_id + "-" + uuid.uuid4().hex, batch, operation, instruction)
            task_id = task["id"]
            deadline = time.monotonic() + (120 if operation == "question_embedding" else 1800)
            while task["state"] not in {"completed", "failed", "cancelled"}:
                if time.monotonic() >= deadline:
                    client.cancel(owner, task_id)
                    raise MacEmbeddingError("等待授权 Mac 向量计算超时，请确认 Mac 已在线。")
                time.sleep(1)
                task = client.status(owner, task_id)
            if task["state"] != "completed":
                raise MacEmbeddingError("授权 Mac 向量计算未完成，请检查设备状态后重试。")
            vectors = client.result_embeddings(owner, task_id)
            if (
                not isinstance(vectors, list) or len(vectors) != len(batch)
                or any(
                    not isinstance(vector, list) or len(vector) != 1024
                    or any(not isinstance(value, (int, float)) or not math.isfinite(value) for value in vector)
                    or not any(value != 0 for value in vector)
                    for vector in vectors
                )
            ):
                raise MacEmbeddingError("Mac 返回的 Qwen 向量数量或维度不正确。")
            embeddings.extend(vectors)
            task_id = None
            if progress_callback:
                progress_callback(len(embeddings), total)
        return embeddings
    except MacEmbeddingError:
        raise
    except Exception as error:
        raise MacEmbeddingError("授权 Mac 向量计算暂时不可用，请检查设备连接。") from error
