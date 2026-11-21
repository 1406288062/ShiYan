import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const adapterSource=fs.readFileSync(new URL('../apps/web/adapters/cos-transfer.js',import.meta.url),'utf8');
const appSource=fs.readFileSync(new URL('../shared/frontend/app.js',import.meta.url),'utf8');
const extract=name=>appSource.match(new RegExp('  async function '+name+'\\([^\\n]*\\) \\{[\\s\\S]*?\\n  \\}'))![0];
const settle=async()=>{for(let i=0;i<16;i++)await Promise.resolve();};
const file=(name='fixture.png',size=100)=>({name,size,type:'image/png'});
const ticket=(id='ticket-a')=>({ticketId:id,method:'PUT',url:'https://photos-12345.cos.ap-guangzhou.myqcloud.com/private/'+id+'?q-signature=fixture',headers:{'Content-Type':'image/png','x-cos-acl':'private'},expiresAt:2000000000});
function setup({mode='web',available=true,uploads=[ticket()],initError,completeError,deferComplete=false,unknownDimensions=false}: any = {}): any {
  const requests: any[] = [], calls: any[] = [], legacy: any[] = [], updates: any[] = [], timers = new Map(), fields = new Map(), timings: any[] = [];
  let count=0,clock=0,completeResolve;
  class XHR { [key: string]: any;
    constructor(){this.headers={};this.upload={};requests.push(this);}
    open(method,url){this.method=method;this.url=url;}
    setRequestHeader(name,value){this.headers[name.toLowerCase()]=value;}
    send(body){this.body=body;}
    progress(loaded){this.upload.onprogress?.({loaded});}
    sent(){this.upload.onload?.({loaded:this.body.size});}
    respond(status=200){this.status=status;this.onload?.();}
    abort(){this.onabort?.();}
  }
  const window: any = {ShiYanPlatform:{mode},ShiYanUploadPriority:{begin(){count++;return ()=>count--;},upload:async(...args)=>{legacy.push(args);return {ok:true,assets:[{id:'legacy-asset'}]};}},ShiYanEnhancementTiming:{beginUpload(){return (...args)=>timings.push(args);}}};
  const api=async(path,method,body)=>{
    calls.push({path,method,body});
    if(path==='/api/assets/cos/upload'){if(initError)throw initError;return {ok:true,available,uploads};}
    if(path==='/api/assets/cos/complete'){
      if(completeError)throw completeError;
      const result={ok:true,assets:body.ticketIds.map((id,index)=>({id:'asset-'+index,width:unknownDimensions?null:32,height:unknownDimensions?null:24}))};
      return deferComplete?new Promise(resolve=>completeResolve=()=>resolve(result)):result;
    }
    if(path.startsWith('/api/assets')){legacy.push({path,method,body});return {ok:true,assets:[{id:'legacy-asset'}]};}
    return {ok:true};
  };
  class TestURL extends URL{static createObjectURL(){return 'blob:fixture';}static revokeObjectURL(){}}
  const context: any = {window,URL:TestURL,XMLHttpRequest:XHR,api,FormData:class{append(){}},ui:{input:null,result:null,feature:'enhance',model:'general'},state:{settings:{}},
    remember:asset=>asset,renderPhoto(){},console,Image:class{naturalWidth=32;naturalHeight=24;onload: any;set src(v){this.onload?.();}},
    $:id=>{if(!fields.has(id))fields.set(id,{value:'',disabled:false});return fields.get(id);},
    photoBusy:()=>false,toast(){},confirmAction:async()=>true,setText(){},show(){},
    setTimeout:(fn,delay)=>{timers.set(++clock,{fn,delay});return clock;},clearTimeout:id=>timers.delete(id)};
  vm.createContext(context);vm.runInContext(adapterSource,context);
  vm.runInContext('let workspaceSaveQueue=Promise.resolve();\n'+['upload','saveWorkspace','chooseWebHomeImage'].map(extract).join('\n'),context);
  return {window,context,requests,calls,legacy,updates,timers,fields,timings,get active(){return count>0;},finishComplete:()=>completeResolve?.(),
    run:(items=[file()],kind='input')=>context.upload(items,kind),
    direct:(items=[file()],kind='input')=>window.ShiYanCosTransfer.upload(items,kind,api,p=>updates.push(p),'enhance')};
}

test('unconfigured COS falls back before any direct upload, under the existing priority scope',async()=>{
  const s=setup({available:false});const result=await s.run();
  assert.equal(result[0].id,'legacy-asset');assert.equal(s.requests.length,0);assert.equal(s.legacy.length,1);
  assert.equal(s.calls.length,1);assert.equal(s.calls[0].path,'/api/assets/cos/upload');assert.equal(s.active,false);
  assert.equal(s.legacy[0][0],'/api/assets?compact=1');assert.equal(s.timings[0][0],'completed');
});

