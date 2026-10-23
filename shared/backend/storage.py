 
from __future__ import annotations
import hashlib
import io
import json
import mimetypes
import os
from pathlib import Path
import shutil
import sqlite3
import threading
import uuid
import warnings
from datetime import datetime, timezone

from .upload_image import upload_image_copy

def now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

def new_id():
    return str(uuid.uuid4())

def anime_export_filename(filename):
     
    name = Path(filename or "图片.jpg").name
    stem, suffix = Path(name).stem, Path(name).suffix
    if stem.casefold().endswith(("_anime", "_anime_4x")):
        return name
    return stem + "_anime" + suffix

class Storage:
    def __init__(self, directory, project_root):
        self.root = Path(directory).expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.media = self.root / "assets"
        self.media.mkdir(exist_ok=True, mode=0o700)
        self.transfers = self.root / "transfers"
        self.transfers.mkdir(exist_ok=True, mode=0o700)
        self.thumbnail_lock = threading.Lock()
        self.lock = threading.RLock()
        self.db = sqlite3.connect(self.root / "state.sqlite3", check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("CREATE TABLE IF NOT EXISTS documents (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,id))")
        self.db.execute("CREATE TABLE IF NOT EXISTS preferences (key TEXT PRIMARY KEY, data TEXT NOT NULL)")
        self.db.commit()
        result = self.db.execute("PRAGMA quick_check").fetchone()
        if result[0] != "ok":
            raise RuntimeError("本地记录校验失败，原数据库已保留，请恢复备份")
        os.chmod(self.root / "state.sqlite3", 0o600)
        self.project_root = Path(project_root)
        self.sync_observer = None

    def list(self, kind):
        with self.lock:
            return [json.loads(row[0]) for row in self.db.execute("SELECT data FROM documents WHERE kind=?", (kind,))]

    def get(self, kind, identifier):
        with self.lock:
            row = self.db.execute("SELECT data FROM documents WHERE kind=? AND id=?", (kind, identifier)).fetchone()
            return json.loads(row[0]) if row else None

    def put(self, kind, value):
        encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        with self.lock, self.db:
            previous = self.get(kind, value["id"]) if self.sync_observer else None
            self.db.execute("INSERT INTO documents(kind,id,data) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data",
                            (kind, value["id"], encoded))
            if self.sync_observer:
                self.sync_observer(kind, value, previous)
        return value

    def remove(self, kind, identifier):
        with self.lock, self.db:
            previous = self.get(kind, identifier) if self.sync_observer else None
            self.db.execute("DELETE FROM documents WHERE kind=? AND id=?", (kind, identifier))
            if self.sync_observer:
                self.sync_observer(kind, None, previous)

    def setting(self, key, fallback=None):
        with self.lock:
            row = self.db.execute("SELECT data FROM preferences WHERE key=?", (key,)).fetchone()
            return json.loads(row[0]) if row else fallback

    def set_setting(self, key, value):
        with self.lock, self.db:
            self.db.execute("INSERT INTO preferences(key,data) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
                            (key, json.dumps(value, ensure_ascii=False)))

    def asset(self, identifier):
        value = self.get("assets", identifier)
        if value is None:
            raise ValueError("图片或文件不存在")
        return value

    def asset_path(self, identifier):
        item = self.asset(identifier)
        target = (self.media / item["storedName"]).resolve()
        if not target.is_relative_to(self.media) or not target.is_file():
            raise ValueError("本地文件不存在")
        return target

    def thumbnail_path(self, identifier):
        from PIL import Image, ImageOps
        item = self.asset(identifier)
        if not item.get("mimeType", "").startswith("image/"):
            raise ValueError("该文件不是图片")
        source = self.asset_path(identifier)
        cache = self.root / "thumbnails"
        cache.mkdir(exist_ok=True, mode=0o700)
        key = hashlib.sha256((item["sha256"] + ":space-v1-768").encode()).hexdigest()
        target = cache / (key + ".png")
        if target.is_file():
            return target
        with self.thumbnail_lock:
            if target.is_file():
                return target
            temporary = cache / (key + "." + uuid.uuid4().hex + ".tmp")
            try:
                with Image.open(source) as opened:
                    opened.thumbnail((768, 768), Image.Resampling.LANCZOS, reducing_gap=3.0)
                    image = ImageOps.exif_transpose(opened)
                    if image.mode not in {"RGB", "RGBA"}:
                        image = image.convert("RGBA")
                    with temporary.open("xb") as output:
                        os.chmod(temporary, 0o600)
                        image.save(output, "PNG", optimize=True)
                temporary.replace(target)
            finally:
                temporary.unlink(missing_ok=True)
        return target

    @staticmethod
    def public_asset(item):
        return {k: v for k, v in item.items() if k not in {"storedName", "sourcePath"}}

    def public_assets(self, ids):
        result = []
        for identifier in ids:
            item = self.get("assets", identifier)
            if item:
                result.append(self.public_asset(item))
        return result

    def export_filename(self, asset, history=None):
         
        identifier = asset["id"]
        anime = history is not None and history.get("modelName") == "动漫增强"
        if history is None:
            anime = any(entry.get("assetId") == identifier and entry.get("modelName") == "动漫增强"
                        for entry in self.list("history"))
        if not anime:
            anime = any(job.get("feature") == "enhance" and job.get("model") == "anime"
                        and (job.get("outputAssetId") == identifier or
                             any(output.get("id") == identifier for output in job.get("outputAssets", [])))
                        for job in self.list("photoJobs"))
        filename = Path(asset["filename"]).name
        return anime_export_filename(filename) if anime else filename

    @staticmethod
    def normalized_image_bytes(image, *, mask=False, force_jpeg=False):
         
        from PIL import Image
        image.thumbnail((3000, 3000), Image.Resampling.LANCZOS)
        out = io.BytesIO()
        if not force_jpeg and (mask or "A" in image.getbands()):
            image.convert("RGBA" if "A" in image.getbands() else "RGB").save(out, "PNG")
            return out.getvalue(), ".png", "image/png"
        image.convert("RGB").save(out, "JPEG", quality=95)
        return out.getvalue(), ".jpg", "image/jpeg"

    def request_image(self, identifier, *, mask=False):
         
        item = self.asset(identifier)
        source = self.asset_path(identifier)
        if max(item.get("width") or 0, item.get("height") or 0) <= 3000 and item["bytes"] <= 40 * 1024 * 1024:
            suffix = ".png" if item["mimeType"] == "image/png" else ".webp" if item["mimeType"] == "image/webp" else ".jpg"
            return upload_image_copy(source.read_bytes(), suffix, mask=mask)
        from PIL import Image, ImageOps
        import warnings
        from .limits import MAX_LOCAL_OUTPUT_PIXELS
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", Image.DecompressionBombWarning)
            with Image.open(source) as opened:
                if opened.width * opened.height > MAX_LOCAL_OUTPUT_PIXELS:
                    raise ValueError("图片超过可发送尺寸")
                opened.draft("RGB", (3000, 3000))
                image = ImageOps.exif_transpose(opened)
                data, suffix, _ = self.normalized_image_bytes(image, mask=mask, force_jpeg=not mask)
        if len(data) > 40 * 1024 * 1024:
            raise ValueError("图片请求副本超过 40 MB")
        return upload_image_copy(data, suffix, mask=mask)

    def save_bytes(self, data, filename, mime=None, *, normalize=False, mask=False, remote_id=None):
        if not data or len(data) > 40 * 1024 * 1024:
            raise ValueError("文件为空或超过 40 MB")
        filename = Path(filename or "文件").name.replace("\x00", "")[:180]
        suffix = Path(filename).suffix.lower()
        mime = (mime or mimetypes.guess_type(filename)[0] or "application/octet-stream").split(";")[0]
        width = height = None
        if mime.startswith("image/") or suffix in {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".heic", ".heif"}:
            from PIL import Image, ImageOps, UnidentifiedImageError
            try:
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore", Image.DecompressionBombWarning)
                    with Image.open(io.BytesIO(data)) as opened:
                        pixel_limit = 144_000_000 if normalize and not mask else 40_000_000
                        if opened.width * opened.height > pixel_limit:
                            raise ValueError("图片像素过大，请先缩小后导入")
                        image = ImageOps.exif_transpose(opened)
                        image.load()
                        if normalize:
                            data, suffix, mime = self.normalized_image_bytes(image, mask=mask)
                        width, height = image.size
                        if mask and not normalize:
                            out = io.BytesIO()
                            image.convert("RGBA" if "A" in image.getbands() else "RGB").save(out, "PNG")
                            data, suffix, mime = out.getvalue(), ".png", "image/png"
                        elif normalize:
                            pass
                        else:
                            actual = (opened.format or "").upper()
                            suffix, mime = {"JPEG":(".jpg","image/jpeg"),"PNG":(".png","image/png"),"WEBP":(".webp","image/webp"),"BMP":(".bmp","image/bmp")}.get(actual, (suffix, mime))
            except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
                raise ValueError("无法读取图片，请选择完整的 JPEG、PNG、WebP 或 HEIC 文件") from exc
        if not suffix or len(suffix) > 12 or any(c not in ".abcdefghijklmnopqrstuvwxyz0123456789" for c in suffix):
            suffix = ".bin"
        identifier = new_id()
        stored = identifier + suffix
        destination = self.media / stored
        temporary = destination.with_suffix(destination.suffix + ".tmp")
        with open(temporary, "xb") as output:
            os.chmod(temporary, 0o600)
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        temporary.replace(destination)
        item = {"id":identifier,"filename":Path(filename).stem + suffix,"mimeType":mime,
                "width":width,"height":height,"bytes":len(data),"createdAt":now(),"storedName":stored,
                "sha256":hashlib.sha256(data).hexdigest(),"url":f"/api/assets/{identifier}/file",
                "downloadUrl":f"/api/assets/{identifier}/file?download=1","remoteId":remote_id}
        self.put("assets", item)
        return self.public_asset(item)

    def import_worker_output(self, source, filename, job_id, expected_size):
         

 
 
 
        from PIL import Image
        import warnings
        from .limits import MAX_LOCAL_OUTPUT_BYTES, MAX_LOCAL_OUTPUT_PIXELS
        try:
            canonical_id = str(uuid.UUID(str(job_id)))
        except (ValueError, TypeError, AttributeError) as error:
            raise ValueError("增强任务标识无效") from error
        if canonical_id != str(job_id):
            raise ValueError("增强任务标识无效")
        job = self.get("photoJobs", canonical_id)
        if not job or job.get("feature") != "enhance" or job.get("state") != "running":
            raise ValueError("增强任务状态无效")
        folder = self.transfers / ("enhance-" + canonical_id)
        expected = folder / "result.jpg"
        source = Path(source)
        if (folder.is_symlink() or source.is_symlink() or source.resolve() != expected
                or not source.is_file()):
            raise ValueError("增强结果路径无效")
        size = source.stat().st_size
        if not 0 < size <= MAX_LOCAL_OUTPUT_BYTES:
            raise ValueError("增强结果文件超过可保存大小")
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", Image.DecompressionBombWarning)
            with Image.open(source) as opened:
                width, height = opened.size
                if (opened.format != "JPEG" or width <= 0 or height <= 0
                        or width > 12000 or height > 12000
                        or width * height > MAX_LOCAL_OUTPUT_PIXELS
                        or (width, height) != tuple(expected_size)):
                    raise ValueError("增强结果格式或尺寸校验失败")
                opened.verify()
        identifier = new_id()
        filename = Path(filename or "增强图片.jpg").name.replace("\x00", "")[:180]
        destination = self.media / (identifier + ".jpg")
        temporary = destination.with_suffix(".jpg.tmp")
        digest = hashlib.sha256()
        copied = 0
        try:
            with open(source, "rb") as incoming, open(temporary, "xb") as outgoing:
                os.chmod(temporary, 0o600)
                while chunk := incoming.read(1024 * 1024):
                    copied += len(chunk)
                    if copied > MAX_LOCAL_OUTPUT_BYTES:
                        raise ValueError("增强结果文件超过可保存大小")
                    outgoing.write(chunk)
                    digest.update(chunk)
                if copied != size:
                    raise ValueError("增强结果在保存期间发生变化")
                outgoing.flush()
                os.fsync(outgoing.fileno())
            current = self.get("photoJobs", canonical_id)
            if not current or current.get("state") != "running":
                raise ValueError("增强任务已停止")
            temporary.replace(destination)
            item = {"id":identifier,"filename":Path(filename).stem + ".jpg","mimeType":"image/jpeg",
                    "width":width,"height":height,"bytes":copied,"createdAt":now(),
                    "storedName":destination.name,"sha256":digest.hexdigest(),
                    "url":f"/api/assets/{identifier}/file",
                    "downloadUrl":f"/api/assets/{identifier}/file?download=1","remoteId":None}
            self.put("assets", item)
            return self.public_asset(item)
        except BaseException:
            temporary.unlink(missing_ok=True)
            destination.unlink(missing_ok=True)
            raise

    def add_history(self, asset_id, model_name, filename=None, job_id=None):
        if job_id:
            existing = next((h for h in self.list("history") if h.get("jobId")==job_id and h["assetId"]==asset_id), None)
            if existing:
                return existing
        asset = self.asset(asset_id)
        entry = {"id":new_id(),"assetId":asset_id,"filename":filename or asset["filename"],
                 "modelName":model_name,"createdAt":now(),"imageWidth":asset.get("width"),
                 "imageHeight":asset.get("height"),"jobId":job_id}
        return self.put("history", entry)

    def import_legacy_outputs(self):
        if self.setting("legacyOutputsImported", False):
            return
        folder = self.project_root / "outputs"
        imported = 0
        if folder.is_dir():
            for source in sorted(folder.iterdir()):
                if source.is_symlink() or not source.is_file() or source.suffix.lower() not in {".jpg",".jpeg",".png",".webp",".bmp"}:
                    continue
                if source.stat().st_size > 40 * 1024 * 1024:
                    continue
                marker = "legacy:" + hashlib.sha256(str(source.resolve()).encode()).hexdigest()
                if self.setting(marker):
                    continue
                asset = self.save_bytes(source.read_bytes(), source.name)
                self.add_history(asset["id"], "历史增强", source.name)
                self.set_setting(marker, asset["id"])
                imported += 1
        self.set_setting("legacyOutputsImported", True)
        self.set_setting("legacyImportedCount", self.setting("legacyImportedCount", 0) + imported)

    def close(self):
        with self.lock:
            self.db.close()
