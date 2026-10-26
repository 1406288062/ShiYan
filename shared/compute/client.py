"""Private loopback client for the explicitly authorized Mac compute broker."""
from __future__ import annotations

import hashlib
import http.client
import json
import math
import os
from pathlib import Path
import stat
from urllib.parse import quote, urlsplit


class MacComputeError(RuntimeError):
    def __init__(self, message, status=0, code="unavailable"):
        super().__init__(message)
        self.status = status
        self.code = code


def private_config(path):
    try:
        path = Path(path).expanduser()
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600:
            raise ValueError("private configuration required")
        if info.st_uid != os.getuid():
            raise ValueError("configuration owner mismatch")
        value = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(value, dict):
            raise ValueError("invalid configuration")
        return value
    except (OSError, ValueError, TypeError) as exc:
        raise MacComputeError("Mac 计算配置不可用", code="configuration") from exc


class MacComputeClient:
    @staticmethod
    def configured(config_path=None):
        return bool(config_path or os.environ.get("SHIYAN_MAC_COMPUTE_CONFIG"))

    @staticmethod
    def _valid_owner(owner):
        return (isinstance(owner, str) and 0 < len(owner) <= 256 and owner != "*"
                and not any(char in owner for char in "\0\r\n"))

    @classmethod
    def enabled_for(cls, owner, config_path=None):
        if not cls._valid_owner(owner) or not cls.configured(config_path):
            return False
        cls(config_path)
        # Every signed-in account uses the shared compute service. The broker
        # checks the live account database; a stale local list is not authority.
        return True

    def __init__(self, config_path=None):
        value = private_config(config_path or os.environ.get("SHIYAN_MAC_COMPUTE_CONFIG", ""))
        parsed = urlsplit(str(value.get("url", "")))
        if (parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "::1", "localhost"}
                or parsed.username or parsed.password or parsed.query or parsed.fragment):
            raise MacComputeError("Mac 计算服务必须使用本机私有接口", code="configuration")
        self.host, self.port = parsed.hostname, parsed.port or 80
        self.prefix = parsed.path.rstrip("/")
        self.token = str(value.get("token") or "")
        if not self.token or "\n" in self.token or "\r" in self.token:
            raise MacComputeError("Mac 计算配置不可用", code="configuration")

    def _request(self, method, route, owner=None, payload=None, source=None, destination=None):
        if ((owner is not None and not self._valid_owner(owner))
                or (owner is None and route != "/v1/health")):
            raise MacComputeError("账号信息无效", 403, "owner_forbidden")
        headers = {"Authorization": "Bearer " + self.token}
        if owner is not None:
            headers["X-Shiyan-Owner"] = owner
        body = None
        opened = None
        connection = http.client.HTTPConnection(self.host, self.port, timeout=30)
        try:
            if source is not None:
                opened = Path(source).open("rb")
                body = opened
                headers.update({"Content-Type": "application/octet-stream", "Content-Length": str(os.fstat(opened.fileno()).st_size)})
            elif payload is not None:
                body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
                headers["Content-Type"] = "application/json"
            connection.request(method, self.prefix + route, body=body, headers=headers)
            response = connection.getresponse()
            if response.status >= 400:
                raw = response.read(8192)
                try:
                    failure = json.loads(raw)
                except (ValueError, UnicodeError):
                    failure = {}
                code = str(failure.get("code") or "request_failed")[:80]
                # Do not forward an arbitrary HTTP response body or private values.
                raise MacComputeError("Mac 计算请求未完成（" + code + "）", response.status, code)
            if destination is not None:
                destination = Path(destination)
                partial = destination.with_name(destination.name + ".part")
                size = 0
                try:
                    with partial.open("wb") as output:
                        while chunk := response.read(256 * 1024):
                            size += len(chunk)
                            if size > 512 * 1024 * 1024:
                                raise MacComputeError("Mac 计算结果超过大小限制", code="result_too_large")
                            output.write(chunk)
                    partial.replace(destination)
                finally:
                    partial.unlink(missing_ok=True)
                return None
            raw = response.read(4 * 1024 * 1024 + 1)
            if len(raw) > 4 * 1024 * 1024:
                raise MacComputeError("Mac 计算响应超过大小限制", code="invalid_response")
            return json.loads(raw)
        except MacComputeError:
            raise
        except (OSError, ValueError, http.client.HTTPException) as exc:
            raise MacComputeError("暂时无法连接 Mac 计算服务", code="unavailable") from exc
        finally:
            if opened:
                opened.close()
            connection.close()

    @staticmethod
    def _task_id(task_id):
        return quote(str(task_id), safe="")

    def submit_enhance(self, owner, request_id, model, input_path, width, height, on_created=None):
        path = Path(input_path)
        digest = hashlib.sha256()
        with path.open("rb") as source:
            while chunk := source.read(256 * 1024):
                digest.update(chunk)
        task = self._request("POST", "/v1/tasks", owner, {
            "kind": "enhance", "request_id": request_id,
            "params": {"model": model, "width": width, "height": height,
                       "input_sha256": digest.hexdigest(), "input_bytes": path.stat().st_size},
        })["task"]
        if on_created is not None:
            on_created(task["id"])
        if task["state"] == "uploading":
            self._request("PUT", "/v1/tasks/" + self._task_id(task["id"]) + "/input", owner, source=path)
            task = self.status(owner, task["id"])
        return task

    def submit_embed(self, owner, request_id, texts, operation, instruction):
        return self._request("POST", "/v1/tasks", owner, {
            "kind": "embed", "request_id": request_id,
            "params": {"texts": texts, "operation": operation, "instruction": instruction},
        })["task"]

    def submit_enhance_cos(self, owner, request_id, model, input_metadata, on_created=None):
        """Submit references only: image bodies go directly between COS and Mac."""
        task = self._request("POST", "/v1/tasks", owner, {
            "kind": "enhance_cos", "request_id": request_id,
            "params": {"model": model, "input": input_metadata},
        })["task"]
        if on_created is not None:
            on_created(task["id"])
        return task

    def result_cos(self, owner, task_id):
        result = self._request("GET", "/v1/tasks/" + self._task_id(task_id) + "/result", owner)
        if result.get("kind") != "enhance_cos" or result.get("device") != "mps":
            raise MacComputeError("Mac 图片结果信息无效", code="invalid_result")
        return result

    def status(self, owner, task_id):
        return self._request("GET", "/v1/tasks/" + self._task_id(task_id), owner)["task"]

    def download_image(self, owner, task_id, destination):
        self._request("GET", "/v1/tasks/" + self._task_id(task_id) + "/result", owner, destination=destination)

    def result_embeddings(self, owner, task_id):
        result = self._request("GET", "/v1/tasks/" + self._task_id(task_id) + "/result", owner)
        vectors = result.get("embeddings")
        if (result.get("device") != "mps" or result.get("dimensions") != 1024
                or not isinstance(vectors, list) or not vectors or len(vectors) > 8
                or any(not isinstance(v, list) or len(v) != 1024 or any(
                    isinstance(x, bool) or not isinstance(x, (float, int)) or not math.isfinite(x) for x in v
                ) or not any(v) for v in vectors)):
            raise MacComputeError("Mac 向量结果校验失败", code="invalid_result")
        return vectors

    def cancel(self, owner, task_id):
        return self._request("DELETE", "/v1/tasks/" + self._task_id(task_id), owner)

    def health(self):
        return self._request("GET", "/v1/health")
