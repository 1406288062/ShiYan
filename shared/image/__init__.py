"""Legacy import namespace for the single physical shared implementation."""
from pathlib import Path
import sys

for _parent in Path(__file__).resolve().parents:
    if (_parent / "shared" / "paths.py").is_file():
        if str(_parent) not in sys.path:
            sys.path.insert(0, str(_parent))
        break