test('successful web upload sends raw bytes only to COS then finalizes compact asset IDs',async()=>{
  const s=setup({deferComplete:true}),original=file();let resolved=false;
  const pending=s.run([original]).then(result=>{resolved=true;return result;});await settle();
  assert.equal(s.active,true);assert.equal(s.requests.length,1);const xhr=s.requests[0];
  assert.equal(xhr.method,'PUT');assert.equal(xhr.body,original);assert.equal(xhr.withCredentials,false);
  assert.deepEqual(xhr.headers,{'content-type':'image/png','x-cos-acl':'private'});
  assert.equal(xhr.headers.authorization,undefined);assert.equal(xhr.headers.cookie,undefined);assert.equal(xhr.headers['x-shiyan-local'],undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(s.calls[0].body)),{kind:'input',purpose:'enhance',files:[{name:'fixture.png',size:100,type:'image/png'}]});
  xhr.progress(50);assert.equal(s.context.ui.photoUploadLabel,'正在上传图片 50%');
  xhr.sent();assert.equal(s.context.ui.photoUploadLabel,'图片已发送，正在确认');await settle();assert.equal(resolved,false);
  xhr.respond(200);await settle();assert.equal(s.active,true);assert.equal(s.legacy.length,0);
  assert.equal(s.calls[1].path,'/api/assets/cos/complete');assert.deepEqual(Array.from(s.calls[1].body.ticketIds),['ticket-a']);
  s.finishComplete();const result=await pending;assert.equal(result[0].id,'asset-0');assert.equal(s.active,false);
  assert.equal(s.timings[0][0],'completed');assert.equal(s.timings[0][1],'asset-0');assert.equal(s.timings[0][2],100);
});

test('desktop and attachments retain their existing transport without COS planning calls',async()=>{
  for(const [mode,kind] of [['desktop','input'],['web','attachment'],['web','mask']]){
    const s=setup({mode});const result=await s.run([file()],kind);
    assert.equal(result[0].id,'legacy-asset');assert.equal(s.requests.length,0);assert.equal(s.legacy.length,1);
    assert(!s.calls.some(call=>call.path.includes('/cos/')));assert.equal(s.active,false);
    if(mode==='desktop')assert.equal(s.window.ShiYanCosTransfer,undefined);
  }
});

test('network, HTTP, abort and stalled direct uploads never duplicate the body to the legacy server',async()=>{
  for(const failure of ['network','http','abort','timeout']){
    const s=setup();const pending=s.run();const rejected=assert.rejects(pending,/图片上传/);await settle();
    const xhr=s.requests[0];
    if(failure==='network')xhr.onerror();
    if(failure==='http')xhr.respond(403);
    if(failure==='abort')xhr.abort();
    if(failure==='timeout'){assert.equal([...s.timers.values()][0].delay,120000);[...s.timers.values()][0].fn();}
    await rejected;assert.equal(s.legacy.length,0);assert.equal(s.calls.length,1);assert.equal(s.active,false);assert.equal(s.timers.size,0);
    assert.equal(s.timings[0][0],'failed');
  }
});

test('planning failure and completion failure surface errors instead of silently using the old upload path',async()=>{
  const planned=setup({initError:Error('session expired')});await assert.rejects(planned.run(),/session expired/);
  assert.equal(planned.requests.length,0);assert.equal(planned.legacy.length,0);assert.equal(planned.active,false);
  const completed=setup({completeError:Error('finalization failed')});const pending=completed.run();const rejected=assert.rejects(pending,/finalization failed/);
  await settle();completed.requests[0].respond();await rejected;
  assert.equal(completed.requests.length,1);assert.equal(completed.legacy.length,0);assert.equal(completed.active,false);
});

test('unsafe upload endpoints or headers are rejected before any file bytes are sent',async()=>{
  const invalid=[
    {...ticket(),url:'http://photos-12345.cos.ap-guangzhou.myqcloud.com/a?q-signature=x'},
    {...ticket(),url:'https://photos-12345.cos.ap-guangzhou.myqcloud.com.attacker.test/a?q-signature=x'},
    {...ticket(),url:'https://name:password@photos-12345.cos.ap-guangzhou.myqcloud.com/a?q-signature=x'},
    {...ticket(),url:'https://photos-12345.cos.ap-guangzhou.myqcloud.com/a'},
    {...ticket(),method:'POST'},
    {...ticket(),headers:{...ticket().headers,Authorization:'session-secret'}},
    {...ticket(),headers:{...ticket().headers,'X-Shiyan-Local':'1'}},
    {...ticket(),headers:{...ticket().headers,'x-cos-acl':'public-read'}},
    {...ticket(),headers:{'Content-Type':'image/png'}},
    {...ticket(),headers:{...ticket().headers,'Content-Length':'101'}},
  ];
  for(const value of invalid){const s=setup({uploads:[value]});await assert.rejects(s.run(),/图片上传/);assert.equal(s.requests.length,0);assert.equal(s.legacy.length,0);assert.equal(s.active,false);}
});

