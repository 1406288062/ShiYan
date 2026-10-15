#!/usr/bin/env python3
 
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import time

PROJECT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument("--app", type=Path, default=PROJECT / "dist" / "拾燕.app")
parser.add_argument("--skip-relocation", action="store_true")
args = parser.parse_args()
APP = args.app.resolve()
QA = PROJECT / "native" / "build" / ("qa-native-" + time.strftime("%Y%m%d-%H%M%S"))
QA.mkdir(parents=True, exist_ok=True)


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def port_open(port):
    with socket.socket() as client:
        client.settimeout(0.5)
        return client.connect_ex(("127.0.0.1", port)) == 0


def runtime_check(app):
    framework = app / "Contents" / "Frameworks" / "Python.framework" / "Versions" / "3.14"
    python = framework / "bin" / "python3.14"
    env = {"HOME": str(Path.home()), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
           "PYTHONNOUSERSITE": "1", "PYTHONDONTWRITEBYTECODE": "1"}
    code = ("import json,sys,torch,cv2,numpy,ssl,sqlite3;"
            "print(json.dumps({'prefix':sys.prefix,'torch':torch.__file__,"
            "'opencv':cv2.__file__,'ssl':ssl.OPENSSL_VERSION,'sqlite':sqlite3.sqlite_version}))")
    result = subprocess.run([str(python), "-B", "-I", "-c", code], cwd=app,
                            env=env, capture_output=True, text=True, timeout=60, check=True)
    report = json.loads(result.stdout.strip().splitlines()[-1])
    assert str(app) in report["prefix"], report
    assert str(app) in report["torch"], report
    assert str(app) in report["opencv"], report
    report["passed"] = True
    return report


def run_native(app, label):
    data = QA / label
    data.mkdir(parents=True)
    env = {key: value for key, value in os.environ.items()
           if key in {"HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL"}}
    env.update({"PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
                "SHIYAN_DATA_DIR": str(data),
                "PYTHONHOME": "/nonexistent-shiyan-test",
                "PYTHONPATH": "/nonexistent-shiyan-test"})
    log = (data / "native-launch.log").open("w")
    process = subprocess.Popen([str(app / "Contents" / "MacOS" / "ShiYan"), "--self-test"],
                               cwd=app.parent, env=env, stdout=log, stderr=subprocess.STDOUT)
    ready = None
    report_path = data / "native-self-test.json"
    deadline = time.monotonic() + 80
    while time.monotonic() < deadline and process.poll() is None:
        paths = list((data / "runtime").glob("ready-*.json")) if (data / "runtime").exists() else []
        if paths:
            try:
                ready = json.loads(paths[0].read_text())
                break
            except (OSError, json.JSONDecodeError):
                pass
        time.sleep(0.1)
    duplicate_report = {"attempted": False}
    if ready:
        duplicate = subprocess.Popen([str(app / "Contents" / "MacOS" / "ShiYan"), "--self-test"],
                                     cwd=app.parent, env=env, stdout=log, stderr=subprocess.STDOUT)
        try:
            code = duplicate.wait(timeout=8)
            duplicate_report = {"attempted": True, "exitCode": code, "singleInstancePassed": code == 0,
                                "originalStillAlive": process.poll() is None}
        except subprocess.TimeoutExpired:
            duplicate.terminate()
            duplicate.wait(timeout=5)
            duplicate_report = {"attempted": True, "singleInstancePassed": False}
    try:
        code = process.wait(timeout=max(1, deadline - time.monotonic()))
    except subprocess.TimeoutExpired:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        raise RuntimeError("Native self-test timed out: " + str(data))
    finally:
        log.close()
    report = json.loads(report_path.read_text()) if report_path.exists() else {
        "error": "Native app did not write its self-test report",
        "log": str(data / "native-launch.log")}
    report["processExitCode"] = code
    report["duplicateLaunch"] = duplicate_report
    if ready:
        time.sleep(0.3)
        report["backendGoneAfterQuit"] = not alive(ready["pid"])
        report["portClosedAfterQuit"] = not port_open(ready["port"])
        report["readyFileCleaned"] = not list((data / "runtime").glob("ready-*.json"))
        try:
            os.killpg(ready["pid"], 0)
            report["backendProcessGroupGone"] = False
        except ProcessLookupError:
            report["backendProcessGroupGone"] = True
    images = report.get("page", {}).get("images", [])
    report["visibleImagesLoaded"] = bool(images) and all(image.get("loaded") is True for image in images)
    report["passed"] = (
        code == 0 and "error" not in report
        and report.get("windowClosePassed") is True
        and report.get("windowReopenPassed") is True
        and report.get("assetURLBoundaryPassed") is True
        and report.get("backendGoneAfterQuit") is True
        and report.get("portClosedAfterQuit") is True
        and report.get("backendProcessGroupGone") is True
        and report.get("page", {}).get("native") is True
        and report.get("visibleImagesLoaded") is True
        and not report.get("javascriptError")
        and duplicate_report.get("singleInstancePassed") is True
    )
    (data / "result.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"phase": label, "passed": report["passed"],
                      "error": report.get("error"), "backendGone": report.get("backendGoneAfterQuit"),
                      "portClosed": report.get("portClosedAfterQuit")}, ensure_ascii=False), flush=True)
    return report


result = {"startedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "originalApp": str(APP),
          "dataRoot": str(QA), "checks": {}}
relocated = QA / "relocated" / "拾燕.app"
try:
    result["checks"]["originalRuntime"] = runtime_check(APP)
    result["checks"]["originalNative"] = run_native(APP, "original")
    if not args.skip_relocation and result["checks"]["originalNative"]["passed"]:
        relocated.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["/bin/cp", "-cRp", str(APP), str(relocated)], check=True)
        result["relocationCopyStrategy"] = "APFS copy-on-write independent clone"
        result["checks"]["relocatedRuntime"] = runtime_check(relocated)
        result["checks"]["relocatedNative"] = run_native(relocated, "moved")
    result["passed"] = all(check.get("passed") for check in result["checks"].values()) and len(result["checks"]) == (2 if args.skip_relocation else 4)
except Exception as error:
    result["passed"] = False
    result["error"] = str(error)
finally:
    if relocated.exists():
        shutil.rmtree(relocated)
    result["relocatedCopyRemoved"] = not relocated.exists()
    result["finishedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    (QA / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"resultFile": str(QA / "result.json"), "passed": result["passed"],
                      "error": result.get("error")}, ensure_ascii=False), flush=True)
