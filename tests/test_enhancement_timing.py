"""Content-free stage telemetry, failures and account isolation."""
import contextlib
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from shared.compute.timing import timed_stage,timing_event,browser_timing,emit_timing

class OwnedStorage:
    def asset(self,key):
        if key!='asset-a':raise ValueError('Unknown asset')
        return {'id':key}
    def get(self,kind,key):
        return {'feature':'enhance','outputAssetId':'asset-a','requestId':'req-a','remoteTaskId':'task-a'} if key=='job-a' else None

class TimingTests(unittest.TestCase):
    def test_success_and_failure_use_monotonic_clock_and_do_not_swallow_errors(self):
        out=io.StringIO()
        with contextlib.redirect_stdout(out),patch('shared.compute.timing.time.perf_counter',side_effect=[10,10.25,20,20.5]):
            with timed_stage('model_load',taskId='task-a'):pass
            with self.assertRaisesRegex(RuntimeError,'private secret'):
                with timed_stage('gpu_inference',taskId='task-a'):raise RuntimeError('private secret')
        rows=[json.loads(x) for x in out.getvalue().splitlines()]
        self.assertEqual([r['status'] for r in rows],['started','completed','started','failed'])
        self.assertEqual(rows[1]['durationMs'],250);self.assertEqual(rows[3]['durationMs'],500)
        self.assertNotIn('private secret',out.getvalue())
    def test_allowlist_and_broken_log_stream(self):
        e=timing_event('mac_upload','completed',taskId='task-a',durationMs=2,filename='/private/a.jpg',token='secret',text='pixels',bytes=float('nan'))
        self.assertNotIn('filename',e);self.assertNotIn('token',e);self.assertNotIn('text',e);self.assertNotIn('bytes',e)
        with patch('builtins.print',side_effect=BrokenPipeError):
            emit_timing('mac_upload','completed')
            with timed_stage('mac_download'):pass
    def test_account_scoped_browser_references(self):
        data={'stage':'web_download','status':'completed','durationMs':20,'startedAtMs':100,'endedAtMs':120,'assetId':'asset-a','photoJobId':'job-a'}
        fields=browser_timing(data,OwnedStorage());self.assertEqual(fields['taskId'],'task-a')
        for changed in [{'assetId':'other-user-asset'},{'photoJobId':'other-user-job'},{'assetId':None},{'durationMs':float('inf')},{'durationMs':-1},{'durationMs':True},{'stage':'gpu_inference'},{'assetId':{'path':'secret'}}]:
            with self.subTest(changed=changed),self.assertRaises(ValueError):browser_timing({**data,**changed},OwnedStorage())
    def test_failed_upload_has_no_fake_asset_and_forged_server_identifiers_are_ignored(self):
        data={'stage':'upload','status':'failed','durationMs':20,'startedAtMs':100,'endedAtMs':120,'attemptId':'upload-a','taskId':'forged-task','scopeId':'forged-owner'}
        fields=browser_timing(data,OwnedStorage());self.assertNotIn('taskId',fields);self.assertNotIn('scopeId',fields)
    def test_child_task_link_comes_from_process_environment(self):
        with patch.dict('os.environ',{'SHIYAN_ENHANCEMENT_TASK_ID':'task-a'}):
            self.assertEqual(timing_event('result_encode','completed')['taskId'],'task-a')


class TimingEndpointTests(unittest.IsolatedAsyncioTestCase):
    async def test_endpoint_logs_only_after_account_scoped_validation(self):
        import tempfile
        from types import SimpleNamespace
        from unittest.mock import AsyncMock
        from shared.paths import APP_ROOT
        from desktop_backend.api import create_app
        with tempfile.TemporaryDirectory() as directory:
            app=create_app(directory,APP_ROOT,profile='web')
            endpoint=next(r.endpoint for r in app.routes if r.path=='/api/photo/timings')
            payload={'stage':'web_download','status':'completed','durationMs':20,'startedAtMs':100,'endedAtMs':120,'assetId':'asset-a','photoJobId':'job-a'}
            runtime=SimpleNamespace(storage=OwnedStorage(),account={'owner':'owner-a'})
            request=SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(runtime=runtime)),body=AsyncMock(return_value=b'{}'),json=AsyncMock(return_value=payload))
            with patch('desktop_backend.api.emit_timing') as log:
                self.assertEqual(await endpoint(request),{'ok':True});self.assertEqual(log.call_args.kwargs['taskId'],'task-a')
                request.json.return_value={**payload,'assetId':'foreign'}
                with self.assertRaises(ValueError):await endpoint(request)
                self.assertEqual(log.call_count,1)
            request.body.return_value=b'x'*2049
            with self.assertRaises(ValueError):await endpoint(request)

if __name__=='__main__':unittest.main()
