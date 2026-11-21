import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../shared/frontend/assets/upload-priority.js',import.meta.url),'utf8');
const settle=async()=>{for(let n=0;n<8;n++)await Promise.resolve();};
function setup(): any {
  const requests: any[] = [], timers = new Map(); let timerId = 0;
  const setTimeout=(callback,delay)=>{const id=++timerId;timers.set(id,{callback,delay});return id;};
  const clearTimeout=id=>timers.delete(id);
  class CustomEvent extends Event {detail: any; constructor(type: any, options: any = {}){super(type);this.detail=options.detail;}}
  class MockXHR extends EventTarget { [key: string]: any;
    constructor(){super();this.upload=new EventTarget();this.headers={};this.status=0;this.responseText='';requests.push(this);}
    open(method,url,async=true){this.method=method;this.url=url;this.async=async;}
    setRequestHeader(name,value){this.headers[name.toLowerCase()]=value;}
    send(body){this.body=body;}
    emit(type,properties={}){const event=new Event(type);Object.assign(event,properties);this.dispatchEvent(event);this['on'+type]?.(event);}
    progress(loaded,total,computable=true){const event=new Event('progress');Object.assign(event,{loaded,total,lengthComputable:computable});this.upload.dispatchEvent(event);this.upload.onprogress?.(event);}
    sent(loaded,total=loaded){const event=new Event('load');Object.assign(event,{loaded,total,lengthComputable:true});this.upload.dispatchEvent(event);this.upload.onload?.(event);}
    respond(status,data){this.status=status;this.responseText=typeof data==='string'?data:JSON.stringify(data);this.response=this.responseText;this.emit('load');}
    abort(){this.emit('abort');}
  }
  const window: any = new EventTarget(); window.window = window;
  const context={window,CustomEvent,Event,EventTarget,XMLHttpRequest:MockXHR,FormData:class{},Promise,Error,JSON,Math,Number,Set,Array,console,setTimeout,clearTimeout};
  vm.createContext(context);vm.runInContext(source,context,{filename:'upload-priority.js'});
  return {window,context,requests,timers,priority:window.ShiYanUploadPriority};
}

test('nested scopes wake waiters and emit transitions only on first begin and last release',async()=>{
  const s=setup(), events: any[] = [];s.window.addEventListener('shiyan-upload-priority-change',()=>events.push(s.priority.active));
  assert.equal(s.priority.active,false);await s.priority.wait();
  const first=s.priority.begin(),second=s.priority.begin();assert.equal(s.priority.active,true);
  let resumed=0;const a=s.priority.wait().then(()=>resumed++),b=s.priority.wait().then(()=>resumed++);
  await settle();assert.equal(resumed,0);assert.deepEqual(events,[true]);
  first();first();await settle();assert.equal(s.priority.active,true);assert.equal(resumed,0);
  second();await Promise.all([a,b]);assert.equal(s.priority.active,false);assert.equal(resumed,2);assert.deepEqual(events,[true,false]);
  second();assert.deepEqual(events,[true,false]);
  const next=s.priority.begin();assert.equal(s.priority.active,true);next();assert.deepEqual(events,[true,false,true,false]);
});

test('upload sends the original FormData with same-origin credentials and local request header',async()=>{
  const s=setup(),form=new s.context.FormData();const result=s.priority.upload('/api/assets?compact=1',form,()=>{});
  assert.equal(s.requests.length,1);const xhr=s.requests[0];
  assert.equal(xhr.method,'POST');assert.equal(xhr.url,'/api/assets?compact=1');assert.equal(xhr.body,form);
  assert.equal(xhr.withCredentials,true);assert.equal(xhr.headers['x-shiyan-local'],'1');assert.equal(xhr.headers['content-type'],undefined);
  xhr.respond(200,{ok:true,assets:[{id:'image-a'}]});assert.equal((await result).assets[0].id,'image-a');
  assert.equal(s.priority.active,false);
});

