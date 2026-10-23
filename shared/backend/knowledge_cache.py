"""Disposable account-local reading copies, independent of the WebKit origin/port."""
from pathlib import Path
import hashlib
import json
import os
import re
import shutil
import threading
import time
import uuid

_LOCK = threading.RLock()
_EPOCHS = {}
_ROUTE = re.compile(r'(spaces(?:/[^/]+/knowledge-bases)?|knowledge-bases/[^/]+/(?:documents|knowledge)|documents/[^/]+)\Z')

class KnowledgeReadCache:
    max_bytes = 32 * 1024 * 1024
    max_age = 86400
    max_entries = 64

    def __init__(self, account_directory):
        self.root = Path(account_directory).resolve() / 'knowledge-reading-v1'

    @staticmethod
    def eligible(route):
        return bool(_ROUTE.fullmatch(route))

    def epoch(self):
        with _LOCK:
            return _EPOCHS.get(str(self.root), 0)

    def clear(self):
        with _LOCK:
            _EPOCHS[str(self.root)] = self.epoch() + 1
            shutil.rmtree(self.root, ignore_errors=True)

    def _entries(self):
        return sorted(self.root.glob('*.json'), key=lambda p: p.stat().st_mtime, reverse=True) if self.root.exists() else []

    def snapshot(self):
        """Warm small reading entries on startup; never load an unbounded graph."""
        with _LOCK:
            result, total = {}, 0
            for p in self._entries():
                try:
                    size = p.stat().st_size
                    if size > 750 * 1024 or total + size > 1500 * 1024:
                        continue
                    item = json.loads(p.read_bytes())
                    age = time.time() - item['at']
                    if item.get('version') != 1 or not 0 <= age < self.max_age or not self.eligible(item['route']):
                        continue
                    result['/api/' + item['route']] = item['value']
                    total += size
                except (OSError, ValueError, TypeError, KeyError):
                    continue
            return result

    def write(self, route, data, epoch):
        if not self.eligible(route) or len(data) > 8 * 1024 * 1024:
            return
        try:
            value = json.loads(data)
            raw = json.dumps({'version': 1, 'at': time.time(), 'route': route, 'value': value}, ensure_ascii=False).encode()
        except (ValueError, TypeError):
            return
        with _LOCK:
            if epoch != self.epoch():
                return
            try:
                self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
                destination = self.root / (hashlib.sha256(route.encode()).hexdigest() + '.json')
                temp = self.root / (uuid.uuid4().hex + '.tmp')
                try:
                    with temp.open('xb') as stream:
                        os.chmod(temp, 0o600)
                        stream.write(raw)
                    temp.replace(destination)
                finally:
                    temp.unlink(missing_ok=True)
                entries = self._entries()
                total = sum(p.stat().st_size for p in entries)
                for index, p in reversed(list(enumerate(entries))):
                    if total <= self.max_bytes and index < self.max_entries and time.time() - p.stat().st_mtime < self.max_age:
                        continue
                    total -= p.stat().st_size
                    p.unlink(missing_ok=True)
            except OSError:
                return  # Cache writes never make a successful response fail.
