"""Restart only this Mac project's matching localhost web process."""
from __future__ import annotations

import argparse
import ctypes
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time


def _options(arguments):
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--port", type=int, default=7860)
    parser.add_argument("--data-dir", default=str(Path.home() / "Library/Application Support/image_enhancer"))
    parser.add_argument("--profile", choices=("web", "desktop"), default="web")
    parser.add_argument("--ready-file")
    parser.add_argument("--reload", action="store_true")
    parser.add_argument("--legacy", action=argparse.BooleanOptionalAction, default=False)
    try:
        values, unknown = parser.parse_known_args(arguments)
    except SystemExit:
        return None
    if unknown or values.profile != "web" or not 0 <= values.port <= 65535:
        return None
    return values


def _listeners(port):
    result = subprocess.run(
        ["/usr/sbin/lsof", "-nP", "-t", "-iTCP:" + str(port), "-sTCP:LISTEN"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=5)
    if result.returncode not in (0, 1):
        raise RuntimeError("无法确认端口占用进程，未停止任何程序")
    return {int(value) for value in result.stdout.split() if value.isdigit()}


def _process_arguments(pid):
    # KERN_PROCARGS2 preserves real argument boundaries, including data-dir
    # paths containing spaces. Never parse a shell-formatted ps command line.
    libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
    mib = (ctypes.c_int * 3)(1, 49, pid)
    size = ctypes.c_size_t()
    if libc.sysctl(mib, 3, None, ctypes.byref(size), None, 0):
        raise OSError(ctypes.get_errno(), "无法读取进程参数")
    buffer = ctypes.create_string_buffer(size.value)
    if libc.sysctl(mib, 3, buffer, ctypes.byref(size), None, 0):
        raise OSError(ctypes.get_errno(), "无法读取进程参数")
    raw = buffer.raw[:size.value]
    argc = int.from_bytes(raw[:4], sys.byteorder)
    if not 1 <= argc <= 1024:
        raise ValueError("进程参数无效")
    offset = raw.index(b"\0", 4) + 1
    while offset < len(raw) and raw[offset] == 0:
        offset += 1
    return [os.fsdecode(value) for value in raw[offset:].split(b"\0", argc)[:argc]]


def _process_cwd(pid):
    result = subprocess.run(
        ["/usr/sbin/lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=5, check=True)
    return Path(next(line[1:] for line in result.stdout.splitlines() if line.startswith("n"))).resolve()


def _matching_process(pid, entry, options):
    try:
        uid = subprocess.check_output(
            ["/bin/ps", "-p", str(pid), "-o", "uid="], text=True, timeout=5).strip()
        if uid != str(os.getuid()) or pid == os.getpid():
            return False
        args = _process_arguments(pid)
        interpreters = {Path(sys.executable).resolve(),
                        (Path(sys.base_prefix) / "Resources/Python.app/Contents/MacOS/Python").resolve()}
        if Path(args[0]).resolve() not in interpreters:
            return False
        cwd = _process_cwd(pid)
        # Python options precede the script; reject -c/-m and unexpected entries.
        index = next(i for i, arg in enumerate(args[1:], 1) if not arg.startswith("-"))
        if any(value in {"-c", "-m"} for value in args[1:index]):
            return False
        script = (cwd / args[index]).resolve()
        if script != entry:
            return False
        old = _options(args[index + 1:])
        if old is None or old.port != options.port:
            return False
        old_data = (cwd / Path(old.data_dir).expanduser()).resolve()
        new_data = Path(options.data_dir).expanduser().resolve()
        return old_data == new_data
    except (OSError, ValueError, StopIteration, IndexError, subprocess.SubprocessError):
        return False


def _launcher_for_listener(pid, entry, options):
    """A reload worker shares its supervisor's socket; stop the supervisor."""
    if _matching_process(pid, entry, options):
        return pid
    for _ in range(4):
        try:
            parent = int(subprocess.check_output(
                ["/bin/ps", "-p", str(pid), "-o", "ppid="], text=True, timeout=5).strip())
            if parent <= 1 or parent == pid:
                return None
            pid = parent
            if _matching_process(pid, entry, options):
                return pid if "--reload" in _process_arguments(pid) else None
        except (OSError, ValueError, subprocess.SubprocessError):
            return None
    return None


def prepare_restart(entry, arguments=None):
    # Production Linux services and packaged desktop startup are unaffected.
    if sys.platform != "darwin":
        return
    options = _options(sys.argv[1:] if arguments is None else arguments)
    if options is None or options.port == 0:
        return
    try:
        with socket.socket() as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            probe.bind(("127.0.0.1", options.port))
        return
    except OSError:
        pass
    try:
        listeners = _listeners(options.port)
        pids = {_launcher_for_listener(pid, Path(entry).resolve(), options) for pid in listeners}
        if not pids or None in pids:
            raise RuntimeError(
                f"端口 {options.port} 被其他程序或不同数据目录的服务占用，未停止任何程序；请换一个 --port")
        # Re-check the identity immediately before signalling each process.
        for pid in pids:
            if not _matching_process(pid, Path(entry).resolve(), options):
                raise RuntimeError("端口进程已变化，已取消重启，请重试")
            os.kill(pid, signal.SIGINT)
        print(f"正在重启本地网页服务：127.0.0.1:{options.port}", flush=True)
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            with socket.socket() as probe:
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                try:
                    probe.bind(("127.0.0.1", options.port))
                    return
                except OSError:
                    pass
            time.sleep(0.15)
        raise RuntimeError("旧网页服务尚未退出，请稍后重试；未强制结束进程")
    except (OSError, ValueError, subprocess.SubprocessError, RuntimeError) as exc:
        raise SystemExit(str(exc)) from exc