test('progress reports bytes while full sent status still waits for the server response',async()=>{
  const s=setup(), updates: any[] = [];let resolved=false;const result=s.priority.upload('/api/assets',new s.context.FormData(),p=>updates.push(p)).then(r=>{resolved=true;return r;});
  const xhr=s.requests[0];xhr.progress(25,100);const partial=updates.at(-1);
  assert.equal(partial.loaded,25);assert.equal(partial.total,100);assert.equal(partial.percent,25);assert.equal(partial.sent,false);
  xhr.progress(100,100);xhr.sent(100);await settle();assert.equal(resolved,false);
  const sent=updates.at(-1);assert.equal(sent.loaded,100);assert.equal(sent.total,100);assert.equal(sent.percent,100);assert.equal(sent.sent,true);
  xhr.respond(200,{ok:true,assets:[]});assert.equal((await result).ok,true);assert.equal(resolved,true);
});

test('unknown-length transfer progress never invents a percentage or a completed response',async()=>{
  const s=setup(), updates: any[] = [];const result=s.priority.upload('/api/assets',new s.context.FormData(),p=>updates.push(p));
  const xhr=s.requests[0];xhr.progress(512,0,false);const progress=updates.at(-1);assert.equal(progress.loaded,512);assert.equal(progress.sent,false);assert(progress.percent==null||progress.percent===0);
  xhr.respond(200,{ok:true});await result;
});

test('network, abort, HTTP and application failures reject and caller finally releases priority',async()=>{
  for(const scenario of ['error','abort','http','application','invalid-json','null-json']){
    const s=setup(),release=s.priority.begin();let failure;
    const pending=s.priority.upload('/api/assets',new s.context.FormData(),()=>{}).catch(error=>{failure=error;}).finally(release);
    assert.equal(s.priority.active,true);const xhr=s.requests[0];
    if(scenario==='error')xhr.emit('error');
    if(scenario==='abort')xhr.abort();
    if(scenario==='http')xhr.respond(413,{ok:false,error:'图片过大'});
    if(scenario==='application')xhr.respond(200,{ok:false,error:'保存失败'});
    if(scenario==='invalid-json')xhr.respond(502,'not json');
    if(scenario==='null-json')xhr.respond(200,'null');
    await pending;assert(failure instanceof Error,scenario);assert.equal(s.priority.active,false,scenario);
    if(scenario==='http')assert.match(failure.message,/图片过大/);
    if(scenario==='application')assert.match(failure.message,/保存失败/);
  }
});

test('a stalled upload stays pending until explicitly aborted; release remains owned by caller',async()=>{
  const s=setup(),release=s.priority.begin();let completed=false;
  const pending=s.priority.upload('/api/assets',new s.context.FormData(),()=>{}).then(()=>{completed=true;},()=>{completed=true;}).finally(release);
  await settle();assert.equal(completed,false);assert.equal(s.priority.active,true);
  s.requests[0].abort();await pending;assert.equal(completed,true);assert.equal(s.priority.active,false);
});


test('inactivity deadline resets on progress and timeout aborts transport then releases caller priority',async()=>{
  const s=setup(),release=s.priority.begin();let failure;
  const pending=s.priority.upload('/api/assets',new s.context.FormData(),()=>{}).catch(error=>{failure=error;}).finally(release);
  assert.equal(s.timers.size,1);const initial=[...s.timers.keys()][0];
  const xhr=s.requests[0];xhr.progress(10,100);assert.equal(s.timers.size,1);assert(!s.timers.has(initial));
  const timer=[...s.timers.values()][0];assert.equal(timer.delay,120000);timer.callback();await pending;
  assert(failure instanceof Error);assert.equal((failure as any).status,408);assert.equal(s.priority.active,false);assert.equal(s.timers.size,0);
  xhr.respond(200,{ok:true});assert.equal((failure as any).status,408);
});

