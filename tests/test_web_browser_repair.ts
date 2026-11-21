import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
const platformSource=fs.readFileSync(new URL('../shared/frontend/assets/platform.js',import.meta.url),'utf8');
const questionSource=fs.readFileSync(new URL('../shared/frontend/assets/user-input.js',import.meta.url),'utf8');
test('Web marks its platform and coalesces subscriptions until after window load',()=>{
 const listeners={},tasks=[];const document={readyState:'interactive',documentElement:{dataset:{}}};
 const window={__SHIYAN_PLATFORM__:{mode:'web'},addEventListener:(name,fn)=>listeners[name]=fn};
 vm.runInNewContext(platformSource,{window,document,setTimeout:fn=>tasks.push(fn)});
 assert.equal(document.documentElement.dataset.shiyanPlatform,'web');
 let calls=0;const subscribe=()=>calls++;
 assert.equal(window.ShiYanPlatform.deferUntilLoaded(subscribe),true);
 assert.equal(window.ShiYanPlatform.deferUntilLoaded(subscribe),true);
 assert.equal(calls,0);document.readyState='complete';listeners.load();
 assert.equal(calls,0);tasks.forEach(fn=>fn());assert.equal(calls,1);
 assert.equal(window.ShiYanPlatform.deferUntilLoaded(subscribe),false);
});
test('Desktop never defers its existing subscriptions',()=>{
 const document={readyState:'loading',documentElement:{dataset:{}}};const window={__SHIYAN_PLATFORM__:{mode:'desktop'}};
 vm.runInNewContext(platformSource,{window,document});assert.equal(window.ShiYanPlatform.deferUntilLoaded(()=>{}),false);
 assert.equal(document.documentElement.dataset.shiyanPlatform,'desktop');
});
function questions(mode='web',state='running'){
 const listeners={},calls=[];let tick,now=100000,result={pendingQuestions:[]},failure=null;
 const message={id:'m1',role:'assistant',remoteJobId:'j1',state};
 const snapshot={selectedConversationId:'c1',conversations:[{id:'c1',messages:[message]}]};
 const window={ShiYanPlatform:{mode},addEventListener:(name,fn)=>listeners[name]=fn,
  shiyan:{getState:()=>snapshot,getView:()=> 'agent',api:async path=>{calls.push(path);if(failure)throw failure;return result;}}};
 const document={hidden:false,addEventListener:()=>{},querySelector:()=>null};
 class Clock extends Date {static now(){return now;}}
 vm.runInNewContext(questionSource,{window,document,Date:Clock,setInterval:fn=>{tick=fn;},setTimeout:()=>1,clearTimeout:()=>{},console});
 return {poll:()=>tick(),calls,message,setResult:x=>result=x,setFailure:x=>failure=x,advance:ms=>now+=ms,document,window,listeners};
}
test('Web does not poll completed, failed, cancelled or interrupted messages',async()=>{
 for(const state of ['completed','failed','cancelled','interrupted']){const p=questions('web',state);await p.poll();await p.poll();assert.equal(p.calls.length,0);}
});
test('Active Web task questions remain enabled',async()=>{
 const p=questions();await p.poll();await p.poll();assert.equal(p.calls.length,2);
});
test('Missing active mailbox response is retried after 30 seconds, not 1.5',async()=>{
 const p=questions();p.setResult({pendingQuestions:[],unavailable:true,pollAfterMs:30000});
 await p.poll();p.advance(1500);await p.poll();assert.equal(p.calls.length,1);
 p.advance(28500);await p.poll();assert.equal(p.calls.length,2);
});
test('A failed old job cannot suppress questions for a newly selected job',async()=>{
 const p=questions();p.setFailure(Object.assign(new Error('missing'),{status:404}));
 await p.poll();await p.poll();assert.equal(p.calls.length,1);
 p.message.remoteJobId='j2';p.setFailure(null);await p.poll();assert.equal(p.calls.length,2);
});
test('Background tabs do not issue question polling requests',async()=>{
 const p=questions();p.document.hidden=true;await p.poll();assert.equal(p.calls.length,0);
});
test('Desktop stops polling completed, failed, cancelled and interrupted jobs',async()=>{
 for(const state of ['completed','failed','cancelled','interrupted']){
  const p=questions('desktop',state);
  await p.poll();await p.poll();assert.equal(p.calls.length,0);
 }
});
test('Desktop keeps active questions and backs off missing mailboxes',async()=>{
 const p=questions('desktop','running');await p.poll();await p.poll();
 assert.equal(p.calls.length,2);
 p.setFailure(Object.assign(new Error('missing'),{status:404}));
 await p.poll();await p.poll();assert.equal(p.calls.length,3);
 p.advance(30000);p.setFailure(null);await p.poll();assert.equal(p.calls.length,4);
});
