import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, createHash, randomUUID, sign } from 'node:crypto';
import { mobileSyncChange } from './sync-mobile-projection.ts';
import { SyncStore, hydrateMutation, hydrateStoredMutation, materializeJob, readSyncAsset, jobMessageData } from './sync-store.ts';

const fixture=()=>{const root=mkdtempSync(path.join(os.tmpdir(),'shiyan-sync-'));const store=new SyncStore(root);return {root,store,done(){store.close();rmSync(root,{recursive:true,force:true});}};};
const mutation=(kind: any,id: any,data: any,baseRevision=0,deleted=false)=>({mutationId:randomUUID(),kind,id,data,baseRevision,deleted});
const project=(id: any)=>({id,name:'测试项目',createdAt:'2026-10-11T00:00:00.000Z'});
const assistant=(id: any,cid: any,requestId: any)=>({id,conversationId:cid,role:'assistant',text:'旧内容',requestId,assets:[],state:'running'});
const job=(overrides={})=>({id:randomUUID(),owner:'owner-a',requestId:'request-opaque-UPPER',conversationKey:'remote-key',text:'实际模型输出',status:'completed',createdAt:1791710000000,startedAt:1791710001000,updatedAt:1791710002000,reasoning:'high',model:'test-model',threadId:'thread-opaque-UPPER',assets:[],events:[],...overrides});

test('CAS rejects simultaneous stale edit, mutation retries are idempotent, and tombstones never revive',()=>{
  const f=fixture();try{
    const id=randomUUID(),first=mutation('projects',id,project(id));const a=f.store.apply('owner-a',[first]);assert.equal(a.accepted[0].revision,1);
    assert.equal(f.store.apply('owner-a',[first]).accepted[0].revision,1);
    assert.throws(()=>f.store.apply('owner-a',[{...first,data:{...first.data,name:'different'}}]),/标识已使用/);
    const edit=mutation('projects',id,{...project(id),name:'设备一编辑'},1);assert.equal(f.store.apply('owner-a',[edit]).accepted[0].revision,2);
    const stale=f.store.apply('owner-a',[mutation('projects',id,{...project(id),name:'设备二编辑'},1)]);assert.equal(stale.conflicts[0].current.data.name,'设备一编辑');
    f.store.apply('owner-a',[mutation('projects',id,{},2,true)]);
    assert.equal(f.store.apply('owner-a',[mutation('projects',id,project(id),3)]).conflicts[0].current.deleted,true);
    assert.equal(f.store.putAuthoritative('owner-a','projects',id,project(id))!.deleted,true);
  }finally{f.done();}
});

test('cursor pagination is complete and private to owner despite global sequence gaps',()=>{
  const f=fixture();try{
    for(let n=0;n<5;n++){const id=randomUUID();f.store.apply(n%2?'owner-b':'owner-a',[mutation('projects',id,project(id))]);}
    let after=0,ids: any[]=[];while(true){const r=f.store.list('owner-a',after,1);ids.push(...r.changes.map(x=>x.id));after=r.cursor;if(!r.hasMore)break;}
    assert.equal(ids.length,3);assert.equal(new Set(ids).size,3);assert.equal(f.store.list('owner-b').changes.length,2);assert.equal(f.store.list('owner-c').changes.length,0);
    assert.throws(()=>f.store.list('owner-a',-1),/游标/);
  }finally{f.done();}
});

test('batch transaction rolls back malformed later mutation and never accepts local-only fields',()=>{
  const f=fixture();try{
    const cid=randomUUID(),mid=randomUUID();assert.throws(()=>f.store.apply('owner-a',[mutation('projects',cid,project(cid)),mutation('messages',mid,{id:mid,role:'assistant'})]),/消息/);assert.equal(f.store.list('owner-a').changes.length,0);
    f.store.apply('owner-a',[mutation('conversations',cid,{id:cid,title:'标题',draft:'草稿',queuedMessages:['x'],pendingJobId:'local',lastEventId:99,fileChangeRoots:['/local'],projectId:null})]);
    const data=f.store.get('owner-a','conversations',cid)!.data;assert.equal(data.title,'标题');assert.equal(data.draft,undefined);assert.equal(data.pendingJobId,undefined);assert.equal(data.lastEventId,undefined);
  }finally{f.done();}
});