const appSource=fs.readFileSync(new URL('../shared/frontend/app.js',import.meta.url),'utf8');
const extract=name=>appSource.match(new RegExp('  (?:async )?function '+name+'\\([^\\n]*\\) \\{[\\s\\S]*?\\n  \\}'))![0];
function appSetup(): any {
  const s=setup(), fetches: any[] = [], fields: any = new Map(), streams: any[] = [], toasts: any[] = []; let releaseSettings: any;
  class EventSource extends EventTarget{path: any; closed: any; constructor(path: any){super();this.path=path;this.closed=false;streams.push(this);}close(){this.closed=true;}}
  Object.assign(s.context,{EventSource,ui:{input:null,result:null,photoUploadFile:null,photoLocalURL:null,feature:'enhance',model:'general',photoUploading:false},state:{settings:{}},
    URL:{createObjectURL:()=> 'blob:fixture',revokeObjectURL(){}},Image:class{naturalWidth=32;naturalHeight=24;onload: any;set src(value){this.onload?.();}},
    $:id=>{if(!fields.has(id))fields.set(id,{disabled:false,value:''});return fields.get(id);},renderPhoto(){},renderConnection(){},setText(){},show(){},
    remember:asset=>asset,applyState(){},humanError:value=>String(value),toast:value=>toasts.push(value),confirmAction:async()=>true,
    fetch:async(path,options)=>{fetches.push({path,options});if(path==='/api/settings?compact=1')return new Promise(resolve=>{releaseSettings=()=>resolve({ok:true,json:async()=>({ok:true})});});return {ok:true,json:async()=>({ok:true})};}
  });
  s.context.FormData=class {append(){}};s.window.ShiYanPlatform={mode:'web'};
  const listener=appSource.slice(appSource.indexOf("  window.addEventListener('shiyan-upload-priority-change'"),appSource.indexOf('  async function start()'));
  vm.runInContext('let workspaceSaveQueue=Promise.resolve(),eventSource=null;\n'+['api','upload','saveWorkspace','chooseWebHomeImage','connectStateEvents'].map(extract).join('\n')+'\n'+listener,s.context);
  return {...s,fetches,fields,streams,toasts,releaseSettings:()=>releaseSettings?.()};
}

test('actual app pauses state SSE and background fetches during upload, then resumes before settings reply',async()=>{
  const s=appSetup();s.context.connectStateEvents();assert.equal(s.streams.length,1);
  const pending=s.context.chooseWebHomeImage({name:'fixture.png',size:128,type:'image/png'});
  assert.equal(s.priority.active,true);assert.equal(s.streams[0].closed,true);
  const background=s.context.api('/api/dots/local-state','PATCH',{state:{cursor:1}});
  const manager=s.context.api('/api/dots/manager');const state=s.context.api('/api/state');
  await settle();assert.equal(s.fetches.length,0);
  const xhr=s.requests[0];xhr.progress(64,128);assert.match(s.context.ui.photoUploadLabel,/50%/);
  xhr.sent(128);assert.match(s.context.ui.photoUploadLabel,/已发送/);assert.equal(s.context.ui.photoUploading,true);
  xhr.respond(200,{ok:true,assets:[{id:'image-a',width:32,height:24}]});await pending;await Promise.all([background,manager,state]);
  assert.equal(s.priority.active,false);assert.equal(s.streams.length,2);assert.equal(s.streams[1].closed,false);
  assert.equal(s.context.ui.photoUploading,false);assert.equal(s.context.ui.input.id,'image-a');assert.equal(s.context.ui.input.url,'blob:fixture');
  assert.equal(s.fields.get('homeFileInput').disabled,false);assert(s.fetches.some(r=>r.path==='/api/settings?compact=1'));s.releaseSettings();
});

test('actual app releases background fetches and restores SSE after upload failure while retaining retry preview',async()=>{
  const s=appSetup();s.context.connectStateEvents();const file={name:'fixture.png',size:128,type:'image/png'};
  const pending=s.context.chooseWebHomeImage(file);const background=s.context.api('/api/dots/local-state','PATCH',{state:{cursor:1}});
  await settle();assert.equal(s.fetches.length,0);s.requests[0].emit('error');await pending;await background;
  assert.equal(s.priority.active,false);assert.equal(s.streams.length,2);assert.equal(s.streams[1].closed,false);
  assert.equal(s.context.ui.photoUploading,false);assert.equal(s.context.ui.photoUploadFile,file);assert.equal(s.context.ui.input.url,'blob:fixture');
  assert.match(s.context.ui.photoError,/上传失败/);assert.equal(s.fields.get('homeFileInput').disabled,false);assert(!s.fetches.some(r=>r.path.includes('/api/settings')));
});
