"""Generated ZIP exports must not inherit image upload or native preview limits."""
from __future__ import annotations
import hashlib
import io
import os
from datetime import datetime
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

_repository = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(_repository), str(_repository / "Mac")]
from desktop_backend.runtime import Runtime
from desktop_backend.storage import Storage
from PIL import Image


class HistoryArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.storage = Storage(Path(self.temp.name) / "data", _repository / "Mac")
        self.addCleanup(self.storage.close)
        self.runtime = Runtime.__new__(Runtime)
        self.runtime.storage = self.storage
        clock_patch = patch("desktop_backend.runtime.datetime")
        self.clock = clock_patch.start()
        self.addCleanup(clock_patch.stop)
        self.clock.now.return_value = datetime(2026, 10, 25, 22, 55, 0)

    def entry(self, data, filename, mime="application/octet-stream", model="通用增强"):
        asset = self.storage.save_bytes(data, filename, mime)
        return self.storage.add_history(asset["id"], model)

    def test_zip_over_40_mib_is_saved_and_download_bytes_are_intact(self):
        payload = os.urandom(21 * 1024 * 1024)
        first = self.entry(payload, "result.bin")
        second = self.entry(payload, "result.bin")
        exported = self.runtime.export_history([first["id"], second["id"]])
        path = self.storage.asset_path(exported["id"])
        self.assertGreater(exported["bytes"], 40 * 1024 * 1024)
        self.assertEqual(exported["mimeType"], "application/zip")
        self.assertEqual(exported["filename"], "拾燕_通用增强_20261025_225500.zip")
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(exported["bytes"], path.stat().st_size)
        self.assertEqual(exported["sha256"], hashlib.sha256(path.read_bytes()).hexdigest())
        with zipfile.ZipFile(path) as archive:
            self.assertEqual(archive.namelist(), ["result.bin", "result_2.bin"])
            self.assertIsNone(archive.testzip())
            for name in archive.namelist():
                self.assertEqual(archive.read(name), payload)
        self.assertNotIn("storedName", exported)
        self.assertEqual(exported["downloadUrl"], f"/api/assets/{exported['id']}/file?download=1")

    def test_upload_still_rejects_empty_and_over_40_mib_files(self):
        for data in (b"", b"x" * (40 * 1024 * 1024 + 1)):
            with self.subTest(bytes=len(data)), self.assertRaisesRegex(ValueError, "文件为空或超过 40 MB"):
                self.storage.save_bytes(data, "upload.zip", "application/zip")
        self.assertEqual(self.storage.list("assets"), [])

    def test_image_names_and_anime_suffix_survive_export(self):
        image = io.BytesIO()
        Image.new("RGB", (4, 3), "blue").save(image, "JPEG")
        first = self.entry(image.getvalue(), "photo.jpg", "image/jpeg", "动漫增强")
        second = self.entry(image.getvalue(), "photo.jpg", "image/jpeg", "动漫增强")
        exported = self.runtime.export_history([first["id"], second["id"]])
        self.assertEqual(exported["filename"], "拾燕_动漫增强_20261025_225500.zip")
        with zipfile.ZipFile(self.storage.asset_path(exported["id"])) as archive:
            self.assertEqual(archive.namelist(), ["photo_anime.jpg", "photo_anime_2.jpg"])
            self.assertEqual(archive.read("photo_anime.jpg"), image.getvalue())

    def test_archive_name_uses_enhancement_category_for_every_model_alias(self):
        for model, category in (("general", "通用增强"), ("x4", "通用增强"), ("通用增强", "通用增强"),
                                ("anime", "动漫增强"), ("x4anime", "动漫增强"), ("动漫增强", "动漫增强"),
                                ("AI Agent", "增强图片"), ("", "增强图片"), (None, "增强图片")):
            with self.subTest(model=model):
                payload = b"enhanced image bytes"
                entry = self.entry(payload, "result.bin", model=model)
                exported = self.runtime.export_history([entry["id"]])
                self.assertEqual(exported["filename"], f"拾燕_{category}_20261025_225500.zip")
                self.assertEqual(self.storage.export_filename(exported), exported["filename"])
                with zipfile.ZipFile(self.storage.asset_path(exported["id"])) as archive:
                    self.assertEqual(len(archive.namelist()), 1)
                    self.assertEqual(archive.read(archive.namelist()[0]), payload)

    def test_archive_name_groups_same_category_and_labels_mixed_categories(self):
        for models, category in ((("general", "x4", "通用增强"), "通用增强"),
                                 (("anime", "x4anime", "动漫增强"), "动漫增强"),
                                 (("general", "anime"), "混合增强"),
                                 (("general", "AI Agent"), "混合增强"),
                                 (("AI Agent", "其他"), "增强图片")):
            with self.subTest(models=models):
                entries = [self.entry(f"result {index}".encode(), "result.bin", model=model)
                           for index, model in enumerate(models)]
                exported = self.runtime.export_history([entry["id"] for entry in entries])
                self.assertEqual(exported["filename"], f"拾燕_{category}_20261025_225500.zip")
                with zipfile.ZipFile(self.storage.asset_path(exported["id"])) as archive:
                    self.assertEqual(len(archive.namelist()), len(entries))
                    self.assertEqual(len(set(archive.namelist())), len(entries))
                    self.assertEqual([archive.read(name) for name in archive.namelist()],
                                     [f"result {index}".encode() for index in range(len(entries))])

    def test_archive_name_uses_local_export_time_with_padded_date_and_seconds(self):
        entry = self.entry(b"original", "result.bin")
        self.clock.now.return_value = datetime(2027, 1, 2, 3, 4, 5)
        exported = self.runtime.export_history([entry["id"]])
        self.assertEqual(exported["filename"], "拾燕_通用增强_20270102_030405.zip")
        self.clock.now.assert_called_once_with()

    def test_invalid_selection_does_not_leave_an_archive(self):
        for ids in ([], ["missing"]):
            with self.subTest(ids=ids), self.assertRaisesRegex(ValueError, "有效的图片记录"):
                self.runtime.export_history(ids)
        self.assertEqual(list(self.storage.media.iterdir()), [])
        self.assertEqual(self.storage.list("assets"), [])

    def test_failed_archive_write_cleans_partial_files(self):
        entry = self.entry(b"original", "result.bin")
        before = set(self.storage.media.iterdir())
        with patch("desktop_backend.storage.zipfile.ZipFile.write", side_effect=OSError("disk full")):
            with self.assertRaisesRegex(OSError, "disk full"):
                self.runtime.export_history([entry["id"]])
        self.assertEqual(set(self.storage.media.iterdir()), before)
        self.assertEqual(len(self.storage.list("assets")), 1)

    def test_failed_registration_cleans_finished_archive(self):
        entry = self.entry(b"original", "result.bin")
        before = set(self.storage.media.iterdir())
        with patch.object(self.storage, "put", side_effect=OSError("database unavailable")):
            with self.assertRaisesRegex(OSError, "database unavailable"):
                self.runtime.export_history([entry["id"]])
        self.assertEqual(set(self.storage.media.iterdir()), before)
        self.assertEqual(len(self.storage.list("assets")), 1)


if __name__ == "__main__":
    unittest.main()
