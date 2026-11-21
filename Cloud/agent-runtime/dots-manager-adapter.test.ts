// Isolated manager fixtures: no model turns, live goals, Mac commands, device
// registration, approvals or production SQLite writes occur in this suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DotsAdapter, DotsStore } from './dots-adapter.ts';
import { createDotsSidecar } from './dots-sidecar.ts';

const OWNER='shiyan-private-owner';
const disconnected=()=>Object.assign(new Error('fixture disconnected'),{status:503,code:'runtime_unavailable'});
const copy=value=>JSON.parse(JSON.stringify(value));
const instruction=(extra={})=>({requestId:'manager-first',message:'检查手机端表格',host:'shiyan_mobile',...extra});
function fixture(t,{managerPollMs=0}={}){
  const root=mkdtempSync(path.join(os.tmpdir(),'shiyan-manager-fixture-'));
  const store=new DotsStore(root),calls=[],receipts=new Map(),activity=[];
  const manager={id:'manager:'+OWNER,ownerId:OWNER,name:'大内总管',status:'active',controlRevision:0,createdAt:1000,updatedAt:1000,lastSummary:'',workerLimit:2,runningWorkers:0,tasks:[],messages:[],capabilities:{manager:true,delegation:true,dependencies:true,durableRuns:true,workerConcurrency:2,apns:false,hardBudgets:false,recurringSchedules:false},thread_id:'private-thread',token:'never-project'};
  let loseMessage=false,loseControl=false,unavailable=false,badCursor=false;
  const append=(kind,{taskId=null,message='',data={}}={})=>{const row={id:activity.length+1,managerId:manager.id,taskId,kind,message,data,createdAt:1000+activity.length};activity.push(row);return row;};
  const client={async rpc(method){calls.push({method});if(method==='ping')return {};throw new Error('unsupported fixture rpc');},async tool(name,args){
    if(args.owner_id&&args.owner_id!==OWNER)throw Object.assign(Error('Manager not found'),{status:404});
    calls.push({name,args});if(unavailable)throw disconnected();
    if(name==='dots_get_manager')return {ok:true,manager:{...copy(manager),activityCursor:activity.length,messages:copy(manager.messages.slice(-100)),hasMoreMessages:manager.messages.length>100,oldestMessageId:manager.messages.slice(-100)[0]?.id??null}};
    if(name==='dots_get_manager_messages'){
      const rows=manager.messages.filter(message=>!args.before_id||message.id<args.before_id).sort((a,b)=>b.id-a.id).slice(0,args.limit+1);
      const visible=rows.slice(0,args.limit).reverse();return {ok:true,messages:copy(visible),hasMore:rows.length>args.limit,nextBeforeId:visible[0]?.id??null};
    }
    if(name==='dots_message_manager'){
      if(receipts.has(args.request_id))return copy(receipts.get(args.request_id));
      const message={id:manager.messages.length+1,role:'user',content:args.message,taskId:args.task_id??null,requestId:args.request_id,createdAt:1001};manager.messages.push(message);append('manager.message',{message:args.message,data:{message}});
      const result={ok:true,accepted:true,message,manager:copy(manager)};receipts.set(args.request_id,copy(result));if(loseMessage){loseMessage=false;throw disconnected();}return result;
    }
    if(name==='dots_control_manager'){
      if(receipts.has(args.request_id))return copy(receipts.get(args.request_id));
      manager.status={pause:'paused',resume:'active',cancel:'cancelled',wake:manager.status}[args.action];manager.controlRevision++;append('manager.control',{message:args.action});
      const result={ok:true,manager:copy(manager)};receipts.set(args.request_id,copy(result));if(loseControl){loseControl=false;throw disconnected();}return result;
    }
    if(name==='dots_get_manager_activity'){
      const rows=activity.filter(a=>a.id>args.after_id).slice(0,args.limit);
      return {ok:true,activity:copy(rows),nextCursor:badCursor?0:(rows.at(-1)?.id??args.after_id),hasMore:activity.some(a=>a.id>(rows.at(-1)?.id??args.after_id))};
    }
    if(name==='dots_list_goals')return {ok:true,goals:[]};
    if(name==='dots_list_notifications')return {notifications:[],next_cursor:args.after_id,has_more:false};
    throw new Error('unsupported fixture tool '+name);
  }};
  const adapter=new DotsAdapter({root,store,client,eventReader:{read(){return [];},close(){}},recoverIntervalMs:0,subscriptionRefreshMs:0,managerPollMs});
  t.after(()=>{adapter.close();rmSync(root,{recursive:true,force:true});});
  return {root,store,adapter,client,calls,manager,activity,append,receipts,loseMessage(){loseMessage=true;},loseControl(){loseControl=true;},unavailable(value=true){unavailable=value;},badCursor(value=true){badCursor=value;},task(extra={}){const task={id:101+manager.tasks.length,managerId:manager.id,title:'检查表格',instruction:'验证手机表格渲染',status:'active',acceptanceStatus:'pending',dependencies:[],controlRevision:0,createdAt:1000,updatedAt:1000,nextWakeAt:1000,lastSummary:'',runCount:0,originHost:'shiyan_mobile',...extra};manager.tasks.push(task);return task;}};
}

