"""Privacy-aware, append-only telemetry for remote model calls."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from threading import Lock
from typing import Any

from config import MODEL_RESPONSE_LOG_BODY, MODEL_RESPONSE_LOG_MAX_CHARS, MODEL_RESPONSE_LOG_PATH


_write_lock = Lock()


def log_model_response(
    *,
    provider: str,
    operation: str,
    model: str,
    status_code: int | None,
    elapsed_ms: int,
    response_body: str | None = None,
    error: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> None:
    """Write one model response event without breaking the business flow."""
    event: dict[str, Any] = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "provider": provider,
        "operation": operation,
        "model": model,
        "status_code": status_code,
        "elapsed_ms": elapsed_ms,
    }
    if metadata:
        event.update(metadata)
    if response_body is not None:
        event["response_chars"] = len(response_body)
        if MODEL_RESPONSE_LOG_BODY and MODEL_RESPONSE_LOG_MAX_CHARS:
            event["response_body"] = response_body[:MODEL_RESPONSE_LOG_MAX_CHARS]
            event["response_body_truncated"] = len(response_body) > MODEL_RESPONSE_LOG_MAX_CHARS
    if error:
        event["error"] = error

    try:
        line = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
        with _write_lock:
            MODEL_RESPONSE_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
            with MODEL_RESPONSE_LOG_PATH.open("a", encoding="utf-8") as handle:
                handle.write(line + "\n")
    except (OSError, TypeError, ValueError):
        # Logging must never turn a successful model response into a task failure.
        pass
