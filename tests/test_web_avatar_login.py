"""Browser avatar sign-in uses private per-browser credentials and phone approval."""
import asyncio
import importlib
import json
import os
from pathlib import Path
import secrets
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

ROOT = Path(__file__).resolve().parents[1]
BASE = Path(os.environ.get("SHIYAN_TEST_BASE", str(ROOT)))
PACKAGE = "_web_avatar_login_test"
package = types.ModuleType(PACKAGE)
package.__path__ = [str(ROOT / "shared/backend"), str(BASE / "shared/backend")]
sys.modules[PACKAGE] = package
sessions = importlib.import_module(PACKAGE + ".account_sessions")
web = importlib.import_module(PACKAGE + ".web_sessions")
gateway = importlib.import_module(PACKAGE + ".gateway")


class Authority:
    def __init__(self):
        self.tokens, self.devices, self.challenges, self.qrs = {}, {}, {}, {}

    def user(self, name):
        return {"id": name, "owner": "account:" + name, "displayName": name,
                "role": "user", "serverAccess": False}

    def result(self, name, pair=True):
        token = secrets.token_urlsafe(32)
        user = self.user(name)
        self.tokens[token] = user
        result = {"ok": True, "user": user, "token": token,
                  "expiresAt": int(time.time() * 1000) + 3600000}
        if pair:
            device = {"id": secrets.token_urlsafe(32), "secret": secrets.token_urlsafe(32),
                      "userId": name, "name": name, "avatar": None}
            self.devices[device["id"]] = device
            result["device"] = dict(device)
        return result


class FakeGateway:
    authority = None

    def __init__(self, *args, **kwargs):
        self.account_token = None

    def close(self): pass

    async def helper_json(self, *args):
        return {"png": "fixture-png"}

    async def json(self, method, route, payload=None, **kwargs):
        a = self.authority
        if route == "auth/status":
            return {"ok": True, "registrationEnabled": True, "bootstrapRequired": False,
                    "emailVerificationRequired": True, "emailDeliveryAvailable": True}
        if route in {"auth/login", "auth/register"}:
            if payload.get("password") != "fixture-password":
                raise sessions.GatewayError("密码错误", 401)
            return a.result(payload["email"].split("@")[0])
        if route == "auth/me":
            if self.account_token not in a.tokens:
                raise sessions.GatewayError("请先登录", 401)
            return {"user": a.tokens[self.account_token], "expiresAt": int(time.time()*1000)+3600000}
        if route == "auth/logout":
            a.tokens.pop(self.account_token, None)
            return {"ok": True}
        if route == "auth/device/request":
            device = a.devices.get(payload["deviceId"])
            if not device or device["secret"] != payload["deviceSecret"]:
                raise sessions.GatewayError("关联已失效", 401)
            identifier, secret = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
            a.challenges[identifier] = {"device": device, "secret": secret, "state": "pending"}
            return {"id": identifier, "pollSecret": secret, "code": "123456", "expiresAt": int(time.time()*1000)+120000}
        if route == "auth/device/poll":
            request = a.challenges[payload["id"]]
            if request["device"]["id"] != payload["deviceId"] or request["secret"] != payload["pollSecret"]:
                raise sessions.GatewayError("请求无效", 401)
            if request["state"] == "expired":
                raise sessions.GatewayError("请求过期", 410)
            if request["state"] != "approved":
                return {"state": request["state"]}
            request["state"] = "consumed"
            return {**a.result(request["device"]["userId"], pair=False), "state": "approved"}
        if route == "auth/qr/create":
            identifier = secrets.token_urlsafe(32)
            a.qrs[identifier] = None
            return {"id": identifier, "pollSecret": secrets.token_urlsafe(32), "code": "123456",
                    "expiresAt": int(time.time()*1000)+120000, "payload": "fixture"}
        if route == "auth/qr/poll":
            name = a.qrs[payload["id"]]
            return {**a.result(name), "state": "approved"} if name else {"state": "pending"}
        raise AssertionError(route)


class FakeRuntime:
    def __init__(self, directory, root, account, account_token, **kwargs):
        self.account, self.closing, self.listeners = account, False, []
        self.server_access = False
        self.gateway = FakeGateway()
        self.gateway.account_token = account_token
        self.storage = types.SimpleNamespace(root=Path(directory))

    async def close(self): self.closing = True


class FakeResource:
    def __init__(self, *args): pass
    async def close(self): pass


class BrowserAvatarTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.authority = Authority()
        FakeGateway.authority = self.authority
        runtime = types.ModuleType(PACKAGE + ".runtime")
        runtime.Runtime = FakeRuntime
        workbench = types.ModuleType(PACKAGE + ".workbench")
        workbench.Workbench = FakeResource
        schedules = types.ModuleType(PACKAGE + ".schedules")
        schedules.DesktopSchedules = FakeResource
        for boundary in [patch.object(sessions, "Gateway", FakeGateway),
                         patch.dict(sys.modules, {runtime.__name__: runtime, workbench.__name__: workbench, schedules.__name__: schedules}),
                         patch.dict(os.environ, {"SHIYAN_OFFLINE_TEST": "1"})]:
            boundary.start()
            self.addCleanup(boundary.stop)
        self.clients, self.registries = [], []
        self.app, self.registry = self.create_app()

    def create_app(self):
        app = FastAPI()
        registry = web.BrowserAccountRegistry(app, self.folder.name, BASE / "Mac", platform="web")
        self.registries.append(registry)
        app.state.accounts = registry
        sessions.register_accounts(app)

        @app.middleware("http")
        async def middleware(request, call_next):
            try:
                await registry.protect(request)
                response = await call_next(request)
                registry.finish(request, response)
                return response
            except sessions.GatewayError as error:
                return JSONResponse({"ok": False, "error": str(error)}, status_code=error.status)

        @app.exception_handler(sessions.GatewayError)
        async def error_handler(request, error):
            return JSONResponse({"ok": False, "error": str(error)}, status_code=error.status)

        @app.get("/api/probe")
        async def probe(request: Request):
            return {"user": request.app.state.runtime.account["id"]}
        return app, registry

    async def client(self, app=None):
        client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app or self.app), base_url="https://browser.test")
        self.clients.append(client)
        return client

    async def login(self, client, name="alice"):
        response = await client.post("/api/auth/login", json={"email": name+"@fixture.test", "password": "fixture-password"})
        self.assertEqual(response.status_code, 200, response.text)
        return response

    async def sign_out(self, client):
        response = await client.post("/api/auth/logout", json={})
        self.assertEqual(response.status_code, 200, response.text)

    async def profile(self, client):
        response = await client.get("/api/auth/remembered")
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["profile"]

    async def asyncTearDown(self):
        for client in self.clients: await client.aclose()
        for registry in self.registries:
            if not registry.closed: await registry.close()

    async def test_password_remembers_only_this_browser_and_never_exposes_credentials(self):
        a, b = await self.client(), await self.client()
        response = await self.login(a)
        cookie = next(v for v in response.headers.get_list("set-cookie") if v.startswith(web.REMEMBERED_COOKIE+"="))
        for flag in ["HttpOnly", "Secure", "SameSite=strict", "Max-Age="]: self.assertIn(flag, cookie)
        self.assertNotIn("device", response.json())
        self.assertIsNone(await self.profile(b))
        await self.sign_out(a)
        self.assertEqual((await self.profile(a))["name"], "alice")
        self.assertIsNone(a.cookies.get(sessions.COOKIE))
        self.assertEqual((await a.get("/api/probe")).status_code, 401)
        self.assertFalse((Path(self.folder.name)/"account-login").exists())

    async def test_phone_confirmation_is_required_and_poll_is_bound_to_browser(self):
        a, b = await self.client(), await self.client()
        await self.login(a); await self.sign_out(a)
        response = await a.post("/api/auth/device/request", json={})
        self.assertEqual(response.status_code, 200, response.text)
        identifier = response.json()["id"]
        self.assertNotIn("pollSecret", response.json())
        self.assertTrue(a.cookies.get(web.PREAUTH_COOKIE))
        response = await a.post("/api/auth/device/poll", json={"id":identifier})
        self.assertEqual(response.json()["state"], "pending")
        self.assertIsNone(a.cookies.get(sessions.COOKIE))
        self.assertEqual((await b.post("/api/auth/device/poll", json={"id":identifier})).status_code, 409)
        self.authority.challenges[identifier]["state"] = "approved"
        approved = await a.post("/api/auth/device/poll", json={"id":identifier})
        self.assertEqual(approved.status_code, 200, approved.text)
        self.assertEqual(approved.json()["user"]["id"], "alice")
        self.assertEqual(approved.json()["user"]["role"], "user")
        self.assertIn("Max-Age=", next(v for v in approved.headers.get_list("set-cookie") if v.startswith(sessions.COOKIE+"=")))
        self.assertIsNone(a.cookies.get(web.PREAUTH_COOKIE))
        self.assertEqual((await a.get("/api/probe")).json(), {"user":"alice"})
        self.assertEqual((await a.post("/api/auth/device/poll", json={"id":identifier})).status_code, 409)

    async def test_two_browsers_and_account_switches_keep_profiles_separate(self):
        a, b = await self.client(), await self.client()
        await self.login(a); await self.login(b, "bob")
        old = a.cookies.get(web.REMEMBERED_COOKIE)
        await self.login(a, "carol")
        self.assertNotEqual(a.cookies.get(web.REMEMBERED_COOKIE), old)
        self.assertIsNone(self.registry.read_device(old))
        await self.sign_out(a)
        self.assertEqual((await self.profile(a))["name"], "carol")
        self.assertEqual((await b.get("/api/probe")).json(), {"user":"bob"})
        await self.sign_out(b)
        self.assertEqual((await self.profile(b))["name"], "bob")

    async def test_qr_pairing_persists_the_browser_profile(self):
        client = await self.client()
        created = await client.post("/api/auth/qr/create", json={})
        self.assertEqual(created.status_code, 200, created.text)
        identifier = created.json()["id"]
        self.authority.qrs[identifier] = "alice"
        approved = await client.post("/api/auth/qr/poll", json={"id":identifier})
        self.assertEqual(approved.status_code, 200, approved.text)
        await self.sign_out(client)
        self.assertEqual((await self.profile(client))["name"], "alice")

    async def test_forged_or_cleared_browser_cookies_never_reveal_another_profile(self):
        client = await self.client()
        await self.login(client); await self.sign_out(client)
        client.cookies.clear()
        self.assertIsNone(await self.profile(client))
        client.cookies.set(web.REMEMBERED_COOKIE, secrets.token_urlsafe(32))
        self.assertIsNone(await self.profile(client))
        self.assertEqual((await client.post("/api/auth/device/request", json={})).status_code, 401)

    async def test_rejection_and_expiry_never_issue_an_authenticated_cookie(self):
        client = await self.client()
        await self.login(client); await self.sign_out(client)
        for state, status in [("denied",200),("expired",410)]:
            created = await client.post("/api/auth/device/request", json={})
            identifier = created.json()["id"]
            self.authority.challenges[identifier]["state"] = state
            response = await client.post("/api/auth/device/poll", json={"id":identifier})
            self.assertEqual(response.status_code, status)
            self.assertIsNone(client.cookies.get(sessions.COOKIE))

    async def test_registry_restart_restores_each_session_and_its_own_profile(self):
        a, b = await self.client(), await self.client()
        await self.login(a); await self.login(b, "bob")
        a_cookies, b_cookies = dict(a.cookies), dict(b.cookies)
        await self.registry.close()
        app, registry = self.create_app()
        new_a, new_b = await self.client(app), await self.client(app)
        new_a.cookies.update(a_cookies); new_b.cookies.update(b_cookies)
        self.assertEqual((await new_a.get("/api/probe")).json(), {"user":"alice"})
        self.assertEqual((await new_b.get("/api/probe")).json(), {"user":"bob"})
        self.assertEqual((await self.profile(new_a))["name"], "alice")
        self.assertEqual((await self.profile(new_b))["name"], "bob")
        self.assertEqual((Path(self.folder.name)/"browser-sessions.sqlite3").stat().st_mode & 0o777, 0o600)

    async def test_avatar_refresh_does_not_rotate_credentials_or_extend_their_lifetime(self):
        client = await self.client(); await self.login(client)
        key = client.cookies.get(web.REMEMBERED_COOKIE)
        manager = self.registry.sessions[web.cookie_key(client.cookies.get(sessions.COOKIE))]
        before = self.registry.database.execute("SELECT expires_at FROM browser_devices WHERE cookie_hash=?", (web.cookie_key(key),)).fetchone()[0]
        device = await manager.remembered_device()
        await manager.saved_session("write", {"device":{**device,"avatar":"dGVzdA=="}})
        self.assertEqual(manager.remembered_cookie, key)
        self.assertFalse(manager.remembered_dirty)
        after = self.registry.database.execute("SELECT expires_at FROM browser_devices WHERE cookie_hash=?", (web.cookie_key(key),)).fetchone()[0]
        self.assertEqual(before, after)
        await self.sign_out(client)
        self.assertEqual((await self.profile(client))["avatar"], "dGVzdA==")

    async def test_expired_browser_association_is_not_returned(self):
        client = await self.client(); await self.login(client); await self.sign_out(client)
        self.registry.database.execute("UPDATE browser_devices SET expires_at=0")
        self.registry.database.commit()
        self.assertIsNone(await self.profile(client))

    async def test_web_auth_identifies_browser_without_changing_the_execution_transport(self):
        instance = gateway.Gateway.__new__(gateway.Gateway)
        instance.prefix = "/v1/"; instance.account_token = None
        instance.platform = types.SimpleNamespace(mode="web")
        _, _, headers = await instance.request_parts("POST", "auth/login", {})
        self.assertEqual(headers["X-Shiyan-Platform"], "web")
        instance.platform = types.SimpleNamespace(mode="desktop")
        _, _, headers = await instance.request_parts("POST", "auth/login", {})
        self.assertEqual(headers["X-Shiyan-Platform"], "macos")


if __name__ == "__main__": unittest.main()