test('one authenticated manager is shared across hosts and legacy task bindings remain intact',async t=>{
  const f=fixture(t);const task=f.task({status:'paused',acceptanceStatus:'changes_requested',dependencies:[99],controlRevision:4});
  f.store.bind(OWNER,'original-conversation','chatgpt',{id:task.id,title:'Original',status:'paused'});
  const response=await f.adapter.manager(OWNER);assert.equal(response.manager.id,'manager:'+OWNER);assert.deepEqual(response.messages,[]);assert.equal(response.tasks[0].status,'paused');assert.equal(response.tasks[0].controlRevision,4);assert.equal(response.tasks[0].acceptanceStatus,'changes_requested');assert.deepEqual(response.tasks[0].dependencies,[99]);
  assert.ok(!('thread_id' in response.manager));assert.ok(!('token' in response.manager));assert.equal(f.store.mapping(OWNER,task.id).conversation_id,'original-conversation');assert.equal(f.store.mapping(OWNER,task.id).origin_host,'chatgpt');
  assert.equal(f.calls.filter(c=>c.name==='dots_control_goal'||c.name==='dots_create_goal').length,0);assert.equal((await f.adapter.list(OWNER)).goals[0].controlRevision,4);
  await assert.rejects(f.adapter.manager('another-owner'),e=>e.status===404);
});

test('manager instructions are durably accepted once despite duplicate requests and response loss',async t=>{
  const f=fixture(t);f.loseMessage();await assert.rejects(f.adapter.messageManager(OWNER,instruction()));
  const [a,b]=await Promise.all([f.adapter.messageManager(OWNER,instruction()),f.adapter.messageManager(OWNER,instruction())]);assert.equal(a.accepted,true);assert.equal(a.message.id,b.message.id);assert.equal(f.manager.messages.length,1);assert.equal(f.receipts.size,1);
  assert.ok(a.cursor>0);assert.equal(f.store.receipt(OWNER,'manager-first').state,'completed');assert.equal(f.adapter.events(OWNER).events.filter(e=>e.type==='manager_activity').length,1);
  assert.equal(f.calls.filter(c=>c.name==='dots_message_manager').length,2);assert.ok(!f.calls.find(c=>c.name==='dots_message_manager').args.request_id.includes(OWNER));
  await assert.rejects(f.adapter.messageManager(OWNER,instruction({message:'另一件事'})),e=>e.code==='request_conflict');
});

test('invalid instruction and foreign task IDs never reach runtime',async t=>{
  const f=fixture(t);await assert.rejects(f.adapter.messageManager(OWNER,instruction({host:'chatgpt'})),e=>e.status===400);await assert.rejects(f.adapter.messageManager(OWNER,instruction({taskId:999})),e=>e.status===404);await assert.rejects(f.adapter.messageManager(OWNER,{...instruction(),owner_id:'forged'}),e=>e.status===400);assert.equal(f.calls.length,0);
});

test('paused manager accepts new instructions without silently resuming',async t=>{
  const f=fixture(t);f.manager.status='paused';const response=await f.adapter.messageManager(OWNER,instruction());assert.equal(response.manager.status,'paused');assert.equal(response.accepted,true);assert.equal(f.calls.filter(c=>c.name==='dots_control_manager').length,0);
});

