#!/usr/bin/env python3
 
import argparse
import hashlib
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import time

parser = argparse.ArgumentParser()
parser.add_argument("--app", type=Path, required=True)
parser.add_argument("--fixture", type=Path, required=True)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
app = args.app.resolve()
resource = app / "Contents/Resources/app"
fixture = args.fixture.resolve()
output_directory = args.output.resolve()
output_directory.mkdir(parents=True, exist_ok=True)
output = output_directory / "result.png"
assert sys.flags.isolated == 1
assert Path(sys.executable).resolve().is_relative_to(app)
bootstrap = '''import json, pathlib, runpy, sys
root = pathlib.Path(sys.argv.pop(1))
sys.path.insert(0, str(root))
try:
    runpy.run_module("desktop_backend.worker", run_name="__main__", alter_sys=True)
except SystemExit as error:
    if error.code not in (0, None): raise
engine = sys.modules["src.engine"]
trace = {"python":sys.executable,"prefix":sys.prefix,"isolated":bool(sys.flags.isolated),
         "worker":str(root/"desktop_backend/worker.py"),"engine":engine.__file__,
         "torch":sys.modules["torch"].__file__,
         "model":str(engine.MODEL_DIR/engine.ImageEnhancer.MODEL_URLS["x4plus_anime"][0].split("/")[-1])}
print("PACKAGE_TRACE:"+json.dumps(trace,ensure_ascii=False),flush=True)
'''
env = {key: value for key, value in os.environ.items() if key in {"HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL"}}
env.update({"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "PYTHONDONTWRITEBYTECODE": "1"})
started = time.monotonic()
process = subprocess.run([sys.executable, "-B", "-I", "-c", bootstrap, str(resource),
                          "--input", str(fixture), "--output", str(output), "--model", "anime"],
                         cwd=resource, env=env, capture_output=True, text=True, timeout=90)
(output_directory / "worker.log").write_text(process.stdout + process.stderr)
events = []
trace = None
for line in process.stdout.splitlines():
    if line.startswith("PACKAGE_TRACE:"):
        trace = json.loads(line.removeprefix("PACKAGE_TRACE:"))
    elif line.startswith("{"):
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            pass
report = {"app":str(app),"fixture":str(fixture),"output":str(output),
          "exitCode":process.returncode,"runtime":trace,"events":events,
          "elapsedSeconds":round(time.monotonic()-started,3),
          "testedAt":time.strftime("%Y-%m-%dT%H:%M:%S%z")}
try:
    assert process.returncode == 0, process.stderr
    assert trace and trace["isolated"] is True
    for key in ("python", "prefix", "worker", "engine", "torch", "model"):
        assert Path(trace[key]).resolve().is_relative_to(app), (key, trace[key])
    encoded = output.read_bytes()
    assert encoded[:8] == b"\x89PNG\r\n\x1a\n"
    size = list(struct.unpack(">II", encoded[16:24]))
    assert size == [256, 192], size
    final = next(event for event in reversed(events) if event.get("progress") == 1)
    assert final["inputWidth"] == 64 and final["inputHeight"] == 48
    device = next(event["device"] for event in events if "device" in event)
    assert device == "mps", device
    assert not Path(str(output) + ".pixels").exists()
    report.update({"outputSize":size,"outputSHA256":hashlib.sha256(encoded).hexdigest(),
                   "engineSHA256":hashlib.sha256(Path(trace["engine"]).read_bytes()).hexdigest(),
                   "workerSHA256":hashlib.sha256(Path(trace["worker"]).read_bytes()).hexdigest(),
                   "device":device,"memmapCleaned":True,"passed":True})
except Exception as error:
    report.update({"passed":False,"error":str(error)})
(output_directory / "result.json").write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n")
print(json.dumps({"report":str(output_directory/"result.json"),"passed":report["passed"],"error":report.get("error")},ensure_ascii=False))
if not report["passed"]:
    raise SystemExit(1)
