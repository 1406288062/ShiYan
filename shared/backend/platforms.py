"""Shared configuration and platform context, without product feature policy."""
from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path

MODES = {"desktop", "web"}


def merge_config(shared, override):
    """Merge nested objects; a platform may explicitly replace other values."""
    result = deepcopy(shared)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = merge_config(result[key], value)
        else:
            result[key] = deepcopy(value)
    return result


class PlatformProfile:
    def __init__(self, mode, root):
        if mode not in MODES:
            raise ValueError("运行模式必须为 desktop 或 web")
        self.mode = mode
        path = Path(root) / "platforms.json"
        settings = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        if not isinstance(settings, dict) or any(
            not isinstance(settings.get(key, {}), dict) for key in ("shared", "desktop", "web")
        ):
            raise ValueError("平台配置的 shared、desktop、web 必须为对象")
        self.config = merge_config(settings.get("shared", {}), settings.get(mode, {}))

    def public(self):
        # These values are sent to the frontend; keep credentials out of this file.
        return {"mode": self.mode, "config": deepcopy(self.config)}


def resolve_profile(profile, root):
    return profile if isinstance(profile, PlatformProfile) else PlatformProfile(profile or "desktop", root)