test('worker start timestamp never replaces the original message request timestamp',()=>{
  const createdAt=1791710000000,requestStartedAt=new Date(createdAt).toISOString();
  const base={id:randomUUID(),conversationId:randomUUID(),role:'assistant',createdAt:requestStartedAt,requestStartedAt,state:'running'};
  const snapshot=jobMessageData(job({createdAt,startedAt:createdAt+25000,status:'running'}),base);
  assert.equal(snapshot.requestStartedAt,requestStartedAt);
  const fallback=jobMessageData(job({createdAt,startedAt:createdAt+25000,status:'running'}),{...base,requestStartedAt:undefined});
  assert.equal(fallback.requestStartedAt,requestStartedAt);
});

test('legacy request binding uses real model reply, preserves user text and strips local asset URLs',()=>{
  const f=fixture();try{
    const cid=randomUUID(),mid=randomUUID(),uid=randomUUID(),artifact=randomUUID(),j=job({assets:[{id:artifact,filename:'reply.jpg',mimeType:'image/jpeg',bytes:4,sha256:'hash'}]});
    const raw=mutation('messages',mid,{...assistant(mid,cid,j.requestId),text:'不应覆盖模型',assets:[{id:randomUUID(),syncAssetId:artifact,url:'http://127.0.0.1/file',path:'/local'}],submissionFailed:true});
    const state={jobs:{[j.id]:j},requests:{['owner-a:'+j.requestId]:j.id}};
    f.store.apply('owner-a',[hydrateMutation(raw,'owner-a',state)]);
    assert.equal(f.store.get('owner-a','messages',mid)!.data.text,j.text);assert.equal(f.store.get('owner-a','messages',mid)!.data.state,'completed');assert.equal(f.store.get('owner-a','messages',mid)!.data.assets[0].syncAssetId,artifact);assert.equal(f.store.get('owner-a','messages',mid)!.data.assets[0].url,undefined);
    j.text='后续权威输出';j.updatedAt++;assert.equal(f.store.apply('owner-a',[hydrateMutation(raw,'owner-a',state)]).accepted[0].revision,1,'same original mutation remains idempotent as job advances');
    f.store.apply('owner-a',[mutation('messages',uid,{id:uid,conversationId:cid,role:'user',text:'用户原文',requestId:j.requestId,assets:[]})]);materializeJob(f.store,j,{id:'remote-UPPER',threadId:j.threadId});
    assert.equal(f.store.get('owner-a','messages',uid)!.data.text,'用户原文');assert.equal(f.store.get('owner-a','messages',uid)!.data.state,'completed');assert.equal(f.store.get('owner-a','messages',mid)!.data.text,j.text);
    const sameRevision=f.store.get('owner-a','messages',mid)!.revision;materializeJob(f.store,j,{id:'remote-UPPER',threadId:j.threadId});assert.equal(f.store.get('owner-a','messages',mid)!.revision,sameRevision);
  }finally{f.done();}
});

test('stable local conversation survives remote forks; deleted conversation and message are never recreated',()=>{
  const f=fixture();try{
    const cid=randomUUID(),uid=randomUUID(),mid=randomUUID(),j=job({syncConversationId:cid,userMessageId:uid,assistantMessageId:mid});
    f.store.apply('owner-a',[mutation('conversations',cid,{id:cid,title:'手动标题',titleIsManual:true})]);
    materializeJob(f.store,j,{id:'remote-fork-UPPER',title:'自动标题'});assert.equal(f.store.get('owner-a','conversations',cid)!.data.title,'手动标题');assert.equal(f.store.get('owner-a','conversations',cid)!.data.remoteConversationId,'remote-fork-UPPER');
    materializeJob(f.store,{...j,updatedAt:j.updatedAt-1000},{id:'older-remote'});assert.equal(f.store.get('owner-a','conversations',cid)!.data.remoteConversationId,'remote-fork-UPPER');
    const rev=f.store.get('owner-a','messages',mid)!.revision;f.store.apply('owner-a',[mutation('messages',mid,{},rev,true)]);materializeJob(f.store,{...j,updatedAt:j.updatedAt+1000},{id:'remote-fork-UPPER'});assert.equal(f.store.get('owner-a','messages',mid)!.deleted,true);
    const cr=f.store.get('owner-a','conversations',cid)!.revision;f.store.apply('owner-a',[mutation('conversations',cid,{},cr,true)]);materializeJob(f.store,{...j,updatedAt:j.updatedAt+2000},{id:'remote-fork-UPPER'});assert.equal(f.store.get('owner-a','conversations',cid)!.deleted,true);
  }finally{f.done();}
});

