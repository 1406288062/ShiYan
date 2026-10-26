"""Web COS transfer isolation, signing, bounded IO and API contracts."""
import concurrent.futures
from contextlib import closing
import hashlib
import io
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
from types import SimpleNamespace
import unittest
import uuid
from unittest.mock import AsyncMock, Mock, patch
from urllib.parse import parse_qs, urlsplit

import httpx
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from shared.paths import APP_ROOT
sys.path.insert(0, str(APP_ROOT))
from desktop_backend.api import create_app
from desktop_backend.storage import Storage
from desktop_backend.runtime import Runtime
from apps.web.adapters.cos_transfer import CosClient, CosConfig, CosTransfer, CosUnavailable, MAX_INPUT


CONFIG = CosConfig("fixture-12345678", "ap-guangzhou", "fixture-id", "fixture-secret")


class MemoryCOS(CosClient):
    def __init__(self):
        super().__init__(CONFIG)
        self.objects = {}
        self.downloads = 0
        self.uploads = []
        self.deletes = []
        self.copies = []
        self.types = {}

    def download(self, key, size):
        self.downloads += 1
        return self.objects[key]

    def head(self, key):
        if key not in self.objects:
            raise CosUnavailable()
        return {"content-length": str(len(self.objects[key])), "content-type": self.types.get(key, "image/png"),
                "etag": '"' + hashlib.md5(self.objects[key]).hexdigest() + '"'}

    def copy(self, source, destination, etag):
        if self.head(source)["etag"] != etag:
            raise CosUnavailable()
        self.copies.append((source, destination))
        self.objects[destination] = self.objects[source]
        self.types[destination] = self.types.get(source, "image/png")
        return self.head(destination)

    def delete(self, key):
        self.deletes.append(key)
        self.objects.pop(key, None)

    def upload_file(self, key, path, mime):
        self.uploads.append((key, mime))
        self.objects[key] = Path(path).read_bytes()
        self.types[key] = mime


class TransferTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.runtimes = []
        self.runtime = self.runtime_for("alice")
        data = io.BytesIO()
        Image.new("RGB", (80, 40), (12, 34, 56)).save(data, "PNG")
        self.image = data.getvalue()
        self.client = MemoryCOS()
        self.clock = [1000.0]
        self.transfer = CosTransfer(CONFIG, self.client, clock=lambda: self.clock[0])

    def runtime_for(self, owner):
        storage = Storage(Path(self.folder.name) / owner, APP_ROOT)
        self.addCleanup(storage.db.close)
        runtime = SimpleNamespace(account={"owner": owner}, storage=storage, server_access=True,
                                  snapshot=Mock(), notify=Mock())
        self.runtimes.append(runtime)
        return runtime

    def start(self, runtime=None, size=None):
        return self.transfer.initialize(runtime or self.runtime, {"kind": "input", "purpose": "enhance", "files": [
            {"name": "测试.png", "size": size or len(self.image), "type": "image/png"}]})["uploads"][0]

    def staged(self, runtime=None):
        upload = self.start(runtime)
        self.client.objects[urlsplit(upload["url"]).path.lstrip("/")] = self.image
        return upload

    def test_upload_url_binds_private_acl_size_type_and_scoped_random_key(self):
        first, second = self.start(), self.start()
        url = urlsplit(first["url"])
        self.assertEqual(url.hostname, CONFIG.host)
        self.assertTrue(url.path.startswith("/shiyan-web/uploads/" + hashlib.sha256(b"alice").hexdigest() + "/"))
        self.assertNotEqual(first["url"], second["url"])
        self.assertEqual(first["headers"], {"Content-Type": "image/png", "Content-Length": str(len(self.image)), "x-cos-acl": "private"})
        query = parse_qs(url.query)
        self.assertEqual(query["q-header-list"], ["content-length;content-type;host;x-cos-acl"])
        self.assertEqual(query["q-sign-time"], ["940;1900"])
        self.assertNotIn(CONFIG.secret_key, first["url"])
        changed = self.client.signed_url("PUT", url.path.lstrip("/"), headers={**first["headers"], "x-cos-acl": "public-read"}, now=1000, ttl=900)
        self.assertNotEqual(parse_qs(urlsplit(changed).query)["q-signature"], query["q-signature"])

    def test_cross_account_and_unknown_tickets_rejected_before_cos_access(self):
        upload = self.staged()
        bob = self.runtime_for("bob")
        with self.assertRaises(ValueError):
            self.transfer.complete(bob, {"ticketIds": [upload["ticketId"]]})
        with self.assertRaises(ValueError):
            self.transfer.complete(self.runtime, {"ticketIds": ["foreign"]})
        self.assertEqual(self.client.downloads, 0)

    def test_tickets_persist_and_double_completion_is_idempotent(self):
        upload = self.staged()
        restarted = CosTransfer(CONFIG, self.client, clock=lambda: self.clock[0])
        payload = {"ticketIds": [upload["ticketId"]]}
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: restarted.complete(self.runtime, payload), range(2)))
        self.assertEqual(results[0], results[1])
        self.assertEqual(self.client.downloads, 0)
        self.assertEqual(len(self.runtime.storage.list("assets")), 1)
        asset = results[0]["assets"][0]
        self.assertEqual((asset["width"], asset["height"], asset["mimeType"]), (None, None, "image/png"))
        self.assertNotIn("storedName", asset)
        self.assertTrue(self.client.objects)  # Cleanup is deliberately off the response path.
        restarted.cleanup_completed(self.runtime, payload["ticketIds"])
        self.assertEqual(len(self.client.objects), 1)
        self.assertFalse(list(self.runtime.storage.media.iterdir()))
        self.runtime.notify.assert_not_called()
        self.runtime.snapshot.assert_not_called()

    def test_expired_ticket_and_untrusted_input_never_download(self):
        upload = self.staged()
        self.clock[0] += 1201
        for payload in ({"ticketIds": [upload["ticketId"]]},
                        {"ticketIds": [upload["ticketId"]], "url": "https://attacker/"},
                        {"ticketIds": [upload["ticketId"], upload["ticketId"]]}):
            with self.assertRaises(ValueError):
                self.transfer.complete(self.runtime, payload)
        self.assertEqual(self.client.downloads, 0)

    def test_size_mismatch_fails_but_image_decoding_is_deferred_to_mac(self):
        upload = self.start(size=len(self.image) + 1)
        self.client.objects[urlsplit(upload["url"]).path.lstrip("/")] = self.image
        with self.assertRaises(ValueError):
            self.transfer.complete(self.runtime, {"ticketIds": [upload["ticketId"]]})
        upload = self.start(size=5)
        self.client.objects[urlsplit(upload["url"]).path.lstrip("/")] = b"hello"
        asset = self.transfer.complete(self.runtime, {"ticketIds": [upload["ticketId"]]})["assets"][0]
        self.assertFalse(asset["validated"])
        self.assertTrue(asset["remoteOnly"])
        self.assertIsNone(asset["width"])
        self.assertEqual(self.client.downloads, 0)
        self.assertFalse(list(self.runtime.storage.media.iterdir()))

    def test_limits_and_image_kind_prevent_unbounded_presigning(self):
        good = {"name": "image.png", "size": len(self.image), "type": "image/png"}
        for payload in ({"kind": "input", "purpose": "enhance", "files": [good] * 11},
                        {"kind": "input", "purpose": "enhance", "files": [{**good, "size": MAX_INPUT + 1}]},
                        {"kind": "input", "purpose": "enhance", "files": [{**good, "type": "text/html"}]},
                        {"kind": "input", "purpose": "enhance", "files": [{**good, "key": "foreign"}]}):
            with self.assertRaises(ValueError):
                self.transfer.initialize(self.runtime, payload)
        for _ in range(20):
            self.start()
        with self.assertRaises(ValueError):
            self.start()

    def test_mirror_authorizes_owner_and_uses_immutable_key_and_fresh_signed_url(self):
        upload = self.staged()
        asset = self.transfer.complete(self.runtime, {"ticketIds": [upload["ticketId"]]})["assets"][0]
        url = self.transfer.asset_url(self.runtime, asset["id"], download=True)
        second = self.transfer.asset_url(self.runtime, asset["id"], download=False)
        self.assertEqual(len(self.client.uploads), 0)
        self.assertIn("/shiyan-web/assets/", url)
        self.assertNotEqual(urlsplit(url).path, urlsplit(upload["url"]).path)
        params = parse_qs(urlsplit(url).query)
        self.assertEqual(params["response-content-type"], ["image/png"])
        self.assertTrue(params["response-content-disposition"][0].startswith("attachment; filename*=UTF-8''"))
        self.assertIn("no-store", params["response-cache-control"][0])
        self.assertTrue(parse_qs(urlsplit(second).query)["response-content-disposition"][0].startswith("inline;"))
        with self.assertRaises(ValueError):
            self.transfer.asset_url(self.runtime_for("bob"), asset["id"])
        with closing(sqlite3.connect(self.runtime.storage.root / "cos-transfer.sqlite3")) as db:
            data = db.execute("SELECT data FROM tickets").fetchone()[0]
            self.assertNotIn("q-signature", data)
            self.assertNotIn("q-ak", data)

    def test_download_bounds_and_generic_upstream_errors(self):
        response = Mock(status=200)
        response.getheader.return_value = str(MAX_INPUT + 1)
        connection = Mock()
        connection.getresponse.return_value = response
        with patch("http.client.HTTPSConnection", return_value=connection):
            with self.assertRaises(CosUnavailable):
                CosClient(CONFIG).download("safe-key", 4)
        response.read.assert_not_called()
        connection.close.assert_called_once()
        connection.request.side_effect = RuntimeError("https://private/?secret=leak")
        with patch("http.client.HTTPSConnection", return_value=connection):
            with self.assertRaises(CosUnavailable) as caught:
                CosClient(CONFIG).download("safe-key", 4)
        self.assertNotIn("leak", str(caught.exception))

    def test_only_enhancement_uses_cos_and_ten_files_are_supported(self):
        self.assertEqual(self.transfer.initialize(self.runtime, {"kind": "attachment"}), {"ok": True, "available": False})
        self.assertEqual(self.transfer.initialize(self.runtime, {"kind": "input", "purpose": "remove"}), {"ok": True, "available": False})
        result = self.transfer.initialize(self.runtime, {"kind": "input", "purpose": "enhance", "files": [
            {"name": f"{n}.png", "size": len(self.image), "type": "image/png"} for n in range(10)]})
        self.assertEqual(len(result["uploads"]), 10)

    def test_old_local_asset_migrates_once_and_remote_asset_never_reads_disk(self):
        asset = self.runtime.storage.save_bytes(self.image, "old.png", "image/png")
        first = self.transfer.ensure_input(self.runtime, asset["id"])
        with patch.object(self.runtime.storage, "asset_path", side_effect=AssertionError("must not read local image")):
            second = self.transfer.ensure_input(self.runtime, asset["id"])
            self.transfer.asset_url(self.runtime, asset["id"])
        self.assertEqual(first, second)
        self.assertEqual(len(self.client.uploads), 1)
        self.assertEqual(self.client.downloads, 0)
        # Cached compute metadata must not disable old chat attachments or
        # other local image tools which still resolve the original asset path.
        saved = self.runtime.storage.asset(asset["id"])
        self.assertFalse(saved.get("remoteOnly"))
        self.assertEqual(self.runtime.storage.asset_path(asset["id"]).read_bytes(), self.image)
        self.assertIsNone(self.transfer.asset_url(self.runtime, asset["id"]))
        saved["cosObject"]["key"] = saved["cosObject"]["key"].replace(hashlib.sha256(b"owner-a").hexdigest(), "f" * 64)
        saved["cosObject"]["host"] = "other.example.com"
        self.runtime.storage.put("assets", saved)
        with self.assertRaises(ValueError):
            self.transfer.ensure_input(self.runtime, asset["id"])

    def test_replayed_browser_put_cannot_change_frozen_private_input(self):
        upload = self.staged()
        raw_key = urlsplit(upload["url"]).path.lstrip("/")
        asset = self.transfer.complete(self.runtime, {"ticketIds": [upload["ticketId"]]})["assets"][0]
        frozen = self.transfer.input_metadata(self.runtime, asset["id"])
        self.client.objects[raw_key] = b"other payload"
        self.assertEqual(self.client.objects[frozen["key"]], self.image)
        replay = self.transfer.complete(self.runtime, {"ticketIds": [upload["ticketId"]]})["assets"][0]
        self.assertEqual(replay["id"], asset["id"])


