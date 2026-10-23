"""Exercise the real sync engine without native helpers, network or image packages."""
import ast
import asyncio
import importlib.util
import json
from pathlib import Path
import sys
_repository = Path(__file__).resolve().parents[1]
if str(_repository) not in sys.path:
    sys.path.insert(0, str(_repository))
from shared.paths import APP_ROOT
import sqlite3
import sys
import threading
import types
import unittest
import uuid


ROOT = APP_ROOT
SOURCE = ROOT / "source" if (ROOT / "source" / "sync.py").is_file() else ROOT / "desktop_backend"
PACKAGE = "_shiyan_sync_host_tests"
package = types.ModuleType(PACKAGE)
package.__path__ = [str(SOURCE)]
sys.modules[PACKAGE] = package
storage_module = types.ModuleType(PACKAGE + ".storage")
storage_module.now = lambda: "2026-10-21T12:00:00Z"
storage_module.new_id = lambda: str(uuid.uuid4())
sys.modules[storage_module.__name__] = storage_module
spec = importlib.util.spec_from_file_location(PACKAGE + ".sync", SOURCE / "sync.py")
sync_module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = sync_module
spec.loader.exec_module(sync_module)
SyncEngine = sync_module.SyncEngine


# Execute the production lifecycle methods rather than importing Runtime's
# native/image dependencies. The host task must be covered by actual close().
runtime_tree = ast.parse((SOURCE / "runtime.py").read_text())
runtime_class = next(n for n in runtime_tree.body if isinstance(n, ast.ClassDef) and n.name == "Runtime")
lifecycle_methods = [n for n in runtime_class.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name in {"spawn", "close"}]
lifecycle_tree = ast.Module(body=lifecycle_methods, type_ignores=[])
lifecycle_namespace = {"asyncio": asyncio}
exec(compile(ast.fix_missing_locations(lifecycle_tree), str(SOURCE / "runtime.py"), "exec"), lifecycle_namespace)


