#!/usr/bin/env python3
"""SSH stdio client for Dots' private Unix socket and a temporary HTTPS callback."""
import argparse
import http.client
import json
import os
from pathlib import Path
import queue
import re
import signal
import socket
import subprocess
import sys
import threading
import time

SOCKET_PATH = '/home/ubuntu/dots-runtime/local-ipc/mcp.sock'


def emit(obj):
    print(json.dumps(obj, ensure_ascii=False), flush=True)


class UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self):
        super().__init__('localhost', timeout=40)
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(SOCKET_PATH)


def call(message):
    conn = UnixHTTPConnection()
    try:
        conn.request('POST', '/mcp', json.dumps(message).encode(), {'content-type': 'application/json'})
        response = conn.getresponse()
        data = response.read(1024 * 1024)
        if response.status != 200:
            raise RuntimeError('Local MCP returned HTTP ' + str(response.status))
        return json.loads(data)
    finally:
        conn.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--callback-port', type=int, required=True)
    args = parser.parse_args()
    if not 1024 <= args.callback_port <= 65535:
        raise ValueError('callback port out of range')
    if not Path(SOCKET_PATH).is_socket():
        raise RuntimeError('Private Dots MCP socket is not available')
    proc = subprocess.Popen([
        '/home/ubuntu/cloudflared', 'tunnel', '--no-autoupdate', '--protocol', 'http2',
        '--url', f'http://127.0.0.1:{args.callback_port}',
    ], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, bufsize=1)
    lines = queue.Queue()
    def drain():
        for line in proc.stderr:
            lines.put(line)
        lines.put(None)
    threading.Thread(target=drain, daemon=True).start()
    def shutdown(signum=None, frame=None):
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
        if signum is not None:
            raise SystemExit(128 + signum)
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    subscriptions = []
    try:
        deadline = time.monotonic() + 75
        callback_base = None
        connected = False
        while time.monotonic() < deadline:
            try:
                line = lines.get(timeout=max(0.1, deadline - time.monotonic()))
            except queue.Empty:
                break
            if line is None:
                raise RuntimeError('HTTPS tunnel exited before connecting')
            match = re.search(r'https://[a-z0-9-]+\.trycloudflare\.com', line)
            if match:
                callback_base = match.group(0)
            if 'Registered tunnel connection' in line:
                connected = True
            if callback_base and connected:
                break
        if not callback_base or not connected:
            raise RuntimeError('HTTPS callback tunnel did not become ready within 75 seconds')
        emit({'kind': 'ready', 'callback_base': callback_base, 'transport': 'HTTPS webhook / reverse SSH', 'runtime_port': 4330})
        for raw in sys.stdin:
            try:
                msg = json.loads(raw)
                method = msg.get('method')
                if method not in ('tools/call', 'events/subscribe', 'events/unsubscribe', 'events/list'):
                    raise ValueError('RPC method not permitted')
                if method == 'tools/call' and msg.get('params', {}).get('name') not in (
                    'dots_create_goal', 'dots_instruct_goal', 'dots_get_goal', 'dots_read_output'):
                    raise ValueError('MCP tool not permitted')
                if method == 'events/subscribe':
                    delivery = msg.get('params', {}).get('delivery', {})
                    if not str(delivery.get('url', '')).startswith(callback_base + '/'):
                        raise ValueError('Subscription must target this client callback')
                    if not isinstance(msg.get('params', {}).get('arguments', {}).get('goal_id'), int):
                        raise ValueError('This relay requires a goal-scoped subscription')
                for attempt in range(4):
                    response = call(msg)
                    error = response.get('error')
                    if method != 'events/subscribe' or not error:
                        break
                    detail = str(error.get('data', {}).get('detail', ''))
                    safe_detail = re.sub(r'https?://\S+', '<callback-url>', detail)[:300]
                    audit = {'at': time.time(), 'goal_id': msg.get('params', {}).get('arguments', {}).get('goal_id'), 'attempt': attempt + 1, 'reason': error.get('data', {}).get('reason'), 'detail': safe_detail}
                    fd = os.open('/home/ubuntu/dots-runtime/client-relay-audit.jsonl', os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
                    with os.fdopen(fd, 'a') as out:
                        out.write(json.dumps(audit) + '\n')
                    transient = re.search(r'EAI_AGAIN|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed|timed out|timeout|HTTP 502|HTTP 503|HTTP 504', detail, re.I)
                    if attempt == 3 or not transient:
                        error['message'] = str(error.get('message', 'Subscription failed')) + ': ' + safe_detail
                        break
                    # Retry only this idempotent callback handshake, never task creation or execution.
                    time.sleep(2 ** attempt)
                if method == 'events/subscribe' and 'result' in response:
                    subscriptions.append(msg['params'])
                if method == 'events/unsubscribe' and 'result' in response:
                    subscriptions = [p for p in subscriptions if p.get('delivery', {}).get('url') != msg.get('params', {}).get('delivery', {}).get('url')]
                emit(response)
            except Exception as exc:
                emit({'kind': 'error', 'error': type(exc).__name__})
    finally:
        for params in subscriptions:
            try:
                call({'jsonrpc': '2.0', 'id': 'cleanup', 'method': 'events/unsubscribe', 'params': params})
            except Exception:
                pass
        shutdown()


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        emit({'kind': 'fatal', 'error': str(exc) if isinstance(exc, (RuntimeError, ValueError)) else type(exc).__name__})
        sys.exit(1)
