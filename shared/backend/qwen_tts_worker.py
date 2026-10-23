"""Compatibility path for the existing native TTS worker."""
from pathlib import Path
import sys

for _parent in Path(__file__).resolve().parents:
    if (_parent / "shared" / "paths.py").is_file():
        if str(_parent) not in sys.path:
            sys.path.insert(0, str(_parent))
        break
from apps.desktop.adapters import qwen_tts_worker as _implementation

if __name__ == "__main__":
    _implementation.Worker().run()
else:
    sys.modules[__name__] = _implementation
