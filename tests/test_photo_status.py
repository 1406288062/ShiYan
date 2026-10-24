"""Small, account-scoped enhancement updates must never serialize chat history."""
import copy
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock,AsyncMock,patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from shared.paths import APP_ROOT
sys.path.insert(0,str(APP_ROOT))
from desktop_backend.runtime import Runtime
from desktop_backend.api import create_app
from desktop_backend.storage import Storage

class OwnedStorage:
    public_asset=staticmethod(Storage.public_asset)
    def __init__(self):
        self.jobs={'job-a':{'id':'job-a','feature':'enhance','state':'running','progress':0,'photoRevision':1,'updatedAt':'2026-10-24T08:00:00Z','outputAssetId':None}}
        self.assets={'asset-a':{'id':'asset-a','mimeType':'image/jpeg','storedName':'private-path','sourcePath':'private-original','width':64,'height':64}}
    def get(self,kind,key):return copy.deepcopy((self.jobs if kind=='photoJobs' else self.assets if kind=='assets' else {}).get(key))
    def put(self,kind,value):
        assert kind=='photoJobs';self.jobs[value['id']]=copy.deepcopy(value)
    def list(self,kind):
        assert kind=='history','Photo status attempted to read full chat state'
        return [{'id':'history-a','jobId':'job-a','assetId':'asset-a'}]
    def asset(self,key):
        v=self.get('assets',key)
        if not v:raise ValueError('Unknown asset')
        return v
    def asset_path(self,key):return Path('/synthetic/input.jpg')

class PhotoStatusTests(unittest.IsolatedAsyncioTestCase):
    def runtime(self):
        r=Runtime.__new__(Runtime);r.storage=OwnedStorage();r.notify=Mock(side_effect=AssertionError('Full snapshot requested'))
        return r
    async def test_progress_does_not_notify_chat_and_duplicate_progress_does_not_write(self):
        r=self.runtime();r.update_photo('job-a',progress=.5);job=r.storage.get('photoJobs','job-a')
        self.assertEqual(job['photoRevision'],2);r.update_photo('job-a',progress=.5)
        self.assertEqual(r.storage.get('photoJobs','job-a'),job);r.notify.assert_not_called()
    async def test_result_is_small_and_private_storage_fields_are_removed(self):
        r=self.runtime();r.update_photo('job-a',state='completed',outputAssetId='asset-a')
        result=r.photo_status('job-a');wire=json.dumps(result)
        self.assertLess(len(wire),2048);self.assertNotIn('storedName',wire);self.assertNotIn('sourcePath',wire)
        self.assertEqual(result['assets'][0]['id'],'asset-a');self.assertEqual(result['history'][0]['asset']['id'],'asset-a')
        with self.assertRaises(ValueError):r.photo_status('other-user-job')
    async def test_create_has_no_full_state_and_photo_revision_starts_at_one(self):
        r=self.runtime();r.platform=SimpleNamespace(mode='desktop');r.account={};r.launch=lambda key,coro:coro.close()
        job=r.create_photo_job({'feature':'enhance','assetId':'asset-a','model':'anime'})
        self.assertEqual(job['photoRevision'],1);r.notify.assert_not_called()
    async def test_create_read_cancel_endpoints_do_not_use_result_snapshot(self):
        r=self.runtime();r.create_photo_job=Mock(return_value=r.storage.get('photoJobs','job-a'));r.stop_photo=AsyncMock()
        with tempfile.TemporaryDirectory() as d:
            app=create_app(d,APP_ROOT,profile='web')
            routes={route.path:route.endpoint for route in app.routes if hasattr(route,"endpoint")}
            request=SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(runtime=r)),json=AsyncMock(return_value={}))
            created=await routes['/api/photo/jobs'](request);self.assertEqual(created['jobId'],'job-a');self.assertNotIn('state',created)
            for endpoint in ['/api/photo/jobs/{identifier}','/api/photo/jobs/{identifier}/cancel']:
                result=await routes[endpoint]('job-a',request);self.assertEqual(result['job']['id'],'job-a');self.assertNotIn('state',result);self.assertLess(len(json.dumps(result)),2048)
            with self.assertRaises(ValueError):await routes['/api/photo/jobs/{identifier}']('foreign',request)

if __name__=='__main__':unittest.main()