test('browser controls Content-Length and aggregate progress increases across sequential files',async()=>{
  const first={...ticket('first'),headers:{...ticket().headers,'Content-Length':'100'}},s=setup({uploads:[first,ticket('second')]});
  const pending=s.direct([file('one.png',100),file('two.png',300)]);await settle();
  assert.equal(s.requests.length,1);assert.equal(s.requests[0].headers['content-length'],undefined);
  s.requests[0].progress(50);assert.equal(s.updates.at(-1).percent,12);
  s.requests[0].sent();assert.equal(s.updates.at(-1).percent,25);assert.equal(s.updates.at(-1).sent,false);
  s.requests[0].respond();await settle();assert.equal(s.requests.length,2);
  s.requests[1].progress(100);assert.equal(s.updates.at(-1).loaded,200);assert.equal(s.updates.at(-1).percent,50);
  s.requests[1].sent();assert.equal(s.updates.at(-1).percent,100);assert.equal(s.updates.at(-1).sent,true);
  s.requests[1].respond();const result=await pending;assert.equal(result.assets.length,2);assert.equal(s.legacy.length,0);
});

test('real image chooser keeps the local original available after a failed COS upload',async()=>{
  const s=setup(),original=file();const pending=s.context.chooseWebHomeImage(original);
  assert.equal(s.context.ui.input.url,'blob:fixture');assert.equal(s.context.ui.photoUploading,true);await settle();
  s.requests[0].onerror();await pending;
  assert.equal(s.context.ui.input.url,'blob:fixture');assert.equal(s.context.ui.photoUploadFile,original);
  assert.equal(s.context.ui.photoUploading,false);assert.equal(s.fields.get('homeFileInput').disabled,false);
  assert.match(s.context.ui.photoError,/上传失败/);assert.equal(s.legacy.length,0);
});

test('real image chooser preserves decoded local preview after COS completion',async()=>{
  const s=setup(),original=file();const pending=s.context.chooseWebHomeImage(original);await settle();
  s.requests[0].respond();await pending;
  assert.equal(s.context.ui.input.id,'asset-0');assert.equal(s.context.ui.input.url,'blob:fixture');
  assert.equal(s.context.ui.photoUploadFile,null);assert.equal(s.context.ui.photoUploading,false);
  assert(s.calls.some(call=>call.path==='/api/settings?compact=1'));assert.equal(s.legacy.length,0);
});

test('progress resets inactivity timeout and completed transport removes the timer',async()=>{
  const s=setup();const pending=s.direct();await settle();const initial=[...s.timers.keys()][0];
  s.requests[0].progress(50);assert(!s.timers.has(initial));assert.equal(s.timers.size,1);
  s.requests[0].respond();await pending;assert.equal(s.timers.size,0);
});

test('non-enhancement input never starts COS and the image batch limit is checked before planning',async()=>{
  const s=setup();s.context.ui.feature='remove';await s.run();assert.equal(s.requests.length,0);assert.equal(s.calls.length,0);assert.equal(s.legacy.length,1);
  const limit=setup();await assert.rejects(limit.direct(Array.from({length:11},(_,n)=>file(n+'.png'))),/10/);
  assert.equal(limit.calls.length,0);assert.equal(limit.requests.length,0);
});

test('unknown remote original dimensions keep the decoded single-image preview size without metadata upload',async()=>{
 const s=setup({unknownDimensions:true}),pending=s.context.chooseWebHomeImage(file());await settle();s.requests[0].respond();await pending;
 assert.equal(s.context.ui.input.width,32);assert.equal(s.context.ui.input.height,24);assert.equal(s.context.ui.input.url,'blob:fixture');
 assert(!('width' in s.calls[0].body.files[0]));assert(!('height' in s.calls[0].body.files[0]));
});
test('single-image preview remains local and gets dimensions when decode finishes after upload',async()=>{
 const s=setup({unknownDimensions:true});let loaded;
 s.context.Image=class{naturalWidth=0;naturalHeight=0;onload: any;set src(value){loaded=()=>{this.naturalWidth=88;this.naturalHeight=99;this.onload();};}};
 const pending=s.context.chooseWebHomeImage(file());await settle();s.requests[0].respond();await pending;
 assert.equal(s.context.ui.input.url,'blob:fixture');loaded();assert.equal(s.context.ui.input.width,88);assert.equal(s.context.ui.input.height,99);
});
