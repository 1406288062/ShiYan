"""Compact Mac transport, deferred details, and projection writeback regressions."""
import ast
import copy
import importlib.util
import json
import types
import unittest
from urllib.parse import quote

from test_sync_host_isolation import SOURCE, FakeRuntime, SyncEngine


def load_source(name):
    spec = importlib.util.spec_from_file_location("_shiyan_compact_test_" + name, SOURCE / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


gateway_module = load_source("gateway")
message_view_module = load_source("message_view")
api_tree = ast.parse((SOURCE / "api.py").read_text())
create_app = next(n for n in api_tree.body if isinstance(n, ast.FunctionDef) and n.name == "create_app")
details_handler = next(n for n in create_app.body if isinstance(n, ast.AsyncFunctionDef) and n.name == "message_details")
details_handler.decorator_list = []
api_globals = {"runtime": lambda request: request.runtime, "Request": object, "quote": quote, "GatewayError": gateway_module.GatewayError}
exec(compile(ast.fix_missing_locations(ast.Module(body=[details_handler], type_ignores=[])), str(SOURCE / "api.py"), "exec"), api_globals)
message_details = api_globals["message_details"]


def compact_message():
    return {
        "id": "remote-message", "conversationId": "cloud-chat", "role": "assistant",
        "text": "the complete visible answer", "state": "completed", "assets": [],
        "createdAt": "2026-10-21T12:00:00Z", "updatedAt": "2026-10-21T12:01:00Z",
        "rawResult": None, "fileChanges": [{"path": "/project/file.py", "diff": "short", "diffTruncated": True}],
        "displayItems": [{"id": "tool-one", "type": "command_execution", "status": "completed"}],
        "executionStats": {"total": 1, "success": 1, "failed": 0, "pending": 0},
        "executionDetailsAvailable": True, "serverOnlyMetadata": "not a local edit",
    }


class CompactSyncTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.runtime = FakeRuntime(server_access=False)
        self.engine = SyncEngine(self.runtime)

    async def asyncTearDown(self):
        await self.runtime.close()

    async def import_compact_message(self, prior_full=False):
        changes = [{"kind": "conversations", "id": "cloud-chat", "revision": 1,
                    "data": {"id": "cloud-chat", "title": "cloud conversation"}}]
        data = compact_message()
        if prior_full:
            full = {**data, "rawResult": "full original record", "fileChanges": [{"path": "/project/file.py", "diff": "complete original diff"}],
                    "displayItems": [{"id": "tool-one", "type": "command_execution", "status": "completed", "output": "complete tool output"}]}
            full.pop("executionDetailsAvailable")
            changes.append({"kind": "messages", "id": data["id"], "revision": 1, "data": full})
        changes.append({"kind": "messages", "id": data["id"], "revision": 2, "data": data})
        await self.engine.apply_changes(changes, cursor=2)
        return self.runtime.storage.get("conversations", "cloud-chat")

    async def test_only_sync_routes_request_compact_without_mobile_authorization(self):
        gateway = gateway_module.Gateway.__new__(gateway_module.Gateway)
        gateway.prefix = "/shiyan/v1/"
        gateway.account_token = "test-account-token"
        for route in ("sync", "sync?after=22&limit=200"):
            _, _, headers = await gateway.request_parts("GET", route)
            self.assertEqual("compact", headers["X-Shiyan-Sync-Profile"])
            self.assertEqual("macos", headers["X-Shiyan-Platform"])
            self.assertEqual("Bearer test-account-token", headers["Authorization"])
            self.assertEqual("1", headers["X-Shiyan-Account-Required"])
        for route in ("sync/assets", "sync/messages/id/details", "capabilities", "auth/me", "sync/schedules/host"):
            _, _, headers = await gateway.request_parts("GET", route)
            self.assertNotIn("X-Shiyan-Sync-Profile", headers)

    async def test_compact_import_preserves_existing_full_records_and_visible_answer(self):
        conversation = await self.import_compact_message(prior_full=True)
        message = conversation["messages"][0]
        self.assertEqual("the complete visible answer", message["text"])
        self.assertEqual("full original record", message["rawResult"])
        self.assertEqual("complete original diff", message["fileChanges"][0]["diff"])
        self.assertEqual("complete tool output", message["displayItems"][0]["output"])
        self.assertTrue(message["executionDetailsAvailable"])
        self.assertTrue(message["detailsDeferred"])
        self.assertEqual("sync:2", message["detailsToken"])

    async def test_draft_and_title_saves_do_not_stage_compact_message_or_cached_full_fields(self):
        for prior_full in (False, True):
            with self.subTest(prior_full=prior_full):
                conversation = await self.import_compact_message(prior_full)
                conversation.update(draft="new draft", title="new title")
                self.runtime.storage.put("conversations", conversation)
                self.assertFalse(any(m["kind"] == "messages" for m in self.engine.pending()))
                with self.runtime.storage.db:
                    self.runtime.storage.db.execute("DELETE FROM sync_outbox")

    async def test_body_edit_carries_marker_and_projection_instead_of_cached_full_fields(self):
        conversation = await self.import_compact_message(prior_full=True)
        conversation["messages"][0]["text"] = "locally corrected answer"
        self.runtime.storage.put("conversations", conversation)
        mutation = next(m for m in self.engine.pending() if m["kind"] == "messages")
        self.assertEqual("locally corrected answer", mutation["data"]["text"])
        self.assertTrue(mutation["data"]["executionDetailsAvailable"])
        self.assertIsNone(mutation["data"]["rawResult"])
        self.assertTrue(mutation["data"]["fileChanges"][0]["diffTruncated"])
        self.assertEqual(compact_message()["updatedAt"], mutation["data"]["updatedAt"])

    async def test_fresh_local_fields_keep_projection_marker_and_persist_only_the_dirty_mask(self):
        conversation = await self.import_compact_message(prior_full=True)
        conversation["messages"][0].update(rawResult="new complete native execution", fileChanges=[{"path": "/project/file.py", "diff": "new complete diff"}])
        self.runtime.storage.put("conversations", conversation)
        saved = self.runtime.storage.get("conversations", "cloud-chat")
        self.assertTrue(saved["messages"][0]["executionDetailsAvailable"])
        self.assertEqual(["fileChanges", "rawResult"], saved["messages"][0]["executionDetailsChanged"])
        mutation = next(m for m in self.engine.pending() if m["kind"] == "messages")
        self.assertTrue(mutation["data"]["executionDetailsAvailable"])
        self.assertEqual(["fileChanges", "rawResult"], mutation["data"]["executionDetailsChanged"])
        self.assertEqual("new complete native execution", mutation["data"]["rawResult"])
        self.assertEqual("new complete diff", mutation["data"]["fileChanges"][0]["diff"])
        self.assertEqual(compact_message()["displayItems"], mutation["data"]["displayItems"])
        saved["draft"] = "another draft"
        self.runtime.storage.put("conversations", saved)
        self.assertEqual(mutation, next(m for m in self.engine.pending() if m["kind"] == "messages"))

    async def test_single_local_field_never_promotes_other_preview_fields_to_full(self):
        conversation = await self.import_compact_message()
        conversation["messages"][0]["fileChanges"] = [{"path": "/project/local.py", "diff": "a new complete local diff"}]
        self.runtime.storage.put("conversations", conversation)
        mutation = next(m for m in self.engine.pending() if m["kind"] == "messages")
        self.assertEqual(["fileChanges"], mutation["data"]["executionDetailsChanged"])
        self.assertTrue(mutation["data"]["executionDetailsAvailable"])
        self.assertIsNone(mutation["data"]["rawResult"])
        self.assertEqual(compact_message()["displayItems"], mutation["data"]["displayItems"])
        self.assertEqual("a new complete local diff", mutation["data"]["fileChanges"][0]["diff"])

    async def test_removed_local_details_are_explicit_clears_in_the_dirty_payload(self):
        for field in ("rawResult", "fileChanges", "displayItems"):
            with self.subTest(field=field):
                conversation = await self.import_compact_message(prior_full=True)
                conversation["messages"][0].pop(field)
                self.runtime.storage.put("conversations", conversation)
                mutation = next(m for m in self.engine.pending() if m["kind"] == "messages")
                self.assertEqual([field], mutation["data"]["executionDetailsChanged"])
                self.assertIn(field, mutation["data"])
                self.assertEqual(None if field == "rawResult" else [], mutation["data"][field])
                saved = self.runtime.storage.get("conversations", "cloud-chat")["messages"][0]
                self.assertEqual(mutation["data"][field], saved[field])
                with self.runtime.storage.db:
                    self.runtime.storage.db.execute("DELETE FROM sync_outbox")

    async def test_acknowledged_dirty_fields_are_cleared_without_restaging_on_draft_save(self):
        conversation = await self.import_compact_message()
        conversation["messages"][0]["fileChanges"] = [{"diff": "complete local diff"}]
        self.runtime.storage.put("conversations", conversation)
        await self.engine.once()
        self.assertEqual([], self.engine.pending())
        saved = self.runtime.storage.get("conversations", "cloud-chat")
        self.assertNotIn("executionDetailsChanged", saved["messages"][0])
        self.assertTrue(saved["messages"][0]["executionDetailsAvailable"])
        saved["draft"] = "a later draft"
        self.runtime.storage.put("conversations", saved)
        self.assertFalse(any(m["kind"] == "messages" for m in self.engine.pending()))

    async def test_new_cloud_revision_clears_old_dirty_mask_and_cached_deferred_token(self):
        conversation = await self.import_compact_message()
        conversation["messages"][0].update(executionDetailsChanged=["fileChanges"], detailsDeferred=True, detailsToken="old cache token")
        self.engine.importing = True
        try:
            self.runtime.storage.put("conversations", conversation)
        finally:
            self.engine.importing = False
        await self.engine.apply_changes([{"kind": "messages", "id": "remote-message", "revision": 3, "data": compact_message()}], cursor=3)
        saved = self.runtime.storage.get("conversations", "cloud-chat")["messages"][0]
        self.assertNotIn("executionDetailsChanged", saved)
        self.assertTrue(saved["detailsDeferred"])
        self.assertEqual("sync:3", saved["detailsToken"])
        full = compact_message()
        full.pop("executionDetailsAvailable")
        full["rawResult"] = "new cloud full record"
        await self.engine.apply_changes([{"kind": "messages", "id": "remote-message", "revision": 4, "data": full}], cursor=4)
        saved = self.runtime.storage.get("conversations", "cloud-chat")["messages"][0]
        self.assertNotIn("executionDetailsChanged", saved)
        self.assertNotIn("executionDetailsAvailable", saved)
        self.assertNotIn("detailsDeferred", saved)
        self.assertNotIn("detailsToken", saved)

    async def test_inflight_non_job_edit_survives_old_ack_and_compact_reply(self):
        conversation = await self.import_compact_message()
        conversation["messages"][0]["fileChanges"] = [{"diff": "first complete local diff"}]
        self.runtime.storage.put("conversations", conversation)
        old = next(m for m in self.engine.pending() if m["kind"] == "messages")
        new_mutations = []
        async def push(payload):
            latest = self.runtime.storage.get("conversations", "cloud-chat")
            latest["messages"][0]["rawResult"] = "new complete local execution"
            self.runtime.storage.put("conversations", latest)
            new_mutations.append(next(m for m in self.engine.pending() if m["kind"] == "messages"))
            reply_data = compact_message()
            return {"accepted": [{"mutationId": m["mutationId"], "revision": 3} for m in payload["mutations"]],
                    "changes": [{"kind": "messages", "id": "remote-message", "revision": 3, "data": reply_data}], "cursor": 3}
        self.runtime.gateway.sync_push = push
        await self.engine.once()
        remaining = next(m for m in self.engine.pending() if m["kind"] == "messages")
        self.assertNotEqual(old["mutationId"], remaining["mutationId"])
        self.assertEqual(new_mutations[0]["mutationId"], remaining["mutationId"])
        self.assertEqual(3, remaining["baseRevision"])
        self.assertEqual(["fileChanges", "rawResult"], remaining["data"]["executionDetailsChanged"])
        self.assertEqual("new complete local execution", remaining["data"]["rawResult"])
        self.assertEqual("first complete local diff", remaining["data"]["fileChanges"][0]["diff"])
        saved = self.runtime.storage.get("conversations", "cloud-chat")["messages"][0]
        self.assertEqual(["fileChanges", "rawResult"], saved["executionDetailsChanged"])
        self.assertEqual("new complete local execution", saved["rawResult"])

    async def test_conflict_preserves_explicit_full_values_even_when_they_equal_the_old_base(self):
        conversation = await self.import_compact_message()
        conversation["messages"][0].update(rawResult="same full value as acknowledged base", fileChanges=[{"diff": "new complete diff"}])
        self.runtime.storage.put("conversations", conversation)
        mutation = next(m for m in self.engine.pending() if m["kind"] == "messages")
        entity = self.engine._entity("messages", "remote-message")
        base = entity["base"]
        base["rawResult"] = mutation["data"]["rawResult"]
        with self.runtime.storage.db:
            self.runtime.storage.db.execute("UPDATE sync_entities SET base=? WHERE kind='messages' AND id='remote-message'", (json.dumps(base),))
        await self.engine.resolve_conflict(mutation, {"kind": "messages", "id": "remote-message", "revision": 3, "data": compact_message()})
        merged = next(m for m in self.engine.pending() if m["kind"] == "messages")
        self.assertEqual("same full value as acknowledged base", merged["data"]["rawResult"])
        self.assertEqual(["fileChanges", "rawResult"], merged["data"]["executionDetailsChanged"])
        self.assertTrue(merged["data"]["executionDetailsAvailable"])

    async def test_remote_job_authoritative_result_keeps_the_existing_outbox_replacement_rule(self):
        conversation = await self.import_compact_message()
        conversation["messages"][0]["fileChanges"] = [{"diff": "local pending diff"}]
        self.runtime.storage.put("conversations", conversation)
        remote = {**compact_message(), "remoteJobId": "cloud-job", "text": "canonical server answer"}
        await self.engine.apply_changes([{"kind": "messages", "id": "remote-message", "revision": 3, "data": remote}], cursor=3)
        self.assertFalse(any(m["kind"] == "messages" for m in self.engine.pending()))
        saved = self.runtime.storage.get("conversations", "cloud-chat")["messages"][0]
        self.assertEqual("canonical server answer", saved["text"])
        self.assertNotIn("executionDetailsChanged", saved)

    async def test_minimal_projection_still_tells_ui_to_load_details_and_invalidates_on_revision(self):
        view = message_view_module.message_view({"id": "message", "text": "answer", "rawResult": None, "executionDetailsAvailable": True})
        self.assertTrue(view["detailsDeferred"])
        self.assertTrue(view["detailsToken"])
        conversation = await self.import_compact_message()
        first = message_view_module.message_view(conversation["messages"][0])
        await self.engine.apply_changes([{"kind": "messages", "id": "remote-message", "revision": 3, "data": compact_message()}], cursor=3)
        second = message_view_module.message_view(self.runtime.storage.get("conversations", "cloud-chat")["messages"][0])
        self.assertNotEqual(first["detailsToken"], second["detailsToken"])

    async def test_details_fetch_merges_complete_fields_without_changing_local_records(self):
        conversation = await self.import_compact_message()
        original = copy.deepcopy(conversation)
        pending = self.engine.pending()
        calls = []
        async def request(method, route, timeout):
            calls.append((method, route, timeout))
            return {"ok": True, "revision": 20, "rawResult": "complete raw", "fileChanges": [{"diff": "complete diff"}], "displayItems": [{"output": "complete output"}]}
        self.runtime.gateway.json = request
        self.runtime.conversation = lambda identifier: self.runtime.storage.get("conversations", identifier)
        result = await message_details("cloud-chat", "remote-message", types.SimpleNamespace(runtime=self.runtime))
        self.assertEqual([("GET", "sync/messages/remote-message/details", 90)], calls)
        self.assertEqual("complete raw", result["message"]["rawResult"])
        self.assertEqual("complete diff", result["message"]["fileChanges"][0]["diff"])
        self.assertEqual("the complete visible answer", result["message"]["text"])
        self.assertFalse(result["message"]["detailsDeferred"])
        self.assertEqual(original, self.runtime.storage.get("conversations", "cloud-chat"))
        self.assertEqual(pending, self.engine.pending())

    async def test_details_view_uses_local_dirty_field_and_cloud_full_values_for_other_fields(self):
        conversation = await self.import_compact_message()
        conversation["messages"][0]["fileChanges"] = [{"diff": "fresh local full diff"}]
        self.runtime.storage.put("conversations", conversation)
        original = self.runtime.storage.get("conversations", "cloud-chat")
        async def request(*args, **kwargs):
            return {"ok": True, "rawResult": "cloud complete execution", "fileChanges": [{"diff": "older cloud diff"}], "displayItems": [{"output": "cloud complete tool output"}]}
        self.runtime.gateway.json = request
        self.runtime.conversation = lambda identifier: self.runtime.storage.get("conversations", identifier)
        response = await message_details("cloud-chat", "remote-message", types.SimpleNamespace(runtime=self.runtime))
        self.assertEqual("fresh local full diff", response["message"]["fileChanges"][0]["diff"])
        self.assertEqual("cloud complete execution", response["message"]["rawResult"])
        self.assertEqual("cloud complete tool output", response["message"]["displayItems"][0]["output"])
        self.assertEqual(original, self.runtime.storage.get("conversations", "cloud-chat"))

    async def test_remote_job_details_view_prefers_server_full_values_over_local_dirty_fields(self):
        conversation = await self.import_compact_message()
        conversation["messages"][0].update(remoteJobId="cloud-job", fileChanges=[{"diff": "local pending diff"}])
        self.runtime.storage.put("conversations", conversation)
        async def request(*args, **kwargs):
            return {"ok": True, "rawResult": "server canonical raw", "fileChanges": [{"diff": "server canonical diff"}], "displayItems": []}
        self.runtime.gateway.json = request
        self.runtime.conversation = lambda identifier: self.runtime.storage.get("conversations", identifier)
        response = await message_details("cloud-chat", "remote-message", types.SimpleNamespace(runtime=self.runtime))
        self.assertEqual("server canonical diff", response["message"]["fileChanges"][0]["diff"])

    async def test_details_errors_remain_retryable_and_do_not_claim_completion(self):
        await self.import_compact_message()
        self.runtime.conversation = lambda identifier: self.runtime.storage.get("conversations", identifier)
        replies = [OSError("network unavailable"), {"ok": True, "rawResult": "missing fields"},
                   {"ok": True, "rawResult": "complete", "fileChanges": [], "displayItems": []}]
        async def request(*args, **kwargs):
            reply = replies.pop(0)
            if isinstance(reply, Exception):
                raise reply
            return reply
        self.runtime.gateway.json = request
        context = types.SimpleNamespace(runtime=self.runtime)
        with self.assertRaises(OSError):
            await message_details("cloud-chat", "remote-message", context)
        with self.assertRaises(gateway_module.GatewayError):
            await message_details("cloud-chat", "remote-message", context)
        self.assertTrue(self.runtime.storage.get("conversations", "cloud-chat")["messages"][0]["detailsDeferred"])
        self.assertFalse((await message_details("cloud-chat", "remote-message", context))["message"]["detailsDeferred"])

    async def test_local_full_details_do_not_trigger_cloud_fetch(self):
        self.runtime.conversation = lambda _: {"messages": [{"id": "local", "text": "answer", "rawResult": "local complete"}]}
        result = await message_details("conversation", "local", types.SimpleNamespace(runtime=self.runtime))
        self.assertEqual("local complete", result["message"]["rawResult"])
        self.assertEqual([], self.runtime.gateway.calls)

    async def test_outbox_posts_are_limited_to_ten_and_remaining_mutations_stay_pending(self):
        for i in range(15):
            self.runtime.storage.put("projects", {"id": f"project-{i}", "name": str(i)})
        before = self.engine.pending()
        await self.engine.once()
        sent = next(c[1]["mutations"] for c in self.runtime.gateway.calls if len(c) == 2 and c[0] == "POST")
        self.assertEqual(10, len(sent))
        self.assertEqual(before[:10], sent)
        self.assertEqual(before[10:], self.engine.pending())


if __name__ == "__main__":
    unittest.main()
