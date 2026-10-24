"""Web-only neural voice synthesis; audio is returned without persistence."""
from __future__ import annotations

import asyncio
import json

from fastapi import Request
from fastapi.responses import JSONResponse, Response

VOICE = "zh-CN-XiaoxiaoNeural"
RATE = "-5%"
MAX_TEXT = 1000
MAX_BODY = 8192
MAX_AUDIO = 2 * 1024 * 1024
SYNTHESIS_TIMEOUT = 30


def register_web_voice(app):
    # The existing app middleware authenticates and checks same-origin requests.
    slots = asyncio.Semaphore(2)

    @app.post("/api/voice/synthesize")
    async def synthesize(request: Request):
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > MAX_BODY:
                return JSONResponse({"ok": False, "error": "朗读内容过长"}, status_code=413)
        try:
            value = json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            return JSONResponse({"ok": False, "error": "朗读请求格式无效"}, status_code=400)
        if (not isinstance(value, dict) or set(value) != {"text"}
                or not isinstance(value["text"], str)
                or not value["text"].strip() or len(value["text"]) > MAX_TEXT):
            return JSONResponse({"ok": False, "error": "请提供 1 到 1000 字的朗读内容"}, status_code=400)

        async def collect():
            async with slots:
                # Desktop builds neither import nor require this dependency.
                import edge_tts
                audio = bytearray()
                async for chunk in edge_tts.Communicate(value["text"], VOICE, rate=RATE).stream():
                    if chunk["type"] == "audio":
                        audio.extend(chunk["data"])
                        if len(audio) > MAX_AUDIO:
                            raise ValueError("voice response limit")
                if not audio:
                    raise ValueError("empty voice response")
                return bytes(audio)

        try:
            audio = await asyncio.wait_for(collect(), timeout=SYNTHESIS_TIMEOUT)
        except Exception:
            # Upstream errors can contain request text or connection details.
            return JSONResponse({"ok": False, "error": "自然语音暂时不可用，请稍后再试"}, status_code=503)
        return Response(audio, media_type="audio/mpeg", headers={"Cache-Control": "no-store"})
