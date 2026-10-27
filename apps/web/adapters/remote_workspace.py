"""Web-only remote-device workspace routes.

All filesystem work is executed by the fixed helper in ``device_files`` on a
device returned by the authenticated ``list_devices`` call.  The web process
only stores account-local mappings and never uses a host-path fallback.
"""
from __future__ import annotations

import asyncio
import base64
import difflib
import hashlib
import hmac
import http.client
import json
import os
from pathlib import Path
import re
import shlex
import socket
import tempfile
import time
import uuid
from typing import Any

from fastapi import HTTPException, Request
from fastapi.responses import HTMLResponse, Response

from .device_files import command as device_command, encoded_text_chunks


SOCKET_ENV = "SHIYAN_SPONGE_SOCKET"
SOCKET_DEFAULT = "/home/ubuntu/boss-codex-service/shiyan-v2/data/sponge/connector.sock"
MAX_RPC = 16 * 1024 * 1024
MAX_BODY = 4 * 1024 * 1024
TEXT_LIMIT = 2 * 1024 * 1024
DOC_LIMIT = 4 * 1024 * 1024
PDF_LIMIT = 4 * 1024 * 1024
OWNER_RE = re.compile(r"^[^\x00-\x1f\x7f\x80-\x9f]{1,512}$")
ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,128}$")
HASH_RE = re.compile(r"^[0-9a-fA-F]{64}$")
FORBIDDEN_PAYLOAD_KEYS = {"owner", "token", "socket", "command"}


class RemoteFailure(Exception):
    def __init__(self, message: str, status: int = 503):
        super().__init__(message)
        self.message, self.status = message, status


class RemoteUncertain(RemoteFailure):
    def __init__(self):
        super().__init__("远端操作状态不确定，请勿重复发送；确认设备状态后可重试相同请求", 504)


def _socket_path() -> str:
    # This is server configuration, never a browser-controlled URL or path.
    value = os.environ.get(SOCKET_ENV) or (str(Path(os.environ["SHIYAN_ROOT"]) / "data/sponge/connector.sock") if os.environ.get("SHIYAN_ROOT") else SOCKET_DEFAULT)
    if not isinstance(value, str) or not value or not os.path.isabs(value):
        raise RemoteFailure("远端设备连接路径无效", 503)
    return value


def _read_http(sock: socket.socket) -> bytes:
    # HTTPResponse handles both Content-Length and chunked replies from the
    # existing Node connector. Never assume a single recv is a full response.
    response = http.client.HTTPResponse(sock)
    try:
        response.begin()
        length = response.getheader("Content-Length")
        if length is not None and (not length.isdigit() or int(length) > MAX_RPC):
            raise RemoteFailure("远端响应长度无效或超过限制", 502)
        body = response.read(MAX_RPC + 1)
        if len(body) > MAX_RPC:
            raise RemoteFailure("远端响应超过大小限制", 502)
        if not 200 <= response.status < 300:
            raise RemoteFailure("远端设备连接失败", 503 if response.status >= 500 else 502)
        return body
    finally:
        response.close()