test('runtime manager controls are receipt-deduplicated even after a lost reply',async t=>{
  const f=fixture(t);f.loseControl();const command={requestId:'pause-manager',action:'pause'};await assert.rejects(f.adapter.controlManager(OWNER,command));const response=await f.adapter.controlManager(OWNER,command);assert.equal(response.manager.status,'paused');assert.equal(f.manager.controlRevision,1);await f.adapter.controlManager(OWNER,command);assert.equal(f.calls.filter(c=>c.name==='dots_control_manager').length,2);assert.equal(f.adapter.events(OWNER).events.filter(e=>e.type==='manager_snapshot').length,1);
});

test('assistant replies and worker lifecycle changes enter durable replay, deduplicated on catch-up',async t=>{
  const f=fixture(t);await f.adapter.manager(OWNER);const task=f.task();f.append('task.created',{taskId:task.id,data:{task}});const assistant={id:1,role:'assistant',content:'已安排检查',taskId:null,requestId:null,createdAt:1002};f.manager.messages.push(assistant);f.append('manager.message',{message:assistant.content,data:{message:assistant}});
  await f.adapter.syncManagerActivity(OWNER);await f.adapter.syncManagerActivity(OWNER);const events=f.adapter.events(OWNER).events;
  assert.equal(events.length,2);assert.equal(events[0].goalId,task.id);assert.equal(events[1].goalId,0);assert.equal(events[1].payload.activity.data.message.content,'已安排检查');assert.equal(f.store.manager(OWNER).runtime_cursor,2);assert.ok(f.store.mapping(OWNER,task.id));
  const desktop=f.adapter.acknowledge(OWNER,{consumerId:'desktop',cursor:events[1].seq});assert.equal(desktop.handoffOnly,true);assert.equal(f.adapter.acknowledge(OWNER,{consumerId:'ios',cursor:0}).cursor,0);assert.equal(f.manager.messages.length,1);
});

test('manager activity cursor and event replay survive adapter database reopen',async t=>{
  const f=fixture(t);await f.adapter.manager(OWNER);f.append('manager.message',{message:'已完成'});await f.adapter.syncManagerActivity(OWNER);
  const second=new DotsStore(f.root);t.after(()=>second.close());assert.equal(second.manager(OWNER).runtime_cursor,1);assert.equal(second.events(OWNER,0,10).events[0].payload.activity.message,'已完成');assert.equal(second.latestCursor(OWNER),1);assert.equal(second.latestCursor('another-owner'),0);
});

test('invalid runtime cursor rolls back events and checkpoint together',async t=>{
  const f=fixture(t);await f.adapter.manager(OWNER);f.append('manager.message',{message:'检查中'});f.badCursor();await assert.rejects(f.adapter.syncManagerActivity(OWNER),e=>e.code==='runtime_rejected');assert.equal(f.adapter.events(OWNER).events.length,0);assert.equal(f.store.manager(OWNER).runtime_cursor,0);f.badCursor(false);await f.adapter.syncManagerActivity(OWNER);assert.equal(f.adapter.events(OWNER).events.length,1);
});

test('foreign manager/task activity is not silently bound or replayed',async t=>{
  const f=fixture(t);await f.adapter.manager(OWNER);f.activity.push({id:1,managerId:'manager:other',taskId:null,kind:'manager.message',message:'private',data:{},createdAt:1001});await assert.rejects(f.adapter.syncManagerActivity(OWNER),e=>e.code==='runtime_rejected');assert.equal(f.adapter.events(OWNER).events.length,0);
  f.activity.length=0;f.append('task.changed',{taskId:999});await assert.rejects(f.adapter.syncManagerActivity(OWNER),e=>e.code==='runtime_rejected');assert.equal(f.adapter.events(OWNER).events.length,0);
});

test('manager activity pagination drains more than one page without losing ordering',async t=>{
  const f=fixture(t);await f.adapter.manager(OWNER);for(let n=0;n<205;n++)f.append('manager.message',{message:'update '+n});await f.adapter.syncManagerActivity(OWNER);const replay=f.adapter.events(OWNER,{limit:500});assert.equal(replay.events.length,205);assert.equal(replay.events.at(-1).payload.activity.id,205);assert.equal(f.store.manager(OWNER).runtime_cursor,205);
});

