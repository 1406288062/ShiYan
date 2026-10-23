import json
from pathlib import Path
import tempfile
import time
import unittest
from desktop_backend.knowledge_cache import KnowledgeReadCache

class ReadingCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.cache = KnowledgeReadCache(Path(self.temp.name) / 'alice')
    def test_survives_new_instance_and_isolates_accounts(self):
        self.cache.write('spaces', b'[{"id":"s"}]', self.cache.epoch())
        restored = KnowledgeReadCache(Path(self.temp.name) / 'alice')
        self.assertEqual(restored.snapshot()['/api/spaces'], [{'id':'s'}])
        self.assertEqual(KnowledgeReadCache(Path(self.temp.name) / 'bob').snapshot(), {})
    def test_clear_rejects_stale_inflight_writes(self):
        epoch = self.cache.epoch()
        self.cache.clear()
        self.cache.write('spaces', b'[]', epoch)
        self.assertEqual(self.cache.snapshot(), {})
    def test_expired_corrupt_and_non_reading_data_are_not_restored(self):
        self.cache.write('query', b'{"answer":"private"}', self.cache.epoch())
        self.cache.write('spaces', b'[]', self.cache.epoch())
        p = next(self.cache.root.glob('*.json'))
        item = json.loads(p.read_bytes()); item['at'] = time.time() - 86401
        p.write_text(json.dumps(item)); self.assertEqual(self.cache.snapshot(), {})
        p.write_text('broken'); self.assertEqual(self.cache.snapshot(), {})
    def test_eviction_and_private_permissions(self):
        self.cache.max_bytes = 1500; self.cache.max_entries = 3
        for i in range(10): self.cache.write('documents/'+str(i), json.dumps({'text':'x'*300}).encode(), self.cache.epoch())
        files = list(self.cache.root.glob('*.json'))
        self.assertLessEqual(len(files), 3)
        self.assertLessEqual(sum(p.stat().st_size for p in files), 1500)
        self.assertTrue(all(p.stat().st_mode & 0o777 == 0o600 for p in files))
    def test_oversized_warmup_is_bounded(self):
        self.cache.write('documents/large', json.dumps({'text':'x'*800000}).encode(), self.cache.epoch())
        self.assertEqual(self.cache.snapshot(), {})

if __name__ == '__main__': unittest.main()
