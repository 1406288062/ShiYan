"""Platform architecture contracts, using temporary data and offline gateways."""
from contextlib import asynccontextmanager
import json
import os
from pathlib import Path
import sys
_repository = Path(__file__).resolve().parents[1]
if str(_repository) not in sys.path:
    sys.path.insert(0, str(_repository))
from shared.paths import APP_ROOT
import tempfile
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from fastapi.responses import JSONResponse

from desktop_backend.api import create_app
from desktop_backend.account_sessions import COOKIE
from desktop_backend.gateway import Gateway
from desktop_backend.platforms import PlatformProfile, resolve_profile
from desktop_backend.verify_accounts import FakeGateway


ROOT = APP_ROOT
MODES = ("desktop", "web")


class ConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="shiyan-platform-config-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def configure(self, value):
        (self.root / "platforms.json").write_text(json.dumps(value), encoding="utf-8")

    def test_shared_nested_configuration_and_explicit_overrides(self):
        self.configure({
            "shared": {"appearance": {"spacing": 12, "theme": "shared"}, "items": [1, 2], "value": 1},
            "desktop": {"appearance": {"theme": "desktop"}},
            "web": {"appearance": {"theme": "web"}, "items": [3], "value": None},
        })
        self.assertEqual(PlatformProfile("web", self.root).config, {
            "appearance": {"spacing": 12, "theme": "web"}, "items": [3], "value": None,
        })
        self.assertEqual(PlatformProfile("desktop", self.root).config, {
            "appearance": {"spacing": 12, "theme": "desktop"}, "items": [1, 2], "value": 1,
        })

    def test_only_the_selected_platform_override_is_applied(self):
        self.configure({"shared": {"common": True}, "desktop": {"desktopValue": 1}, "web": {"webValue": 2}})
        self.assertEqual(PlatformProfile("desktop", self.root).config, {"common": True, "desktopValue": 1})
        self.assertEqual(PlatformProfile("web", self.root).config, {"common": True, "webValue": 2})

    def test_profiles_and_public_metadata_do_not_share_mutable_configuration(self):
        self.configure({"shared": {"nested": {"items": [1]}}})
        first = PlatformProfile("web", self.root)
        second = PlatformProfile("web", self.root)
        public = first.public()
        public["config"]["nested"]["items"].append(2)
        self.assertEqual(first.config["nested"]["items"], [1])
        first.config["nested"]["items"].append(3)
        self.assertEqual(second.config["nested"]["items"], [1])
        self.assertEqual(PlatformProfile("desktop", self.root).config["nested"]["items"], [1])

    def test_missing_configuration_keeps_both_modes_empty(self):
        for mode in MODES:
            with self.subTest(mode=mode):
                self.assertEqual(PlatformProfile(mode, self.root).public(), {"mode": mode, "config": {}})

    def test_shipped_platform_overrides_are_empty_and_default_configuration_matches(self):
        self.assertEqual(json.loads((ROOT / "platforms.json").read_text()), {"shared": {}, "desktop": {}, "web": {}})
        self.assertEqual(PlatformProfile("desktop", ROOT).config, PlatformProfile("web", ROOT).config)
        self.assertEqual(PlatformProfile("desktop", ROOT).config, {})

    def test_invalid_modes_and_configuration_are_rejected(self):
        for mode in ("", "mobile", None):
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                PlatformProfile(mode, self.root)
        for value in ([], None, {"shared": []}, {"desktop": None}, {"web": False}):
            self.configure(value)
            with self.subTest(configuration=value), self.assertRaises(ValueError):
                PlatformProfile("desktop", self.root)
        (self.root / "platforms.json").write_text("{invalid", encoding="utf-8")
        with self.assertRaises(ValueError):
            PlatformProfile("web", self.root)

    def test_resolving_an_existing_profile_preserves_context_identity(self):
        profile = PlatformProfile("web", self.root)
        self.assertIs(resolve_profile(profile, self.root), profile)
        self.assertEqual(resolve_profile(None, self.root).mode, "desktop")


class RecordingGateway(FakeGateway):
    def __init__(self, root, platform=None):
        super().__init__(root, platform=platform)
        self.platform = platform


class ApplicationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="shiyan-platform-app-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "project"
        assets = self.root / "web" / "assets"
        assets.mkdir(parents=True)
        for name in ("index.html", "app.js", "assets/platform.js"):
            (self.root / "web" / name).write_bytes((ROOT / "web" / name).read_bytes())
        (self.root / "platforms.json").write_text(json.dumps({"shared": {"example": {"value": 7}}, "desktop": {}, "web": {}}))
        RecordingGateway.users = {}
        RecordingGateway.tokens = {}

    @asynccontextmanager
    async def client(self, mode, legacy=None):
        with patch.dict(os.environ, {"SHIYAN_OFFLINE_TEST": "1"}), \
             patch("desktop_backend.account_sessions.Gateway", RecordingGateway), \
             patch("desktop_backend.runtime.Gateway", RecordingGateway):
            app = create_app(Path(self.temporary.name) / (mode + "-data"), self.root, legacy=legacy, profile=mode)
            async with app.router.lifespan_context(app):
                transport = httpx.ASGITransport(app=app)
                async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:17861", headers={"X-Shiyan-Local": "1"}) as client:
                    yield app, client

    def selected_account(self, app, client):
        accounts = app.state.accounts
        if app.state.platform.mode == "web":
            cookie = client.cookies.get(COOKIE)
            return next(manager for manager in accounts.sessions.values() if manager.cookie == cookie)
        return accounts

    def assert_no_signed_in_resources(self, app):
        accounts = app.state.accounts
        if app.state.platform.mode == "web":
            self.assertEqual(accounts.sessions, {})
            self.assertEqual(accounts.loading, {})
        else:
            self.assertIsNone(accounts.resources)

    def test_both_modes_register_the_same_routes_with_and_without_legacy(self):
        def routes(app):
            return {(route.path, tuple(sorted(getattr(route, "methods", ()) or ()))) for route in app.routes}
        for legacy in (None, SimpleNamespace()):
            with self.subTest(legacy=legacy is not None):
                desktop = create_app(Path(self.temporary.name) / "desktop-routes", self.root, legacy=legacy, profile="desktop")
                web = create_app(Path(self.temporary.name) / "web-routes", self.root, legacy=legacy, profile="web")
                self.assertEqual(routes(desktop), routes(web))
                self.assertEqual(any(route.path == "/{rest:path}" for route in web.routes), legacy is not None)

    async def test_platform_metadata_is_public_and_matches_bootstrap_script(self):
        for mode in MODES:
            with self.subTest(mode=mode):
                async with self.client(mode) as (app, client):
                    self.assert_no_signed_in_resources(app)
                    info = await client.get("/api/platform")
                    self.assertEqual(info.status_code, 200)
                    expected = {"mode": mode, "config": {"example": {"value": 7}}}
                    self.assertEqual(info.json(), {"ok": True, **expected})
                    self.assertEqual(info.headers["cache-control"], "no-store")
                    script = await client.get("/platform.js")
                    self.assertEqual(script.status_code, 200)
                    self.assertEqual(json.loads(script.text.removeprefix("window.__SHIYAN_PLATFORM__=").strip().removesuffix(";")), expected)
                    self.assertEqual(script.headers["cache-control"], "no-store")
                    self.assertEqual((await client.get("/assets/platform.js")).status_code, 200)
                    self.assertEqual((await client.get("/api/state")).status_code, 401)
                    self.assert_no_signed_in_resources(app)

    async def test_existing_authentication_and_same_origin_checks_match_in_both_modes(self):
        for mode in MODES:
            with self.subTest(mode=mode):
                async with self.client(mode) as (_, client):
                    for headers in ({"Host": "evil.example:17861"}, {"Origin": "https://evil.example"}, {"Origin": "http://127.0.0.1:17862"}, {"Sec-Fetch-Site": "cross-site"}):
                        self.assertEqual((await client.get("/api/platform", headers=headers)).status_code, 403)
                    self.assertEqual((await client.post("/api/auth/login", json={"email": "fixture@test"}, headers={"X-Shiyan-Local": "0"})).status_code, 403)
                    self.assertEqual((await client.get("/api/state")).status_code, 401)
                    login = await client.post("/api/auth/login", json={"email": mode + "@test"})
                    self.assertEqual(login.status_code, 200, login.text)
                    self.assertNotIn("token", login.json())
                    self.assertIn("HttpOnly", login.headers["set-cookie"])
                    self.assertIn("SameSite=strict", login.headers["set-cookie"])
                    self.assertEqual((await client.get("/api/state")).status_code, 200)
                    self.assertEqual((await client.get("/api/admin/users")).status_code, 403)

    async def test_one_platform_context_reaches_accounts_runtime_and_gateways(self):
        for mode in MODES:
            with self.subTest(mode=mode):
                async with self.client(mode) as (app, client):
                    accounts = app.state.accounts
                    self.assertIs(accounts.platform, app.state.platform)
                    login = await client.post("/api/auth/login", json={"email": mode + "-context@test"})
                    self.assertEqual(login.status_code, 200, login.text)
                    manager = self.selected_account(app, client)
                    self.assertIs(manager.platform, app.state.platform)
                    self.assertIs(manager.gateway.platform, app.state.platform)
                    runtime = manager.resources.runtime
                    self.assertIs(runtime.platform, app.state.platform)
                    self.assertIs(runtime.gateway.platform, app.state.platform)
                    self.assertEqual(runtime.platform.public(), {"mode": mode, "config": {"example": {"value": 7}}})
                    if mode == "web":
                        # The shared platform context must not share authentication,
                        # gateways, or storage between browser cookie jars.
                        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=client.base_url, headers={"X-Shiyan-Local": "1"}) as other:
                            self.assertEqual((await other.get("/api/state")).status_code, 401)
                            second = await other.post("/api/auth/login", json={"email": "web-other-context@test"})
                            self.assertEqual(second.status_code, 200, second.text)
                            other_manager = self.selected_account(app, other)
                            other_runtime = other_manager.resources.runtime
                            self.assertIsNot(manager, other_manager)
                            self.assertIsNot(manager.gateway, other_manager.gateway)
                            self.assertIsNot(runtime.gateway, other_runtime.gateway)
                            self.assertNotEqual(runtime.storage.root, other_runtime.storage.root)
                            self.assertIs(other_manager.platform, app.state.platform)
                            self.assertIs(other_manager.gateway.platform, app.state.platform)
                            self.assertIs(other_runtime.platform, app.state.platform)
                            self.assertIs(other_runtime.gateway.platform, app.state.platform)
                            self.assertEqual(len(accounts.sessions), 2)
                            self.assertIs(app.state.accounts, accounts)
                            first_me = await client.get("/api/auth/me")
                            second_me = await other.get("/api/auth/me")
                            self.assertEqual(first_me.json()["user"]["id"], login.json()["user"]["id"])
                            self.assertEqual(second_me.json()["user"]["id"], second.json()["user"]["id"])
                            self.assertNotEqual(first_me.json()["user"]["id"], second_me.json()["user"]["id"])

    async def test_explicit_legacy_handler_remains_available_under_the_existing_authentication(self):
        for mode in MODES:
            with self.subTest(mode=mode):
                legacy = SimpleNamespace(close=AsyncMock(), proxy=AsyncMock(return_value=JSONResponse({"legacy": "fixture"})))
                async with self.client(mode, legacy=legacy) as (app, client):
                    if mode == "desktop":
                        self.assertIs(app.state.accounts.legacy, legacy)
                    else:
                        self.assertFalse(hasattr(app.state.accounts, "legacy"))
                    self.assertEqual((await client.get("/legacy-fixture")).status_code, 401)
                    login = await client.post("/api/auth/bootstrap", json={"email": mode + "-owner@test"})
                    self.assertEqual(login.status_code, 200, login.text)
                    response = await client.get("/legacy-fixture")
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(response.json(), {"legacy": "fixture"})
                    if mode == "web":
                        self.assertIsNone(self.selected_account(app, client).legacy)
                        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=client.base_url, headers={"X-Shiyan-Local": "1"}) as other:
                            login = await other.post("/api/auth/login", json={"email": "web-legacy-member@test"})
                            self.assertEqual(login.status_code, 200, login.text)
                            self.assertEqual((await other.get("/legacy-fixture")).status_code, 403)
                    legacy.proxy.assert_awaited_once()
                    self.assertEqual(legacy.proxy.await_args.args[1], "legacy-fixture")


