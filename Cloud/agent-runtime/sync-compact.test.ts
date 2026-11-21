import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { SyncStore, hydrateCompactMutation, hydrateMutation } from './sync-store.ts';

process.env.SHIYAN_SYNC_NO_LISTEN='1';
const { createSyncSidecar }=await import('./sync-sidecar.ts');
const owner='compact-owner';
const compactHeaders={'x-shiyan-sync-profile':'compact'};
const mutation=(kind,id,data,baseRevision=0)=>({mutationId:randomUUID(),kind,id,data,baseRevision,deleted:false});

async function fixture(t){
  const root=mkdtempSync(path.join(os.tmpdir(),'shiyan-compact-'));
  const store=new SyncStore(root);
  const server=createSyncSidecar({root,store,runtimeWrites:true,authenticate:req=>req.headers['x-test-anonymous']?null:{
    owner:req.headers['x-test-owner']||owner,platform:'macos',role:'admin',serverAccess:true,
    accountSession:true,deviceID:'mac-session-one',sessionId:'mac-session-one',
  }});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',()=>resolve()));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));rmSync(root,{recursive:true,force:true});});
  const base='http://127.0.0.1:'+(server.address() as any).port;
  const request=async(route: string,{method='GET',data,headers=compactHeaders}: { method?: string; data?: any; headers?: Record<string, string> }={})=>{
    const body=data===undefined?undefined:JSON.stringify(data);
    return fetch(base+'/v1/'+route,{method,headers:{...headers,...(body===undefined?{}:{'x-shiyan-body-sha':createHash('sha256').update(body).digest('hex')})},body});
  };
  return {store,request};
}

function largeMessage(store: any,{remoteJobId}: { remoteJobId?: any }={}){
  const cid=randomUUID(),id=randomUUID(),assetId=randomUUID();
  const asset=store.saveAsset(owner,{id:assetId,filename:'result.png',mimeType:'image/png',data:Buffer.from('test image bytes').toString('base64')});
  store.putAuthoritative(owner,'conversations',cid,{id:cid,title:'Compact transport'});
  const data={id,conversationId:cid,role:'assistant',text:'完整的聊天正文与附件保持不变。',state:'completed',
    createdAt:'2026-10-21T00:00:00Z',updatedAt:'2026-10-21T00:01:00Z',assets:[asset],
    rawResult:'full execution '.repeat(20000),
    fileChanges:Array.from({length:12},(_,i)=>({path:'/project/file-'+i+'.swift',kind:'update',added:123,removed:4,diff:'full difference '.repeat(10000)})),
    displayItems:Array.from({length:25},(_,i)=>({id:'command-'+i,type:'command_execution',status:'completed',command:'inspect',aggregated_output:'full output '.repeat(300)})),
    ...(remoteJobId?{remoteJobId,requestId:'request-'+remoteJobId}:{}),
  };
  store.putAuthoritative(owner,'messages',id,data);
  return {id,cid,asset,full:store.get(owner,'messages',id)};
}

test('macOS compact snapshots retain text, assets and full authorized details without altering storage',async t=>{
  const {store,request}=await fixture(t),{id,asset,full}=largeMessage(store);
  const response=await request('sync');assert.equal(response.status,200);
  const page: any=await response.json(),message=page.changes.find(c=>c.id===id);
  assert.ok(Buffer.byteLength(JSON.stringify(page))<96*1024);
  assert.equal(message.data.text,full.data.text);assert.deepEqual(message.data.assets,full.data.assets);
  assert.equal(message.data.rawResult,null);assert.equal(message.data.executionDetailsAvailable,true);
  assert.equal(message.revision,full.revision);assert.equal(message.data.fileChanges.length,12);
  assert.equal(message.data.fileChanges[0].diffTruncated,true);
  assert.deepEqual(store.get(owner,'messages',id),full);
  const details: any=await(await request('sync/messages/'+id+'/details')).json();
  assert.equal(details.rawResult,full.data.rawResult);assert.deepEqual(details.fileChanges,full.data.fileChanges);assert.deepEqual(details.displayItems,full.data.displayItems);
  const file=await request('sync/assets/'+asset.id);assert.equal(file.status,200);assert.equal(await file.text(),'test image bytes');
  assert.equal((await request('sync/messages/'+id+'/details',{headers:{...compactHeaders,'x-test-owner':'other-owner'}})).status,404);
  assert.equal((await request('sync',{headers:{...compactHeaders,'x-test-anonymous':'yes'}})).status,401);
  let legacy: any=await(await request('sync',{headers:{}})).json();
  if(!legacy.changes.some(c=>c.id===id))legacy=await(await request('sync?after='+legacy.cursor,{headers:{}})).json();
  assert.equal(legacy.changes.find(c=>c.id===id).data.rawResult,full.data.rawResult);
});

