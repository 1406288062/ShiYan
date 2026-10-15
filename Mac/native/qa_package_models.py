#!/usr/bin/env python3
 
import argparse
import gc
import hashlib
import json
from pathlib import Path
import sys
import time

parser = argparse.ArgumentParser()
parser.add_argument("--app", type=Path, required=True)
parser.add_argument("--fixture", type=Path, required=True)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
app = args.app.resolve()
resource = app / "Contents" / "Resources" / "app"
assert Path(sys.executable).resolve().is_relative_to(app), sys.executable
assert Path(sys.prefix).resolve().is_relative_to(app), sys.prefix
assert sys.flags.isolated == 1, "Run with the bundled Python -I"
sys.path.insert(0, str(resource))
import cv2
import numpy as np
import torch
from src import engine
for module in (cv2, np, torch, engine):
    assert Path(module.__file__).resolve().is_relative_to(app), module.__file__
assert engine.MODEL_DIR.resolve().is_relative_to(app)
args.output.mkdir(parents=True, exist_ok=True)
def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()
source = cv2.imread(str(args.fixture), cv2.IMREAD_COLOR)
assert source is not None and source.shape[:2] == (48, 64)
torch.set_num_threads(2)
report = {
    "app": str(app), "isolated": bool(sys.flags.isolated),
    "python": sys.executable, "prefix": sys.prefix,
    "torch": torch.__file__, "opencv": cv2.__file__, "numpy": np.__file__,
    "engine": engine.__file__, "modelDirectory": str(engine.MODEL_DIR),
    "fixture": str(args.fixture), "fixtureSHA256": digest(args.fixture),
    "inputSize": [64, 48], "checks": [],
    "startedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z")
}
try:
    for label, model_name in (("general", "x4plus"), ("anime", "x4plus_anime")):
        model = engine.MODEL_DIR / engine.ImageEnhancer.MODEL_URLS[model_name][0].split("/")[-1]
        assert model.is_file() and model.resolve().is_relative_to(app), str(model)
        started = time.monotonic()
        enhancer = engine.ImageEnhancer(model_name=model_name, scale=4, tile_size=400)
        output = enhancer.enhance(source)
        assert output.shape == (192, 256, 3), output.shape
        assert output.dtype == np.uint8 and float(output.std()) > 0
        target = args.output / (label + "-4x.png")
        assert cv2.imwrite(str(target), output)
        assert np.array_equal(cv2.imread(str(target)), output)
        row = {
            "mode": label, "model": str(model), "modelSHA256": digest(model),
            "device": str(enhancer._device), "output": str(target),
            "outputSize": [int(output.shape[1]), int(output.shape[0])],
            "outputSHA256": digest(target), "elapsedSeconds": round(time.monotonic() - started, 3),
            "passed": True
        }
        report["checks"].append(row)
        print(json.dumps(row, ensure_ascii=False), flush=True)
        del enhancer, output
        gc.collect()
        if torch.backends.mps.is_available():
            torch.mps.empty_cache()
    report["passed"] = len(report["checks"]) == 2
except Exception as error:
    report["passed"] = False
    report["error"] = str(error)
finally:
    report["finishedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    destination = args.output / "result.json"
    destination.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"result": str(destination), "passed": report["passed"]}, ensure_ascii=False), flush=True)
if not report["passed"]:
    raise SystemExit(1)
