 
from __future__ import annotations
import asyncio
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import re
import uuid
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from fastapi import Request
from fastapi.responses import Response
from .storage import now, new_id

REPEATS = {"once", "hourly", "daily", "weekdays", "weekly", "monthly"}
TERMINAL = {"completed", "failed", "cancelled", "interrupted"}
FIELDS = {"requestId", "title", "instruction", "emoji", "enabled", "repeat", "time", "timezone", "startDate", "endDate",
    "runLocally", "notificationMode", "newChatEachRun", "model", "reasoning", "projectId"}


def instant(value):
    return datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone(timezone.utc)


def stamp(value):
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def next_run(task, after=None):
    if not task.get("enabled"):
        return None
    after = after or datetime.now(timezone.utc)
    zone = ZoneInfo(task["timezone"])
    local = after.astimezone(zone)
    anchor = datetime.fromisoformat(task["startDate"]).date()
    end = datetime.fromisoformat(task["endDate"]).date() if task.get("endDate") else None
    first = max(local.date(), anchor)
    hour, minute = map(int, task["time"].split(":"))
    if task["repeat"] == "once" and first > anchor:
        return None
    for offset in range(740):
        date = first + timedelta(days=offset)
        if end and date > end:
            return None
        if task["repeat"] == "once" and date != anchor:
            return None
        if task["repeat"] == "weekdays" and date.weekday() >= 5:
            continue
        if task["repeat"] == "weekly" and date.weekday() != anchor.weekday():
            continue
        if task["repeat"] == "monthly":
            next_month = date.replace(day=28) + timedelta(days=4)
            last = (next_month - timedelta(days=next_month.day)).day
            if date.day != min(anchor.day, last):
                continue
        hours = range(24) if task["repeat"] == "hourly" else [hour]
        for selected_hour in hours:
            candidate = datetime(date.year, date.month, date.day, selected_hour, minute, tzinfo=zone)
            utc = candidate.astimezone(timezone.utc)
             
            if utc.astimezone(zone).replace(tzinfo=None) != candidate.replace(tzinfo=None):
                continue
            if utc > after:
                return stamp(utc)
    return None


def stable(identifier, kind):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, "shiyan-desktop-schedule:" + identifier + ":" + kind))


