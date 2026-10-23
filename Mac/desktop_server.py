#!/usr/bin/env python3
"""Compatibility entry; the single server implementation lives in shared/."""
from pathlib import Path
import sys

_repository = Path(__file__).resolve().parent
if not (_repository / "shared" / "paths.py").is_file():
    _repository = _repository.parent
if str(_repository) not in sys.path:
    sys.path.insert(0, str(_repository))
from shared.launcher import ROOT, main

if __name__ == "__main__":
    main()
