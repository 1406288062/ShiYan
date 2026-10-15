 
import asyncio,base64,json,os,signal,subprocess,time,uuid,re
from pathlib import Path
import httpx
ROOT=Path(__file__).resolve().parents[1]; QA=ROOT/'qa/v23-package'; APP=ROOT/'dist/拾燕.app'
FRAME=APP/'Contents/Frameworks/Python.framework/Versions/3.14'; SOURCE=APP/'Contents/Resources/app'
PYTHON=FRAME/'bin/python3.14'; tests=[]; process=None; child_pids=[]

def check(name,condition,detail=None):
    entry={'name':name,'ok':bool(condition)}
    if detail is not None:entry['detail']=detail
    tests.append(entry); print(('PASS ' if condition else 'FAIL ')+name,flush=True)
    if not condition:raise AssertionError(name)

def exists(pid):
    try:os.kill(pid,0);return True
    except ProcessLookupError:return False

def launch():
    env={k:v for k,v in os.environ.items() if k in ['HOME','USER','LOGNAME','TMPDIR','LANG']}
    env.update(PATH='/usr/bin:/bin:/usr/sbin:/sbin',PYTHONHOME=str(FRAME),PYTHONPATH=str(SOURCE),PYTHONNOUSERSITE='1',PYTHONDONTWRITEBYTECODE='1',SHIYAN_PACKAGED='1',SHIYAN_OFFLINE_TEST='1',SHIYAN_IDENTITY_HELPER=str(APP/'Contents/MacOS/ShiYanIdentity'),SSL_CERT_FILE=str(FRAME/'lib/python3.14/site-packages/certifi/cacert.pem'))
    ready=QA/('packaged-ready-'+uuid.uuid4().hex+'.json')
    p=subprocess.Popen([str(PYTHON),'-B','-u',str(SOURCE/'desktop_server.py'),'--port','0','--ready-file',str(ready),'--data-dir',str(QA/'package-data')],env=env,cwd=SOURCE,stdout=(QA/'packaged-backend.log').open('a'),stderr=subprocess.STDOUT,start_new_session=True)
    for _ in range(200):
        if ready.exists():return p,json.loads(ready.read_text())
        if p.poll() is not None:raise RuntimeError('Bundled runtime failed: see packaged-backend.log')
        time.sleep(.1)
    p.terminate();raise RuntimeError('Bundled startup timed out')

