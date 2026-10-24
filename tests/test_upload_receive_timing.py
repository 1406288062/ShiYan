"""Measure request-body wait separately from image processing, without file content logs."""
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_compact_photo_upload as compact
from starlette.requests import Request, ClientDisconnect
from shared.compute.timing import timing_event

class UploadReceiveTimingTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = compact.CompactPhotoUploadTests.asyncSetUp
    upload = compact.CompactPhotoUploadTests.upload

    async def test_asgi_upload_distinguishes_body_receive_from_image_processing(self):
        times=iter([10,12,12.25,12.25])
        clock=SimpleNamespace(perf_counter=lambda:next(times))
        with patch('desktop_backend.api.time',clock),patch('desktop_backend.api.emit_timing') as log:
            response=await self.upload()
        self.assertEqual(response.status_code,200)
        log.assert_called_once()
        self.assertEqual(log.call_args.args,('upload','completed'))
        fields=log.call_args.kwargs
        self.assertEqual(fields['source'],'server')
        self.assertEqual(fields['receiveMs'],2000)
        self.assertEqual(fields['processMs'],250)
        self.assertEqual(fields['durationMs'],2250)
        self.assertEqual(fields['bytes'],len(self.image))
        self.assertEqual(fields['assetId'],response.json()['assets'][0]['id'])
        self.assertTrue(set(fields)<= {'source','assetId','bytes','durationMs','receiveMs','processMs'})
        self.runtime.notify.assert_not_called();self.runtime.snapshot.assert_not_called()

    async def test_disconnected_multipart_body_logs_receive_failure_before_storage(self):
        endpoint=next(route.endpoint for route in self.app.routes if route.path=='/api/assets' and 'POST' in route.methods)
        messages=iter([{'type':'http.request','body':b'--boundary\r\n','more_body':True},{'type':'http.disconnect'}])
        async def receive():return next(messages)
        request=Request({'type':'http','method':'POST','scheme':'http','path':'/api/assets','query_string':b'compact=1',
                         'server':('127.0.0.1',17861),'headers':[(b'content-type',b'multipart/form-data; boundary=boundary')],'app':self.app},receive=receive)
        times=iter([10,13,13]);clock=SimpleNamespace(perf_counter=lambda:next(times))
        with patch('desktop_backend.api.time',clock),patch('desktop_backend.api.emit_timing') as log,patch.object(self.storage,'save_bytes') as save:
            with self.assertRaises(ClientDisconnect):await endpoint(request)
        save.assert_not_called();log.assert_called_once()
        self.assertEqual(log.call_args.args,('upload','failed'))
        self.assertEqual(log.call_args.kwargs,{'source':'server','durationMs':3000,'receiveMs':3000})

    async def test_stage_allowlist_preserves_nonnegative_phase_times_only(self):
        result=timing_event('upload','completed',receiveMs=12.25,processMs=3.75,filename='private.png',body='private')
        self.assertEqual(result['receiveMs'],12.25);self.assertEqual(result['processMs'],3.75)
        self.assertNotIn('filename',result);self.assertNotIn('body',result)
        invalid=timing_event('upload','failed',receiveMs=-1,processMs=float('nan'))
        self.assertNotIn('receiveMs',invalid);self.assertNotIn('processMs',invalid)

if __name__=='__main__':unittest.main()
