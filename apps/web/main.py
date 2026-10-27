#!/usr/bin/env python3
"""Web-only launcher: extend shared application without editing desktop code."""
from pathlib import Path
import sys

_repository = Path(__file__).resolve().parents[2]
if str(_repository) not in sys.path:
    sys.path.insert(0, str(_repository))

from shared import launcher
from apps.web.adapters.workspace import install
from apps.web.adapters.local_restart import prepare_restart
from apps.web.adapters.development import run_reload

if __name__ == "__main__":
    if run_reload(_repository, sys.argv[1:]):
        raise SystemExit(0)
    prepare_restart(Path(__file__))
    original_create_app = launcher.create_app

    def web_create_app(*args, **kwargs):
        app = original_create_app(*args, **kwargs)
        if app.state.platform.mode == "web":
            install(app, _repository)
        return app

    launcher.create_app = web_create_app
    try:
        launcher.main(default_profile="web")
    finally:
        launcher.create_app = original_create_app