test('SQLite is persistent and coordinates two connections without duplicate authoritative revisions',()=>{
  const f=fixture();let other;try{
    const id=randomUUID();f.store.apply('owner-a',[mutation('projects',id,project(id))]);other=new SyncStore(f.root);
    assert.equal(other.get('owner-a','projects',id)!.revision,1);other.putAuthoritative('owner-a','projects',id,project(id));assert.equal(f.store.get('owner-a','projects',id)!.revision,1);
    other.apply('owner-a',[mutation('projects',id,{...project(id),name:'other connection'},1)]);assert.equal(f.store.apply('owner-a',[mutation('projects',id,project(id),1)]).conflicts[0].current.revision,2);
  }finally{other?.close();f.done();}
});

test('asset upload is immutable, owner isolated, byte checked; generated artifacts share UUID without copying',()=>{
  const f=fixture();try{
    const id=randomUUID(),bytes=Buffer.from('binary attachment\0'),input={id,filename:'attachment.bin',mimeType:'application/octet-stream',data:bytes.toString('base64')};
    const a=f.store.saveAsset('owner-a',input);assert.equal(a.syncAssetId,id);assert.equal(f.store.saveAsset('owner-a',input).sha256,a.sha256);assert.equal(f.store.asset('owner-b',id),null);
    assert.throws(()=>f.store.saveAsset('owner-a',{...input,data:Buffer.from('changed').toString('base64')}),/标识已使用/);
    assert.throws(()=>f.store.saveAsset('owner-a',{...input,id:randomUUID(),data:'%%%'}),/附件无效/);
    const generated=randomUUID(),state={assets:{[generated]:{owner:'owner-a',file:f.store.assetFile('owner-a',id),filename:'gen.jpg',mimeType:'image/jpeg',bytes:bytes.length}}};assert.equal(readSyncAsset(f.store,state,'owner-a',generated)!.metadata.syncAssetId,generated);assert.equal(readSyncAsset(f.store,state,'owner-b',generated),null);
  }finally{f.done();}
});

