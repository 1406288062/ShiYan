"""Browser repair regressions. Only synthetic requests and temporary data."""
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from shared.paths import APP_ROOT
from desktop_backend.api import create_app
from desktop_backend.gateway import GatewayError
from desktop_backend.member_workspace import proxy_member_request
from desktop_backend.verify_accounts import FakeGateway
from starlette.requests import Request
import httpx
from PIL import Image, ImageChops

class BrowserRepairTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='shiyan-web-repair-test-')
        self.addCleanup(self.directory.cleanup)

    def question_endpoint(self, mode, state='running', error=None):
        app = create_app(self.directory.name, APP_ROOT, profile=mode)
        endpoint = next(r.endpoint for r in app.routes if r.path == '/api/conversations/{identifier}/questions')
        gateway = SimpleNamespace(user_questions=AsyncMock(return_value={'ok':True,'pendingQuestions':[]}))
        if error: gateway.user_questions.side_effect = error
        conversation = {'messages':[{'role':'assistant','remoteJobId':'test-job','state':state}]}
        runtime = SimpleNamespace(conversation=Mock(return_value=conversation), gateway=gateway)
        request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(runtime=runtime)))
        return endpoint, request, runtime

    async def test_finished_web_jobs_do_not_query_remote_mailbox(self):
        for state in ('completed','failed','cancelled','interrupted'):
            endpoint, request, runtime = self.question_endpoint('web',state)
            result = await endpoint('owned-conversation',request)
            self.assertFalse(result['polling'])
            runtime.gateway.user_questions.assert_not_awaited()

    async def test_active_web_jobs_retain_questions(self):
        endpoint, request, runtime = self.question_endpoint('web')
        runtime.gateway.user_questions.return_value = {'ok':True,'pendingQuestions':[{'id':'ask-one'}]}
        self.assertEqual((await endpoint('owned-conversation',request))['pendingQuestions'],[{'id':'ask-one'}])
        runtime.gateway.user_questions.assert_awaited_once_with('test-job')

    async def test_missing_active_mailbox_backs_off(self):
        endpoint, request, runtime = self.question_endpoint('web',error=GatewayError('任务不存在',404))
        result = await endpoint('owned-conversation',request)
        self.assertTrue(result['unavailable']);self.assertEqual(result['pollAfterMs'],30000)

    async def test_auth_and_service_errors_are_not_hidden(self):
        for status in (401,403,429,500,503):
            endpoint, request, runtime = self.question_endpoint('web',error=GatewayError('test failure',status))
            with self.assertRaises(GatewayError) as failure: await endpoint('owned-conversation',request)
            self.assertEqual(failure.exception.status,status)

    async def test_unauthorized_conversation_is_not_looked_up_remotely(self):
        endpoint, request, runtime = self.question_endpoint('web')
        runtime.conversation.side_effect = ValueError('会话不存在')
        with self.assertRaises(ValueError): await endpoint('other-account-conversation',request)
        runtime.gateway.user_questions.assert_not_awaited()

    async def test_desktop_mailbox_behavior_is_unchanged(self):
        endpoint, request, runtime = self.question_endpoint('desktop','completed',GatewayError('任务不存在',404))
        with self.assertRaises(GatewayError): await endpoint('owned-conversation',request)
        runtime.gateway.user_questions.assert_awaited_once()

    def directory_request(self, mode='web', query='projectId=owned-project&path=&offset=100', token='test-workspace'):
        entries=[{'name':f'f-{i:03d}','path':f'f-{i:03d}','directory':False,'blocked':False} for i in range(205)]
        gateway=SimpleNamespace(json=AsyncMock(return_value={'ok':True,'entries':entries,'path':'.','truncated':True}))
        runtime=SimpleNamespace(server_access=False,platform=SimpleNamespace(mode=mode),gateway=gateway)
        app=SimpleNamespace(state=SimpleNamespace(runtime=runtime,workbench=SimpleNamespace(token='test-workspace')))
        request=Request({'type':'http','http_version':'1.1','method':'GET','scheme':'http','path':'/api/workspace/directory-details',
                         'query_string':query.encode(),'headers':[(b'x-shiyan-workspace',token.encode())],
                         'server':('127.0.0.1',17861),'app':app})
        return request,gateway

    async def test_web_directory_uses_existing_isolated_api_with_pagination(self):
        request,gateway=self.directory_request()
        result=json.loads((await proxy_member_request(request)).body)
        self.assertEqual(len(result['entries']),100);self.assertEqual(result['total'],205)
        self.assertEqual(result['nextOffset'],200);self.assertTrue(result['truncated'])
        self.assertTrue(gateway.json.call_args.args[1].startswith('workspace/directory?'))
        self.assertNotIn('directory-details',gateway.json.call_args.args[1])
        self.assertEqual(result['entries'][0]['name'],'f-100')

    async def test_last_directory_page_and_invalid_offset(self):
        request,gateway=self.directory_request(query='projectId=owned-project&offset=200')
        result=json.loads((await proxy_member_request(request)).body)
        self.assertEqual(len(result['entries']),5);self.assertIsNone(result['nextOffset'])
        request,gateway=self.directory_request(query='offset=oops')
        with self.assertRaises(GatewayError) as failure: await proxy_member_request(request)
        self.assertEqual(failure.exception.status,400);gateway.json.assert_not_awaited()

    async def test_workspace_csrf_and_upstream_errors_still_fail_closed(self):
        request,gateway=self.directory_request(token='other-account-token')
        with self.assertRaises(GatewayError) as failure: await proxy_member_request(request)
        self.assertEqual(failure.exception.status,403);gateway.json.assert_not_awaited()
        for status in (403,404,503):
            request,gateway=self.directory_request();gateway.json.side_effect=GatewayError('test',status)
            with self.assertRaises(GatewayError) as failure: await proxy_member_request(request)
            self.assertEqual(failure.exception.status,status)

    async def test_desktop_directory_transport_is_unchanged(self):
        request,gateway=self.directory_request(mode='desktop')
        await proxy_member_request(request)
        self.assertTrue(gateway.json.call_args.args[1].startswith('workspace/directory-details?'))

    async def test_public_page_csp_and_platform_icons(self):
        with patch.dict(os.environ,{'SHIYAN_OFFLINE_TEST':'1'}),patch('desktop_backend.account_sessions.Gateway',FakeGateway):
            for mode in ('web','desktop'):
                app=create_app(Path(self.directory.name)/mode,APP_ROOT,profile=mode)
                async with app.router.lifespan_context(app):
                    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://127.0.0.1:17861') as client:
                        page=await client.get('/')
                        self.assertEqual(page.status_code,200)
                        self.assertIn("script-src 'self';",page.headers['content-security-policy'])
                        self.assertNotIn('<script>',page.text)
                        self.assertIn('/assets/site-icon.png?v=20261024-home-logo-v1',page.text)
                        icon=await client.get('/assets/site-icon.png')
                        self.assertEqual(icon.status_code,200)
                        name='web-favicon.png' if mode=='web' else 'app-icon.png'
                        self.assertEqual(icon.content,(APP_ROOT/'web/assets'/name).read_bytes())
        with Image.open(APP_ROOT/'web/assets/logo.png') as source,Image.open(APP_ROOT/'web/assets/web-favicon.png') as icon:
            expected=source.convert('RGBA').resize((64,64),Image.Resampling.LANCZOS)
            self.assertIsNone(ImageChops.difference(expected,icon).getbbox())

if __name__=='__main__': unittest.main()
