"""Offline integration fixture: real app/auth + socket protocol + device script.

Only synthetic accounts and files are used. No deployed services are changed.
"""
from __future__ import annotations
from contextlib import ExitStack
import asyncio
import copy
import hashlib
from http.server import BaseHTTPRequestHandler
import json
import os
from pathlib import Path
import secrets
import shlex
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path: sys.path.insert(0, str(ROOT))
from shared.paths import APP_ROOT
if str(APP_ROOT) not in sys.path: sys.path.insert(0, str(APP_ROOT))
from desktop_backend.api import create_app
from desktop_backend.account_sessions import COOKIE
from desktop_backend.web_sessions import cookie_key
from desktop_backend.verify_accounts import FakeGateway
from desktop_backend.gateway import GatewayError
from apps.web.adapters.workspace import install
from apps.web.tests.preview_fixture import docx_bytes, pdf_bytes
import httpx
import uvicorn
from fastapi.responses import StreamingResponse, JSONResponse
from starlette.routing import Route


class IntegrationGateway(FakeGateway):
    users = {}; tokens = {}; workspaces = {}

    async def json(self, method, route, payload=None, timeout=40):
        user = self.tokens.get(self.account_token)
        if user and route == 'integrations/sponge/status':
            return {'ok':True,'connected':True,'devices':[{'deviceId':'fixture-device','name':'测试 Mac','platform':'darwin','online':True,'ready':True}]}
        if user and route == 'workspace/browser':
            return {'ok':True,'tabs':[],'history':[],'bookmarks':[],'downloads':[],'searchEngine':'bing'}
        if user and route.startswith('workspace/files/search'):
            return {'ok':True,'entries':[],'truncated':False,'searched':0}
        if user and route == 'account/quota': return {'ok':True,'quota':{'available':False}}
        return await super().json(method, route, payload, timeout)


