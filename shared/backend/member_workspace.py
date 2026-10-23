"""Account-authenticated workspace transport; members never enter host handlers."""
from __future__ import annotations
import asyncio
import hmac
import http.client
import json
import uuid
from fastapi.responses import JSONResponse, Response, StreamingResponse
from .gateway import GatewayError


async def stream_workspace(request, gateway, route):
    path, _, headers = await gateway.request_parts("GET", route)
    headers["Accept"] = "text/event-stream"
    connection = gateway.make_connection(45)
    gateway.open_connections.add(connection)
    try:
        def open_stream():
            connection.request("GET", path, headers=headers)
            return connection.getresponse()
        response = await asyncio.to_thread(open_stream)
        if response.status != 200:
            connection.close()
            raise GatewayError("工作区实时连接暂不可用", response.status)
    except BaseException:
        connection.close()
        gateway.open_connections.discard(connection)
        raise

    async def events():
        try:
            while not await request.is_disconnected():
                line = await asyncio.to_thread(response.readline, 1024 * 1024)
                if not line:
                    break
                if len(line) >= 1024 * 1024:
                    raise GatewayError("终端消息超过接收上限", 413)
                yield line
        except (OSError, http.client.HTTPException):
            yield b'event: terminal\ndata: {"type":"exit","code":-1}\n\n'
        finally:
            connection.close()
            gateway.open_connections.discard(connection)
    return StreamingResponse(events(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"})


async def member_schedule_request(runtime, suffix, method, value):
    gateway = runtime.gateway
    listing = await gateway.json("GET", "sync/schedules")
    tasks = listing.get("tasks", [])
    if not suffix and method == "GET":
        return {**listing, "scheduler": {"available": True, "durable": True, "transport": "isolated",
            "pollIntervalMs": 2000, "requiresAppRunning": False}}
    parts = suffix.strip("/").split("/") if suffix else []
    identifier = parts[0] if parts else None
    prior = next((item for item in tasks if item.get("id") == identifier), None)
    if identifier and prior is None and method == "GET":
        raise GatewayError("定时任务不存在", 404)
    if len(parts) == 1 and method == "GET":
        return {"ok": True, "task": prior}
    if len(parts) == 2 and parts[1] == "share":
        return Response(json.dumps({"format": "shiyan-scheduled-task-v1", "task": prior}, ensure_ascii=False),
            media_type="application/json", headers={"Content-Disposition": 'attachment; filename="shiyan-task.json"'})
    control = len(parts) == 2 and parts[1] == "control"
    action = (value or {}).get("action") if control else None
    if control and action not in {"pause", "resume", "delete", "cancel"} or len(parts) > 1 and not control:
        return await gateway.json(method, "workspace/schedules" + suffix, value, timeout=90)
    if method not in {"POST", "PATCH", "DELETE"}:
        raise GatewayError("任务操作无效", 405)
    data = dict(value or {})
    request_id = data.get("requestId")
    if not isinstance(request_id, str) or not 8 <= len(request_id) <= 128:
        raise GatewayError("缺少有效请求标识", 400)
    # Persist the frozen revision and payload before sending, so an uncertain
    # network result can safely replay the same upstream idempotency receipt.
    saved = runtime.storage.setting("memberScheduleTransport", {})
    slot = method + ":" + suffix + ":" + request_id
    transport = saved.get(slot)
    if transport is None:
        if identifier and prior is None:
            raise GatewayError("定时任务不存在", 404)
        identifier = identifier or str(uuid.uuid5(uuid.NAMESPACE_URL, "shiyan-member-schedule:" + request_id))
        remove = method == "DELETE" or action in {"delete", "cancel"}
        task = {**(prior or {}), **{key: val for key, val in data.items() if key != "requestId"}, "runLocally": False}
        if control:
            task["enabled"] = action == "resume"
        transport = {"method": "DELETE" if remove else "PATCH" if prior else "POST",
            "route": "sync/schedules" + ("/" + identifier if prior else ""),
            "payload": {"requestId": request_id, "id": identifier,
                "revision": int((prior or {}).get("revision", 0)), **({} if remove else {"task": task})}}
        saved[slot] = transport
        while len(saved) > 256:
            saved.pop(next(iter(saved)))
        runtime.storage.set_setting("memberScheduleTransport", saved)
    return await gateway.json(transport["method"], transport["route"], transport["payload"], timeout=90)


async def proxy_member_request(request):
    """Run after local CSRF/session checks and before dispatch to local routes."""
    runtime = getattr(request.app.state, "runtime", None)
    if runtime is None or runtime.server_access:
        return None
    path = request.url.path
    workspace = path.startswith("/api/workspace/")
    scheduled = path == "/api/schedules" or path.startswith("/api/schedules/")
    if not workspace and not scheduled:
        return None
    gateway = runtime.gateway
    work = request.app.state.workbench
    suffix = path[len("/api/workspace/"):] if workspace else path[len("/api/schedules"):]
    if scheduled and suffix == "/pending":
        return None  # Idempotency receipts live in this account's local database.
    # Preferences and conversation selection mutate this account's local cache,
    # rather than touching any filesystem or spawning a local process.
    if workspace and (suffix == "preferences" or suffix.startswith("temporary-chats") or
                      suffix.startswith("projects/") and suffix.endswith("/select")):
        return None
    if workspace and suffix != "bootstrap" and not hmac.compare_digest(
            request.headers.get("x-shiyan-workspace", ""), work.token):
        raise GatewayError("工作区授权已失效，请重新打开应用", 403)
    if workspace and suffix == "bootstrap":
        if request.headers.get("x-shiyan-local") != "1":
            raise GatewayError("需要应用工作区请求", 403)
        # Existing project identities are preserved across all clients. Never
        # send a prior host path when registering an isolated workspace project.
        existing = await gateway.json("GET", "workspace/projects")
        known = {item["id"] for item in existing.get("projects", [])}
        for item in runtime.storage.list("projects"):
            if item["id"] not in known:
                await gateway.json("POST", "workspace/projects", {"id": item["id"], "name": item["name"]})
        result = await gateway.json("POST", "workspace/bootstrap", {})
        for item in result.get("projects", []):
            runtime.storage.put("projects", item)
        result.update(token=work.token, preferences=work.preferences(),
                      defaultDirectory="/workspace", terminalTransport="SSE", executionMode="isolated")
        return JSONResponse(result)
    if scheduled and suffix == "/models":
        caps = await gateway.connect()
        return JSONResponse({"ok": True, "local": {"available": False, "models": [], "error": None},
            "cloud": {"available": True, "models": caps.get("models", []), "connection": runtime.connection},
            "defaults": {"runLocally": False, "notificationMode": "important", "newChatEachRun": False,
                "timezone": "Asia/Shanghai", "model": caps.get("model"), "reasoning": caps.get("defaultReasoning")}})
    route = "workspace/" + suffix if workspace else "sync/schedules" + suffix
    if request.url.query:
        route += "?" + request.url.query
    if workspace and suffix.startswith("terminals/") and suffix.endswith("/events"):
        return await stream_workspace(request, gateway, route)
    value = None
    if request.method not in {"GET", "HEAD"}:
        raw = await request.body()
        if raw:
            try:
                value = json.loads(raw)
            except (ValueError, UnicodeDecodeError):
                raise GatewayError("请求格式无效", 400)
            if not isinstance(value, dict):
                raise GatewayError("请求格式无效", 400)
        if scheduled and value is not None:
            # A member's execution target is always the isolated server runtime.
            if "runLocally" in value:
                value = {**value, "runLocally": False}
    if scheduled:
        result = await member_schedule_request(runtime, suffix, request.method, value)
        return result if isinstance(result, Response) else JSONResponse(result, headers={"Cache-Control": "no-store"})
    if workspace and suffix.startswith("files/pdf/"):
        _, headers, data = await gateway.raw(request.method, route, value)
        return Response(data, media_type="application/pdf", headers={
            "Content-Disposition": "inline", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})
    if scheduled and suffix.endswith("/share"):
        _, headers, data = await gateway.raw(request.method, route, value)
        return Response(data, media_type="application/json", headers={"Content-Disposition": 'attachment; filename="shiyan-task.json"'})
    result = await gateway.json(request.method, route, value, timeout=90)
    if workspace and suffix.startswith("projects"):
        if request.method == "DELETE":
            identifier = suffix.split("/")[1]
            runtime.storage.remove("projects", identifier)
            for conversation in runtime.storage.list("conversations"):
                if conversation.get("projectId") == identifier:
                    conversation["projectId"] = None
                    runtime.save_conversation(conversation)
        for item in result.get("projects", []):
            runtime.storage.put("projects", item)
        if isinstance(result.get("project"), dict):
            runtime.storage.put("projects", result["project"])
        runtime.notify()
        if request.method == "DELETE":
            result["state"] = runtime.snapshot()
    if workspace and isinstance(result.get("previewUrl"), str):
        result["previewUrl"] = result["previewUrl"].replace("/v1/workspace/", "/api/workspace/")
    return JSONResponse(result, headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})
