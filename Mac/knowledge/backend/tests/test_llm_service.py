import json
import sys
import unittest
from pathlib import Path

SRC_DIR = Path(__file__).resolve().parents[1] / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from services.llm_service import LLMService


class StructuredJsonParsingTests(unittest.TestCase):
    def test_json_string_can_contain_markdown_code_fence(self):
        payload = {
            "text": '示例代码：\n```python\nprint("ok")\n```\n结束',
            "is_blank": False,
            "content_kinds": ["text", "code"],
        }
        content = json.dumps(payload, ensure_ascii=False)

        parsed = LLMService._json_object_from_text(content)

        self.assertEqual(parsed, payload)

    def test_whole_response_json_fence_is_unwrapped(self):
        content = '```json\n{"text":"ok","is_blank":false}\n```'
        parsed = LLMService._json_object_from_text(content)
        self.assertEqual(parsed["text"], "ok")


if __name__ == "__main__":
    unittest.main()
