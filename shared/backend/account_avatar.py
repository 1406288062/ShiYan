"""Account-scoped avatar transport shared by the desktop and web entry points."""
from __future__ import annotations

import asyncio
import base64
import http.client
import io
import json
import socket
import threading

from fastapi import Request
from fastapi.responses import StreamingResponse

from .gateway import GatewayError


MAX_AVATAR_JSON = 2 * 1024 * 1024


async def _body(request):
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > MAX_AVATAR_JSON:
            raise GatewayError("头像图片过大，请重新选择", 413)
    try:
        value = json.loads(raw) if raw else {}
    except (ValueError, UnicodeDecodeError) as error:
        raise ValueError("头像请求格式无效") from error
    if not isinstance(value, dict):
        raise ValueError("头像请求格式无效")
    return value


def _login_thumbnail(encoded):
    if encoded is None:
        return None
    if not isinstance(encoded, str) or len(encoded) > MAX_AVATAR_JSON:
        raise ValueError("头像数据无效")
    from PIL import Image, ImageOps
    data = base64.b64decode(encoded, validate=True)
    with Image.open(io.BytesIO(data)) as source:
        if source.width * source.height > 4096 * 4096:
            raise ValueError("头像尺寸过大")
        image = ImageOps.fit(ImageOps.exif_transpose(source).convert("RGB"), (64, 64))
        for quality in (80, 65, 45):
            output = io.BytesIO()
            image.save(output, format="JPEG", quality=quality, optimize=True)
            thumbnail = base64.b64encode(output.getvalue()).decode("ascii")
            # Leave room for the remembered-device credentials in the 8 KB file.
            if len(thumbnail) <= 6000:
                return thumbnail
    raise ValueError("无法生成头像缩略图")


async def _remember_avatar(runtime, manager, generation, payload):
    """Refresh the same account's login thumbnail without changing login policy."""
    avatar = payload.get("avatar") if isinstance(payload, dict) else None
    if not isinstance(avatar, dict) or not isinstance(avatar.get("revision"), int):
        return
    revision = avatar["revision"]
    if getattr(runtime, "_remembered_avatar_revision", -1) >= revision:
        return

    def current():
        resources = manager.resources
        return (not runtime.closing and manager.generation == generation
                and resources is not None and resources.runtime is runtime
                and manager.user and manager.user.get("id") == runtime.account.get("id"))

    if not current():
        return
    try:
        device = await manager.remembered_device()
        if not device or device.get("userId") != runtime.account.get("id"):
            return
        thumbnail = await asyncio.to_thread(_login_thumbnail, avatar.get("data"))
        async with manager.switch_lock:
            if not current():
                return
            latest = await manager.remembered_device()
            if (not latest or latest.get("id") != device.get("id")
                    or latest.get("userId") != runtime.account.get("id")):
                return
            if getattr(runtime, "_remembered_avatar_revision", -1) >= revision:
                return
            if latest.get("avatar") != thumbnail:
                await manager.saved_session("write", {"device": {**latest, "avatar": thumbnail}})
            runtime._remembered_avatar_revision = revision
    except Exception:
        # The cloud write has already succeeded. A failed local thumbnail write
        # must not report a failed avatar upload or change the account session.
        return