def _rpc_sync(owner: str, method: str, params: dict[str, Any], timeout: float) -> Any:
    path = _socket_path()
    if not os.path.isabs(path) or len(path) > 4096:
        raise RemoteFailure("远端设备连接路径无效", 503)
    payload = json.dumps({"owner": owner, "method": method, "params": params},
                         ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(payload) > 256 * 1024:
        raise RemoteFailure("远端请求超过大小限制", 413)
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    request_sent = False
    try:
        sock.settimeout(timeout)
        sock.connect(path)
        request = (b"POST /rpc HTTP/1.1\r\nHost: local\r\nContent-Type: application/json\r\n"
                   + ("Content-Length: %d\r\nConnection: close\r\n\r\n" % len(payload)).encode("ascii") + payload)
        request_sent = True
        sock.sendall(request)
        raw = _read_http(sock)
    except RemoteFailure:
        raise
    except (OSError, TimeoutError, http.client.HTTPException) as exc:
        if request_sent:
            raise RemoteUncertain() from exc
        raise RemoteFailure("远端设备连接不可用", 503) from exc
    finally:
        sock.close()
    try:
        envelope = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RemoteFailure("远端响应不是有效 JSON", 502) from exc
    if not isinstance(envelope, dict):
        raise RemoteFailure("远端响应格式无效", 502)
    if envelope.get("ok") is not True:
        raise RemoteFailure(str(envelope.get("error") or "远端请求失败")[:240], 503)
    return envelope.get("result")


def _text_payload(value: Any) -> Any:
    """Unwrap the bounded MCP text layer, including nested result/text values."""
    current = value
    for _ in range(8):
        if isinstance(current, dict) and current.get("isError"):
            raise RemoteFailure(str(current.get("error") or "远端设备工具调用失败")[:240], 502)
        if isinstance(current, dict) and isinstance(current.get("content"), list):
            text = next((block.get("text") for block in current["content"]
                         if isinstance(block, dict) and isinstance(block.get("text"), str)), None)
            if text is None:
                return {}
            try:
                current = json.loads(text)
            except json.JSONDecodeError:
                return text
            continue
        if isinstance(current, dict) and set(current) == {"text"} and isinstance(current["text"], str):
            try:
                current = json.loads(current["text"])
            except json.JSONDecodeError:
                return current["text"]
            continue
        return current
    raise RemoteFailure("远端响应嵌套过深", 502)


def _pending(value: Any) -> tuple[str | None, str | None]:
    value = _text_payload(value)
    if not isinstance(value, dict):
        return None, None
    state = str(value.get("state") or "").lower()
    if not state and isinstance(value.get("result"), (dict, str)):
        return _pending(value["result"])
    call_id = value.get("call_id") or value.get("callId") or value.get("id")
    return (str(call_id) if call_id else None), state


def _message_running(value: Any) -> bool:
    value = _text_payload(value)
    if not isinstance(value, dict) or "result" in value:
        return False
    message = str(value.get("message") or value.get("text") or "").lower()
    return any(word in message for word in ("still running", "正在运行", "processing", "执行中"))


def _tool_data(value: Any) -> Any:
    """Return helper DATA while retaining pending envelopes for the caller."""
    value = _text_payload(value)
    if isinstance(value, dict) and value.get("ok") is False:
        raise RemoteFailure(str(value.get("error") or "远端文件操作失败")[:240], 502)
    if isinstance(value, dict) and value.get("ok") is True and "result" in value:
        return _text_payload(value["result"])
    if isinstance(value, dict) and "result" in value and "state" not in value:
        return _tool_data(value["result"])
    if isinstance(value, dict) and isinstance(value.get("text"), str) and "state" not in value:
        return _tool_data(_text_payload(value["text"]))
    if isinstance(value, dict) and str(value.get("state") or "").lower() in {"completed", "complete", "done"}:
        if "result" in value:
            return _tool_data(value["result"])
        if isinstance(value.get("text"), str):
            return _tool_data(_text_payload(value["text"]))
    return value


def _helper_error(message: str) -> RemoteFailure:
    message = str(message or "远端文件操作失败")[:240]
    if "状态不确定" in message or "请勿重复" in message:
        return RemoteFailure(message, 504)
    if any(word in message for word in ("已被其他程序修改", "保存前文件发生变化", "相同 requestId")):
        return RemoteFailure(message, 409)
    if "超过" in message:
        return RemoteFailure(message, 413)
    if any(word in message for word in ("无效", "不支持", "不能", "必须", "不是", "无法")):
        return RemoteFailure(message, 400)
    return RemoteFailure(message, 502)


def _json_from_output(value: Any) -> Any:
    """Find one helper JSON line in process output and reject helper failures."""
    value = _text_payload(value)
    if isinstance(value, dict) and ("ok" in value or "result" in value):
        candidate = value
    elif isinstance(value, str):
        if len(value.encode("utf-8", "replace")) > MAX_RPC:
            raise RemoteFailure("远端进程输出超过大小限制", 502)
        candidate = None
        decoder = json.JSONDecoder()
        for line in value.splitlines():
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                parsed, _ = decoder.raw_decode(line)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict) and ("ok" in parsed or "result" in parsed):
                candidate = parsed
                break
        if candidate is None:
            return None
    else:
        return None
    if isinstance(candidate, dict) and candidate.get("ok") is False:
        raise _helper_error(candidate.get("error"))
    return _tool_data(candidate)


