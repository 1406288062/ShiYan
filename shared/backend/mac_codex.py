"""Compatibility import for the existing Mac implementation."""
import sys
from apps.desktop.adapters import mac_codex as _implementation

sys.modules[__name__] = _implementation
