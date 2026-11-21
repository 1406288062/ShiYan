import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source=fs.readFileSync(process.env.SHIYAN_DOTS_SOURCE || new URL('../shared/frontend/assets/workbench-dots.js',import.meta.url),'utf8');
const between=(start: any,end: any)=>{const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a,`Missing source section: ${start}`);return source.slice(a,b);};
const persistSource=between('function persist() {','\n  async function hydrate');
const refreshSource=between('function refresh(forceApprovals = false) {','\n  function managerTime');
const monitorSource=between('function monitorAllowed() {','\n  const voiceGlyph');
const prioritySource=between('function handleUploadPriorityChange() {','\n  function handleVisibilityChange');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function persistence(api: any){
 const stored: any[]=[],errors: any[]=[];
 const context=vm.createContext({JSON,Promise,Error,key:'account-isolated',saveChain:Promise.resolve(),persistedSnapshot:null,savingSnapshot:null,savingTask:null,
  manager:{status:'active'},messages:[{id:1,content:'unchanged history'}],tasks:[],goals:[],details:{},drafts:{},pending:{},cursor:1,readState:{readThrough:1},
  api,localStorage:{setItem:(key: any,value: any)=>stored.push({key,value})},showError:(error: any)=>errors.push(error),URGENT_PARTS:['drafts','pending'],persistedParts:{},localParts:{},draftsAt:0,hydration:null,scheduleCacheFlush:()=>{},partsJSON:(parts: any)=>Object.fromEntries(Object.entries(parts).map(([k,v])=>[k,JSON.stringify(v??null)]))});
 context.stateParts=()=>({manager:context.manager,messages:context.messages,tasks:context.tasks,goals:context.goals,details:context.details,drafts:context.drafts,pending:context.pending,cursor:context.cursor,readState:context.readState});
 vm.runInContext(persistSource,context);return {context,stored,errors};
}

test('unchanged Dots snapshots share their pending durability promise and are not resent after success',async()=>{
 const gate=deferred(),calls: any[]=[];
 const {context,stored}=persistence(async(...args: any[])=>{calls.push(args);await gate.promise;});
 const first=context.persist(),second=context.persist();assert.equal(first,second);
 let durable=false;first.then(()=>durable=true);await tick();assert.equal(calls.length,1);assert.equal(durable,false);
 (gate.resolve as any)?.();await first;await context.persist();assert.equal(calls.length,1);assert.equal(durable,true);assert.equal(stored.length,3);
 assert.equal(stored[0].key,'account-isolated');
});

test('a failed Dots save is retried for the identical snapshot',async()=>{
 let calls=0;const {context,errors}=persistence(async()=>{if(++calls===1)throw Error('offline');});
 await assert.rejects(context.persist(),/offline/);await context.persist();assert.equal(calls,2);assert.equal(errors.length,1);
});

test('changed Dots snapshots retain their captured values and ordering',async()=>{
 const gate=deferred(),calls: any[]=[];
 const {context}=persistence(async(_path: any,_method: any,body: any)=>{calls.push(JSON.parse(JSON.stringify(body.patch)));if(calls.length===1)await gate.promise;});
 context.drafts.text='first';const first=context.persist();
 context.drafts.text='second';context.pending.send={requestId:'pending-message'};const second=context.persist();
 context.drafts.text='third';delete context.pending.send;const third=context.persist();
 await tick();assert.equal(calls.length,1);(gate.resolve as any)?.();await Promise.all([first,second,third]);
 assert.deepEqual(calls.map(state=>state.drafts.text),['first','second','third']);
 assert.equal(calls[1].pending.send.requestId,'pending-message');assert.equal(calls[2].pending.send,undefined);
});

test('localStorage failure is reported before any Dots network write',async()=>{
 let calls=0;const {context}=persistence(async()=>calls++);context.localStorage.setItem=()=>{throw Error('quota');};
 assert.throws(()=>context.persist(),/无法保存 Dots 状态/);await tick();assert.equal(calls,0);
});

function refreshing(api: any){
 const approvals: any[]=[],saved: any[]=[],renders: any[]=[];
 const context=vm.createContext({Promise,refreshFlight:null,refreshQueuedForce:false,readState:{observedThrough:10},active:false,drawerOpen:false,selected:null,
  api,adopt:()=>{},reconcileUnreadGap:async()=>{},refreshApprovals:async (force: any)=>approvals.push(force),persist:async()=>saved.push(true),refreshContent:()=>renders.push(true)});
 vm.runInContext(refreshSource,context);return {context,approvals,saved,renders};
}

test('slow Dots refresh coalesces timer calls instead of building a backlog',async()=>{
 const gate=deferred();let calls=0;
 const {context,saved}=refreshing(async()=>{calls++;await gate.promise;return {};});
 const first=context.refresh();for(let i=0;i<20;i++)assert.equal(context.refresh(),first);
 await tick();assert.equal(calls,1);(gate.resolve as any)?.();await first;assert.equal(calls,1);assert.equal(saved.length,1);
});

test('forced approval refresh during a pending refresh gets one trailing pass',async()=>{
 const gate=deferred();let calls=0;
 const {context,approvals}=refreshing(async()=>{if(++calls===1)await gate.promise;return {};});
 const first=context.refresh();assert.equal(context.refresh(true),first);assert.equal(context.refresh(true),first);
 (gate.resolve as any)?.();await first;assert.equal(calls,2);assert.deepEqual(approvals,[false,true]);
});

test('failed refresh clears the in-flight slot for the next attempt',async()=>{
 let calls=0;const {context}=refreshing(async()=>{if(++calls===1)throw Error('offline');return {};});
 await assert.rejects(context.refresh(),/offline/);await context.refresh();assert.equal(calls,2);
});

test('photo priority disconnects background Dots monitoring and reconnects on release',async()=>{
 const listeners=new Map();let connections=0,disconnections=0,refreshes=0;
 const context=vm.createContext({window:{ShiYanUploadPriority:{active:false},addEventListener:(name: any,fn: any)=>listeners.set(name,fn)},document:{hidden:false},voice:{active:false},monitorReady:true,
  connect:()=>connections++,disconnect:()=>disconnections++,refresh:async()=>refreshes++,showError:()=>{}});
 vm.runInContext(monitorSource+'\n'+prioritySource,context);
 assert.equal(context.monitorAllowed(),true);context.window.ShiYanUploadPriority.active=true;
 listeners.get('shiyan-upload-priority-change')();assert.equal(context.monitorAllowed(),false);assert.equal(disconnections,1);
 context.window.ShiYanUploadPriority.active=false;listeners.get('shiyan-upload-priority-change')();await tick();assert.equal(connections,1);assert.equal(refreshes,1);
 context.document.hidden=true;listeners.get('shiyan-upload-priority-change')();assert.equal(connections,1);
});
