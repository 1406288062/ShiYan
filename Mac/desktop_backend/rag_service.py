"""Run ShiYan's owned knowledge service behind its authenticated relay.

The public relay authenticates the Shiyan account. This loopback companion
accepts only its shared secret and maps that account to an isolated RAG user.
ShiYan owns the source, data, ingestion and retrieval implementation.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import importlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import threading
import uuid


DEFAULT_CONFIG = Path.home() / ".config/shiyan-rag/bridge.json"
DEFAULT_SOURCE = Path(__file__).resolve().parents[1] / "knowledge" / "backend"
OWNER_PATTERN = re.compile(r"[A-Za-z0-9_:@.+-]{1,200}\Z")
ROUTES = (
    (re.compile(r"/health\Z"), {"GET"}),
    (re.compile(r"/api/spaces\Z"), {"GET", "POST"}),
    (re.compile(r"/api/spaces/[^/]+/knowledge-bases\Z"), {"GET", "POST"}),
    (re.compile(r"/api/knowledge-bases/[^/]+\Z"), {"PATCH", "DELETE"}),
    (re.compile(r"/api/knowledge-bases/[^/]+/documents\Z"), {"GET", "POST"}),
    (re.compile(r"/api/knowledge-bases/[^/]+/knowledge\Z"), {"GET"}),
    (re.compile(r"/api/knowledge-bases/[^/]+/tasks/active\Z"), {"GET"}),
    (re.compile(r"/api/documents/[^/]+\Z"), {"GET", "DELETE"}),
    (re.compile(r"/api/tasks/[^/]+\Z"), {"GET"}),
    (re.compile(r"/api/query\Z"), {"POST"}),
    (re.compile(r"/api/chat/history\Z"), {"GET", "DELETE"}),
)


def read_config(path: Path) -> dict:
    if stat.S_IMODE(path.stat().st_mode) & 0o077:
        raise RuntimeError("RAG bridge configuration must be private (0600)")
    config = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(config, dict) or not isinstance(config.get("secret"), str) or len(config["secret"]) < 32:
        raise RuntimeError("RAG bridge shared secret is missing")
    mapping = config.get("owner_user_map", {})
    if not isinstance(mapping, dict) or any(
        not isinstance(owner, str) or not OWNER_PATTERN.fullmatch(owner)
        or not isinstance(user_id, str) or not user_id
        for owner, user_id in mapping.items()
    ):
        raise RuntimeError("RAG owner mapping is invalid")
    return config


class OwnerBridge:
    def __init__(self, app, config: dict, database, auth):
        self.app = app
        self.secret = config["secret"].encode("utf-8")
        self.mapping = config.get("owner_user_map", {})
        self.database = database
        self.auth = auth
        self.lock = threading.Lock()

    def owner_token(self, owner: str) -> str:
        mapped = self.mapping.get(owner)
        user_id = mapped or "shiyan-" + hashlib.sha256(owner.encode("utf-8")).hexdigest()[:40]
        with self.lock, self.database.get_conn() as conn:
            user = conn.execute("SELECT id, email, display_name FROM users WHERE id = ?", (user_id,)).fetchone()
            if mapped and user is None:
                raise RuntimeError("Configured RAG owner no longer exists")
            if user is None:
                now = self.database.utc_now()
                conn.execute(
                    "INSERT OR IGNORE INTO users(id,email,display_name,password_hash,created_at) VALUES (?,?,?,?,?)",
                    (user_id, user_id + "@shiyan.local.invalid", "拾燕", "!bridge-only", now),
                )
                space_id = str(uuid.uuid5(uuid.NAMESPACE_URL, "shiyan:rag:space:" + owner))
                conn.execute(
                    "INSERT OR IGNORE INTO spaces(id,name,owner_id,created_at) VALUES (?,?,?,?)",
                    (space_id, "个人空间", user_id, now),
                )
                conn.execute(
                    "INSERT OR IGNORE INTO space_members(space_id,user_id,role,created_at) VALUES (?,?,?,?)",
                    (space_id, user_id, "owner", now),
                )
                user = conn.execute("SELECT id,email,display_name FROM users WHERE id = ?", (user_id,)).fetchone()
            return self.auth.create_access_token(user["id"], user["email"], user["display_name"])

    async def reject(self, scope, receive, send, status: int, detail: str):
        from starlette.responses import JSONResponse
        await JSONResponse({"detail": detail}, status_code=status)(scope, receive, send)

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = scope.get("headers", [])
        authorizations = [v for k, v in headers if k.lower() == b"authorization"]
        expected = b"Bearer " + self.secret
        if len(authorizations) != 1 or not hmac.compare_digest(authorizations[0], expected):
            await self.reject(scope, receive, send, 401, "需要拾燕登录")
            return
        path, method = scope.get("path", ""), scope.get("method", "")
        if not any(pattern.fullmatch(path) and method in methods for pattern, methods in ROUTES):
            await self.reject(scope, receive, send, 404, "接口不存在")
            return
        if path == "/health":
            await self.app(scope, receive, send)
            return
        owners = [v for k, v in headers if k.lower() == b"x-shiyan-owner"]
        owner = owners[0].decode("ascii", "replace") if len(owners) == 1 else ""
        if not OWNER_PATTERN.fullmatch(owner):
            await self.reject(scope, receive, send, 400, "缺少有效的拾燕账户")
            return
        from starlette.concurrency import run_in_threadpool
        try:
            token = await run_in_threadpool(self.owner_token, owner)
        except Exception:
            await self.reject(scope, receive, send, 503, "知识库账户暂时不可用")
            return
        child_scope = dict(scope)
        child_scope["headers"] = [
            (key, value) for key, value in headers
            if key.lower() not in {b"authorization", b"x-shiyan-owner", b"cookie"}
        ] + [(b"authorization", ("Bearer " + token).encode("ascii"))]
        await self.app(child_scope, receive, send)


def create_app(config_path: str | Path | None = None, source_path: str | Path | None = None):
    config = read_config(Path(config_path or os.environ.get("SHIYAN_RAG_CONFIG", DEFAULT_CONFIG)).expanduser())
    source = Path(source_path or DEFAULT_SOURCE).expanduser().resolve()
    if not (source / "src/main.py").is_file():
        raise RuntimeError("ShiYan knowledge source was not found")
    sys.path[:0] = [str(source), str(source / "src")]
    original = importlib.import_module("src.main")
    from starlette.middleware.gzip import GZipMiddleware
    bridge = OwnerBridge(original.app, config, importlib.import_module("database"), importlib.import_module("auth_service"))
    return GZipMiddleware(bridge, minimum_size=4096, compresslevel=5)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default=str(DEFAULT_CONFIG))
    parser.add_argument("--source")
    parser.add_argument("--port", type=int, default=8769)
    args = parser.parse_args()
    import uvicorn
    uvicorn.run(create_app(args.config, args.source), host="127.0.0.1", port=args.port, access_log=False)


if __name__ == "__main__":
    main()
