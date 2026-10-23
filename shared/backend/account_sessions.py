"""One active account per desktop process; secrets never enter browser storage."""
from __future__ import annotations
import asyncio
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import time
import stat
import tempfile
from types import SimpleNamespace
from fastapi import Request
from fastapi.responses import JSONResponse
from .gateway import Gateway, GatewayError
from .platforms import resolve_profile

PRIVATE_OWNER = "shiyan-private-owner"
COOKIE = "shiyan_account_session"
READ_VERIFY_SECONDS = 15
SENSITIVE_VERIFY_SECONDS = 1


class AccountSessions:
    def __init__(self, app, directory, root, legacy=None, platform=None):
        self.app, self.directory, self.root, self.legacy = app, Path(directory).expanduser().resolve(), Path(root), legacy
        self.platform = resolve_profile(platform,root)
        self.gateway = Gateway(root,platform=self.platform)
        self.resources = None
        self.cookie = None
        self.user = None
        self.expires_at = 0
        self.generation = 0
        self.switch_lock = asyncio.Lock()
        self.verify_lock = asyncio.Lock()
        self.verified_at = 0
        self.verify_error = None
        self.verify_failed_at = 0
        self.monitor = None
        self.restore_lock = asyncio.Lock()
        self.restore_task = None
        self.restore_verified_at = 0
        self.device_login = None
        self.qr_login = None
        self.profile = hashlib.sha256(str(self.directory).encode()).hexdigest()

    def matches(self, request):
        supplied = request.cookies.get(COOKIE, "")
        return bool(self.cookie and isinstance(supplied, str) and hmac.compare_digest(supplied, self.cookie))

    async def saved_session(self, action, session=None):
        if os.environ.get("SHIYAN_OFFLINE_TEST") == "1":
            return {}
        # Use the private app data directory, never the ACL-bound legacy helper
        # keychain item. Old credentials are deliberately not read or migrated.
        folder = self.directory / "account-login"
        folder.mkdir(mode=0o700, parents=True, exist_ok=True)
        info = folder.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
            raise GatewayError("登录状态目录无效", 503)
        folder.chmod(0o700)
        file = folder / "session.json"
        if action == "delete":
            file.unlink(missing_ok=True)
            return {}
        if action == "read":
            try:
                fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW)
            except FileNotFoundError:
                return {}
            with os.fdopen(fd, "r") as stream:
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > 8192:
                    raise GatewayError("登录状态文件权限无效，请重新登录", 503)
                return {"session": stream.read(8193)}
        if action != "write" or not isinstance(session, dict):
            raise GatewayError("登录状态无效", 400)
        value = json.dumps(session, separators=(",", ":"))
        if len(value.encode()) > 8192: raise GatewayError("登录状态无效", 400)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", dir=folder, delete=False) as stream:
                temporary = Path(stream.name)
                os.fchmod(stream.fileno(), 0o600)
                stream.write(value)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, file)
        finally:
            if temporary: temporary.unlink(missing_ok=True)
        return {}

    def prepare_restore(self):
        # Validate the saved token while WebKit loads public assets. Do not open
        # any account resources or issue a browser cookie until /auth/me claims it.
        if self.restore_task is None:
            self.restore_task = asyncio.create_task(self.read_saved_session())
            self.restore_task.add_done_callback(lambda task: task.exception() if not task.cancelled() else None)
        return self.restore_task

    async def restore(self):
        task = self.prepare_restore()
        try:
            result = await asyncio.shield(task)
        except BaseException:
            if self.restore_task is task and task.done():
                self.restore_task = None
            raise
        if result is None:
            self.restore_task = None
            return None
        # A delayed document must not reuse an old permissions decision.
        if time.monotonic() - self.restore_verified_at > 5:
            self.restore_task = None
            return await self.restore()
        verified_at = self.restore_verified_at
        return await self.activate(result, remember=False, verified_at=verified_at)

    async def read_saved_session(self):
        # Relaunch always requires phone approval; discard old bearer-token files.
        saved = await self.saved_session("read")
        try:
            if "token" in json.loads(saved.get("session", "{}")):
                await self.saved_session("delete")
        except (ValueError, TypeError):
            await self.saved_session("delete")
        return None

    async def remembered_device(self):
        saved = await self.saved_session("read")
        try:
            value = json.loads(saved.get("session", "{}"))
            device = value.get("device")
            if not isinstance(device, dict): return None
            if not all(re.fullmatch(r"[A-Za-z0-9_-]{43}", str(device.get(k, ""))) for k in ("id", "secret")): return None
            if not isinstance(device.get("userId"), str): return None
            return device
        except (ValueError, TypeError):
            return None

    async def clear(self, forget=True):
        task, self.restore_task = self.restore_task, None
        self.restore_verified_at = 0
        # Invalidate request authentication before yielding to close old resources.
        self.cookie = None
        self.user = None
        self.device_login = None
        self.qr_login = None
        self.generation += 1
        self.verified_at = 0
        self.verify_error = None
        self.verify_failed_at = 0
        self.expires_at = 0
        resources, self.resources = self.resources, None
        if task is not None and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        if self.monitor and self.monitor is not asyncio.current_task():
            self.monitor.cancel()
        self.monitor = None
        if resources:
            runtime = resources.runtime
            runtime.closing = True
            for queue in tuple(runtime.listeners):
                if queue.full():
                    try: queue.get_nowait()
                    except asyncio.QueueEmpty: pass
                queue.put_nowait(None)
            await resources.schedules.close()
            await resources.workbench.close()
            await runtime.close()
        if self.legacy:
            await self.legacy.close()
        if forget:
            await self.saved_session("delete")

    async def activate(self, result, remember=True, verified_at=None):
        from .runtime import Runtime
        from .workbench import Workbench
        from .schedules import DesktopSchedules
        user, token = result.get("user"), result.get("token")
        if not isinstance(user, dict) or not isinstance(user.get("owner"), str) or not re.fullmatch(r"[A-Za-z0-9_-]{43}", str(token or "")):
            raise GatewayError("登录响应无效", 502)
        async with self.switch_lock:
            await self.clear(forget=False)
            if remember:
                device = result.get("device") or await self.remembered_device()
                if isinstance(device, dict) and device.get("userId") == user["id"]:
                    await self.saved_session("write", {"device": device})
                else:
                    await self.saved_session("delete")
            owner = user["owner"]
            directory = self.directory if owner == PRIVATE_OWNER else self.directory / "accounts" / hashlib.sha256(owner.encode()).hexdigest()
            runtime = Runtime(directory, self.root, account=user, account_token=token,platform=self.platform)
            resources = SimpleNamespace(runtime=runtime, workbench=Workbench(runtime), schedules=DesktopSchedules(runtime), accounts=self)
            self.resources, self.user = resources, dict(user)
            self.cookie = secrets.token_urlsafe(32)
            self.expires_at = int(result.get("expiresAt", 0))
            self.verified_at = time.monotonic() if verified_at is None else verified_at
            if os.environ.get("SHIYAN_OFFLINE_TEST") != "1":
                runtime.spawn(runtime.start())
                if runtime.server_access:
                    runtime.spawn(resources.schedules.run())
                if self.legacy and owner == PRIVATE_OWNER:
                    runtime.spawn(self.legacy.start())
                self.monitor = asyncio.create_task(self.watch(self.generation))
            return self.cookie

    async def verify(self, request, force=False):
        if not self.matches(request) or not self.resources:
            raise GatewayError("请先登录", 401)
        generation = self.generation
        ttl = SENSITIVE_VERIFY_SECONDS if force else READ_VERIFY_SECONDS
        # Local reads do not queue behind an unrelated network refresh. Sensitive
        # requests share a one-second check, including callers that arrive while
        # the same session is already being checked.
        if self.expires_at and self.expires_at <= time.time() * 1000:
            await self.clear()
            raise GatewayError("登录已过期，请重新登录", 401)
        if time.monotonic() - self.verified_at <= ttl:
            return self.resources
        async with self.verify_lock:
            if not self.matches(request) or generation != self.generation or not self.resources:
                raise GatewayError("登录状态已更新，请重新登录", 401)
            resources = self.resources
            if time.monotonic() - self.verified_at > ttl:
                # Share a failed refresh too; queued callers must not each spend
                # another full network timeout while the server is unreachable.
                if self.verify_error and time.monotonic() - self.verify_failed_at < SENSITIVE_VERIFY_SECONDS:
                    message, status = self.verify_error
                    raise GatewayError(message, status)
                try:
                    result = await resources.runtime.gateway.json("GET", "auth/me", timeout=12)
                except GatewayError as error:
                    if generation == self.generation:
                        if error.status == 401:
                            await self.clear()
                        else:
                            self.verify_error = (str(error), error.status)
                            self.verify_failed_at = time.monotonic()
                    raise
                if generation != self.generation or not self.matches(request):
                    raise GatewayError("登录状态已更新，请重新登录", 401)
                user = result.get("user")
                if not isinstance(user, dict) or user.get("id") != self.user["id"] or user.get("owner") != self.user["owner"]:
                    await self.clear()
                    raise GatewayError("账户身份已变化，请重新登录", 401)
                self.user = dict(user)
                resources.runtime.account = dict(user)
                resources.runtime.server_access = user.get("role") == "admin" and user.get("serverAccess") is True
                self.expires_at = int(result.get("expiresAt", self.expires_at))
                self.verified_at = time.monotonic()
                self.verify_error = None
                self.verify_failed_at = 0
            return resources

    async def protect(self, request):
        path = request.url.path
        if path in {"/", "/app.js", "/styles.css", "/platform.js", "/api/platform", "/api/health"} or path.startswith("/assets/") or path.startswith("/api/auth/"):
            return
        privileged = path.startswith(("/api/workspace/files/", "/api/workspace/terminals", "/api/workspace/directory", "/api/schedules")) or path == "/api/account/quota"
        resources = await self.verify(request, force=privileged)
        user = self.user
        if path.startswith("/api/admin/") and user.get("role") != "admin":
            raise GatewayError("需要管理员权限", 403)
        if not resources.runtime.server_access:
            if not path.startswith("/api/"):
                raise GatewayError("需要管理员权限", 403)
            if path == "/api/account/quota" or path.endswith("/file-changes"):
                raise GatewayError("此操作需要服务器管理权限", 403)
            # Workspace requests are intercepted by member_workspace before any
            # host filesystem or terminal handler can run. Dots uses owner auth.
        # Every request retains its own resources, even if another tab switches accounts.
        request.scope["app"] = SimpleNamespace(state=resources)
        request.state.account = dict(user)

    async def watch(self, generation):
        try:
            while self.resources and generation == self.generation:
                await asyncio.sleep(15)
                resources = self.resources
                if not resources or generation != self.generation: return
                try:
                    await self.verify(SimpleNamespace(cookies={COOKIE: self.cookie}), force=True)
                except GatewayError as error:
                    if error.status == 401 and generation == self.generation:
                        await self.clear()
                        return
        except asyncio.CancelledError:
            return

    async def close(self):
        await self.clear(forget=False)
        self.gateway.close()