test('legacy signature verifier covers full path/query and synchronizes two devices without restarting executor',async()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'shiyan-sync-http-'));mkdirSync(path.join(root,'data'));writeFileSync(path.join(root,'data/state.json'),JSON.stringify({jobs:{},conversations:{},assets:{},requests:{}}));
  const keys=[generateKeyPairSync('ed25519'),generateKeyPairSync('ed25519'),generateKeyPairSync('ed25519')];const registry={};
  const identities=keys.map((key,n)=>{const raw=key.publicKey.export({format:'der',type:'spki'}).subarray(-32),id=createHash('sha256').update(raw).digest('hex');(registry as any)[id]={approved:true,publicKey:raw.toString('base64'),owner:n===2?'owner-b':'owner-a'};return {id,key:key.privateKey};});
  writeFileSync(path.join(root,'devices.json'),JSON.stringify(registry));process.env.SHIYAN_ROOT=root;process.env.SHIYAN_SYNC_NO_LISTEN='1';
  const {createSyncSidecar}=await import('./sync-sidecar.ts');const {authenticateLegacyDevice}=await import('./device-auth.ts');const server=createSyncSidecar({root,authenticate:authenticateLegacyDevice});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',()=>resolve()));const base='http://127.0.0.1:'+(server.address() as any).port;
  async function request(device: any,method: any,route: any,data: any=undefined,sentRoute=route){const body=data===undefined?'':JSON.stringify(data),timestamp=Date.now(),nonce=randomUUID(),digest=createHash('sha256').update(body).digest('hex');const message=[method,route,String(timestamp),nonce,digest].join('\n');return fetch(base+sentRoute,{method,headers:{'Content-Type':'application/json','x-shiyan-device':device.id,'x-shiyan-time':String(timestamp),'x-shiyan-nonce':nonce,'x-shiyan-body-sha':digest,'x-shiyan-signature':sign(null,Buffer.from(message),device.key).toString('base64')},...(method==='POST'?{body}:{})});}
  try{
    const id=randomUUID(),m=mutation('projects',id,project(id));assert.equal((await request(identities[0],'POST','/shiyan/v1/sync',{after:0,mutations:[m]})).status,200);
    const read: any=await(await request(identities[1],'GET','/shiyan/v1/sync?after=0&limit=200')).json();assert.equal(read.changes[0].id,id);assert.equal(((await(await request(identities[2],'GET','/shiyan/v1/sync?after=0')).json()) as any).changes.length,0);
    assert.equal((await request(identities[0],'GET','/shiyan/v1/sync?after=0',undefined,'/shiyan/v1/sync?after=1')).status,401);
    const assetId=randomUUID(),bytes=Buffer.from('same-owner-download');assert.equal((await request(identities[0],'POST','/shiyan/v1/sync/assets',{id:assetId,filename:'test.txt',mimeType:'text/plain',data:bytes.toString('base64')})).status,200);
    assert.equal(await(await request(identities[1],'GET','/shiyan/v1/sync/assets/'+assetId)).text(),bytes.toString());assert.equal((await request(identities[2],'GET','/shiyan/v1/sync/assets/'+assetId)).status,404);
    const cid=randomUUID(),mid=randomUUID(),j=job({status:'running',text:'实时输出'}),remote={id:'remote-fork-UPPER',threadId:j.threadId};
    const state={jobs:{[j.id]:j},requests:{['owner-a:'+j.requestId]:j.id},conversations:{[j.conversationKey]:remote},assets:{}};
    writeFileSync(path.join(root,'data/state.json'),JSON.stringify(state));
    const push: any=await(await request(identities[0],'POST','/shiyan/v1/sync',{after:0,mutations:[mutation('conversations',cid,{id:cid,title:'历史标题',remoteConversationId:remote.id}),mutation('messages',mid,assistant(mid,cid,j.requestId))]})).json();
    const legacy=push.changes.filter((change: any)=>change.id===mid).at(-1);assert.equal(legacy.data.text,'实时输出');assert.equal(legacy.data.state,'running');
    j.status='completed';j.text='已完成的权威输出';j.updatedAt+=5000;writeFileSync(path.join(root,'data/state.json'),JSON.stringify(state));
    const second: any=await(await request(identities[1],'GET','/shiyan/v1/sync?after='+push.cursor)).json();const finished=second.changes.filter((change: any)=>change.id===mid).at(-1);assert.equal(finished.data.text,j.text);assert.equal(finished.data.state,'completed');assert.equal(finished.data.remoteJobId,j.id);
    assert.equal(((await(await request(identities[1],'GET','/shiyan/v1/sync?after='+second.cursor)).json()) as any).changes.length,0,'unchanged job does not generate repeat revisions');
  }finally{await new Promise(resolve=>server.close(resolve));rmSync(root,{recursive:true,force:true});}
});

test('legacy phone conversation title updates before message upload without creating duplicate messages or reviving deletions',()=>{
 const f=fixture();try{
  const cid=randomUUID(),j=job();
  f.store.apply(j.owner,[mutation('conversations',cid,{id:cid,title:'新聊天',updatedAt:new Date(j.createdAt-1000).toISOString()})]);
  materializeJob(f.store,j,{id:cid.toUpperCase(),title:'鹈鹕骑车SVG动画'});
  assert.equal(f.store.get(j.owner,'conversations',cid)!.data.title,'鹈鹕骑车SVG动画');
  assert.equal(f.store.get(j.owner,'conversations',cid)!.data.threadId,j.threadId);
  assert.equal(f.store.list(j.owner).changes.some(c=>c.kind==='messages'),false);
  const revision=f.store.get(j.owner,'conversations',cid)!.revision;
  materializeJob(f.store,j,{id:cid.toUpperCase(),title:'鹈鹕骑车SVG动画'});
  assert.equal(f.store.get(j.owner,'conversations',cid)!.revision,revision);
  f.store.apply(j.owner,[mutation('conversations',cid,{...f.store.get(j.owner,'conversations',cid)!.data,title:'手动命名',titleIsManual:true},revision)]);
  materializeJob(f.store,{...j,updatedAt:j.updatedAt+1000},{id:cid.toUpperCase(),title:'自动覆盖'});
  assert.equal(f.store.get(j.owner,'conversations',cid)!.data.title,'手动命名');
  f.store.apply(j.owner,[mutation('conversations',cid,{},f.store.get(j.owner,'conversations',cid)!.revision,true)]);
  materializeJob(f.store,{...j,updatedAt:j.updatedAt+2000},{id:cid.toUpperCase(),title:'不要复活'});
  assert.equal(f.store.get(j.owner,'conversations',cid)!.deleted,true);
  const absent=randomUUID();materializeJob(f.store,j,{id:absent,title:'不存在'});assert.equal(f.store.get(j.owner,'conversations',absent),null);
 }finally{f.done();}
});