test('compact POST canonical receipts and conflicts stay small, including unchanged hydrated snapshots',async t=>{
  const {store,request}=await fixture(t),{id,full}=largeMessage(store,{remoteJobId:'remote-compact-job'});
  const page: any=await(await request('sync')).json();
  const edit=mutation('messages',id,{...full.data,state:'running',rawResult:null,fileChanges:[],displayItems:[]},full.revision);
  const response=await request('sync',{method:'POST',data:{after:page.cursor,mutations:[edit]}});
  assert.equal(response.status,200);const receipt: any=await response.json();
  assert.equal(receipt.accepted.length,1);assert.equal(receipt.cursor,page.cursor);
  const accepted=receipt.changes.find(c=>c.id===id);assert.equal(accepted.data.state,'completed');
  assert.equal(accepted.data.executionDetailsAvailable,true);assert.equal(accepted.data.rawResult,null);
  assert.ok(Buffer.byteLength(JSON.stringify(receipt))<96*1024);
  assert.deepEqual(store.get(owner,'messages',id)!.data,full.data);
  const conflictResponse=await request('sync',{method:'POST',data:{after:page.cursor,mutations:[{...edit,mutationId:randomUUID(),baseRevision:0}]}});
  const conflict: any=await conflictResponse.json();assert.equal(conflict.conflicts.length,1);
  assert.equal(conflict.conflicts[0].current.data.rawResult,null);assert.equal(conflict.conflicts[0].current.data.executionDetailsAvailable,true);
  assert.ok(Buffer.byteLength(JSON.stringify(conflict))<96*1024);
});

test('non-job compact message edits preserve canonical execution data and original mutation identity',async t=>{
  const {store,request}=await fixture(t),{id,full}=largeMessage(store);
  const page: any=await(await request('sync')).json(),wire=page.changes.find(c=>c.id===id);
  const edit=mutation('messages',id,{...wire.data,text:'用户修改了正文。'},wire.revision);
  const response=await request('sync',{method:'POST',data:{after:page.cursor,mutations:[edit]}});
  assert.equal(response.status,200);const first: any=await response.json();assert.equal(first.accepted.length,1);
  const stored=store.get(owner,'messages',id)!;assert.equal(stored.data.text,'用户修改了正文。');
  for(const key of ['rawResult','fileChanges','displayItems'])assert.deepEqual(stored.data[key],full.data[key]);
  assert.equal(Object.hasOwn(stored.data,'executionDetailsAvailable'),false);
  const latest={...stored.data,rawResult:'a newer complete execution record'};
  store.putAuthoritative(owner,'messages',id,latest);
  const retry=await request('sync',{method:'POST',data:{after:first.cursor,mutations:[edit]}});
  assert.equal(retry.status,200);const repeated: any=await retry.json();
  assert.deepEqual(repeated.accepted,first.accepted,'same original mutation remains idempotent after canonical details change');
  assert.equal(store.get(owner,'messages',id)!.data.rawResult,latest.rawResult);
  assert.equal(((await(await request('sync/messages/'+id+'/details')).json()) as any).rawResult,latest.rawResult);
});

