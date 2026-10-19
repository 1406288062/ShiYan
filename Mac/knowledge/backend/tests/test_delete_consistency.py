import asyncio
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


class DeletionConsistencyTests(unittest.TestCase):
    def test_failed_vector_cleanup_never_finalizes_delete(self):
        original_path = database.DB_PATH
        original_document_delete = main.vector_service.delete_document
        original_knowledge_base_delete = main.vector_service.delete_knowledge_base
        try:
            with tempfile.TemporaryDirectory() as temp_dir:
                database.DB_PATH = Path(temp_dir) / "delete.db"
                database.init_db()
                user = database.create_user("delete@example.com", "Delete", "hash")
                space = database.create_space_for_user(user["id"])
                knowledge_base_id = str(uuid.uuid4())
                document_id = str(uuid.uuid4())
                now = database.utc_now()
                stored_path = Path(temp_dir) / "document.pdf"
                stored_path.write_bytes(b"%PDF-1.4\n%%EOF")

                with database.get_conn() as conn:
                    conn.execute(
                        """
                        INSERT INTO knowledge_bases(
                            id, space_id, name, description, created_by, created_at, updated_at
                        ) VALUES (?, ?, ?, '', ?, ?, ?)
                        """,
                        (knowledge_base_id, space["id"], "删除测试", user["id"], now, now),
                    )
                    conn.execute(
                        """
                        INSERT INTO documents(
                            id, knowledge_base_id, title, filename, stored_path,
                            status, created_by, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?)
                        """,
                        (
                            document_id,
                            knowledge_base_id,
                            "待删除",
                            "document.pdf",
                            str(stored_path),
                            user["id"],
                            now,
                            now,
                        ),
                    )

                def fail(*_args, **_kwargs):
                    raise RuntimeError("chroma unavailable")

                main.vector_service.delete_document = fail
                with self.assertRaisesRegex(main.HTTPException, "文档未删除"):
                    asyncio.run(main.delete_document(document_id, user))
                self.assertIsNotNone(
                    database.fetch_one("SELECT id FROM documents WHERE id = ?", (document_id,))
                )
                self.assertTrue(stored_path.exists())

                main.vector_service.delete_knowledge_base = fail
                with self.assertRaisesRegex(main.HTTPException, "知识库未删除"):
                    asyncio.run(main.delete_knowledge_base(knowledge_base_id, user))
                self.assertIsNotNone(
                    database.fetch_one(
                        "SELECT id FROM knowledge_bases WHERE id = ?",
                        (knowledge_base_id,),
                    )
                )
                self.assertTrue(stored_path.exists())

                with database.get_conn() as conn:
                    conn.execute(
                        "UPDATE documents SET status = 'queued' WHERE id = ?",
                        (document_id,),
                    )
                with self.assertRaisesRegex(main.HTTPException, "处理或排队"):
                    asyncio.run(main.delete_document(document_id, user))
                with self.assertRaisesRegex(main.HTTPException, "处理或排队"):
                    asyncio.run(main.delete_knowledge_base(knowledge_base_id, user))
        finally:
            database.DB_PATH = original_path
            main.vector_service.delete_document = original_document_delete
            main.vector_service.delete_knowledge_base = original_knowledge_base_delete


if __name__ == "__main__":
    unittest.main()
