import asyncio
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import unittest

from apps.web.adapters.remote_workspace import RemoteFailure, SpongeTransport, _device, _projects


class FakeSocket:
    def __init__(self):
        self.folder = tempfile.TemporaryDirectory(dir="/private/tmp")
        self.path = str(Path(self.folder.name) / "connector.sock")
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            self.server.bind(self.path)
        except PermissionError:
            self.server.close()
            self.folder.cleanup()
            raise
        self.server.listen(8)
        self.stop = False
        self.thread = threading.Thread(target=self.serve, daemon=True)
        self.thread.start()
        self.calls = []

    def serve(self):
        while not self.stop:
            try:
                client, _ = self.server.accept()
            except OSError:
                return
            with client:
                raw = b""
                while b"\r\n\r\n" not in raw:
                    raw += client.recv(65536)
                head, body = raw.split(b"\r\n\r\n", 1)
                length = int(next(line.split(b":", 1)[1] for line in head.split(b"\r\n") if line.lower().startswith(b"content-length")))
                while len(body) < length:
                    body += client.recv(65536)
                request = json.loads(body[:length].decode())
                self.calls.append(request)
                params = request["params"]
                if params["name"] == "list_devices":
                    result = {"devices": [{"deviceId": "dev-1", "name": "测试设备", "online": True, "ready": True, "platform": "linux"}]}
                elif params["name"] == "run_device_tool":
                    result = {"ok": True, "result": {"ping": "pong"}}
                else:
                    result = {}
                mcp = {"content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}]}
                payload = json.dumps({"ok": True, "result": mcp}).encode()
                client.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: " + str(len(payload)).encode() + b"\r\nConnection: close\r\n\r\n" + payload)

    def close(self):
        self.stop = True
        self.server.close()
        self.folder.cleanup()


class Storage:
    def __init__(self, values=None): self.values = values or {}
    def setting(self, key, fallback=None): return self.values.get(key, fallback)
    def set_setting(self, key, value): self.values[key] = value


class Runtime:
    def __init__(self, owner, values=None):
        self.account = {"owner": owner}
        self.storage = Storage(values)


class RemoteTransportTests(unittest.TestCase):
    def test_socket_owner_devices_and_projects_are_account_scoped(self):
        try:
            fake = FakeSocket()
        except PermissionError:
            self.skipTest("当前受限测试环境不允许创建 Unix socket")
        old = os.environ.get("SHIYAN_SPONGE_SOCKET")
        os.environ["SHIYAN_SPONGE_SOCKET"] = fake.path
        try:
            async def exercise():
                transport = SpongeTransport("owner-a")
                devices = await transport.devices()
                self.assertEqual(devices[0]["deviceId"], "dev-1")
                self.assertEqual((await transport.tool("run_device_tool", {"deviceId": "dev-1"}))["ping"], "pong")
            asyncio.run(exercise())
            self.assertEqual(fake.calls[0]["owner"], "owner-a")
            a = Runtime("owner-a", {"webRemoteProjects": [{"id": "web-device-a", "name": "A", "path": "/x", "deviceId": "dev-1"}]})
            b = Runtime("owner-b")
            self.assertEqual(_projects(a)[0]["name"], "A")
            self.assertEqual(_projects(b), [])
        finally:
            if old is None: os.environ.pop("SHIYAN_SPONGE_SOCKET", None)
            else: os.environ["SHIYAN_SPONGE_SOCKET"] = old
            fake.close()

    def test_nested_pending_process_trailer_reads_pid_without_repeating_start(self):
        class PendingSocket:
            def __init__(self):
                self.folder = tempfile.TemporaryDirectory(dir="/private/tmp")
                self.path = str(Path(self.folder.name) / "connector.sock")
                self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                try:
                    self.server.bind(self.path); self.server.listen(8)
                except BaseException:
                    self.server.close(); self.folder.cleanup(); raise
                self.calls = []
                self.polls = 0
                self.process_output = ""
                self.thread = threading.Thread(target=self.serve, daemon=True); self.thread.start()

            def reply(self, client, payload):
                nested = {"ok": True, "result": {"content": [{"type": "text", "text": json.dumps(payload)}]}}
                raw = json.dumps(nested).encode()
                client.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: " + str(len(raw)).encode() +
                               b"\r\nConnection: close\r\n\r\n" + raw)

            def serve(self):
                while True:
                    try: client, _ = self.server.accept()
                    except OSError: return
                    with client:
                        raw = b""
                        while b"\r\n\r\n" not in raw: raw += client.recv(65536)
                        head, body = raw.split(b"\r\n\r\n", 1)
                        length = int(next(line.split(b":", 1)[1] for line in head.split(b"\r\n")
                                         if line.lower().startswith(b"content-length")))
                        while len(body) < length: body += client.recv(65536)
                        request = json.loads(body[:length].decode()); self.calls.append(request)
                        params = request["params"]; name = params["name"]
                        if name == "run_device_tool":
                            tool = params["arguments"]["tool"]
                            if tool == "start_process":
                                completed = subprocess.run(params["arguments"]["arguments"]["command"], shell=True,
                                                           text=True, capture_output=True, timeout=30)
                                self.process_output = completed.stdout
                                self.reply(client, {"state": "sent", "call_id": "call-1"})
                            elif tool == "read_process_output":
                                self.reply(client, {"output": "noise\n" + self.process_output +
                                                    "\n✅ Process 123 finished with exit code 0"})
                        elif name == "get_tool_result":
                            self.polls += 1
                            self.reply(client, {"state": "completed", "call_id": "placeholder",
                                                "message": "still running" if self.polls == 1 else "Process started with PID 123\n"})

            def close(self):
                self.server.close(); self.folder.cleanup()

        helper_folder = tempfile.TemporaryDirectory(dir="/private/tmp")
        helper_root = Path(helper_folder.name); (helper_root / "x.txt").write_text("hello\n")
        try:
            fake = PendingSocket()
        except PermissionError:
            helper_folder.cleanup()
            self.skipTest("当前受限测试环境不允许创建 Unix socket")
        old = os.environ.get("SHIYAN_SPONGE_SOCKET"); os.environ["SHIYAN_SPONGE_SOCKET"] = fake.path
        try:
            async def exercise():
                transport = SpongeTransport("account:123")
                return await transport.run("dev-1", {"action": "read", "root": str(helper_root), "path": "x.txt"}, timeout=3)
            result = asyncio.run(exercise())
            self.assertEqual(result["kind"], "text")
            self.assertEqual(result["text"], "hello\n")
            names = [call["params"]["name"] for call in fake.calls]
            self.assertEqual(names, ["run_device_tool", "get_tool_result", "get_tool_result", "run_device_tool"])
            self.assertEqual(fake.calls[-1]["params"]["arguments"]["tool"], "read_process_output")
        finally:
            if old is None: os.environ.pop("SHIYAN_SPONGE_SOCKET", None)
            else: os.environ["SHIYAN_SPONGE_SOCKET"] = old
            fake.close()
            helper_folder.cleanup()

    def test_device_missing_offline_and_revoked_are_rejected(self):
        class Transport:
            async def devices(self):
                return [{"deviceId": "offline", "online": False, "ready": False},
                        {"deviceId": "revoked", "online": True, "ready": True, "revokedAt": "now"}]
        async def exercise():
            with self.assertRaises(Exception): await _device(Transport(), "missing")
            with self.assertRaises(Exception): await _device(Transport(), "offline")
            with self.assertRaises(Exception): await _device(Transport(), "revoked")
        asyncio.run(exercise())


if __name__ == "__main__":
    unittest.main()
