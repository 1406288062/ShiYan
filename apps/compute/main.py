#!/usr/bin/env python3
"""Run the fixed-operation Mac GPU worker with its private configuration."""
from pathlib import Path
import sys

_repository = Path(__file__).resolve().parents[2]
if str(_repository) not in sys.path:
    sys.path.insert(0, str(_repository))
from shared.compute.worker import main

if __name__ == "__main__":
    raise SystemExit(main())