class DesktopSchedules:
    def __init__(self, runtime):
        self.runtime, self.storage = runtime, runtime.storage
        self.lock = asyncio.Lock()
        self.closed = False

    def task(self, identifier):
        value = self.storage.get("scheduledTasks", identifier)
        if not value:
            raise ValueError("定时任务不存在")
        return value

    def owns(self, task):
        identity = (self.runtime.gateway.public_identity or {}).get("deviceID")
        return not task.get("executorDeviceId") or task.get("executorDeviceId") == identity

    def require_host(self, task):
        if not self.owns(task):
            raise ValueError("此任务需要在原执行 Mac 上操作")

    def pending_stop(self, identifier):
        pending = self.storage.setting("schedulePending", {})
        if not isinstance(pending, dict):
            return False
        request = pending.get("control:" + identifier)
        return isinstance(pending.get("delete:" + identifier), dict) or isinstance(request, dict) and request.get("action") in {"pause", "delete", "cancel"}

    @staticmethod
    def public(task):
        return {k: v for k, v in task.items() if k not in {"lastResultHash", "activeRunId"}}

    def listing(self):
        tasks = sorted(self.storage.list("scheduledTasks"), key=lambda x: (x.get("nextRunAt") is None,
            x.get("nextRunAt") or "", x.get("createdAt", "")))
        return {"ok": True, "tasks": [self.public(x) for x in tasks], "scheduler": {
            "available": True, "durable": True, "transport": "desktop", "pollIntervalMs": 2000,
            "requiresAppRunning": True, "missedRuns": "one-catch-up-run", "automaticRetry": False}}

    def models(self, local, error=None):
        caps = self.runtime.capabilities
        cloud = caps.get("models") or []
        return {"ok": True, "local": {"available": bool(local) and not error, "models": local, "error": error},
            "cloud": {"available": bool(cloud), "models": cloud, "connection": self.runtime.connection},
            "defaults": {"runLocally": True, "notificationMode": "important", "newChatEachRun": False,
                "timezone": "Asia/Shanghai", "model": caps.get("model"), "reasoning": caps.get("defaultReasoning")}}

    async def validate(self, data, prior=None):
        if not isinstance(data, dict) or not set(data).issubset(FIELDS):
            raise ValueError("定时任务包含不支持的字段")
        value = {**(prior or {}), **{k: v for k, v in data.items() if k != "requestId"}}
        text = value.get("instruction")
        if not isinstance(text, str) or not text.strip() or len(text) > 20000:
            raise ValueError("请输入最多 20000 字的任务说明")
        value["instruction"] = text.strip()
        title = value.get("title") or text.strip().splitlines()[0][:40]
        if not isinstance(title, str) or not title.strip() or len(title) > 200:
            raise ValueError("任务名称需要 1 到 200 个字")
        value["title"] = title.strip()
        zone = value.setdefault("timezone", "Asia/Shanghai")
        try:
            if not isinstance(zone, str) or len(zone) > 100:
                raise ValueError()
            location = ZoneInfo(zone)
        except (ValueError, ZoneInfoNotFoundError):
            raise ValueError("时区无效")
        value.setdefault("enabled", True)
        value.setdefault("repeat", "daily")
        value.setdefault("time", "09:00")
        value.setdefault("startDate", datetime.now(location).date().isoformat())
        value.setdefault("endDate", None)
        for field, default in [("runLocally", True), ("newChatEachRun", False)]:
            value.setdefault(field, default)
            if not isinstance(value[field], bool):
                raise ValueError("任务运行选项无效")
        value.setdefault("notificationMode", "important")
        if value["notificationMode"] not in {"important", "all", "none"}:
            raise ValueError("通知选项无效")
        if not isinstance(value["enabled"], bool) or value["repeat"] not in REPEATS or not isinstance(value["time"], str) or not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", value["time"]):
            raise ValueError("执行频率或时间无效")
        for key in ("startDate", "endDate"):
            if key == "endDate" and value[key] is None:
                continue
            try:
                if not isinstance(value[key], str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value[key]):
                    raise ValueError()
                datetime.fromisoformat(value[key])
            except ValueError:
                raise ValueError("开始或结束日期无效")
        if value["endDate"] and value["endDate"] < value["startDate"]:
            raise ValueError("结束日期不能早于开始日期")
        if value["runLocally"]:
            choices = await self.runtime.mac_codex.models()
        else:
            choices = self.runtime.capabilities.get("models") or []
        if not choices:
            raise ValueError("暂时无法读取可用模型，请连接服务后重试")
        candidate = value.get("model") or self.runtime.capabilities.get("model")
        capability = next((x for x in choices if x["id"] == candidate), None)
        if not capability and value.get("model"):
            raise ValueError("当前运行位置不支持所选模型")
        capability = capability or choices[0]
        value["model"] = capability["id"]
        value.setdefault("reasoning", capability["defaultReasoning"])
        if value["reasoning"] not in capability["reasoningEfforts"]:
            raise ValueError("当前模型不支持所选强度")
        value.setdefault("projectId", None)
        if value["projectId"] is not None and not isinstance(value["projectId"], str):
            raise ValueError("任务项目无效")
        if value["projectId"] and not self.storage.get("projects", value["projectId"]):
            raise ValueError("任务项目不存在")
        if prior and (value["runLocally"] != prior["runLocally"] or value["projectId"] != prior.get("projectId")):
            value["conversationId"] = None   
        return value

    @staticmethod
    def request_id(data):
        identifier = data.get("requestId")
        if not isinstance(identifier, str) or not re.fullmatch(r"[A-Za-z0-9_-]{8,128}", identifier):
            raise ValueError("缺少有效请求标识")
        return identifier

    def replay(self, data, operation):
        identifier = self.request_id(data)
        digest = hashlib.sha256(json.dumps([operation, data], sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        previous = self.storage.get("scheduleReceipts", identifier)
        if previous:
            if previous["digest"] != digest:
                raise ValueError("请求标识已用于不同操作")
            return identifier, digest, previous["response"]
        return identifier, digest, None

    def commit(self, identifier, digest, response, task=None, remove=None):
         
        with self.storage.lock, self.storage.db:
            previous = self.storage.get("scheduledTasks", task["id"] if task else remove) if task or remove else None
            if task:
                self.storage.db.execute("INSERT INTO documents(kind,id,data) VALUES('scheduledTasks',?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data",
                    (task["id"], json.dumps(task, ensure_ascii=False)))
            if remove:
                self.storage.db.execute("DELETE FROM documents WHERE kind='scheduledTasks' AND id=?", (remove,))
            if self.storage.sync_observer and (task or remove):
                self.storage.sync_observer("scheduledTasks", task, previous)
            receipt = {"id": identifier, "digest": digest, "response": response, "createdAt": now()}
            self.storage.db.execute("INSERT INTO documents(kind,id,data) VALUES('scheduleReceipts',?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data",
                (identifier, json.dumps(receipt, ensure_ascii=False)))
        self.runtime.notify()
        return response

    async def save(self, data, identifier=None):
        async with self.lock:
            request, digest, response = self.replay(data, "update:" + identifier if identifier else "create")
            if response:
                return response
            prior = self.task(identifier) if identifier else None
            if prior:
                self.require_host(prior)
            value = await self.validate(data, prior)
            if prior and prior.get("activeRunId"):
                active = self.storage.get("scheduleRuns", prior["activeRunId"])
                if active and active["state"] not in TERMINAL and any(value[k] != prior[k] for k in ("runLocally", "model", "reasoning", "projectId")):
                    raise ValueError("请等待当前执行完成后再更改运行位置或模型")
            value.update(id=identifier or new_id(), source="desktop", createdAt=prior["createdAt"] if prior else now(), updatedAt=now(),
                revision=(prior or {}).get("revision", 0) + 1, conversationId=value.get("conversationId"), lastRunAt=value.get("lastRunAt"))
            value["executorDeviceId"] = (await self.runtime.gateway.identity())["deviceID"]
            value["nextRunAt"] = next_run(value, datetime.now(timezone.utc) - timedelta(milliseconds=1))
            if value["enabled"] and not value["nextRunAt"]:
                raise ValueError("执行时间已过去，请选择未来时间")
            value["status"] = "enabled" if value["enabled"] else "paused"
            return self.commit(request, digest, {"ok": True, "task": self.public(value)}, task=value)

    def runs(self, identifier):
        return sorted((x for x in self.storage.list("scheduleRuns") if x["taskId"] == identifier),
            key=lambda x: x["createdAt"], reverse=True)[:100]

    def conversation(self, identifier):
        task = self.task(identifier)
        conversation = self.storage.get("conversations", task.get("conversationId") or "")
        return {"ok": True, "task": self.public(task), "conversation": conversation,
            "messages": [{**m, "content": m.get("text", "")} for m in (conversation or {}).get("messages", [])], "runs": self.runs(identifier)}

    def claim(self, task, request_id, due=None, instruction=None, followup=False, execution=None):
        self.require_host(task)
        run_id = stable(request_id, "run")
        existing = self.storage.get("scheduleRuns", run_id)
        if existing:
            return existing
        if task.get("activeRunId"):
            active = self.storage.get("scheduleRuns", task["activeRunId"])
            if active and active["state"] not in TERMINAL:
                raise ValueError("此任务正在执行，请等待完成")
        if followup or not task["newChatEachRun"]:
            conversation_id = task.get("conversationId")
            if not conversation_id or not self.storage.get("conversations", conversation_id):
                conversation_id = stable(run_id, "conversation")
        else:
            conversation_id = stable(run_id, "conversation")
        previous = self.storage.get("conversations", conversation_id)
        if previous and (self.runtime.is_busy(previous) or previous.get("messageQueue") or previous.get("queuePaused")):
            raise ValueError("对应对话正在处理其他消息")
         
        options = execution or task
        run = {"id": run_id, "taskId": task["id"], "state": "prepared", "createdAt": now(), "dueAt": due,
            "conversationId": conversation_id, "requestId": stable(run_id, "request"),
            "userMessageId": stable(run_id, "user"), "assistantMessageId": stable(run_id, "assistant"),
            "instruction": instruction or task["instruction"], "title": task["title"], "projectId": task.get("projectId"),
            "runLocally": options["runLocally"], "model": options["model"], "reasoning": options["reasoning"],
            "notificationMode": task["notificationMode"], "followup": followup}
        if due:
            run["scheduleConfig"] = {key: task.get(key) for key in FIELDS - {"requestId"}}
        task.update(activeRunId=run_id, conversationId=conversation_id, lastRunAt=run["createdAt"], updatedAt=now())
        if due:
            task["nextRunAt"] = next_run(task)
        with self.storage.lock, self.storage.db:
            for kind, value in [("scheduleRuns", run), ("scheduledTasks", task)]:
                self.storage.db.execute("INSERT INTO documents(kind,id,data) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data",
                    (kind, value["id"], json.dumps(value, ensure_ascii=False)))
            if self.storage.sync_observer:
                self.storage.sync_observer("scheduledTasks", task, None)
        return run

    async def dispatch(self, run):
        task = self.storage.get("scheduledTasks", run["taskId"])
        if not task or not self.owns(task):
            return
        identifier = run["conversationId"]
        conversation = self.storage.get("conversations", identifier)
        if not conversation:
            conversation = {"id": identifier, "projectId": run.get("projectId"), "title": run["title"], "titleIsManual": True,
                "titleWasGenerated": False, "isPinned": False, "hasUnread": False, "createdAt": now(), "updatedAt": now(),
                "lastOpenedAt": None, "reasoning": run["reasoning"], "model": run["model"], "draft": "", "draftAssets": [],
                "activeImageId": None, "messages": [], "pendingJobId": None, "pendingMessageId": None,
                "lastEventId": 0, "threadId": None, "remoteConversationId": identifier, "scheduledTaskId": run["taskId"],
                "executionTransport": "mac" if run["runLocally"] else "cloud"}
        message = next((m for m in conversation["messages"] if m["id"] == run["assistantMessageId"]), None)
        if not message:
            if self.runtime.is_busy(conversation):
                return   
            user = {"id": run["userMessageId"], "role": "user", "text": run["instruction"], "assets": [],
                "state": "completed", "createdAt": run["createdAt"], "phase": "", "error": None, "requestId": run["requestId"]}
            message = {"id": run["assistantMessageId"], "role": "assistant", "text": "", "assets": [],
                "state": "submitting", "createdAt": now(), "phase": "发送中", "error": None, "requestId": run["requestId"],
                "reasoning": run["reasoning"], "model": run["model"], "requestStartedAt": run["createdAt"], "rawResult": None,
                "localExecution": run["runLocally"]}
            conversation["messages"].extend([user, message])
            conversation.update(pendingMessageId=message["id"], pendingJobId=None, lastEventId=0,
                updatedAt=now(), model=run["model"], reasoning=run["reasoning"])
            self.runtime.save_conversation(conversation)
        run.update(state="dispatched", updatedAt=now())
        self.storage.put("scheduleRuns", run)
        if message["state"] not in TERMINAL:
            self.runtime.launch("conversation:" + identifier, self.runtime.run_agent(identifier))

    async def control(self, identifier, data):
        if set(data) - {"requestId", "action"} or data.get("action") not in {"pause", "resume", "run", "delete", "cancel"}:
            raise ValueError("任务操作无效")
        async with self.lock:
            request, digest, response = self.replay(data, "control:" + identifier)
            if response:
                return response
            task = self.task(identifier)
            self.require_host(task)
            action = data["action"]
            if action in {"delete", "cancel"}:
                return self.commit(request, digest, {"ok": True, "id": identifier, "deleted": True}, remove=identifier)
            if action in {"pause", "resume"}:
                task["enabled"] = action == "resume"
                task["nextRunAt"] = next_run(task) if task["enabled"] else None
                if task["enabled"] and not task["nextRunAt"]:
                    raise ValueError("此任务已结束，请编辑执行时间后继续")
                task.update(status="enabled" if task["enabled"] else "paused", updatedAt=now(), revision=task["revision"] + 1)
                return self.commit(request, digest, {"ok": True, "task": self.public(task)}, task=task)
             
            run = self.claim(task, request)
            await self.dispatch(run)
            return self.commit(request, digest, {"ok": True, "task": self.public(task), "run": run, "conversationId": run["conversationId"]})

    async def reply(self, identifier, data):
        if set(data) - {"requestId", "message", "model", "reasoning"}:
            raise ValueError("回复包含不支持的字段")
        message = data.get("message")
        if not isinstance(message, str) or not message.strip() or len(message) > 20000:
            raise ValueError("请输入最多 20000 字的回复")
        async with self.lock:
            request, digest, response = self.replay(data, "reply:" + identifier)
            if response:
                return response
            task = self.task(identifier)
             
            turn = await self.validate({"instruction": task["instruction"], **{k: data[k] for k in ("model", "reasoning") if k in data}}, task)
            run = self.claim(task, request, instruction=message.strip(), followup=True, execution=turn)
            await self.dispatch(run)
            task.update(activeRunId=run["id"], conversationId=run["conversationId"], lastRunAt=run["createdAt"], updatedAt=now())
            self.storage.put("scheduledTasks", task)
            return self.commit(request, digest, {"ok": True, "task": self.public(task), "conversationId": run["conversationId"], "run": run})

    async def notification(self, task, run, message):
        mode = run.get("notificationMode", "important")
        digest = hashlib.sha256(str(message.get("text") or message.get("error") or "").encode()).hexdigest()
        important = message["state"] != "completed" or digest != task.get("lastResultHash")
        task["lastResultHash"] = digest
        if mode == "none" or mode == "important" and not important:
            run["notificationState"] = "suppressed"
            return
        body = (message.get("error") or message.get("text") or "任务已完成").replace("\n", " ")[:160]
        title = task["title"][:80]
         
        script = 'on run argv\n display notification (item 2 of argv) with title (item 1 of argv)\nend run'
        try:
            process = await asyncio.create_subprocess_exec("/usr/bin/osascript", "-e", script, title, body,
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
            try:
                code = await asyncio.wait_for(process.wait(), 5)
            except asyncio.TimeoutError:
                process.terminate()
                await process.wait()
                code = -1
            run["notificationState"] = "requested" if code == 0 else "unavailable"
        except OSError:
            run["notificationState"] = "unavailable"

    async def reconcile(self):
        for run in self.storage.list("scheduleRuns"):
            if run["state"] == "prepared":
                task = self.storage.get("scheduledTasks", run["taskId"])
                if task:
                    if run.get("dueAt"):
                        snapshot = run.get("scheduleConfig") or {key: run[key] for key in ("instruction", "runLocally", "model", "reasoning", "projectId") if key in run}
                        if not task.get("enabled") or any(task.get(key) != value for key, value in snapshot.items()):
                            run.update(state="cancelled", reconciled=True, updatedAt=now(), completedAt=now())
                            self.storage.put("scheduleRuns", run)
                            if task.get("activeRunId") == run["id"]:
                                task["activeRunId"] = None
                                self.storage.put("scheduledTasks", task)
                            continue
                        if self.pending_stop(run["taskId"]):
                            continue
                    await self.dispatch(run)
                else:
                    run.update(state="cancelled", reconciled=True, updatedAt=now())
                    self.storage.put("scheduleRuns", run)
            if run["state"] in TERMINAL and run.get("reconciled"):
                continue
            conversation = self.storage.get("conversations", run["conversationId"])
            message = next((m for m in (conversation or {}).get("messages", []) if m["id"] == run["assistantMessageId"]), None)
            if not message or message["state"] not in TERMINAL:
                continue
            run.update(state=message["state"], completedAt=message.get("completedAt") or now(), updatedAt=now(),
                error=message.get("error"), usage=message.get("usage"))
            task = self.storage.get("scheduledTasks", run["taskId"])
            if task:
                 
                 
                if not run.get("notificationState"):
                    run["notificationState"] = "claimed"
                    self.storage.put("scheduleRuns", run)
                    await self.notification(task, run, message)
                else:
                    task["lastResultHash"] = hashlib.sha256(str(message.get("text") or message.get("error") or "").encode()).hexdigest()
                if task.get("activeRunId") == run["id"]:
                    task["activeRunId"] = None
                if task["enabled"] and not task.get("nextRunAt"):
                    task.update(enabled=False, status="completed")
                task.update(updatedAt=now(), lastRunState=message["state"], lastError=message.get("error"))
                self.storage.put("scheduledTasks", task)
            run["reconciled"] = True
            self.storage.put("scheduleRuns", run)
            self.runtime.notify()

    async def tick(self):
        async with self.lock:
            await self.reconcile()
            current = datetime.now(timezone.utc)
            for task in self.storage.list("scheduledTasks"):
                if not self.owns(task) or not task["enabled"] or not task.get("nextRunAt") or instant(task["nextRunAt"]) > current or self.pending_stop(task["id"]):
                    continue
                try:
                    await self.validate({k: task[k] for k in FIELDS if k in task}, task)
                    engine = self.runtime.sync
                    entity = engine._entity("scheduledTasks", task["id"])
                    pending = self.storage.db.execute("SELECT 1 FROM sync_outbox WHERE kind='scheduledTasks' AND id=?", (task["id"],)).fetchone()
                    if not entity or not entity["revision"] or pending:
                        continue
                    request = stable(task["id"], task["nextRunAt"])
                    lease = {"requestId": request, "revision": entity["revision"], "dueAt": task["nextRunAt"]}
                    saved = self.storage.setting("scheduleLeasePending", {})
                    slot = task["id"] + ":" + task["nextRunAt"]
                    lease = saved.get(slot) or lease
                    saved[slot] = lease
                    self.storage.set_setting("scheduleLeasePending", saved)
                    try:
                        result = await self.runtime.gateway.json("POST", "sync/schedules/" + task["id"] + "/claim", lease)
                    except Exception as exc:
                        if getattr(exc, "status", None) in {400, 403, 404, 409, 422}:
                            saved.pop(slot, None)
                            self.storage.set_setting("scheduleLeasePending", saved)
                        continue
                    if not result.get("claimed"):
                        continue
                    fresh = self.storage.get("scheduledTasks", task["id"])
                     
                     
                    config_keys = FIELDS - {"requestId"}
                    if not fresh or not fresh.get("enabled") or self.pending_stop(task["id"]) or fresh.get("nextRunAt") != task["nextRunAt"] or any(fresh.get(k) != task.get(k) for k in config_keys):
                        saved.pop(slot, None)
                        self.storage.set_setting("scheduleLeasePending", saved)
                        continue
                    task = fresh
                    run = self.claim(task, request, due=task["nextRunAt"])
                    saved.pop(slot, None)
                    self.storage.set_setting("scheduleLeasePending", saved)
                    await self.dispatch(run)
                    self.runtime.notify()
                except ValueError:
                     
                    continue

    async def run(self):
        while not self.closed and not self.runtime.closing:
            try:
                await self.tick()
            except asyncio.CancelledError:
                raise
            except Exception:
                 
                pass
            await asyncio.sleep(2)

    async def close(self):
        self.closed = True


def register_schedules(app):
    def service(request):
        return request.app.state.schedules

    async def body(request):
        try:
            data = await request.json()
        except (ValueError, UnicodeDecodeError):
            raise ValueError("请求格式无效")
        if not isinstance(data, dict):
            raise ValueError("请求应为 JSON 对象")
        return data

    @app.get("/api/schedules")
    async def listing(request: Request):
        return service(request).listing()

    @app.get("/api/schedules/models")
    async def models(request: Request):
        local, error = [], None
        try:
            local = await request.app.state.runtime.mac_codex.models()
        except (ValueError, OSError, asyncio.TimeoutError) as exc:
            error = str(exc) or "本机模型目录读取超时"
        return service(request).models(local, error)

    @app.post("/api/schedules")
    async def create(request: Request):
        return await service(request).save(await body(request))

    @app.get("/api/schedules/pending")
    async def pending(request: Request):
        return {"ok": True, "pending": request.app.state.runtime.storage.setting("schedulePending", {})}

    @app.put("/api/schedules/pending")
    @app.patch("/api/schedules/pending")
    async def save_pending(request: Request):
        data = await body(request)
        pending = data.get("pending")
        if set(data) != {"pending"} or not isinstance(pending, dict) or len(pending) > 200:
            raise ValueError("待确认请求记录无效")
        if len(json.dumps(pending, ensure_ascii=False).encode()) > 256 * 1024:
            raise ValueError("待确认请求记录过大")
        for slot, payload in pending.items():
            if not isinstance(slot, str) or not slot or len(slot) > 256 or not isinstance(payload, dict):
                raise ValueError("待确认请求记录无效")
            service(request).request_id(payload)
         
         
        request.app.state.runtime.storage.set_setting("schedulePending", pending)
        return {"ok": True, "pending": pending}

    @app.get("/api/schedules/{identifier}")
    async def get(identifier: str, request: Request):
        return {"ok": True, "task": service(request).public(service(request).task(identifier))}

    @app.patch("/api/schedules/{identifier}")
    async def update(identifier: str, request: Request):
        return await service(request).save(await body(request), identifier)

    @app.delete("/api/schedules/{identifier}")
    async def delete(identifier: str, request: Request):
        return await service(request).control(identifier, {**await body(request), "action": "delete"})

    @app.post("/api/schedules/{identifier}/control")
    async def control(identifier: str, request: Request):
        return await service(request).control(identifier, await body(request))

    @app.get("/api/schedules/{identifier}/conversation")
    async def conversation(identifier: str, request: Request):
        return service(request).conversation(identifier)

    @app.post("/api/schedules/{identifier}/messages")
    async def messages(identifier: str, request: Request):
        return await service(request).reply(identifier, await body(request))

    @app.get("/api/schedules/{identifier}/share")
    async def share(identifier: str, request: Request):
        schedule = service(request).task(identifier)
        data = {k: v for k, v in schedule.items() if k in FIELDS and k not in {"requestId", "projectId", "enabled"}}
        text = json.dumps({"format": "shiyan-scheduled-task-v1", "task": data}, ensure_ascii=False, indent=2)
        return Response(text, media_type="application/json", headers={"Content-Disposition": 'attachment; filename="shiyan-task.json"',
            "Content-Security-Policy": "sandbox; default-src 'none'"})