def _process_started(value: Any) -> tuple[int | None, str | None]:
    value = _text_payload(value)
    if isinstance(value, dict):
        pid = value.get("pid")
        output = (value.get("output") or value.get("initial_output") or value.get("initialOutput") or
                  value.get("stdout") or value.get("text") or value.get("message") or "")
        output = str(output)
        if not (isinstance(pid, int) or str(pid).isdigit()):
            match = re.search(r"Process started with PID\s+(\d+)", output, re.I)
            pid = int(match.group(1)) if match else None
        return (int(pid) if isinstance(pid, int) or str(pid).isdigit() else None, output)
    if isinstance(value, str):
        match = re.search(r"Process started with PID\s+(\d+)", value, re.I)
        if match:
            output = value.split("Initial output:", 1)[-1].strip() if "Initial output:" in value else ""
            output = re.sub(r"\n?\s*[✅✓]?\s*Process\s+\d+\s+(?:finished|exited).*\Z", "", output,
                            flags=re.I | re.S).strip()
            return int(match.group(1)), output
    return None, None


class SpongeTransport:
    def __init__(self, owner: str):
        if not isinstance(owner, str) or not OWNER_RE.fullmatch(owner):
            raise RemoteFailure("当前账户远端身份无效", 401)
        self.owner = owner

    async def rpc(self, method: str, params: dict[str, Any], timeout: float = 15):
        return await asyncio.to_thread(_rpc_sync, self.owner, method, params, timeout)

    async def tool(self, name: str, arguments: dict[str, Any], timeout: float = 90):
        result = _text_payload(await self.rpc("tools/call", {"name": name, "arguments": arguments}, min(timeout, 30)))
        call_id, state = _pending(result)
        if state in {"sent", "accepted", "executing", "pending"} or (state in {"completed", "complete", "done"} and _message_running(result)):
            if not call_id:
                raise RemoteUncertain()
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                await asyncio.sleep(0.15)
                # Once accepted, this is the only permitted follow-up.  Never
                # dispatch the original tool again after an uncertain write.
                result = _text_payload(await self.rpc("tools/call", {
                    "name": "get_tool_result", "arguments": {"call_id": call_id}}, 15))
                next_id, next_state = _pending(result)
                if next_state in {"sent", "accepted", "executing", "pending"}:
                    continue
                if next_state == "uncertain":
                    raise RemoteUncertain()
                if next_state in {"completed", "complete", "done", ""}:
                    if _message_running(result):
                        continue
                    data = _tool_data(result)
                    if data not in (None, {}, ""):
                        return data
                    # A completed placeholder can mean that the process was
                    # accepted but its stdout is still being drained.  The
                    # run() caller will use the PID and read_process_output.
                    return result
            raise RemoteUncertain()
        if state == "uncertain":
            raise RemoteUncertain()
        return _tool_data(result)

    async def devices(self) -> list[dict[str, Any]]:
        result = _tool_data(await self.rpc("tools/call", {"name": "list_devices", "arguments": {}}, 20))
        if isinstance(result, dict): result = result.get("devices", result.get("result", []))
        if not isinstance(result, list):
            raise RemoteFailure("远端设备列表格式无效", 502)
        return [item for item in result if isinstance(item, dict) and isinstance(item.get("deviceId"), str)]

    async def run(self, device_id: str, args: dict[str, Any], timeout: float = 90):
        cmd = device_command(args)
        result = await self.tool("run_device_tool", {
            "deviceId": device_id, "tool": "start_process",
            "arguments": {"command": cmd, "timeout_ms": int(min(timeout, 120) * 1000)}}, timeout)
        pid, output = _process_started(result)
        parsed = _json_from_output(output) if output else _json_from_output(result)
        if parsed is not None:
            return parsed
        if pid is None:
            if isinstance(result, str):
                raise RemoteFailure(result[:240], 502)
            raise RemoteFailure("远端进程未返回有效 PID 或输出", 502)
        deadline = time.monotonic() + timeout
        last = ""
        while time.monotonic() < deadline:
            await asyncio.sleep(0.15)
            # A known PID is only queried through read_process_output; never
            # dispatch the original start_process again after an uncertain write.
            polled = await self.tool("run_device_tool", {
                "deviceId": device_id, "tool": "read_process_output",
                "arguments": {"pid": pid, "timeout_ms": int(min(2, max(0.2, deadline - time.monotonic())) * 1000)}},
                min(15, max(1, deadline - time.monotonic())))
            p_pid, p_output = _process_started(polled)
            last = p_output or (polled if isinstance(polled, str) else "")
            parsed = _json_from_output(p_output or polled)
            if parsed is not None:
                return parsed
            if p_pid is None and isinstance(polled, dict) and str(polled.get("status", "")).lower() in {"failed", "error"}:
                raise RemoteFailure(str(polled.get("message") or "远端进程失败")[:240], 502)
        raise RemoteUncertain() if last else RemoteFailure("远端进程未返回有效输出", 502)


