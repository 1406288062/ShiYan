 
from __future__ import annotations
import asyncio
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import time
from desktop_backend.storage import now
from desktop_backend.file_changes import begin_changes, finish_changes

WORKING = {"submitting", "queued", "running", "reconnecting"}
VISIBLE_TOOLS = {"command_execution", "mcp_tool_call", "web_search", "image_generation", "collab_tool_call", "todo_list", "file_change", "error"}
COUNTED_TOOLS = {"command_execution", "mcp_tool_call", "web_search", "image_generation", "collab_tool_call", "file_change"}


def binary():
    candidates = [Path.home() / ".local/bin/codex", Path("/opt/homebrew/bin/codex")]
    found = shutil.which("codex")
    if found:
        candidates.append(Path(found))
    return next((str(p) for p in candidates if p.is_file() and os.access(p, os.X_OK)), None)


class MacCodex:
    def __init__(self, runtime):
        self.runtime = runtime
        self.storage = runtime.storage
        self.models_cache = self.storage.setting("macCodexModels", [])
        self.checked_at = 0
        self.model_lock = asyncio.Lock()

    async def models(self):
        if self.models_cache and time.monotonic() - self.checked_at < 300:
            return self.models_cache
        async with self.model_lock:
            if self.models_cache and time.monotonic() - self.checked_at < 300:
                return self.models_cache
            executable = binary()
            if not executable:
                raise ValueError("此电脑未安装 Codex")
            process = await asyncio.create_subprocess_exec(executable, "app-server", stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL, limit=2 * 1024 * 1024)
            async def request(method, params, identifier):
                process.stdin.write((json.dumps({"id": identifier, "method": method, "params": params}) + "\n").encode())
                await process.stdin.drain()
                while True:
                    line = await process.stdout.readline()
                    if not line:
                        raise ValueError("本机模型目录进程已退出")
                    try:
                        value = json.loads(line)
                    except ValueError:
                        continue
                    if value.get("id") != identifier:
                        continue
                    if value.get("error"):
                        raise ValueError(str(value["error"].get("message", "模型目录读取失败")))
                    return value.get("result", {})
            async def catalog():
                await request("initialize", {"clientInfo": {"name": "shiyan-schedules", "version": "2.3"},
                    "capabilities": {"experimentalApi": True}}, 1)
                process.stdin.write(b'{"method":"initialized"}\n')
                await process.stdin.drain()
                cursor, identifier, choices = None, 2, []
                for _ in range(20):
                    result = await request("model/list", {"includeHidden": False, **({"cursor": cursor} if cursor else {})}, identifier)
                    for item in result.get("data", []):
                        levels = [v.get("reasoningEffort") for v in item.get("supportedReasoningEfforts", []) if isinstance(v, dict)]
                        model = item.get("model") or item.get("id")
                        default = item.get("defaultReasoningEffort")
                        if not item.get("hidden") and isinstance(model, str) and levels and default in levels:
                            choices.append({"id": model, "displayName": item.get("displayName") or model,
                                "reasoningEfforts": levels, "defaultReasoning": default})
                    cursor = result.get("nextCursor")
                    if not cursor:
                        break
                    identifier += 1
                if not choices:
                    raise ValueError("本机 Codex 未返回可用模型")
                return choices
            try:
                self.models_cache = await asyncio.wait_for(catalog(), 20)
                self.checked_at = time.monotonic()
                self.storage.set_setting("macCodexModels", self.models_cache)
                return self.models_cache
            finally:
                if process.returncode is None:
                    process.terminate()
                    try:
                        await asyncio.wait_for(process.wait(), 2)
                    except asyncio.TimeoutError:
                        process.kill()
                        await process.wait()

    def capability(self, model):
        found = next((x for x in self.models_cache if x.get("id") == model), None)
        if not found:
            raise ValueError("本机 Codex 不支持所选模型，请刷新模型目录")
        return found

    def interrupt_saved(self):
        for item in self.storage.list("conversations"):
            changed = False
            for message in item.get("messages", []):
                if message.get("localExecution") and message.get("state") in WORKING:
                    pid = message.get("localProcessId")
                    if isinstance(pid, int) and pid > 1:
                        try:
                            command = subprocess.run(["/bin/ps", "eww", "-p", str(pid), "-o", "command="],
                                capture_output=True, timeout=1, text=True).stdout
                            token = "SHIYAN_SCHEDULE_REQUEST=" + str(message.get("requestId") or "")
                            if token in command and "codex" in command:
                                os.killpg(pid, signal.SIGTERM)
                        except (OSError, subprocess.TimeoutExpired):
                            pass
                    message.update(state="interrupted", phase="", error="应用已退出，本机执行已中断；已保存结果，请确认后重新运行", completedAt=now())
                    message.pop("localProcessId", None)
                    if item.get("pendingMessageId") == message["id"]:
                        item.update(pendingMessageId=None, pendingJobId=None)
                    changed = True
            if changed:
                self.storage.put("conversations", item)

    @staticmethod
    def display(item, lifecycle):
        kind = item.get("type")
        if kind not in VISIBLE_TOOLS:
            return None
        result = {"id": str(item.get("id", ""))[:160], "type": kind,
            "status": item.get("status") or ("completed" if lifecycle == "item.completed" else "in_progress")}
        if item.get("error") or isinstance(item.get("result"), dict) and item["result"].get("isError") is True or kind == "command_execution" and isinstance(item.get("exit_code"), int) and item["exit_code"] != 0:
            result["status"] = "failed"
        for key in ("command", "query", "server", "tool", "message"):
            if isinstance(item.get(key), str):
                result[key] = item[key][:1000]
        if isinstance(item.get("aggregated_output"), str):
            result["aggregated_output"] = item["aggregated_output"][-4000:]
        if isinstance(item.get("exit_code"), int):
            result["exit_code"] = item["exit_code"]
        if isinstance(item.get("error"), dict):
            result["error"] = {"message": str(item["error"].get("message", ""))[:1000]}
        if kind == "mcp_tool_call":
            parts = item.get("result", {}).get("content", []) if isinstance(item.get("result"), dict) else []
            result["result_text"] = "\n".join(p.get("text", "") for p in parts if isinstance(p, dict) and p.get("type") == "text")[:4000]
        if kind == "todo_list":
            result["items"] = [{"text": str(x.get("text", ""))[:256], "completed": x.get("completed") is True}
                for x in item.get("items", [])[:32] if isinstance(x, dict)]
        if kind == "file_change":
            result["changes"] = [{"path": str(x.get("path", ""))[:4096], "kind": x.get("kind", "update")}
                for x in item.get("changes", [])[:200] if isinstance(x, dict)]
        if kind == "collab_tool_call":
            result["count"] = len(item.get("receiver_thread_ids", []))
        return result

    async def run(self, identifier):
        runtime = self.runtime
        conversation, message = runtime.pending_message(identifier)
        if not message or not message.get("localExecution"):
            return
        request_id, message_id = message["requestId"], message["id"]
        process, drain = None, None
        terminal = "failed"
        failure = None
        try:
            executable = binary()
            if not executable:
                raise ValueError("此电脑未安装 Codex")
            index = conversation["messages"].index(message)
            user = conversation["messages"][index - 1]
            project = self.storage.get("projects", str(conversation.get("projectId") or ""))
            cwd = Path(project.get("path", "")) if project else self.storage.root / "scheduled-workspaces" / str(conversation.get("scheduledTaskId") or identifier)
            if project and not cwd.is_dir():
                raise ValueError("此任务绑定的本机项目目录不存在")
            if not project:
                cwd.mkdir(parents=True, exist_ok=True, mode=0o700)
            cwd = cwd.resolve()
            message["workingDirectory"] = str(cwd)
            runtime.save_conversation(conversation, notify=False)
            if not project:
                conversation["fileChangeRoots"] = [str(cwd)]
                runtime.save_conversation(conversation, notify=False)
            await asyncio.to_thread(begin_changes, self.storage, conversation, message)
            options = ["--json", "--color", "never", "--skip-git-repo-check", "-m", message["model"],
                "-c", "model_reasoning_effort=" + json.dumps(message["reasoning"]),
                "-c", 'sandbox_mode="workspace-write"', "-c", 'approval_policy="never"']
             
            if conversation.get("macThreadId"):
                options = [x for i, x in enumerate(options) if i not in (1, 2)]
                args = [executable, "exec", "resume", *options, conversation["macThreadId"], "-"]
            else:
                args = [executable, "exec", *options, "-"]
            process = await asyncio.create_subprocess_exec(*args, cwd=str(cwd), stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, start_new_session=True, limit=8 * 1024 * 1024,
                env={**os.environ, "SHIYAN_SCHEDULE_REQUEST": request_id,
                    "PATH": str(Path.home() / ".local/bin") + ":/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"})
            runtime.processes["mac-codex:" + request_id] = process
            diagnostic = bytearray()
            async def stderr():
                while True:
                    chunk = await process.stderr.read(4096)
                    if not chunk:
                        return
                    diagnostic.extend(chunk)
                    if len(diagnostic) > 8192:
                        del diagnostic[:-8192]
            drain = asyncio.create_task(stderr())
            process.stdin.write(user["text"].encode())
            await process.stdin.drain()
            process.stdin.close()
            conversation, current = runtime.pending_message(identifier)
            if current is None or current["id"] != message_id:
                raise asyncio.CancelledError()
            current.update(state="running", phase="在此电脑上运行", localProcessId=process.pid)
            runtime.save_conversation(conversation)
            texts = {}
            tool_items = {}
            current["executionStats"] = {"total": 0, "success": 0, "failed": 0, "pending": 0}
            while True:
                line = await process.stdout.readline()
                if not line:
                    break
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                conversation, current = runtime.pending_message(identifier)
                if current is None or current["id"] != message_id:
                    raise asyncio.CancelledError()
                if event.get("type") == "thread.started":
                    conversation["macThreadId"] = event.get("thread_id")
                item = event.get("item")
                if isinstance(item, dict):
                    if item.get("type") == "agent_message":
                        texts[str(item.get("id", "reply"))] = str(item.get("text", ""))
                        current["text"] = "\n\n".join(texts.values())
                    display = self.display(item, event.get("type"))
                    if display:
                        previous = current.get("displayItems", [])
                        current["displayItems"] = ([x for x in previous if x["id"] != display["id"]] + [display])[-128:]
                        current["phase"] = "调用工具中" if display["status"] == "in_progress" else "整理结果中"
                        if display["type"] in COUNTED_TOOLS and display["id"]:
                             
                             
                             
                            receipt = {key: display[key] for key in ("id", "type", "status", "exit_code") if key in display}
                            tool_items[receipt["id"]] = receipt
                            stats = {"total": len(tool_items), "success": 0, "failed": 0, "pending": 0}
                            for value in tool_items.values():
                                if value["status"] == "failed":
                                    stats["failed"] += 1
                                elif value["status"] in {"completed", "succeeded", "success"} or value.get("exit_code") == 0:
                                    stats["success"] += 1
                                else:
                                    stats["pending"] += 1
                            current["executionStats"] = stats
                             
                             
                             
                            current["rawResult"] = json.dumps(list(tool_items.values()), ensure_ascii=False, separators=(",", ":"))
                if event.get("type") == "turn.completed":
                    current["usage"] = event.get("usage")
                    terminal = "completed"
                elif event.get("type") in {"turn.failed", "error"}:
                    error = event.get("error")
                    failure = str(error.get("message", "本机任务失败") if isinstance(error, dict) else event.get("message") or error or "本机任务失败")
                runtime.save_conversation(conversation)
            code = await process.wait()
            if drain:
                await drain
            if code != 0:
                terminal = "failed"
                failure = failure or diagnostic.decode(errors="replace").strip()[-2000:] or "本机 Codex 执行失败"
            elif terminal != "completed":
                failure = failure or "本机 Codex 未返回完成状态"
        except asyncio.CancelledError:
            terminal, failure = "interrupted", "本机执行已中断，已保存结果"
            raise
        except Exception as error:
            failure = str(error)
        finally:
            if process and process.returncode is None:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                    await asyncio.wait_for(process.wait(), 3)
                except (ProcessLookupError, asyncio.TimeoutError):
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    await process.wait()
            if drain and not drain.done():
                drain.cancel()
                await asyncio.gather(drain, return_exceptions=True)
            runtime.processes.pop("mac-codex:" + request_id, None)
            conversation = self.storage.get("conversations", identifier)
            current = next((m for m in (conversation or {}).get("messages", []) if m["id"] == message_id), None)
            if current and current.get("state") != "cancelled":
                current.update(state=terminal, phase="", error=failure if terminal != "completed" else None, completedAt=now())
                current.pop("localProcessId", None)
                try:
                    changes = await asyncio.to_thread(finish_changes, self.storage, current)
                    if changes:
                        current["fileChanges"] = changes
                except (ValueError, OSError):
                    pass
                if conversation.get("pendingMessageId") == message_id:
                    conversation.update(pendingMessageId=None, pendingJobId=None, updatedAt=now())
                if self.storage.setting("selectedConversationId") != identifier:
                    conversation["hasUnread"] = True
                runtime.save_conversation(conversation)
