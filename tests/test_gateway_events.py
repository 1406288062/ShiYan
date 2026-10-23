"""Protocol-level regressions for large SSE results and terminal recovery."""
import asyncio
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
_repository = Path(__file__).resolve().parents[1]
if str(_repository) not in sys.path:
    sys.path.insert(0, str(_repository))
from shared.paths import APP_ROOT
import unittest

source = Path(os.environ.get('SHIYAN_GATEWAY_TEST_SOURCE', APP_ROOT / 'desktop_backend/gateway.py'))
spec = importlib.util.spec_from_file_location('gateway_under_test', source)
gateway = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway)

class Response(io.BytesIO):
    status = 200

class Connection:
    def __init__(self, wire, status=200):
        self.response = Response(wire)
        self.response.status = status
        self.closed = False
    def request(self, *args, **kwargs): pass
    def getresponse(self): return self.response
    def close(self): self.closed = True

class GatewayEventsTests(unittest.IsolatedAsyncioTestCase):
    def client(self, wire=b'', snapshot=None, status=200):
        client = gateway.Gateway.__new__(gateway.Gateway)
        client.open_connections = set()
        client.authorization_error = None
        conn = Connection(wire, status)
        client.make_connection = lambda timeout: conn
        async def enrolled(): pass
        async def parts(*args): return '/fixture', b'', {}
        async def fetch(*args): return snapshot or {'status': 'running'}
        client.ensure_enrolled, client.request_parts, client.json = enrolled, parts, fetch
        return client, conn

    async def test_large_result_and_utf8_split_are_lossless(self):
        event = {'seq': 9, 'type': 'completed', 'text': '中文正文',
                 'fileChanges': [{'path': 'a.py', 'diff': '字' * 1100000}]}
        wire = b'data: ' + json.dumps(event, ensure_ascii=False).encode() + b'\n\n'
        client, conn = self.client(wire)
        self.assertEqual([event], [item async for item in client.events('job')])
        self.assertTrue(conn.closed)
        self.assertFalse(client.open_connections)

    async def test_multiline_crlf_and_heartbeats(self):
        client, _ = self.client(b': keepalive\r\nid: 1\r\ndata: {"seq":1,\r\ndata: "type":"completed"}\r\n\r\n')
        self.assertEqual('completed', [x async for x in client.events('job')][0]['type'])

    async def test_resumed_completed_job_uses_full_snapshot(self):
        snapshot = {'status': 'completed', 'text': 'done', 'fileChanges': [{'diff': '+code'}], 'displayItems': [{'id':'tool'}]}
        client, conn = self.client(snapshot=snapshot)
        result = [x async for x in client.events('job', 27)]
        self.assertEqual(28, result[0]['seq'])
        self.assertEqual(snapshot['fileChanges'], result[0]['fileChanges'])
        self.assertEqual(snapshot['displayItems'], result[0]['displayItems'])
        self.assertFalse(conn.closed)  # No stream was opened.

    async def test_eof_or_truncation_recovers_authoritative_result(self):
        for wire in [b'', b'data: {"seq":4', b'data: invalid\n\n']:
            with self.subTest(wire=wire):
                client, conn = self.client(wire, {'status':'completed','text':'saved','fileChanges':[{'path':'a'}]})
                result = [x async for x in client.events('job')]
                self.assertEqual('saved', result[0]['text'])
                self.assertTrue(conn.closed)

    async def test_invalid_event_is_not_reported_as_complete_if_server_running(self):
        client, _ = self.client(b'data: invalid\n\n')
        with self.assertRaisesRegex(gateway.GatewayError, '解析失败'):
            _ = [x async for x in client.events('job')]

    async def test_failed_and_cancelled_snapshots_keep_terminal_status(self):
        for state in ['failed','cancelled','interrupted']:
            client, _ = self.client(snapshot={'status':state,'error':'reason'})
            result = [x async for x in client.events('job', 3)]
            self.assertEqual(state, result[0]['type'])
            self.assertEqual('reason', result[0]['error'])

    async def test_unauthorized_does_not_fall_back_or_mark_complete(self):
        client, conn = self.client(status=401, snapshot={'status':'completed'})
        with self.assertRaises(gateway.GatewayError) as raised:
            _ = [x async for x in client.events('job')]
        self.assertEqual(401, raised.exception.status)
        self.assertTrue(conn.closed)

    async def test_oversized_event_is_rejected_without_unbounded_buffering(self):
        client, _ = self.client(b'data: '+b'x'*(40*1024*1024)+b'\n\n')
        with self.assertRaisesRegex(gateway.GatewayError, '单次事件过大'):
            _ = [x async for x in client.events('job')]

if __name__ == '__main__': unittest.main()
