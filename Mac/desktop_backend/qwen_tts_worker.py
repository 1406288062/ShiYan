"""On-demand, local-only Qwen3-TTS worker used by the native Dots player.

The interview project's existing Python environment runs this module. JSONL on
stdin accepts warmup, speak, cancel and shutdown. stdout contains only JSONL;
audio frames are bounded mono little-endian PCM16 chunks. No server is started.
"""
from __future__ import annotations

import base64
import contextlib
import json
import os
from pathlib import Path
import re
import resource
import time
import sys
import threading

MODEL_ID = "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-6bit"
INSTRUCTION = "自然、温和、清晰的中文对话语气，像面对面交流。语速适中，按句意自然停顿，重点稍作强调，不要播音腔，不要夸张表演。"
_OUTPUT = sys.stdout
_OUTPUT_LOCK = threading.Lock()


def emit(kind: str, **values) -> None:
    with _OUTPUT_LOCK:
        _OUTPUT.write(json.dumps({"type": kind, **values}, ensure_ascii=False) + "\n")
        _OUTPUT.flush()


def local_model_path() -> Path:
    """Resolve the existing weights, never fetch or install anything."""
    project = os.environ.get("SHIYAN_INTERVIEW_PROJECT")
    if project:
        config = Path(project) / "server/.env"
        allowed = {"MLX_TTS_MODEL", "MLX_TTS_LOCAL_PATH", "HF_HOME", "HUGGINGFACE_HUB_CACHE"}
        if config.is_file():
            for line in config.read_text().splitlines():
                key, separator, value = line.strip().removeprefix("export ").partition("=")
                if separator and key.strip() in allowed:
                    os.environ.setdefault(key.strip(), value.strip().strip("\"'"))
    explicit = os.environ.get("SHIYAN_TTS_MODEL_PATH") or os.environ.get("MLX_TTS_LOCAL_PATH")
    if explicit:
        candidate = Path(explicit).expanduser()
        if not (candidate / "config.json").is_file():
            raise RuntimeError("本地 Qwen3-TTS 模型目录不可用。")
        return candidate.resolve()
    model = os.environ.get("MLX_TTS_MODEL", MODEL_ID)
    direct = Path(model).expanduser()
    if (direct / "config.json").is_file():
        return direct.resolve()
    cache = Path(os.environ.get("HUGGINGFACE_HUB_CACHE") or
                 str(Path(os.environ.get("HF_HOME", str(Path.home() / ".cache/huggingface"))) / "hub"))
    root = cache / ("models--" + model.replace("/", "--"))
    reference = root / "refs/main"
    if reference.is_file():
        candidate = root / "snapshots" / reference.read_text().strip()
        if (candidate / "config.json").is_file():
            return candidate.resolve()
    candidates = sorted((root / "snapshots").glob("*/config.json"),
                        key=lambda path: path.stat().st_mtime, reverse=True)
    if candidates:
        return candidates[0].parent.resolve()
    raise RuntimeError("未找到面试项目已有的本地 Qwen3-TTS 模型，请检查模型目录。")


def speech_segments(text: str):
    # Keep punctuation as prosody cues. Bound each generation's context and
    # cancellation tail without splitting a normal Chinese sentence midway.
    text = re.sub(r"```[\s\S]*?```", "（代码内容请查看屏幕。）", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"[*#`]+", "", text).strip()
    pending = ""
    for part in re.split(r"(?<=[。！？!?；;\n])", text):
        if not part.strip():
            continue
        if pending and len(pending) + len(part) > 160:
            yield pending.strip()
            pending = ""
        while len(part) > 240:
            boundary = max(part.rfind(char, 80, 220) for char in "，,、：: ")
            boundary = boundary + 1 if boundary >= 80 else 200
            if pending:
                yield pending.strip()
                pending = ""
            yield part[:boundary].strip()
            part = part[boundary:]
        pending += part
        if len(pending) >= 80:
            yield pending.strip()
            pending = ""
    if pending.strip():
        yield pending.strip()


