// Real additive runtime store + real gateway, both using temporary SQLite.
// Structured model results are fixtures; no provider turn or Mac execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createManagerStore } from '/home/ubuntu/dots-runtime/manager-store.mjs';
import { createMcpBridge } from '/home/ubuntu/dots-runtime/mcp-events.mjs';
import { startLocalMcpSocket } from '/home/ubuntu/dots-runtime/local-mcp-socket.mjs';
import { DotsAdapter, DotsStore, createLocalDotsClient } from './dots-adapter.ts';

const OWNER='shiyan-private-owner';
function fixture(t: any){
  const root=mkdtempSync(path.join(os.tmpdir(),'shiyan-runtime-manager-integration-'));
  const db=new DatabaseSync(path.join(root,'runtime.sqlite3'));
  db.exec(`CREATE TABLE goals(id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT NOT NULL,instruction TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',thread_id TEXT,workspace TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,next_wake_at INTEGER,last_run_at INTEGER,last_summary TEXT NOT NULL DEFAULT '',run_count INTEGER NOT NULL DEFAULT 0);CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT,goal_id INTEGER NOT NULL,type TEXT NOT NULL,payload TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,consumed_at INTEGER);CREATE TABLE approvals(id INTEGER PRIMARY KEY AUTOINCREMENT,goal_id INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending');`);
  db.prepare("INSERT INTO goals(title,instruction,status,thread_id,workspace,created_at,updated_at,next_wake_at) VALUES('旧任务','保留原线程','paused','original-thread',?,1000,1000,NULL)").run(path.join(root,'legacy'));
  const runtime=createManagerStore({db,ownerId:OWNER,workspaceRoot:path.join(root,'workspaces'),now:()=>1000});
  const store=new DotsStore(path.join(root,'gateway'));let lost=false;const calls: any[]=[];
  const client={async rpc(){return {};},forOwner(value: any){return client;},async tool(name: any,args: any){
    calls.push({name,args});runtime.requireOwner(args.owner_id);
    if(name==='dots_get_manager')return {ok:true,manager:runtime.snapshot()};
    if(name==='dots_get_manager_messages')return runtime.messages({beforeId:args.before_id,limit:args.limit});
    if(name==='dots_get_manager_activity')return runtime.activity({afterId:args.after_id,limit:args.limit});
    if(name==='dots_message_manager'){const result=runtime.message({requestId:args.request_id,message:args.message,host:args.host,taskId:args.task_id});if(lost){lost=false;throw Object.assign(new Error('lost reply'),{status:503,code:'runtime_unavailable'});}return result;}
    if(name==='dots_control_manager')return runtime.control({requestId:args.request_id,action:args.action});
    if(name==='dots_get_goal')return {ok:true,goal:db.prepare('SELECT * FROM goals WHERE id=?').get(args.goal_id)};
    throw new Error('unsupported fixture tool '+name);
  }};
  const adapter=new DotsAdapter({root:path.join(root,'gateway'),store,client,eventReader:{read(){return [];},request(){return null;},close(){}},recoverIntervalMs:0,subscriptionRefreshMs:0,managerPollMs:0});
  t.after(()=>{adapter.close();db.close();rmSync(root,{recursive:true,force:true});});
  return {root,db,runtime,store,adapter,calls,lose(){lost=true;}};
}

test('real manager migration only reparents legacy goals and preserves status, wake time and thread',async t=>{
  const f=fixture(t);const response=await f.adapter.manager(OWNER);assert.equal(response.manager.name,'大内总管');assert.equal(response.tasks.length,1);const row=f.db.prepare('SELECT * FROM goals WHERE id=1').get();assert.equal(row!.status,'paused');assert.equal(row!.next_wake_at,null);assert.equal(row!.thread_id,'original-thread');assert.equal(row!.manager_id,'manager:'+OWNER);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM manager_runs').get()!.n,0);assert.equal(f.store.mapping(OWNER,1)!.conversation_id,'dots-task-1');
});

