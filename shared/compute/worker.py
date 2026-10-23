"""Serial fixed-operation Mac GPU worker; it has no command execution API."""
from __future__ import annotations

import argparse
import fcntl
import http.client
import ipaddress
import json
import math
import os
from pathlib import Path
import queue
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import quote, urlsplit

from shared.compute.client import MacComputeError, private_config
from shared.paths import APP_ROOT, REPOSITORY_ROOT


class WorkerHTTP:
    def __init__(self, config):
        value = urlsplit(str(config.get("url", "")))
        if (value.scheme != "https" or not value.hostname or value.username or value.password
                or value.query or value.fragment):
            raise MacComputeError("Mac worker requires HTTPS", code="configuration")
        self.host, self.port, self.prefix = value.hostname, value.port or 443, value.path.rstrip("/")
        self.connect_ip = str(config.get("connect_ip") or "")
        if self.connect_ip:
            try:
                ipaddress.ip_address(self.connect_ip)
            except ValueError as exc:
                raise MacComputeError("Invalid fixed broker address", code="configuration") from exc
        self.token = str(config.get("token") or "")
        if not self.token or "\n" in self.token or "\r" in self.token:
            raise MacComputeError("Mac worker credentials unavailable", code="configuration")

    def request(self, method, route, lease=None, payload=None, source=None, destination=None):
        headers = {"Authorization": "Bearer " + self.token}
        if lease:
            headers["X-Task-Lease"] = lease
        body = None
        opened = None
        connection = http.client.HTTPSConnection(self.host, self.port, timeout=30)
        if self.connect_ip:
            # Connect to the configured literal IP, while HTTPSConnection keeps
            # the real host for TLS SNI and normal certificate verification.
            def connect_fixed(address, timeout, source_address=None, **kwargs):
                return socket.create_connection((self.connect_ip, address[1]), timeout, source_address)
            connection._create_connection = connect_fixed
        try:
            if source:
                opened = Path(source).open("rb")
                body = opened
                headers.update({"Content-Type": "image/jpeg", "Content-Length": str(os.fstat(opened.fileno()).st_size)})
            elif payload is not None:
                body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
                headers["Content-Type"] = "application/json"
            connection.request(method, self.prefix + route, body=body, headers=headers)
            response = connection.getresponse()
            if response.status >= 400:
                response.read(8192)
                raise MacComputeError("Mac task request refused", response.status, "worker_request_failed")
            if destination:
                size = 0
                with Path(destination).open("wb") as output:
                    while data := response.read(256 * 1024):
                        size += len(data)
                        if size > 40 * 1024 * 1024:
                            raise MacComputeError("Mac task image too large", code="input_too_large")
                        output.write(data)
                return None
            data = response.read(4 * 1024 * 1024 + 1)
            if len(data) > 4 * 1024 * 1024:
                raise MacComputeError("Mac task response too large", code="invalid_response")
            return json.loads(data)
        except MacComputeError:
            raise
        except (OSError, ValueError, http.client.HTTPException) as exc:
            raise MacComputeError("Mac task connection unavailable", code="unavailable") from exc
        finally:
            if opened:
                opened.close()
            connection.close()


def require_mps():
    import torch
    if not torch.backends.mps.is_available():
        raise RuntimeError("Apple GPU MPS is unavailable")
    return torch


def image_engine(input_path, output_path, model):
    # Reuse the existing model, image normalization, tiling and JPEG quality.
    # Guard device selection inside this inference process, not only its parent.
    torch = require_mps()
    from src.engine import ImageEnhancer, MODEL_DIR
    name = "x4plus_anime" if model == "anime" else "x4plus"
    model_path = MODEL_DIR / ImageEnhancer.MODEL_URLS[name][0].split("/")[-1]
    if not model_path.is_file():
        raise RuntimeError("Configured enhancement model is unavailable")
    def select_device(self):
        require_mps()
        return torch.device("mps")
    def deny_download(self, path):
        raise RuntimeError("Worker model downloads are disabled")
    ImageEnhancer._select_device = select_device
    ImageEnhancer._download_model = deny_download
    from desktop_backend.worker import main
    sys.argv = ["image-worker", "--input", input_path, "--output", output_path, "--model", model]
    main()


