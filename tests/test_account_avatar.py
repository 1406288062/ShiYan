"""Focused avatar bridge checks; no real accounts, network, or user files."""
import asyncio
import base64
import http.client
import importlib.util
import io
import json
from pathlib import Path
import sys
import socket
import threading
import types
import unittest
from unittest.mock import patch

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "shared" / "backend"
if not BACKEND.is_dir():
    BACKEND = ROOT / "desktop_backend"
package = types.ModuleType("_avatar_bridge_test")
package.__path__ = [str(BACKEND)]
sys.modules[package.__name__] = package

# The scratch runtime has Pillow but no FastAPI. Exercise the same bridge code
# using only the two framework boundary types there; use real FastAPI when
# running this file in the application's existing Python environment.
STUB_FRAMEWORK = importlib.util.find_spec("fastapi") is None
if STUB_FRAMEWORK:
    fastapi = types.ModuleType("fastapi")
    fastapi.Request = object
    responses = types.ModuleType("fastapi.responses")

    class StreamingResponse:
        def __init__(self, iterator, media_type=None, headers=None):
            self.body_iterator, self.media_type, self.headers = iterator, media_type, headers

    responses.StreamingResponse = StreamingResponse
    sys.modules["fastapi"] = fastapi
    sys.modules["fastapi.responses"] = responses

spec = importlib.util.spec_from_file_location("_avatar_bridge_test.account_avatar", BACKEND / "account_avatar.py")
avatar = importlib.util.module_from_spec(spec)
spec.loader.exec_module(avatar)
if STUB_FRAMEWORK:
    del sys.modules["fastapi.responses"]
    del sys.modules["fastapi"]


def encoded_image(color="red"):
    output = io.BytesIO()
    Image.new("RGB", (512, 320), color).save(output, "JPEG", quality=90)
    return base64.b64encode(output.getvalue()).decode()


def payload(revision=1, data=None):
    return {"ok": True, "avatar": {"data": data, "revision": revision,
                                     "mimeType": "image/jpeg", "updatedAt": 1234}}


class Manager:
    def __init__(self, runtime, device_user="a"):
        self.resources = types.SimpleNamespace(runtime=runtime)
        self.user = dict(runtime.account)
        self.generation = 1
        self.switch_lock = asyncio.Lock()
        self.device = {"id": "remembered-device", "userId": device_user, "avatar": None}
        self.writes = 0

    async def remembered_device(self):
        return dict(self.device)

    async def saved_session(self, action, value):
        assert action == "write"
        self.device = dict(value["device"])
        self.writes += 1


class Request:
    def __init__(self, runtime, manager, value=None, chunks=None):
        self.app = types.SimpleNamespace(state=types.SimpleNamespace(runtime=runtime, accounts=manager))
        self.chunks = chunks if chunks is not None else [json.dumps(value or {}).encode()]

    async def stream(self):
        for chunk in self.chunks:
            yield chunk


class Registry:
    def __init__(self):
        self.routes = {}

    def register(self, method, path):
        def decorate(fn):
            self.routes[method, path] = fn
            return fn
        return decorate

    def get(self, path): return self.register("GET", path)
    def put(self, path): return self.register("PUT", path)
    def delete(self, path): return self.register("DELETE", path)


class Response:
    def __init__(self, data=b"", status=200, content_type="text/event-stream", on_read=None):
        self.data, self.status = io.BytesIO(data), status
        self.content_type, self.closed, self.on_read = content_type, False, on_read

    def getheader(self, name, default=None):
        return self.content_type if name == "Content-Type" else default

    def readline(self, size):
        if self.on_read:
            self.on_read()
        return self.data.readline(size)

    def close(self):
        self.closed = True


class Connection:
    def __init__(self, response):
        self.response = response
        self.closed = False
        self.shutdowns = 0
        self.sock = self

    def request(self, method, path, headers):
        self.last_request = method, path, headers

    def getresponse(self): return self.response
    def shutdown(self, _): self.shutdowns += 1
    def close(self): self.closed = True