class ThreadedUnix(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


class Harness:
    def __init__(self):
        self.temp = tempfile.TemporaryDirectory(prefix='shiyan-web-integration-',dir='/private/tmp')
        self.root = Path(self.temp.name)
        self.project = self.root/'device-project';self.project.mkdir()
        self.home = self.root/'device-home';self.home.mkdir()
        (self.project/'src').mkdir()
        self.source = self.project/'src'/'main.py'
        self.source.write_text("print('before')\n",encoding='utf-8');self.source.chmod(0o755)
        (self.project/'README.md').write_text('# Fixture project\n',encoding='utf-8')
        (self.project/'report.docx').write_bytes(docx_bytes())
        (self.project/'report.pdf').write_bytes(pdf_bytes())
        self.calls=[];self.device_online=True;self.gateways=[]
        self.stack=ExitStack();self.socket_path=str(self.root/'connector.sock')
        harness=self
        class Handler(BaseHTTPRequestHandler):
            protocol_version='HTTP/1.1'
            def log_message(self,*args):pass
            def do_POST(self):
                try:
                    count=int(self.headers.get('content-length','0'))
                    if count>1024*1024:raise ValueError('request too large')
                    data=json.loads(self.rfile.read(count));harness.calls.append(copy.deepcopy(data))
                    owner=data.get('owner')
                    assert isinstance(owner,str) and owner.startswith(('account:','shiyan-'))
                    if self.path=='/status':
                        value={'ok':True,'connected':True,'devices':harness.devices(),'needsPairing':False}
                    else:
                        assert self.path=='/rpc' and data.get('method')=='tools/call'
                        params=data['params'];name=params['name'];arguments=params.get('arguments',{})
                        if name=='list_devices': result={'devices':harness.devices()}
                        elif name=='run_device_tool':
                            assert arguments['deviceId']=='fixture-device'
                            if not harness.device_online:raise ValueError('offline')
                            tool=arguments['tool'];args=arguments.get('arguments',{})
                            assert tool=='start_process',tool
                            command=args['command'];assert command.startswith('python3 -I -c '),command[:50]
                            # Exercise the exact generated helper, not a fake read/write shortcut.
                            argv=shlex.split(command);argv[0]='/opt/homebrew/bin/python3'
                            env={**os.environ,'HOME':str(harness.home)}
                            completed=subprocess.run(argv,capture_output=True,text=True,timeout=20,env=env)
                            result=f'Process started with PID {secrets.randbelow(10000)+10000} (shell: /bin/zsh)\nInitial output:\n{completed.stdout}\n✅ Process has finished execution with exit code {completed.returncode}'
                        else:raise ValueError('unexpected tool '+name)
                        mcp={'content':[{'type':'text','text':result if isinstance(result,str) else json.dumps(result,ensure_ascii=False)}]}
                        value={'ok':True,'result':mcp}
                    raw=json.dumps(value,ensure_ascii=False).encode();self.send_response(200)
                except Exception as exc:
                    raw=json.dumps({'ok':False,'error':str(exc)}).encode();self.send_response(502)
                self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(raw)))
                self.send_header('Connection','close');self.end_headers();self.wfile.write(raw)
        self.socket_server=ThreadedUnix(self.socket_path,Handler)
        self.socket_thread=threading.Thread(target=self.socket_server.serve_forever,daemon=True)
        self.socket_thread.start()
        self.stack.enter_context(patch.dict(os.environ,{'SHIYAN_OFFLINE_TEST':'1','SHIYAN_SPONGE_SOCKET':self.socket_path}))
        self.stack.enter_context(patch('desktop_backend.account_sessions.Gateway',IntegrationGateway))
        self.stack.enter_context(patch('desktop_backend.runtime.Gateway',IntegrationGateway))
        IntegrationGateway.users={};IntegrationGateway.tokens={};IntegrationGateway.workspaces={}
        self.app=create_app(self.root/'browser-data',APP_ROOT,profile='web')
        install(self.app,ROOT)
        # These unrelated long-lived services are deliberately stubbed only in
        # the test harness; workspace/auth/files continue through real routes.
        async def idle_events(request):
            async def events():
                while not await request.is_disconnected():
                    yield b': fixture keepalive\n\n'
                    await asyncio.sleep(1)
            return StreamingResponse(events(),media_type='text/event-stream')
        for path in ['/api/dots/events','/api/account/avatar/events']:
            self.app.router.routes.insert(0,Route(path,idle_events,methods=['GET']))
        self.listener=socket.socket();self.listener.bind(('127.0.0.1',0));self.listener.listen(128)
        self.port=self.listener.getsockname()[1];self.base=f'http://127.0.0.1:{self.port}'
        self.server=uvicorn.Server(uvicorn.Config(self.app,host='127.0.0.1',port=self.port,log_level='error',timeout_graceful_shutdown=1))
        self.thread=threading.Thread(target=self.server.run,kwargs={'sockets':[self.listener]},daemon=True)
        self.thread.start()
        for _ in range(100):
            if self.server.started:break
            time.sleep(.03)
        if not self.server.started:raise RuntimeError('fixture server failed to start')

    def devices(self):
        return [{'deviceId':'fixture-device','name':'测试 Mac','platform':'darwin','online':self.device_online,'ready':self.device_online,'status':'online' if self.device_online else 'offline'}]

    def client(self,email='fixture-a@example.test'):
        client=httpx.Client(base_url=self.base,headers={'X-Shiyan-Local':'1'},timeout=30)
        response=client.post('/api/auth/register',json={'email':email})
        assert response.status_code==200,response.text
        self.gateways.append(client)
        return client

    def runtime(self,client):
        cookie=client.cookies.get(COOKIE)
        return self.app.state.accounts.sessions[cookie_key(cookie)].resources.runtime

    def seed(self,client):
        runtime=self.runtime(client)
        word=runtime.storage.save_bytes(docx_bytes(),'fixture.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document')
        pdf=runtime.storage.save_bytes((self.project/'report.pdf').read_bytes(),'fixture.pdf','application/pdf')
        cloud={'id':'fixture-cloud-project','name':'云端验收项目','path':'/workspace/projects/fixture'}
        runtime.storage.put('projects',cloud)
        IntegrationGateway.workspaces.setdefault(runtime.account['owner'],{})[cloud['id']]=cloud
        conversation=runtime.storage.list('conversations')[0]
        conversation['projectId']=cloud['id']
        conversation['title']='网页工作区验收'
        conversation['messages']=[
          {'id':'fixture-user-message','role':'user','text':'请查看修改并生成文件','assets':[],'state':'completed','createdAt':'2026-10-27T01:00:00Z'},
          {'id':'fixture-assistant-message','role':'assistant','text':'已修改文件并生成报告。','assets':[word,pdf],'state':'completed','createdAt':'2026-10-27T01:00:01Z','completedAt':'2026-10-27T01:00:02Z',
           'fileChanges':[{'path':'src/main.py','kind':'update','available':True,'diff':'--- before\n+++ after\n@@ -1 +1 @@\n-print(1)\n+print(2)','added':1,'removed':1}],
           'displayItems':[{'type':'command_execution','command':'python3 --version','status':'completed','aggregated_output':'Python fixture','exit_code':0}]}]
        runtime.storage.put('conversations',conversation)
        return {'word':word,'pdf':pdf,'conversation':conversation['id']}

    def close(self):
        for client in self.gateways: client.close()
        self.server.should_exit=True;self.thread.join(timeout=8)
        self.listener.close();self.socket_server.shutdown();self.socket_server.server_close();self.socket_thread.join(timeout=2)
        self.stack.close();self.temp.cleanup()

    def __enter__(self):return self
    def __exit__(self,*exc):self.close()