test('large repeated tool updates compact to newest revision and bounded pages reach completion',()=>{
  const f=fixture();try{
    const cid=randomUUID(),mid=randomUUID();
    f.store.putAuthoritative('owner-a','conversations',cid,{id:cid,title:'existing'});
    for(let n=0;n<160;n++)f.store.putAuthoritative('owner-a','messages',mid,{...assistant(mid,cid,'request'),text:'x'.repeat(58000)+n});
    f.store.putAuthoritative('owner-a','messages',mid,{...assistant(mid,cid,'request'),text:'finished',state:'completed'});
    const page=f.store.list('owner-a');assert.equal(page.hasMore,false);assert.equal(page.changes.length,2);
    assert.equal(page.changes[0].kind,'conversations');assert.equal(page.changes[1].data.state,'completed');
    assert.ok(Buffer.byteLength(JSON.stringify(page))<2000);
    for(let n=0;n<8;n++){const id=randomUUID();f.store.putAuthoritative('owner-a','messages',id,{...assistant(id,cid,'r'+n),text:'文'.repeat(100000)});}
    let cursor=page.cursor,seen: any[]=[];
    for(let n=0;n<10;n++){const next=f.store.list('owner-a',cursor);assert.ok(next.cursor>cursor);cursor=next.cursor;seen.push(...next.changes.filter(x=>x.kind==='messages').map(x=>x.id));if(!next.hasMore)break;}
    assert.equal(new Set(seen).size,8);assert.equal(f.store.list('owner-a',cursor).changes.length,0);
  }finally{f.done();}
});

test('offline cursor receives completed snapshot before historical running revisions are replayed',()=>{
  const f=fixture();try{
    const cid=randomUUID(),mid=randomUUID();
    f.store.putAuthoritative('owner-a','conversations',cid,{id:cid,title:'offline'});
    for(let n=0;n<220;n++)f.store.putAuthoritative('owner-a','messages',mid,{...assistant(mid,cid,'request'),text:'tool '+n});
    f.store.putAuthoritative('owner-a','messages',mid,{...assistant(mid,cid,'request'),text:'done',state:'completed'});
    const page=f.store.list('owner-a',0,2);
    assert.equal(page.hasMore,false);assert.equal(page.cursor,222);
    assert.equal(page.changes.find(x=>x.id===mid).data.state,'completed');
    assert.equal(page.changes.find(x=>x.id===mid).revision,221);
    const rest=f.store.list('owner-a',page.cursor);
    assert.equal(rest.changes.length,0);
    f.store.apply('owner-a',[mutation('messages',mid,{},221,true)]);
    assert.equal(f.store.list('owner-a',0,2).changes.find(x=>x.id===mid).deleted,true);
  }finally{f.done();}
});

test('backlog pagination sends each newest entity once and includes conversation before new messages',()=>{
  const f=fixture();try{
    const cid=randomUUID(),mid=randomUUID(),uid=randomUUID();
    f.store.putAuthoritative('owner-a','conversations',cid,{id:cid,title:'initial'});
    f.store.putAuthoritative('owner-a','messages',uid,{id:uid,conversationId:cid,role:'user',text:'new user'});
    for(let n=0;n<500;n++)f.store.putAuthoritative('owner-a','messages',mid,{...assistant(mid,cid,'request'),text:'x'.repeat(5000)+n});
    f.store.putAuthoritative('owner-a','conversations',cid,{id:cid,title:'latest'});
    let cursor=0,seen: any[]=[],localConversations=new Set();
    for(let n=0;n<10;n++){
      const page=f.store.list('owner-a',cursor,1);assert.ok(page.cursor>cursor);
      for(const change of page.changes){
        if(change.kind==='conversations')localConversations.add(change.id);
        if(change.kind==='messages'){assert.ok(localConversations.has(change.data.conversationId));seen.push(change.id);}
      }
      cursor=page.cursor;if(!page.hasMore)break;
    }
    assert.deepEqual(seen,[uid,mid]);
    const newId=randomUUID();f.store.putAuthoritative('owner-a','messages',newId,{...assistant(newId,cid,'new-request'),text:'next message',state:'completed'});
    const next=f.store.list('owner-a',cursor);assert.equal(next.changes.find(x=>x.id===newId).data.text,'next message');
    assert.equal(f.store.list('owner-b',0).changes.length,0);
  }finally{f.done();}
});

