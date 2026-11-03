"""Private, account-scoped COS transfer for the web photo enhancement UI."""
from __future__ import annotations

import configparser
from contextlib import contextmanager
from dataclasses import dataclass, field
import hashlib
import hmac
import http.client
import json
import mimetypes
import os
from pathlib import Path
import re
import sqlite3
import threading
import time
from urllib.parse import quote, urlencode, urlsplit
import uuid

from shared.compute.timing import emit_timing

MAX_INPUT = 40 * 1024 * 1024
UPLOAD_TTL = 15 * 60
COMPLETE_TTL = 20 * 60
DOWNLOAD_TTL = 5 * 60
MAX_PENDING = 20


class CosUnavailable(Exception):
    """An upstream failure; never expose upstream URLs, credentials or bodies."""


@dataclass(frozen=True)
class CosConfig:
    bucket: str
    region: str
    secret_id: str = field(repr=False)
    secret_key: str = field(repr=False)

    @property
    def host(self):
        return f"{self.bucket}.cos.{self.region}.myqcloud.com"

    @property
    def origin(self):
        return "https://" + self.host

    @classmethod
    def from_environment(cls):
        filename = os.environ.get("SHIYAN_COS_CONFIG", "").strip()
        if not filename:
            return None
        try:
            parser = configparser.ConfigParser(interpolation=None)
            with open(filename, encoding="utf-8") as source:
                parser.read_file(source)
            values = parser["common"]
            config = cls(values["bucket"].strip(), values["region"].strip(),
                         values["secret_id"].strip(), values["secret_key"].strip())
            if (not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,61}-[0-9]{5,20}", config.bucket)
                    or not re.fullmatch(r"[a-z]{2}-[a-z0-9-]{2,32}", config.region)
                    or not config.secret_id or not config.secret_key):
                raise ValueError()
            return config
        except (OSError, KeyError, ValueError, configparser.Error):
            raise CosUnavailable("图片传输配置不可用") from None


def _encoded(values):
    return "&".join(quote(str(key).lower(), safe="-_.~") + "=" + quote(str(value), safe="-_.~")
                    for key, value in sorted(values.items(), key=lambda item: str(item[0]).lower()))


class CosClient:
    def __init__(self, config):
        self.config = config

    def signed_url(self, method, key, *, headers=None, params=None, ttl=DOWNLOAD_TTL, now=None):
        """COS XML API v5 signature, including all security-sensitive headers."""
        current = int(time.time() if now is None else now)
        key_time = f"{current - 60};{current + ttl}"
        values = {str(k).lower(): str(v) for k, v in (headers or {}).items()}
        values["host"] = self.config.host
        params = {str(k).lower(): str(v) for k, v in (params or {}).items()}
        path = "/" + quote(key, safe="/-_.~")
        canonical = f"{method.lower()}\n{path}\n{_encoded(params)}\n{_encoded(values)}\n"
        sign_key = hmac.new(self.config.secret_key.encode(), key_time.encode(), hashlib.sha1).hexdigest()
        string_to_sign = f"sha1\n{key_time}\n{hashlib.sha1(canonical.encode()).hexdigest()}\n"
        signature = hmac.new(sign_key.encode(), string_to_sign.encode(), hashlib.sha1).hexdigest()
        auth = {"q-sign-algorithm": "sha1", "q-ak": self.config.secret_id,
                "q-sign-time": key_time, "q-key-time": key_time,
                "q-header-list": ";".join(sorted(values)), "q-url-param-list": ";".join(sorted(params)),
                "q-signature": signature}
        return self.config.origin + path + "?" + urlencode({**params, **auth}, quote_via=quote)

    def request(self, method, key, *, headers=None, body=None, limit=0, expected_size=None):
        headers = dict(headers or {})
        url = urlsplit(self.signed_url(method, key, headers=headers))
        connection = http.client.HTTPSConnection(self.config.host, timeout=30, blocksize=256 * 1024)
        try:
            connection.request(method, url.path + "?" + url.query, body=body, headers=headers)
            response = connection.getresponse()
            if response.status not in ({200, 204, 404} if method == "DELETE" else {200, 201, 204}):
                raise CosUnavailable()
            if method == "HEAD":
                return {name.lower(): value for name, value in response.getheaders()}
            if method != "GET":
                response.read(4096)
                return b""
            raw_length = response.getheader("Content-Length", "")
            if not raw_length.isdigit() or int(raw_length) > limit:
                raise CosUnavailable()
            if expected_size is not None and int(raw_length) != expected_size:
                raise ValueError("上传图片大小与声明不一致，请重新选择图片")
            data = bytearray()
            started = time.monotonic()
            while True:
                block = response.read(min(256 * 1024, limit + 1 - len(data)))
                if not block:
                    break
                data.extend(block)
                if len(data) > limit or time.monotonic() - started > 120:
                    raise CosUnavailable()
            if len(data) != int(raw_length):
                raise CosUnavailable()
            return bytes(data)
        except ValueError:
            raise
        except Exception:
            raise CosUnavailable("图片传输暂时失败，请稍后重试") from None
        finally:
            connection.close()

    def download(self, key, size):
        return self.request("GET", key, limit=MAX_INPUT, expected_size=size)

    def delete(self, key):
        self.request("DELETE", key)

    def head(self, key):
        return self.request("HEAD", key)

    def copy(self, source, destination, etag):
        self.request("PUT", destination, headers={"Content-Length": "0", "x-cos-acl": "private",
                     "x-cos-copy-source": self.config.host + "/" + quote(source, safe="/-_.~"),
                     "x-cos-copy-source-if-match": etag})
        return self.head(destination)

    def upload_file(self, key, path, mime):
        with open(path, "rb") as source:
            self.request("PUT", key, body=source, headers={"Content-Type": mime,
                         "Content-Length": str(os.fstat(source.fileno()).st_size), "x-cos-acl": "private"})

    def upload_bytes(self, key, data, mime):
        self.request("PUT", key, body=data, headers={"Content-Type": mime,
                     "Content-Length": str(len(data)), "x-cos-acl": "private"})