class Gateway:
    def __init__(self, response=None, result=None, owner="a"):
        self.response = response or Response()
        self.connection = Connection(self.response)
        self.open_connections = set()
        self.result = result or payload()
        self.calls = []
        self.owner = owner

    async def request_parts(self, method, route):
        return "/shiyan/v1/" + route, b"", {"Authorization": "Bearer fake-" + self.owner}

    def make_connection(self, timeout):
        self.timeout = timeout
        return self.connection

    async def json(self, method, route, value=None, timeout=None):
        self.calls.append((self.owner, method, route, value))
        return self.result


class AvatarBridgeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        # All test images and streams are in-memory fixtures. Run their blocking
        # boundaries deterministically; production uses the actual thread pool.
        async def in_memory(function, *args, **kwargs):
            return function(*args, **kwargs)
        boundary = patch.object(avatar.asyncio, "to_thread", in_memory)
        boundary.start()
        self.addCleanup(boundary.stop)
        self.runtime = types.SimpleNamespace(account={"id": "a"}, closing=False, gateway=Gateway())
        self.manager = Manager(self.runtime)

    async def test_bounded_streaming_body_and_object_shape(self):
        request = Request(self.runtime, self.manager, chunks=[b"{" + b" " * avatar.MAX_AVATAR_JSON, b"}"])
        with self.assertRaises(avatar.GatewayError) as caught:
            await avatar._body(request)
        self.assertEqual(caught.exception.status, 413)
        with self.assertRaises(ValueError):
            await avatar._body(Request(self.runtime, self.manager, chunks=[b"[]"]))

    async def test_thumbnail_is_bounded_square_jpeg(self):
        thumb = avatar._login_thumbnail(encoded_image())
        self.assertLessEqual(len(thumb), 6000)
        with Image.open(io.BytesIO(base64.b64decode(thumb))) as image:
            self.assertEqual(image.size, (64, 64))
            self.assertEqual(image.format, "JPEG")

    async def test_remembered_updates_once_and_delete_clears(self):
        value = payload(1, encoded_image())
        await avatar._remember_avatar(self.runtime, self.manager, 1, value)
        await avatar._remember_avatar(self.runtime, self.manager, 1, value)
        self.assertEqual(self.manager.writes, 1)
        self.assertIsNotNone(self.manager.device["avatar"])
        await avatar._remember_avatar(self.runtime, self.manager, 1, payload(2))
        self.assertEqual(self.manager.writes, 2)
        self.assertIsNone(self.manager.device["avatar"])
        await avatar._remember_avatar(self.runtime, self.manager, 1, value)
        self.assertEqual(self.manager.writes, 2, "Old events must not restore a deleted avatar")

    async def test_remembered_other_account_is_never_changed(self):
        self.manager.device["userId"] = "b"
        await avatar._remember_avatar(self.runtime, self.manager, 1, payload(1, encoded_image()))
        self.assertEqual(self.manager.writes, 0)

    async def test_account_change_during_decode_discards_write(self):
        def delayed(_):
            self.manager.generation += 1
            return "new-thumbnail"

        with patch.object(avatar, "_login_thumbnail", delayed):
            await avatar._remember_avatar(self.runtime, self.manager, 1, payload(1, "x"))
        self.assertEqual(self.manager.writes, 0)

    async def test_invalid_thumbnail_does_not_fail_cloud_success(self):
        await avatar._remember_avatar(self.runtime, self.manager, 1, payload(1, "not-a-jpeg"))
        self.assertEqual(self.manager.writes, 0)

    async def test_routes_use_current_resource_gateway_and_reject_target_injection(self):
        app = Registry()
        avatar.register_account_avatar(app)
        for owner in ("a", "b"):
            runtime = types.SimpleNamespace(account={"id": owner}, closing=False,
                                            gateway=Gateway(result=payload(0), owner=owner))
            manager = Manager(runtime, device_user=owner)
            await app.routes["PUT", "/api/account/avatar"](Request(runtime, manager, {"data": "encoded", "expectedRevision": 0}))
            self.assertEqual(runtime.gateway.calls, [(owner, "PUT", "account/avatar", {"data": "encoded", "expectedRevision": 0})])
            with self.assertRaises(ValueError):
                await app.routes["PUT", "/api/account/avatar"](Request(runtime, manager, {"data": "encoded", "userId": "other"}))
            self.assertEqual(len(runtime.gateway.calls), 1)

    async def test_event_forwarding_and_cleanup(self):
        frame = b"event: avatar\ndata: " + json.dumps(payload(1)).encode() + b"\n\n"
        response = Response(b": connected\n\n" + frame)
        self.runtime.gateway = gateway = Gateway(response=response)
        stream = await avatar._events(None, self.runtime, self.manager, 1)
        received = b"".join([chunk async for chunk in stream.body_iterator])
        self.assertEqual(received, b": connected\n\n" + frame)
        self.assertTrue(gateway.connection.closed)
        self.assertGreater(gateway.connection.shutdowns, 0)
        self.assertTrue(response.closed)
        self.assertFalse(gateway.open_connections)
        self.assertEqual(gateway.connection.last_request[2]["Authorization"], "Bearer fake-a")

    async def test_account_switch_stops_stream_before_delivery(self):
        def change_account():
            self.manager.generation += 1
        response = Response(b"event: avatar\ndata: {}\n\n", on_read=change_account)
        self.runtime.gateway = gateway = Gateway(response=response)
        stream = await avatar._events(None, self.runtime, self.manager, 1)
        self.assertEqual([chunk async for chunk in stream.body_iterator], [])
        self.assertTrue(response.closed)
        self.assertFalse(gateway.open_connections)

    async def test_upstream_auth_failure_propagates_and_closes(self):
        self.runtime.gateway = gateway = Gateway(response=Response(status=401))
        with self.assertRaises(avatar.GatewayError) as caught:
            await avatar._events(None, self.runtime, self.manager, 1)
        self.assertEqual(caught.exception.status, 401)
        self.assertTrue(gateway.response.closed)
        self.assertFalse(gateway.open_connections)