class TaskRunner:
    def __init__(self, http, task, config):
        self.http, self.task, self.config = http, task, config
        self.route = "/v1/worker/tasks/" + quote(str(task["id"]), safe="")
        self.lease = task["lease_token"]
        self.progress = {"progress": 0, "label": "Mac 正在准备", "details": {"device": "mps"}}
        self.lock = threading.Lock()
        self.done = threading.Event()
        self.lost = threading.Event()
        self.process = None
        self.last_renewal = time.monotonic()

    def heartbeat(self):
        while not self.done.is_set():
            try:
                with self.lock:
                    payload = dict(self.progress)
                self.http.request("POST", self.route + "/progress", self.lease, payload=payload)
                self.last_renewal = time.monotonic()
            except MacComputeError as exc:
                if exc.status in {401, 403, 404, 409, 410} or time.monotonic() - self.last_renewal > 100:
                    self.lost.set()
                    self.stop_process()
                    return
            if self.done.wait(10):
                return

    def update(self, progress, label, **details):
        with self.lock:
            self.progress = {"progress": min(0.99, max(0, float(progress))), "label": label,
                             "details": {"device": "mps", **details}}

    def stop_process(self):
        process = self.process
        if process and process.poll() is None:
            process.terminate()

    def run_process(self, command, request=None):
        environment = dict(os.environ, PYTORCH_ENABLE_MPS_FALLBACK="0", PYTHONUNBUFFERED="1")
        environment["PYTHONPATH"] = os.pathsep.join((str(REPOSITORY_ROOT), str(APP_ROOT)))
        if self.lost.is_set():
            raise RuntimeError("Task lease lost")
        self.process = subprocess.Popen(command, cwd=APP_ROOT, env=environment,
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                        text=True, encoding="utf-8")
        if request is not None:
            self.process.stdin.write(json.dumps(request, ensure_ascii=False))
        self.process.stdin.close()
        # Drain stderr without retaining/logging model text, paths or credentials.
        def discard_stderr():
            for _ in self.process.stderr:
                pass
        drain = threading.Thread(target=discard_stderr, daemon=True)
        drain.start()
        result = None
        started = time.monotonic()
        lines = queue.Queue()
        def read_lines():
            for line in self.process.stdout:
                if len(line) <= 4 * 1024 * 1024:
                    lines.put(line)
            lines.put(None)
        threading.Thread(target=read_lines, daemon=True).start()
        while True:
            if self.lost.is_set() or time.monotonic() - started > 1800:
                self.stop_process()
                raise RuntimeError("Task lease lost or inference timed out")
            try:
                line = lines.get(timeout=1)
            except queue.Empty:
                continue
            if line is None:
                break
            try:
                event = json.loads(line)
            except (ValueError, UnicodeError):
                continue
            if event.get("event") == "progress":
                if event.get("device") not in {None, "mps"}:
                    self.stop_process()
                    raise RuntimeError("GPU inference required")
                self.update(event.get("progress", 0), str(event.get("label") or "Mac 正在增强"),
                            **{key: event[key] for key in ("inputWidth", "inputHeight", "peakRssBytes") if key in event})
            elif event.get("type") == "progress":
                self.update(event.get("done", 0) / max(1, event.get("total", 1)), "Mac 正在计算向量")
            elif event.get("type") == "result":
                result = event
        if self.process.wait(timeout=10) != 0 or self.lost.is_set():
            raise RuntimeError("Mac GPU inference failed")
        drain.join(timeout=2)
        return result

    def execute(self):
        heartbeat = threading.Thread(target=self.heartbeat, daemon=True)
        heartbeat.start()
        try:
            require_mps()
            params = self.task["params"]
            with tempfile.TemporaryDirectory(prefix="shiyan-compute-") as folder:
                os.chmod(folder, 0o700)
                directory = Path(folder)
                if self.task["kind"] == "enhance":
                    if params.get("model") not in {"anime", "general"}:
                        raise ValueError("Unsupported enhancement model")
                    source, output = directory / "input.img", directory / "result.jpg"
                    self.update(0, "Mac 正在接收图片")
                    self.http.request("GET", self.route + "/input", self.lease, destination=source)
                    from PIL import Image
                    with Image.open(source) as image:
                        if image.size != (params["width"], params["height"]) or max(image.size) > 3000:
                            raise ValueError("Invalid input dimensions")
                    self.run_process([sys.executable, "-m", "shared.compute.worker", "--engine-image",
                                      str(source), str(output), params["model"]])
                    if self.lost.is_set():
                        raise RuntimeError("Task lease lost")
                    with Image.open(output) as image:
                        if image.format != "JPEG" or image.size != (params["width"] * 4, params["height"] * 4):
                            raise ValueError("Invalid enhancement result")
                    self.update(0.99, "Mac 正在回传图片")
                    self.http.request("PUT", self.route + "/result", self.lease, source=output)
                elif self.task["kind"] == "embed":
                    texts = params.get("texts")
                    if (not isinstance(texts, list) or not 1 <= len(texts) <= 8
                            or any(not isinstance(x, str) or len(x) > 16384 for x in texts)
                            or sum(map(len, texts)) > 65536
                            or params.get("operation") not in {"document_embedding", "question_embedding"}):
                        raise ValueError("Invalid embedding request")
                    model_path = Path(str(self.config.get("embedding_model_path") or ""))
                    if not (model_path / "config.json").is_file():
                        raise ValueError("Configured embedding model unavailable")
                    script = APP_ROOT / "knowledge/backend/src/services/embedding_worker.py"
                    result = self.run_process([sys.executable, str(script)], {
                        "texts": texts, "model_path": str(model_path), "device": "mps", "batch_size": 4,
                        "max_length": 2048, "operation": params["operation"],
                        "query_instruction": params.get("instruction", ""),
                    })
                    vectors = (result or {}).get("embeddings")
                    if (not result or result.get("device") != "mps" or result.get("dimensions") != 1024
                            or not isinstance(vectors, list) or len(vectors) != len(texts)
                            or any(len(v) != 1024 or not any(v) or any(not math.isfinite(x) for x in v) for v in vectors)):
                        raise ValueError("Invalid embedding result")
                    if self.lost.is_set():
                        raise RuntimeError("Task lease lost")
                    self.http.request("PUT", self.route + "/result", self.lease,
                                      payload={"embeddings": vectors, "device": "mps", "dimensions": 1024})
                else:
                    raise ValueError("Unsupported task")
        except Exception:
            if not self.lost.is_set():
                try:
                    self.http.request("POST", self.route + "/fail", self.lease,
                                      payload={"error": "Mac GPU 计算未完成，请检查设备或模型后重试", "code": "GPU_FAILED"})
                except MacComputeError:
                    pass
            raise
        finally:
            self.done.set()
            self.stop_process()
            if self.process:
                try:
                    self.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait()
            heartbeat.join(timeout=35)


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default=os.environ.get("SHIYAN_MAC_WORKER_CONFIG"))
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--engine-image", nargs=3, metavar=("INPUT", "OUTPUT", "MODEL"), help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    os.umask(0o077)
    if args.engine_image:
        image_engine(*args.engine_image)
        return 0
    def stop_worker(signum, frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stop_worker)
    config = private_config(args.config or "")
    if not config.get("device_id"):
        raise RuntimeError("Mac compute device is not configured")
    http = WorkerHTTP(config)
    # A second launch must not claim another task on the same authorized Mac.
    lock_path = Path(args.config).with_suffix(".worker.lock")
    with lock_path.open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("Mac compute worker is already running")
        delay = 2
        while True:
            try:
                task = http.request("POST", "/v1/worker/claim", payload={}).get("task")
                delay = 2
                if task:
                    TaskRunner(http, task, config).execute()
            except (MacComputeError, RuntimeError, ValueError, OSError):
                # No task contents or credentials are emitted to service logs.
                print("Mac compute connection or GPU task unavailable; retrying", flush=True)
                if args.once:
                    return 1
                delay = min(30, delay * 2)
            if args.once:
                return 0
            time.sleep(delay)


if __name__ == "__main__":
    raise SystemExit(main())
