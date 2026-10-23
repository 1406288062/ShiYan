"""Isolated account-boundary tests. No live accounts or user data are modified."""
import asyncio
import base64
import copy
import os
from pathlib import Path
import sys
for _parent in Path(__file__).resolve().parents:
    if (_parent / "shared" / "paths.py").is_file():
        if str(_parent) not in sys.path:
            sys.path.insert(0, str(_parent))
        break
from shared.paths import APP_ROOT
import secrets
import tempfile
import time
from unittest.mock import patch
import httpx
from .api import create_app
from .gateway import Gateway, GatewayError
from .account_sessions import COOKIE, PRIVATE_OWNER


class FakeGateway:
    users = {}
    tokens = {}
    workspaces = {}

    def __init__(self, root, platform=None):
        self.account_token = None
        self.public_identity = None

    async def json(self, method, route, payload=None, timeout=40):
        if route == "auth/status":
            return {"ok": True, "bootstrapRequired": True, "canBootstrap": True, "registrationEnabled": True}
        if route in {"auth/login", "auth/register", "auth/bootstrap"}:
            email = payload["email"]
            if email not in self.users:
                self.users[email] = {"id": secrets.token_hex(16), "email": email, "username": email.split("@")[0], "displayName": email,
                    "owner": PRIVATE_OWNER if route.endswith("bootstrap") else "account:" + secrets.token_hex(16),
                    "role": "admin" if route.endswith("bootstrap") else "user", "serverAccess": route.endswith("bootstrap"),
                    "status": "active", "revision": 1}
            token = secrets.token_urlsafe(32)
            self.tokens[token] = self.users[email]
            return {"ok": True, "token": token, "user": copy.deepcopy(self.users[email]), "expiresAt": int(time.time()*1000)+3600000}
        user = self.tokens.get(self.account_token)
        if not user: raise GatewayError("请先登录", 401)
        if route == "auth/me": return {"ok": True, "user": copy.deepcopy(user), "expiresAt": int(time.time()*1000)+3600000}
        if route == "auth/logout": self.tokens.pop(self.account_token, None); return {"ok": True}
        if route == "admin/users": return {"ok": True, "users": list(self.users.values())}
        if route == "dots/profile": return {"ok": True, "profile": {"name": user["id"]}}
        if route.startswith("workspace/"):
            projects = self.workspaces.setdefault(user["owner"], {})
            if route in {"workspace/bootstrap", "workspace/projects"}:
                if route == "workspace/projects" and method == "POST":
                    raw = str((payload or {}).get("path", ""))
                    if raw and not raw.startswith("/workspace"):
                        raise GatewayError("不能访问工作区外的目录", 403)
                    item = {"id": (payload or {}).get("id") or secrets.token_hex(16), "name": payload["name"], "path": "/workspace/projects/test"}
                    projects[item["id"]] = item
                    return {"ok": True, "project": item, "projects": list(projects.values())}
                return {"ok": True, "projects": list(projects.values())}
            if route.startswith("workspace/directory"):
                return {"ok": True, "entries": [], "path": "", "truncated": False}
            if route == "workspace/files/read":
                return {"ok": True, "file": {"kind": "text", "path": "/workspace/test.txt", "text": user["id"]}}
            if route == "workspace/terminals":
                return {"ok": True, "terminal": {"id": user["id"], "cwd": "/workspace", "running": True}}
        if route == "sync/schedules": return {"ok": True, "tasks": []}
        raise GatewayError("测试接口不存在", 404)

    async def ensure_enrolled(self):
        return await self.connect()

    async def connect(self):
        return {"model":"test-model", "models": [{"id":"test-model","reasoningEfforts":["low"],"defaultReasoning":"low"}], "defaultReasoning":"low"}

    def close(self): pass