test('compact restoration cannot read another owner, change the message identity or create partial records',async t=>{
  const {store,request}=await fixture(t),{id,full}=largeMessage(store);
  const wire=((await(await request('sync')).json()) as any).changes.find(c=>c.id===id).data;
  assert.throws(()=>hydrateCompactMutation(mutation('messages',id,wire,0),'other-owner',store),{status:409});
  assert.throws(()=>hydrateCompactMutation(mutation('messages',randomUUID(),wire,0),owner,store),{status:409});
  assert.throws(()=>hydrateCompactMutation(mutation('messages',id,{...wire,role:'user'},1),owner,store),{status:409});
  assert.throws(()=>hydrateCompactMutation(mutation('messages',id,{...wire,conversationId:randomUUID()},1),owner,store),{status:409});
  const denied=await request('sync',{method:'POST',headers:{...compactHeaders,'x-test-owner':'other-owner'},data:{mutations:[mutation('messages',id,wire,1)]}});
  assert.equal(denied.status,200);const missing: any=await denied.json();assert.equal(missing.conflicts[0].current.revision,0);
  assert.equal(missing.conflicts[0].current.data.rawResult,null);assert.equal(missing.conflicts[0].current.data.fileChanges,undefined);
  assert.equal(store.get('other-owner','messages',id),null);assert.deepEqual(store.get(owner,'messages',id),full);
  store.apply(owner,[{...mutation('messages',id,full.data,full.revision),deleted:true}]);
  const removed=await request('sync',{method:'POST',data:{mutations:[mutation('messages',id,wire,1)]}});
  assert.equal(removed.status,200);assert.equal(((await removed.json()) as any).conflicts[0].current.deleted,true);
});

test('a lost compact receipt can be retried after a later deletion without blocking the batch',async t=>{
  const {store,request}=await fixture(t),{id,full}=largeMessage(store);
  const wire=((await(await request('sync')).json()) as any).changes.find(c=>c.id===id).data;
  const edit=mutation('messages',id,{...wire,text:'edited'},full.revision);
  const first: any=await(await request('sync',{method:'POST',data:{mutations:[edit]}})).json();
  const current=store.get(owner,'messages',id)!;
  store.apply(owner,[{...mutation('messages',id,current.data,current.revision),deleted:true}]);
  const nextId=randomUUID();
  const retry=await request('sync',{method:'POST',data:{mutations:[edit,mutation('projects',nextId,{id:nextId,name:'new project'})]}});
  assert.equal(retry.status,200);const result: any=await retry.json();
  assert.deepEqual(result.accepted[0],first.accepted[0]);assert.equal(result.accepted.length,2);
  assert.equal(store.get(owner,'messages',id)!.deleted,true);assert.equal(store.get(owner,'projects',nextId)!.data.name,'new project');
});

test('explicit partial detail edits preserve every other canonical field and remain idempotent',async t=>{
  const {store,request}=await fixture(t);
  const edits={rawResult:null,fileChanges:[{path:'/project/new.swift',kind:'add',added:1,removed:0,diff:'+local complete difference'}],
    displayItems:[{id:'local-command',type:'command_execution',status:'completed',command:'inspect',aggregated_output:'local complete output'}]};
  for(const [field,value] of Object.entries(edits)){
    const {id,full}=largeMessage(store),after=Number(store.db.prepare('SELECT MAX(seq) AS seq FROM sync_changes WHERE owner=?').get(owner)!.seq)-1;
    const wire=((await(await request('sync?after='+after)).json()) as any).changes.find(c=>c.id===id)?.data;
    assert.ok(wire);assert.equal(wire.executionDetailsAvailable,true);
    const edit=mutation('messages',id,{...wire,[field]:value,executionDetailsChanged:[field]},full.revision);
    const response=await request('sync',{method:'POST',data:{after:store.list(owner).cursor,mutations:[edit]}});
    assert.equal(response.status,200);const receipt: any=await response.json();assert.equal(receipt.accepted.length,1);
    const saved=store.get(owner,'messages',id)!;
    for(const key of Object.keys(edits))assert.deepEqual(saved.data[key],key===field?value:full.data[key]);
    assert.equal(Object.hasOwn(saved.data,'executionDetailsAvailable'),false);assert.equal(Object.hasOwn(saved.data,'executionDetailsChanged'),false);
    const newer={...saved.data,rawResult:'newer canonical result'};store.putAuthoritative(owner,'messages',id,newer);
    const retry=await request('sync',{method:'POST',data:{after:store.list(owner).cursor,mutations:[edit]}});
    assert.equal(retry.status,200);assert.deepEqual(((await retry.json()) as any).accepted,receipt.accepted);
    assert.equal(store.get(owner,'messages',id)!.data.rawResult,newer.rawResult);
  }
});