test('stored executor output hydrates stale phone mutations without loading execution archive',()=>{
 const f=fixture();try{
  const cid=randomUUID(),mid=randomUUID(),j=job();
  f.store.putAuthoritative('owner-a','messages',mid,jobMessageFixture(j,mid,cid));
  const original=mutation('messages',mid,{...assistant(mid,cid,j.requestId),remoteJobId:j.id});
  const hydrated=hydrateStoredMutation(original,'owner-a',f.store);
  assert.equal(hydrated.data.state,'completed');assert.equal(hydrated.data.text,j.text);
  assert.equal(hydrateStoredMutation(original,'owner-b',f.store),original);
  const byJob=hydrateStoredMutation({...original,data:{...original.data,requestId:undefined}},'owner-a',f.store);
  assert.equal(byJob.data.state,'completed');
  f.store.apply('owner-a',[{...hydrated,baseRevision:1}]);
 }finally{f.done();}
 function jobMessageFixture(j: any,id: any,cid: any){return{...assistant(id,cid,j.requestId),remoteJobId:j.id,text:j.text,state:'completed'};}
});

test('runtime-backed sidecar serves and hydrates SQLite without parsing unavailable archive',async()=>{
 const f=fixture();process.env.SHIYAN_SYNC_NO_LISTEN='1';
 const {createSyncSidecar}=await import('./sync-sidecar.ts');
 const server=createSyncSidecar({root:f.root,store:f.store,runtimeWrites:true,authenticate:()=>({owner:'owner-a'})});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',()=>resolve()));
 const base='http://127.0.0.1:'+(server.address() as any).port;
 try{
  mkdirSync(path.join(f.root,'data'));writeFileSync(path.join(f.root,'data/state.json'),'invalid archive must not be read');
  const cid=randomUUID(),mid=randomUUID(),j=job();
  f.store.putAuthoritative('owner-a','conversations',cid,{id:cid,title:'live'});
  f.store.putAuthoritative('owner-a','messages',mid,{...assistant(mid,cid,j.requestId),remoteJobId:j.id,text:'done',state:'completed'});
  const read: any=await(await fetch(base+'/v1/sync')).json();assert.equal(read.ok,true);assert.equal(read.changes.find((x: any)=>x.id===mid).data.state,'completed');
  const input={after:read.cursor,mutations:[mutation('messages',mid,{...assistant(mid,cid,j.requestId),remoteJobId:j.id},1)]};
  const body=JSON.stringify(input);const posted: any=await(await fetch(base+'/v1/sync',{method:'POST',headers:{'x-shiyan-body-sha':createHash('sha256').update(body).digest('hex')},body})).json();
  assert.equal(posted.ok,true);assert.equal(f.store.get('owner-a','messages',mid)!.data.state,'completed');
 }finally{await new Promise(resolve=>server.close(resolve));rmSync(f.root,{recursive:true,force:true});}
});

test('generated asset references stay private and survive restart without execution archive reads',()=>{
 const f=fixture();try{
  const id=randomUUID(),file=path.join(f.root,'artifacts',id+'.txt');mkdirSync(path.dirname(file));writeFileSync(file,'generated');
  const asset={id,owner:'owner-a',file,filename:'result.txt',mimeType:'text/plain',bytes:9,sha256:createHash('sha256').update('generated').digest('hex')};
  f.store.registerGeneratedAsset(asset);
  assert.equal(readSyncAsset(f.store,{},'owner-a',id)!.file,file);
  assert.equal(readSyncAsset(f.store,{},'owner-b',id),null);
  assert.equal(f.store.registerGeneratedAsset({...asset,id:randomUUID(),file:'/etc/passwd'}),null);
  const second=new SyncStore(f.root);try{assert.equal(second.asset('owner-a',id).filename,'result.txt');assert.equal(second.assetFile('owner-a',id),file);}finally{second.close();}
  assert.equal(f.store.saveAsset('owner-a',{id,filename:'result.txt',mimeType:'text/plain',data:Buffer.from('generated').toString('base64')}).id,id);
 }finally{f.done();}
});

