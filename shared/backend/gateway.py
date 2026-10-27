 
from __future__ import annotations
import asyncio
import base64
import hashlib
import http.client
import json
import os
from pathlib import Path
import ssl
import time
from urllib.parse import urlsplit
import uuid

FALLBACK_CAPABILITIES = {"model":"Codex","reasoningEfforts":["low","medium","high"],
                         "defaultReasoning":"low","maxUploadImages":8,"streams":True,"resumable":True}

class GatewayError(Exception):
    def __init__(self, message, status=503):
        super().__init__(message)
        self.status = status

class PinnedConnection(http.client.HTTPSConnection):
    def __init__(self, host, port, certificate, timeout=40):
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
        super().__init__(host, port=port, timeout=timeout, context=context)
        self.certificate = certificate

    def connect(self):
        super().connect()
        actual = self.sock.getpeercert(binary_form=True)
        if actual != self.certificate:
            self.close()
            raise GatewayError("服务证书校验失败，连接已停止", 502)

class Gateway:
    def __init__(self, root, platform=None):
        self.project_root = Path(root)
        self.platform = platform
        self.account_token = None
        endpoint = urlsplit(os.environ.get("SHIYAN_GATEWAY_URL", "https://129.226.81.110/shiyan/v1/"))
        if endpoint.scheme != "https" or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment:
            raise ValueError("服务地址必须是无凭据的 HTTPS 地址")
        self.host, self.port = endpoint.hostname, endpoint.port or 443
        self.prefix = endpoint.path.rstrip("/") + "/"
        certificate_path = Path(__file__).parent / "resources" / "boss-codex.cer"
        self.certificate = certificate_path.read_bytes()
        if self.certificate.startswith(b"-----BEGIN"):
            self.certificate = ssl.PEM_cert_to_DER_cert(self.certificate.decode())
        self.helper = os.environ.get("SHIYAN_IDENTITY_HELPER") or str(self.project_root / "native" / "build" / "ShiYanIdentity")
        self.public_identity = None
        self.enrolled = False
        self.capabilities = dict(FALLBACK_CAPABILITIES)
        self.connection_task = None
        self.authorization_error = None
        self.open_connections = set()

    async def helper_json(self, action, value=b""):
        try:
            child = await asyncio.create_subprocess_exec(self.helper, action, stdin=asyncio.subprocess.PIPE,
                         stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        except OSError as exc:
            raise GatewayError("设备身份组件不可用，请通过拾燕应用启动") from exc
        try:
            stdout, stderr = await asyncio.wait_for(child.communicate(value), timeout=30)
        except BaseException:
            if child.returncode is None:
                child.kill()
            await child.wait()
            raise
        if child.returncode != 0:
            raise GatewayError("无法读取本机安全身份，请解锁 Mac 后重试")
        try:
            return json.loads(stdout)
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise GatewayError("设备身份响应无效") from exc

    async def identity(self):
        if self.public_identity is None:
            info = await self.helper_json("identity")
            try:
                raw = base64.b64decode(info["publicKey"], validate=True)
                if len(raw) != 32 or hashlib.sha256(raw).hexdigest() != info["deviceID"]:
                    raise ValueError()
            except (ValueError, KeyError) as exc:
                raise GatewayError("设备公钥校验失败") from exc
            self.public_identity = {"deviceID":info["deviceID"],"publicKey":info["publicKey"]}
        return self.public_identity

    async def request_parts(self, method, route, payload=None):
        path = self.prefix + route
        if "\n" in path or "\r" in path or not path.startswith(self.prefix):
            raise GatewayError("请求地址无效", 400)
        body = b"" if payload is None else json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
        maximum = 90 * 1024 * 1024 if route == "sync/assets" else 40 * 1024 * 1024
        if len(body) > maximum:
            raise GatewayError("上传内容超过 40 MB，请减少图片", 413)
        digest = hashlib.sha256(body).hexdigest()
        headers = {"Content-Type":"application/json", "Content-Length":str(len(body)),
                   "X-Shiyan-Body-Sha":digest, "X-Shiyan-Platform":(
                       "web" if route.startswith("auth/") and getattr(getattr(self, "platform", None), "mode", None) == "web" else "macos"),
                   "Connection":"close"}
        if route == "sync" or route.startswith("sync?"):
            headers["X-Shiyan-Sync-Profile"] = "compact"
        if self.account_token:
            headers["Authorization"] = "Bearer " + self.account_token
            headers["X-Shiyan-Account-Required"] = "1"
            return path, body, headers
        if route in {"auth/status", "auth/login", "auth/register", "auth/register-code", "auth/password-reset-code", "auth/password-reset", "auth/qr/create", "auth/qr/poll", "auth/device/request", "auth/device/poll"}:
            return path, body, headers
        if route not in {"auth/status", "auth/bootstrap", "enroll"}:
            raise GatewayError("请先登录", 401)
        try:
            identity = await self.identity()
        except GatewayError:
            if route == "auth/status": return path, body, headers
            raise
        timestamp = str(int(time.time() * 1000))
        nonce = str(uuid.uuid4())
        digest = hashlib.sha256(body).hexdigest()
        canonical = "\n".join([method, path, timestamp, nonce, digest]).encode()
        signature = (await self.helper_json("sign", canonical)).get("signature")
        if not signature:
            raise GatewayError("设备签名失败")
        headers = {"Content-Type":"application/json","Content-Length":str(len(body)),
                   "X-Shiyan-Device":identity["deviceID"],"X-Shiyan-Time":timestamp,
                   "X-Shiyan-Nonce":nonce,"X-Shiyan-Body-Sha":digest,
                   "X-Shiyan-Signature":signature,"Connection":"close"}
        return path, body, headers

    def make_connection(self, timeout=40):
        return PinnedConnection(self.host, self.port, self.certificate, timeout)

    async def raw(self, method, route, payload=None, timeout=40):
        path, body, headers = await self.request_parts(method, route, payload)
        conn = self.make_connection(timeout)
        self.open_connections.add(conn)
        def perform():
            conn.request(method, path, body=body if body else None, headers=headers)
            response = conn.getresponse()
            maximum = (64 if route.startswith("sync/assets/") else 40) * 1024 * 1024
            data = response.read(maximum + 1)
            if len(data) > maximum:
                raise GatewayError("服务器文件超过可接收大小")
            return response.status, {k.lower():v for k,v in response.getheaders()}, data
        try:
            status, fields, data = await asyncio.to_thread(perform)
            if not 200 <= status < 300:
                try:
                    message = json.loads(data).get("error")
                except (ValueError, AttributeError):
                    message = None
                error = GatewayError(message or f"服务暂不可用（{status}）", status)
                self.remember_authorization_error(error)
                raise error
            return status, fields, data
        except (OSError, http.client.HTTPException) as exc:
            raise GatewayError("连接中断，请检查网络后重试") from exc
        finally:
            conn.close()
            self.open_connections.discard(conn)

    async def json(self, method, route, payload=None, timeout=40):
        _, _, data = await self.raw(method, route, payload, timeout)
        try:
            return json.loads(data)
        except (ValueError, UnicodeDecodeError) as exc:
            raise GatewayError("服务返回了无法识别的数据") from exc

    def remember_authorization_error(self, error):
        if isinstance(error, GatewayError) and error.status == 401:
            self.enrolled = False
            self.authorization_error = (error.status, str(error))

    async def connect(self, force=False):
         
         
        task = self.connection_task
        if task is not None and not task.done():
            return await self._wait_connection(task)
        if force:
             
             
            self.authorization_error = None
            self.enrolled = False
        elif self.authorization_error is not None:
            status, message = self.authorization_error
            raise GatewayError(message, status)
        elif self.enrolled:
            return self.capabilities
        task = asyncio.create_task(self._connect_outcome())
        self.connection_task = task
        def completed(value):
            if self.connection_task is value:
                self.connection_task = None
             
            if not value.cancelled():
                value.exception()
        task.add_done_callback(completed)
        return await self._wait_connection(task)

    async def _wait_connection(self, task):
        capabilities, error = await asyncio.shield(task)
        if error is not None:
            if isinstance(error, GatewayError):
                raise GatewayError(str(error), error.status)
            raise error
        return capabilities

    async def _connect_outcome(self):
         
         
         
        try:
            return await self._connect_once(), None
        except Exception as error:
            return None, error

    async def _connect_once(self):
        try:
            if not self.account_token:
                raise GatewayError("请先登录", 401)
            caps = await self.json("GET", "capabilities")
            levels = caps.get("reasoningEfforts")
            if not isinstance(levels, list) or not levels or any(not isinstance(x,str) for x in levels):
                raise GatewayError("服务返回的推理档位无效")
            self.capabilities = {**FALLBACK_CAPABILITIES, **caps}
            self.enrolled = True
            self.authorization_error = None
            return self.capabilities
        except GatewayError as error:
            self.remember_authorization_error(error)
            raise

    async def ensure_enrolled(self):
         
         
        if not self.enrolled or self.connection_task is not None:
            await self.connect()

    async def _upload_job_image(self, image):
        # Each signed request stays small. Completed chunks survive a lost
        # response, and a retry resumes by content hash without changing images.
        try:
            data = base64.b64decode(image["data"], validate=True)
        except (KeyError, ValueError, TypeError) as exc:
            raise GatewayError("图片数据不完整", 400) from exc
        identifier = hashlib.sha256(data).hexdigest()
        suffix = image.get("suffix")
        route = "job-images/" + identifier
        try:
            result = await self.json("GET", route)
            upload = result.get("upload", {})
        except GatewayError as error:
            if error.status != 404:
                raise
            upload = {"offset": 0, "total": len(data), "suffix": suffix, "complete": False}
        offset = upload.get("offset")
        if (not isinstance(offset, int) or isinstance(offset, bool) or
                not 0 <= offset <= len(data) or upload.get("total") != len(data) or
                upload.get("suffix") != suffix):
            raise GatewayError("图片上传状态不一致，请保留原图片", 409)
        complete = upload.get("complete") is True
        if complete != (offset == len(data)):
            raise GatewayError("图片上传尚未完整确认，请重试")
        while offset < len(data):
            chunk = data[offset:offset + 48 * 1024]
            body = {"offset": offset, "total": len(data), "suffix": suffix,
                    "sha256": identifier, "data": base64.b64encode(chunk).decode()}
            for attempt in range(3):
                try:
                    result = await self.json("POST", route, body)
                    break
                except GatewayError as error:
                    if error.status not in {408, 429, 500, 502, 503, 504}:
                        raise
                    if attempt == 2:
                        raise GatewayError("图片上传暂时中断，已上传部分保留；请恢复网络后重试") from error
                    await asyncio.sleep(attempt + 1)
            upload = result.get("upload", {})
            next_offset = upload.get("offset")
            if (not isinstance(next_offset, int) or isinstance(next_offset, bool) or
                    not offset + len(chunk) <= next_offset <= len(data) or
                    upload.get("total") != len(data) or upload.get("suffix") != suffix or
                    (upload.get("complete") is True) != (next_offset == len(data))):
                raise GatewayError("图片上传响应不完整，请重试")
            offset = next_offset
        return {"uploadId": identifier, "suffix": suffix, "sha256": identifier}

    async def create_job(self, payload):
        await self.ensure_enrolled()
        images = payload.get("images") or []
        if images:
            references = [await self._upload_job_image(image) for image in images]
            payload = {**payload, "images": references}
        result = await self.json("POST", "jobs", payload)
        if not result.get("jobId"):
            raise GatewayError("任务响应无效")
        return result["jobId"]

    async def user_questions(self, job_id):
        return await self.json("GET", f"jobs/{job_id}/questions", timeout=12)

    async def answer_question(self, job_id, request_id, answers):
        return await self.json("POST", f"jobs/{job_id}/questions/{request_id}/answer", {"answers":answers}, timeout=20)

    async def sync_get(self, after=0):
        return await self.json("GET", f"sync?after={int(after)}&limit=200")

    async def sync_push(self, payload):
        return await self.json("POST", "sync", payload)

    async def sync_asset_upload(self, payload):
        return await self.json("POST", "sync/assets", payload, timeout=120)

    async def sync_asset_download(self, identifier):
        import uuid
        identifier = str(uuid.UUID(identifier))
        return await self.raw("GET", f"sync/assets/{identifier}", timeout=120)

    async def fork(self, source, target, retained, replaced):
        await self.ensure_enrolled()
        result = await self.json("POST", "conversations/fork",
                     {"sourceConversationId":source,"targetConversationId":target,
                      "retainedPrompts":retained,"replacedPrompt":replaced}, timeout=65)
        if result.get("ok") is not True or (retained and not result.get("threadId") and result.get("historyRetained") is not True):
            raise GatewayError("无法保留编辑位置之前的上下文，原记录已保留")
        return result.get("threadId")

    async def cancel(self, request_id):
        await self.ensure_enrolled()
        result = await self.json("POST", f"requests/{request_id}/cancel", {}, timeout=10)
        if result.get("ok") is not True or result.get("status") not in {"cancelled","completed","failed","interrupted"}:
            raise GatewayError("服务器尚未确认停止")
        return result["status"]

    async def title(self, remote_id):
        await self.ensure_enrolled()
        result = await self.json("POST", "title", {"conversationId":remote_id})
        value = result.get("title")
        return value.strip()[:100] if isinstance(value, str) else None

    async def terminal_snapshot_event(self, job_id, after=0):
        """Recover authoritative results even when the event history was compacted."""
        snapshot = await self.json("GET", f"jobs/{job_id}")
        if not isinstance(snapshot, dict):
            raise GatewayError("服务返回了无法识别的任务结果")
        status = snapshot.get("status")
        if status not in {"completed", "failed", "cancelled", "interrupted"}:
            return None
        fields = ("text", "assets", "threadId", "error", "reasoning", "displayItems", "fileChanges", "usage")
        return {**{key: snapshot[key] for key in fields if key in snapshot},
                "seq": after + 1, "type": status}

    async def events(self, job_id, after=0):
        await self.ensure_enrolled()
        if after:
            try:
                final = await self.terminal_snapshot_event(job_id, after)
            except GatewayError as error:
                if error.status in {401, 403}:
                    raise
            else:
                if final is not None:
                    yield final
                    return
        path, body, headers = await self.request_parts("GET", f"jobs/{job_id}/events?after={after}&transport=metadata")
        headers["Accept"] = "text/event-stream"
        conn = self.make_connection(40)
        self.open_connections.add(conn)
        failure = None
        last_seq = after
        try:
            def open_stream():
                conn.request("GET", path, headers=headers)
                return conn.getresponse()
            response = await asyncio.to_thread(open_stream)
            if response.status != 200:
                error = GatewayError(f"实时连接失败（{response.status}）", response.status)
                self.remember_authorization_error(error)
                raise error
            fields, length, pending_line = [], 0, bytearray()
            while True:
                fragment = await asyncio.to_thread(response.readline, 1024 * 1024)
                if not fragment:
                    if pending_line or fields:
                        raise GatewayError("实时事件不完整")
                    break
                length += len(fragment)
                if length > 40 * 1024 * 1024:
                    raise GatewayError("单次事件过大")
                pending_line.extend(fragment)
                # readline(size) may stop at size before a newline, including
                # inside UTF-8 or JSON tokens. Only parse complete physical lines.
                if not fragment.endswith(b"\n"):
                    continue
                line = bytes(pending_line).rstrip(b"\r\n")
                pending_line.clear()
                if not line:
                    if fields:
                        try:
                            event = json.loads(b"\n".join(fields))
                        except (ValueError, UnicodeError) as exc:
                            raise GatewayError("实时事件解析失败") from exc
                        if not isinstance(event, dict):
                            raise GatewayError("实时事件格式无效")
                        last_seq = max(last_seq, event.get("seq", 0))
                        yield event
                        if event.get("type") in {"completed", "failed", "cancelled", "interrupted"}:
                            return
                    fields, length = [], 0
                elif line.startswith(b"data:"):
                    fields.append(line[5:].lstrip(b" "))
        except (OSError, http.client.HTTPException) as exc:
            failure = GatewayError("实时连接中断")
            failure.__cause__ = exc
        except GatewayError as exc:
            if exc.status in {401, 403}:
                raise
            failure = exc
        finally:
            conn.close()
            self.open_connections.discard(conn)
        # EOF is not a completion signal. Ask the server before declaring a
        # receive failure, and retain the original diagnostic if still running.
        try:
            final = await self.terminal_snapshot_event(job_id, last_seq)
        except GatewayError as error:
            if error.status in {401, 403}:
                raise
            if failure is not None:
                raise failure from error
            raise
        if final is not None:
            yield final
        elif failure is not None:
            raise failure

    async def download(self, asset, storage, progress=None, inline=None):
        if inline:
            data = base64.b64decode(inline, validate=True)
            return storage.save_bytes(data, asset["filename"], asset["mimeType"], remote_id=asset["id"])
        route = f"artifacts/{asset['id']}"
        if asset["mimeType"].startswith("image/"):
            route += "?display=1"
        separator = "&" if "?" in route else "?"
        part_size = 65536
        status, headers, first = await self.raw("GET", route + separator + f"offset=0&length={part_size}")
        if status == 200:
            expected = headers.get("x-content-sha256")
            if expected and hashlib.sha256(first).hexdigest() != expected:
                raise GatewayError("结果校验失败，请重新接收")
            data = first
        else:
            try:
                total = int(headers["content-range"].split("/")[-1])
                expected = headers["x-content-sha256"]
                if status != 206 or not 0 < total <= 32 * 1024 * 1024 or len(expected) != 64 or len(first) != min(total, part_size):
                    raise ValueError()
            except (KeyError, ValueError) as exc:
                raise GatewayError("结果分段信息无效") from exc
            folder = storage.transfers / hashlib.sha256((route+expected).encode()).hexdigest()
            folder.mkdir(exist_ok=True)
            parts, received = {0:first}, len(first)
            if progress:
                await progress(received,total)
            semaphore = asyncio.Semaphore(3)
            async def part(offset):
                nonlocal received
                size = min(part_size, total-offset)
                path = folder / f"{offset}.part"
                async with semaphore:
                    if path.exists() and path.stat().st_size == size:
                        value = path.read_bytes()
                    else:
                        for attempt in range(3):
                            try:
                                code, fields, value = await self.raw("GET",route+separator+f"offset={offset}&length={size}")
                                if code != 206 or len(value) != size or fields.get("x-content-sha256") != expected or not fields.get("content-range","").startswith(f"bytes {offset}-"):
                                    raise GatewayError("结果分段校验失败")
                                temporary = path.with_suffix(".tmp")
                                temporary.write_bytes(value)
                                temporary.replace(path)
                                break
                            except (GatewayError,OSError):
                                if attempt==2:
                                    raise
                                await asyncio.sleep(attempt+1)
                    parts[offset]=value
                    received += len(value)
                    if progress:
                        await progress(received,total)
            await asyncio.gather(*(part(offset) for offset in range(part_size,total,part_size)))
            data = b"".join(parts[offset] for offset in sorted(parts))
            if hashlib.sha256(data).hexdigest() != expected:
                import shutil
                shutil.rmtree(folder, ignore_errors=True)
                raise GatewayError("结果校验失败，请重新接收")
            import shutil
            shutil.rmtree(folder, ignore_errors=True)
        mime = headers.get("content-type", asset["mimeType"]).split(";")[0]
        filename = asset["filename"]
        if mime == "image/jpeg":
            filename = Path(filename).stem + ".jpg"
        return storage.save_bytes(data, filename, mime, remote_id=asset["id"])

    def close(self):
        if self.connection_task is not None and not self.connection_task.done():
            self.connection_task.cancel()
        for connection in list(self.open_connections):
            connection.close()
        self.open_connections.clear()