class CosTransfer:
    def __init__(self, config, client=None, clock=time.time):
        self.config = config
        self.client = client or CosClient(config)
        self.clock = clock
        self._guard = threading.Lock()
        self._locks = {}

    def _scope(self, runtime):
        owner = getattr(runtime, "account", {}).get("owner")
        if not isinstance(owner, str) or not owner:
            raise ValueError("请先登录后再上传图片")
        return hashlib.sha256(owner.encode()).hexdigest()

    def _lock(self, runtime):
        key = str(runtime.storage.root)
        with self._guard:
            return self._locks.setdefault(key, threading.RLock())

    @contextmanager
    def _database(self, runtime):
        # Separate from synced conversation/settings documents; never export tickets.
        filename = runtime.storage.root / "cos-transfer.sqlite3"
        db = sqlite3.connect(filename)
        os.chmod(filename, 0o600)
        db.execute("CREATE TABLE IF NOT EXISTS tickets (id TEXT PRIMARY KEY, owner TEXT NOT NULL, data TEXT NOT NULL)")
        db.execute("CREATE TABLE IF NOT EXISTS mirrors (id TEXT PRIMARY KEY, owner TEXT NOT NULL, data TEXT NOT NULL)")
        db.execute("CREATE TABLE IF NOT EXISTS dots_files (id TEXT NOT NULL, owner TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(owner,id))")
        try:
            yield db
        finally:
            db.close()

    @staticmethod
    def _row(db, table, identifier, owner):
        row = db.execute(f"SELECT data FROM {table} WHERE id=? AND owner=?", (identifier, owner)).fetchone()
        return json.loads(row[0]) if row else None

    @staticmethod
    def _put(db, table, identifier, owner, value):
        db.execute(f"INSERT INTO {table} (id,owner,data) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,data=excluded.data",
                   (identifier, owner, json.dumps(value, ensure_ascii=False)))
        db.commit()

    def dots_file_info(self, runtime, identifier):
        owner = self._scope(runtime)
        with self._database(runtime) as db:
            return self._row(db, "dots_files", identifier, owner)

    def mirror_dots_file(self, runtime, identifier, filename, mime, data):
        if not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", str(identifier), re.I):
            raise ValueError("文件标识无效")
        filename = Path(str(filename).replace("\\", "/")).name
        filename = re.sub(r"[\x00-\x1f\x7f]", "", filename)[:180]
        if not filename or filename in {".", ".."}:
            raise ValueError("文件名无效")
        if not isinstance(data, bytes) or not 0 < len(data) <= MAX_INPUT:
            raise ValueError("文件大小无效")
        mime = str(mime or "application/octet-stream").split(";")[0][:150]
        digest = hashlib.sha256(data).hexdigest()
        owner = self._scope(runtime)
        with self._database(runtime) as db:
            prior = self._row(db, "dots_files", identifier, owner)
            if prior and prior.get("sha256") == digest:
                return prior
            key = f"dots/{owner}/{identifier}/{digest}"
            self.client.upload_bytes(key, data, mime)
            value = {"key": key, "filename": filename, "mime": mime, "bytes": len(data), "sha256": digest}
            db.execute("INSERT INTO dots_files(id,owner,data) VALUES(?,?,?) ON CONFLICT(owner,id) DO UPDATE SET data=excluded.data", (identifier, owner, json.dumps(value, ensure_ascii=False)))
            db.commit()
            return value

    def read_dots_file(self, runtime, identifier):
        owner = self._scope(runtime)
        with self._database(runtime) as db:
            value = self._row(db, "dots_files", identifier, owner)
        if not value:
            raise FileNotFoundError("文件不存在")
        data = self.client.request("GET", value["key"], limit=MAX_INPUT, expected_size=int(value["bytes"]))
        if hashlib.sha256(data).hexdigest() != value["sha256"]:
            raise CosUnavailable("文件校验失败")
        return {**value, "data": data}

    def _cleanup(self, db, owner):
        now = self.clock()
        for identifier, raw in db.execute("SELECT id,data FROM tickets WHERE owner=?", (owner,)).fetchall():
            ticket = json.loads(raw)
            if ticket["expires"] > now:
                continue
            # Expiring COS prefix lifecycle removes interrupted uploads. Never make
            # upload preparation wait on a series of upstream DELETE requests.
            db.execute("DELETE FROM tickets WHERE id=? AND owner=?", (identifier, owner))
        db.commit()

    def initialize(self, runtime, payload):
        if payload.get("kind") != "input" or payload.get("purpose") != "enhance":
            return {"ok": True, "available": False}
        if set(payload) - {"kind", "files", "purpose"}:
            raise ValueError("图片上传信息无效")
        files = payload.get("files")
        if not isinstance(files, list) or not 1 <= len(files) <= 10:
            raise ValueError("请选择 1 到 10 张图片")
        prepared = []
        for item in files:
            if not isinstance(item, dict) or set(item) - {"name", "size", "type"}:
                raise ValueError("图片上传信息无效")
            name, size, mime = item.get("name"), item.get("size"), item.get("type", "")
            if (not isinstance(name, str) or not name or len(name) > 512 or "\x00" in name
                    or isinstance(size, bool) or not isinstance(size, int) or not 0 < size <= MAX_INPUT
                    or not isinstance(mime, str)):
                raise ValueError("图片为空或超过 40 MB")
            mime = mime.split(";")[0].lower().strip()
            if not mime or mime == "application/octet-stream":
                mime = mimetypes.guess_type(name)[0] or ""
            if mime not in {"image/jpeg", "image/png", "image/webp", "image/bmp", "image/gif", "image/heic", "image/heif"}:
                raise ValueError("请选择 JPEG、PNG、WebP、BMP、GIF 或 HEIC 图片")
            prepared.append((Path(name).name, size, mime))
        owner = self._scope(runtime)
        with self._lock(runtime), self._database(runtime) as db:
            self._cleanup(db, owner)
            pending = sum(not json.loads(raw).get("assetId") for (raw,) in db.execute(
                "SELECT data FROM tickets WHERE owner=?", (owner,)).fetchall())
            if pending + len(prepared) > MAX_PENDING:
                raise ValueError("待上传图片过多，请完成当前上传或稍后重试")
            uploads = []
            now = self.clock()
            for name, size, mime in prepared:
                identifier = str(uuid.uuid4())
                key = f"shiyan-web/uploads/{owner}/{identifier}"
                ticket = {"key": key, "name": name, "size": size, "mime": mime,
                          "expires": now + COMPLETE_TTL, "assetId": None}
                self._put(db, "tickets", identifier, owner, ticket)
                headers = {"Content-Type": mime, "Content-Length": str(size), "x-cos-acl": "private"}
                uploads.append({"ticketId": identifier, "method": "PUT", "headers": headers,
                                "url": self.client.signed_url("PUT", key, headers=headers, ttl=UPLOAD_TTL, now=now),
                                "expiresAt": int((now + UPLOAD_TTL) * 1000)})
            return {"ok": True, "available": True, "uploads": uploads}

    def complete(self, runtime, payload):
        identifiers = payload.get("ticketIds")
        if (set(payload) != {"ticketIds"} or not isinstance(identifiers, list)
                or not 1 <= len(identifiers) <= 10 or any(not isinstance(v, str) for v in identifiers)
                or len(set(identifiers)) != len(identifiers)):
            raise ValueError("图片上传凭据无效")
        owner = self._scope(runtime)
        with self._lock(runtime), self._database(runtime) as db:
            tickets = [self._row(db, "tickets", identifier, owner) for identifier in identifiers]
            if any(not ticket or (not ticket.get("assetId") and ticket["expires"] < self.clock()) for ticket in tickets):
                raise ValueError("图片上传凭据已过期或不存在，请重新选择图片")
            assets = []
            for identifier, ticket in zip(identifiers, tickets):
                if ticket.get("assetId"):
                    asset = runtime.storage.public_asset(runtime.storage.asset(ticket["assetId"]))
                else:
                    started = time.perf_counter()
                    head = self.client.head(ticket["key"])
                    etag = head.get("etag", "")
                    if (head.get("content-length") != str(ticket["size"])
                            or not re.fullmatch(r'"?[a-fA-F0-9]{32}(?:-[0-9]+)?"?', etag)
                            or head.get("content-type", "").split(";")[0].lower() != ticket["mime"]):
                        raise ValueError("上传图片的大小或格式信息不一致，请重新选择图片")
                    if ticket.get("frozenEtag") and ticket["frozenEtag"] != etag:
                        raise ValueError("上传图片已发生变化，请重新选择图片")
                    ticket["frozenEtag"] = etag
                    self._put(db, "tickets", identifier, owner, ticket)
                    key = f"shiyan-web/assets/{owner}/input-{identifier}"
                    existing = runtime.storage.get("assets", identifier)
                    if existing:
                        descriptor = existing.get("cosObject", {})
                        if descriptor.get("key") != key or descriptor.get("etag") != etag:
                            raise ValueError("图片上传凭据冲突，请重新选择图片")
                        asset = runtime.storage.public_asset(existing)
                    else:
                        copied = self.client.copy(ticket["key"], key, etag)
                        if copied.get("content-length") != str(ticket["size"]) or copied.get("etag") != etag:
                            raise CosUnavailable("图片传输暂时失败，请稍后重试")
                        asset = runtime.storage.save_remote_image(identifier, ticket["name"], ticket["mime"],
                            ticket["size"], {"host": self.config.host, "key": key, "etag": etag})
                    ticket["assetId"] = asset["id"]
                    self._put(db, "tickets", identifier, owner, ticket)
                    emit_timing("upload", "completed", source="server", assetId=asset["id"], bytes=ticket["size"],
                                durationMs=(time.perf_counter() - started) * 1000)
                assets.append(asset)
            return {"ok": True, "assets": assets}

    def cleanup_completed(self, runtime, identifiers):
        """Best effort after the response; lifecycle covers failed cleanup/replays."""
        owner = self._scope(runtime)
        with self._lock(runtime), self._database(runtime) as db:
            tickets = [self._row(db, "tickets", identifier, owner) for identifier in identifiers]
            keys = [ticket["key"] for ticket in tickets if ticket and ticket.get("assetId")]
        for key in keys:
            try:
                self.client.delete(key)
            except CosUnavailable:
                pass

    def descriptor(self, runtime, asset, *, thumbnail=False, require_remote=True):
        owner = self._scope(runtime)
        reference = asset.get("thumbnailCosObject") if thumbnail else asset.get("cosObject")
        if thumbnail and not reference:
            reference = asset.get("cosObject")
        if ((require_remote and not asset.get("remoteOnly")) or not isinstance(reference, dict)
                or reference.get("host") != self.config.host
                or not isinstance(reference.get("key"), str)
                or not reference["key"].startswith(f"shiyan-web/assets/{owner}/")
                or any(part in {"", ".", ".."} for part in reference["key"].split("/"))):
            raise ValueError("当前账号的图片存储信息无效")
        return reference

    def ensure_input(self, runtime, identifier):
        asset = runtime.storage.asset(identifier)
        owner = self._scope(runtime)
        key = f"shiyan-web/assets/{owner}/input-{identifier}"
        if not 0 < asset.get("bytes", 0) <= MAX_INPUT:
            raise ValueError("待增强原图超过 40 MB，请重新选择图片")
        with self._lock(runtime):
            if asset.get("cosObject"):
                reference = self.descriptor(runtime, asset, require_remote=False)
                if reference["key"] == key:
                    return self.input_metadata(runtime, identifier)
            if asset.get("remoteOnly"):
                reference = self.descriptor(runtime, asset)
                head = self.client.head(reference["key"])
                self.client.copy(reference["key"], key, head["etag"])
            else:
                # One-time migration of pre-existing local assets only. Newly
                # selected web images never download, decode or upload here.
                self.client.upload_file(key, runtime.storage.asset_path(identifier), asset["mimeType"])
            head = self.client.head(key)
            if head.get("content-length") != str(asset["bytes"]):
                raise CosUnavailable("图片传输暂时失败，请稍后重试")
            asset.update(cosObject={"host": self.config.host, "key": key, "etag": head["etag"]})
            runtime.storage.put("assets", asset)
            return self.input_metadata(runtime, identifier)

    def input_metadata(self, runtime, identifier):
        asset = runtime.storage.asset(identifier)
        reference = self.descriptor(runtime, asset, require_remote=False)
        owner = self._scope(runtime)
        if reference["key"] != f"shiyan-web/assets/{owner}/input-{identifier}":
            raise ValueError("请重新选择待增强的原图")
        return {"id": identifier, "key": reference["key"], "bytes": asset["bytes"],
                "name": asset["filename"], "mime": asset["mimeType"], "etag": reference["etag"]}

    def register_result(self, runtime, job, result):
        owner = self._scope(runtime)
        if result.get("kind") != "enhance_cos" or result.get("device") != "mps":
            raise ValueError("Mac 图片结果元数据无效")
        source, output, thumbnail = result.get("input"), result.get("output"), result.get("thumbnail")
        if not all(isinstance(item, dict) for item in (source, output, thumbnail)):
            raise ValueError("Mac 图片结果元数据无效")
        def integer(value, maximum):
            return not isinstance(value, bool) and isinstance(value, int) and 0 < value <= maximum
        if (not integer(source.get("width"), 3000) or not integer(source.get("height"), 3000)
                or not integer(source.get("bytes"), MAX_INPUT)
                or not re.fullmatch(r"[0-9a-f]{64}", str(source.get("sha256", "")))):
            raise ValueError("Mac 原图校验信息无效")
        references = []
        for kind, item in (("output", output), ("thumbnail", thumbnail)):
            key = item.get("key", "")
            pattern = rf"shiyan-web/assets/{owner}/{kind}-{re.escape(job['remoteTaskId'])}-[0-9a-f]{{32}}\.jpg"
            if (not isinstance(key, str) or not re.fullmatch(pattern, key)
                    or item.get("mime") != "image/jpeg"
                    or not integer(item.get("bytes"), 512 * 1024 * 1024 if kind == "output" else 4 * 1024 * 1024)
                    or not integer(item.get("width"), 12000 if kind == "output" else 768)
                    or not integer(item.get("height"), 12000 if kind == "output" else 768)
                    or not re.fullmatch(r"[0-9a-f]{64}", str(item.get("sha256", "")))):
                raise ValueError("Mac 图片结果元数据无效")
            if kind == "output" and (item["width"], item["height"]) != (source["width"] * 4, source["height"] * 4):
                raise ValueError("Mac 图片结果尺寸不一致")
            references.append({"host": self.config.host, "key": key, "mime": "image/jpeg"})
        current = runtime.storage.get("photoJobs", job["id"])
        if not current or current.get("state") == "cancelled":
            raise ValueError("增强任务已停止")
        original = runtime.storage.asset(job["inputAssetId"])
        original["normalizedInput"] = source
        original["validated"] = True
        runtime.storage.put("assets", original)
        identifier = str(uuid.uuid5(uuid.NAMESPACE_URL, "shiyan-cos-output:" + job["id"]))
        filename = Path(original["filename"]).stem + "_4x.jpg"
        if job["model"] == "anime":
            from desktop_backend.storage import anime_export_filename
            filename = anime_export_filename(filename)
        return runtime.storage.save_remote_image(identifier, filename, "image/jpeg", output["bytes"], references[0],
                width=output["width"], height=output["height"], sha256=output["sha256"],
                validated=True, thumbnail=references[1])

    def asset_url(self, runtime, identifier, download=False, thumbnail=False):
        asset = runtime.storage.asset(identifier)
        if not asset.get("remoteOnly"):
            return None  # Existing local assets retain their original file route.
        reference = self.descriptor(runtime, asset, thumbnail=thumbnail)
        mime = reference.get("mime", asset["mimeType"])
        inline = mime in {"image/jpeg", "image/png", "image/webp", "image/bmp"} and not download
        filename = asset["filename"] if inline else runtime.storage.export_filename(asset)
        disposition = ("inline" if inline else "attachment") + "; filename*=UTF-8''" + quote(filename, safe="")
        return self.client.signed_url("GET", reference["key"], ttl=DOWNLOAD_TTL,
                params={"response-content-type": mime, "response-content-disposition": disposition,
                        "response-cache-control": "private, max-age=0, no-store"})