test('real runtime receipt survives gateway response loss and mobile and desktop share message order',async t=>{
  const f=fixture(t);const input={requestId:'mobile-write',message:'先检查渲染',host:'shiyan_mobile'};f.lose();await assert.rejects(f.adapter.messageManager(OWNER,input));const first=await f.adapter.messageManager(OWNER,input);assert.equal(first.accepted,true);assert.equal(first.message.createdAt,1000);assert.equal(first.message.host,'shiyan_mobile');
  await f.adapter.messageManager(OWNER,{requestId:'desktop-write',message:'同时检查同步',host:'shiyan_desktop'});await f.adapter.syncManagerActivity(OWNER);assert.equal(f.runtime.snapshot().messages.length,2);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM manager_requests').get()!.n,2);assert.deepEqual((await f.adapter.manager(OWNER)).messages.map((m: any)=>m.content),['先检查渲染','同时检查同步']);assert.equal(f.adapter.events(OWNER).events.filter(e=>e.type==='manager_activity').length,2);
});

test('real manager structured delegation produces dependent child tasks and assistant SSE replay',async t=>{
  const f=fixture(t);await f.adapter.messageManager(OWNER,{requestId:'delegate',message:'修复并验证',host:'shiyan_mobile'});
  const run=f.runtime.claimManager();assert.ok(run);const completed=f.runtime.completeManager(run,{reply:'已派两项任务，修复后再验证。',summary:'修复手机表格',tasks:[{key:'fix',title:'修复表格',instruction:'修改渲染',dependencies:[],acceptanceCriteria:'列宽跟随内容',resourceKey:'project:ios'},{key:'verify',title:'验证表格',instruction:'核对修复',dependencies:['fix'],acceptanceCriteria:'证明修复生效',resourceKey:'project:ios'}],reviews:[],controls:[],instructions:[]});assert.equal(completed.committed,true);
  await f.adapter.syncManagerActivity(OWNER);const response=await f.adapter.manager(OWNER);assert.equal(response.messages.at(-1).role,'assistant');assert.equal(response.tasks.length,3);const verify=response.tasks.find((task: any)=>task.title==='验证表格');const fix=response.tasks.find((task: any)=>task.title==='修复表格');assert.deepEqual(verify.dependencies,[fix.id]);assert.equal(verify.acceptanceCriteria,'证明修复生效');assert.equal(fix.resourceKey,'project:ios');assert.equal(f.runtime.taskEligibility(verify.id),false);assert.equal(f.runtime.taskEligibility(fix.id),true);assert.ok(f.store.mapping(OWNER,fix.id));assert.ok(f.adapter.events(OWNER).events.some(e=>e.payload.activity?.kind==='assistant_message'));
});

test('voice reply attribution survives gateway snapshot, pagination and activity without cross-owner access',async t=>{
  const f=fixture(t);
  const desktop=await f.adapter.messageManager(OWNER,{requestId:'voice-origin',message:'语音第一句',host:'shiyan_desktop'});
  const mobile=await f.adapter.messageManager(OWNER,{requestId:'mobile-origin',message:'手机补充',host:'shiyan_mobile'});
  const run=f.runtime.claimManager();
  const completed=f.runtime.completeManager(run,{reply:'一并回复。',summary:'合并输入',tasks:[],reviews:[],controls:[],instructions:[]});
  assert.equal(completed.committed,true);
  const sources=[desktop.message.id,mobile.message.id];
  await f.adapter.syncManagerActivity(OWNER);
  const snapshot=await f.adapter.manager(OWNER);
  assert.deepEqual(snapshot.messages.at(-1).respondsToMessageIds,sources);
  const history=await f.adapter.managerMessages(OWNER,{limit:1});
  assert.deepEqual(history.messages[0].respondsToMessageIds,sources);
  const event=f.adapter.events(OWNER).events.find(item=>item.payload.activity?.kind==='assistant_message');
  assert.deepEqual(event.payload.activity.data.message.respondsToMessageIds,sources);
  await assert.rejects(f.adapter.manager('other-owner'),e=>(e as any).statusCode===404||(e as any).status===404);
  await assert.rejects(f.adapter.managerMessages('other-owner'),e=>(e as any).statusCode===404||(e as any).status===404);
});

test('gateway rejects malformed reply attribution and preserves empty historical associations',async t=>{
  const f=fixture(t);
  const message={id:1,role:'assistant',content:'reply',createdAt:1000};
  assert.deepEqual(f.adapter.presentManagerMessage(message,OWNER).respondsToMessageIds,[]);
  assert.deepEqual(f.adapter.presentManagerMessage({...message,respondsToMessageIds:[2,2,3]},OWNER).respondsToMessageIds,[2,3]);
  for(const respondsToMessageIds of [null,'2',[0],[-1],[1.5],['2']])assert.throws(()=>f.adapter.presentManagerMessage({...message,respondsToMessageIds},OWNER),/归属格式/);
});