class Worker:
    def __init__(self):
        self.condition = threading.Condition()
        self.pending: dict | None = None
        self.active: dict | None = None
        self.cancelled = threading.Event()
        self.stopping = False
        self.model = None
        self.outstanding = 0

    def receive(self):
        try:
            while line := sys.stdin.readline(200_001):
                if len(line) > 200_000:
                    raise ValueError("语音请求过长")
                message = json.loads(line)
                action = message.get("action")
                with self.condition:
                    if action == "shutdown":
                        self.stopping = True
                        self.cancelled.set()
                    elif action == "cancel":
                        request_id = message.get("id")
                        if self.active and (not request_id or self.active.get("id") == request_id):
                            self.cancelled.set()
                        if self.pending and (not request_id or self.pending.get("id") == request_id):
                            self.pending = None
                    elif action == "consumed":
                        if self.active and self.active.get("id") == message.get("id"):
                            self.outstanding = max(0, self.outstanding - 1)
                    elif action in {"speak", "warmup"}:
                        if action == "speak":
                            text = message.get("text")
                            if not isinstance(text, str) or not text.strip() or len(text) > 20_000:
                                emit("error", id=message.get("id"), message="语音文本为空或过长。")
                                continue
                            self.cancelled.set()
                        if action == "speak" or not self.pending:
                            self.pending = message
                    self.condition.notify()
                    if self.stopping:
                        return
        except (ValueError, OSError):
            pass
        finally:
            with self.condition:
                self.stopping = True
                self.cancelled.set()
                self.condition.notify()

    def load(self):
        if self.model is None:
            # Offline flags must be set before transformers/HF are imported.
            os.environ["HF_HUB_OFFLINE"] = "1"
            os.environ["TRANSFORMERS_OFFLINE"] = "1"
            os.environ["TOKENIZERS_PARALLELISM"] = "false"
            from mlx_audio.tts.utils import load_model
            self.model = load_model(str(local_model_path()))
        return self.model

    def run(self):
        threading.Thread(target=self.receive, name="qwen-input", daemon=True).start()
        while True:
            with self.condition:
                self.condition.wait_for(lambda: self.pending is not None or self.stopping)
                if self.stopping:
                    break
                request = self.pending
                self.pending = None
                self.active = request
                self.cancelled.clear()
                self.outstanding = 0
            identifier = request.get("id")
            started = time.monotonic()
            try:
                # Third-party diagnostic prints must never corrupt the protocol.
                with contextlib.redirect_stdout(sys.stderr):
                    model = self.load()
                    if request["action"] == "warmup":
                        # Warm the tokenizer and Metal kernels too. These frames
                        # are discarded, never emitted or played. An arriving
                        # user request interrupts at the next short chunk.
                        if not self.cancelled.is_set():
                            warmup = model.generate_custom_voice(
                                text="你好。", speaker="Serena", language="Chinese",
                                instruct=INSTRUCTION, stream=True, streaming_interval=0.48,
                                temperature=0.75, max_tokens=48, verbose=False)
                            try:
                                for index, _ in enumerate(warmup):
                                    if self.cancelled.is_set() or index >= 1:
                                        break
                            finally:
                                warmup.close()
                        emit("ready", model=MODEL_ID, voice="Serena",
                             elapsed=round(time.monotonic() - started, 3))
                        continue
                    import numpy as np
                    count = 0
                    audio_seconds = 0.0
                    for segment in speech_segments(request["text"]):
                        if self.cancelled.is_set():
                            break
                        generator = model.generate_custom_voice(
                            text=segment, speaker="Serena", language="Chinese",
                            instruct=INSTRUCTION, stream=True, streaming_interval=0.48,
                            temperature=0.75, max_tokens=max(160, min(1600, len(segment) * 12)),
                            verbose=False,
                        )
                        try:
                            for result in generator:
                                if self.cancelled.is_set():
                                    break
                                raw = np.asarray(result.audio, dtype=np.float32).reshape(-1)
                                raw = np.nan_to_num(raw, nan=0.0, posinf=1.0, neginf=-1.0)
                                # Retain natural dynamics across streaming chunks.
                                pcm = (np.clip(raw, -1.0, 1.0) * 32767).astype("<i2")
                                rate = int(getattr(result, "sample_rate", 24000))
                                # Defensive cap even if an upstream decoder yields
                                # a whole sentence instead of the requested chunk.
                                for offset in range(0, pcm.size, rate):
                                    if self.cancelled.is_set():
                                        break
                                    chunk = pcm[offset:offset + rate]
                                    if chunk.size:
                                        # A bounded playback window avoids building
                                        # up an entire long response in RAM.
                                        with self.condition:
                                            self.condition.wait_for(lambda: self.outstanding < 12 or self.cancelled.is_set())
                                            if self.cancelled.is_set():
                                                break
                                            self.outstanding += 1
                                        emit("audio", id=identifier, sampleRate=rate,
                                             pcm=base64.b64encode(chunk.tobytes()).decode("ascii"))
                                        count += 1
                                        audio_seconds += chunk.size / rate
                        finally:
                            generator.close()
                    if self.cancelled.is_set():
                        emit("cancelled", id=identifier)
                    elif count:
                        emit("done", id=identifier, audioSeconds=round(audio_seconds, 3),
                             elapsed=round(time.monotonic() - started, 3),
                             peakMemoryBytes=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
                    else:
                        raise RuntimeError("Qwen3-TTS 没有生成有效音频。")
            except Exception as error:
                if not self.cancelled.is_set():
                    emit("error", id=identifier, message="本地 Qwen3-TTS 生成失败：" + str(error)[:240])
            finally:
                with self.condition:
                    self.active = None


if __name__ == "__main__":
    Worker().run()
