#!/usr/bin/env python3
"""Desktop entry; all server and page behavior is shared."""
from pathlib import Path
import sys

_repository = Path(__file__).resolve().parents[2]
if str(_repository) not in sys.path:
    sys.path.insert(0, str(_repository))
from shared.launcher import main

if __name__ == "__main__":
    main(default_profile="desktop")