def result_fixture(owner, task_id):
    prefix = f"shiyan-web/assets/{hashlib.sha256(owner.encode()).hexdigest()}/"
    return {"kind": "enhance_cos", "device": "mps",
            "input": {"width": 80, "height": 40, "bytes": 1234, "sha256": "a" * 64},
            "output": {"key": prefix + f"output-{task_id}-" + "c" * 32 + ".jpg", "bytes": 2000,
                       "mime": "image/jpeg", "width": 320, "height": 160, "sha256": "b" * 64, "name": "result.jpg"},
            "thumbnail": {"key": prefix + f"thumbnail-{task_id}-" + "c" * 32 + ".jpg", "bytes": 1000,
                          "mime": "image/jpeg", "width": 320, "height": 160, "sha256": "d" * 64, "name": "thumb.jpg"}}


class RuntimeBatchTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.runtime = Runtime.__new__(Runtime)
        self.runtime.storage = Storage(self.folder.name, APP_ROOT)
        self.addCleanup(self.runtime.storage.db.close)
        self.runtime.account = {"owner": "alice"}
        self.runtime.platform = SimpleNamespace(mode="web")
        self.runtime.tasks = {}
        self.runtime.closing = False
        self.runtime.launch = lambda key, coro: coro.close()
        self.client = MemoryCOS()
        self.transfer = self.runtime._web_cos_transfer = CosTransfer(CONFIG, self.client)
        self.mac = patch("desktop_backend.runtime.MacComputeClient.enabled_for", return_value=True)
        self.mac.start()
        self.addCleanup(self.mac.stop)
        image = io.BytesIO()
        Image.new("RGB", (80, 40)).save(image, "PNG")
        self.image = image.getvalue()

    def asset(self):
        upload = self.transfer.initialize(self.runtime, {"kind": "input", "purpose": "enhance", "files": [
            {"name": "input.png", "size": len(self.image), "type": "image/png"}]})["uploads"][0]
        self.client.objects[urlsplit(upload["url"]).path.lstrip("/")] = self.image
        return self.transfer.complete(self.runtime, {"ticketIds": [upload["ticketId"]]})["assets"][0]

    async def test_batch_is_durable_and_partial_failure_keeps_success(self):
        assets = [self.asset() for _ in range(10)]
        response = self.runtime.create_photo_batch({"feature": "enhance", "model": "anime", "assetIds": [a["id"] for a in assets]})
        batch = response["batch"]
        self.assertEqual(batch["total"], 10)
        self.assertEqual(len(response["assets"]), 10)
        self.assertTrue(all(job["cosCompute"] for job in response["jobs"]))
        for index, job_id in enumerate(batch["jobIds"]):
            self.runtime.update_photo(job_id, state="completed" if index < 8 else "failed", progress=1, error=None if index < 8 else "fixture failure")
        persisted = self.runtime.photo_batch_status(batch["id"])
        self.assertEqual(persisted["batch"]["state"], "completed")
        self.assertEqual((persisted["batch"]["completedCount"], persisted["batch"]["failedCount"]), (8, 2))
        self.assertEqual(self.runtime.storage.get("photoBatches", batch["id"])["jobIds"], batch["jobIds"])
        before = len(self.runtime.storage.list("photoJobs"))
        for invalid in ([assets[0]["id"], "foreign"], [assets[0]["id"]] * 2, [a["id"] for a in assets] + [str(uuid.uuid4())]):
            with self.assertRaises(ValueError):
                self.runtime.create_photo_batch({"feature": "enhance", "assetIds": invalid})
        self.assertEqual(len(self.runtime.storage.list("photoJobs")), before)

    async def test_legacy_web_job_resumes_on_cos_without_local_image_io(self):
        asset = self.asset()
        job = self.runtime.create_photo_job({"feature": "enhance", "assetId": asset["id"], "model": "anime"})
        task_id = str(uuid.uuid4())
        result = result_fixture("alice", task_id)
        job.pop("macCompute")
        job.pop("cosCompute")
        self.runtime.storage.put("photoJobs", job)
        class Compute:
            @staticmethod
            def enabled_for(owner): return owner == "alice"
            def submit_enhance_cos(inner, owner, request_id, model, metadata, remember):
                remember(task_id)
                return {"id": task_id, "state": "queued"}
            def status(inner, owner, identifier):
                return {"id": identifier, "state": "completed", "result": result}
        with patch("desktop_backend.runtime.MacComputeClient", Compute), \
             patch("asyncio.create_subprocess_exec", side_effect=AssertionError("local inference")), \
             patch.object(self.runtime.storage, "asset_path", side_effect=AssertionError("local image IO")), \
             patch.object(self.runtime.storage, "save_bytes", side_effect=AssertionError("server decoding")), \
             patch.object(self.runtime.storage, "import_worker_output", side_effect=AssertionError("server output download")):
            await self.runtime.run_enhancement(job["id"])
        status = self.runtime.photo_status(job["id"])
        self.assertEqual(status["job"]["state"], "completed", status["job"].get("error"))
        output = status["assets"][0]
        self.assertTrue(output["remoteOnly"])
        self.assertTrue(output["validated"])
        self.assertEqual((output["width"], output["height"]), (320, 160))
        self.assertNotIn("cosObject", output)
        self.assertNotIn("thumbnailCosObject", output)
        self.assertEqual(len(status["history"]), 1)
        self.assertEqual(self.client.downloads, 0)
        self.assertEqual(self.client.uploads, [])
        self.assertFalse(list(self.runtime.storage.media.iterdir()))
        self.assertIn("thumbnail-", self.transfer.asset_url(self.runtime, output["id"], thumbnail=True))

    async def test_result_metadata_rejects_wrong_owner_dimensions_and_cancelled_job(self):
        asset = self.asset()
        job = self.runtime.create_photo_job({"feature": "enhance", "assetId": asset["id"]})
        task_id = str(uuid.uuid4())
        job = self.runtime.update_photo(job["id"], remoteTaskId=task_id, state="running")
        wrong_owner = result_fixture("bob", task_id)
        wrong_size = result_fixture("alice", task_id)
        wrong_size["output"]["width"] = 321
        for value in (wrong_owner, wrong_size):
            with self.assertRaises(ValueError):
                self.transfer.register_result(self.runtime, job, value)
        self.runtime.update_photo(job["id"], state="cancelled")
        with self.assertRaises(ValueError):
            self.transfer.register_result(self.runtime, job, result_fixture("alice", task_id))
        self.assertEqual(len(self.runtime.storage.list("assets")), 1)