test('long-lived manager history is paginated independently of activity and preserves chronological order',async t=>{
  const f=fixture(t);for(let id=1;id<=235;id++)f.manager.messages.push({id,role:id%2?'user':'assistant',content:'历史消息 '+id,taskId:null,requestId:null,createdAt:1000+id});
  const current=await f.adapter.manager(OWNER);assert.equal(current.messages.length,100);assert.equal(current.hasMoreMessages,true);assert.equal(current.manager.hasMoreMessages,true);assert.equal(current.oldestMessageId,136);assert.equal(current.messages[0].id,136);
  const older=await f.adapter.managerMessages(OWNER,{before:136,limit:100});assert.equal(older.messages[0].id,36);assert.equal(older.messages.at(-1).id,135);assert.equal(older.hasMore,true);assert.equal(older.nextBeforeId,36);
  const oldest=await f.adapter.managerMessages(OWNER,{before:36,limit:100});assert.equal(oldest.messages.length,35);assert.equal(oldest.messages[0].id,1);assert.equal(oldest.hasMore,false);
  const empty=await f.adapter.managerMessages(OWNER,{before:1});assert.deepEqual(empty.messages,[]);assert.equal(empty.nextBeforeId,null);assert.equal(f.store.latestCursor(OWNER),0);
  const latest=await f.adapter.managerMessages(OWNER,{before:'0',limit:'100'});assert.equal(latest.messages[0].id,136);await assert.rejects(f.adapter.managerMessages('another-owner'),e=>e.status===404);await assert.rejects(f.adapter.managerMessages(OWNER,{before:-1}),e=>e.status===400);
});

test('cached manager reads disclose offline state and never invent live webhook support',async t=>{
  const f=fixture(t);await f.adapter.manager(OWNER);f.unavailable();const cached=await f.adapter.manager(OWNER);assert.equal(cached.stale,true);assert.equal(cached.realtimeUnavailable,true);const capabilities=await f.adapter.capabilities(OWNER);assert.equal(capabilities.managerWebhook,false);assert.equal(capabilities.apns,false);assert.equal(capabilities.budgetsSupported,false);assert.match(capabilities.managerTransport,/polling/);
});

test('manager read catches up snapshot when assistant activity arrives between initial read and replay',async t=>{
  const f=fixture(t);const original=f.client.tool;let injected=false;
  f.client.tool=async(name,args)=>{const response=await original(name,args);if(name==='dots_get_manager'&&!injected){injected=true;const message={id:1,role:'assistant',content:'刚完成的回复',taskId:null,requestId:null,createdAt:1001};f.manager.messages.push(message);f.append('assistant_message',{message:message.content,data:{message}});}return response;};
  const current=await f.adapter.manager(OWNER);assert.equal(current.messages.at(-1).content,'刚完成的回复');assert.equal(current.manager.activityCursor,1);assert.equal(current.cursor,1);assert.equal(f.store.manager(OWNER).runtime_cursor,1);
});

test('replayed old acceptance snapshot cannot overwrite a newer assistant reply or task state',async t=>{
  const f=fixture(t);await f.adapter.messageManager(OWNER,instruction());await f.adapter.syncManagerActivity(OWNER);
  const remote=f.calls.find(call=>call.name==='dots_message_manager').args.request_id;f.receipts.get(remote).manager.activityCursor=1;
  const task=f.task({status:'done',acceptanceStatus:'accepted',legacyImported:false});const message={id:2,role:'assistant',content:'已完成并验收',taskId:task.id,requestId:null,createdAt:1002};f.manager.messages.push(message);f.append('task_created',{taskId:task.id});f.append('assistant_message',{message:message.content,data:{message}});await f.adapter.manager(OWNER);
  f.store.db.prepare("UPDATE dots_requests SET state='pending',response=NULL WHERE request_id='manager-first'").run();const recovered=await f.adapter.messageManager(OWNER,instruction());assert.equal(recovered.message.id,1);assert.equal(recovered.messages.at(-1).content,'已完成并验收');assert.equal(recovered.tasks[0].status,'done');assert.equal(recovered.tasks[0].legacyImported,false);assert.equal(JSON.parse(f.store.manager(OWNER).snapshot).activityCursor,3);await f.adapter.syncManagerActivity(OWNER);
});

test('active manager SSE listener receives worker changes using short polling, idle adapter does not poll',async t=>{
  const f=fixture(t,{managerPollMs:10});await f.adapter.manager(OWNER);let received=[];const listener={destroyed:false,write(value){received.push(value);},end(){}};
  const before=f.calls.filter(c=>c.name==='dots_get_manager_activity').length;await new Promise(resolve=>setTimeout(resolve,40));assert.equal(f.calls.filter(c=>c.name==='dots_get_manager_activity').length,before);
  f.listenersSet=new Set([listener]);f.adapter.listeners.set(OWNER,f.listenersSet);f.append('manager.message',{message:'后台结果'});await new Promise(resolve=>setTimeout(resolve,45));assert.ok(received.some(value=>value.includes('后台结果')));assert.equal(f.adapter.events(OWNER).events.length,1);
  f.listenersSet.clear();
});