async def verify_session_performance(root):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    from .account_sessions import AccountSessions
    with tempfile.TemporaryDirectory(prefix="shiyan-session-perf-") as directory:
        manager = AccountSessions(None, directory, root)
        manager.cookie = "performance-cookie"
        user = {"id": "performance-user", "owner": "account:performance", "role": "user", "serverAccess": False}
        manager.user = dict(user)
        class DelayedGateway:
            calls = 0
            blocked = False
            error = None
            started = asyncio.Event()
            release = asyncio.Event()
            async def json(self, *args, **kwargs):
                self.calls += 1
                if self.blocked:
                    self.started.set()
                    await self.release.wait()
                await asyncio.sleep(.15)
                if self.error:
                    raise self.error
                return {"user": dict(user), "expiresAt": int(time.time()*1000)+3600000}
        gateway = DelayedGateway()
        resources = SimpleNamespace(
            runtime=SimpleNamespace(gateway=gateway, account=dict(user), server_access=False,
                                    closing=False, listeners=set(), close=AsyncMock()),
            schedules=SimpleNamespace(close=AsyncMock()), workbench=SimpleNamespace(close=AsyncMock()))
        manager.resources = resources
        request = SimpleNamespace(cookies={COOKIE: manager.cookie})
        started = time.monotonic()
        await asyncio.gather(*(manager.verify(request, force=True) for _ in range(8)))
        elapsed = time.monotonic() - started
        assert gateway.calls == 1, "Concurrent session checks must share one upstream verification"
        assert elapsed < .8, "Session checks must not serialize eight network round trips"
        print("PASS: 8 concurrent sensitive checks shared 1 upstream call in %.3fs (150ms simulated RTT)" % elapsed)
        # A valid ordinary local read must not wait for a sensitive recheck.
        manager.verified_at = time.monotonic() - 2
        gateway.blocked = True
        checking = asyncio.create_task(manager.verify(request, force=True))
        await gateway.started.wait()
        assert await asyncio.wait_for(manager.verify(request), .1) is resources
        gateway.release.set()
        await checking
        gateway.blocked = False
        manager.verified_at = 0
        gateway.error = GatewayError("network unavailable", 503)
        prior_calls = gateway.calls
        failures = await asyncio.gather(*(manager.verify(request, force=True) for _ in range(8)), return_exceptions=True)
        assert all(isinstance(error, GatewayError) and error.status == 503 for error in failures)
        assert gateway.calls == prior_calls + 1 and manager.resources is resources
        gateway.error = GatewayError("revoked", 401)
        manager.verify_failed_at = 0
        try:
            await manager.verify(request, force=True)
            raise AssertionError("Revoked session must be rejected")
        except GatewayError as error:
            assert error.status == 401 and manager.resources is None and manager.cookie is None
        assert resources.runtime.closing and resources.runtime.close.await_count == 1
        manager.gateway.close()
        print("PASS: cached reads bypass network queue; stale checks fail closed; revocation closes account resources")