class APITests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.storage = Storage(self.temp.name, APP_ROOT)
        self.addCleanup(self.storage.db.close)
        self.runtime = SimpleNamespace(storage=self.storage, account={"owner": "alice"}, server_access=True,
                                       notify=Mock(), snapshot=Mock())
        gate = patch("desktop_backend.api.MacComputeClient.enabled_for", return_value=True)
        gate.start()
        self.addCleanup(gate.stop)

    async def client(self, mode="web", config=None):
        with patch.dict(os.environ, {"SHIYAN_COS_CONFIG": ""}), \
             patch.object(CosConfig, "from_environment", return_value=config):
            app = create_app(self.temp.name, APP_ROOT, profile=mode)
        app.state.runtime = self.runtime
        app.state.accounts = SimpleNamespace(protect=AsyncMock())
        client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:17861",
                                  headers={"X-Shiyan-Local": "1"})
        self.addAsyncCleanup(client.aclose)
        return app, client

    async def test_disabled_and_desktop_keep_original_file_endpoint(self):
        image = io.BytesIO()
        Image.new("RGB", (4, 4)).save(image, "PNG")
        asset = self.storage.save_bytes(image.getvalue(), "fixture.png", "image/png")
        for mode, config in (("web", None), ("desktop", CONFIG)):
            app, client = await self.client(mode, config)
            response = await client.post("/api/assets/cos/upload", json={"kind": "input", "purpose": "enhance", "files": []})
            self.assertEqual(response.json(), {"ok": True, "available": False})
            response = await client.get(asset["url"])
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.content, image.getvalue())
            self.assertNotIn(CONFIG.host, (await client.get("/")).headers["content-security-policy"])

    async def test_unavailable_compute_rejects_upload_without_legacy_fallback(self):
        app, client = await self.client(config=CONFIG)
        app.state.cos_transfer.initialize = Mock(side_effect=AssertionError("must not presign"))
        with patch("desktop_backend.api.MacComputeClient.enabled_for", return_value=False):
            response = await client.post("/api/assets/cos/upload", json={"kind": "input", "purpose": "enhance", "files": []})
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {"ok": False, "error": "图片增强服务暂不可用，请稍后重试"})
        app.state.cos_transfer.initialize.assert_not_called()

    async def test_enabled_csp_only_allows_configured_host_and_errors_do_not_fallback(self):
        app, client = await self.client(config=CONFIG)
        policy = (await client.get("/")).headers["content-security-policy"]
        self.assertEqual(policy.count(CONFIG.origin), 2)
        self.assertNotIn("*", policy)
        app.state.cos_transfer.initialize = Mock(side_effect=CosUnavailable("credential should not escape"))
        response = await client.post("/api/assets/cos/upload", json={"kind": "input", "purpose": "enhance", "files": []})
        self.assertEqual(response.status_code, 503)
        self.assertNotIn("credential", response.text)
        self.assertNotIn("available", response.json())

    async def test_file_redirect_retains_authorization_and_file_metadata(self):
        app, client = await self.client(config=CONFIG)
        image = io.BytesIO()
        Image.new("RGB", (4, 4)).save(image, "PNG")
        asset = self.storage.save_bytes(image.getvalue(), "fixture.png", "image/png")
        app.state.cos_transfer.client = MemoryCOS()
        response = await client.get(asset["downloadUrl"])
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["x-content-sha256"], asset["sha256"])
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertEqual((await client.get("/api/assets/foreign/file")).status_code, 400)

    async def test_account_resource_proxy_keeps_upload_complete_and_download_working(self):
        app, client = await self.client(config=CONFIG)
        async def protect(request):
            request.scope["app"] = SimpleNamespace(state=SimpleNamespace(runtime=self.runtime))
        app.state.accounts.protect = protect
        upstream = MemoryCOS()
        app.state.cos_transfer.client = upstream
        image = io.BytesIO()
        Image.new("RGB", (4, 4)).save(image, "PNG")
        response = await client.post("/api/assets/cos/upload", json={"kind": "input", "purpose": "enhance", "files": [
            {"name": "image.png", "size": len(image.getvalue()), "type": "image/png"}]})
        self.assertEqual(response.status_code, 200, response.text)
        ticket = response.json()["uploads"][0]
        upstream.objects[urlsplit(ticket["url"]).path.lstrip("/")] = image.getvalue()
        response = await client.post("/api/assets/cos/complete", json={"ticketIds": [ticket["ticketId"]]})
        self.assertEqual(response.status_code, 200, response.text)
        asset = response.json()["assets"][0]
        self.assertNotIn("storedName", asset)
        response = await client.get(asset["url"])
        self.assertEqual(response.status_code, 307)
        self.assertEqual(urlsplit(response.headers["location"]).hostname, CONFIG.host)
        self.assertEqual((await client.get(f"/api/assets/{asset['id']}/thumbnail")).status_code, 307)
        self.assertEqual(upstream.downloads, 0)
        self.assertFalse(list(self.storage.media.iterdir()))
        self.assertEqual((await client.get("/assets/platform-cos.js")).status_code, 200)

    async def test_batch_api_settings_and_cancellation_preserve_account_boundaries(self):
        runtime = Runtime.__new__(Runtime)
        runtime.storage, runtime.account = self.storage, {"owner": "alice"}
        runtime.platform = SimpleNamespace(mode="desktop")
        runtime.tasks, runtime.closing = {}, False
        runtime.launch = lambda key, coro: coro.close()
        runtime.notify = Mock()
        runtime.server_access = True
        self.runtime = runtime
        app, client = await self.client(mode="desktop")
        image = io.BytesIO()
        Image.new("RGB", (4, 4)).save(image, "PNG")
        assets = [self.storage.save_bytes(image.getvalue(), f"{i}.png", "image/png") for i in range(10)]
        identifiers = [asset["id"] for asset in assets]
        response = await client.post("/api/photo/jobs/batch", json={"feature": "enhance", "assetIds": identifiers, "model": "anime"})
        self.assertEqual(response.status_code, 200, response.text)
        batch = response.json()["batch"]
        self.assertEqual(len(response.json()["jobs"]), 10)
        self.assertNotIn("state", response.json())
        response = await client.patch("/api/settings?compact=1", json={"homeInputAssetIds": identifiers, "homePhotoBatchId": batch["id"]})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["settings"]["homeInputAssetIds"], identifiers)
        for payload in ({"homeInputAssetIds": ["foreign"]}, {"homeInputAssetIds": identifiers + [str(uuid.uuid4())]},
                        {"homePhotoBatchId": "foreign"}):
            self.assertEqual((await client.patch("/api/settings?compact=1", json=payload)).status_code, 400)
        self.assertEqual((await client.get("/api/photo/batches/foreign")).status_code, 400)
        self.assertEqual((await client.get("/api/photo/batches/" + batch["id"])).status_code, 200)
        response = await client.post("/api/photo/batches/" + batch["id"] + "/cancel")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["batch"]["state"], "cancelled")
        self.assertEqual(response.json()["batch"]["cancelledCount"], 10)


if __name__ == "__main__":
    unittest.main()
