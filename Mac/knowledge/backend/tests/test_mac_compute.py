"""Isolated owner-routing and batching tests; no PDFs, models or network."""

import importlib.util
import json
import math
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

_source = Path(__file__).resolve().parents[1] / "src/services/mac_compute.py"
_spec = importlib.util.spec_from_file_location("rag_mac_compute_test_target", _source)
compute = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(compute)


class FakeClient:
    allowed = {"owner-a"}

    def __init__(self):
        self.submissions = []
        self.cancelled = []
        self.tasks = {}

    @classmethod
    def enabled_for(cls, owner):
        return owner in cls.allowed

    def submit_embed(self, owner, request_id, texts, operation, instruction):
        self.submissions.append((owner, request_id, list(texts), operation, instruction))
        task_id = str(len(self.submissions))
        self.tasks[task_id] = texts
        return {"id": task_id, "state": "completed"}

    def result_embeddings(self, owner, task_id):
        return [[1.0] + [0.0] * 1023 for _ in self.tasks[task_id]]

    def cancel(self, owner, task_id):
        self.cancelled.append((owner, task_id))


class OwnerRoutingTests(unittest.TestCase):
    def setUp(self):
        compute.configure_owner_mapping({"owner-a": "rag-user-a"})

    def tearDown(self):
        compute.configure_owner_mapping({})

    def test_only_authenticated_bound_context_routes_and_restores(self):
        with patch.dict(os.environ, {"SHIYAN_MAC_COMPUTE_CONFIG": "private.json"}), patch.object(compute, "_client_type", return_value=FakeClient):
            self.assertIsNone(compute.current_mac_owner())
            with compute.owner_context("owner-a"):
                self.assertEqual(compute.current_mac_owner(), "owner-a")
                with compute.owner_context("owner-b"):
                    self.assertIsNone(compute.current_mac_owner())
                self.assertEqual(compute.current_mac_owner(), "owner-a")
            self.assertIsNone(compute.current_mac_owner())

    def test_invalid_explicit_config_fails_instead_of_cpu_fallback(self):
        broken = Mock()
        broken.enabled_for.side_effect = ValueError("unreadable credential")
        with patch.dict(os.environ, {"SHIYAN_MAC_COMPUTE_CONFIG": "private.json"}), patch.object(compute, "_client_type", return_value=broken), compute.owner_context("owner-a"):
            with self.assertRaises(compute.MacEmbeddingError):
                compute.current_mac_owner()

    def test_persisted_user_requires_matching_document_and_current_membership(self):
        fetch = Mock(return_value={"id": "doc-a"})
        with patch.object(compute, "_configured_owners", return_value=["owner-a"]), patch.dict(sys.modules, {"database": types.SimpleNamespace(fetch_one=fetch)}):
            self.assertEqual(compute.owner_for_ingestion("rag-user-a", "kb-a", "doc-a"), "owner-a")
            self.assertEqual(fetch.call_args.args[1], ("doc-a", "kb-a", "rag-user-a", "rag-user-a"))
            fetch.return_value = None
            with self.assertRaises(compute.MacEmbeddingError):
                compute.owner_for_ingestion("rag-user-a", "kb-b", "doc-a")

    def test_other_user_never_gets_bound_mac_even_in_shared_knowledge_base(self):
        fetch = Mock()
        with patch.object(compute, "_configured_owners", return_value=["owner-a"]), patch.dict(sys.modules, {"database": types.SimpleNamespace(fetch_one=fetch)}):
            self.assertIsNone(compute.owner_for_ingestion("other-rag-user", "kb-a", "doc-b"))
            fetch.assert_not_called()

    def test_default_bridge_user_mapping_and_ambiguous_mapping(self):
        default_user = "shiyan-" + compute.hashlib.sha256(b"account:one").hexdigest()[:40]
        with patch.object(compute, "_configured_owners", return_value=["account:one"]), patch.dict(sys.modules, {"database": types.SimpleNamespace(fetch_one=Mock(return_value={"id": "doc"}))}):
            self.assertEqual(compute.owner_for_ingestion(default_user, "kb", "doc"), "account:one")
        compute.configure_owner_mapping({"owner-a": "rag-user-a", "owner-b": "rag-user-a"})
        with patch.object(compute, "_configured_owners", return_value=["owner-a", "owner-b"]):
            with self.assertRaises(compute.MacEmbeddingError):
                compute.owner_for_ingestion("rag-user-a", "kb", "doc")

    def test_owner_binding_file_must_be_private(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "client.json"
            path.write_text(json.dumps({"owners": ["owner-a"]}))
            path.chmod(0o600)
            with patch.dict(os.environ, {"SHIYAN_MAC_COMPUTE_CONFIG": str(path)}):
                self.assertEqual(compute._configured_owners(), ["owner-a"])
                path.chmod(0o644)
                with self.assertRaises(compute.MacEmbeddingError):
                    compute._configured_owners()


class MacBatchTests(unittest.TestCase):
    def test_batches_at_most_eight_and_progress_counts_completed_chunks(self):
        client = FakeClient()
        progress = []
        with patch.object(compute, "_client_type", return_value=lambda: client):
            vectors = compute.embed_on_mac("owner-a", [str(i) for i in range(17)], "document_embedding", "original instruction", lambda done, total: progress.append((done, total)))
        self.assertEqual([len(call[2]) for call in client.submissions], [8, 8, 1])
        self.assertEqual(progress, [(0, 17), (8, 17), (16, 17), (17, 17)])
        self.assertEqual(len(vectors), 17)
        self.assertTrue(all(len(vector) == 1024 for vector in vectors))

    def test_character_limit_bounds_batch_without_changing_text(self):
        texts = ["字" * 16384] * 5
        self.assertEqual([len(batch) for batch in compute._batches(texts)], [4, 1])
        with self.assertRaises(compute.MacEmbeddingError):
            list(compute._batches(["字" * 16385]))

    def test_question_instruction_and_original_text_are_forwarded_once(self):
        client = FakeClient()
        with patch.object(compute, "_client_type", return_value=lambda: client):
            compute.embed_on_mac("owner-a", ["问题"], "question_embedding", "exact instruction")
        call = client.submissions[0]
        self.assertEqual((call[0], call[2], call[3], call[4]), ("owner-a", ["问题"], "question_embedding", "exact instruction"))

    def test_invalid_vectors_fail_without_another_engine(self):
        for vector in ([0.0] * 1024, [1.0], [math.nan] * 1024):
            client = FakeClient()
            client.result_embeddings = Mock(return_value=[vector])
            with patch.object(compute, "_client_type", return_value=lambda: client):
                with self.assertRaises(compute.MacEmbeddingError):
                    compute.embed_on_mac("owner-a", ["text"], "document_embedding", "")

    def test_mac_network_error_is_safe_and_does_not_include_secrets(self):
        client = FakeClient()
        client.submit_embed = Mock(side_effect=RuntimeError("secret token private path"))
        with patch.object(compute, "_client_type", return_value=lambda: client):
            with self.assertRaises(compute.MacEmbeddingError) as raised:
                compute.embed_on_mac("owner-a", ["text"], "document_embedding", "")
        self.assertNotIn("secret", str(raised.exception))

    def test_question_deadline_cancels_remote_work(self):
        client = FakeClient()
        client.submit_embed = Mock(return_value={"id": "pending", "state": "queued"})
        with patch.object(compute, "_client_type", return_value=lambda: client), patch.object(compute.time, "monotonic", side_effect=[0, 121]):
            with self.assertRaises(compute.MacEmbeddingError):
                compute.embed_on_mac("owner-a", ["text"], "question_embedding", "")
        self.assertEqual(client.cancelled, [("owner-a", "pending")])


if __name__ == "__main__":
    unittest.main()