class MemoryStorage:
    def __init__(self):
        self.lock = threading.RLock()
        self.db = sqlite3.connect(":memory:")
        self.db.executescript("""
            CREATE TABLE documents(kind TEXT,id TEXT,data TEXT,PRIMARY KEY(kind,id));
            CREATE TABLE preferences(key TEXT PRIMARY KEY,data TEXT);
        """)
        self.sync_observer = None
        self.closed = False
        self.set_setting("sync.startupRepairVersion", 2)

    def list(self, kind):
        return [json.loads(row[0]) for row in self.db.execute("SELECT data FROM documents WHERE kind=?", (kind,))]

    def get(self, kind, identifier):
        row = self.db.execute("SELECT data FROM documents WHERE kind=? AND id=?", (kind, identifier)).fetchone()
        return json.loads(row[0]) if row else None

    def put(self, kind, value):
        with self.lock, self.db:
            previous = self.get(kind, value["id"])
            self.db.execute("INSERT OR REPLACE INTO documents VALUES(?,?,?)", (kind, value["id"], json.dumps(value)))
            if self.sync_observer:
                self.sync_observer(kind, value, previous)
        return value

    def remove(self, kind, identifier):
        with self.lock, self.db:
            previous = self.get(kind, identifier)
            self.db.execute("DELETE FROM documents WHERE kind=? AND id=?", (kind, identifier))
            if self.sync_observer:
                self.sync_observer(kind, None, previous)

    def setting(self, key, fallback=None):
        row = self.db.execute("SELECT data FROM preferences WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else fallback

    def set_setting(self, key, value):
        with self.lock, self.db:
            self.db.execute("INSERT OR REPLACE INTO preferences VALUES(?,?)", (key, json.dumps(value)))

    def close(self):
        self.closed = True
        self.db.close()


class FakeGateway:
    def __init__(self):
        self.public_identity = {"deviceID": "host-device", "publicKey": "public-key"}
        self.account_token = "test-session-one"
        self.calls = []
        self.stage_counts = {}
        self.blocked_stage = None
        self.failed_stage = None
        self.stage_entered = asyncio.Event()
        self.stage_cancelled = asyncio.Event()
        self.get_pages = []
        self.push_reply = None
        self.get_error = None
        self.push_error = None
        self.closed = False

    async def stage(self, name):
        self.stage_counts[name] = self.stage_counts.get(name, 0) + 1
        await asyncio.sleep(0)
        if self.failed_stage == name:
            raise ValueError("unavailable " + name)
        if self.blocked_stage == name:
            self.stage_entered.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                self.stage_cancelled.set()
                raise

    async def ensure_enrolled(self):
        await self.stage("enrollment")

    async def identity(self):
        await self.stage("identity")
        return self.public_identity

    async def helper_json(self, action, proof):
        self.calls.append((action, proof))
        await self.stage("sign")
        return {"signature": "signature"}

    async def json(self, method, route, payload):
        self.calls.append((method, route, payload))
        await self.stage("host")
        return {"ok": True}

    async def sync_get(self, after):
        self.calls.append(("GET", after))
        await asyncio.sleep(0)
        if self.get_error:
            raise self.get_error
        if self.get_pages:
            return self.get_pages.pop(0)
        return {"changes": [], "cursor": after, "hasMore": False}

    async def sync_push(self, payload):
        self.calls.append(("POST", payload))
        await asyncio.sleep(0)
        if self.push_error:
            raise self.push_error
        if self.push_reply is not None:
            return self.push_reply
        return {"changes": [], "cursor": payload["after"], "accepted": [
            {"mutationId": m["mutationId"], "revision": m["baseRevision"] + 1} for m in payload["mutations"]
        ]}

    def close(self):
        self.closed = True


class FakeRuntime:
    spawn = lifecycle_namespace["spawn"]
    close = lifecycle_namespace["close"]

    def __init__(self, server_access=True):
        self.storage = MemoryStorage()
        self.gateway = FakeGateway()
        self.server_access = server_access
        self.closing = False
        self.account = {"owner": "account-one"}
        self.capabilities = {"models": ["cloud-model"], "model": "cloud-model"}
        self.mac_codex = types.SimpleNamespace(models=self.models)
        self.tasks = {}
        self.background = set()
        self.processes = {}
        self.notifications = 0

    async def models(self):
        await self.gateway.stage("models")
        return ["local-model"]

    def notify(self):
        self.notifications += 1

    def pump_queue(self, identifier):
        pass


class SyncHostIsolationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.runtimes = []

    async def asyncTearDown(self):
        for runtime in self.runtimes:
            if not runtime.closing:
                await runtime.close()

    def make_engine(self, server_access=True):
        runtime = FakeRuntime(server_access)
        self.runtimes.append(runtime)
        engine = SyncEngine(runtime)
        runtime.storage.put("projects", {"id": "local-project", "name": "pending local edit"})
        return runtime, engine

    def assert_chat_round_trip(self, runtime, engine):
        self.assertTrue(any(c[0] == "GET" for c in runtime.gateway.calls))
        self.assertTrue(any(len(c) == 2 and c[0] == "POST" for c in runtime.gateway.calls))
        self.assertEqual([], engine.pending(include_schedules=False))
        self.assertIsNone(engine.last_error)

    async def test_identity_failure_does_not_block_get_or_post(self):
        runtime, engine = self.make_engine()
        runtime.gateway.failed_stage = "identity"
        await asyncio.wait_for(engine.once(), timeout=0.3)
        await engine._schedule_host_task
        self.assert_chat_round_trip(runtime, engine)
        self.assertIn("identity", engine.schedule_host_error)
        self.assertEqual(0, engine.schedule_host_registered)

    async def test_hung_dependencies_leave_chat_running_and_only_one_task(self):
        for stage in ("enrollment", "identity", "models", "sign", "host"):
            with self.subTest(stage=stage):
                runtime, engine = self.make_engine()
                runtime.gateway.blocked_stage = stage
                engine.schedule_host_timeout = 10
                await asyncio.wait_for(engine.once(), timeout=0.3)
                host_task = engine._schedule_host_task
                await asyncio.wait_for(runtime.gateway.stage_entered.wait(), timeout=0.3)
                for _ in range(3):
                    await asyncio.wait_for(engine.once(), timeout=0.3)
                    self.assertIs(host_task, engine._schedule_host_task)
                self.assert_chat_round_trip(runtime, engine)
                self.assertEqual(1, runtime.gateway.stage_counts[stage])
                self.assertIn(host_task, runtime.background)
                self.assertEqual(1, len(runtime.background))
                await runtime.close()
                self.assertTrue(host_task.cancelled())
                self.assertTrue(runtime.gateway.stage_cancelled.is_set())
                self.assertEqual(set(), runtime.background)

    async def test_timeout_is_bounded_and_retries_are_throttled(self):
        runtime, engine = self.make_engine()
        runtime.gateway.blocked_stage = "models"
        engine.schedule_host_timeout = 0.02
        await engine.once()
        await asyncio.wait_for(engine._schedule_host_task, timeout=0.3)
        self.assertEqual("TimeoutError", engine.schedule_host_error)
        self.assertTrue(runtime.gateway.stage_cancelled.is_set())
        await engine.once()
        self.assertEqual(1, runtime.gateway.stage_counts["models"])
        self.assertGreater(engine._schedule_host_retry_at, asyncio.get_running_loop().time())
        engine._schedule_host_retry_at = 0
        await engine.once()
        await asyncio.wait_for(engine._schedule_host_task, timeout=0.3)
        self.assertEqual(2, runtime.gateway.stage_counts["models"])

    async def test_normal_account_never_claims_a_local_host(self):
        runtime, engine = self.make_engine(server_access=False)
        runtime.storage.put("scheduledTasks", {"id": "schedule-one", "enabled": True})
        await engine.once()
        self.assert_chat_round_trip(runtime, engine)
        self.assertEqual({}, runtime.gateway.stage_counts)
        self.assertIsNone(engine._schedule_host_task)
        self.assertNotIn("executorDeviceId", runtime.storage.get("scheduledTasks", "schedule-one"))

    async def test_schedule_backlog_cannot_block_chat_when_host_is_unavailable(self):
        for mode in ("failed", "blocked"):
            with self.subTest(mode=mode):
                runtime, engine = self.make_engine()
                if mode == "failed":
                    runtime.gateway.failed_stage = "identity"
                else:
                    runtime.gateway.blocked_stage = "models"
                for i in range(110):
                    runtime.storage.put("scheduledTasks", {"id": f"schedule-{i}", "enabled": True})
                runtime.storage.put("conversations", {"id": "chat-one", "messages": [
                    {"id": "new-message", "role": "user", "text": "new local message", "assets": []}
                ]})
                await asyncio.wait_for(engine.once(), timeout=0.3)
                if mode == "failed":
                    await engine._schedule_host_task
                else:
                    await asyncio.wait_for(runtime.gateway.stage_entered.wait(), timeout=0.3)
                self.assert_chat_round_trip(runtime, engine)
                sent = next(c[1]["mutations"] for c in runtime.gateway.calls if len(c) == 2 and c[0] == "POST")
                self.assertIn("new-message", [m["id"] for m in sent])
                self.assertNotIn("scheduledTasks", [m["kind"] for m in sent])
                self.assertEqual(110, len(engine.pending(limit=200)))
                self.assertTrue(all(m["kind"] == "scheduledTasks" for m in engine.pending(limit=200)))

    async def test_pending_schedule_edits_resume_after_this_session_proves_its_host(self):
        runtime, engine = self.make_engine()
        runtime.gateway.failed_stage = "identity"
        runtime.storage.put("scheduledTasks", {"id": "schedule-one", "enabled": True})
        await engine.once()
        await engine._schedule_host_task
        self.assertEqual(["scheduledTasks"], [m["kind"] for m in engine.pending()])
        runtime.gateway.failed_stage = None
        engine._schedule_host_retry_at = 0
        await engine.once()
        await engine._schedule_host_task
        await engine.once()
        self.assertEqual([], engine.pending())
        self.assertTrue(any(m["kind"] == "scheduledTasks" for c in runtime.gateway.calls if len(c) == 2 and c[0] == "POST" for m in c[1]["mutations"]))

    async def test_new_login_session_cannot_reuse_an_old_host_registration(self):
        runtime, engine = self.make_engine()
        await engine.once()
        await engine._schedule_host_task
        runtime.gateway.account_token = "test-session-two"
        runtime.gateway.failed_stage = "identity"
        runtime.storage.put("projects", {"id": "local-project", "name": "another chat edit"})
        runtime.storage.put("scheduledTasks", {"id": "schedule-one", "enabled": True})
        previous = len(runtime.gateway.calls)
        await engine.once()
        await engine._schedule_host_task
        self.assert_chat_round_trip(runtime, engine)
        self.assertEqual(0, engine.schedule_host_registered)
        self.assertEqual(["scheduledTasks"], [m["kind"] for m in engine.pending()])
        self.assertFalse(any(m["kind"] == "scheduledTasks" for c in runtime.gateway.calls[previous:] if len(c) == 2 and c[0] == "POST" for m in c[1]["mutations"]))

    async def test_refresh_failure_keeps_a_proven_host_for_the_same_session(self):
        runtime, engine = self.make_engine()
        await engine.once()
        await engine._schedule_host_task
        registered = engine.schedule_host_registered
        runtime.gateway.failed_stage = "identity"
        engine._schedule_host_retry_at = 0
        runtime.storage.put("scheduledTasks", {"id": "schedule-one", "enabled": True})
        await engine.once()
        await engine._schedule_host_task
        self.assertEqual([], engine.pending())
        self.assertEqual(registered, engine.schedule_host_registered)
        self.assertIn("identity", engine.schedule_host_error)
        self.assertIsNone(engine.last_error)

    async def test_success_preserves_host_proof_models_and_schedule_assignment(self):
        runtime, engine = self.make_engine()
        runtime.storage.put("scheduledTasks", {"id": "unassigned", "enabled": True})
        runtime.storage.put("scheduledTasks", {"id": "existing", "executorDeviceId": "other-host"})
        await engine.once()
        await engine._schedule_host_task
        host = next(c for c in runtime.gateway.calls if c[:2] == ("POST", "sync/schedules/host"))[2]
        self.assertEqual("host-device", host["deviceId"])
        self.assertEqual("public-key", host["devicePublicKey"])
        self.assertEqual("signature", host["deviceSignature"])
        self.assertEqual(["local-model"], host["local"])
        self.assertEqual(["cloud-model"], host["cloud"])
        self.assertEqual("cloud-model", host["defaultModel"])
        proof = next(c[1] for c in runtime.gateway.calls if c[0] == "sign")
        self.assertEqual(["shiyan-schedule-host-v1", "account-one", "host-device"], proof.decode().splitlines()[:3])
        self.assertEqual("host-device", runtime.storage.get("scheduledTasks", "unassigned")["executorDeviceId"])
        self.assertEqual("other-host", runtime.storage.get("scheduledTasks", "existing")["executorDeviceId"])
        self.assertGreater(engine.schedule_host_registered, 0)
        self.assertIsNone(engine.schedule_host_error)
        await engine.once()
        self.assertEqual(1, runtime.gateway.stage_counts["host"])

    async def test_model_discovery_failure_still_registers_cloud_host(self):
        runtime, engine = self.make_engine()
        runtime.gateway.failed_stage = "models"
        await engine.once()
        await engine._schedule_host_task
        host = next(c for c in runtime.gateway.calls if c[:2] == ("POST", "sync/schedules/host"))[2]
        self.assertEqual([], host["local"])
        self.assertIsNone(engine.schedule_host_error)

    async def test_permission_revocation_cancels_an_existing_host_task(self):
        runtime, engine = self.make_engine()
        runtime.gateway.blocked_stage = "identity"
        await engine.once()
        await asyncio.wait_for(runtime.gateway.stage_entered.wait(), timeout=0.3)
        runtime.server_access = False
        await engine.once()
        await asyncio.gather(engine._schedule_host_task, return_exceptions=True)
        self.assertTrue(engine._schedule_host_task.cancelled())
        self.assert_chat_round_trip(runtime, engine)

    async def test_pagination_applies_each_cursor_and_uploads_at_the_last_page(self):
        runtime, engine = self.make_engine(server_access=False)
        runtime.gateway.get_pages = [
            {"changes": [{"kind": "projects", "id": f"remote-{i}", "revision": 1, "data": {"name": str(i)}}],
             "cursor": i, "hasMore": i < 3} for i in range(1, 4)
        ]
        await engine.once()
        self.assertEqual([0, 1, 2], [c[1] for c in runtime.gateway.calls if c[0] == "GET"])
        self.assertEqual(3, runtime.storage.setting("sync.cursor"))
        for i in range(1, 4):
            self.assertEqual(str(i), runtime.storage.get("projects", f"remote-{i}")["name"])
        post = next(c[1] for c in runtime.gateway.calls if len(c) == 2 and c[0] == "POST")
        self.assertEqual(3, post["after"])
        self.assertEqual("local-project", post["mutations"][0]["id"])
        self.assert_chat_round_trip(runtime, engine)

    async def test_pagination_is_bounded_and_continues_without_cursor_skips(self):
        runtime, engine = self.make_engine(server_access=False)
        runtime.gateway.get_pages = [{"changes": [], "cursor": i, "hasMore": True} for i in range(1, 13)]
        await engine.once()
        self.assertEqual(list(range(8)), [c[1] for c in runtime.gateway.calls if c[0] == "GET"])
        self.assertEqual(8, runtime.storage.setting("sync.cursor"))
        await engine.once()
        self.assertEqual(list(range(13)), [c[1] for c in runtime.gateway.calls if c[0] == "GET"])
        self.assertEqual(12, runtime.storage.setting("sync.cursor"))

    async def test_stalled_cursor_does_not_spin_or_discard_unacknowledged_outbox(self):
        runtime, engine = self.make_engine(server_access=False)
        runtime.gateway.get_pages = [{"changes": [], "cursor": 0, "hasMore": True}]
        runtime.gateway.push_reply = {"changes": [], "cursor": 0, "accepted": []}
        before = engine.pending()
        await engine.once()
        self.assertEqual([("GET", 0)], [c for c in runtime.gateway.calls if c[0] == "GET"])
        self.assertEqual(before, engine.pending())
        self.assertEqual(0, runtime.storage.setting("sync.cursor", 0))

    async def test_failed_apply_stops_before_advancing_cursor_or_sending_outbox(self):
        runtime, engine = self.make_engine(server_access=False)
        runtime.gateway.get_pages = [{"changes": [{"kind": "projects", "id": "broken", "revision": "invalid"}], "cursor": 99, "hasMore": True}]
        before = engine.pending()
        with self.assertRaises(ValueError):
            await engine.once()
        self.assertEqual(0, runtime.storage.setting("sync.cursor", 0))
        self.assertEqual(before, engine.pending())
        self.assertFalse(any(len(c) == 2 and c[0] == "POST" for c in runtime.gateway.calls))

    async def test_chat_transport_errors_are_not_swallowed_as_host_errors(self):
        runtime, engine = self.make_engine(server_access=False)
        before = engine.pending()
        engine.last_error = "previous sync error"
        runtime.gateway.get_error = OSError("sync read failed")
        with self.assertRaisesRegex(OSError, "sync read failed"):
            await engine.once()
        self.assertEqual("previous sync error", engine.last_error)
        self.assertEqual(before, engine.pending())
        runtime.gateway.get_error = None
        runtime.gateway.push_error = OSError("sync write failed")
        with self.assertRaisesRegex(OSError, "sync write failed"):
            await engine.once()
        self.assertEqual("previous sync error", engine.last_error)
        self.assertEqual(before, engine.pending())


if __name__ == "__main__":
    unittest.main()
