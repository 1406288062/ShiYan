"""Application configuration for the knowledge-base agent."""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv


BASE_DIR = Path(__file__).resolve().parents[1]
load_dotenv(os.environ.get("SHIYAN_KNOWLEDGE_ENV", BASE_DIR / ".env"))


def _path_from_env(name: str, default: Path) -> Path:
    value = os.getenv(name)
    path = Path(value) if value else default
    return path if path.is_absolute() else BASE_DIR / path


def _bool_from_env(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _int_from_env(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        value = default
    return max(minimum, min(value, maximum))


DATA_DIR = _path_from_env("DATA_DIR", BASE_DIR)
STORAGE_DIR = _path_from_env("STORAGE_DIR", DATA_DIR / "storage")
UPLOAD_DIR = STORAGE_DIR / "pdfs"
KNOWLEDGE_DIR = STORAGE_DIR / "knowledge"
CHROMA_DIR = _path_from_env("CHROMA_DIR", STORAGE_DIR / "chroma")
DB_PATH = _path_from_env("DATABASE_PATH", DATA_DIR / "knowledge.db")
MODEL_RESPONSE_LOG_PATH = _path_from_env(
    "MODEL_RESPONSE_LOG_PATH", DATA_DIR / "logs" / "model_responses.jsonl"
)
MODEL_RESPONSE_LOG_BODY = _bool_from_env("MODEL_RESPONSE_LOG_BODY", False)
MODEL_RESPONSE_LOG_MAX_CHARS = _int_from_env("MODEL_RESPONSE_LOG_MAX_CHARS", 4000, 0, 20000)

APP_ENV = os.getenv("APP_ENV", "development").strip().lower()
JWT_SECRET = os.getenv("JWT_SECRET", "dev-only-change-this-secret")
if APP_ENV in {"production", "prod"} and (
    len(JWT_SECRET) < 32
    or JWT_SECRET in {"dev-only-change-this-secret", "change-this-secret-before-production", "replace-with-a-long-random-secret"}
):
    raise RuntimeError("生产环境必须配置长度至少 32 位的随机 JWT_SECRET。")
ACCESS_TOKEN_TTL_MINUTES = int(os.getenv("ACCESS_TOKEN_TTL_MINUTES", "1440"))
MAX_UPLOAD_BYTES = int(os.getenv("MAX_UPLOAD_BYTES", str(50 * 1024 * 1024)))

CODEX_NODE_BINARY = os.getenv("CODEX_NODE_BINARY", "node").strip() or "node"
CODEX_BRIDGE_PATH = _path_from_env("CODEX_BRIDGE_PATH", BASE_DIR / "codex-bridge" / "bridge.mjs")
CODEX_GATEWAY_URL = os.getenv("CODEX_GATEWAY_URL", "").strip()
CODEX_GATEWAY_TOKEN = os.getenv("CODEX_GATEWAY_TOKEN", "").strip()
CODEX_GATEWAY_CA_CERT = _path_from_env("CODEX_GATEWAY_CA_CERT", BASE_DIR / "certs" / "codex-server.crt")
# Project-level pin: all generation paths must override gateway/CLI defaults.
CODEX_MODEL = "gpt-6-luna"
CODEX_REASONING_EFFORT = "low"
CODEX_TIMEOUT_SECONDS = _int_from_env("CODEX_TIMEOUT_SECONDS", 180, 30, 900)
EMBEDDING_PROVIDER = os.getenv("EMBEDDING_PROVIDER", "qwen").strip().lower()
DOUBAO_EM_API_KEY = os.getenv("DOUBAO_EM_API_KEY")
DOUBAO_EM_BASE_URL = os.getenv("DOUBAO_EM_BASE_URL", "https://ark.cn-beijing.volces.com/api/v3")
DOUBAO_EM_MODEL = os.getenv("DOUBAO_EM_MODEL", "doubao-embedding-vision-251215")
LOCAL_EMBEDDING_MODEL = _path_from_env(
    "LOCAL_EMBEDDING_MODEL", BASE_DIR / "models" / "Qwen3-Embedding-0.6B"
)
LOCAL_EMBEDDING_DEVICE = os.getenv("LOCAL_EMBEDDING_DEVICE", "auto").strip().lower()
LOCAL_EMBEDDING_BATCH_SIZE = _int_from_env("LOCAL_EMBEDDING_BATCH_SIZE", 4, 1, 32)
LOCAL_EMBEDDING_MAX_LENGTH = _int_from_env("LOCAL_EMBEDDING_MAX_LENGTH", 8192, 128, 8192)
LOCAL_EMBEDDING_QUERY_INSTRUCTION = os.getenv(
    "LOCAL_EMBEDDING_QUERY_INSTRUCTION",
    "Given a user question, retrieve relevant passages from a Chinese PDF knowledge base that answer the question",
).strip()
SEARCH_API_URL = os.getenv("SEARCH_API_URL", "")

# Text PDFs stay on the deterministic local parser. Only pages that look like
# scans, visual tables, charts or damaged text are rendered for the vision
# model, keeping both latency and hallucination surface under control.
PDF_VISION_MIN_TEXT_CHARS = _int_from_env("PDF_VISION_MIN_TEXT_CHARS", 80, 0, 1000)
PDF_VISION_RENDER_DPI = _int_from_env("PDF_VISION_RENDER_DPI", 132, 96, 220)
PDF_VISION_MAX_PAGES = _int_from_env("PDF_VISION_MAX_PAGES", 200, 1, 1000)
PDF_VISION_WORKERS = _int_from_env("PDF_VISION_WORKERS", 9, 1, 9)
KNOWLEDGE_WORKERS = _int_from_env("KNOWLEDGE_WORKERS", 9, 1, 9)
KNOWLEDGE_CONTEXT_MAX_CHARS = _int_from_env(
    "KNOWLEDGE_CONTEXT_MAX_CHARS", 500000, 24000, 800000
)

_origins = os.getenv("ALLOWED_ORIGINS", "http://localhost:5174,http://127.0.0.1:5174")
ALLOWED_ORIGINS = [origin.strip() for origin in _origins.split(",") if origin.strip()]


def ensure_runtime_dirs() -> None:
    for path in (DATA_DIR, STORAGE_DIR, UPLOAD_DIR, KNOWLEDGE_DIR, CHROMA_DIR):
        path.mkdir(parents=True, exist_ok=True)
