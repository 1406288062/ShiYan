 
import asyncio,json,os,subprocess,time,uuid
from pathlib import Path
import httpx
ROOT=Path(__file__).resolve().parents[1];QA=ROOT/'qa/workbench-v1-run';APP=ROOT/'dist/拾燕.app';FRAME=APP/'Contents/Frameworks/Python.framework/Versions/3.14';SOURCE=APP/'Contents/Resources/app'
report={'connected':False,'replyVerified':False,'streamObserved':False};process=None
async def main():
    global process
    ready=QA/('chat-ready-'+uuid.uuid4().hex+'.json')
    env={k:v for k,v in os.environ.items() if k in ['HOME','USER','LOGNAME','TMPDIR','LANG']}
    env.update(PATH='/usr/bin:/bin:/usr/sbin:/sbin',PYTHONHOME=str(FRAME),PYTHONPATH=str(SOURCE),PYTHONNOUSERSITE='1',PYTHONDONTWRITEBYTECODE='1',SHIYAN_PACKAGED='1',SHIYAN_IDENTITY_HELPER=str(APP/'Contents/MacOS/ShiYanIdentity'),SSL_CERT_FILE=str(FRAME/'lib/python3.14/site-packages/certifi/cacert.pem'))
    process=subprocess.Popen([str(FRAME/'bin/python3.14'),'-B','-u',str(SOURCE/'desktop_server.py'),'--port','0','--ready-file',str(ready),'--data-dir',str(QA/'chat-smoke-data')],env=env,cwd=SOURCE,stdout=(QA/'chat-smoke-backend.log').open('w'),stderr=subprocess.STDOUT,start_new_session=True)
    for _ in range(150):
        if ready.exists():break
        if process.poll() is not None:raise RuntimeError('Chat-test backend failed')
        await asyncio.sleep(.1)
    info=json.loads(ready.read_text())
    async with httpx.AsyncClient(base_url=info['url'],timeout=65) as client:
        connected=asyncio.Future();finished=asyncio.Future();conversation=None
        async def events():
            async with client.stream('GET','/api/events',timeout=None) as response:
                async for line in response.aiter_lines():
                    if not line.startswith('data: '):continue
                    state=json.loads(line[6:]);status=state.get('connection',{}).get('status')
                    if status=='ready' and not connected.done():connected.set_result(True)
                    if status in {'unauthorized','unavailable'} and not connected.done():connected.set_exception(RuntimeError(state['connection'].get('error') or status))
                    if conversation:
                        c=next((c for c in state['conversations'] if c['id']==conversation),None)
                        for m in (c or {}).get('messages',[]):
                            if m.get('role')!='assistant':continue
                            if m.get('state') in {'queued','running','submitting'}:report['streamObserved']=True
                            if m.get('text') and m.get('state') not in {'queued','running','submitting','reconnecting','cancelling'} and not finished.done():finished.set_result(m)
                            if m.get('state')=='failed' and not finished.done():finished.set_exception(RuntimeError(m.get('error','Chat failed')))
        stream=asyncio.create_task(events())
        try:
            await asyncio.wait_for(connected,65);report['connected']=True;print('CONNECTED',flush=True)
            r=await client.post('/api/conversations',headers={'X-Shiyan-Local':'1'},json={});r.raise_for_status();conversation=r.json()['conversation']['id']
            r=await client.post('/api/conversations/'+conversation+'/send',headers={'X-Shiyan-Local':'1'},json={'text':'这是桌面应用连通性测试。不要调用工具，不要读写任何文件，只回复 WORKBENCH_CHAT_OK。','assetIds':[]});r.raise_for_status()
            message=await asyncio.wait_for(finished,100);report['replyVerified']='WORKBENCH_CHAT_OK' in message.get('text','');report['finalState']=message.get('state');report['reply']=message.get('text','')[:200];print('REPLY',report['reply'],flush=True)
        finally:
            if conversation and not report['replyVerified']:
                try:await client.post('/api/conversations/'+conversation+'/stop',headers={'X-Shiyan-Local':'1'},json={})
                except Exception:pass
            stream.cancel();await asyncio.gather(stream,return_exceptions=True)
try:asyncio.run(main())
except Exception as e:report['error']=str(e);print('ERROR',repr(e),flush=True)
finally:
    if process and process.poll() is None:
        process.terminate()
        try:process.wait(10)
        except subprocess.TimeoutExpired:process.kill()
    (QA/'chat-smoke.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));print(json.dumps(report,ensure_ascii=False),flush=True)
