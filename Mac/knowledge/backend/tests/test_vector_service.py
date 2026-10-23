import importlib
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


SRC_DIR = Path(__file__).resolve().parents[1] / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

vector_module = importlib.import_module("services.vector_service")
VectorService = vector_module.VectorService


class LocalEmbeddingTests(unittest.TestCase):
    def test_bound_owner_uses_mac_for_documents_and_questions(self):
        service = VectorService.__new__(VectorService)
        service.provider = "qwen"
        with patch.object(vector_module, "current_mac_owner", return_value="owner-a"), patch.object(vector_module, "embed_on_mac", return_value=[[0.1, 0.2]]) as mac, patch.object(service, "_get_local_embeddings") as cpu:
            service.get_embeddings(["文档"], operation="document_embedding")
            service.get_embedding("问题", operation="question_embedding")
        self.assertEqual([call.args[2] for call in mac.call_args_list], ["document_embedding", "question_embedding"])
        cpu.assert_not_called()

    def test_bound_owner_mac_failure_never_falls_back_to_cpu(self):
        service = VectorService.__new__(VectorService)
        service.provider = "qwen"
        with patch.object(vector_module, "current_mac_owner", return_value="owner-a"), patch.object(vector_module, "embed_on_mac", side_effect=vector_module.MacEmbeddingError("Mac 离线")), patch.object(service, "_get_local_embeddings") as cpu:
            with self.assertRaisesRegex(vector_module.LocalEmbeddingError, "Mac 离线"):
                service.get_embeddings(["文档"])
        cpu.assert_not_called()

    def test_qwen_provider_does_not_call_remote_embedding(self):
        service = VectorService.__new__(VectorService)
        service.provider = "qwen"

        with patch.object(service, "_get_local_embeddings", return_value=[[0.1, 0.2]]) as local:
            with patch.object(service, "_get_doubao_embeddings") as remote:
                result = service.get_embeddings(["本地文本"])

        self.assertEqual(result, [[0.1, 0.2]])
        local.assert_called_once()
        remote.assert_not_called()

    def test_local_model_references_are_released_after_call(self):
        service = VectorService.__new__(VectorService)
        service.local_model = object()
        service.local_tokenizer = object()
        service.local_functional = object()
        service.local_device = "cpu"
        service.local_torch = object()

        service._release_local_model()

        self.assertIsNone(service.local_model)
        self.assertIsNone(service.local_tokenizer)
        self.assertIsNone(service.local_functional)
        self.assertIsNone(service.local_device)
        self.assertIsNone(service.local_torch)

    def test_local_embedding_worker_failure_is_reported(self):
        import io

        class FakeProcess:
            def __init__(self):
                self.stdin = io.StringIO()
                self.stdout = io.StringIO(
                    '{"type":"error","error":"RuntimeError: 模型不可用"}\n'
                )

            def wait(self):
                return 1

            def poll(self):
                return 1

            def kill(self):
                return None

        service = VectorService.__new__(VectorService)
        with patch.object(vector_module.subprocess, "Popen", return_value=FakeProcess()):
            with self.assertRaisesRegex(vector_module.LocalEmbeddingError, "模型不可用"):
                service._get_local_embeddings(["本地文本"], "document_embedding")


class DoubaoEmbeddingTests(unittest.TestCase):
    def test_remote_response_is_reordered_by_index_and_uses_configured_model(self):
        class FakeResponse:
            status_code = 200
            content = b'{}'

            def raise_for_status(self):
                return None

            def json(self):
                return {
                    "data": [
                        {"index": 1, "embedding": [0.3, 0.4]},
                        {"index": 0, "embedding": [0.1, 0.2]},
                    ]
                }

        service = VectorService.__new__(VectorService)
        service.api_key = "test-key"
        service.api_url = "https://embedding.example/v3/embeddings/multimodal"

        with patch.object(vector_module.requests, "post", return_value=FakeResponse()) as request:
            embeddings = service._call_doubao_embeddings(["第一段", "第二段"])

        self.assertEqual(embeddings, [[0.1, 0.2], [0.3, 0.4]])
        request.assert_called_once()
        self.assertEqual(request.call_args.kwargs["json"]["model"], vector_module.DOUBAO_EM_MODEL)
        self.assertEqual(request.call_args.kwargs["json"]["input"][1]["text"], "第二段")


class HistoricalCollectionCleanupTests(unittest.TestCase):
    def test_document_cleanup_finds_old_model_collection_from_objects(self):
        class FakeCollection:
            def __init__(self, name, metadata):
                self.name = name
                self.metadata = metadata
                self.deleted = []

            def delete(self, **kwargs):
                self.deleted.append(kwargs)

        class FakeClient:
            def __init__(self, collections):
                self.collections = collections

            def list_collections(self):
                return list(self.collections)

        historical = FakeCollection(
            "kb_old_embedding_model",
            {"knowledge_base_id": "kb-1", "embedding_model": "old-model"},
        )
        unrelated = FakeCollection(
            "kb_other",
            {"knowledge_base_id": "kb-2", "embedding_model": "old-model"},
        )
        service = VectorService.__new__(VectorService)
        service.client = FakeClient([historical, unrelated])

        service.delete_document("kb-1", "doc-1")

        self.assertEqual(historical.deleted, [{"where": {"document_id": "doc-1"}}])
        self.assertEqual(unrelated.deleted, [])

    def test_document_cleanup_resolves_name_only_collections_before_metadata_filter(self):
        class FakeCollection:
            def __init__(self, name, metadata):
                self.name = name
                self.metadata = metadata
                self.deleted = []

            def delete(self, **kwargs):
                self.deleted.append(kwargs)

        class FakeClient:
            def __init__(self, collections):
                self.collections = {collection.name: collection for collection in collections}

            def list_collections(self):
                return list(self.collections)

            def get_collection(self, name):
                return self.collections[name]

        historical = FakeCollection(
            "kb_old_embedding_model",
            {"knowledge_base_id": "kb-1", "embedding_model": "old-model"},
        )
        unrelated = FakeCollection(
            "kb_other",
            {"knowledge_base_id": "kb-2", "embedding_model": "old-model"},
        )
        service = VectorService.__new__(VectorService)
        service.client = FakeClient([historical, unrelated])

        service.delete_document("kb-1", "doc-1")

        self.assertEqual(historical.deleted, [{"where": {"document_id": "doc-1"}}])
        self.assertEqual(unrelated.deleted, [])


if __name__ == "__main__":
    unittest.main()
