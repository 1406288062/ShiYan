"""Web voice regressions with fake synthesis, accounts, and temporary storage."""
import asyncio
from contextlib import asynccontextmanager
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from shared.paths import APP_ROOT
from desktop_backend.api import create_app
from desktop_backend.verify_accounts import FakeGateway
from apps.web.adapters import tts
import httpx


class WebVoiceTests(unittest.IsolatedAsyncioTestCase):
    @asynccontextmanager
    async def client(self, mode="web", login=True):
        with tempfile.TemporaryDirectory(prefix="shiyan-web-voice-") as directory, \
             patch.dict(os.environ, {"SHIYAN_OFFLINE_TEST": "1"}), \
             patch("desktop_backend.account_sessions.Gateway", FakeGateway), \
             patch("desktop_backend.runtime.Gateway", FakeGateway):
            app = create_app(directory, APP_ROOT, profile=mode)
            async with app.router.lifespan_context(app):
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                        base_url="http://127.0.0.1:17861", headers={"X-Shiyan-Local": "1"}) as client:
                    if login:
                        response = await client.post("/api/auth/login", json={"email": "voice-fixture@test"})
                        self.assertEqual(response.status_code, 200, response.text)
                    yield client

    def engine(self, chunks=None, failure=None):
        calls = []
        class Communicate:
            def __init__(self, text, voice, **kwargs):
                calls.append((text, voice, kwargs))
            async def stream(self):
                if failure:
                    raise failure
                for chunk in chunks or [{"type": "audio", "data": b"fixture-mp3"}]:
                    yield chunk
        return SimpleNamespace(Communicate=Communicate), calls

    async def test_fixed_neural_voice_returns_private_mp3(self):
        engine, calls = self.engine([{"type": "WordBoundary"}, {"type": "audio", "data": b"fixture-mp3"}])
        with patch.dict(sys.modules, {"edge_tts": engine}):
            async with self.client() as client:
                response = await client.post("/api/voice/synthesize", json={"text": "你好，今天过得怎么样？"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"], "audio/mpeg")
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertEqual(response.content, b"fixture-mp3")
        self.assertEqual(calls, [("你好，今天过得怎么样？", "zh-CN-XiaoxiaoNeural", {"rate": "-5%"})])

    async def test_invalid_and_oversized_text_never_reaches_upstream(self):
        engine, calls = self.engine()
        with patch.dict(sys.modules, {"edge_tts": engine}):
            async with self.client() as client:
                for value in ([], {}, {"text": 1}, {"text": " "}, {"text": "字" * 1001},
                              {"text": "你好", "voice": "untrusted-voice"}):
                    response = await client.post("/api/voice/synthesize", json=value)
                    self.assertEqual(response.status_code, 400, response.text)
                self.assertEqual((await client.post("/api/voice/synthesize", content=b"{")).status_code, 400)
                self.assertEqual((await client.post("/api/voice/synthesize", content=b" " * 8193)).status_code, 413)
        self.assertFalse(calls)

    async def test_upstream_failure_is_safe_and_audio_size_is_bounded(self):
        async with self.client() as client:
            cases = (self.engine(failure=RuntimeError("private request text or upstream credential"))[0],
                     self.engine([{"type": "audio", "data": b"x" * (tts.MAX_AUDIO + 1)}])[0],
                     self.engine([{"type": "WordBoundary"}])[0])
            for engine in cases:
                with patch.dict(sys.modules, {"edge_tts": engine}):
                    response = await client.post("/api/voice/synthesize", json={"text": "测试"})
                self.assertEqual(response.status_code, 503)
                self.assertEqual(response.json(), {"ok": False, "error": "自然语音暂时不可用，请稍后再试"})

    async def test_timeout_cancels_upstream(self):
        cancelled = asyncio.Event()
        class Communicate:
            def __init__(self, *args, **kwargs): pass
            async def stream(self):
                try:
                    await asyncio.Event().wait()
                    yield {"type": "audio", "data": b"never"}
                finally:
                    cancelled.set()
        with patch.dict(sys.modules, {"edge_tts": SimpleNamespace(Communicate=Communicate)}), \
             patch.object(tts, "SYNTHESIS_TIMEOUT", .01):
            async with self.client() as client:
                response = await client.post("/api/voice/synthesize", json={"text": "测试"})
        self.assertEqual(response.status_code, 503)
        self.assertTrue(cancelled.is_set())

    async def test_concurrency_is_limited_to_two_synthesis_streams(self):
        active = peak = entered = 0
        ready, release = asyncio.Event(), asyncio.Event()
        class Communicate:
            def __init__(self, *args, **kwargs): pass
            async def stream(self):
                nonlocal active, peak, entered
                active += 1
                entered += 1
                peak = max(peak, active)
                if entered == 2: ready.set()
                try:
                    await release.wait()
                    yield {"type": "audio", "data": b"fixture-mp3"}
                finally:
                    active -= 1
        with patch.dict(sys.modules, {"edge_tts": SimpleNamespace(Communicate=Communicate)}):
            async with self.client() as client:
                pending = [asyncio.create_task(client.post("/api/voice/synthesize", json={"text": "测试"})) for _ in range(3)]
                try:
                    await asyncio.wait_for(ready.wait(), 1)
                    self.assertEqual(entered, 2)
                    release.set()
                    responses = await asyncio.gather(*pending)
                finally:
                    release.set()
                    await asyncio.gather(*pending, return_exceptions=True)
        self.assertEqual(peak, 2)
        self.assertTrue(all(response.status_code == 200 for response in responses))

    async def test_existing_auth_and_csrf_checks_protect_synthesis(self):
        engine, calls = self.engine()
        with patch.dict(sys.modules, {"edge_tts": engine}):
            async with self.client(login=False) as client:
                self.assertEqual((await client.post("/api/voice/synthesize", json={"text": "测试"})).status_code, 401)
                await client.post("/api/auth/login", json={"email": "voice-auth-fixture@test"})
                for headers in ({"X-Shiyan-Local": "0"}, {"Origin": "https://other.example"}):
                    response = await client.post("/api/voice/synthesize", json={"text": "测试"}, headers=headers)
                    self.assertEqual(response.status_code, 403)
        self.assertFalse(calls)

    async def test_desktop_has_no_synthesis_route_or_edge_dependency(self):
        original = sys.modules.pop("edge_tts", None)
        try:
            async with self.client(mode="desktop") as client:
                response = await client.post("/api/voice/synthesize", json={"text": "测试"})
            self.assertEqual(response.status_code, 404)
            self.assertNotIn("edge_tts", sys.modules)
        finally:
            if original is not None: sys.modules["edge_tts"] = original


if __name__ == "__main__":
    unittest.main()
