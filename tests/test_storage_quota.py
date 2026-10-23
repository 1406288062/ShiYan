"""Disk admission checks use temporary files, never real accounts or host volumes."""
import io
import importlib.util
import os
import multiprocessing
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import uuid

from PIL import Image
from desktop_backend.storage import Storage


def hold_reservation(root, ledger, ready, release):
    store = Storage(root, root, quota_bytes=1024 * 1024, minimum_free_bytes=0, reservation_file=ledger)
    try:
        with store.reserve(700 * 1024):
            ready.set()
            release.wait(10)
    finally:
        store.close()


class StorageQuotaTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="shiyan-upload-quota-")
        self.root = Path(self.temporary.name)
        self.ledger = self.root / "ledger.json"
        self.stores = []

    def tearDown(self):
        for store in self.stores:
            store.close()
        self.temporary.cleanup()

    def storage(self, folder="a", quota=1024 * 1024):
        store = Storage(self.root / folder, self.root, quota_bytes=quota,
                        minimum_free_bytes=0, reservation_file=self.ledger)
        self.stores.append(store)
        return store

    def test_assets_transfers_and_database_share_one_quota(self):
        store = self.storage()
        asset = store.save_bytes(b"a" * (400 * 1024), "first.bin")
        store.write_bytes(store.transfers / "download.part", b"b" * (400 * 1024))
        with self.assertRaisesRegex(ValueError, "个人文件空间"):
            store.save_bytes(b"c" * (300 * 1024), "over-quota.bin")
        self.assertEqual([asset["id"]], [value["id"] for value in store.list("assets")])
        self.assertEqual(1, len(list(store.media.iterdir())))
        self.assertFalse(list(store.root.rglob("*.tmp")))
        # A second account keeps its independent allowance.
        self.storage("b").save_bytes(b"d" * (400 * 1024), "other.bin")

    def test_separate_processes_cannot_overbook_one_owner(self):
        store = self.storage()
        context = multiprocessing.get_context("spawn")
        ready, release = context.Event(), context.Event()
        child = context.Process(target=hold_reservation, args=(str(store.root), str(self.ledger), ready, release))
        child.start()
        try:
            self.assertTrue(ready.wait(10))
            with self.assertRaisesRegex(ValueError, "个人文件空间"):
                store.save_bytes(b"a" * (400 * 1024), "concurrent.bin")
        finally:
            release.set()
            child.join(10)
            if child.is_alive():
                child.kill()
                child.join()
        self.assertEqual(child.exitcode, 0)
        store.save_bytes(b"a" * (400 * 1024), "after-release.bin")

    def test_global_reservations_preserve_host_headroom_across_owners(self):
        first, second = self.storage(), self.storage("b")
        first.minimum_free_bytes = second.minimum_free_bytes = 1024 * 1024
        disk = type("Disk", (), {"free": 1024 * 1024 + 700 * 1024})()
        with patch("desktop_backend.storage.shutil.disk_usage", return_value=disk):
            with first.reserve(500 * 1024):
                with self.assertRaisesRegex(ValueError, "存储空间不足"):
                    second.save_bytes(b"a" * (300 * 1024), "no-host-space.bin")
        self.assertFalse(list(second.media.iterdir()))

    def test_metadata_growth_is_bounded_but_shrinking_and_delete_still_work(self):
        store = self.storage()
        store.put("conversations", {"id": "chat", "title": "old"})
        store.set_setting("prompt", "old")
        store.quota_bytes = store._cache_usage()[0]
        with self.assertRaisesRegex(ValueError, "个人文件空间"):
            store.put("conversations", {"id": "new", "title": "x" * 100})
        with self.assertRaisesRegex(ValueError, "个人文件空间"):
            store.set_setting("prompt", "x" * 100)
        store.put("conversations", {"id": "chat"})
        store.set_setting("prompt", "")
        store.remove("conversations", "chat")
        self.assertEqual([], store.list("conversations"))

    def test_worker_import_and_thumbnails_use_actual_write_admission(self):
        store = self.storage(quota=2 * 1024 * 1024)
        output = io.BytesIO()
        Image.new("RGB", (32, 32), "red").save(output, "JPEG")
        asset = store.save_bytes(output.getvalue(), "source.jpg", "image/jpeg")
        store.quota_bytes = store._cache_usage()[0] + 10
        with self.assertRaisesRegex(ValueError, "个人文件空间"):
            store.thumbnail_path(asset["id"])
        store.quota_bytes = 2 * 1024 * 1024
        job_id = str(uuid.uuid4())
        store.put("photoJobs", {"id": job_id, "feature": "enhance", "state": "running"})
        folder = store.transfers / ("enhance-" + job_id)
        folder.mkdir()
        source = folder / "result.jpg"
        source.write_bytes(output.getvalue())
        store.quota_bytes = store._cache_usage()[0] + 10
        with self.assertRaisesRegex(ValueError, "个人文件空间"):
            store.import_worker_output(source, "result.jpg", job_id, (32, 32))
        self.assertEqual(1, len(store.list("assets")))
        self.assertTrue(source.exists())
        self.assertFalse(list(store.root.rglob("*.tmp")))


@unittest.skipUnless(importlib.util.find_spec("fastapi"), "requires the existing web runtime environment")
class UploadAdmissionTests(unittest.IsolatedAsyncioTestCase):
    async def test_multipart_quota_and_chunked_body_limit_apply_to_real_upload_route(self):
        import httpx
        from desktop_backend.api import create_app
        from desktop_backend.verify_accounts import FakeGateway
        with tempfile.TemporaryDirectory(prefix="shiyan-upload-http-") as directory, patch.dict(os.environ, {"SHIYAN_OFFLINE_TEST": "1", "SHIYAN_MULTIUSER_WEB": "0"}), patch("desktop_backend.account_sessions.Gateway", FakeGateway), patch("desktop_backend.runtime.Gateway", FakeGateway):
            app = create_app(directory, Path(__file__).resolve().parents[1])
            async with app.router.lifespan_context(app):
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:7860", headers={"X-Shiyan-Local": "1"}) as client:
                    response = await client.post("/api/auth/register", json={"email": "quota-http@test"})
                    self.assertEqual(response.status_code, 200, response.text)
                    store = app.state.accounts.resources.runtime.storage
                    self.assertEqual(store.quota_bytes, 256 * 1024 * 1024)
                    response = await client.post("/api/assets", data={"kind": "attachment"}, files={"files": ("own.txt", b"private file", "text/plain")})
                    self.assertEqual(response.status_code, 200, response.text)
                    self.assertEqual(len(store.list("assets")), 1)
                    store.quota_bytes = store._cache_usage()[0] + 8
                    response = await client.post("/api/assets", data={"kind": "attachment"}, files={"files": ("no-space.txt", b"blocked file", "text/plain")})
                    self.assertEqual(response.status_code, 400, response.text)
                    self.assertEqual(len(store.list("assets")), 1)
                    self.assertFalse(list(store.transfers.iterdir()))
                    store.quota_bytes = 256 * 1024 * 1024
                    async def body():
                        for _ in range(65):
                            yield b"x" * (1024 * 1024)
                    response = await client.post("/api/assets", headers={"content-type": "application/json"}, content=body())
                    self.assertEqual(response.status_code, 413, response.text)
                    self.assertIn("64 MB", response.text)
                    self.assertEqual(len(store.list("assets")), 1)


if __name__ == "__main__":
    unittest.main()