class GatewayCompatibilityTests(unittest.IsolatedAsyncioTestCase):
    async def test_platform_context_keeps_the_existing_wire_header_and_bearer_contract(self):
        for mode in MODES:
            with self.subTest(mode=mode):
                profile = PlatformProfile(mode, ROOT)
                gateway = Gateway(ROOT, platform=profile)
                self.addCleanup(gateway.close)
                self.assertIs(gateway.platform, profile)
                gateway.account_token = "a" * 43
                with patch.object(gateway, "identity", new=AsyncMock(side_effect=AssertionError("Unexpected identity lookup"))):
                    path, body, headers = await gateway.request_parts("POST", "sync", {"mutations": []})
                self.assertTrue(path.endswith("/sync"))
                self.assertEqual(json.loads(body), {"mutations": []})
                self.assertEqual(headers["X-Shiyan-Platform"], "macos")
                self.assertEqual(headers["Authorization"], "Bearer " + "a" * 43)
                self.assertEqual(headers["X-Shiyan-Account-Required"], "1")

    async def test_both_profiles_delegate_to_the_existing_identity_helper(self):
        for mode in MODES:
            with self.subTest(mode=mode):
                gateway = Gateway(ROOT, platform=PlatformProfile(mode, ROOT))
                self.addCleanup(gateway.close)
                child = SimpleNamespace(returncode=0, communicate=AsyncMock(return_value=(b'{"result":"fixture"}', b"")))
                with patch("desktop_backend.gateway.asyncio.create_subprocess_exec", new=AsyncMock(return_value=child)) as spawn:
                    result = await gateway.helper_json("identity", b"fixture-input")
                self.assertEqual(result, {"result": "fixture"})
                self.assertEqual(spawn.await_args.args, (gateway.helper, "identity"))
                child.communicate.assert_awaited_once_with(b"fixture-input")


