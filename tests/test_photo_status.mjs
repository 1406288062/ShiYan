import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../shared/frontend/assets/photo-status.js',import.meta.url),'utf8');
function setup(){let next=0;const timers=new Map();const context={window:{},AbortController,setTimeout:(fn,ms)=>{timers.set(++next,{fn,ms});return next},clearTimeout:id=>timers.delete(id)};vm.runInNewContext(source,context);return {api:context.window.ShiYanPhotoStatus,timers,run(ms){const entry=[...timers].find(([,t])=>t.ms===ms);assert(entry,`missing ${ms} timer`);timers.delete(entry[0]);entry[1].fn();}};}
const settle=async()=>{await Promise.resolve();await Promise.resolve();await Promise.resolve();};
test('completed result bypasses full state, stops polling, and returns its asset immediately',async()=>{
 const s=setup(),seen=[];let count=0;const poll=s.api.create({request:async id=>({job:{id,state:++count===1?'running':'completed'},assets:[{id:'asset-a'}]}),apply:x=>seen.push(x)});poll.watch('job-a');await settle();s.run(1000);await settle();assert.equal(seen.at(-1).job.state,'completed');assert.equal(seen.at(-1).assets[0].id,'asset-a');assert.equal(s.timers.size,0);
});
test('switching tasks aborts stale request and ignores late response',async()=>{
 const s=setup(),seen=[];let first,signal;const poll=s.api.create({request:(id,sig)=>{if(id==='job-a'){signal=sig;return new Promise(r=>first=r)}return Promise.resolve({job:{id,state:'completed'}})},apply:x=>seen.push(x.job.id)});poll.watch('job-a');poll.watch('job-b');await settle();first({job:{id:'job-a',state:'completed'}});await settle();assert(signal.aborted);assert.deepEqual(seen,['job-b']);assert.equal(s.timers.size,0);
});
test('requests never overlap; timeout retries and foreground refresh resumes promptly',async()=>{
 const s=setup();let count=0;const poll=s.api.create({request:(id,signal)=>{count++;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('timeout'))))},apply:()=>{}});poll.watch('job-a');poll.refresh();assert.equal(count,1);s.run(8000);await settle();s.run(3000);assert.equal(count,2);poll.stop();await settle();assert.equal(s.timers.size,0);
});
test('hidden tab pauses requests and refresh immediately resumes',async()=>{
 const s=setup();let visible=false,count=0;const poll=s.api.create({isVisible:()=>visible,request:async id=>{count++;return {job:{id,state:'cancelled'}}},apply:()=>{}});poll.watch('job-a');assert.equal(count,0);visible=true;poll.refresh();await settle();assert.equal(count,1);assert.equal(s.timers.size,0);
});
test('old full snapshots cannot regress completed jobs or remove their history',()=>{
 const s=setup(),completed={id:'job-a',state:'completed',photoRevision:4,updatedAt:'2026-10-24T08:01:00Z'},previous={photoJobs:[completed],history:[{id:'h-a',jobId:'job-a'}]};
 for(const jobs of [[],[{id:'job-a',state:'running',photoRevision:2,updatedAt:'2026-10-24T08:00:00Z'}]]){const merged=s.api.mergeSnapshot({photoJobs:jobs,history:[],conversations:['new-chat-state']},previous);assert.equal(merged.photoJobs[0].state,'completed');assert.equal(merged.history[0].id,'h-a');assert.equal(merged.conversations[0],'new-chat-state');}
 assert(s.api.newer({photoRevision:5},{photoRevision:4}));assert(!s.api.newer({photoRevision:3},{photoRevision:4}));
});

test('cancelling batches keep polling until all jobs have settled',async()=>{
 const s=setup(),seen=[];let count=0;
 const poll=s.api.create({request:async id=>({job:{id,state:++count===1?'cancelling':'cancelled'}}),apply:data=>seen.push(data.job.state)});
 poll.watch('batch-a');await settle();assert.deepEqual(seen,['cancelling']);s.run(1000);await settle();
 assert.deepEqual(seen,['cancelling','cancelled']);assert.equal(s.timers.size,0);
});

test('enhancement progress uses the same product wording for local and remote jobs',()=>{
 const {api}=setup();
 for(const [raw,expected] of [['Mac 正在接收图片','正在准备图片'],['正在准备图片','正在准备图片'],['Mac 正在回传图片','正在保存图片'],['正在保存图片','正在保存图片'],['加载增强模型','加载增强模型'],['Mac COS GPU 正在增强','正在增强']]){
  const value=api.label({state:'running',label:raw});assert.equal(value,expected);assert(!/mac|cos|gpu|mps|回传/i.test(value));
 }
 assert.equal(api.label({state:'queued',label:'等待 Mac 处理'}),'等待增强');
 assert.equal(api.label({state:'reconnecting',label:'等待恢复 Mac 连接'}),'正在重新连接');
 assert.equal(api.error('Mac COS 图片回传失败'),'图片增强暂时未完成，请重试');
 assert.equal(api.error('图片超过大小限制'),'图片超过大小限制');
});
