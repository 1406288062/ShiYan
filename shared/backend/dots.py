 
from __future__ import annotations
import asyncio
import http.client
import json
import re
import uuid
from pathlib import Path
from fastapi import Request
from fastapi.responses import StreamingResponse, Response
from urllib.parse import quote
from .gateway import GatewayError


def register_dots(app):
    async def body(request):
        try:
            value = await request.json()
        except (ValueError, UnicodeDecodeError):
            raise ValueError("请求格式无效")
        if not isinstance(value, dict):
            raise ValueError("请求应为 JSON 对象")
        if not isinstance(value.get("requestId"), str) or not 8 <= len(value["requestId"]) <= 128:
            raise ValueError("缺少请求标识，请重新打开 Dots")
        return value

    async def remote(request, method, route, value=None):
        gateway = request.app.state.runtime.gateway
        await gateway.ensure_enrolled()
        return await gateway.json(method, "dots/" + route, value)

    def identifier(value):
        if value <= 0:
            raise ValueError("目标标识无效")
        return str(value)

    @app.get("/api/dots/local-state")
    async def local_state(request: Request):
         
         
        storage = request.app.state.runtime.storage
        return {"ok": True, "dotsState": storage.setting("dotsLocalState", {})}

    @app.patch("/api/dots/local-state")
    async def save_local_state(request: Request):
        try:
            data = await request.json()
        except (ValueError, UnicodeDecodeError):
            raise ValueError("Dots 本地状态格式无效")
        state = data.get("state") if isinstance(data, dict) else None
        if not isinstance(state, dict):
            raise ValueError("Dots 本地状态格式无效")
        allowed = {"selected", "goals", "details", "drafts", "pending", "cursor", "manager", "messages", "tasks", "readState"}
        state = {k: v for k, v in state.items() if k in allowed}
        if len(json.dumps(state, ensure_ascii=False).encode()) > 8 * 1024 * 1024:
            raise ValueError("Dots 本地记录过大，请先减少历史记录")
        request.app.state.runtime.storage.set_setting("dotsLocalState", state)
        return {"ok": True}

    @app.get("/api/dots/subscriptions")
    async def subscriptions(request: Request):
        return await remote(request, "GET", "subscriptions")

    @app.patch("/api/dots/subscriptions/{provider}")
    @app.put("/api/dots/subscriptions/{provider}")
    async def save_subscription(provider: str, request: Request):
        if provider not in {"github", "email", "google-calendar", "rss"}:
            raise ValueError("不支持的订阅类型")
        data = await request.json()
        if not isinstance(data, dict):
            raise ValueError("订阅格式无效")
        return await remote(request, "PATCH", "subscriptions/" + provider, data)

    @app.delete("/api/dots/subscriptions/{provider}")
    async def delete_subscription(provider: str, request: Request):
        if provider not in {"github", "email", "google-calendar", "rss"}:
            raise ValueError("不支持的订阅类型")
        return await remote(request, "DELETE", "subscriptions/" + provider)

    # 设置、连接器、微信、授权、做过的事、目标：转发给服务器上的 Dots。
    async def plain(request):
        try:
            value = await request.json()
        except (ValueError, UnicodeDecodeError):
            value = {}
        if not isinstance(value, dict):
            raise ValueError("请求格式无效")
        return value

    def positive(value):
        if value <= 0:
            raise ValueError("标识无效")
        return str(value)

    @app.get("/api/dots/settings")
    async def dots_settings(request: Request):
        return await remote(request, "GET", "settings")

    @app.patch("/api/dots/settings")
    async def save_dots_settings(request: Request):
        data = await plain(request)
        return await remote(request, "PATCH", "settings", {k: data[k] for k in ("approvalMode", "dailyBrief", "dailyBriefTime") if k in data})

    @app.get("/api/dots/connectors")
    async def dots_connectors(request: Request):
        return await remote(request, "GET", "connectors")

    # MCP 连接：常用插件（catalogId）或自定义地址（name/url/token）。
    def connector_id(value):
        if not re.fullmatch(r"[a-z0-9_-]{1,64}", value or ""):
            raise ValueError("连接标识无效")
        return value

    @app.post("/api/dots/connectors/mcp")
    async def connect_mcp(request: Request):
        data = await plain(request)
        payload = {k: str(data[k])[:4096] for k in ("catalogId", "name", "url", "token") if isinstance(data.get(k), str) and data[k].strip()}
        return await remote(request, "POST", "connectors/mcp", payload)

    @app.delete("/api/dots/connectors/mcp/{connector}")
    async def remove_mcp(connector: str, request: Request):
        return await remote(request, "DELETE", "connectors/mcp/" + connector_id(connector))

    @app.post("/api/dots/connectors/mcp/{connector}/refresh")
    async def refresh_mcp(connector: str, request: Request):
        return await remote(request, "POST", "connectors/mcp/" + connector_id(connector) + "/refresh", {})

    # 执行过程：每个步骤的标题与说明（服务端生成并缓存）。
    @app.post("/api/dots/steps/summary")
    async def step_summary(request: Request):
        data = await plain(request)
        steps = data.get("steps") if isinstance(data.get("steps"), list) else []
        return await remote(request, "POST", "steps/summary", {"steps": steps[:60]})

    @app.post("/api/dots/manager/messages/{message_id}/feedback")
    async def message_feedback(message_id: int, request: Request):
        data = await plain(request)
        return await remote(request, "POST", "manager/messages/" + positive(message_id) + "/feedback", {"value": data.get("value")})

    @app.get("/api/dots/weixin")
    async def weixin_status(request: Request):
        return await remote(request, "GET", "weixin")

    @app.patch("/api/dots/weixin")
    async def weixin_push(request: Request):
        data = await plain(request)
        return await remote(request, "PATCH", "weixin", {"enabled": data.get("enabled") is True})

    @app.delete("/api/dots/weixin")
    async def weixin_unbind(request: Request):
        return await remote(request, "DELETE", "weixin")

    @app.post("/api/dots/weixin/login")
    async def weixin_login(request: Request):
        return await remote(request, "POST", "weixin/login", {})

    @app.post("/api/dots/weixin/verify")
    async def weixin_verify(request: Request):
        data = await plain(request)
        return await remote(request, "POST", "weixin/verify", {"code": str(data.get("code", ""))[:16]})

    @app.get("/api/dots/approval-grants")
    async def approval_grants(request: Request):
        return await remote(request, "GET", "approval-grants")

    @app.delete("/api/dots/approval-grants/{grant_id}")
    async def revoke_grant(grant_id: int, request: Request):
        return await remote(request, "DELETE", "approval-grants/" + positive(grant_id))

    @app.get("/api/dots/audit")
    async def dots_audit(request: Request, before: int = 0, limit: int = 50, category: str = ""):
        query = f"audit?limit={min(200, max(1, limit))}"
        if before > 0:
            query += f"&before={before}"
        if category:
            if category not in {"action", "message", "change"}:
                raise ValueError("类别无效")
            query += "&category=" + category
        return await remote(request, "GET", query)

    @app.get("/api/dots/life-goals")
    async def life_goals(request: Request):
        return await remote(request, "GET", "life-goals")

    @app.post("/api/dots/life-goals")
    async def create_life_goal(request: Request):
        return await remote(request, "POST", "life-goals", await plain(request))

    @app.patch("/api/dots/life-goals/{goal_id}")
    async def update_life_goal(goal_id: int, request: Request):
        return await remote(request, "PATCH", "life-goals/" + positive(goal_id), await plain(request))

    @app.delete("/api/dots/life-goals/{goal_id}")
    async def delete_life_goal(goal_id: int, request: Request):
        return await remote(request, "DELETE", "life-goals/" + positive(goal_id))

    @app.post("/api/dots/life-goals/{goal_id}/milestones")
    async def life_goal_milestone(goal_id: int, request: Request):
        return await remote(request, "POST", "life-goals/" + positive(goal_id) + "/milestones", await plain(request))

    @app.post("/api/dots/life-goals/{goal_id}/replan")
    async def replan_life_goal(goal_id: int, request: Request):
        return await remote(request, "POST", "life-goals/" + positive(goal_id) + "/replan", {})

    @app.get("/api/dots/capabilities")
    async def capabilities(request: Request):
        return await remote(request, "GET", "capabilities")

    @app.post("/api/dots/attachments")
    async def upload_attachment(request: Request):
        data = await request.json()
        if not isinstance(data, dict):
            raise ValueError("文件数据无效")
        return await remote(request, "POST", "attachments", data)

    @app.get("/api/dots/attachments/{attachment_id}")
    async def download_attachment(attachment_id: str, request: Request):
        attachment_id = str(uuid.UUID(attachment_id))
        gateway = request.app.state.runtime.gateway
        await gateway.ensure_enrolled()
        _, headers, data = await gateway.raw("GET", "dots/attachments/" + attachment_id)
        return Response(data, media_type="application/octet-stream", headers={
            "Content-Disposition": headers.get("content-disposition", "attachment"),
            "Content-Security-Policy": "sandbox; default-src 'none'",
        })

    @app.get("/api/dots/relationship")
    async def relationship(request: Request):
        return await remote(request, "GET", "relationship")

    async def relationship_body(request):
        data = await request.json()
        if not isinstance(data, dict):
            raise ValueError("话题格式无效")
        return data

    def topic_identifier(value):
        if not 1 <= len(value) <= 128 or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for c in value):
            raise ValueError("话题标识无效")
        return quote(value, safe="")

    @app.patch("/api/dots/relationship/topics/{topic_id}")
    async def save_relationship_topic(topic_id: str, request: Request):
        data = await relationship_body(request)
        if not set(data).issubset({"title", "summary", "openQuestion", "revision"}):
            raise ValueError("话题格式无效")
        return await remote(request, "PATCH", "relationship/topics/" + topic_identifier(topic_id), data)

    @app.delete("/api/dots/relationship/topics/{topic_id}")
    async def delete_relationship_topic(topic_id: str, request: Request):
        return await remote(request, "DELETE", "relationship/topics/" + topic_identifier(topic_id))

    @app.get("/api/dots/profile")
    async def profile(request: Request):
        storage = request.app.state.runtime.storage
        value = storage.setting("dotsProfile", {})
        try:
            shared = (await remote(request, "GET", "profile")).get("profile", {})
            if not shared.get("petId") and value.get("petId"):
                initial = {k: value[k] for k in ("name", "accent", "petId") if k in value}
                shared = (await remote(request, "PATCH", "profile", initial)).get("profile", {})
            value.update({k: shared[k] for k in ("name", "accent", "petId") if k in shared})
            storage.set_setting("dotsProfile", value)
        except GatewayError:
            pass   
        return {"ok": True, "profile": value}

    @app.patch("/api/dots/profile")
    async def save_profile(request: Request):
        data = await request.json()
        if not isinstance(data, dict) or not set(data).issubset({"name", "accent", "petId", "seenActivities"}):
            raise ValueError("个人设置格式无效")
        storage = request.app.state.runtime.storage
        value = storage.setting("dotsProfile", {})
        if "name" in data:
            name = str(data["name"]).strip()
            if not name or len(name) > 40:
                raise ValueError("名称需要 1 到 40 个字")
            value["name"] = name
        if "accent" in data:
            accent = str(data["accent"])
            if accent not in {"#bdc4d5", "#00b4ef", "#ffd139", "#d469da", "#bada10", "#ed729c", "#f79557", "#7293f1"}:
                raise ValueError("请选择可用颜色")
            value["accent"] = accent
        if "petId" in data:
            manifest = pets_manifest(request)
            if data["petId"] not in {p["id"] for p in manifest.get("pets", [])}:
                raise ValueError("桌宠不存在，请重新选择")
            value["petId"] = data["petId"]
        if "seenActivities" in data:
            seen = data["seenActivities"]
            if not isinstance(seen, dict) or len(seen) > 500 or any(not isinstance(k, str) or len(k) > 100 or not isinstance(v, (int, float)) or v < 0 for k, v in seen.items()):
                raise ValueError("活动阅读记录无效")
            value["seenActivities"] = seen
        shared_fields = {k: value[k] for k in ("name", "accent", "petId") if k in data}
        if shared_fields:
            await remote(request, "PATCH", "profile", shared_fields)
        storage.set_setting("dotsProfile", value)
        return {"ok": True, "profile": value}

    def pets_manifest(request):
        file = request.app.state.runtime.root / "web" / "assets" / "dots-pets" / "manifest.json"
        if not file.is_file():
            return {"pets": [], "active_pet_id": None}
        manifest = json.loads(file.read_text())
        for pet in manifest.get("pets", []):
            for key in ["preview_url", "thumbnail_url", "sprite_url"]:
                if key in pet:
                    pet[key] = pet[key].replace("/static/dots-pets/", "/assets/dots-pets/")
        return manifest

    @app.get("/api/dots/pets")
    async def pets(request: Request):
        return {"ok": True, **pets_manifest(request)}

    @app.get("/api/dots/activity")
    async def activity(request: Request):
        return await remote(request, "GET", "activity")

    @app.get("/api/dots/goals/{goal_id}/conversation")
    async def conversation(goal_id: int, request: Request):
        return await remote(request, "GET", "goals/" + identifier(goal_id) + "/conversation")

    @app.get("/api/dots/schedules")
    async def schedules(request: Request):
        return await remote(request, "GET", "schedules")

    @app.post("/api/dots/schedules")
    async def create_schedule(request: Request):
        return await remote(request, "POST", "schedules", await body(request))

    @app.get("/api/dots/schedules/{schedule_id}")
    async def schedule(schedule_id: str, request: Request):
        return await remote(request, "GET", "schedules/" + str(uuid.UUID(schedule_id)))

    @app.patch("/api/dots/schedules/{schedule_id}")
    async def save_schedule(schedule_id: str, request: Request):
        return await remote(request, "PATCH", "schedules/" + str(uuid.UUID(schedule_id)), await body(request))

    @app.post("/api/dots/schedules/{schedule_id}/control")
    async def schedule_control(schedule_id: str, request: Request):
        return await remote(request, "POST", "schedules/" + str(uuid.UUID(schedule_id)) + "/control", await body(request))

    async def remote_file(request, route):
        gateway = request.app.state.runtime.gateway
        await gateway.ensure_enrolled()
        _, headers, data = await gateway.raw("GET", "dots/" + route)
        return Response(data, media_type=headers.get("content-type", "application/octet-stream"), headers={
            "Content-Disposition": headers.get("content-disposition", "attachment"),
            "Content-Security-Policy": "sandbox; default-src 'none'",
        })

    @app.get("/api/dots/outputs/{output_id}/file")
    async def output_file(output_id: int, request: Request):
        return await remote_file(request, "outputs/" + identifier(output_id) + "/file")

    @app.get("/api/dots/artifacts/{goal_id}/{artifact_path}")
    async def artifact(goal_id: int, artifact_path: str, request: Request):
        if not artifact_path or len(artifact_path) > 2048 or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for c in artifact_path):
            raise ValueError("作品标识无效")
        return await remote_file(request, "artifacts/" + identifier(goal_id) + "/" + artifact_path)

    @app.get("/api/dots/manager")
    async def manager(request: Request):
        return await remote(request, "GET", "manager")

    @app.get("/api/dots/manager/messages")
    async def manager_history(request: Request, before: int = 0, limit: int = 100):
        return await remote(request, "GET", f"manager/messages?before={max(0,before)}&limit={min(200,max(1,limit))}")

    @app.post("/api/dots/manager/messages")
    async def manager_message(request: Request):
        data = await body(request)
        data["host"] = "shiyan_desktop"
        if not isinstance(data.get("message"), str) or not data["message"].strip():
            raise ValueError("请输入给总管的交代")
        return await remote(request, "POST", "manager/messages", data)

    @app.post("/api/dots/manager/control")
    async def manager_control(request: Request):
        data = await body(request)
        if data.get("action") not in {"pause", "resume", "cancel", "wake"}:
            raise ValueError("总管操作无效")
        return await remote(request, "POST", "manager/control", data)

    @app.get("/api/dots/manager/activity")
    async def manager_activity(request: Request, after: int = 0, limit: int = 100):
        return await remote(request, "GET", f"manager/activity?after={max(0,after)}&limit={min(200,max(1,limit))}")

    @app.get("/api/dots/goals")
    async def goals(request: Request, after: int = 0, limit: int = 100):
        return await remote(request, "GET", f"goals?after={max(0,after)}&limit={min(200,max(1,limit))}")

    @app.post("/api/dots/goals")
    async def create(request: Request):
        data = await body(request)
        data["host"] = "shiyan_desktop"
        data.setdefault("runNow", True)
        if not isinstance(data.get("instruction"), str) or not data["instruction"].strip():
            raise ValueError("请输入目标")
        if not isinstance(data.get("title"), str) or not data["title"].strip():
            data["title"] = next((line.strip() for line in data["instruction"].splitlines() if line.strip()), "新目标")[:80]
        return await remote(request, "POST", "goals", data)

    @app.get("/api/dots/goals/{goal_id}")
    async def detail(goal_id: int, request: Request):
        return await remote(request, "GET", "goals/" + identifier(goal_id))

    @app.post("/api/dots/goals/{goal_id}/instruct")
    async def instruct(goal_id: int, request: Request):
        data = await body(request)
        if not isinstance(data.get("message"), str) or not data["message"].strip():
            raise ValueError("请输入补充要求")
        return await remote(request, "POST", "goals/" + identifier(goal_id) + "/instruct", data)

    @app.post("/api/dots/goals/{goal_id}/control")
    async def control(goal_id: int, request: Request):
        data = await body(request)
        if data.get("action") not in {"pause", "resume", "cancel", "wake"}:
            raise ValueError("目标操作无效")
        return await remote(request, "POST", "goals/" + identifier(goal_id) + "/control", data)

    @app.get("/api/dots/outputs/{output_id}")
    async def output(output_id: int, request: Request):
        return await remote(request, "GET", "outputs/" + identifier(output_id))

    @app.post("/api/dots/goals/{goal_id}/approvals/{approval_id}/decision")
    async def decide(goal_id: int, approval_id: int, request: Request):
        data = await body(request)
        if data.get("decision") not in {"approve", "reject"}:
            raise ValueError("审批操作无效")
        if data["decision"] == "approve" and not isinstance(data.get("confirmedCommand"), str):
            raise ValueError("请先核对要执行的命令")
        return await remote(request, "POST", f"goals/{identifier(goal_id)}/approvals/{identifier(approval_id)}/decision", data)

    @app.post("/api/dots/notifications/ack")
    async def acknowledge(request: Request):
        try:
            data = await request.json()
            cursor = int(data.get("cursor", 0))
        except (ValueError, TypeError, AttributeError):
            raise ValueError("通知游标无效")
        if cursor < 0:
            raise ValueError("通知游标无效")
        storage = request.app.state.runtime.storage
        consumer = storage.setting("dotsConsumerId")
        if not consumer:
            consumer = "shiyan-desktop-" + str(uuid.uuid4())
            storage.set_setting("dotsConsumerId", consumer)
        return await remote(request, "POST", "notifications/ack", {"consumerId": consumer, "cursor": cursor})

    @app.get("/api/dots/events")
    async def events(request: Request, after: int = 0):
        gateway = request.app.state.runtime.gateway
         
         
        await gateway.ensure_enrolled()
        path, _, headers = await gateway.request_parts("GET", f"dots/events?after={max(0,after)}")
        headers["Accept"] = "text/event-stream"

        async def stream():
            conn = gateway.make_connection(40)
            gateway.open_connections.add(conn)
            try:
                def open_stream():
                    conn.request("GET", path, headers=headers)
                    return conn.getresponse()
                response = await asyncio.to_thread(open_stream)
                if response.status != 200:
                    raise GatewayError(f"Dots 实时连接失败（{response.status}）", response.status)
                yield 'event: connected\ndata: {}\n\n'
                fields, length = [], 0
                while not await request.is_disconnected():
                    line = await asyncio.to_thread(response.readline, 1024 * 1024)
                    if not line:
                        return
                    length += len(line)
                    if length > 4 * 1024 * 1024:
                        raise GatewayError("Dots 事件过大")
                    line = line.rstrip(b"\r\n")
                    if not line:
                        if fields:
                            event = json.loads(b"\n".join(fields))
                            sequence = int(event.get("seq", 0))
                            if sequence > 0:
                                yield f"id: {sequence}\nevent: update\ndata: " + json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n\n"
                        else:
                            yield ': keepalive\n\n'
                        fields, length = [], 0
                    elif line.startswith(b"data:"):
                        fields.append(line[5:].lstrip(b" "))
                    elif line.startswith(b":"):
                        yield ': keepalive\n\n'
            except (GatewayError, OSError, http.client.HTTPException, ValueError, TypeError) as error:
                if isinstance(error, GatewayError):
                    gateway.remember_authorization_error(error)
                yield 'event: connection-error\ndata: ' + json.dumps({"error": "Dots 实时连接中断，正在重连"}, ensure_ascii=False) + '\n\n'
            finally:
                conn.close()
                gateway.open_connections.discard(conn)
        return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"})

