"""Independent browser sessions for a shared Web deployment.

The desktop retains its single signed-in account. A Web request never falls
back to another browser's account or to a desktop remembered login.
"""
from __future__ import annotations
import asyncio
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import time
from types import SimpleNamespace
from .account_sessions import AccountSessions, COOKIE
from .gateway import GatewayError

PREAUTH_COOKIE = "shiyan_browser_login"
REMEMBERED_COOKIE = "shiyan_browser_device"
REMEMBERED_SECONDS = 90 * 86400


def browser_key(value):
    return value if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_-]{43}", value) else None


def cookie_key(value):
    return hashlib.sha256(value.encode()).hexdigest()


class BrowserAccountSession(AccountSessions):
    def __init__(self, *args, registry, remembered=None, **kwargs):
        super().__init__(*args, **kwargs)
        self.registry = registry
        self.preserve_on_close = False
        self.remembered_cookie = browser_key(remembered)
        self.remembered_dirty = False

    async def saved_session(self, action, session=None):
        # Only an opaque, HttpOnly browser cookie leaves the server. Device
        # credentials remain in the private registry, never the desktop store.
        device = self.registry.read_device(self.remembered_cookie)
        if action == "read":
            return {"session": json.dumps({"device": device})} if device else {}
        if action == "delete":
            self.registry.forget_device(self.remembered_cookie)
            self.remembered_cookie = None
            self.remembered_dirty = True
            return {}
        if action != "write" or not isinstance(session, dict):
            raise GatewayError("浏览器关联信息无效", 400)
        current = session.get("device")
        if (not isinstance(current, dict) or not browser_key(current.get("id"))
                or not browser_key(current.get("secret")) or not isinstance(current.get("userId"), str)):
            raise GatewayError("浏览器关联信息无效", 400)
        if (device and device["id"] == current["id"]
                and device["userId"] == current["userId"] and device["secret"] == current["secret"]):
            self.registry.update_device(self.remembered_cookie, current)
        else:
            previous = self.remembered_cookie
            self.remembered_cookie = secrets.token_urlsafe(32)
            self.registry.save_device(self.remembered_cookie, current)
            self.registry.forget_device(previous)
            self.remembered_dirty = True
        return {}

    async def restore(self):
        return None  # The registry restores only this request's exact cookie.

    async def activate(self, result, remember=True, verified_at=None):
        value = await super().activate(result, remember=remember, verified_at=verified_at)
        self.registry.remember(self, result)
        return value

    async def clear(self, forget=True):
        previous = self.cookie
        # Signing out removes authentication, while the avatar still requires
        # a new, explicitly approved phone challenge on the next sign-in.
        await super().clear(forget=False)
        if previous:
            self.registry.discard(previous, persistent=not self.preserve_on_close)

    async def close(self):
        self.preserve_on_close = True
        await super().close()