test('partial detail declarations cannot override authoritative remote job details or execution state',async t=>{
  const {store,request}=await fixture(t),{id,cid,full}=largeMessage(store,{remoteJobId:'partial-details-job'});
  const wire=((await(await request('sync')).json()) as any).changes.find(c=>c.id===id).data;
  const files=[{path:'/project/local.swift',kind:'update',added:1,removed:1,diff:'-before\n+after'}];
  const edit=mutation('messages',id,{...wire,text:'stale reply',state:'running',fileChanges:files,executionDetailsChanged:['fileChanges']},full.revision);
  const restored=hydrateCompactMutation(edit,owner,store);
  const job={id:'partial-details-job',owner,requestId:'request-partial-details-job',text:'authoritative reply',status:'completed',updatedAt:Date.now(),assets:[],displayItems:[],fileChanges:full.data.fileChanges};
  const hydrated=hydrateMutation(restored,owner,{jobs:{[job.id]:job}});
  assert.deepEqual(hydrated.data.fileChanges,job.fileChanges);assert.equal(hydrated.data.text,job.text);assert.equal(hydrated.data.state,'completed');
  const response=await request('sync',{method:'POST',data:{mutations:[edit]}});
  assert.equal(response.status,200);assert.equal(((await response.json()) as any).accepted.length,1);
  const saved=store.get(owner,'messages',id)!;assert.deepEqual(saved.data.fileChanges,full.data.fileChanges);
  assert.equal(saved.data.text,full.data.text);assert.equal(saved.data.state,'completed');
  assert.equal(saved.data.rawResult,full.data.rawResult);assert.deepEqual(saved.data.displayItems,full.data.displayItems);
});

test('invalid partial detail declarations fail closed before changing any record',async t=>{
  const {store,request}=await fixture(t),{id,full}=largeMessage(store);
  const wire=((await(await request('sync')).json()) as any).changes.find(c=>c.id===id).data;
  for(const executionDetailsChanged of ['fileChanges',null,['text'],['fileChanges','fileChanges'],['missing']]){
    const response=await request('sync',{method:'POST',data:{mutations:[mutation('messages',id,{...wire,executionDetailsChanged},full.revision)]}});
    assert.equal(response.status,400);assert.deepEqual(store.get(owner,'messages',id),full);
  }
  const {fileChanges,...withoutValue}=wire;
  assert.throws(()=>hydrateCompactMutation(mutation('messages',id,{...withoutValue,executionDetailsChanged:['fileChanges']},full.revision),owner,store),{status:400});
  assert.throws(()=>hydrateCompactMutation(mutation('messages',id,{...wire,executionDetailsAvailable:false,executionDetailsChanged:['fileChanges']},full.revision),owner,store),{status:400});
});

test('compact transport keeps macOS schedule host proof requirements and execution reports',async t=>{
  const {store,request}=await fixture(t),id='compact-schedule-task';
  const key=generateKeyPairSync('ed25519'),raw=key.publicKey.export({format:'der',type:'spki'}).subarray(-32),deviceId=createHash('sha256').update(raw).digest('hex');
  const task={id,title:'Daily report',instruction:'Summarize available information',enabled:true,repeat:'daily',time:'09:00',timezone:'Asia/Shanghai',startDate:'2026-10-13',endDate:null,
    runLocally:true,newChatEachRun:false,notificationMode:'important',model:'test-model',reasoning:'low',projectId:null,executorDeviceId:deviceId,lastRunState:'completed'};
  const denied=await request('sync',{method:'POST',data:{mutations:[mutation('scheduledTasks',id,task)]}});
  assert.equal(denied.status,403,'compact header must not make a Mac an iOS config-only writer');
  assert.equal(store.get(owner,'scheduledTasks',id),null);
  const deviceTime=Date.now(),deviceNonce=randomUUID(),proof=['shiyan-schedule-host-v1',owner,deviceId,String(deviceTime),deviceNonce].join('\n');
  const host=await request('sync/schedules/host',{method:'POST',data:{deviceId,devicePublicKey:raw.toString('base64'),deviceTime,deviceNonce,deviceSignature:sign(null,Buffer.from(proof),key.privateKey).toString('base64')}});
  assert.equal(host.status,200);
  const accepted=await request('sync',{method:'POST',data:{mutations:[mutation('scheduledTasks',id,task)]}});
  assert.equal(accepted.status,200);assert.equal(((await accepted.json()) as any).accepted.length,1);
  const saved=store.get(owner,'scheduledTasks',id)!;assert.equal(saved.data.executorDeviceId,deviceId);assert.equal(saved.data.lastRunState,'completed');
});
