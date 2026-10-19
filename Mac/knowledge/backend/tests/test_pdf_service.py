import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from PIL import Image


SRC_DIR = Path(__file__).resolve().parents[1] / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from services.pdf_service import (
    content_hash,
    PdfPage,
    assess_pdf_page,
    build_knowledge_context,
    extract_pdf_document,
    split_pages_into_chunks,
)


class PdfChunkingTests(unittest.TestCase):
    def test_chinese_sentences_split_without_whitespace(self):
        text = "这是一个用于验证中文切分的完整句子。" * 180
        chunks = split_pages_into_chunks([PdfPage(1, text)], chunk_size=420, overlap=60)

        self.assertGreater(len(chunks), 1)
        self.assertTrue(all(0 < len(chunk["text"]) <= 420 for chunk in chunks))
        self.assertTrue(all(chunk["page_start"] == 1 for chunk in chunks))

    def test_overlap_never_pushes_chunk_over_limit(self):
        chunks = split_pages_into_chunks(
            [PdfPage(1, "中" * 3000)],
            chunk_size=1200,
            overlap=160,
        )

        self.assertGreater(len(chunks), 2)
        self.assertTrue(all(len(chunk["text"]) <= 1200 for chunk in chunks))

    def test_punctuation_at_chunk_boundary_never_exceeds_limit(self):
        text = ("中" * 1199) + "。" + ("后" * 300)
        chunks = split_pages_into_chunks(
            [PdfPage(1, text)],
            chunk_size=1200,
            overlap=160,
        )

        self.assertTrue(all(len(chunk["text"]) <= 1200 for chunk in chunks))

    def test_long_context_keeps_every_fragment_label(self):
        chunks = [
            {
                "text": f"START-{index} " + ("内容" * 150) + f" END-{index}",
                "page_start": index,
                "page_end": index,
            }
            for index in range(1, 41)
        ]

        context = build_knowledge_context(chunks, max_chars=7000)

        self.assertLessEqual(len(context), 7000)
        self.assertIn("\n…\n", context)
        for index in range(1, 41):
            self.assertIn(f"[片段 {index} | 第 {index}-{index} 页]", context)
            self.assertIn(f"START-{index}", context)
            self.assertIn(f"END-{index}", context)

    def test_content_hash_binds_page_boundaries(self):
        first = split_pages_into_chunks([PdfPage(1, "同一段正文")])
        moved = split_pages_into_chunks([PdfPage(2, "同一段正文")])

        self.assertNotEqual(content_hash(first), content_hash(moved))

    def test_same_page_content_keeps_same_hash(self):
        first = split_pages_into_chunks([PdfPage(1, "同一段正文")])
        repeated = split_pages_into_chunks([PdfPage(1, "同一段正文")])

        self.assertEqual(content_hash(first), content_hash(repeated))


