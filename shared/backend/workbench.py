 

 
 
 
 
from __future__ import annotations

import asyncio
import base64
import fcntl
import hmac
import hashlib
import json
import mimetypes
import io
import zipfile
from xml.etree import ElementTree
import os
from pathlib import Path
import pty
import secrets
import signal
import struct
import subprocess
import sys
import termios
import threading
import time
from urllib.parse import urlsplit
import uuid

from fastapi import HTTPException, Request
from fastapi.responses import StreamingResponse, FileResponse
from .storage import now, new_id

TEXT_LIMIT = 2 * 1024 * 1024
IMAGE_LIMIT = 8 * 1024 * 1024
PDF_LIMIT = 64 * 1024 * 1024


def valid_name(value):
    value = str(value or "").strip()
    if not value or len(value) > 100 or value in {".", ".."} or any(c in value for c in "/\\\x00"):
        raise ValueError("请输入有效的项目名称（不能包含路径分隔符）")
    return value


class TerminalSession:
    def __init__(self, cwd: Path, project_id: str | None, storage_root=None, tab_id=None):
        self.id = new_id()
        self.cwd = str(cwd)
        self.project_id = project_id
        self.queue = asyncio.Queue(maxsize=128)
        self.closed = False
        self.attached = False
        self.paused = False
        self.expiry = None
        self.loop = asyncio.get_running_loop()
        master, slave = pty.openpty()
        self.master = master
        environment = {k: os.environ[k] for k in ["HOME", "USER", "LOGNAME", "TMPDIR"] if k in os.environ}
        environment.update({"TERM": "xterm-256color", "COLORTERM": "truecolor", "LANG": "en_US.UTF-8",
                            "LC_CTYPE": "UTF-8", "SHELL": "/bin/zsh",
                            "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"})
        if storage_root:
            import shlex
            startup=Path(storage_root)/'terminal-shells'/self.id
            startup.mkdir(parents=True,mode=0o700)
            histories=Path(storage_root)/'terminal-histories';histories.mkdir(exist_ok=True,mode=0o700)
            key=str(tab_id or self.id)
            if not all(c.isalnum() or c in '-_' for c in key) or len(key)>100:raise ValueError('终端标签标识无效')
            for filename in ['.zshenv','.zprofile','.zshrc','.zlogin']:
                original=Path.home()/filename
                script='if [[ -r '+shlex.quote(str(original))+' ]]; then source '+shlex.quote(str(original))+'; fi\n'
                if filename=='.zshrc':
                    script += 'unsetopt SHARE_HISTORY INC_APPEND_HISTORY INC_APPEND_HISTORY_TIME\n'
                    script += 'HISTFILE='+shlex.quote(str(histories/(key+'.zsh_history')))+'\n(( HISTSIZE > 0 )) || HISTSIZE=10000\n(( SAVEHIST > 0 )) || SAVEHIST=10000\nsetopt APPEND_HISTORY INC_APPEND_HISTORY\n'
                    script += 'function _shiyan_cwd() { printf "\\033]7;file://localhost%s\\007" "$PWD"; }\nautoload -Uz add-zsh-hook\nadd-zsh-hook precmd _shiyan_cwd\n'
                (startup/filename).write_text(script)
            environment['ZDOTDIR']=str(startup)
         
         
        command = [sys.executable, "-I", "-S", str(Path(__file__).with_name("terminal_child.py"))]
         
         
        if os.environ.get("PYTHONHOME"):
            environment["PYTHONHOME"] = os.environ["PYTHONHOME"]
        try:
            self.process = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave,
                                            cwd=cwd, env=environment, close_fds=True, start_new_session=True)
        except BaseException:
            os.close(master)
            raise
        finally:
            os.close(slave)
        os.set_blocking(master, False)
        self.resize(100, 30)
        self.loop.add_reader(master, self._readable)
        self.waiter = asyncio.create_task(self._wait())
        self._schedule_expiry()

    def public(self):
        return {"id": self.id, "cwd": self.cwd, "projectId": self.project_id,
                "pid": self.process.pid, "running": not self.closed and self.process.poll() is None}

    def resize(self, cols, rows):
        cols, rows = int(cols), int(rows)
        if not 20 <= cols <= 500 or not 5 <= rows <= 200:
            raise ValueError("终端尺寸无效")
        if not self.closed:
            fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    def _readable(self):
        if self.closed:
            return
        if self.queue.full():
            self.loop.remove_reader(self.master)
            self.paused = True
            return
        try:
            chunk = os.read(self.master, 8192)
        except BlockingIOError:
            return
        except OSError:
            self.loop.remove_reader(self.master)
            return
        if chunk:
            self.queue.put_nowait({"type": "data", "data": base64.b64encode(chunk).decode("ascii")})
        else:
            self.loop.remove_reader(self.master)

    def resume(self):
        if self.paused and not self.closed and self.queue.qsize() < 64:
            self.paused = False
            self.loop.add_reader(self.master, self._readable)

    async def _wait(self):
        code = await asyncio.to_thread(self.process.wait)
        if not self.closed:
             
            await asyncio.sleep(.04)
            self._readable()
            await self.queue.put({"type": "exit", "code": code})

    def _schedule_expiry(self):
        if self.expiry:
            self.expiry.cancel()
        async def expire():
            await asyncio.sleep(20)
            if not self.attached:
                await self.close()
        self.expiry = asyncio.create_task(expire())

    async def write(self, value):
        if self.closed or self.process.poll() is not None:
            raise ValueError("终端已退出，请重新打开")
        data = str(value).encode("utf-8")
        if len(data) > 65536:
            raise ValueError("单次终端输入超过 64 KB")
        view = memoryview(data)
        while view:
            try:
                count = os.write(self.master, view)
                view = view[count:]
            except BlockingIOError:
                future = self.loop.create_future()
                def writable():
                    if not future.done():
                        future.set_result(None)
                self.loop.add_writer(self.master, writable)
                try:
                    await asyncio.wait_for(future, 5)
                finally:
                    self.loop.remove_writer(self.master)
            except OSError as exc:
                raise ValueError("终端连接已关闭") from exc

    async def stream(self):
        if self.attached:
            raise ValueError("此终端已经连接")
        self.attached = True
        if self.expiry:
            self.expiry.cancel()
        try:
            yield 'event: terminal\ndata: ' + json.dumps({"type": "ready", **self.public()}) + '\n\n'
            while not self.closed:
                try:
                    item = await asyncio.wait_for(self.queue.get(), 15)
                except asyncio.TimeoutError:
                    yield ': keepalive\n\n'
                    continue
                self.resume()
                yield 'event: terminal\ndata: ' + json.dumps(item, separators=(",", ":")) + '\n\n'
                if item["type"] == "exit":
                    break
        finally:
            self.attached = False
            self._schedule_expiry()

    async def close(self):
        if self.closed:
            return
        self.closed = True
        if self.expiry and self.expiry is not asyncio.current_task():
            self.expiry.cancel()
        self.loop.remove_reader(self.master)
        self.loop.remove_writer(self.master)
         
        groups = {self.process.pid}
        try:
            groups.add(os.tcgetpgrp(self.master))
        except OSError:
            pass
        children = set()
        try:
            lines = subprocess.check_output(["/bin/ps", "-axo", "pid=,ppid="], text=True, timeout=2).splitlines()
            pairs = [tuple(map(int, x.split())) for x in lines if len(x.split()) == 2]
            parents = {self.process.pid}
            for _ in range(16):
                found = {pid for pid, ppid in pairs if ppid in parents} - parents
                if not found:
                    break
                children |= found
                parents |= found
        except (OSError, subprocess.SubprocessError, ValueError):
            pass
        for group in groups:
            if group > 1 and group != os.getpgrp():
                try:
                    os.killpg(group, signal.SIGTERM)
                except ProcessLookupError:
                    pass
        for pid in children:
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        try:
            await asyncio.wait_for(asyncio.to_thread(self.process.wait), 1)
        except asyncio.TimeoutError:
            for group in groups:
                if group > 1 and group != os.getpgrp():
                    try:
                        os.killpg(group, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
            try:
                self.process.kill()
            except ProcessLookupError:
                pass
        for pid in children:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        try:
            os.close(self.master)
        except OSError:
            pass
        while not self.queue.empty():
            self.queue.get_nowait()
        self.queue.put_nowait({"type": "exit", "code": self.process.poll()})
        if not self.waiter.done():
            self.waiter.cancel()


class Workbench:
    def __init__(self, runtime):
        self.runtime = runtime
        self.storage = runtime.storage
        self.token = secrets.token_urlsafe(32)
        self.terminals = {}
        self.pdf_previews = {}
        self.pdf_preview_lock = threading.RLock()

    def preferences(self):
        return self.storage.setting("workspace", {})

    def save_preferences(self, changes):
        allowed = {"leftOpen", "rightOpen", "leftWidth", "rightWidth", "groups", "tabs", "activeTab", "selectedProjectId", "bottomTerminalIds", "bottomTerminalId", "bottomTerminalVisible"}
        current = self.preferences()
        for key in allowed:
            if key in changes:
                value = changes[key]
                if key in {"leftOpen", "rightOpen", "bottomTerminalVisible"}:
                    value = bool(value)
                elif key in {"leftWidth", "rightWidth"}:
                    value = max(200, min(1200, int(value)))
                elif key == "tabs":
                    if not isinstance(value, list) or len(value) > 30:
                        raise ValueError("最多保留 30 个工作区标签")
                    clean = []
                    for tab in value:
                        if not isinstance(tab, dict) or tab.get("type") not in {"browser", "file", "files", "terminal", "history", "bookmarks", "downloads", "settings", "changes"}:
                            continue
                        entry = {k: str(tab[k])[:4096] for k in ["id", "type", "title", "url", "projectId", "path", "fileId", "selectedPath", "directoryPath", "cwd", "conversationId", "messageId", "assetId", "assetName"] if tab.get(k) is not None}
                        if "directoryOpen" in tab:
                            entry["directoryOpen"] = bool(tab["directoryOpen"])
                        if entry.get("id"):
                            clean.append(entry)
                    value = clean
                elif key == "groups":
                    if not isinstance(value, dict):
                        raise ValueError("分组状态无效")
                    value = {k: bool(value.get(k, True)) for k in ["pinned", "projects", "recent"]}
                elif key == "selectedProjectId" and value and not self.storage.get("projects", str(value)):
                    raise ValueError("项目不存在")
                current[key] = value
        if len(json.dumps(current)) > 100000:
            raise ValueError("工作区配置过大")
        self.storage.set_setting("workspace", current)
        self.runtime.notify()
        return current

    def project(self, identifier):
        item = self.storage.get("projects", str(identifier or ""))
        if not item:
            raise ValueError("请选择一个本地项目")
        if not str(item.get("path") or "").strip():
            raise ValueError("此项目尚未关联 Mac 本地目录，请先关联目录")
        root = Path(item["path"]).resolve()
        if not root.is_dir():
            raise ValueError("项目目录不存在或已移动，请重新关联")
        return item, root

    def create_project(self, data):
        if not self.runtime.server_access:
            if data.get("path"): raise ValueError("此账户不能关联本机目录")
            item = {"id":new_id(), "name":valid_name(data.get("name")), "createdAt":now()}
            self.storage.put("projects", item)
            self.runtime.notify()
            return item
        raw = str(data.get("path", "")).strip()
        if not raw or len(raw) > 4096:
            raise ValueError("请选择本地目录")
        parent = Path(raw).expanduser().resolve()
        if not parent.is_dir():
            raise ValueError("所选目录不存在")
        name = valid_name(data.get("name") or parent.name)
        root = parent
        if data.get("create"):
            root = parent / name
            if root.exists():
                raise ValueError("同名目录已存在，可改用打开项目")
            root.mkdir(mode=0o755)
        for item in self.storage.list("projects"):
            if item.get("path") and Path(item["path"]).resolve() == root:
                return item
        item = {"id": new_id(), "name": name, "path": str(root), "createdAt": now()}
        self.storage.put("projects", item)
        self.runtime.notify()
        return item

    def bind_project(self, identifier, data):
        item = self.storage.get("projects", identifier)
        if not item:
            raise ValueError("项目不存在")
        raw = str(data.get("path") or "").strip()
        if not raw or len(raw) > 4096:
            raise ValueError("请选择本地目录")
        directory = Path(raw).expanduser().resolve()
        if not directory.is_dir():
            raise ValueError("所选目录不存在")
        item["path"] = str(directory)
        self.storage.put("projects", item)
        self.runtime.notify()
        return item

    def resolve(self, project_id, relative):
        item, root = self.project(project_id)
        relative = str(relative or "")
        if len(relative) > 4096 or "\x00" in relative or Path(relative).is_absolute():
            raise ValueError("文件路径无效")
        candidate = (root / relative).resolve()
        if not candidate.is_relative_to(root):
            raise HTTPException(403, "不能访问项目目录之外的文件")
        return candidate, root

    def list_directory(self, project_id, relative):
        directory, root = self.resolve(project_id, relative)
        if not directory.is_dir():
            raise ValueError("目录不存在")
        excluded = {".git", "node_modules", "__pycache__", ".DS_Store", ".venv"}
        items = []
        truncated = False
        with os.scandir(directory) as entries:
            for entry in entries:
                if entry.name in excluded:
                    continue
                if len(items) >= 600:
                    truncated = True
                    break
                target = Path(entry.path)
                try:
                    safe = target.resolve().is_relative_to(root)
                    is_dir = entry.is_dir(follow_symlinks=True) if safe else False
                    items.append({"name": entry.name, "path": str(target.relative_to(root)),
                                  "directory": is_dir, "blocked": not safe, "symlink": entry.is_symlink()})
                except OSError:
                    continue
        items.sort(key=lambda e: (not e["directory"], e["name"].lower()))
        return {"entries": items, "path": str(directory.relative_to(root)), "truncated": truncated}

    def read_file(self, data):
        file_id = data.get("fileId")
        if file_id:
            record = self.storage.get("workspaceFiles", str(file_id))
            if not record:
                raise ValueError("文件授权记录不存在，请重新打开")
            target = Path(record["path"]).resolve()
            project_id = record.get("projectId")
            if project_id:
                _, root = self.project(project_id)
                if not target.is_relative_to(root):
                    raise HTTPException(403, "文件已移动到项目之外")
        else:
            project_id = data.get("projectId")
            target, _ = self.resolve(project_id, data.get("path"))
        if not target.is_file():
            raise ValueError("文件不存在或不是普通文件")
        size = target.stat().st_size
        mime = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        base = {"name": target.name, "path": str(target), "size": size, "projectId": project_id, "fileId": file_id}
        if target.suffix.lower() == ".pdf":
            if size > PDF_LIMIT:
                return {**base, "kind": "large", "message": "PDF 超过 64 MB 预览上限，请在本地阅读器中打开"}
            with target.open("rb") as handle:
                if b"%PDF-" not in handle.read(1024):
                    raise ValueError("PDF 文件不完整或格式无效")
            return {**base, "kind": "pdf", "mimeType": "application/pdf"}
        image = mime in {"image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"}
        limit = IMAGE_LIMIT if image else TEXT_LIMIT
        if size > limit:
            return {**base, "kind": "large", "message": "文件超过预览上限，请用本地编辑器打开"}
        with target.open("rb") as handle:
            raw = handle.read(limit + 1)
        if len(raw) > limit:
            raise ValueError("文件在读取过程中变大，请重试")
        if image:
            return {**base, "kind": "image", "dataUrl": f"data:{mime};base64," + base64.b64encode(raw).decode("ascii")}
        if target.suffix.lower() == ".docx":
            try:
                with zipfile.ZipFile(io.BytesIO(raw)) as document:
                    info = document.getinfo("word/document.xml")
                    if info.file_size > 4 * 1024 * 1024:
                        raise ValueError("Word 文档正文超过预览上限")
                    tree = ElementTree.fromstring(document.read(info))
                ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
                paragraphs = ["".join(t.text or "" for t in paragraph.findall(".//w:t", ns)) for paragraph in tree.findall(".//w:p", ns)]
                return {**base, "kind": "text", "text": "\n".join(paragraphs),
                        "encoding": "DOCX", "language": "docx", "sensitive": False}
            except (zipfile.BadZipFile, KeyError, ElementTree.ParseError) as exc:
                raise ValueError("Word 文档不完整或无法预览") from exc
        if b"\x00" in raw[:8192]:
            return {**base, "kind": "binary", "message": "此二进制文件暂不支持内嵌预览"}
        try:
            text = raw.decode("utf-8-sig")
            encoding = "UTF-8"
        except UnicodeDecodeError:
            try:
                text = raw.decode("gb18030")
                encoding = "GB18030"
            except UnicodeDecodeError:
                return {**base, "kind": "binary", "message": "无法识别此文件的文本编码"}
        sensitive = target.name == ".env" or target.name.startswith(".env.") or target.suffix.lower() in {".pem", ".key", ".p12"} or any(x in {".ssh", ".aws", ".codex"} for x in target.parts)
        return {**base, "kind": "text", "text": text, "encoding": encoding,
                "language": target.suffix.lower().lstrip("."), "sensitive": sensitive, "contentHash":hashlib.sha256(raw).hexdigest()}

    def pdf_preview_file(self, reference):
        file = self.read_file(reference)
        if file["kind"] == "large":
            raise HTTPException(413, file["message"])
        if file["kind"] != "pdf":
            raise HTTPException(415, "此文件不是可预览的 PDF")
        return file

    def create_pdf_preview(self, reference):
        self.pdf_preview_file(reference)
        reference = {key: reference[key] for key in ("fileId", "projectId", "path") if key in reference}
        now = time.monotonic()
        with self.pdf_preview_lock:
            self.pdf_previews = {key: value for key, value in self.pdf_previews.items() if value["expires"] > now}
            while len(self.pdf_previews) >= 64:
                self.pdf_previews.pop(next(iter(self.pdf_previews)))
            ticket = secrets.token_urlsafe(32)
            self.pdf_previews[ticket] = {"reference": reference, "expires": now + 1800}
        return "/api/workspace/files/pdf/" + ticket

    def grant_file(self, path):
        target = Path(str(path or "")).expanduser().resolve()
        if not target.is_file():
            raise ValueError("请选择普通文件")
        existing = next((x for x in self.storage.list("workspaceFiles") if x["path"] == str(target)), None)
        record = existing or {"id": new_id(), "path": str(target), "createdAt": now()}
        self.storage.put("workspaceFiles", record)
        return self.read_file({"fileId": record["id"]})

    async def close(self):
        await asyncio.gather(*(x.close() for x in self.terminals.values()), return_exceptions=True)
        self.terminals.clear()
        self.pdf_previews.clear()


def register_workbench(app):
    from .workbench_v2 import register_v2
    register_v2(app)

    def work(request):
        return request.app.state.workbench

    def same_origin(request):
        port = request.scope.get("server", (None, None))[1]
        expected = {f"127.0.0.1:{port}", f"localhost:{port}"}
        if request.headers.get("host", "").lower() not in expected:
            raise HTTPException(403, "本地地址校验失败")
        origin = request.headers.get("origin")
        if origin:
            parsed = urlsplit(origin)
            if parsed.scheme != "http" or parsed.netloc.lower() not in expected:
                raise HTTPException(403, "禁止跨站工作区访问")
        if request.headers.get("sec-fetch-site") == "cross-site":
            raise HTTPException(403, "禁止跨站工作区访问")

    def auth(request):
        same_origin(request)
        w = work(request)
        if not hmac.compare_digest(request.headers.get("x-shiyan-workspace", ""), w.token):
            raise HTTPException(403, "工作区授权已失效，请重新打开应用")
        return w

    async def body(request):
        try:
            value = await request.json()
        except ValueError as exc:
            raise ValueError("请求格式无效") from exc
        if not isinstance(value, dict):
            raise ValueError("请求格式无效")
        return value

    @app.post("/api/workspace/bootstrap")
    async def bootstrap(request: Request):
        same_origin(request)
        if request.headers.get("x-shiyan-local") != "1":
            raise HTTPException(403, "需要本地应用请求")
        w = work(request)
        preferred = Path.home() / "Projects"
        if not preferred.is_dir():
            preferred = Path.home()
        return {"ok": True, "token": w.token, "projects": w.storage.list("projects"),
                "preferences": w.preferences(), "defaultDirectory": str(preferred) if w.runtime.server_access else "", "terminalTransport": "SSE" if w.runtime.server_access else None}

    @app.patch("/api/workspace/preferences")
    async def preferences(request: Request):
        w = auth(request)
        return {"ok": True, "preferences": w.save_preferences(await body(request))}

    @app.get("/api/workspace/projects")
    async def projects(request: Request):
        w = auth(request)
        return {"ok": True, "projects": w.storage.list("projects")}

    @app.post("/api/workspace/projects")
    async def create_project(request: Request):
        w = auth(request)
        item = w.create_project(await body(request))
        return {"ok": True, "project": item, "projects": w.storage.list("projects")}

    @app.post("/api/workspace/projects/{identifier}/select")
    async def select_project(identifier: str, request: Request):
        w = auth(request)
        if not w.storage.get("projects", identifier):
            raise ValueError("项目不存在")
        w.save_preferences({"selectedProjectId": identifier})
        r = w.runtime
        candidates = [x for x in w.storage.list("conversations") if x.get("projectId") == identifier]
        candidates.sort(key=lambda x: x.get("updatedAt", ""), reverse=True)
        if candidates:
            item = candidates[0]
        else:
            item = r.new_conversation(project_id=identifier, force_new=True)
        r.select(item["id"])
        r.notify()
        return {"ok": True, "conversationId": item["id"], "state": r.snapshot()}

    @app.post("/api/workspace/projects/{identifier}/bind")
    async def bind_project(identifier: str, request: Request):
        w = auth(request)
        item = w.bind_project(identifier, await body(request))
        return {"ok": True, "project": item, "projects": w.storage.list("projects")}

    @app.get("/api/workspace/directory")
    async def directory(request: Request, projectId: str, path: str = ""):
        w = auth(request)
        return {"ok": True, **await asyncio.to_thread(w.list_directory, projectId, path)}

    @app.post("/api/workspace/files/pdf")
    async def create_pdf_preview(request: Request):
        w = auth(request)
        url = await asyncio.to_thread(w.create_pdf_preview, await body(request))
        return {"ok": True, "previewUrl": url}

    @app.get("/api/workspace/files/pdf/{ticket}")
    async def preview_pdf(ticket: str, request: Request):
        # Browser frames cannot attach the workspace header. A short-lived ticket
        # is issued by the authorized POST above and belongs to this account's
        # Workbench; the existing account middleware still protects every GET.
        same_origin(request)
        w = work(request)
        with w.pdf_preview_lock:
            preview = w.pdf_previews.get(ticket)
            if not preview or preview["expires"] <= time.monotonic():
                w.pdf_previews.pop(ticket, None)
                raise HTTPException(403, "PDF 预览已失效，请重新打开文件")
        file = await asyncio.to_thread(w.pdf_preview_file, preview["reference"])
        return FileResponse(file["path"], media_type="application/pdf", filename=file["name"],
                            content_disposition_type="inline",
                            headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})

    @app.post("/api/workspace/files/read")
    async def read_file(request: Request):
        w = auth(request)
        return {"ok": True, "file": await asyncio.to_thread(w.read_file, await body(request))}

    @app.post("/api/workspace/files/asset")
    async def open_asset_file(request: Request):
        w = auth(request)
        data = await body(request)
        asset = w.storage.asset(data.get("assetId"))
        target = w.storage.asset_path(asset["id"])
        file = await asyncio.to_thread(w.grant_file, target)
        file["name"] = asset["filename"]
        return {"ok": True, "file": file}

    @app.post("/api/workspace/files/open")
    async def open_file(request: Request):
        w = auth(request)
        data = await body(request)
        return {"ok": True, "file": await asyncio.to_thread(w.grant_file, data.get("path"))}

    @app.post("/api/workspace/terminals")
    async def new_terminal(request: Request):
        w = auth(request)
        data = await body(request)
        active = [x for x in w.terminals.values() if not x.closed and x.process.poll() is None]
        if len(active) >= 8:
            raise HTTPException(429, "最多同时开启 8 个终端")
        project_id = data.get("projectId")
        cwd = w.project(project_id)[1] if project_id else Path.home()
        if data.get("cwd"):
            requested=Path(str(data["cwd"])).expanduser().resolve()
            if not requested.is_dir():raise ValueError("终端工作目录不存在")
            cwd=requested
        session = TerminalSession(cwd, project_id, w.storage.root, data.get("tabId"))
        w.terminals[session.id] = session
        return {"ok": True, "terminal": session.public()}

    def terminal(w, identifier):
        value = w.terminals.get(identifier)
        if not value or value.closed:
            raise HTTPException(404, "终端不存在或已关闭")
        return value

    @app.get("/api/workspace/terminals/{identifier}/events")
    async def terminal_events(identifier: str, request: Request):
        w = auth(request)
        session = terminal(w, identifier)
        if session.attached:
            raise HTTPException(409, "此终端已经连接")
        return StreamingResponse(session.stream(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"})

    @app.post("/api/workspace/terminals/{identifier}/input")
    async def terminal_input(identifier: str, request: Request):
        w = auth(request)
        data = await body(request)
        await terminal(w, identifier).write(data.get("data", ""))
        return {"ok": True}

    from .workbench_v22 import register_v22
    register_v22(app, auth, body)

    @app.post("/api/workspace/terminals/{identifier}/resize")
    async def terminal_resize(identifier: str, request: Request):
        w = auth(request)
        data = await body(request)
        terminal(w, identifier).resize(data.get("cols", 100), data.get("rows", 30))
        return {"ok": True}

    @app.delete("/api/workspace/terminals/{identifier}")
    async def terminal_close(identifier: str, request: Request):
        w = auth(request)
        session = w.terminals.get(identifier)
        if session:
            await session.close()
            w.terminals.pop(identifier, None)
        return {"ok": True}