async def main():
    global process
    process,info=await asyncio.to_thread(launch)
    check('Standalone bundled backend starts without development server',process.poll() is None)
    async with httpx.AsyncClient(base_url=info['url'],timeout=15) as client:
        headers={'X-Shiyan-Local':'1'}
        async def req(method,path,data=None,extra=None):
            response=await client.request(method,path,json=data,headers={**headers,**(extra or {})});response.raise_for_status();return response.json()
        boot=await req('POST','/api/workspace/bootstrap',{});headers['X-Shiyan-Workspace']=boot['token']
        p=await req('POST','/api/workspace/projects',{'name':'Packaged QA','path':str(QA/'fixture-project')});project=p['project'];project_id=project['id']
        check('Packaged project import resolves actual local directory',project['path']==str(QA/'fixture-project'))
        f=await req('POST','/api/workspace/files/read',{'projectId':project_id,'path':'hello.py'})
        check('Packaged file reader preserves Chinese text','你好，拾燕' in f['file']['text'])
        reference={'projectId':project_id,'path':'hello.py'}
        original=f['file']
        baseline=await req('POST','/api/workspace/files/changes',{**reference,'baselineText':original['text']})
        check('Opened file baseline reports unchanged content',baseline['changes']['available'] and not baseline['changes']['diff'])
        saved=await req('POST','/api/workspace/files/save-text',{**reference,'contentHash':original['contentHash'],'text':original['text']+'# saved refinement\n','confirmed':True})
        diff=await req('POST','/api/workspace/files/changes',reference)
        check('Packaged file changes use genuine pre-save backup','+# saved refinement' in diff['changes']['diff'] and Path(saved['backupPath']).read_text()==original['text'])
        conflict=await client.post('/api/workspace/files/save-text',json={**reference,'contentHash':original['contentHash'],'text':'stale','confirmed':True},headers=headers)
        check('Packaged stale editor cannot overwrite newer file',conflict.status_code>=400 and 'saved refinement' in Path(saved['file']['path']).read_text())
        t=await req('POST','/api/workspace/terminals',{'projectId':project_id});terminal=t['terminal'];tid=terminal['id'];child_pids.append(terminal['pid'])
        output=bytearray();attached=asyncio.Event()
        async def consume():
            async with client.stream('GET',f'/api/workspace/terminals/{tid}/events',headers=headers,timeout=None) as response:
                response.raise_for_status()
                async for line in response.aiter_lines():
                    if not line.startswith('data: '):continue
                    event=json.loads(line[6:])
                    if event['type']=='ready':attached.set()
                    if event['type']=='data':output.extend(base64.b64decode(event['data']))
                    if event['type']=='exit':return
        stream=asyncio.create_task(consume());await asyncio.wait_for(attached.wait(),8)
        await req('POST',f'/api/workspace/terminals/{tid}/input',{'data':"printf '%s%s\\n' PACKAGED_ PTY_OK; pwd\n"})
        async def has(marker,timeout=10):
            async with asyncio.timeout(timeout):
                while marker not in output.decode('utf8','replace'):
                    if stream.done():raise RuntimeError('Terminal exited before marker: '+output.decode('utf8','replace')[-800:])
                    await asyncio.sleep(.04)
        await has('PACKAGED_PTY_OK')
        check('Bundled Python child bootstraps genuine interactive PTY',True)
        await has(str(QA/'fixture-project'))
        check('Packaged terminal starts in selected project directory',True)
        await req('POST',f'/api/workspace/terminals/{tid}/resize',{'cols':91,'rows':27})
        await req('POST',f'/api/workspace/terminals/{tid}/input',{'data':'stty size\n'});await has('27 91')
        check('Packaged PTY resize reaches controlling terminal',True)
        await req('POST',f'/api/workspace/terminals/{tid}/input',{'data':'sleep 40\n'});await asyncio.sleep(.3)
        await req('POST',f'/api/workspace/terminals/{tid}/input',{'data':"\u0003printf '%s%s\\n' INTERRUPT_ OK\n"});await has('INTERRUPT_OK')
        check('Packaged Ctrl-C interrupts foreground process and shell remains usable',True)
        bad=await client.get(f'/api/workspace/terminals/{tid}/events',headers={**headers,'Origin':'https://untrusted.example'})
        check('Live terminal stream rejects foreign Origin',bad.status_code==403)
        await req('DELETE',f'/api/workspace/terminals/{tid}');await asyncio.wait_for(stream,5)
        check('Closing packaged terminal reaps its process',not exists(terminal['pid']))
        await req('PATCH','/api/workspace/preferences',{'selectedProjectId':project_id,'leftOpen':False,'rightOpen':True,'groups':{'pinned':False,'projects':True,'recent':False},'tabs':[{'id':str(uuid.uuid4()),'type':'browser','url':'https://example.com','title':'QA restore'}]})
        c=await req('POST','/api/conversations',{'projectId':project_id});conversation_id=c['conversation']['id']
        check('Packaged new conversation is associated with project',c['conversation']['projectId']==project_id)
        state=(await req('GET','/api/state'))['state'];before=len(state['history']);done=asyncio.Future()
        async def photo_events():
            async with client.stream('GET','/api/events',timeout=None) as response:
                async for line in response.aiter_lines():
                    if not line.startswith('data: '):continue
                    state=json.loads(line[6:])
                    if len(state.get('history',[]))>before:
                        if not done.done():done.set_result(state);return
                    for job in state.get('photoJobs',[]):
                        if job.get('state')=='failed' and not done.done():done.set_exception(RuntimeError(str(job.get('error'))));return
        watcher=asyncio.create_task(photo_events())
        fixture=ROOT/'qa/fixtures/enhance-input.png';check('Real enhancement fixture available',fixture.exists())
        response=await client.post('/api/assets',headers=headers,files={'files':('enhance-input.png',fixture.read_bytes(),'image/png')},data={'kind':'input'});response.raise_for_status();asset=response.json()['assets'][0]
        await req('POST','/api/photo/jobs',{'feature':'enhance','assetId':asset['id'],'model':'general'})
        try:state=await asyncio.wait_for(done,150)
        finally:watcher.cancel();await asyncio.gather(watcher,return_exceptions=True)
        history=state['history'][0];result=history['asset'];check('Real packaged 4x enhancement completes into unified history',result['width']==asset['width']*4 and result['height']==asset['height']*4,{'input':[asset['width'],asset['height']],'output':[result['width'],result['height']]})
        image=await client.get('/api/assets/'+result['id']+'/file');check('Enhanced artifact can be read from packaged app',image.status_code==200 and len(image.content)>100);(QA/'packaged-enhanced.png').write_bytes(image.content)
        t2=(await req('POST','/api/workspace/terminals',{'projectId':project_id}))['terminal'];child_pids.append(t2['pid'])
        await req('POST',f'/api/workspace/terminals/{t2["id"]}/input',{'data':'sleep 90 &\n'});await asyncio.sleep(.3)
        pairs=[tuple(map(int,line.split())) for line in subprocess.check_output(['/bin/ps','-axo','pid=,ppid='],text=True).splitlines() if len(line.split())==2]
        child_pids.extend(pid for pid,parent in pairs if parent==t2['pid'])
    process.terminate();await asyncio.to_thread(process.wait,10)
    check('Packaged app shutdown cleans terminal and its background children',all(not exists(pid) for pid in child_pids))
    process,second=await asyncio.to_thread(launch)
    async with httpx.AsyncClient(base_url=second['url'],timeout=10) as client:
        boot=(await client.post('/api/workspace/bootstrap',headers={'X-Shiyan-Local':'1'},json={})).json()
        check('New-port restart restores projects, layout and tabs from SQLite',boot['preferences'].get('leftOpen') is False and boot['preferences'].get('selectedProjectId')==project_id and any(t.get('title')=='QA restore' for t in boot['preferences']['tabs']))
        state=(await client.get('/api/state')).json()['state']
        check('New-port restart preserves conversation and enhanced artifact',any(c['id']==conversation_id for c in state['conversations']) and any(h['asset']['id']==result['id'] for h in state['history']))
        check('Launch capability rotates on restart',boot['token']!=headers['X-Shiyan-Workspace'])
    process.terminate();await asyncio.to_thread(process.wait,10)

try:asyncio.run(main())
except Exception as exc:
    tests.append({'name':'unexpected failure','ok':False,'error':str(exc)});print('ERROR',repr(exc),flush=True)
finally:
    if process and process.poll() is None:
        process.terminate()
        try:process.wait(timeout=10)
        except subprocess.TimeoutExpired:process.kill()
    report={'tests':tests,'passed':sum(t['ok'] for t in tests),'failed':sum(not t['ok'] for t in tests),'dataDirectory':str(QA/'package-data'),'app':str(APP)}
    (QA/'package-api-tests.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));print(json.dumps({'passed':report['passed'],'failed':report['failed']}),flush=True)
    raise SystemExit(1 if report['failed'] else 0)
