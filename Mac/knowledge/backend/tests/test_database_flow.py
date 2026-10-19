import sys
import tempfile
import unittest
from pathlib import Path


SRC_DIR = Path(__file__).resolve().parents[1] / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

import database


class KnowledgeBaseFlowTests(unittest.TestCase):
    def test_new_space_does_not_create_a_hidden_knowledge_base(self):
        original_path = database.DB_PATH
        try:
            with tempfile.TemporaryDirectory() as temp_dir:
                database.DB_PATH = Path(temp_dir) / "flow.db"
                database.init_db()
                user = database.create_user("flow@example.com", "Flow", "test-hash")
                space = database.create_space_for_user(user["id"])

                knowledge_bases = database.fetch_all(
                    "SELECT id FROM knowledge_bases WHERE space_id = ?",
                    (space["id"],),
                )
                membership = database.fetch_one(
                    "SELECT role FROM space_members WHERE space_id = ? AND user_id = ?",
                    (space["id"], user["id"]),
                )

                self.assertEqual(knowledge_bases, [])
                self.assertEqual(membership["role"], "owner")
        finally:
            database.DB_PATH = original_path

    def test_ingestion_recovery_columns_are_migrated(self):
        original_path = database.DB_PATH
        try:
            with tempfile.TemporaryDirectory() as temp_dir:
                database.DB_PATH = Path(temp_dir) / "schema.db"
                database.init_db()
                with database.get_conn() as conn:
                    task_columns = {
                        row[1]: row for row in conn.execute("PRAGMA table_info(tasks)")
                    }
                    document_columns = {
                        row[1]: row for row in conn.execute("PRAGMA table_info(documents)")
                    }

                self.assertIn("stage", task_columns)
                self.assertIn("attempts", task_columns)
                self.assertEqual(task_columns["status"][4], "'queued'")
                self.assertIn("page_count", document_columns)
                self.assertIn("extraction_json", document_columns)
        finally:
            database.DB_PATH = original_path


if __name__ == "__main__":
    unittest.main()