def _owner_runtime(request: Request):
    runtime = getattr(request.app.state, "runtime", None)
    account = getattr(runtime, "account", None) if runtime is not None else None
    owner = account.get("owner") if isinstance(account, dict) else None
    if not isinstance(owner, str) or not OWNER_RE.fullmatch(owner):
        raise HTTPException(401, "请先登录")
    return runtime, SpongeTransport(owner)


def _projects(runtime) -> list[dict[str, Any]]:
    values = runtime.storage.setting("webRemoteProjects", [])
    if not isinstance(values, list): return []
    result = []
    for item in values:
        if (isinstance(item, dict) and isinstance(item.get("id"), str) and item["id"].startswith("web-device-")
                and isinstance(item.get("deviceId"), str) and isinstance(item.get("path"), str)
                and isinstance(item.get("name"), str)):
            result.append({"id": item["id"], "name": item["name"], "path": item["path"], "deviceId": item["deviceId"]})
    return result


def _set_projects(runtime, items):
    runtime.storage.set_setting("webRemoteProjects", items)


def _ready(device: dict[str, Any]) -> bool:
    status = str(device.get("status") or "").lower()
    revoked = bool(device.get("revokedAt")) or status in {"revoked", "reclaimed", "disabled", "blocked"}
    connected = bool(device["connected"]) if "connected" in device else (
        bool(device["online"]) if "online" in device else status in {"online", "connected", "ready"})
    ready = bool(device["ready"]) if "ready" in device else status in {"ready", "online", "connected"}
    return connected and ready and not revoked


async def _device(transport: SpongeTransport, device_id: str, *, for_write: bool = False):
    if not isinstance(device_id, str) or len(device_id) > 200:
        raise HTTPException(400, "设备标识无效")
    try:
        devices = await transport.devices()
    except RemoteFailure as exc:
        raise HTTPException(exc.status, exc.message) from exc
    found = next((item for item in devices if item.get("deviceId") == device_id), None)
    if found is None:
        raise HTTPException(404, "设备不存在或不属于当前账户")
    status = str(found.get("status") or "").lower()
    if found.get("revokedAt") or status in {"revoked", "reclaimed", "disabled", "blocked"}:
        raise HTTPException(409, "设备已撤销")
    if not _ready(found):
        raise HTTPException(503, "设备当前离线或未就绪")
    return found


async def _run(runtime, transport, project, args, timeout=90):
    await _device(transport, project["deviceId"], for_write=args.get("action") in {"save", "stage"})
    args = {**args, "root": project["path"]}
    try:
        return await transport.run(project["deviceId"], args, timeout)
    except RemoteFailure:
        raise
    except (OSError, ValueError, TypeError) as exc:
        raise RemoteFailure("远端文件操作失败", 502) from exc


def _project(runtime, identifier: str):
    item = next((x for x in _projects(runtime) if hmac.compare_digest(x["id"], str(identifier))), None)
    if not item: raise HTTPException(404, "远程项目不存在")
    return item


async def _body(request: Request) -> dict[str, Any]:
    raw = await request.body()
    if len(raw) > MAX_BODY: raise HTTPException(413, "请求内容过大")
    try: value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc: raise HTTPException(400, "请求格式无效") from exc
    if not isinstance(value, dict): raise HTTPException(400, "请求格式无效")
    if FORBIDDEN_PAYLOAD_KEYS.intersection(value):
        raise HTTPException(400, "请求包含不支持的字段")
    return value


def _call_error(exc: RemoteFailure):
    raise HTTPException(exc.status, exc.message) from exc


def _valid_name(value):
    value = str(value or "").strip()
    if not value or len(value) > 100 or value in {".", ".."} or any(c in value for c in "/\\\x00"):
        raise HTTPException(400, "请输入有效的项目名称（不能包含路径分隔符）")
    return value


def _document_token(documents, runtime, project, path):
    token = uuid.uuid4().hex + uuid.uuid4().hex
    owner = str(runtime.account["owner"])
    documents[token] = {"owner": owner, "project": dict(project), "path": path, "expires": time.monotonic() + 1800}
    while len(documents) > 256:
        documents.pop(next(iter(documents)))
    return "/api/web-workspace/document/" + token