class BrowserAccountRegistry:
    def __init__(self, app, directory, root, legacy=None, platform=None):
        self.app, self.directory, self.root, self.platform = app, Path(directory).expanduser().resolve(), root, platform
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        file = self.directory / "browser-sessions.sqlite3"
        self.database = sqlite3.connect(file)
        file.chmod(0o600)
        self.database.execute("PRAGMA journal_mode=WAL")
        self.database.execute("PRAGMA busy_timeout=5000")
        self.database.execute("CREATE TABLE IF NOT EXISTS sessions(cookie_hash TEXT PRIMARY KEY, token TEXT NOT NULL, user TEXT NOT NULL, expires_at INTEGER NOT NULL)")
        self.database.execute("CREATE TABLE IF NOT EXISTS browser_devices(cookie_hash TEXT PRIMARY KEY, device TEXT NOT NULL, expires_at INTEGER NOT NULL)")
        self.database.execute("DELETE FROM sessions WHERE expires_at<=?", (int(time.time()*1000),))
        self.database.execute("DELETE FROM browser_devices WHERE expires_at<=?", (int(time.time()),))
        self.database.commit()
        self.sessions = {}
        self.loading = {}
        self.pending = {}
        self.closed = False

    def prepare_restore(self):
        pass

    def new(self, remembered=None):
        arguments = {"platform": self.platform} if self.platform is not None else {}
        return BrowserAccountSession(self.app, self.directory, self.root, None,
                                     registry=self, remembered=remembered, **arguments)

    def read_device(self, key):
        if not browser_key(key):
            return None
        row = self.database.execute("SELECT device FROM browser_devices WHERE cookie_hash=? AND expires_at>?",
                                    (cookie_key(key), int(time.time()))).fetchone()
        if not row:
            return None
        try:
            return json.loads(row[0])
        except (ValueError, TypeError):
            return None

    def save_device(self, key, device):
        self.database.execute("INSERT INTO browser_devices VALUES(?,?,?)",
                              (cookie_key(key), json.dumps(device), int(time.time()) + REMEMBERED_SECONDS))
        self.database.commit()

    def update_device(self, key, device):
        # Avatar updates and approved sign-ins never extend the original device lifetime.
        self.database.execute("UPDATE browser_devices SET device=? WHERE cookie_hash=?",
                              (json.dumps(device), cookie_key(key)))
        self.database.commit()

    def forget_device(self, key):
        if browser_key(key):
            self.database.execute("DELETE FROM browser_devices WHERE cookie_hash=?", (cookie_key(key),))
            self.database.commit()

    def discard(self, cookie, persistent=True):
        key = cookie_key(cookie)
        self.sessions.pop(key, None)
        if persistent and not self.closed:
            self.database.execute("DELETE FROM sessions WHERE cookie_hash=?", (key,))
            self.database.commit()

    def remember(self, manager, result):
        key = cookie_key(manager.cookie)
        self.sessions[key] = manager
        self.database.execute("INSERT INTO sessions VALUES(?,?,?,?) ON CONFLICT(cookie_hash) DO UPDATE SET token=excluded.token,user=excluded.user,expires_at=excluded.expires_at",
            (key, result["token"], json.dumps(result["user"], ensure_ascii=False), manager.expires_at))
        self.database.commit()

    async def load(self, cookie):
        key = cookie_key(cookie)
        record = self.database.execute("SELECT token,user,expires_at FROM sessions WHERE cookie_hash=?", (key,)).fetchone()
        if not record:
            return None
        if record[2] <= int(time.time()*1000):
            self.discard(cookie)
            return None
        manager = self.new()
        manager.gateway.account_token = record[0]
        try:
            result = await manager.gateway.json("GET", "auth/me", timeout=12)
            previous = json.loads(record[1])
            user = result.get("user", {})
            if user.get("id") != previous.get("id") or user.get("owner") != previous.get("owner"):
                raise GatewayError("账户身份已变化，请重新登录", 401)
            manager.gateway.account_token = None
            await manager.activate({"token": record[0], "user": user, "expiresAt": result.get("expiresAt", record[2])}, remember=False)
            generated = manager.cookie
            self.discard(generated)
            manager.cookie = cookie
            self.remember(manager, {"token": record[0], "user": user})
            return manager
        except GatewayError as error:
            if error.status in {401,403}:
                self.discard(cookie)
            await manager.close()
            if error.status not in {401,403}:
                raise
            return None

    def anonymous(self, request):
        now = time.monotonic()
        for key, item in list(self.pending.items()):
            if item["expires"] <= now:
                self.pending.pop(key, None)
        supplied = request.cookies.get(PREAUTH_COOKIE, "")
        if isinstance(supplied, str) and re.fullmatch(r"[A-Za-z0-9_-]{43}", supplied):
            item = self.pending.get(cookie_key(supplied))
            if item is not None and request.url.path.startswith("/api/auth/"):
                request.state.browser_preauth_cookie = supplied
                return item["manager"]
        manager = self.new(request.cookies.get(REMEMBERED_COOKIE))
        if request.url.path in {"/api/auth/qr/create", "/api/auth/device/request"}:
            value = secrets.token_urlsafe(32)
            self.pending[cookie_key(value)] = {"manager": manager, "expires": now + 600}
            request.state.browser_preauth_cookie = value
            request.state.browser_preauth_new = True
        return manager

    def finish(self, request, response):
        manager = getattr(request.state, "browser_account_manager", None)
        if manager is not None and manager.remembered_dirty:
            row = self.database.execute("SELECT expires_at FROM browser_devices WHERE cookie_hash=?",
                                         (cookie_key(manager.remembered_cookie),)).fetchone() if manager.remembered_cookie else None
            if row:
                response.set_cookie(REMEMBERED_COOKIE, manager.remembered_cookie,
                                    max_age=max(1, row[0] - int(time.time())), path="/", httponly=True,
                                    secure=request.url.scheme == "https", samesite="strict")
            else:
                response.delete_cookie(REMEMBERED_COOKIE, path="/", httponly=True,
                                       secure=request.url.scheme == "https", samesite="strict")
            manager.remembered_dirty = False
        value = getattr(request.state, "browser_preauth_cookie", None)
        if not value:
            return
        if manager is not None and manager.cookie:
            self.pending.pop(cookie_key(value), None)
            response.delete_cookie(PREAUTH_COOKIE, path="/", httponly=True, secure=request.url.scheme == "https", samesite="strict")
        elif getattr(request.state, "browser_preauth_new", False):
            response.set_cookie(PREAUTH_COOKIE, value, max_age=600, path="/", httponly=True, secure=request.url.scheme == "https", samesite="strict")

    async def select(self, request):
        supplied = request.cookies.get(COOKIE, "")
        if not isinstance(supplied, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43}", supplied):
            return self.anonymous(request)
        key = cookie_key(supplied)
        current = self.sessions.get(key)
        if current:
            if current.remembered_cookie is None:
                current.remembered_cookie = browser_key(request.cookies.get(REMEMBERED_COOKIE))
            return current
        task = self.loading.get(key)
        if task is None:
            task = asyncio.create_task(self.load(supplied))
            self.loading[key] = task
        try:
            manager = await asyncio.shield(task)
            if manager is None:
                return self.anonymous(request)
            if manager.remembered_cookie is None:
                manager.remembered_cookie = browser_key(request.cookies.get(REMEMBERED_COOKIE))
            return manager
        finally:
            if task.done() and self.loading.get(key) is task:
                self.loading.pop(key, None)

    async def protect(self, request):
        manager = await self.select(request)
        request.state.browser_account_manager = manager
        # Bind public auth routes as well as protected resource routes before
        # dispatch. FastAPI's global application state is never reassigned.
        state = dict(self.app.state._state)
        state["accounts"] = manager
        request.scope["app"] = SimpleNamespace(state=SimpleNamespace(**state))
        await manager.protect(request)

    async def close(self):
        self.closed = True
        for task in self.loading.values():
            task.cancel()
        await asyncio.gather(*self.loading.values(), return_exceptions=True)
        await asyncio.gather(*(manager.close() for manager in list(self.sessions.values())), return_exceptions=True)
        self.sessions.clear()
        for item in self.pending.values():
            item["manager"].gateway.close()
        self.pending.clear()
        self.database.close()
