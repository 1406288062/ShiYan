import sys
import unittest
from pathlib import Path


SRC_DIR = Path(__file__).resolve().parents[1] / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

import services.retrieval_service as retrieval_module
from services.vector_service import EmbeddingError


class RetrievalFallbackTests(unittest.TestCase):
    def test_lexical_results_survive_embedding_outage(self):
        rows = [
            {
                "chunk_id": "chunk-1",
                "content": "缓存命中后直接返回结果。",
                "document_id": "doc-1",
                "page_start": 2,
                "page_end": 2,
                "heading": "缓存策略",
                "title": "服务设计",
                "filename": "service.pdf",
            }
        ]
        original_fetch_all = retrieval_module.fetch_all
        original_query = retrieval_module.vector_service.query
        try:
            retrieval_module.fetch_all = lambda *_args, **_kwargs: rows

            def unavailable(*_args, **_kwargs):
                raise EmbeddingError("embedding unavailable")

            retrieval_module.vector_service.query = unavailable
            citations = retrieval_module.retrieval_service.search("kb-1", "缓存")
        finally:
            retrieval_module.fetch_all = original_fetch_all
            retrieval_module.vector_service.query = original_query

        self.assertEqual(len(citations), 1)
        self.assertEqual(citations[0]["chunk_id"], "chunk-1")
        self.assertEqual(citations[0]["retrieval"]["lexical_rank"], 1)
        self.assertIsNone(citations[0]["retrieval"]["vector_rank"])


if __name__ == "__main__":
    unittest.main()