async def main():
    os.environ["SHIYAN_OFFLINE_TEST"] = "1"
    root = APP_ROOT
    await verify_session_performance(root)
    with tempfile.TemporaryDirectory(prefix="shiyan-account-test-") as directory:
        with patch("desktop_backend.account_sessions.Gateway", FakeGateway), patch("desktop_backend.runtime.Gateway", FakeGateway):
            app = create_app(directory, root)
            async with app.router.lifespan_context(app):
                transport = httpx.ASGITransport(app=app)
                async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:7860", headers={"X-Shiyan-Local": "1"}) as client:
                    assert (await client.get("/api/state")).status_code == 401
                    assert app.state.accounts.resources is None, "No owner runtime can load before login"
                    assert (await client.post("/api/auth/login", json={"email":"a@test"}, headers={"Origin":"https://evil.example"})).status_code == 403
                    assert (await client.post("/api/auth/login", json={"email":"a@test"}, headers={"Origin":"http://127.0.0.1:5174"})).status_code == 403
                    assert (await client.get("/api/auth/status", headers={"Host":"evil.example:7860"})).status_code == 403
                    login = await client.post("/api/auth/register", json={"email":"a@test"})
                    assert login.status_code == 200, login.text
                    assert "token" not in login.json()
                    assert "HttpOnly" in login.headers["set-cookie"] and "SameSite=strict" in login.headers["set-cookie"]
                    cookie_a = client.cookies.get(COOKIE)
                    session_a = app.state.accounts.resources
                    owner_a = login.json()["user"]["owner"]
                    assert str(session_a.runtime.storage.root).startswith(str(Path(directory).resolve()/"accounts"))
                    assert session_a.runtime.server_access is False
                    state = (await client.get("/api/state")).json()["state"]
                    conversation_a = state["conversations"][0]["id"]
                    assert (await client.patch("/api/conversations/"+conversation_a, json={"draft":"Private account A"})).status_code == 200
                    assert (await client.patch("/api/conversations/"+conversation_a, json={"fileChangeRoots":[str(root)]})).status_code == 403
                    for route in ["/api/workspace/directory", "/api/account/quota", "/api/admin/users"]:
                        assert (await client.get(route)).status_code == 403, route
                    for route in ["/api/workspace/files/read", "/api/workspace/terminals"]:
                        assert (await client.post(route,json={})).status_code == 403, route
                    assert (await client.get("/api/dots/profile")).json()["profile"]["name"] == login.json()["user"]["id"]
                    models = (await client.get("/api/schedules/models")).json()
                    assert models["cloud"]["available"] and not models["local"]["available"]
                    workspace = (await client.post("/api/workspace/bootstrap",json={})).json()
                    assert workspace["defaultDirectory"] == "/workspace" and workspace["terminalTransport"] == "SSE"
                    headers = {"X-Shiyan-Workspace":workspace["token"]}
                    assert (await client.post("/api/workspace/projects", json={"name":"Cloud project"},headers=headers)).status_code == 200
                    assert (await client.post("/api/workspace/projects", json={"name":"Probe","path":str(root)},headers=headers)).status_code == 403
                    # Every file/terminal request must use the owner-bound server,
                    # even when a local host implementation exists.
                    with patch("desktop_backend.workbench.Workbench.list_directory", side_effect=AssertionError("host filesystem called")), patch("desktop_backend.workbench.TerminalSession", side_effect=AssertionError("host terminal called")):
                        assert (await client.get("/api/workspace/directory", headers=headers)).status_code == 200
                        assert (await client.post("/api/workspace/files/read", json={"path":"test.txt"}, headers=headers)).json()["file"]["path"] == "/workspace/test.txt"
                        assert (await client.post("/api/workspace/terminals", json={}, headers=headers)).json()["terminal"]["cwd"] == "/workspace"
                        unsupported = await client.post("/api/workspace/files/open-editor", json={}, headers=headers)
                        assert unsupported.status_code == 404, "An unsupported isolated operation must never fall back to a host handler"
                    asset = session_a.runtime.storage.save_bytes(b"account-a-private", "private.txt", "text/plain")
                    assert (await client.get("/api/assets/"+asset["id"]+"/file")).content == b"account-a-private"
                    queue=asyncio.Queue(maxsize=1);session_a.runtime.listeners.add(queue)
                    b = await client.post("/api/auth/register", json={"email":"b@test"})
                    assert b.status_code == 200, b.text
                    assert session_a.runtime.closing and queue.get_nowait() is None
                    assert app.state.accounts.resources.runtime.storage.root != session_a.runtime.storage.root
                    state_b = (await client.get("/api/state")).json()["state"]
                    assert not state_b["history"] and not state_b["projects"]
                    assert all(c["id"]!=conversation_a for c in state_b["conversations"])
                    assert (await client.get("/api/assets/"+asset["id"]+"/file")).status_code == 400
                    async with httpx.AsyncClient(transport=transport,base_url="http://127.0.0.1:7860",headers={"Cookie":COOKIE+"="+cookie_a}) as old:
                        assert (await old.get("/api/state")).status_code == 401
                    assert (await client.post("/api/auth/logout",json={})).status_code == 200
                    assert (await client.get("/api/state")).status_code == 401
                    login_a = await client.post("/api/auth/login",json={"email":"a@test"})
                    assert login_a.json()["user"]["owner"] == owner_a
                    restored = (await client.get("/api/state")).json()["state"]
                    assert next(c for c in restored["conversations"] if c["id"]==conversation_a)["draft"] == "Private account A"
                    app.state.accounts.verified_at = 0
                    FakeGateway.tokens.pop(app.state.accounts.resources.runtime.gateway.account_token)
                    assert (await client.get("/api/auth/me")).status_code == 401
                    assert app.state.accounts.resources is None
                    admin = await client.post("/api/auth/bootstrap",json={"email":"owner@test"})
                    assert admin.status_code == 200, admin.text
                    assert app.state.accounts.resources.runtime.storage.root == Path(directory).resolve()
                    assert (await client.get("/api/admin/users")).status_code == 200
    gateway = Gateway(root)
    gateway.account_token = "a"*43
    async def forbidden_identity(): raise AssertionError("New account requests must not require the private device identity")
    gateway.identity = forbidden_identity
    _, _, headers = await gateway.request_parts("POST", "sync", {"mutations":[]})
    assert headers["Authorization"] == "Bearer "+"a"*43 and headers["X-Shiyan-Account-Required"] == "1"
    gateway.enrolled = True
    gateway.remember_authorization_error(GatewayError("workspace access denied", 403))
    assert gateway.enrolled and gateway.authorization_error is None, "An isolated resource denial must not disable unrelated AI features"
    await gateway.ensure_enrolled()
    gateway.remember_authorization_error(GatewayError("expired session", 401))
    assert not gateway.enrolled and gateway.authorization_error[0] == 401
    gateway.close()
    print("PASS: account cookie/CSRF, logged-out gate, owner directory preservation, two-account local store and asset isolation, stale cookie rejection, session revocation, member AI access, host-handler bypass denial, bearer forwarding")


if __name__ == "__main__": asyncio.run(main())