class _AvatarEventConnection:
    def __init__(self, gateway, path, headers):
        self.connection = gateway.make_connection(45)
        self.path, self.headers = path, headers
        self.response = None
        self.socket = None
        self.closed = False
        self.io_lock = threading.Lock()

    def open(self):
        with self.io_lock:
            if self.closed:
                raise GatewayError("头像实时连接已关闭")
            self.connection.request("GET", self.path, headers=self.headers)
            # HTTPResponse keeps its own file even when Connection: close is set.
            # Retain the socket so logout can interrupt a blocked readline promptly.
            self.socket = self.connection.sock
            if self.closed:
                self.close()
                raise GatewayError("头像实时连接已关闭")
            self.response = self.connection.getresponse()
            if self.closed:
                self.close()
                raise GatewayError("头像实时连接已关闭")
            return self.response

    def readline(self, size):
        with self.io_lock:
            if self.closed:
                return b""
            return self.response.readline(size)

    def close(self):
        # Do not acquire io_lock here: a blocking read holds it. Socket shutdown
        # wakes that read without concurrently mutating HTTPResponse.fp.
        self.closed = True
        active_socket = self.socket or self.connection.sock
        if active_socket is not None:
            try:
                active_socket.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    def dispose(self):
        self.close()
        # HTTPConnection.close may itself close its retained HTTPResponse.
        # Both closes must happen after open/readline has completely returned.
        with self.io_lock:
            if self.response is not None:
                self.response.close()
            self.connection.close()


async def _events(request, runtime, manager, generation):
    gateway = runtime.gateway
    path, _, headers = await gateway.request_parts("GET", "account/avatar/events")
    headers["Accept"] = "text/event-stream"
    connection = _AvatarEventConnection(gateway, path, headers)
    gateway.open_connections.add(connection)
    try:
        response = await asyncio.to_thread(connection.open)
        if response.status != 200:
            raise GatewayError(f"头像实时连接失败（{response.status}）", response.status)
        if response.getheader("Content-Type", "").split(";", 1)[0].strip() != "text/event-stream":
            raise GatewayError("头像实时响应格式无效", 502)
    except (OSError, http.client.HTTPException) as error:
        connection.close()
        gateway.open_connections.discard(connection)
        await asyncio.to_thread(connection.dispose)
        raise GatewayError("头像实时连接中断，请检查网络后重试") from error
    except BaseException:
        connection.close()
        gateway.open_connections.discard(connection)
        await asyncio.to_thread(connection.dispose)
        raise

    async def stream():
        frame = bytearray()
        try:
            while not runtime.closing and generation == manager.generation:
                line = await asyncio.to_thread(connection.readline, MAX_AVATAR_JSON + 1)
                if not line or runtime.closing or generation != manager.generation:
                    return
                frame.extend(line)
                if len(frame) > MAX_AVATAR_JSON:
                    return
                if line in {b"\n", b"\r\n"}:
                    fields = [part[5:].lstrip() for part in bytes(frame).splitlines() if part.startswith(b"data:")]
                    if fields:
                        try:
                            payload = json.loads(b"\n".join(fields))
                        except (ValueError, UnicodeDecodeError):
                            return
                        await _remember_avatar(runtime, manager, generation, payload)
                    if runtime.closing or generation != manager.generation:
                        return
                    yield bytes(frame)
                    frame.clear()
        except (OSError, http.client.HTTPException):
            # Ending the stream lets EventSource reconnect with current cookies.
            return
        finally:
            connection.close()
            gateway.open_connections.discard(connection)
            await asyncio.to_thread(connection.dispose)

    return StreamingResponse(stream(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"})


def register_account_avatar(app):
    @app.get("/api/account/avatar")
    async def get_avatar(request: Request):
        runtime, manager = request.app.state.runtime, request.app.state.accounts
        generation = manager.generation
        payload = await runtime.gateway.json("GET", "account/avatar", timeout=25)
        await _remember_avatar(runtime, manager, generation, payload)
        return payload

    @app.put("/api/account/avatar")
    async def put_avatar(request: Request):
        runtime, manager = request.app.state.runtime, request.app.state.accounts
        generation = manager.generation
        value = await _body(request)
        if set(value) - {"data", "expectedRevision"} or not isinstance(value.get("data"), str):
            raise ValueError("头像请求格式无效")
        payload = await runtime.gateway.json("PUT", "account/avatar", value, timeout=25)
        await _remember_avatar(runtime, manager, generation, payload)
        return payload

    @app.get("/api/account/avatar/events")
    async def avatar_events(request: Request):
        runtime, manager = request.app.state.runtime, request.app.state.accounts
        return await _events(request, runtime, manager, manager.generation)
