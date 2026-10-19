"""Start the knowledge service using only ShiYan-owned source and local data."""
from pathlib import Path
import os
import subprocess
import sys
ROOT = Path(__file__).resolve().parent
RUNTIME = ROOT / ".runtime"
REQUIRED = "import fastapi, uvicorn, dotenv, chromadb, pdfplumber, torch, transformers, requests, multipart"

def main():
    candidates = [Path("/opt/homebrew/bin/python3"), RUNTIME / "python/bin/python"]
    python = next((p for p in candidates if p.exists() and subprocess.run(
        [str(p), "-c", REQUIRED], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0), None)
    if python is None:
        raise SystemExit("Knowledge Python dependencies are missing; see Mac/knowledge/README.md")
    env = dict(os.environ)
    env["PATH"] = "/opt/homebrew/bin:" + env.get("PATH", "")
    env["SHIYAN_KNOWLEDGE_ENV"] = str(RUNTIME / "service.env")
    env["DATA_DIR"] = str(RUNTIME / "data")
    env["STORAGE_DIR"] = str(RUNTIME / "data/storage")
    env["DATABASE_PATH"] = str(RUNTIME / "data/knowledge.db")
    env["CHROMA_DIR"] = str(RUNTIME / "data/storage/chroma")
    env["MODEL_RESPONSE_LOG_PATH"] = str(RUNTIME / "data/logs/model_responses.jsonl")
    env["LOCAL_EMBEDDING_MODEL"] = str(RUNTIME / "models/Qwen3-Embedding-0.6B")
    env["CODEX_BRIDGE_PATH"] = str(ROOT / "backend/codex-bridge/bridge.mjs")
    env["CODEX_GATEWAY_CA_CERT"] = str(RUNTIME / "certs/codex-server.crt")
    os.chdir(ROOT / "backend")
    os.execve(str(python), [str(python), str(ROOT.parent / "desktop_backend/rag_service.py"), *sys.argv[1:]], env)

if __name__ == "__main__":
    main()