test('unchanged hydrated acceptance returns canonical completion beyond a caught-up cursor',()=>{
 const f=fixture();try{
  const cid=randomUUID(),mid=randomUUID(),j=job();
  f.store.putAuthoritative('owner-a','conversations',cid,{id:cid,title:'canonical'});
  f.store.putAuthoritative('owner-a','messages',mid,{...assistant(mid,cid,j.requestId),remoteJobId:j.id,text:'done',state:'completed'});
  const before=f.store.list('owner-a');
  const original=mutation('messages',mid,{...f.store.get('owner-a','messages',mid)!.data,state:'cancelled'},1);
  const hydrated=hydrateStoredMutation(original,'owner-a',f.store);
  const reply=f.store.apply('owner-a',[hydrated],before.cursor);
  assert.equal(reply.cursor,before.cursor);assert.equal(reply.accepted[0].revision,1);
  assert.equal(reply.changes.find((x: any)=>x.id===mid).data.state,'completed');
  assert.equal(reply.changes[0].kind,'conversations');
  assert.equal(f.store.apply('owner-a',[hydrated],reply.cursor).changes.find((x: any)=>x.id===mid).data.text,'done');
 }finally{f.done();}
});

test('canonical receipt for deletion of an unsynced message does not require a parent',()=>{
 const f=fixture();try{
  const id=randomUUID();const reply=f.store.apply('owner-a',[mutation('messages',id,{},0,true)]);
  assert.equal(reply.accepted.length,1);assert.equal(reply.changes[0].deleted,true);
 }finally{f.done();}
});

test('mobile sync bounds verbose execution data while preserving full records and conversation content',()=>{
 const f=fixture();try{
  const cid=randomUUID(),mid=randomUUID();f.store.putAuthoritative('owner-a','conversations',cid,{id:cid,title:'large MCP'});
  const files=Array.from({length:52},(_,i)=>({path:'file-'+i+'.swift',kind:'update',added:123,removed:4,diff:'差异'.repeat(10000)}));
  const data={...assistant(mid,cid,'req'),text:'完整正文保持原样',state:'completed',rawResult:'raw'.repeat(100000),fileChanges:files,displayItems:Array.from({length:30},(_,i)=>({id:'tool-'+i,type:'command_execution',status:'completed',command:'command',aggregated_output:'output'.repeat(500)}))};
  f.store.putAuthoritative('owner-a','messages',mid,data);
  const original=f.store.get('owner-a','messages',mid)!;
  const page=f.store.list('owner-a',0,200,{mobile:true}),mobile=page.changes.find(x=>x.id===mid);
  assert.ok(Buffer.byteLength(JSON.stringify(page))<96*1024);assert.equal(mobile.data.text,data.text);assert.equal(mobile.data.state,'completed');assert.equal(mobile.data.fileChanges.length,52);assert.equal(mobile.data.fileChanges[0].added,123);assert.equal(mobile.data.rawResult,null);assert.equal(mobile.data.executionDetailsAvailable,true);
  assert.deepEqual(mobileSyncChange(mobile),mobile,'projection remains stable through receipt shaping');
  assert.equal(f.store.get('owner-a','messages',mid)!.data.rawResult,data.rawResult);assert.deepEqual(f.store.get('owner-a','messages',mid)!.data.fileChanges,files);assert.equal(f.store.list('owner-a',1).changes.find(x=>x.id===mid).data.rawResult,data.rawResult);
  assert.equal(mobile.revision,original.revision);assert.equal(f.store.list('owner-b',0,200,{mobile:true}).changes.length,0);
 }finally{f.done();}
});

