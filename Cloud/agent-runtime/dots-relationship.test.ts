import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DotsAdapter,DotsStore,createLocalDotsClient} from './dots-adapter.mjs';
import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
import {createDotsSidecar} from './dots-sidecar.mjs';

const owner='shiyan-private-owner';
function fixture(t){
  const root=mkdtempSync(path.join(tmpdir(),'dots-relationship-gateway-')),calls=[];
  const relationship={revision:1,topics:[{id:'shared-topic',title:'共同产品想法',summary:'用户提出的想法',sourceMessageIds:[1],updatedAt:1000}]};
  const client={async tool(name,args){calls.push({name,args});return {ok:true,relationship};}};
  const adapter=new DotsAdapter({root,store:new DotsStore(root),client,eventReader:{close(){}},activityReader:{close(){}},recoverIntervalMs:0,subscriptionRefreshMs:0,managerPollMs:0,schedulePollMs:0});
  t.after(()=>{adapter.close();rmSync(root,{recursive:true,force:true});});
  return {adapter,root,calls,relationship};
}

test('shared topic access and corrections route to the same owner without task creation',async t=>{
  const f=fixture(t);
  const response=(await f.adapter.relationship(owner)).relationship;
  assert.deepEqual(response.topics,f.relationship.topics);assert.equal(response.revision,1);
  assert.deepEqual(response.settings,{initiative:'natural',paused:false,quietUntil:0});
  assert.equal(f.adapter.configureRelationship,undefined);assert.equal(f.adapter.relationshipFeedback,undefined);
  assert.deepEqual((await f.adapter.updateRelationshipTopic(owner,'shared-topic',{summary:'用户纠正的想法',revision:1})).relationship.settings,response.settings);
  assert.deepEqual((await f.adapter.deleteRelationshipTopic(owner,'shared-topic')).relationship.settings,response.settings);
  assert.deepEqual(f.calls.map(c=>c.name),['dots_get_relationship','dots_update_relationship_topic','dots_delete_relationship_topic']);
  assert.ok(f.calls.every(c=>c.args.owner_id===owner));
  assert.equal(f.adapter.store.db.prepare('SELECT count(*) AS n FROM dots_goals').get().n,0);
  assert.equal(f.adapter.store.latestCursor(owner),0);
});

test('malformed owner identities and forged topic edits cannot reach the runtime',async t=>{
  const f=fixture(t);
  await assert.rejects(f.adapter.relationship('invalid/owner'),e=>e.status===401);
  await assert.rejects(f.adapter.updateRelationshipTopic(owner,'../private',{summary:'x'}),e=>e.status===400);
  await assert.rejects(f.adapter.updateRelationshipTopic(owner,'shared-topic',{sourceMessageIds:[999]}),e=>e.status===400);
  assert.equal(f.calls.length,0);
});

test('proactive message metadata survives projection without a fabricated user reply link',t=>{
  const f=fixture(t);
  const row=f.adapter.presentManagerMessage({id:9,role:'assistant',content:'关于之前的想法，我有一个新的角度。',origin:'proactive',topicId:'shared-topic',proactiveReason:'一个新的设计角度',deliveryState:'completed',revision:1,privateReasoning:'hidden'},owner);
  assert.equal(row.origin,'proactive');assert.equal(row.topicId,'shared-topic');
  assert.deepEqual(row.respondsToMessageIds,[]);assert.equal(row.deliveryState,'completed');
  assert.equal('privateReasoning' in row,false);
});

test('HTTP removes initiative and feedback controls while retaining shared topic management',async t=>{
  const f=fixture(t);
  const server=createDotsSidecar({root:f.root,adapter:f.adapter,authenticate:()=>({owner}),recover:false});
  // The fixture owns adapter cleanup, so avoid the sidecar closing it twice.
  server.removeAllListeners('close');
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base='http://127.0.0.1:'+server.address().port+'/v1/dots/relationship';
  const mutate=async(url,method,input)=>{const body=JSON.stringify(input);return fetch(url,{method,headers:{'content-type':'application/json','x-shiyan-body-sha':createHash('sha256').update(body).digest('hex')},body});};
  assert.equal((await fetch(base)).status,200);
  assert.equal((await mutate(base,'PATCH',{initiative:'off'})).status,404);
  assert.equal((await mutate(base+'/feedback','POST',{messageId:9,action:'dismiss'})).status,404);
  assert.equal((await mutate(base+'/topics/shared-topic','PATCH',{openQuestion:''})).status,200);
  assert.equal((await fetch(base+'/topics/shared-topic',{method:'DELETE'})).status,200);
  assert.equal((await fetch(base,{method:'PATCH',body:'{"initiative":"open"}'})).status,404);
  assert.equal(f.calls.length,3);
});


