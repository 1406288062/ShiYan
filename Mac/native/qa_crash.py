#!/usr/bin/env python3
 
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "dist" / "拾燕.app"
DATA = ROOT / "native" / "build" / ("qa-crash-" + time.strftime("%Y%m%d-%H%M%S"))
DATA.mkdir(parents=True)
env = {key: value for key, value in os.environ.items()
       if key in {"HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL"}}
env["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin"
env["SHIYAN_DATA_DIR"] = str(DATA)
report = {"dataDirectory": str(DATA), "passed": False}


def exists(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


with (DATA / "native-launch.log").open("w") as log:
    app = subprocess.Popen([str(APP / "Contents" / "MacOS" / "ShiYan"), "--self-test-crash"],
                           cwd=APP.parent, env=env, stdout=log, stderr=subprocess.STDOUT)
    ready = None
    try:
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline and app.poll() is None:
            files = list((DATA / "runtime").glob("ready-*.json"))
            if files:
                try:
                    ready = json.loads(files[0].read_text())
                    break
                except (OSError, json.JSONDecodeError):
                    pass
            time.sleep(0.1)
        if not ready:
            raise RuntimeError("Native crash test backend did not become ready")
        backend_pid = ready["pid"]
        report.update({"appPID": app.pid, "backendPID": backend_pid, "backendPort": ready["port"]})
        if os.getpgid(backend_pid) != backend_pid:
            raise RuntimeError("Backend did not own the expected isolated process group")
        started = time.monotonic()
        app.kill()
        app.wait(timeout=5)
        while exists(backend_pid) and time.monotonic() - started < 8:
            time.sleep(0.1)
        report["backendGone"] = not exists(backend_pid)
        try:
            os.killpg(backend_pid, 0)
            report["processGroupGone"] = False
        except ProcessLookupError:
            report["processGroupGone"] = True
        with socket.socket() as client:
            client.settimeout(0.5)
            report["portClosed"] = client.connect_ex(("127.0.0.1", ready["port"])) != 0
        report["cleanupSeconds"] = round(time.monotonic() - started, 2)
        report["readyFileCleaned"] = not list((DATA / "runtime").glob("ready-*.json"))
        report["passed"] = all(report[key] for key in ["backendGone", "processGroupGone", "portClosed", "readyFileCleaned"])
    except Exception as error:
        report["error"] = str(error)
    finally:
        if app.poll() is None:
            app.terminate()
            app.wait(timeout=8)
        if ready and exists(ready["pid"]) and os.getpgid(ready["pid"]) == ready["pid"]:
            os.killpg(ready["pid"], signal.SIGTERM)

(DATA / "result.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"resultFile": str(DATA / "result.json"), **report}, ensure_ascii=False), flush=True)
