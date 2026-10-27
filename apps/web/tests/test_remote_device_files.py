import asyncio
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from apps.web.adapters.device_files import command


class RemoteScriptTests(unittest.TestCase):
    def run_script(self, args):
        env = os.environ.copy()
        if hasattr(self, "test_home"):
            env["HOME"] = str(self.test_home)
        completed = subprocess.run(command(args), shell=True, text=True, capture_output=True, timeout=30, env=env)
        self.assertLessEqual(len(completed.stdout), 16 * 1024 * 1024)
        return completed.returncode, json.loads(completed.stdout)

    def test_binding_listing_search_read_save_backup_conflict_and_isolation(self):
        with tempfile.TemporaryDirectory(dir="/private/tmp") as folder:
            root = Path(folder)
            self.test_home = root / "home"
            self.test_home.mkdir()
            source = root / "hello.txt"
            original = "第一行\r\n第二行\r\n".encode("utf-8")
            source.write_bytes(original)
            outside = root.parent / (root.name + "-outside.txt")
            outside.write_text("outside", encoding="utf-8")
            (root / "escape").symlink_to(root.parent)

            code, result = self.run_script({"action": "validate_root", "path": str(root)})
            self.assertEqual(code, 0)
            self.assertEqual(result["result"]["path"], str(root))

            code, result = self.run_script({"action": "list", "root": str(root), "path": "", "offset": 0})
            self.assertEqual(code, 0)
            self.assertTrue(any(item["name"] == "hello.txt" for item in result["result"]["entries"]))
            self.assertTrue(any(item["symlink"] for item in result["result"]["entries"]))

            code, result = self.run_script({"action": "search", "root": str(root), "q": "hello"})
            self.assertEqual(code, 0)
            self.assertEqual(result["result"]["entries"][0]["path"], "hello.txt")

            code, result = self.run_script({"action": "read", "root": str(root), "path": "hello.txt"})
            self.assertEqual(code, 0)
            file_info = result["result"]
            self.assertEqual(file_info["newline"], "CRLF")
            content_hash = hashlib.sha256(original).hexdigest()
            self.assertEqual(file_info["contentHash"], content_hash)

            request_id = "request-remote-123"
            changed = "改过的内容\n"
            code, result = self.run_script({
                "action": "save", "root": str(root), "path": "hello.txt", "requestId": request_id,
                "contentHash": content_hash, "encoding": "UTF-8", "newline": "CRLF", "bom": False,
                "textB64": __import__("base64").b64encode(changed.encode()).decode(),
            })
            self.assertEqual(code, 0)
            backup = Path(result["result"]["backupPath"])
            self.assertEqual(backup.read_bytes(), original)
            self.assertFalse((root / ".shiyan-web-state").exists())
            self.assertEqual(source.read_bytes(), "改过的内容\r\n".encode("utf-8"))

            # The same request is a receipt lookup and cannot overwrite again.
            source.write_text("changed outside receipt\n", encoding="utf-8")
            code, repeated = self.run_script({
                "action": "save", "root": str(root), "path": "hello.txt", "requestId": request_id,
                "contentHash": content_hash, "encoding": "UTF-8", "newline": "CRLF", "bom": False,
                "textB64": __import__("base64").b64encode(changed.encode()).decode(),
            })
            self.assertEqual(code, 0)
            self.assertEqual(repeated["result"]["backupPath"], result["result"]["backupPath"])
            self.assertEqual(source.read_bytes(), b"changed outside receipt\n")

            code, different = self.run_script({
                "action": "save", "root": str(root), "path": "hello.txt", "requestId": request_id,
                "contentHash": content_hash, "textB64": __import__("base64").b64encode(b"must not apply").decode(),
            })
            self.assertNotEqual(code, 0)
            self.assertIn("不同", different["error"])

            # Stale hashes and every unsafe path are rejected by the device.
            code, conflict = self.run_script({
                "action": "save", "root": str(root), "path": "hello.txt", "requestId": "request-conflict-123",
                "contentHash": content_hash, "encoding": "UTF-8", "newline": "LF", "bom": False,
                "textB64": __import__("base64").b64encode(b"conflict").decode(),
            })
            self.assertNotEqual(code, 0)
            self.assertIn("文件已被其他程序修改", conflict["error"])
            for unsafe in ("../" + root.name + "-outside.txt", "/etc/passwd", "escape/outside"):
                code, response = self.run_script({"action": "read", "root": str(root), "path": unsafe})
                self.assertNotEqual(code, 0, unsafe)

            outside.unlink(missing_ok=True)

    def test_save_preserves_bom_newline_encoding_mode_and_private_cache(self):
        with tempfile.TemporaryDirectory(dir="/private/tmp") as folder:
            root = Path(folder); self.test_home = root / "home"; self.test_home.mkdir()
            source = root / "executable.txt"
            original = b"\xef\xbb\xbfold\r\n"
            source.write_bytes(original); source.chmod(0o755)
            digest = hashlib.sha256(original).hexdigest()
            code, result = self.run_script({
                "action": "save", "root": str(root), "path": source.name,
                "requestId": "request-mode-123", "contentHash": digest,
                "textB64": __import__("base64").b64encode("new\n".encode()).decode(),
            })
            self.assertEqual(code, 0, result)
            self.assertEqual(source.read_bytes(), b"\xef\xbb\xbfnew\r\n")
            self.assertEqual(source.stat().st_mode & 0o777, 0o755)
            backup = Path(result["result"]["backupPath"])
            self.assertEqual(backup.read_bytes(), original)
            self.assertFalse((root / ".shiyan-web-state").exists())
            self.assertTrue((self.test_home / ".local" / "state" / "shiyan-web").is_dir())

            binary = root / "binary.bin"; binary.write_bytes(b"\x00\x01")
            code, response = self.run_script({
                "action": "save", "root": str(root), "path": binary.name,
                "requestId": "request-binary-123", "contentHash": hashlib.sha256(binary.read_bytes()).hexdigest(),
                "textB64": __import__("base64").b64encode(b"text").decode(),
            })
            self.assertNotEqual(code, 0)
            self.assertIn("二进制", response["error"])

    def test_directory_cap_is_truthful(self):
        with tempfile.TemporaryDirectory(dir="/private/tmp") as folder:
            root = Path(folder); self.test_home = root / "home"; self.test_home.mkdir()
            for index in range(2003): (root / ("file-%04d.txt" % index)).write_text("x")
            code, response = self.run_script({"action": "list", "root": str(root), "path": "", "offset": 0})
            self.assertEqual(code, 0)
            listing = response["result"]
            self.assertTrue(listing["truncated"])
            self.assertFalse(listing["totalKnown"])

    def test_changes_untracked_file_uses_empty_baseline_without_repo_state(self):
        with tempfile.TemporaryDirectory(dir="/private/tmp") as folder, tempfile.TemporaryDirectory(dir="/private/tmp") as home:
            root = Path(folder); self.test_home = Path(home)
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            source = root / "untracked.py"; source.write_text("print('new')\n")
            before = subprocess.run(["git", "-C", str(root), "status", "--porcelain"], check=True,
                                    capture_output=True, text=True).stdout
            code, response = self.run_script({"action": "changes", "root": str(root), "path": source.name})
            after = subprocess.run(["git", "-C", str(root), "status", "--porcelain"], check=True,
                                   capture_output=True, text=True).stdout
            self.assertEqual(code, 0)
            self.assertEqual(response["result"]["baselineText"], "")
            self.assertEqual(response["result"]["source"], "工作区新文件")
            self.assertEqual(before, after)
            self.assertFalse((root / ".shiyan-web-state").exists())


if __name__ == "__main__":
    unittest.main()