async def _stage(transport, project, text: str, *, baseline=False):
    stage_id = "webstage-" + uuid.uuid4().hex
    chunks = list(encoded_text_chunks(text))
    if len(chunks) > 256: raise HTTPException(413, "文本超过暂存大小限制")
    total = len(chunks) or 1
    try:
        for index, chunk in enumerate(chunks or [b""]):
            args = {"action": "stage", "stageId": stage_id, "index": index, "total": total,
                    "dataB64": base64.b64encode(chunk).decode("ascii")}
            await transport.run(project["deviceId"], {**args, "root": project["path"]}, 45)
        return stage_id, total
    except RemoteFailure:
        raise


def install_remote(app):
    """Register only web remote-device routes; callers integrate this function."""
    if getattr(getattr(app.state, "platform", None), "mode", None) not in {None, "web"}:
        return
    documents: dict[str, dict[str, Any]] = {}

    @app.get("/api/web-workspace/projects")
    async def remote_projects(request: Request):
        runtime, transport = _owner_runtime(request)
        try: devices = await transport.devices()
        except RemoteFailure as exc: _call_error(exc)
        public = []
        for device in devices:
            status = str(device.get("status") or "").lower()
            online = bool(device["connected"]) if "connected" in device else (
                bool(device["online"]) if "online" in device else status in {"online", "connected", "ready"})
            public.append({"deviceId": device["deviceId"], "name": str(device.get("name") or device["deviceId"])[:100],
                           "online": online,
                           "ready": _ready(device), "platform": str(device.get("platform") or "")[:40]})
        return {"ok": True, "projects": _projects(runtime), "devices": public,
                "connected": any(item["online"] for item in public)}

    @app.post("/api/web-workspace/pick")
    async def remote_pick(request: Request):
        runtime, transport = _owner_runtime(request); data = await _body(request)
        device = await _device(transport, data.get("deviceId"))
        try:
            result = await transport.run(device["deviceId"], {"action": "pick", "platform": device.get("platform", "")}, 125)
        except RemoteFailure as exc: _call_error(exc)
        if not isinstance(result, dict): raise HTTPException(502, "远端选择目录响应无效")
        return {"ok": True, "path": str(result.get("path") or ""), "cancelled": bool(result.get("cancelled"))}

    @app.post("/api/web-workspace/projects")
    async def remote_project_create(request: Request):
        runtime, transport = _owner_runtime(request); data = await _body(request)
        device_id = data.get("deviceId"); raw_path = data.get("path")
        if not isinstance(raw_path, str) or not raw_path or len(raw_path) > 4096 or "\x00" in raw_path:
            raise HTTPException(400, "请选择远程目录")
        device = await _device(transport, device_id)
        try:
            checked = await transport.run(device["deviceId"], {"action": "validate_root", "path": raw_path}, 45)
        except RemoteFailure as exc: _call_error(exc)
        if not isinstance(checked, dict) or not isinstance(checked.get("path"), str):
            raise HTTPException(502, "远程目录校验响应无效")
        path = checked["path"]; name = _valid_name(data.get("name") or Path(path).name or "远程项目")
        items = _projects(runtime)
        for item in items:
            if item["deviceId"] == device_id and item["path"] == path:
                return {"ok": True, "project": item, "projects": items}
        item = {"id": "web-device-" + str(uuid.uuid4()), "name": name, "path": path, "deviceId": device_id}
        items.append(item); _set_projects(runtime, items)
        return {"ok": True, "project": item, "projects": items}

    @app.patch("/api/web-workspace/projects/{identifier}")
    async def remote_project_update(identifier: str, request: Request):
        runtime, _ = _owner_runtime(request); data = await _body(request); item = _project(runtime, identifier)
        item["name"] = _valid_name(data.get("name")); items = _projects(runtime)
        for index, existing in enumerate(items):
            if existing["id"] == item["id"]: items[index] = item
        _set_projects(runtime, items)
        return {"ok": True, "project": item, "projects": items}

    @app.delete("/api/web-workspace/projects/{identifier}")
    async def remote_project_delete(identifier: str, request: Request):
        runtime, _ = _owner_runtime(request); _project(runtime, identifier)
        items = [item for item in _projects(runtime) if item["id"] != identifier]; _set_projects(runtime, items)
        return {"ok": True, "projects": items}

    @app.get("/api/web-workspace/directory-details")
    async def remote_directory(request: Request, projectId: str, path: str = "", offset: int = 0):
        runtime, transport = _owner_runtime(request); project = _project(runtime, projectId)
        if offset < 0 or offset > 100000: raise HTTPException(400, "目录分页参数无效")
        try: result = await _run(runtime, transport, project, {"action": "list", "path": path, "offset": offset}, 60)
        except RemoteFailure as exc: _call_error(exc)
        if not isinstance(result, dict): raise HTTPException(502, "目录响应无效")
        return {"ok": True, "total": int(result.get("total", 0)), "nextOffset": result.get("nextOffset"),
                "name": str(result.get("name") or ""), "path": str(result.get("path") or ""),
                "entries": result.get("entries", []), "truncated": bool(result.get("truncated")),
                "totalKnown": bool(result.get("totalKnown", not result.get("truncated")))}

    @app.get("/api/web-workspace/files/search")
    async def remote_search(request: Request, projectId: str, q: str = ""):
        runtime, transport = _owner_runtime(request); project = _project(runtime, projectId)
        try: result = await _run(runtime, transport, project, {"action": "search", "q": q}, 60)
        except RemoteFailure as exc: _call_error(exc)
        if not isinstance(result, dict): raise HTTPException(502, "远端搜索响应无效")
        return {"ok": True, **{key: result.get(key) for key in ("entries", "truncated", "searched", "omittedGeneratedFolders")}}

    @app.post("/api/web-workspace/files/read")
    async def remote_read(request: Request):
        runtime, transport = _owner_runtime(request); data = await _body(request); project = _project(runtime, data.get("projectId"))
        path = data.get("path")
        try: result = await _run(runtime, transport, project, {"action": "read", "path": path}, 60)
        except RemoteFailure as exc: _call_error(exc)
        if not isinstance(result, dict): raise HTTPException(502, "远端文件响应无效")
        if result.get("kind") == "web-document":
            result = {key: value for key, value in result.items() if key not in {"contentHash"}}
            result["previewUrl"] = _document_token(documents, runtime, project, path)
        return {"ok": True, "file": result}

    @app.get("/api/web-workspace/document/{token}")
    async def remote_document(token: str, request: Request):
        runtime, transport = _owner_runtime(request)
        item = documents.get(token)
        if not item or not hmac.compare_digest(item["owner"], runtime.account["owner"]):
            # A token owned by another account must remain untouched.  This
            # prevents an attacker from invalidating a valid viewer session.
            raise HTTPException(403, "文档预览已失效，请重新打开文件")
        if item["expires"] <= time.monotonic():
            documents.pop(token, None)
            raise HTTPException(403, "文档预览已失效，请重新打开文件")
        project = _project(runtime, item["project"]["id"])
        try: result = await _run(runtime, transport, project, {"action": "raw", "path": item["path"]}, 90)
        except RemoteFailure as exc: _call_error(exc)
        if not isinstance(result, dict) or not isinstance(result.get("dataB64"), str): raise HTTPException(502, "文档响应无效")
        try: raw = base64.b64decode(result["dataB64"].encode("ascii"), validate=True)
        except Exception as exc: raise HTTPException(502, "文档响应编码无效") from exc
        if len(raw) > DOC_LIMIT: raise HTTPException(413, "文档超过传输大小限制")
        if Path(item["path"]).suffix.lower() == ".pdf":
            if len(raw) > PDF_LIMIT: raise HTTPException(413, "PDF 超过 4 MiB 传输上限")
            if not raw.startswith(b"%PDF-"): raise HTTPException(415, "PDF 文件格式无效")
            return Response(raw, media_type="application/pdf", headers={"Content-Disposition": "inline", "X-Content-Type-Options": "nosniff",
                                                                          "Cache-Control": "no-store", "X-Frame-Options": "SAMEORIGIN"})
        with tempfile.NamedTemporaryFile(prefix="shiyan-remote-doc-", suffix=".docx", delete=False) as stream:
            temp = Path(stream.name); stream.write(raw); stream.flush(); os.fsync(stream.fileno())
        try:
            from .document_preview import render_docx, DOCX_CSP
            document = await asyncio.to_thread(render_docx, temp)
        finally:
            temp.unlink(missing_ok=True)
        return HTMLResponse(document, headers={"Content-Security-Policy": DOCX_CSP, "Cache-Control": "no-store",
                                               "X-Frame-Options": "SAMEORIGIN"})

    @app.post("/api/web-workspace/files/save-text")
    async def remote_save(request: Request):
        runtime, transport = _owner_runtime(request); data = await _body(request)
        if data.get("confirmed") is not True: raise HTTPException(400, "请确认保存到原文件")
        request_id = data.get("requestId")
        if not isinstance(request_id, str) or not ID_RE.fullmatch(request_id): raise HTTPException(400, "保存请求标识无效")
        if not isinstance(data.get("text"), str) or len(data["text"].encode("utf-8")) > TEXT_LIMIT * 2: raise HTTPException(413, "编辑内容超过大小上限")
        if not isinstance(data.get("contentHash"), str) or not HASH_RE.fullmatch(data["contentHash"]): raise HTTPException(400, "文件版本标识无效")
        project = _project(runtime, data.get("projectId"))
        try:
            # The device-side receipt lookup is deliberately the first save
            # decision.  A completed requestId must replay its receipt even if
            # the browser's pre-save read is now stale or the target changed.
            text = data["text"]
            encoded = text.encode("utf-8")
            args = {"action": "save", "path": data.get("path"), "requestId": request_id, "contentHash": data["contentHash"]}
            if len(encoded) <= 24576:
                args["textB64"] = base64.b64encode(encoded).decode("ascii")
                saved = await _run(runtime, transport, project, args, 90)
            else:
                stage_id, total = await _stage(transport, project, text)
                saved = await _run(runtime, transport, project, {**args, "stageId": stage_id, "stageTotal": total}, 90)
            if not isinstance(saved, dict): raise RemoteFailure("保存响应无效", 502)
            try:
                after = await _run(runtime, transport, project, {"action": "read", "path": data.get("path")}, 60)
            except RemoteFailure:
                # Receipt replay is still a successful, non-writing outcome;
                # preserve the receipt when the target is no longer readable.
                if not saved.get("_receiptReplay"):
                    raise
                after = None
        except HTTPException: raise
        except RemoteFailure as exc: _call_error(exc)
        return {"ok": True, "file": after, "backupPath": saved.get("backupPath")}

    @app.post("/api/web-workspace/files/changes")
    async def remote_changes(request: Request):
        runtime, transport = _owner_runtime(request); data = await _body(request); project = _project(runtime, data.get("projectId"))
        args = {"action": "changes", "path": data.get("path")}
        baseline = data.get("baselineText")
        if isinstance(baseline, str) and len(baseline.encode("utf-8")) <= TEXT_LIMIT:
            if len(baseline.encode("utf-8")) <= 24576: args["baselineText"] = baseline
            else:
                stage_id, total = await _stage(transport, project, baseline, baseline=True)
                args.update(baselineStage=stage_id, baselineTotal=total)
        try: result = await _run(runtime, transport, project, args, 90)
        except RemoteFailure as exc: _call_error(exc)
        if not isinstance(result, dict) or not isinstance(result.get("currentText"), str): raise HTTPException(502, "变更响应无效")
        before = result.get("baselineText")
        if not isinstance(before, str):
            return {"ok": True, "changes": {"name": result.get("name", ""), "available": False, "diff": "", "source": "暂无保存记录或 Git 基准"}}
        lines = []
        diff_truncated = False
        diff_size = 0
        for line in difflib.unified_diff(before.splitlines(), result["currentText"].splitlines(),
                                         fromfile=str(result.get("source") or "基准"), tofile="当前文件", lineterm=""):
            line_size = len(line.encode("utf-8", "replace")) + 1
            if diff_size + line_size > 512 * 1024:
                diff_truncated = True
                break
            lines.append(line); diff_size += line_size
        if not lines and before != result["currentText"]: lines = ["文件末尾换行已" + ("添加" if result["currentText"].endswith("\n") else "移除")]
        return {"ok": True, "changes": {"name": result.get("name", ""), "path": result.get("path", ""), "available": True,
                "source": result.get("source") or "打开文件时", "diff": "\n".join(lines),
                "added": sum(x.startswith("+") and not x.startswith("+++") for x in lines),
                "removed": sum(x.startswith("-") and not x.startswith("---") for x in lines),
                "truncated": diff_truncated}}

    @app.get("/api/web-workspace/editors")
    async def remote_editors(request: Request, projectId: str = ""):
        _owner_runtime(request)
        return {"ok": True, "editors": []}
