import json
import sys
import tempfile
import unittest
import uuid
from pathlib import Path


SRC_DIR = Path(__file__).resolve().parents[1] / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

import database
import main
from services.knowledge_graph_service import build_knowledge_graph
from services.pdf_service import PdfDocument, PdfPage, content_hash, split_pages_into_chunks


class DuplicateIngestionTests(unittest.TestCase):
    def test_duplicate_upload_is_indexed_as_independent_document(self):
        original_db = database.DB_PATH
        original_knowledge_dir = main.KNOWLEDGE_DIR
        original_delete = main.vector_service.delete_document
        original_add = main.vector_service.add_chunks
        original_extract = main.extract_pdf_document
        original_generate = main.llm_service.generate_knowledge
        try:
            with tempfile.TemporaryDirectory() as temp_dir:
                root = Path(temp_dir)
                database.DB_PATH = root / "duplicate.db"
                main.KNOWLEDGE_DIR = root / "knowledge"
                main.KNOWLEDGE_DIR.mkdir()
                database.init_db()

                user = database.create_user("duplicate@example.com", "Duplicate", "hash")
                space = database.create_space_for_user(user["id"])
                knowledge_base_id = str(uuid.uuid4())
                original_id = str(uuid.uuid4())
                duplicate_id = str(uuid.uuid4())
                task_id = str(uuid.uuid4())
                now = database.utc_now()
                original_path = root / "original.pdf"
                duplicate_path = root / "duplicate.pdf"
                original_path.write_bytes(b"%PDF-1.4\n%%EOF")
                duplicate_path.write_bytes(b"%PDF-1.4\n%%EOF")

                chunks = split_pages_into_chunks([PdfPage(1, "重复正文")])
                digest = content_hash(chunks)
                knowledge = {
                    "title": "重复正文主题",
                    "summary": "原始资料摘要",
                    "tags": ["重复正文"],
                    "structure": {
                        "level1": {
                            "id": "root",
                            "title": "重复正文主题",
                            "content": "<p>主题</p>",
                            "level2": [
                                {
                                    "id": "topic_1",
                                    "title": "正文模块",
                                    "merge_key": "正文模块",
                                    "content": "<p>模块</p>",
                                    "sources": [
                                        {"page_start": 1, "page_end": 1, "quote": "重复正文"}
                                    ],
                                    "level3": [],
                                }
                            ],
                        }
                    },
                }

                with database.get_conn() as conn:
                    conn.execute(
                        """
                        INSERT INTO knowledge_bases(
                            id, space_id, name, description, created_by, created_at, updated_at
                        ) VALUES (?, ?, ?, '', ?, ?, ?)
                        """,
                        (knowledge_base_id, space["id"], "重复资料", user["id"], now, now),
                    )
                    conn.execute(
                        """
                        INSERT INTO documents(
                            id, knowledge_base_id, title, filename, stored_path, status,
                            summary, tags_json, knowledge_json, created_by, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            original_id,
                            knowledge_base_id,
                            "原始资料",
                            "original.pdf",
                            str(original_path),
                            knowledge["summary"],
                            json.dumps(knowledge["tags"], ensure_ascii=False),
                            json.dumps(knowledge, ensure_ascii=False),
                            user["id"],
                            now,
                            now,
                        ),
                    )
                    conn.execute(
                        """
                        INSERT INTO document_versions(id, document_id, version_no, content_hash, created_at)
                        VALUES (?, ?, 1, ?, ?)
                        """,
                        (str(uuid.uuid4()), original_id, digest, now),
                    )
                    conn.execute(
                        """
                        INSERT INTO documents(
                            id, knowledge_base_id, title, filename, stored_path, status,
                            created_by, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, 'processing', ?, ?, ?)
                        """,
                        (
                            duplicate_id,
                            knowledge_base_id,
                            "重复上传",
                            "duplicate.pdf",
                            str(duplicate_path),
                            user["id"],
                            now,
                            now,
                        ),
                    )
                    conn.execute(
                        """
                        INSERT INTO tasks(
                            task_id, user_id, knowledge_base_id, document_id, file_path,
                            status, progress, stage, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, 'processing', 38, 'indexing', ?, ?)
                        """,
                        (task_id, user["id"], knowledge_base_id, duplicate_id, str(duplicate_path), now, now),
                    )

                indexed_chunks = []

                main.vector_service.delete_document = lambda *_args, **_kwargs: None
                main.vector_service.add_chunks = lambda _kb_id, values, **_kwargs: indexed_chunks.extend(values)
                main.extract_pdf_document = lambda *_args, **_kwargs: PdfDocument(
                    pages=[PdfPage(1, "重复正文")],
                    total_pages=1,
                    text_pages=1,
                    vision_pages=0,
                    blank_pages=0,
                    warnings=[],
                )

                def fail_if_model_called(*_args, **_kwargs):
                    raise AssertionError("重复资料应复用已验证知识结构")

                main.llm_service.generate_knowledge = fail_if_model_called
                main.process_document_task(
                    task_id,
                    user["id"],
                    knowledge_base_id,
                    duplicate_id,
                    str(duplicate_path),
                )

                duplicate = database.fetch_one(
                    "SELECT status, summary, knowledge_json FROM documents WHERE id = ?",
                    (duplicate_id,),
                )
                task = database.fetch_one(
                    "SELECT status, progress FROM tasks WHERE task_id = ?",
                    (task_id,),
                )
                version_count = database.fetch_one(
                    "SELECT COUNT(*) AS count FROM document_versions WHERE document_id = ?",
                    (duplicate_id,),
                )
                chunk_count = database.fetch_one(
                    "SELECT COUNT(*) AS count FROM chunks WHERE document_id = ?",
                    (duplicate_id,),
                )
                documents = [
                    main._serialize_document(row, include_knowledge=True)
                    for row in database.fetch_all(
                        "SELECT * FROM documents WHERE knowledge_base_id = ? AND status = 'completed'",
                        (knowledge_base_id,),
                    )
                ]
                graph = build_knowledge_graph(
                    {"id": knowledge_base_id, "name": "重复资料", "description": ""},
                    documents,
                )

                self.assertEqual(duplicate["status"], "completed")
                self.assertEqual(duplicate["summary"], knowledge["summary"])
                self.assertEqual(json.loads(duplicate["knowledge_json"]), knowledge)
                self.assertEqual(task, {"status": "completed", "progress": 100})
                self.assertEqual(version_count["count"], 1)
                self.assertEqual(chunk_count["count"], 1)
                self.assertEqual(len(indexed_chunks), 1)
                self.assertEqual(indexed_chunks[0]["document_id"], duplicate_id)
                self.assertEqual(graph["document_count"], 2)
                self.assertEqual(graph["module_count"], 1)
                self.assertEqual(graph["structure"]["level1"]["level2"][0]["support_count"], 2)
        finally:
            database.DB_PATH = original_db
            main.KNOWLEDGE_DIR = original_knowledge_dir
            main.vector_service.delete_document = original_delete
            main.vector_service.add_chunks = original_add
            main.extract_pdf_document = original_extract
            main.llm_service.generate_knowledge = original_generate


if __name__ == "__main__":
    unittest.main()