def register_accounts(app):
    async def body(request):
        raw = await request.body()
        if len(raw) > 16384: raise GatewayError("账户请求过大", 413)
        try:
            value = await request.json()
            if not isinstance(value, dict): raise ValueError()
            return value
        except (ValueError, UnicodeDecodeError): raise ValueError("账户请求格式无效")

    @app.get("/api/auth/status")
    async def status(request: Request):
        return await request.app.state.accounts.gateway.json("GET", "auth/status", timeout=15)

    @app.get("/api/auth/remembered")
    async def remembered(request: Request):
        device = await request.app.state.accounts.remembered_device()
        return {"ok": True, "profile": {"name": str(device.get("name", "账户"))[:80], "avatar": device.get("avatar")} if device else None}

    @app.post("/api/auth/device/request")
    async def device_request(request: Request):
        manager = request.app.state.accounts
        async with manager.restore_lock:
            if manager.resources: raise GatewayError("请先退出当前账户", 409)
            device = await manager.remembered_device()
            if not device: raise GatewayError("请先扫码关联这台电脑", 401)
            credentials = {"deviceId": device["id"], "deviceSecret": device["secret"]}
            result = await manager.gateway.json("POST", "auth/device/request", credentials, timeout=10)
            manager.device_login = {**credentials, "id": result["id"], "pollSecret": result["pollSecret"]}
            return {"ok": True, "id": result["id"], "code": result["code"], "expiresAt": result["expiresAt"]}

    @app.post("/api/auth/device/poll")
    async def device_poll(request: Request):
        manager = request.app.state.accounts
        payload = await body(request)
        async with manager.restore_lock:
            challenge = manager.device_login
            if manager.resources or not challenge or payload.get("id") != challenge["id"]:
                raise GatewayError("登录请求已更新，请重新发起", 409)
            result = await manager.gateway.json("POST", "auth/device/poll", challenge, timeout=10)
            if result.get("state") != "approved": return {"ok": True, "state": result.get("state")}
            cookie = await manager.activate(result)
            response = JSONResponse({"ok": True, "state": "approved", "user": result["user"]})
            response.set_cookie(COOKIE, cookie, path="/", httponly=True, secure=request.url.scheme == "https", samesite="strict")
            return response

    @app.post("/api/auth/qr/create")
    async def qr_create(request: Request):
        manager = request.app.state.accounts
        async with manager.restore_lock:
            if manager.resources: raise GatewayError("请先退出当前账户", 409)
            result = await manager.gateway.json("POST", "auth/qr/create", {}, timeout=10)
            image = await manager.gateway.helper_json("qr-code", json.dumps({"payload": result["payload"]}).encode())
            manager.qr_login = {"id": result["id"], "pollSecret": result["pollSecret"]}
            return {"ok": True, "id": result["id"], "code": result["code"], "expiresAt": result["expiresAt"], "image": image["png"]}

    @app.post("/api/auth/qr/poll")
    async def qr_poll(request: Request):
        manager = request.app.state.accounts
        payload = await body(request)
        async with manager.restore_lock:
            challenge = manager.qr_login
            if manager.resources or not challenge or payload.get("id") != challenge["id"]:
                raise GatewayError("二维码已更新，请重新扫码", 409)
            result = await manager.gateway.json("POST", "auth/qr/poll", challenge, timeout=10)
            if result.get("state") != "approved": return {"ok": True, "state": result.get("state")}
            cookie = await manager.activate(result)
            response = JSONResponse({"ok": True, "state": "approved", "user": result["user"]})
            response.set_cookie(COOKIE, cookie, max_age=max(1, int((result["expiresAt"]-time.time()*1000)/1000)),
                                path="/", httponly=True, secure=request.url.scheme == "https", samesite="strict")
            return response

    @app.post("/api/auth/register-code")
    async def register_code(request: Request):
        return await request.app.state.accounts.gateway.json("POST", "auth/register-code", await body(request), timeout=35)

    @app.post("/api/auth/{action}")
    async def action(action: str, request: Request):
        manager = request.app.state.accounts
        if action == "logout":
            async with manager.restore_lock:
                if manager.matches(request):
                    resources = manager.resources
                    if resources:
                        from .knowledge_cache import KnowledgeReadCache
                        await asyncio.to_thread(KnowledgeReadCache(resources.runtime.storage.root).clear)
                    generation = manager.generation
                    try:
                        if resources: await resources.runtime.gateway.json("POST", "auth/logout", {}, timeout=10)
                    except GatewayError:
                        pass
                    finally:
                        async with manager.switch_lock:
                            if generation == manager.generation: await manager.clear()
            response = JSONResponse({"ok": True})
            response.delete_cookie(COOKIE, path="/", httponly=True, samesite="strict")
            return response
        if action not in {"login", "register", "bootstrap"}: raise GatewayError("接口不存在", 404)
        payload = await body(request)
        async with manager.restore_lock:
            result = await manager.gateway.json("POST", "auth/" + action, payload, timeout=25)
            cookie = await manager.activate(result)
        response = JSONResponse({"ok": True, "user": result["user"], "expiresAt": result["expiresAt"]})
        response.set_cookie(COOKIE, cookie, max_age=max(1, int((result["expiresAt"] - time.time()*1000)/1000)), path="/",
                            httponly=True, secure=request.url.scheme == "https", samesite="strict")
        return response

    @app.get("/api/auth/me")
    async def me(request: Request):
        manager = request.app.state.accounts
        restored = None
        async with manager.restore_lock:
            if manager.resources is None:
                restored = await manager.restore()
            if restored is None:
                await manager.verify(request, force=True)
            response = JSONResponse({"ok": True, "user": manager.user, "expiresAt": manager.expires_at})
            if restored:
                response.set_cookie(COOKIE, restored, max_age=max(1, int((manager.expires_at-time.time()*1000)/1000)),
                                    path="/", httponly=True, secure=request.url.scheme == "https", samesite="strict")
            return response

    @app.get("/api/admin/users")
    async def users(request: Request):
        return await request.app.state.runtime.gateway.json("GET", "admin/users")

    @app.patch("/api/admin/users/{identifier}")
    async def user(identifier: str, request: Request):
        if not re.fullmatch(r"[0-9a-f-]{36}", identifier, re.I): raise ValueError("用户标识无效")
        return await request.app.state.runtime.gateway.json("PATCH", "admin/users/" + identifier, await body(request))