class PdfAssessmentTests(unittest.TestCase):
    def test_clean_text_page_stays_local(self):
        assessment = assess_pdf_page(
            "可检索的正文内容。" * 30,
            page_width=600,
            page_height=800,
            images=[],
            words=[],
        )

        self.assertFalse(assessment.requires_vision)
        self.assertFalse(assessment.is_blank)

    def test_full_page_image_uses_vision(self):
        assessment = assess_pdf_page(
            "",
            page_width=600,
            page_height=800,
            images=[{"x0": 0, "x1": 600, "top": 0, "bottom": 800}],
            words=[],
        )

        self.assertTrue(assessment.requires_vision)
        self.assertIn("image_heavy", assessment.reasons)

    def test_vector_graphics_page_uses_vision(self):
        assessment = assess_pdf_page(
            "图表标题、坐标轴和图例说明。" * 8,
            page_width=600,
            page_height=800,
            images=[],
            words=[],
            drawing_count=4,
        )

        self.assertFalse(assessment.is_blank)
        self.assertTrue(assessment.requires_vision)
        self.assertIn("vector_graphics", assessment.reasons)

    def test_text_heavy_vector_chart_is_transcribed_for_vision(self):
        class FakePage:
            width = 600
            height = 800
            images = []
            lines = [{}, {}, {}, {}]
            rects = []
            curves = []

            def extract_text(self):
                return "图表标题、坐标轴和图例说明。" * 8

            def extract_words(self):
                return []

            def find_tables(self):
                return []

            def to_image(self, **_kwargs):
                return SimpleNamespace(original=Image.new("RGB", (120, 160), "white"))

        class FakePdf:
            pages = [FakePage()]

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

        def transcribe(*_):
            return {"text": "矢量流程图说明", "is_blank": False}

        with patch("services.pdf_service.pdfplumber.open", return_value=FakePdf()):
            document = extract_pdf_document("vector.pdf", vision_extractor=transcribe)

        self.assertEqual(document.vision_pages, 1)
        self.assertEqual(document.pages[0].text, "矢量流程图说明")

    def test_failed_local_extraction_is_not_treated_as_blank(self):
        assessment = assess_pdf_page(
            "",
            page_width=600,
            page_height=800,
            images=[],
            words=[],
            extraction_failed=True,
        )

        self.assertFalse(assessment.is_blank)
        self.assertTrue(assessment.requires_vision)
        self.assertIn("local_error", assessment.reasons)

    def test_image_pdf_is_rendered_for_vision_transcription(self):
        calls = []

        def transcribe(data_url, page_number, local_text, reasons):
            calls.append((data_url, page_number, local_text, reasons))
            return {"text": "扫描页标题\n表格列名：数值 42", "is_blank": False}

        with tempfile.TemporaryDirectory() as temp_dir:
            pdf_path = Path(temp_dir) / "scan.pdf"
            image = Image.new("RGB", (320, 480), "white")
            image.save(pdf_path, "PDF")

            document = extract_pdf_document(pdf_path, vision_extractor=transcribe)

        self.assertEqual(document.total_pages, 1)
        self.assertEqual(document.vision_pages, 1)
        self.assertEqual(document.pages[0].extraction_method, "vision")
        self.assertIn("数值 42", document.pages[0].text)
        self.assertEqual(calls[0][1], 1)
        self.assertTrue(calls[0][0].startswith("data:image/jpeg;base64,"))

    def test_visual_text_wins_over_a_contradictory_blank_flag(self):
        def transcribe(*_):
            return {"text": "图片中的有效正文", "is_blank": True}

        with tempfile.TemporaryDirectory() as temp_dir:
            pdf_path = Path(temp_dir) / "scan.pdf"
            Image.new("RGB", (120, 180), "white").save(pdf_path, "PDF")

            document = extract_pdf_document(
                pdf_path,
                vision_extractor=transcribe,
            )

        self.assertEqual(document.blank_pages, 0)
        self.assertEqual(document.vision_pages, 1)
        self.assertEqual(document.pages[0].text, "图片中的有效正文")

    def test_local_text_survives_blank_vision_response(self):
        class FakePage:
            width = 600
            height = 800
            images = [{"x0": 0, "x1": 600, "top": 0, "bottom": 800}]
            lines = []
            rects = []
            curves = []

            def extract_text(self):
                return "本地提取的正文，即使视觉模型返回空白也可索引。"

            def extract_words(self):
                return []

            def find_tables(self):
                return []

            def to_image(self, **_kwargs):
                return SimpleNamespace(original=Image.new("RGB", (120, 160), "white"))

        class FakePdf:
            pages = [FakePage()]

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

        def transcribe(*_):
            return {"text": "", "is_blank": True}

        with patch("services.pdf_service.pdfplumber.open", return_value=FakePdf()):
            document = extract_pdf_document("synthetic.pdf", vision_extractor=transcribe)

        self.assertEqual(document.pages[0].text, "本地提取的正文，即使视觉模型返回空白也可索引。")
        self.assertEqual(document.pages[0].extraction_method, "text")
        self.assertEqual(document.text_pages, 1)
        self.assertEqual(document.vision_pages, 0)
        self.assertTrue(any("保留本地解析结果" in warning for warning in document.warnings))


    def test_visual_page_never_disappears_without_a_vision_service(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            pdf_path = Path(temp_dir) / "scan.pdf"
            Image.new("RGB", (120, 180), "white").save(pdf_path, "PDF")

            with self.assertRaisesRegex(ValueError, "视觉解析服务不可用"):
                extract_pdf_document(pdf_path)


if __name__ == "__main__":
    unittest.main()
