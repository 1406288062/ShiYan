"""Compute routing checks use isolated files, loopback HTTP and synthetic pixels."""
from __future__ import annotations
import asyncio
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
import unittest
from unittest.mock import patch

_repository = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(_repository), str(_repository / "Mac")]
from shared.compute.client import MacComputeClient, MacComputeError
from shared.compute.worker import TaskRunner, WorkerHTTP
from desktop_backend.runtime import Runtime
from desktop_backend.storage import Storage
from PIL import Image


class ClientTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.seen = []
        self.state = "uploading"
        test = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def respond(self, body):
                encoded = json.dumps(body).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                test.seen.append((self.path, self.headers["X-Shiyan-Owner"], body))
                self.respond({"task": {"id": "fixed-id", "state": test.state}})
            def do_PUT(self):
                test.uploaded = self.rfile.read(int(self.headers["Content-Length"]))
                test.state = "queued"
                self.respond({"ok": True})
            def do_GET(self):
                self.respond({"task": {"id": "fixed-id", "state": test.state}})
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        self.config = self.root / "client.json"
        self.config.write_text(json.dumps({"url": "http://127.0.0.1:" + str(server.server_port), "token": "fixture-token", "owners": ["owner-A"]}))
        self.config.chmod(0o600)

    def test_configuration_must_be_private_and_loopback(self):
        self.config.chmod(0o644)
        with self.assertRaises(MacComputeError):
            MacComputeClient(self.config)
        self.config.chmod(0o600)
        config = json.loads(self.config.read_text())
        config["url"] = "http://example.com"
        self.config.write_text(json.dumps(config))
        with self.assertRaises(MacComputeError):
            MacComputeClient(self.config)

    def test_missing_explicit_config_fails_closed_and_no_env_is_disabled(self):
        with patch.dict(os.environ, {"SHIYAN_MAC_COMPUTE_CONFIG": str(self.root / "missing")}):
            with self.assertRaises(MacComputeError):
                MacComputeClient.enabled_for("owner-A")
        with patch.dict(os.environ, {}, clear=True):
            self.assertFalse(MacComputeClient.enabled_for("owner-A"))

    def test_owner_is_checked_before_network_and_image_is_streamed(self):
        client = MacComputeClient(self.config)
        with self.assertRaises(MacComputeError):
            client.status("owner-B", "fixed-id")
        self.assertEqual(self.seen, [])
        source = self.root / "fixture.png"
        Image.new("RGB", (3, 5), "red").save(source)
        result = client.submit_enhance("owner-A", "request-1", "anime", source, 3, 5)
        self.assertEqual(result["state"], "queued")
        self.assertEqual(self.uploaded, source.read_bytes())
        body = self.seen[0][2]
        self.assertEqual(body["params"]["input_bytes"], source.stat().st_size)
        self.assertEqual(body["params"]["width"], 3)
        # Deduplicated already-queued task must not be uploaded again.
        del self.uploaded
        client.submit_enhance("owner-A", "request-1", "anime", source, 3, 5)
        self.assertFalse(hasattr(self, "uploaded"))

    def test_worker_requires_https(self):
        for url in ("http://example.com", "https://user:pass@example.com", "https://example.com?token=secret"):
            with self.assertRaises(MacComputeError):
                WorkerHTTP({"url": url, "token": "fixture"})


class RuntimeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.runtime = Runtime.__new__(Runtime)
        self.runtime.storage = Storage(root / "data", root)
        self.addCleanup(self.runtime.storage.close)
        self.runtime.account = {"owner": "owner-A"}
        self.runtime.platform = SimpleNamespace(mode="web")
        self.runtime.closing = False
        self.runtime.tasks = {}
        self.runtime.notify = lambda: None
        self.runtime.launch = lambda key, coroutine: coroutine.close()
        image = io.BytesIO()
        Image.new("RGB", (3, 5), "red").save(image, "PNG")
        self.asset = self.runtime.storage.save_bytes(image.getvalue(), "fixture.png", "image/png")
        self.payload = {"feature": "enhance", "assetId": self.asset["id"], "model": "anime"}

    def test_only_bound_web_owner_is_routed(self):
        with patch("desktop_backend.runtime.MacComputeClient.enabled_for", return_value=True):
            job = self.runtime.create_photo_job(self.payload)
            self.assertTrue(job["macCompute"])
            self.runtime.platform.mode = "desktop"
            self.assertNotIn("macCompute", self.runtime.create_photo_job(self.payload))
        self.runtime.platform.mode = "web"
        with patch("desktop_backend.runtime.MacComputeClient.enabled_for", return_value=False):
            self.assertNotIn("macCompute", self.runtime.create_photo_job(self.payload))

    async def test_existing_remote_task_resumes_without_resubmission(self):
        with patch("desktop_backend.runtime.MacComputeClient.enabled_for", return_value=True):
            job = self.runtime.create_photo_job(self.payload)
        job.update(remoteTaskId="persisted-task", macInputWidth=3, macInputHeight=5)
        self.runtime.storage.put("photoJobs", job)
        class Client:
            def status(self, owner, task):
                assert (owner, task) == ("owner-A", "persisted-task")
                return {"id": task, "state": "completed"}
            def download_image(self, owner, task, destination):
                Image.new("RGB", (12, 20), "blue").save(destination, "JPEG")
            def submit_enhance(self, *args):
                raise AssertionError("A persisted task must not be submitted twice")
        with patch("desktop_backend.runtime.MacComputeClient.enabled_for", return_value=True), patch("desktop_backend.runtime.MacComputeClient", return_value=Client()) as constructor:
            constructor.enabled_for.return_value = True
            await self.runtime.run_enhancement(job["id"])
        result = self.runtime.storage.get("photoJobs", job["id"])
        self.assertEqual(result["state"], "completed")
        self.assertEqual(result["device"], "mps")
        self.assertEqual(len(self.runtime.storage.list("history")), 1)

    async def test_new_image_upload_persists_id_before_result_and_imports(self):
        with patch("desktop_backend.runtime.MacComputeClient.enabled_for", return_value=True):
            job = self.runtime.create_photo_job(self.payload)
        test = self
        class Client:
            def submit_enhance(self, owner, request_id, model, source, width, height, on_created):
                test.assertEqual((owner, model, width, height), ("owner-A", "anime", 3, 5))
                test.assertTrue(Path(source).is_file())
                on_created("new-task")
                test.assertEqual(test.runtime.storage.get("photoJobs", job["id"])["remoteTaskId"], "new-task")
                return {"id": "new-task", "state": "queued"}
            def status(self, owner, task):
                return {"id": task, "state": "completed"}
            def download_image(self, owner, task, destination):
                Image.new("RGB", (12, 20), "blue").save(destination, "JPEG")
        with patch("desktop_backend.runtime.MacComputeClient", return_value=Client()) as constructor:
            constructor.enabled_for.return_value = True
            await self.runtime.run_enhancement(job["id"])
        result = self.runtime.storage.get("photoJobs", job["id"])
        self.assertEqual(result["state"], "completed")
        self.assertEqual(result["remoteTaskId"], "new-task")

    async def test_stop_during_upload_waits_for_id_and_cancels_remote(self):
        with patch("desktop_backend.runtime.MacComputeClient.enabled_for", return_value=True):
            job = self.runtime.create_photo_job(self.payload)
        created, release = threading.Event(), threading.Event()
        cancellations = []
        class Client:
            def submit_enhance(self, owner, request_id, model, source, width, height, on_created):
                on_created("uploading-task")
                created.set()
                if not release.wait(5):raise RuntimeError("fixture timeout")
                return {"id": "uploading-task", "state": "queued"}
            def cancel(self, owner, task):
                cancellations.append((owner, task))
                release.set()
        with patch("desktop_backend.runtime.MacComputeClient", return_value=Client()) as constructor:
            constructor.enabled_for.return_value = True
            task = asyncio.create_task(self.runtime.run_enhancement(job["id"]))
            self.runtime.tasks["photo:" + job["id"]] = task
            self.assertTrue(await asyncio.to_thread(created.wait, 5))
            await self.runtime.stop_photo(job["id"])
            await asyncio.gather(task, return_exceptions=True)
        self.assertIn(("owner-A", "uploading-task"), cancellations)
        self.assertEqual(self.runtime.storage.get("photoJobs", job["id"])["state"], "cancelled")

    async def test_explicit_route_failure_never_starts_local_process(self):
        with patch("desktop_backend.runtime.MacComputeClient.enabled_for", return_value=True):
            job = self.runtime.create_photo_job(self.payload)
        with patch("desktop_backend.runtime.MacComputeClient.enabled_for", return_value=False), patch("asyncio.create_subprocess_exec") as spawn:
            await self.runtime.run_enhancement(job["id"])
            spawn.assert_not_called()
        self.assertEqual(self.runtime.storage.get("photoJobs", job["id"])["state"], "failed")

    async def test_stop_forwards_owner_and_task_and_keeps_cancelled_state(self):
        with patch("desktop_backend.runtime.MacComputeClient.enabled_for", return_value=True):
            job = self.runtime.create_photo_job(self.payload)
        job["remoteTaskId"] = "running-task"
        self.runtime.storage.put("photoJobs", job)
        with patch("desktop_backend.runtime.MacComputeClient") as client:
            await self.runtime.stop_photo(job["id"])
            client.return_value.cancel.assert_called_once_with("owner-A", "running-task")
        self.assertEqual(self.runtime.storage.get("photoJobs", job["id"])["state"], "cancelled")


class WorkerTests(unittest.TestCase):
    def test_revoked_lease_stops_process(self):
        class HTTP:
            def request(self, *args, **kwargs):
                raise MacComputeError("revoked", 403, "revoked")
        runner = TaskRunner(HTTP(), {"id": "task", "lease_token": "lease"}, {})
        class Process:
            terminated = False
            def poll(self):return None
            def terminate(self):self.terminated = True
        runner.process = Process()
        runner.heartbeat()
        self.assertTrue(runner.lost.is_set())
        self.assertTrue(runner.process.terminated)

    def test_mps_unavailable_fails_task_without_subprocess(self):
        calls = []
        class HTTP:
            def request(self, method, route, *args, **kwargs):
                calls.append(route)
                return {"ok": True}
        runner = TaskRunner(HTTP(), {"id": "task", "lease_token": "lease", "kind": "enhance", "params": {}}, {})
        with patch("shared.compute.worker.require_mps", side_effect=RuntimeError("unavailable")), patch("subprocess.Popen") as spawn:
            with self.assertRaises(RuntimeError):
                runner.execute()
            spawn.assert_not_called()
        self.assertIn("/v1/worker/tasks/task/fail", calls)


if __name__ == "__main__":
    unittest.main()
