import asyncio
import sys
import tempfile
import uuid
import unittest
from pathlib import Path
from types import SimpleNamespace


SRC_DIR = Path(__file__).resolve().parents[1] / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

import database
import main


class UploadStateTests(unittest.TestCase):
    def test_new_upload_starts_queued_until_worker_claims_it(self):
        original_db_path = database.DB_PATH
        original_save = main._save_pdf_upload
        original_wake = main._wake_ingestion_worker
        try:
            with tempfile.TemporaryDirectory() as temp_dir:
                database.DB_PATH = Path(temp_dir) / "upload.db"
                database.init_db()
                user = database.create_user("upload@example.com", "Upload", "hash")
                space = database.create_space_for_user(user["id"])
                knowledge_base = {
                    "id": str(uuid.uuid4()),
                    "name": "上传状态测试",
                }
                now = database.utc_now()
                with database.get_conn() as conn:
                    conn.execute(
                        """
                        INSERT INTO knowledge_bases(
                            id, space_id, name, description, created_by, created_at, updated_at
                        ) VALUES (?, ?, ?, '', ?, ?, ?)
                        """,
                        (
                            knowledge_base["id"],
                            space["id"],
                            knowledge_base["name"],
                            user["id"],
                            now,
                            now,
                        ),
                    )

                pdf_path = Path(temp_dir) / "sample.pdf"
                pdf_path.write_bytes(b"%PDF-1.4\n%%EOF")

                async def fake_save(_file):
                    return "sample.pdf", str(pdf_path)

                main._save_pdf_upload = fake_save
                main._wake_ingestion_worker = lambda: None
                result = asyncio.run(
                    main._create_document_upload(
                        knowledge_base,
                        user,
                        SimpleNamespace(content_type="application/pdf"),
                    )
                )

                document = database.fetch_one(
                    "SELECT status FROM documents WHERE id = ?",
                    (result["document_id"],),
                )
                task = database.fetch_one(
                    "SELECT status FROM tasks WHERE task_id = ?",
                    (result["task_id"],),
                )
                self.assertEqual(result["status"], "queued")
                self.assertEqual(document, {"status": "queued"})
                self.assertEqual(task, {"status": "queued"})
        finally:
            database.DB_PATH = original_db_path
            main._save_pdf_upload = original_save
            main._wake_ingestion_worker = original_wake


if __name__ == "__main__":
    unittest.main()