test('failed voice turn retains exact source IDs in durable activity without inventing an assistant reply',async t=>{
  const f=fixture(t);
  const accepted=await f.adapter.messageManager(OWNER,{requestId:'voice-failed',message:'等待本轮结果',host:'shiyan_desktop'});
  f.runtime.failManager(f.runtime.claimManager(),'fixture provider unavailable');
  await f.adapter.syncManagerActivity(OWNER);
  const failure=f.adapter.events(OWNER).events.find(item=>item.payload.activity?.kind==='manager_error');
  assert.deepEqual(failure.payload.activity.data.respondsToMessageIds,[accepted.message.id]);
  const activity=await f.adapter.managerActivity(OWNER);
  assert.deepEqual(activity.activity.find((item: any)=>item.kind==='manager_error').data.respondsToMessageIds,[accepted.message.id]);
  assert.equal((await f.adapter.manager(OWNER)).messages.filter((item: any)=>item.role==='assistant').length,0);
});

test('real reported done waits for manager acceptance before dependent task becomes eligible',async t=>{
  const f=fixture(t);const [fix,verify]=f.runtime.createTasks([{key:'fix',title:'修复',instruction:'执行修复',dependencies:[],acceptanceCriteria:'验证修复'},{key:'verify',title:'验证',instruction:'独立核对',dependencies:['fix']}]);
  f.db.prepare("UPDATE goals SET status='done',last_summary='fixture evidence' WHERE id=?").run(fix.id);f.runtime.reportGoal(fix.id,'done','fixture evidence');assert.equal(f.runtime.taskEligibility(verify.id),false);await f.adapter.manager(OWNER);assert.equal((await f.adapter.manager(OWNER)).tasks.find((task: any)=>task.id===fix.id).acceptanceStatus,'pending');
  f.runtime.acceptTask(fix.id,{accepted:true,reason:'核对了产物和测试'});await f.adapter.syncManagerActivity(OWNER);assert.equal(f.runtime.taskEligibility(verify.id),true);assert.equal((await f.adapter.manager(OWNER)).tasks.find((task: any)=>task.id===fix.id).acceptanceStatus,'accepted');assert.ok(f.adapter.events(OWNER).events.some(e=>e.payload.activity?.kind==='task_accepted'));
});

test('real pause and cancellation controls preserve manager identity and do not double-apply',async t=>{
  const f=fixture(t);const [task]=f.runtime.createTasks([{key:'one',title:'工作',instruction:'办理',dependencies:[]}]);const paused=await f.adapter.controlManager(OWNER,{requestId:'pause',action:'pause'});assert.equal(paused.manager.status,'paused');assert.equal(f.db.prepare('SELECT status FROM goals WHERE id=?').get(task.id)!.status,'active');await f.adapter.messageManager(OWNER,{requestId:'while-paused',message:'先记着这个要求',host:'shiyan_mobile'});assert.equal(f.runtime.snapshot().status,'paused');assert.equal(f.runtime.claimGoal(task.id),null);
  const cancelled=await f.adapter.controlManager(OWNER,{requestId:'cancel-all',action:'cancel'});assert.equal(cancelled.manager.status,'cancelled');assert.equal(f.db.prepare('SELECT status FROM goals WHERE id=?').get(task.id)!.status,'cancelled');const revision=cancelled.manager.controlRevision;await f.adapter.controlManager(OWNER,{requestId:'cancel-all',action:'cancel'});assert.equal(f.runtime.snapshot().controlRevision,revision);const resumed=await f.adapter.controlManager(OWNER,{requestId:'resume',action:'resume'});assert.equal(resumed.manager.id,paused.manager.id);assert.equal(resumed.manager.status,'active');assert.equal(f.db.prepare('SELECT status FROM goals WHERE id=?').get(task.id)!.status,'cancelled');
});