class AvatarConnectionLifecycleTests(unittest.TestCase):
    def test_close_only_interrupts_io_until_serial_dispose(self):
        gateway = Gateway()
        connection = avatar._AvatarEventConnection(gateway, '/events', {})
        connection.open()
        with connection.io_lock:
            connection.close()
            self.assertFalse(gateway.connection.closed)
            self.assertFalse(gateway.response.closed)
            self.assertGreater(gateway.connection.shutdowns, 0)
        connection.dispose()
        self.assertTrue(gateway.connection.closed)
        self.assertTrue(gateway.response.closed)

    def test_logout_interrupts_real_chunked_read_without_concurrent_response_close(self):
        client, server = socket.socketpair()
        client.settimeout(2)
        raw_connection = http.client.HTTPConnection('fixture', timeout=2)
        raw_connection.sock = client
        gateway = Gateway()
        gateway.connection = raw_connection
        connection = avatar._AvatarEventConnection(gateway, '/events', {})
        try:
            server.sendall(b'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n')
        except PermissionError:
            client.close()
            server.close()
            self.skipTest('Scratch socket sandbox; run in the application environment')
        entered, errors = threading.Event(), []
        reader = disposer = None
        try:
            response = connection.open()
            original_readline = response.readline

            def blocked_read(size):
                entered.set()
                return original_readline(size)

            response.readline = blocked_read

            def read():
                try: connection.readline(1024)
                except Exception as error: errors.append(error)

            reader = threading.Thread(target=read, daemon=True)
            reader.start()
            self.assertTrue(entered.wait(1))
            connection.close()
            disposer = threading.Thread(target=connection.dispose, daemon=True)
            disposer.start()
            reader.join(2)
            disposer.join(2)
            self.assertFalse(reader.is_alive(), 'Socket shutdown must wake the pending read')
            self.assertFalse(disposer.is_alive(), 'Dispose must run after the read returns')
            self.assertTrue(all(isinstance(error, (OSError, http.client.HTTPException)) for error in errors), errors)
            self.assertTrue(response.closed)
        finally:
            server.close()
            connection.close()
            if reader is not None: reader.join(2)
            if disposer is not None: disposer.join(2)
            connection.dispose()


if __name__ == "__main__":
    print("Framework boundary:", "stub (scratch only)" if STUB_FRAMEWORK else "real FastAPI")
    unittest.main(verbosity=2)
