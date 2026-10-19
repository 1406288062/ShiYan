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


class TaskRecoveryTests(unittest.TestCase):
    def test_interrupted_task_is_requeued_and_atomically_claimed(self):
        original_path = database.DB_PATH
        try:
            with tempfile.TemporaryDirectory() as temp_dir:
                database.DB_PATH = Path(temp_dir) / "recovery.db"
                database.init_db()
                user = database.create_user("recover@example.com", "Recover", "hash")
                space = database.create_space_for_user(user["id"])
                kb_id = str(uuid.uuid4())
                document_id = str(uuid.uuid4())
                task_id = str(uuid.uuid4())
                pdf_path = Path(temp_dir) / "pending.pdf"
                pdf_path.write_bytes(b"%PDF-1.4\n%%EOF")
                now = database.utc_now()

                with database.get_conn() as conn:
                    conn.execute(
                        """
                        INSERT INTO knowledge_bases(
                            id, space_id, name, description, created_by, created_at, updated_at
                        ) VALUES (?, ?, ?, '', ?, ?, ?)
                        """,
                        (kb_id, space["id"], "恢复测试", user["id"], now, now),
                    )
                    conn.execute(
                        """
                        INSERT INTO documents(
                            id, knowledge_base_id, title, filename, stored_path,
                            created_by, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            document_id,
                            kb_id,
                            "待恢复",
                            "pending.pdf",
                            str(pdf_path),
                            user["id"],
                            now,
                            now,
                        ),
                    )
                    conn.execute(
                        """
                        INSERT INTO tasks(
                            task_id, user_id, knowledge_base_id, document_id,
                            file_path, status, progress, stage, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, 'processing', 68, 'indexing', ?, ?)
                        """,
                        (task_id, user["id"], kb_id, document_id, str(pdf_path), now, now),
                    )

                main._recover_ingestion_tasks()
                recovered = database.fetch_one(
                    "SELECT status, progress, stage FROM tasks WHERE task_id = ?",
                    (task_id,),
                )
                self.assertEqual(recovered, {"status": "queued", "progress": 5, "stage": "queued"})

                claimed = main._claim_next_ingestion_task()
                claimed_row = database.fetch_one(
                    "SELECT status, stage, attempts FROM tasks WHERE task_id = ?",
                    (task_id,),
                )
                self.assertEqual(claimed["task_id"], task_id)
                self.assertEqual(claimed_row, {"status": "processing", "stage": "starting", "attempts": 1})
        finally:
            database.DB_PATH = original_path


if __name__ == "__main__":
    unittest.main()