test('real private Unix MCP bridge translates manager writes, activity and message history into gateway contracts',async t=>{
  const f=fixture(t);f.db.exec(`CREATE TABLE notifications(id INTEGER PRIMARY KEY,goal_id INTEGER,level TEXT,title TEXT,body TEXT,created_at INTEGER,output_id INTEGER,read_at INTEGER,delivered_at INTEGER);CREATE TABLE timeline(id INTEGER PRIMARY KEY,goal_id INTEGER,kind TEXT,message TEXT,data TEXT,created_at INTEGER);`);
  const TOKEN='fixture-token-local-only';const requests: any[]=[];
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url||'/','http://fixture');const chunks: any[]=[];for await(const chunk of req)chunks.push(chunk);const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};
    const reply=(status: any,value: any)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
    if(req.headers.authorization!=='Bearer '+TOKEN)return reply(401,{error:'Fixture authorization failed'});requests.push({method:req.method,url:req.url,body});
    try{
      const match=url.pathname.match(/^\/v1\/managers\/([^/]+)(?:\/(messages|control|activity))?$/);if(!match)return reply(404,{error:'Fixture route not found'});f.runtime.requireOwner(decodeURIComponent(match[1]));
      if(req.method==='GET'&&!match[2])return reply(200,{ok:true,manager:f.runtime.snapshot()});
      if(req.method==='GET'&&match[2]==='messages')return reply(200,f.runtime.messages({beforeId:Number(url.searchParams.get('beforeId')||0),limit:Number(url.searchParams.get('limit')||100)}));
      if(req.method==='POST'&&match[2]==='messages')return reply(200,f.runtime.message(body));
      if(req.method==='POST'&&match[2]==='control')return reply(200,f.runtime.control(body));
      if(req.method==='GET'&&match[2]==='activity')return reply(200,f.runtime.activity({afterId:Number(url.searchParams.get('afterId')||0),limit:Number(url.searchParams.get('limit')||50)}));
      return reply(404,{error:'Fixture method not found'});
    }catch(error){reply((error as any).statusCode||500,{error:(error as any).message});}
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',()=>resolve()));
  const bridge=createMcpBridge({db:f.db,pathSecret:'fixture-path-only',runtimeToken:TOKEN,runtimeBase:'http://127.0.0.1:'+(server.address() as any).port,retryIntervalMs:0});
  const stopSocket=await startLocalMcpSocket({root:f.root,bridge});f.adapter.client=createLocalDotsClient({socketPath:path.join(f.root,'local-ipc','mcp.sock')});
  try{
    const tools=await f.adapter.client.rpc('tools/list');assert.ok(tools.tools.some((tool: any)=>tool.name==='dots_get_manager_messages'));
    const accepted=await f.adapter.messageManager(OWNER,{requestId:'unix-real-write',message:'在总管下创建子任务',host:'shiyan_desktop'});assert.equal(accepted.accepted,true);assert.equal(accepted.message.host,'shiyan_desktop');
    const run=f.runtime.claimManager();f.runtime.completeManager(run,{reply:'已安排子任务。',summary:'派工',tasks:[{key:'one',title:'核对项目',instruction:'只读检查',dependencies:[],acceptanceCriteria:'提供证据',resourceKey:''}],reviews:[],controls:[],instructions:[]});await f.adapter.syncManagerActivity(OWNER);
    const current=await f.adapter.manager(OWNER);assert.equal(current.messages.at(-1).content,'已安排子任务。');assert.equal(current.tasks.length,2);assert.ok(f.adapter.events(OWNER).events.some(event=>event.payload.activity?.kind==='task_created'));
    const insert=f.db.prepare("INSERT INTO manager_messages(manager_id,role,content,created_at) VALUES(?,'assistant',?,1000)");for(let n=0;n<110;n++)insert.run(f.runtime.managerId,'history '+n);
    const latest: any=await f.adapter.manager(OWNER);assert.equal(latest.messages.length,100);assert.equal(latest.hasMoreMessages,true);const older=await f.adapter.managerMessages(OWNER,{before:latest.oldestMessageId,limit:100});assert.equal(older.hasMore,false);assert.equal(older.messages.length,12);assert.equal(older.messages[0].content,'在总管下创建子任务');
    const paused=await f.adapter.controlManager(OWNER,{requestId:'unix-real-pause',action:'pause'});assert.equal(paused.manager.status,'paused');assert.ok(requests.some(request=>request.url.includes('/messages?limit=100&beforeId=')));
  }finally{stopSocket();bridge.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