test('mobile profile serves compact snapshots and authenticated full details separately',async()=>{
 const f=fixture();process.env.SHIYAN_SYNC_NO_LISTEN='1';const {createSyncSidecar}=await import('./sync-sidecar.ts');
 const server=createSyncSidecar({root:f.root,store:f.store,runtimeWrites:true,authenticate:req=>({owner:req.headers['x-test-owner']||'owner-a',platform:'ios'})});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',()=>resolve()));
 try{
  const mid=randomUUID(),cid=randomUUID();f.store.putAuthoritative('owner-a','conversations',cid,{id:cid,title:'details'});f.store.putAuthoritative('owner-a','messages',mid,{...assistant(mid,cid,'req'),rawResult:'full raw'.repeat(20000),fileChanges:[{path:'big.swift',diff:'full diff'.repeat(150000)}]});
  const base='http://127.0.0.1:'+(server.address() as any).port;
  const compact: any=await(await fetch(base+'/v1/sync')).json();assert.equal(compact.changes.find((x: any)=>x.id===mid).data.rawResult,null);
  const details: any=await(await fetch(base+'/v1/sync/messages/'+mid+'/details')).json();assert.equal(details.rawResult,'full raw'.repeat(20000));assert.equal(details.fileChanges[0].diff,'full diff'.repeat(150000));
  assert.equal((await fetch(base+'/v1/sync/messages/'+mid+'/details',{headers:{'x-test-owner':'owner-b'}})).status,404);
 }finally{await new Promise(resolve=>server.close(resolve));rmSync(f.root,{recursive:true,force:true});}
});

test('completed assistant output cannot regress when a late running snapshot is accepted',()=>{
 const f=fixture();try{const id=randomUUID(),cid=randomUUID(),request=randomUUID();const complete={...assistant(id,cid,request),remoteJobId:'original-job',state:'completed',text:'你好！',completedAt:'2026-10-14T00:00:05Z'};
 const saved=f.store.putAuthoritative('owner-a','messages',id,complete)!;
 const late={...complete,state:'running',text:'',completedAt:null,phase:'请求已接收'};
 const reply=f.store.apply('owner-a',[mutation('messages',id,late,saved.revision)]);assert.equal(reply.accepted.length,1);assert.deepEqual(f.store.get('owner-a','messages',id)!.data,saved.data);
 f.store.putAuthoritative('owner-a','messages',id,late);assert.equal(f.store.get('owner-a','messages',id)!.data.state,'completed');
 const fresh={...late,remoteJobId:'new-job',requestId:'new-request'};f.store.putAuthoritative('owner-a','messages',id,fresh);assert.equal(f.store.get('owner-a','messages',id)!.data.state,'running');
 }finally{f.done();}
});

test('failed unaccepted submissions ignore only stale submitting snapshots, allowing a new request or accepted job',()=>{
 const f=fixture();try{
  const cid=randomUUID(),id=randomUUID(),requestId=randomUUID();f.store.putAuthoritative('owner-a','conversations',cid,{id:cid});
  const terminal={...assistant(id,cid,requestId),state:'failed',remoteJobId:null,error:'上传未被接收'};
  const failed=f.store.putAuthoritative('owner-a','messages',id,terminal)!;
  const late=f.store.apply('owner-a',[mutation('messages',id,{...terminal,state:'submitting',error:null},failed.revision)]);
  assert.equal(late.accepted[0].revision,failed.revision);assert.equal(f.store.get('owner-a','messages',id)!.data.state,'failed');
  f.store.putAuthoritative('owner-a','messages',id,{...terminal,state:'running',remoteJobId:'accepted-job'});
  assert.equal(f.store.get('owner-a','messages',id)!.data.state,'running');
  f.store.putAuthoritative('owner-a','messages',id,terminal);
  f.store.putAuthoritative('owner-a','messages',id,{...terminal,state:'submitting',requestId:randomUUID()});
  assert.equal(f.store.get('owner-a','messages',id)!.data.state,'submitting');
  f.store.putAuthoritative('owner-a','messages',id,{...terminal,state:'cancelled'});
  const cancelled=f.store.get('owner-a','messages',id)!;f.store.apply('owner-a',[mutation('messages',id,{...terminal,state:'submitting'},cancelled.revision)]);
  assert.equal(f.store.get('owner-a','messages',id)!.data.state,'cancelled');
 }finally{f.done();}
});
