import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { createManagerStore } from './manager-store.ts';
import { createManagerRuntime, runStructuredTurn, buildManagerPrompt, MANAGER_SCHEMA } from './manager-runtime.ts';
import { canApplyGoalActions, resolveGoalRunState, resolveGoalRunFailure } from './goal-run-state.ts';

function fixture({legacy=false}={}) {
  const root=mkdtempSync(path.join(os.tmpdir(),'dots-manager-test-'));
  const database=path.join(root,'test.sqlite3');
  let db=new DatabaseSync(database),clock=100;
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE goals(id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT NOT NULL,instruction TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',thread_id TEXT,mac_thread_id TEXT,mac_last_route TEXT,workspace TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,next_wake_at INTEGER,last_run_at INTEGER,last_summary TEXT NOT NULL DEFAULT '',run_count INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT,goal_id INTEGER,type TEXT,payload TEXT,created_at INTEGER,consumed_at INTEGER);
    CREATE TABLE approvals(id INTEGER PRIMARY KEY AUTOINCREMENT,goal_id INTEGER,reason TEXT,command TEXT,status TEXT,created_at INTEGER,decided_at INTEGER,output TEXT);
    CREATE TABLE memories(id INTEGER PRIMARY KEY AUTOINCREMENT,goal_id INTEGER,kind TEXT,content TEXT,created_at INTEGER);
    CREATE TABLE timeline(id INTEGER PRIMARY KEY AUTOINCREMENT,goal_id INTEGER,kind TEXT,message TEXT,data TEXT,created_at INTEGER);
    CREATE TABLE notifications(id INTEGER PRIMARY KEY AUTOINCREMENT,goal_id INTEGER,level TEXT,title TEXT,body TEXT,created_at INTEGER,output_id INTEGER);
    CREATE TABLE agent_outputs(id INTEGER PRIMARY KEY AUTOINCREMENT,goal_id INTEGER,run_number INTEGER,thread_id TEXT,status TEXT,raw_result TEXT,summary TEXT,notification TEXT,created_at INTEGER);
  `);
  if(legacy)db.exec("INSERT INTO goals(title,instruction,status,workspace,created_at,updated_at,next_wake_at) VALUES('done','done','done','/old',1,1,NULL),('paused','paused','paused','/old',1,1,NULL),('active','active','active','/old',1,1,80)");
  let store=createManagerStore({db,workspaceRoot:path.join(root,'workspaces'),now:()=>clock});
  return {root,get db(){return db;},get store(){return store;},advance:(n: any)=>{clock+=n;},now:()=>clock,reopen:()=>{db.close();db=new DatabaseSync(database);store=createManagerStore({db,workspaceRoot:path.join(root,'workspaces'),now:()=>clock});},close:()=>{db.close();rmSync(root,{recursive:true,force:true});}};
}
const createTasks=(store: any,count=1,resourceKey='')=>store.createTasks(Array.from({length:count},(_,index)=>({key:'t'+index,title:'task '+index,instruction:'Produce result '+index,dependencies:[],acceptanceCriteria:'Result exists',resourceKey})));
const managerResult=(overrides={})=>({reply:'已安排任务。',summary:'拆解完成',tasks:[],reviews:[],controls:[],instructions:[],...overrides});

test('completed manager replies persist the exact merged user inputs across replay and restart',()=>{
  const f=fixture();try{
    const first=f.store.message({message:'语音第一句',requestId:'voice-one',host:'shiyan_desktop'}).message;
    const second=f.store.message({message:'手机补充',requestId:'mobile-two',host:'shiyan_mobile'}).message;
    const run=f.store.claimManager();
    const committed=f.store.completeManager(run,managerResult({reply:'一并处理。'}));
    assert.equal(committed.committed,true);
    assert.deepEqual(committed.value.message.respondsToMessageIds,[first.id,second.id]);
    assert.equal(committed.value.message.requestId,null);
    assert.equal(committed.value.message.taskId,null);
    const delivered=f.store.activity().activity.find((item: any)=>item.kind==='assistant_message');
    assert.deepEqual(delivered!.data.message.respondsToMessageIds,[first.id,second.id]);
    f.reopen();
    assert.deepEqual(f.store.snapshot().messages.at(-1).respondsToMessageIds,[first.id,second.id]);
    assert.deepEqual(f.store.messages({limit:1}).messages[0].respondsToMessageIds,[first.id,second.id]);
  }finally{f.close();}
});

test('superseded manager runs cannot attribute or deliver a reply to newer messages',()=>{
  const f=fixture();try{
    const first=f.store.message({message:'旧问题',requestId:'voice-old'}).message;
    const oldRun=f.store.claimManager();
    const second=f.store.message({message:'新问题',requestId:'voice-new'}).message;
    assert.equal(f.store.completeManager(oldRun,managerResult()).committed,false);
    f.store.failManager(oldRun,'superseded');
    assert.equal(f.store.snapshot().messages.filter((item: any)=>item.role==='assistant').length,0);
    assert.equal(f.store.activity().activity.filter((item: any)=>item.kind==='manager_error').length,0);
    const newRun=f.store.claimManager();assert.ok(newRun);
    const reply=f.store.completeManager(newRun,managerResult()).value.message;
    assert.deepEqual(reply.respondsToMessageIds,[first.id,second.id]);
  }finally{f.close();}
});

test('background task updates and foreign or non-user inbox records never complete a voice reply',()=>{
  const f=fixture();try{
    const [task]=createTasks(f.store);
    f.store.reportGoal(task.id,'done','后台结果');
    const foreign=f.db.prepare("INSERT INTO manager_messages(manager_id,role,content,created_at) VALUES('manager:other-owner','user','foreign',100)").run();
    const assistant=f.db.prepare("INSERT INTO manager_messages(manager_id,role,content,created_at) VALUES('manager:shiyan-private-owner','assistant','prior update',100)").run();
    const insert=f.db.prepare("INSERT INTO manager_inbox(manager_id,type,payload,created_at) VALUES('manager:shiyan-private-owner','user_message',?,100)");
    for(const id of [Number(foreign.lastInsertRowid),Number(assistant.lastInsertRowid),999999])insert.run(JSON.stringify({id}));
    f.advance(2);
    const run=f.store.claimManager();assert.ok(run);
    const reply=f.store.completeManager(run,managerResult({reply:'后台进度更新'})).value.message;
    assert.deepEqual(reply.respondsToMessageIds,[]);
  }finally{f.close();}
});

test('manager failure retains source IDs for the same pending input and retry',()=>{
  const f=fixture();try{
    const user=f.store.message({message:'说话等待回复',requestId:'voice-retry'}).message;
    const run=f.store.claimManager();f.store.failManager(run,'fixture connection lost');
    const failure=f.store.activity().activity.find((item: any)=>item.kind==='manager_error');
    assert.deepEqual(failure.data.respondsToMessageIds,[user.id]);
    assert.equal(f.store.snapshot().messages.filter((item: any)=>item.role==='assistant').length,0);
    f.advance(120);
    const retry=f.store.claimManager();assert.ok(retry);
    const reply=f.store.completeManager(retry,managerResult()).value.message;
    assert.deepEqual(reply.respondsToMessageIds,[user.id]);
  }finally{f.close();}
});

test('old manager message migration leaves historical replies unassociated',()=>{
  const f=fixture();try{
    f.db.exec('ALTER TABLE manager_messages DROP COLUMN responds_to_message_ids');
    f.db.exec("INSERT INTO manager_messages(manager_id,role,content,created_at) VALUES('manager:shiyan-private-owner','assistant','old reply',100)");
    f.reopen();
    assert.deepEqual(f.store.snapshot().messages[0].respondsToMessageIds,[]);
  }finally{f.close();}
});

test('migration preserves legacy stopped states, accepted history, and due times',()=>{
  const f=fixture({legacy:true});try{
    assert.equal(f.store.snapshot().name,'大内总管');
    const rows=f.db.prepare('SELECT * FROM goals ORDER BY id').all();
    assert.equal(rows[0]!.status,'done');assert.equal(rows[0]!.acceptance_status,'accepted');
    assert.equal(rows[1]!.status,'paused');assert.equal(rows[1]!.next_wake_at,null);
    assert.equal(rows[2]!.next_wake_at,80);
    assert.equal(f.store.claimGoal(1),null);assert.equal(f.store.claimGoal(2),null);
    assert.equal(f.store.claimManager(),null);assert.equal(f.store.snapshot().messages.length,0);
    f.reopen();assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM managers').get()!.n,1);
  }finally{f.close();}
});

test('message receipts survive restart and reject request reuse',()=>{
  const f=fixture();try{
    const message={message:'做一个报告',requestId:'request-one',host:'chatgpt'};
    const first=f.store.message(message);f.reopen();
    assert.deepEqual(f.store.message(message),first);
    assert.equal(f.store.snapshot().messages.length,1);
    assert.throws(()=>f.store.message({...message,message:'不同内容'}),/different content/);
    assert.throws(()=>f.store.requireOwner('other-owner'),/not found/);
  }finally{f.close();}
});

test('long-lived manager history and activity have durable cursor replay',()=>{
  const f=fixture();try{
    for(let i=0;i<105;i++)f.store.message({message:'message '+i,requestId:'history-'+i});
    const latest=f.store.snapshot();assert.equal(latest.messages.length,100);assert.equal(latest.hasMoreMessages,true);
    const earlier=f.store.messages({beforeId:latest.oldestMessageId,limit:100});
    assert.equal(earlier.messages.length,5);assert.equal(earlier.messages[0]!.content,'message 0');assert.equal(earlier.hasMore,false);
    const page=f.store.activity({limit:20});assert.equal(page.activity.length,20);assert.equal(page.hasMore,true);
    f.reopen();const replay=f.store.activity({afterId:page.nextCursor,limit:200});
    assert.equal(replay.activity.length,85);assert.ok(replay.activity.every((row: any)=>row.id>page.nextCursor));
  }finally{f.close();}
});

test('DAG rejects cycles atomically and waits for accepted dependencies',()=>{
  const f=fixture();try{
    assert.throws(()=>f.store.createTasks([{key:'a',title:'a',instruction:'a',dependencies:['b']},{key:'b',title:'b',instruction:'b',dependencies:['a']}]),/cycle/);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM goals').get()!.n,0);
    const tasks=f.store.createTasks([{key:'a',title:'a',instruction:'a',dependencies:[]},{key:'b',title:'b',instruction:'b',dependencies:['a']}]);
    assert.equal(f.store.taskEligibility(tasks[0]!.id),true);assert.equal(f.store.taskEligibility(tasks[1]!.id),false);
    f.db.prepare("UPDATE goals SET status='done' WHERE id=?").run(tasks[0]!.id);
    f.store.reportGoal(tasks[0]!.id,'done','result ready');assert.equal(f.store.taskEligibility(tasks[1]!.id),false);
    f.store.acceptTask(tasks[0]!.id,{accepted:true,reason:'checked artifact'});assert.equal(f.store.taskEligibility(tasks[1]!.id),true);
  }finally{f.close();}
});

test('leases allow two workers, one per task and one per shared resource',()=>{
  const f=fixture();try{
    const tasks=createTasks(f.store,3),first=f.store.claimGoal(tasks[0]!.id),second=f.store.claimGoal(tasks[1]!.id);
    assert.ok(first);assert.ok(second);assert.equal(f.store.claimGoal(tasks[2]!.id),null);assert.equal(f.store.claimGoal(tasks[0]!.id),null);
    f.store.finishRun(first);assert.ok(f.store.claimGoal(tasks[2]!.id));
  }finally{f.close();}
  const g=fixture();try{
    const tasks=createTasks(g.store,2,'shared-project');assert.ok(g.store.claimGoal(tasks[0]!.id));assert.equal(g.store.claimGoal(tasks[1]!.id),null);
  }finally{g.close();}
});

test('pause then resume fences a stale worker without consuming input',()=>{
  const f=fixture();try{
    const [task]=createTasks(f.store);f.db.prepare("INSERT INTO events(goal_id,type,payload,created_at) VALUES(?,'user_instruction','original',100)").run(task.id);
    const run=f.store.claimGoal(task.id);
    f.store.controlTask(task.id,'pause');f.store.controlTask(task.id,'resume');
    assert.equal(f.store.isCurrent(run),false);assert.equal(f.store.commitRun(run,()=>assert.fail('stale commit')).committed,false);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM events WHERE consumed_at IS NULL').get()!.n,2);
  }finally{f.close();}
});

test('manager pause keeps a running worker but does not implicitly resume dispatch',()=>{
  const f=fixture();try{
    const tasks=createTasks(f.store,2),run=f.store.claimGoal(tasks[0]!.id);
    f.store.control({action:'pause',requestId:'pause-manager'});assert.equal(f.store.isCurrent(run),true);
    assert.equal(f.store.claimGoal(tasks[1]!.id),null);assert.throws(()=>f.store.control({action:'wake',requestId:'wake-paused'}),/explicitly/);
    f.store.message({message:'现在进度如何',requestId:'paused-message'});
    const managerRun=f.store.claimManager();assert.ok(managerRun);
    assert.equal(f.store.completeManager(managerRun,managerResult({reply:'总管调度已暂停，现有工人仍在办理。'})).committed,true);
    assert.equal(f.store.snapshot().status,'paused');assert.equal(f.store.claimGoal(tasks[1]!.id),null);
  }finally{f.close();}
});

test('cancel stops unfinished tasks and explicit resume never restarts cancelled children',()=>{
  const f=fixture({legacy:true});try{
    f.store.control({action:'cancel',requestId:'cancel-all'});
    const tasks=f.store.snapshot().tasks;
    assert.equal(tasks.find((task: any)=>task.id===1)!.status,'done');assert.equal(tasks.find((task: any)=>task.id===1)!.acceptanceStatus,'accepted');
    assert.equal(tasks.find((task: any)=>task.id===2)!.status,'cancelled');assert.equal(tasks.find((task: any)=>task.id===3)!.status,'cancelled');
    f.store.control({action:'resume',requestId:'resume-manager'});assert.equal(f.store.snapshot().status,'active');assert.equal(f.store.claimGoal(3),null);
  }finally{f.close();}
});

test('expired action remains uncertain and retains the actual Mac resource until reviewed',()=>{
  const f=fixture();try{
    const tasks=createTasks(f.store,2),run=f.store.claimGoal(tasks[0]!.id);
    const action={type:'mac_codex',path:'/Users/yu/project',content:'work',command:'',reason:'work'};
    f.store.planActions(run,[action]);const receipt=f.store.beginAction(run,0,action);
    f.store.checkpointAction(receipt.id,{operationId:receipt.id,threadId:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',route:'yu'});
    f.advance(61);assert.equal(f.store.renewRun(run.id,run.fence),false);assert.equal(f.store.recoverExpired(),1);assert.equal(f.store.recoverExpired(),0);
    assert.equal(f.db.prepare('SELECT status FROM goals WHERE id=?').get(tasks[0]!.id)!.status,'blocked');
    assert.throws(()=>f.store.controlTask(tasks[0]!.id,'resume'),/uncertain/);
    const second=f.store.claimGoal(tasks[1]!.id);assert.ok(second);
    const deferred=f.store.beginAction(second,0,action);assert.equal(deferred.deferred,true);f.store.finishRun(second);
    assert.equal(f.store.claimGoal(tasks[1]!.id),null);
    f.store.controlTask(tasks[0]!.id,'pause');
    f.store.reconcileAction({actionId:receipt.id,outcome:'succeeded',note:'remote durable receipt checked',requestId:'reconcile-one',autoResume:true});
    assert.equal(f.db.prepare('SELECT status FROM goals WHERE id=?').get(tasks[0]!.id)!.status,'paused');
    assert.ok(f.store.claimGoal(tasks[1]!.id));
  }finally{f.close();}
});

test('expired planner can continue from the checkpointed thread without restoring paused tasks',()=>{
  const f=fixture();try{
    const [task]=createTasks(f.store),run=f.store.claimGoal(task.id);f.store.checkpointThread(run,'planner-thread');
    f.advance(61);f.store.recoverExpired();const retry=f.store.claimGoal(task.id);assert.equal(retry.thread_id,'planner-thread');assert.ok(retry.fence>run.fence);
    f.store.controlTask(task.id,'pause');f.advance(61);f.store.recoverExpired();assert.equal(f.store.claimGoal(task.id),null);
  }finally{f.close();}
});

test('real manager lane uses the SDK turn to delegate and later accept reported results',async()=>{
  const f=fixture();try{
    f.store.message({message:'分别做两个独立报告',requestId:'delegate'});
    let calls=0;
    const codex={startThread:()=>({id:'manager-thread',run:async()=>({finalResponse:JSON.stringify(managerResult({tasks:[{key:'a',title:'report a',instruction:'write a',dependencies:[],acceptance_criteria:'a exists',resource_key:''},{key:'b',title:'report b',instruction:'write b',dependencies:[],acceptance_criteria:'b exists',resource_key:''}]}))})}),resumeThread:()=>({id:'manager-thread',run:async()=>{calls++;return {finalResponse:JSON.stringify(managerResult({reply:'两个报告均已验收。',reviews:f.store.snapshot().tasks.map((task: any)=>({task_id:task.id,accepted:true,reason:'checked report'}))}))};}})};
    const runtime=createManagerRuntime({store:f.store,codex,workspaceRoot:f.root,logger:{error:()=>{}}});
    assert.equal(await runtime.wake(),true);const tasks=f.store.snapshot().tasks;assert.equal(tasks.length,2);
    const first=f.store.claimGoal(tasks[0]!.id),second=f.store.claimGoal(tasks[1]!.id);assert.ok(first);assert.ok(second);
    for(const run of [first,second])f.store.commitRun(run,()=>{f.db.prepare("UPDATE goals SET status='done',last_summary='report file exists' WHERE id=?").run(run.goal_id);f.store.reportGoal(run.goal_id,'done','report file exists');return {summary:'reported'};});
    f.advance(2);assert.equal(await runtime.wake(),true);assert.equal(calls,1);assert.ok(f.store.snapshot().tasks.every((task: any)=>task.acceptanceStatus==='accepted'));
    assert.equal(f.store.snapshot().messages.at(-1)!.content,'两个报告均已验收。');
  }finally{f.close();}
});

test('new user input invalidates an old manager plan and preserves both messages',async()=>{
  const f=fixture();try{
    f.store.message({message:'先做旧方案',requestId:'old-input'});
    const codex={startThread:()=>({id:'thread',run:async()=>{f.store.message({message:'改为新方案',requestId:'new-input'});return {finalResponse:JSON.stringify(managerResult({tasks:[{key:'old',title:'old',instruction:'old',dependencies:[]}]}))};}})};
    const runtime=createManagerRuntime({store:f.store,codex,workspaceRoot:f.root,logger:{error:()=>{}}});await runtime.wake();
    assert.equal(f.store.snapshot().tasks.length,0);assert.equal(f.store.snapshot().messages.length,2);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM manager_inbox WHERE consumed_at IS NULL').get()!.n,2);
  }finally{f.close();}
});

test('streamed thread-start is checkpointed before the final message',async()=>{
  let observed: string | null = null;
  const thread={runStreamed:async()=>({events:(async function*(){yield {type:'thread.started',thread_id:'thread-early'};assert.equal(observed,'thread-early');yield {type:'item.completed',item:{type:'agent_message',text:'{"ok":true}'}};yield {type:'turn.completed',usage:{input_tokens:1}};})()})};
  const turn=await runStructuredTurn(thread,'prompt',{}, {onThread:id=>{observed=id;}});assert.equal(turn.finalResponse,'{"ok":true}');
});

test('actual worker run commits input, output, report and a durable notification together',async()=>{
  const f=fixture();try{
    const [task]=createTasks(f.store);f.db.prepare("INSERT INTO events(goal_id,type,payload,created_at) VALUES(?,'user_instruction','do work',100)").run(task.id);
    const source=readFileSync(new URL('./server.mjs',import.meta.url),'utf8');
    const runSource=source.slice(source.indexOf('async function runGoal('),source.indexOf('function scheduleGoalNow('));
    const ctx=vm.createContext({ownerRegistry:{currentOwner:()=> 'shiyan-private-owner'},PRIVATE_OWNER:'shiyan-private-owner',db:f.db,managerStore:f.store,process,AbortController,setTimeout,clearTimeout,setInterval,clearInterval,runStructuredTurn,canApplyGoalActions,resolveGoalRunState,resolveGoalRunFailure,now:f.now,runningGoalId:null,getGoal:(id: any)=>f.db.prepare('SELECT * FROM goals WHERE id=?').get(id),listGoalMemories:()=>[],listGoalTimeline:()=>[],listPendingEvents:(id: any,limit: any)=>f.db.prepare('SELECT * FROM events WHERE goal_id=? AND consumed_at IS NULL ORDER BY id LIMIT ?').all(id,limit),storeMemories:()=>{},getThread:()=>({id:'worker-thread',run:async()=>({finalResponse:JSON.stringify({status:'done',summary:'result complete',notify:true,notification:'result complete',memories:[],actions:[],wake_after_seconds:900})})}),AGENT_SCHEMA:{},buildAgentPrompt:()=>'',parseJson:JSON.parse,json:JSON.stringify,clampInt:(value: any,min: any,max: any,fallback: any)=>value||fallback,executeSafeActions:async()=>[],addTimeline:(goalId: any,kind: any,message: any,data: any)=>f.db.prepare('INSERT INTO timeline(goal_id,kind,message,data,created_at) VALUES(?,?,?,?,?)').run(goalId,kind,message,JSON.stringify(data||{}),f.now()),createApproval:()=>assert.fail('unexpected approval'),mcpBridge:{emitNotification:async()=>{throw new Error('delivery unavailable');}},addNotification:async()=>assert.fail('durable notification should already exist')});
    vm.runInContext(runSource,ctx);await ctx.runGoal(task.id);
    assert.equal(f.db.prepare('SELECT status FROM goals WHERE id=?').get(task.id)!.status,'done');
    assert.equal(f.db.prepare('SELECT consumed_at FROM events').get()!.consumed_at,100);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM agent_outputs').get()!.n,1);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM notifications').get()!.n,1);
    assert.equal(f.db.prepare('SELECT state FROM manager_runs').get()!.state,'completed');
    assert.ok(f.store.activity({limit:200}).activity.some((event: any)=>event.kind==='worker_report'));
  }finally{f.close();}
});

test('approval binds the reviewed command and control revision before execution',()=>{
  const f=fixture();try{
    const [task]=createTasks(f.store),id=f.store.bindApproval(task.id,'review','printf ok');
    f.db.prepare("UPDATE goals SET status='waiting_approval' WHERE id=?").run(task.id);
    let approval=f.db.prepare('SELECT * FROM approvals WHERE id=?').get(id);assert.ok(f.store.validateApproval(approval));
    f.db.prepare("UPDATE approvals SET command='printf changed' WHERE id=?").run(id);
    approval=f.db.prepare('SELECT * FROM approvals WHERE id=?').get(id);assert.throws(()=>f.store.validateApproval(approval),/stale/);
    f.db.prepare("UPDATE approvals SET command='printf ok' WHERE id=?").run(id);f.store.controlTask(task.id,'cancel');
    approval=f.db.prepare('SELECT * FROM approvals WHERE id=?').get(id);assert.throws(()=>f.store.claimApproval(approval),/stale/);
  }finally{f.close();}
});

test('old executing approvals become uncertain receipts without rerunning commands',()=>{
  const f=fixture();try{
    const [task]=createTasks(f.store),id=f.store.bindApproval(task.id,'review','printf ok');
    f.db.prepare("UPDATE goals SET status='waiting_approval' WHERE id=?").run(task.id);
    f.db.prepare("UPDATE approvals SET status='executing' WHERE id=?").run(id);f.reopen();
    assert.equal(f.db.prepare('SELECT status FROM approvals WHERE id=?').get(id)!.status,'unknown');
    assert.equal(f.db.prepare('SELECT status FROM goals WHERE id=?').get(task.id)!.status,'blocked');
    assert.equal(f.store.unknownActions().length,1);assert.ok(f.db.prepare("SELECT 1 FROM manager_resources WHERE resource_key='host:executor'").get());
    const actionId=f.store.unknownActions()[0].id;
    f.store.reconcileAction({actionId,outcome:'succeeded',note:'User checked the old command outcome',requestId:'legacy-reviewed'});
    assert.equal(f.db.prepare('SELECT status FROM approvals WHERE id=?').get(id)!.status,'executed');
    assert.equal(f.db.prepare('SELECT status FROM goals WHERE id=?').get(task.id)!.status,'blocked');
  }finally{f.close();}
});

test('approval execution keeps a committed success when notification delivery fails',async()=>{
  const f=fixture();try{
    const [task]=createTasks(f.store),id=f.store.bindApproval(task.id,'review','printf ok');
    f.db.prepare("UPDATE goals SET status='waiting_approval' WHERE id=?").run(task.id);
    const source=readFileSync(new URL('./server.mjs',import.meta.url),'utf8');
    const approvalSource=source.slice(source.indexOf('async function decideApproval('),source.indexOf('function detailedGoal('));
    let calls=0;
    const ctx=vm.createContext({ownerRegistry:{currentOwner:()=> 'shiyan-private-owner'},PRIVATE_OWNER:'shiyan-private-owner',db:f.db,managerStore:f.store,process,setInterval,clearInterval,now:f.now,getGoal:(id: any)=>f.db.prepare('SELECT * FROM goals WHERE id=?').get(id),catastrophicCommand:()=>false,execFileAsync:async()=>{calls++;return {stdout:'ok',stderr:''};},scheduleGoalNow:()=>{},addTimeline:()=>{},addNotification:async()=>{throw new Error('notification unavailable');}});
    vm.runInContext(approvalSource,ctx);const result=await ctx.decideApproval(id,'approve');
    assert.equal(result.state,'executed');assert.equal(calls,1);assert.equal(f.db.prepare('SELECT status FROM approvals WHERE id=?').get(id)!.status,'executed');
    assert.equal(f.db.prepare("SELECT state FROM manager_actions WHERE json_extract(payload,'$.approvalId')=?").get(id)!.state,'succeeded');
  }finally{f.close();}
});

test('approval timeout becomes unknown and blocks replay until explicit reconciliation',async()=>{
  const f=fixture();try{
    const [task]=createTasks(f.store),id=f.store.bindApproval(task.id,'review','printf ok');f.db.prepare("UPDATE goals SET status='waiting_approval' WHERE id=?").run(task.id);
    const source=readFileSync(new URL('./server.mjs',import.meta.url),'utf8');
    const approvalSource=source.slice(source.indexOf('async function decideApproval('),source.indexOf('function detailedGoal('));
    const ctx=vm.createContext({ownerRegistry:{currentOwner:()=> 'shiyan-private-owner'},PRIVATE_OWNER:'shiyan-private-owner',db:f.db,managerStore:f.store,process,setInterval,clearInterval,now:f.now,getGoal:(id: any)=>f.db.prepare('SELECT * FROM goals WHERE id=?').get(id),catastrophicCommand:()=>false,execFileAsync:async()=>{throw Object.assign(new Error('timed out'),{killed:true});},scheduleGoalNow:()=>assert.fail('unknown command must not schedule replay'),addTimeline:()=>{},addNotification:async()=>{}});
    vm.runInContext(approvalSource,ctx);const result=await ctx.decideApproval(id,'approve');assert.equal(result.httpStatus,409);
    assert.equal(f.db.prepare('SELECT status FROM approvals WHERE id=?').get(id)!.status,'unknown');assert.equal(f.db.prepare('SELECT status FROM goals WHERE id=?').get(task.id)!.status,'blocked');
    assert.ok(f.db.prepare("SELECT 1 FROM manager_resources WHERE resource_key='host:executor'").get());
  }finally{f.close();}
});

test('stale manager failure preserves immediate new input and persistent user notes survive restart',()=>{
  const f=fixture();try{
    const first=f.store.message({message:'报告默认中文',requestId:'pref'}),run=f.store.claimManager();
    f.store.message({message:'现在开始',requestId:'newer'});f.store.failManager(run,'old turn error');
    assert.equal(f.db.prepare('SELECT next_wake_at FROM managers').get()!.next_wake_at,100);
    const next=f.store.claimManager();assert.ok(next);
    f.store.completeManager(next,managerResult({notes:[{key:'report-language',scope:'user_preference',content:'报告使用中文',source_message_id:first.message.id}]}));
    f.reopen();assert.equal(f.store.snapshot().notes[0]!.content,'报告使用中文');
  }finally{f.close();}
});

test('scheduler does not starve an eligible task behind one hundred waiting dependencies',async()=>{
  const f=fixture();try{
    const [dependency]=createTasks(f.store);f.db.prepare("UPDATE goals SET status='blocked' WHERE id=?").run(dependency.id);
    for(let batch=0;batch<13;batch++)f.store.createTasks(Array.from({length:8},(_,index)=>({key:'b'+batch+'-'+index,title:'waiting '+batch+'-'+index,instruction:'waiting',dependencies:['task:'+dependency.id]})));
    const [ready]=f.store.createTasks([{key:'ready',title:'Independent ready issue',instruction:'Execute ready work',dependencies:[]}]),seen: any[]=[];
    const source=readFileSync(new URL('./server.mjs',import.meta.url),'utf8');
    const schedulerSource=source.slice(source.indexOf('async function schedulerTickForOwner('),source.indexOf('async function schedulerTick(',source.indexOf('async function schedulerTickForOwner(')));
    const ctx=vm.createContext({ownerRegistry:{currentOwner:()=> 'shiyan-private-owner'},PRIVATE_OWNER:'shiyan-private-owner',db:f.db,managerStore:f.store,managerRuntime:{wake:async()=>{}},reconcileUnknownMacActions:async()=>{},now:f.now,runGoal:(id: any)=>{seen.push(id);return Promise.resolve();},console});
    vm.runInContext(schedulerSource,ctx);await ctx.schedulerTickForOwner();assert.deepEqual(seen,[ready.id]);
  }finally{f.close();}
});

test('HTTP idempotent message and control replays do not abort a valid manager turn',async()=>{
  const f=fixture();try{
    const source=readFileSync(new URL('./server.mjs',import.meta.url),'utf8');
    const handleSource=source.slice(source.indexOf('async function handle('),source.indexOf('let closeLocalMcpSocket'));
    let abort: AbortController | null = null,interrupts=0,response: any;
    const ctx=vm.createContext({ownerRegistry:{currentOwner:()=> 'shiyan-private-owner'},PRIVATE_OWNER:'shiyan-private-owner',db:f.db,managerStore:f.store,managerRuntime:{interrupt:()=>{interrupts++;abort?.abort();},wake:async()=>{}},HOST:'127.0.0.1',PORT:4330,TOKEN:'test-fixture',URL,mcpBridge:{matches:()=>false},readJson:async (req: any)=>req.body,send:(_res: any,status: any,body: any)=>{response={status,body};},setImmediate:()=>{}});
    vm.runInContext(handleSource,ctx);
    const invoke=async(operation: any,body: any)=>{await ctx.handle({method:'POST',url:'/v1/managers/shiyan-private-owner/'+operation,headers:{authorization:'Bearer test-fixture'},body},{});return response;};
    const input={message:'只计算13乘17',requestId:'http-message-one',host:'shiyan_desktop'};
    const first=await invoke('messages',input);assert.equal(first.status,202);assert.equal(interrupts,1);
    const run=f.store.claimManager();assert.ok(run);abort=new AbortController();
    const duplicate=await invoke('messages',input);
    assert.equal(duplicate.body.message.id,first.body.message.id);assert.equal(abort!.signal.aborted,false);assert.equal(interrupts,1);assert.equal(f.store.isCurrent(run),true);
    await invoke('messages',{...input,requestId:'http-message-two',message:'现在查进度'});
    assert.equal(abort!.signal.aborted,true);assert.equal(interrupts,2);
    await invoke('control',{action:'pause',requestId:'http-control-one'});assert.equal(interrupts,3);
    abort=new AbortController();await invoke('control',{action:'pause',requestId:'http-control-one'});
    assert.equal(abort!.signal.aborted,false);assert.equal(interrupts,3);
  }finally{f.close();}
});


test('one issue retains its task across blocking, repair and acceptance',()=>{
  const f=fixture();try{
    const [original]=f.store.createTasks([{key:'issue',title:'修复执行权限',instruction:'排查并验证执行权限',dependencies:[]}]);
    f.db.prepare("UPDATE goals SET status='blocked',next_wake_at=NULL WHERE id=?").run(original.id);
    assert.throws(()=>f.store.createTasks([{key:'duplicate',title:'  修复执行权限  ',instruction:'继续修复',dependencies:[]}]),/already has a task/);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM goals').get()!.n,1);
    f.store.controlTask(original.id,'instruct',{message:'权限已修复，在原事项验证结果'});
    assert.equal(f.store.snapshot().tasks.find((t: any)=>t.id===original.id)!.status,'active');
    f.db.prepare("UPDATE goals SET status='done',acceptance_status='pending' WHERE id=?").run(original.id);
    assert.throws(()=>f.store.createTasks([{key:'verify',title:'修复执行权限',instruction:'验收',dependencies:[]}]),/already has a task/);
    f.store.acceptTask(original.id,{accepted:false,reason:'需要补齐验证'});
    assert.equal(f.store.snapshot().tasks.find((t: any)=>t.id===original.id)!.status,'active');
  }finally{f.close();}
});

test('duplicate issues in one plan fail atomically',()=>{
  const f=fixture();try{
    assert.throws(()=>f.store.createTasks([{key:'one',title:'Repair login',instruction:'check',dependencies:[]},{key:'two',title:'repair   login',instruction:'repair',dependencies:[]}]),/already has a task/);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM goals').get()!.n,0);
    const tasks=f.store.createTasks([{key:'one',title:'修复登录',instruction:'check',dependencies:[]},{key:'two',title:'修复图片预览',instruction:'check',dependencies:[]}]);
    assert.equal(tasks.length,2);
  }finally{f.close();}
});


const continuation=(task: any,user: any,overrides={})=>({task_id:task.id,message:'修复后继续验证同一功能',source_message_ids:[user.id],reason:'同一项目、同一功能及验收目标的补充要求',resource_key:task.resourceKey||'',...overrides});

test('semantic continuation retains task identity, worker threads, dependencies and history across restart',async()=>{
  const f=fixture();try{
    const [original]=f.store.createTasks([{key:'login',title:'修复拾燕登录后空白',instruction:'排查登录回调',resource_key:'mac:/Users/yu/codex/拾燕',dependencies:[]}]);
    f.db.prepare("UPDATE goals SET thread_id='worker-thread',mac_thread_id='mac-thread',run_count=4 WHERE id=?").run(original.id);
    f.store.message({message:'进入账号以后屏幕还是空的，接着看下回调并验证',requestId:'related-followup'});
    const user=f.store.snapshot().messages.at(-1);
    const prompts: any[] = [];
    const result=managerResult({reply:'继续处理登录后空白。',continuations:[continuation(original,user,{message:user.content})]});
    const codex={startThread:()=>({id:'manager',run:async (prompt: any)=>{prompts.push(prompt);return {finalResponse:JSON.stringify(result)};}})};
    assert.equal(await createManagerRuntime({store:f.store,codex,workspaceRoot:f.root,logger:{error(){}}}).wake(),true);
    assert.equal(f.store.snapshot().tasks.length,1);
    const row=f.db.prepare('SELECT * FROM goals WHERE id=?').get(original.id)!;
    assert.equal(row.id,original.id);assert.equal(row.thread_id,'worker-thread');assert.equal(row.mac_thread_id,'mac-thread');assert.equal(row.run_count,4);
    assert.equal(row.instruction,'排查登录回调');assert.equal(row.status,'active');
    assert.equal(f.db.prepare("SELECT payload FROM events WHERE goal_id=? AND type='user_instruction'").get(original.id)!.payload,user.content);
    assert.match(prompts[0],/Shared words or being in the same project alone are not sufficient/);
    f.reopen();assert.equal(f.store.snapshot().tasks.length,1);
    assert.deepEqual(f.store.taskContinuationContext(original.id),[user.content]);
    assert.equal(f.store.activity().activity.find((a: any)=>a.kind==='task_continued')!.taskId,original.id);
  }finally{f.close();}
});

test('new user follow-up reopens the same completed task without replacing its accepted history or thread',()=>{
  const f=fixture();try{
    const [original]=createTasks(f.store);
    f.db.prepare("UPDATE goals SET status='done',acceptance_status='accepted',thread_id='keep-thread',last_summary='此前验收结果',next_wake_at=NULL WHERE id=?").run(original.id);
    const user=f.store.message({message:'这个问题还有一个边界情况，接着修复',requestId:'after-acceptance'}).message;
    const run=f.store.claimManager();const completed=f.store.completeManager(run,managerResult({continuations:[continuation(original,user)]}));
    assert.equal(completed.value.tasks.length,0);assert.equal(completed.value.continuedTasks[0].id,original.id);
    const row=f.db.prepare('SELECT * FROM goals WHERE id=?').get(original.id)!;
    assert.equal(row.status,'active');assert.equal(row.acceptance_status,'changes_requested');assert.equal(row.thread_id,'keep-thread');assert.equal(row.last_summary,'此前验收结果');
    assert.equal(f.store.taskEligibility(original.id),true);
    assert.equal(f.store.completeManager(run,managerResult({continuations:[continuation(original,user)]})).committed,false);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM events WHERE type='user_instruction'").get()!.n,1);
  }finally{f.close();}
});

test('continuations reevaluate pending proposals while preserving paused and uncertain execution safeguards',()=>{
  for(const blockedBy of ['paused','pending','unknown']){
    const f=fixture();try{
      const [original]=createTasks(f.store);
      if(blockedBy==='paused')f.store.controlTask(original.id,'pause');
      if(blockedBy==='pending'){
        f.db.prepare("INSERT INTO approvals(goal_id,status,reason,command,created_at) VALUES(?,'pending','approval','fixture',100)").run(original.id);
        f.db.prepare("UPDATE goals SET status='waiting_approval',next_wake_at=NULL WHERE id=?").run(original.id);
      }
      if(blockedBy==='unknown'){
        const worker=f.store.claimGoal(original.id);f.store.beginAction(worker,0,{type:'host_command',command:'fixture'});
        f.store.finishAction(worker.id+':0',{type:'host_command',uncertain:true});
      }
      const before=f.store.snapshot().tasks[0];
      const user=f.store.message({message:'同一问题再补充这一点',requestId:'deferred-'+blockedBy}).message;
      const run=f.store.claimManager();assert.ok(run);
      f.store.completeManager(run,managerResult({continuations:[continuation(original,user)]}));
      const after=f.store.snapshot().tasks[0];
      if(blockedBy==='pending'){
        assert.equal(after.status,'active');assert.equal(after.controlRevision,before.controlRevision+1);assert.equal(after.nextWakeAt,f.now());
        assert.equal(f.db.prepare('SELECT status FROM approvals WHERE goal_id=?').get(original.id)!.status,'superseded');
        assert.equal(f.store.taskEligibility(original.id),true);
        assert.equal(f.store.activity({limit:200}).activity.find((a: any)=>a.kind==='task_continued')!.data.deferred,false);
      }else{
        assert.equal(after.status,before.status);assert.equal(after.controlRevision,before.controlRevision);assert.equal(after.nextWakeAt,before.nextWakeAt);
        assert.equal(f.store.taskEligibility(original.id),false);
        assert.equal(f.store.activity({limit:200}).activity.find((a: any)=>a.kind==='task_continued')!.data.deferred,true);
      }
      assert.equal(f.store.taskContinuationContext(original.id).length,1);
    }finally{f.close();}
  }
});

test('continuation rejects foreign or stale sources, mismatched projects, cancelled targets and duplicate routes atomically',()=>{
  for(const invalid of ['foreign-source','old-source','other-project','missing-project','cancelled','duplicate']){
    const f=fixture();try{
      const [original]=f.store.createTasks([{key:'one',title:'Issue',instruction:'Repair',dependencies:[],resource_key:'project:A'}]);
      const old=f.store.message({message:'Old',requestId:'old'}).message;
      f.store.completeManager(f.store.claimManager(),managerResult());
      if(invalid==='cancelled')f.store.controlTask(original.id,'cancel');
      const user=f.store.message({message:'Follow-up',requestId:'new'}).message;
      const command=continuation(original,user);
      if(invalid==='foreign-source')command.source_message_ids=[999999];
      if(invalid==='old-source')command.source_message_ids=[old.id];
      if(invalid==='other-project')command.resource_key='project:B';
      if(invalid==='missing-project')command.resource_key='';
      const run=f.store.claimManager();
      assert.throws(()=>f.store.completeManager(run,managerResult({continuations:invalid==='duplicate'?[command,command]:[command]})));
      assert.equal(f.db.prepare("SELECT count(*) AS n FROM events WHERE type='user_instruction'").get()!.n,0);
      assert.equal(f.store.snapshot().tasks.length,1);
      assert.equal(f.store.snapshot().messages.filter((m: any)=>m.role==='assistant').length,1);
    }finally{f.close();}
  }
});

test('background reports cannot reopen completed tasks without new user authorization',()=>{
  const f=fixture();try{
    const [original]=createTasks(f.store);
    const user=f.store.message({message:'Original request',requestId:'original'}).message;
    f.store.completeManager(f.store.claimManager(),managerResult());
    f.db.prepare("UPDATE goals SET status='done',acceptance_status='accepted',next_wake_at=NULL WHERE id=?").run(original.id);
    f.store.reportGoal(original.id,'done','Worker report');f.advance(2);
    assert.throws(()=>f.store.completeManager(f.store.claimManager(),managerResult({continuations:[continuation(original,user)]})),/current user/);
    assert.equal(f.store.snapshot().tasks[0]!.status,'done');
  }finally{f.close();}
});

test('routing prompt includes older active issues beyond the UI snapshot and distinguishes explicit new work',()=>{
  const f=fixture();try{
    const [old]=f.store.createTasks([{key:'old',title:'Older active issue',instruction:'Original requirement',dependencies:[]}]);
    const insert=f.db.prepare("INSERT INTO goals(title,instruction,status,workspace,manager_id,acceptance_status,created_at,updated_at) VALUES(?,'Completed','done','/fixture',?,'accepted',100,100)");
    for(let index=0;index<505;index++)insert.run('Historical '+index,f.store.managerId);
    f.store.message({message:'Continue the original issue',requestId:'old-issue'});
    const prompt=buildManagerPrompt(f.store,f.store.claimManager());
    assert.equal(f.store.snapshot().tasks.some((t: any)=>t.id===old.id),false);
    assert.match(prompt,/Older active issue/);
    assert.match(prompt,/explicitly asks for an independent or new task/);
    assert.ok(MANAGER_SCHEMA.required.includes('continuations'));
    assert.deepEqual(MANAGER_SCHEMA.properties.continuations.items.required,['task_id','message','source_message_ids','reason','resource_key']);
  }finally{f.close();}
});

test('same title in distinct projects does not force unrelated work onto the same task',()=>{
  const f=fixture();try{
    const tasks=f.store.createTasks([{key:'a',title:'修复登录',instruction:'Project A',resource_key:'project:A',dependencies:[]},{key:'b',title:'修复登录',instruction:'Project B',resource_key:'project:B',dependencies:[]}]);
    assert.equal(tasks.length,2);assert.notEqual(tasks[0]!.id,tasks[1]!.id);
    assert.throws(()=>f.store.createTasks([{key:'again',title:'修复登录',instruction:'Continue A',resource_key:'project:A',dependencies:[]}]),/already has a task/);
  }finally{f.close();}
});


test('Mac execution preserves stable project identity for duplicate protection and continuation routing',()=>{
  const f=fixture();try{
    const [original]=f.store.createTasks([{key:'one',title:'修复登录',instruction:'Repair A',dependencies:[],resource_key:'mac:/Users/yu/A'}]);
    const worker=f.store.claimGoal(original.id);
    f.store.beginAction(worker,0,{type:'mac_codex',path:'/Users/yu/A',prompt:'Repair login'});
    assert.equal(f.db.prepare('SELECT resource_key FROM goals WHERE id=?').get(original.id)!.resource_key,'mac:/Users/yu/A');
    assert.ok(f.db.prepare("SELECT 1 FROM manager_resources WHERE resource_key='mac:executor'").get());
    f.store.finishAction(worker.id+':0',{type:'mac_codex',ok:true});f.store.finishRun(worker);
    assert.throws(()=>f.store.createTasks([{key:'dup',title:'修复登录',instruction:'Continue A',dependencies:[],resource_key:'mac:/Users/yu/A/'}]),/already has a task/);
    assert.equal(f.store.snapshot().tasks.length,1);
    const user=f.store.message({message:'Continue login in B',requestId:'cross-project'}).message;
    const run=f.store.claimManager();
    assert.throws(()=>f.store.completeManager(run,managerResult({continuations:[continuation(original,user,{resource_key:'mac:/Users/yu/B'})]})),/project does not match/);
    f.store.completeManager(run,managerResult({continuations:[continuation(original,user,{resource_key:'mac:/Users/yu/A'})]}));
    assert.equal(f.store.snapshot().tasks.length,1);
  }finally{f.close();}
});

test('legacy executor-only keys recover the recorded Mac project and never behave as a wildcard',()=>{
  const f=fixture();try{
    const [original]=f.store.createTasks([{key:'one',title:'修复登录',instruction:'Repair A',dependencies:[],resource_key:'mac:/Users/yu/A'}]);
    const worker=f.store.claimGoal(original.id);
    f.store.beginAction(worker,0,{type:'mac_codex',path:'/Users/yu/A',prompt:'Repair'});
    f.store.finishAction(worker.id+':0',{type:'mac_codex',ok:true});f.store.finishRun(worker);
    f.db.prepare("UPDATE goals SET resource_key='mac:executor' WHERE id=?").run(original.id);
    f.reopen();
    assert.equal(f.store.snapshot().tasks[0]!.resourceKey,'mac:/Users/yu/A');
    assert.equal(f.store.routingTasks()[0].resourceKey,'mac:/Users/yu/A');
    assert.throws(()=>f.store.createTasks([{key:'dup',title:'修复登录',instruction:'Continue A',dependencies:[],resource_key:'mac:/Users/yu/A'}]),/already has a task/);
    const user=f.store.message({message:'Continue',requestId:'legacy-project'}).message;
    const run=f.store.claimManager();
    for(const wrong of ['mac:/Users/yu/B','mac:executor',''])assert.throws(()=>f.store.completeManager(run,managerResult({continuations:[continuation(original,user,{resource_key:wrong})]})),/project does not match/);
    f.store.completeManager(run,managerResult({continuations:[continuation(original,user)]}));
    assert.equal(f.store.snapshot().tasks.length,1);
  }finally{f.close();}
});

test('unknown legacy executor project cannot bypass the project guard with another path',()=>{
  const f=fixture();try{
    const [original]=f.store.createTasks([{key:'one',title:'Legacy',instruction:'Unknown project',dependencies:[],resource_key:'mac:executor'}]);
    const user=f.store.message({message:'Continue',requestId:'unknown-project'}).message;
    assert.throws(()=>f.store.completeManager(f.store.claimManager(),managerResult({continuations:[continuation(original,user,{resource_key:'mac:/Users/yu/B'})]})),/project does not match/);
  }finally{f.close();}
});


test('large task history stays within a strict prompt budget while retaining old active and explicitly referenced issues',()=>{
  const f=fixture();try{
    const [active]=f.store.createTasks([{key:'old-active',title:'早期仍在处理的事项',instruction:'Continue active issue',dependencies:[]}]);
    const original='原始要求'.repeat(3000)+'要求末尾不得丢失';
    const insert=f.db.prepare("INSERT INTO goals(title,instruction,status,workspace,manager_id,acceptance_status,last_summary,created_at,updated_at) VALUES(?,?,'done','/fixture',?,'accepted',?,100,100)");
    let target: any;
    for(let index=0;index<505;index++){
      const result=insert.run('历史事项 '+index,original,f.store.managerId,'很长的完成报告'.repeat(1200));
      if(index===490)target=Number(result.lastInsertRowid);
    }
    f.store.message({message:'继续事项 '+target+'，沿用原来的验收条件',requestId:'large-history'});
    const run=f.store.claimManager();
    const prompt=buildManagerPrompt(f.store,run);
    assert.ok(prompt.length<180000,String(prompt.length));assert.ok(Buffer.byteLength(prompt)<480000,String(Buffer.byteLength(prompt)));
    assert.match(prompt,/早期仍在处理的事项/);
    const context=JSON.parse(prompt.split('TASKS AND REPORTS\n')[1].split('\nNEW INPUT')[0]);
    assert.ok(context.directory.some((task: any)=>task.id===active.id));assert.ok(context.directory.some((task: any)=>task.id===target));
    assert.equal(context.totalTasks,506);assert.ok(context.directory.length>20);
    assert.equal(MANAGER_SCHEMA.properties.inspect_tasks,undefined);
    assert.match(prompt,/directoryHint/);
    assert.ok(context.directory.some((task: any)=>task.id===target));
  }finally{f.close();}
});

test('manager uses one model call with server-prepared task context to continue historical work',async()=>{
  const f=fixture();try{
    const original='完整原始要求'.repeat(1800)+'最后必须验证边界';
    const [task]=f.store.createTasks([{key:'one',title:'旧事项',instruction:original,dependencies:[],resource_key:'project:A'}]);
    f.db.prepare("UPDATE goals SET status='done',acceptance_status='accepted',thread_id='preserved-worker',last_summary='此前执行结果' WHERE id=?").run(task.id);
    const user=f.store.message({message:'继续原来的旧事项',requestId:'single-call-followup'}).message;
    let turns=0;
    const thread={id:'manager-thread',run:async (prompt: any)=>{
      turns++;
      assert.match(prompt,/旧事项/);
      assert.match(prompt,/完整原始要求/);
      assert.match(prompt,/此前执行结果/);
      assert.equal(MANAGER_SCHEMA.properties.inspect_tasks,undefined);
      return {finalResponse:JSON.stringify(managerResult({continuations:[continuation(task,user)]}))};
    }};
    assert.equal(await createManagerRuntime({store:f.store,codex:{startThread:()=>thread},workspaceRoot:f.root,logger:{error(){}}}).wake(),true);
    assert.equal(turns,1);assert.equal(f.store.snapshot().tasks.length,1);
    assert.equal(f.store.snapshot().messages.filter((m: any)=>m.role==='assistant').length,1);
    assert.equal(f.db.prepare('SELECT thread_id FROM goals WHERE id=?').get(task.id)!.thread_id,'preserved-worker');
    assert.equal(f.store.snapshot().tasks[0]!.status,'active');
  }finally{f.close();}
});

test('inspection cannot mutate task state, access another manager or hide a stale planning lease',async()=>{
  const f=fixture();try{
    const [task]=createTasks(f.store);
    f.db.prepare("INSERT INTO goals(title,instruction,status,workspace,manager_id,created_at,updated_at) VALUES('Foreign','private','active','/foreign','manager:foreign',100,100)").run();
    assert.throws(()=>f.store.inspectRoutingTask({task_id:task.id+1,query:''}),/not found/);
    assert.deepEqual(f.store.inspectRoutingTask({task_id:null,query:'Foreign'}).matches,[]);
    f.store.message({message:'Inspect first',requestId:'inspect-stale'});
    const thread={id:'manager-thread',run:async()=>{
      f.store.message({message:'New input supersedes the inspection',requestId:'newer-input'});
      return {finalResponse:JSON.stringify(managerResult({inspect_tasks:[{task_id:task.id,query:''}]}))};
    }};
    assert.equal(await createManagerRuntime({store:f.store,codex:{startThread:()=>thread},workspaceRoot:f.root,logger:{error(){}}}).wake(),false);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM manager_runs WHERE state='running'").get()!.n,0);
    assert.equal(f.store.snapshot().messages.filter((m: any)=>m.role==='assistant').length,0);
    assert.ok(f.store.claimManager());
  }finally{f.close();}
});

test('images uploaded in web Dots and WeChat are handed to the model as images', async () => {
  const { pendingImagePaths } = await import('./manager-runtime.ts');
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dots-img-'));
  try {
    const host = path.join(dir, 'a', '图 1.png'); mkdirSync(path.dirname(host), { recursive: true }); writeFileSync(host, 'x');
    const member = path.join(dir, 'ws', 'inputs', 'id1', 'b.JPG'); mkdirSync(path.dirname(member), { recursive: true }); writeFileSync(member, 'x');
    const content = '看看\n\n[用户上传的附件]\n' + JSON.stringify({ filename: '图 1.png', path: host }) + '\n' + JSON.stringify({ filename: 'b.JPG', path: '/workspace/inputs/id1/b.JPG' }) + '\n' + JSON.stringify({ filename: 'c.pdf', path: '/workspace/inputs/id1/c.pdf' });
    const store = { pendingManagerInbox: () => [{ type: 'user_message', payload: JSON.stringify({ content }) }] };
    const resolve = (file: any) => file.startsWith('/workspace/') ? path.join(dir, 'ws', file.slice('/workspace/'.length)) : file;
    assert.deepEqual(pendingImagePaths(store, {}, resolve), [host, member]);
    assert.deepEqual(pendingImagePaths(store, {}, () => ''), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