test('authenticated manager REST validates body hashes and SSE durably replays messages',async t=>{
  const f=fixture(t);const server=createDotsSidecar({adapter:f.adapter,recover:false,authenticate:req=>req.headers['x-fixture-owner']?{owner:req.headers['x-fixture-owner']}:null});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
  t.after(()=>{server.closeAllConnections();server.removeAllListeners('close');server.close();});
  assert.equal((await fetch(base+'/shiyan/v1/dots/manager')).status,401);assert.equal((await fetch(base+'/shiyan/v1/dots/manager',{headers:{'x-fixture-owner':'another-owner'}})).status,404);
  const headers={'x-fixture-owner':OWNER};const fetched=await (await fetch(base+'/shiyan/v1/dots/manager',{headers})).json();assert.equal(fetched.manager.name,'大内总管');const body=JSON.stringify(instruction());const signed={...headers,'Content-Type':'application/json','x-shiyan-body-sha':createHash('sha256').update(body).digest('hex')};
  assert.equal((await fetch(base+'/shiyan/v1/dots/manager/messages',{method:'POST',headers:{...signed,'x-shiyan-body-sha':'wrong'},body})).status,401);const accepted=await (await fetch(base+'/shiyan/v1/dots/manager/messages',{method:'POST',headers:signed,body})).json();assert.equal(accepted.accepted,true);assert.equal(accepted.message.content,'检查手机端表格');
  const activity=await (await fetch(base+'/shiyan/v1/dots/manager/activity?after=0',{headers})).json();assert.equal(activity.activity.length,1);assert.equal(activity.nextCursor,1);
  const history=await (await fetch(base+'/shiyan/v1/dots/manager/messages?before=0&limit=100',{headers})).json();assert.equal(history.messages.length,1);assert.equal(history.nextBeforeId,1);assert.equal(history.hasMore,false);
  const stream=await fetch(base+'/shiyan/v1/dots/events?after=0',{headers});const reader=stream.body.getReader();const chunk=new TextDecoder().decode((await reader.read()).value);assert.match(chunk,/manager_snapshot/);assert.match(chunk,/manager_activity/);assert.match(chunk,/检查手机端表格/);await reader.cancel();
});


test('one issue opens the combined history and keeps cancelled phases cancelled',async t=>{
 const f=fixture(t),first=f.task({title:'Dots 更新',status:'cancelled',updatedAt:1200}),second=f.task({title:'环境排查',status:'blocked',updatedAt:1100});
 await f.adapter.manager(OWNER);
 for(const task of [first,second])f.store.db.prepare('INSERT INTO dots_issue_members(owner,goal_id,issue_key,issue_title) VALUES(?,?,?,?)').run(OWNER,task.id,'dots-maintenance','Dots 更新与执行环境');
 const tool=f.client.tool;f.client.tool=async(name,args)=>name==='dots_get_goal'?{goal:{id:args.goal_id,title:f.manager.tasks.find(t=>t.id===args.goal_id).title,status:f.manager.tasks.find(t=>t.id===args.goal_id).status,outputs:[]}}:tool(name,args);
 f.adapter.activityReader={outputs:()=>[],conversation:(id)=>({messages:[{id:'same-local-id',role:'assistant',content:'记录 '+id,createdAt:id,source:'worker_transcript'}],outputs:[],transcriptAvailable:true}),close(){}};
 const list=await f.adapter.activity(OWNER);assert.equal(list.activities.length,1);assert.equal(list.activities[0].taskId,second.id);assert.equal(list.activities[0].title,'Dots 更新与执行环境');
 const detail=await f.adapter.conversation(OWNER,second.id);assert.equal(detail.messages.length,2);assert.equal(new Set(detail.messages.map(m=>m.id)).size,2);assert.equal(detail.goal.title,'Dots 更新与执行环境');assert.equal(detail.relatedGoals.find(g=>g.id===first.id).status,'cancelled');
 const read=await f.adapter.activity(OWNER);assert.equal(read.activities[0].unread,false);
 await assert.rejects(()=>f.adapter.conversation('other-owner',second.id),e=>e.status===404);
});
