"""Opt-in development reload for the standalone web entry."""
from __future__ import annotations

import json
import os
from pathlib import Path

OPTIONS_ENV = "SHIYAN_WEB_RELOAD_OPTIONS"


def create_app():
    """Uvicorn imports a fresh factory after each source change."""
    from shared import launcher
    from apps.web.adapters.workspace import install

    options = json.loads(os.environ[OPTIONS_ENV])
    repository = Path(__file__).resolve().parents[3]
    directory = Path(options["directory"]).expanduser().resolve()
    legacy = None
    if options.get("legacy"):
        from desktop_backend.legacy import LegacyHost
        legacy = LegacyHost(launcher.ROOT, directory)
    app = launcher.create_app(directory, launcher.ROOT, legacy, profile="web")
    install(app, repository)
    return app


def run_reload(repository, arguments):
    if "--reload" not in arguments:
        return False
    from apps.web.adapters.local_restart import _options, prepare_restart
    options = _options(arguments)
    if options is None:
        raise SystemExit("--reload 仅支持有效的 web 模式启动参数，请检查命令")
    if options.ready_file:
        raise SystemExit("--reload 开发模式不支持 --ready-file")
    import uvicorn
    prepare_restart(Path(repository) / "apps/web/main.py", arguments)

    previous = os.environ.get(OPTIONS_ENV)
    os.environ[OPTIONS_ENV] = json.dumps({
        "directory": str(Path(options.data_dir).expanduser().resolve()),
        "legacy": options.legacy,
    })
    print("开发自动重载已开启；保存 Python 后端代码后自动重启，按 Control+C 停止。", flush=True)
    try:
        uvicorn.run(
            "apps.web.adapters.development:create_app",
            factory=True, host="127.0.0.1", port=options.port,
            reload=True, reload_dirs=[str(Path(repository) / "shared"), str(Path(repository) / "apps/web")],
            log_level="info", access_log=False, timeout_graceful_shutdown=3,
        )
    finally:
        if previous is None:
            os.environ.pop(OPTIONS_ENV, None)
        else:
            os.environ[OPTIONS_ENV] = previous
    return True