class SourceLayoutTests(unittest.TestCase):
    def test_compatibility_paths_resolve_to_one_physical_implementation(self):
        repository = Path(__file__).resolve().parents[1]
        links = {
            "web": "shared/frontend", "desktop_backend": "shared/backend",
            "src": "shared/image", "native": "apps/desktop/native",
            "tools": "apps/desktop/tools", "tests": "tests",
            "platforms.json": "config/platforms.json",
        }
        for old, target in links.items():
            with self.subTest(path=old):
                alias = repository / "Mac" / old
                self.assertTrue(alias.is_symlink())
                self.assertEqual(alias.resolve(), (repository / target).resolve())
                self.assertTrue(alias.samefile(repository / target))

    def test_legacy_adapter_imports_share_the_existing_implementation_module(self):
        import desktop_backend.mac_codex as legacy_codex
        import desktop_backend.qwen_tts_worker as legacy_voice
        from apps.desktop.adapters import mac_codex, qwen_tts_worker
        self.assertIs(legacy_codex, mac_codex)
        self.assertIs(legacy_voice, qwen_tts_worker)
        self.assertIs(legacy_codex.MacCodex, mac_codex.MacCodex)

    def test_worker_module_paths_resolve_from_the_unchanged_runtime_directory(self):
        result = subprocess.run(
            [sys.executable, "-B", "-c", "import runpy; runpy.run_module('desktop_backend.worker', run_name='layout_import'); runpy.run_module('desktop_backend.legacy', run_name='layout_import')"],
            cwd=APP_ROOT, capture_output=True, text=True, timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_native_voice_compatibility_path_starts_in_isolated_python(self):
        with tempfile.TemporaryDirectory(prefix="shiyan-layout-voice-") as directory:
            result = subprocess.run(
                [sys.executable, "-B", "-I", "-S", str(APP_ROOT / "desktop_backend" / "qwen_tts_worker.py")],
                input='{"action":"shutdown"}\n', cwd=directory,
                capture_output=True, text=True, timeout=10,
            )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_knowledge_service_direct_entry_retains_its_original_resource_root(self):
        with tempfile.TemporaryDirectory(prefix="shiyan-layout-rag-") as directory:
            result = subprocess.run(
                [sys.executable, "-B", "-I", "-S", str(APP_ROOT / "desktop_backend" / "rag_service.py"), "--help"],
                cwd=directory, capture_output=True, text=True, timeout=10,
            )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--config", result.stdout)


if __name__ == "__main__":
    unittest.main()