test('real MCP bridge and local client retain only safe relationship conflicts through HTTP',async t=>{
  const runtimeRoot=process.env.SHIYAN_DOTS_TEST_RUNTIME_ROOT||'/home/ubuntu/dots-runtime';
  const {createMcpBridge}=await import(pathToFileURL(path.join(runtimeRoot,'mcp-events.mjs')).href);
  const {startLocalMcpSocket}=await import(pathToFileURL(path.join(runtimeRoot,'local-mcp-socket.mjs')).href);
  const root=mkdtempSync(path.join(tmpdir(),'dots-rel-errors-')),db=new DatabaseSync(':memory:');
  db.exec('CREATE TABLE notifications(id INTEGER PRIMARY KEY,goal_id INTEGER,level TEXT,title TEXT,body TEXT,created_at INTEGER,output_id INTEGER,read_at INTEGER,delivered_at INTEGER);CREATE TABLE timeline(id INTEGER PRIMARY KEY,goal_id INTEGER,kind TEXT,message TEXT,data TEXT,created_at INTEGER);');
  let upstream={status:409,reason:'共同话题已更新，请刷新后重试'};
  const runtime=http.createServer(async(req,res)=>{
    for await(const _chunk of req){};
    assert.equal(req.headers.authorization,'Bearer isolated-relationship-test-token');
    res.writeHead(upstream.status,{'content-type':'application/json'});res.end(JSON.stringify({ok:false,error:upstream.reason}));
  });
  await new Promise(resolve=>runtime.listen(0,'127.0.0.1',resolve));
  const bridge=createMcpBridge({db,pathSecret:'isolated-relationship-test-path',runtimeToken:'isolated-relationship-test-token',runtimeBase:'http://127.0.0.1:'+runtime.address().port,retryIntervalMs:0});
  const closeSocket=await startLocalMcpSocket({root,bridge});
  const client=createLocalDotsClient({socketPath:path.join(root,'local-ipc/mcp.sock')});
  const adapter=new DotsAdapter({root:path.join(root,'gateway'),client,eventReader:{close(){}},activityReader:{close(){}},recoverIntervalMs:0,subscriptionRefreshMs:0,managerPollMs:0,schedulePollMs:0});
  const sidecar=createDotsSidecar({root,adapter,authenticate:()=>({owner}),recover:false});
  await new Promise(resolve=>sidecar.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>sidecar.close(resolve));closeSocket();bridge.close();await new Promise(resolve=>runtime.close(resolve));db.close();rmSync(root,{recursive:true,force:true});});
  const url='http://127.0.0.1:'+sidecar.address().port+'/v1/dots/relationship/topics/shared-topic';
  const update=async()=>{const body=JSON.stringify({summary:'用户的修改',revision:1});return fetch(url,{method:'PATCH',headers:{'content-type':'application/json','x-shiyan-body-sha':createHash('sha256').update(body).digest('hex')},body});};
  for(const [status,reason,code] of [[409,'共同话题已更新，请刷新后重试','relationship_conflict'],[404,'共同话题不存在','relationship_not_found'],[400,'请填写有效的共同话题','relationship_invalid']]){
    upstream={status,reason};const response=await update(),result=await response.json();
    assert.equal(response.status,status);assert.equal(result.error,reason);assert.equal(result.code,code);
  }
  // An internal failure cannot leak a private path, even if it is mislabeled 400.
  for(const status of [500,400]){
    upstream={status,reason:'internal secret /private/example.sqlite'};
    const response=await update(),result=await response.json();assert.equal(response.status,502);assert.doesNotMatch(result.error,/internal|secret|sqlite/);
    const raw=await new Promise((resolve,reject)=>{
      const request=http.request({socketPath:path.join(root,'local-ipc/mcp.sock'),path:'/mcp',method:'POST',headers:{'content-type':'application/json'}},res=>{
        const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve(JSON.parse(Buffer.concat(chunks).toString()).result));
      });request.on('error',reject);request.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'dots_update_relationship_topic',arguments:{topicId:'shared-topic',summary:'用户的修改',revision:1}}}));
    });
    assert.equal(raw.isError,true);assert.equal(raw.structuredContent,undefined);assert.doesNotMatch(JSON.stringify(raw),/internal|secret|sqlite/);
  }
  // Non-relationship tool handling keeps its original generic error contract.
  upstream={status:409,reason:'共同话题已更新，请刷新后重试'};
  await assert.rejects(client.tool('dots_get_goal',{goal_id:1}),error=>error.status===502&&error.code==='runtime_rejected');
});
