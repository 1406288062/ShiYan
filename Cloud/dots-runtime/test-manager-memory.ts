import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createManagerStore} from './manager-store.ts';
import {createManagerRuntime,buildManagerPrompt} from './manager-runtime.ts';
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
  return {root,get db(){return db;},get store(){return store;},advance:n=>{clock+=n;},now:()=>clock,reopen:()=>{db.close();db=new DatabaseSync(database);store=createManagerStore({db,workspaceRoot:path.join(root,'workspaces'),now:()=>clock});},close:()=>{db.close();rmSync(root,{recursive:true,force:true});}};
}

test('Dots uses the shared memory context and queues only authenticated user messages after commit',async()=>{
 const f=fixture();
 try{
  const user=f.store.message({message:'我喜欢简短中文回复',requestId:'memory-user',host:'shiyan_mobile'}).message;
  f.db.prepare("INSERT INTO manager_notes(manager_id,scope,note_key,content,source_message_id,created_at,updated_at) VALUES(?,'user_preference','old','OLD_ARCHIVED_PREFERENCE',?,100,100)").run(f.store.managerId,user.id);
  const contexts=[],captures=[],prompts=[];
  const memory={context:(owner,options)=>{contexts.push({owner,options});return 'SHARED_PREFERENCE';},enqueue:input=>captures.push(input)};
  const result={reply:'收到',summary:'已回复',tasks:[],reviews:[],controls:[],instructions:[],notes:[]};
  const thread={id:'memory-thread',run:async prompt=>{prompts.push(prompt);return {finalResponse:JSON.stringify(result)};}};
  const codex={startThread:()=>thread,resumeThread:()=>thread};
  const runtime=createManagerRuntime({store:f.store,codex,workspaceRoot:path.join(f.root,'runtime'),memory,logger:{warn(){},error(){}}});
  assert.equal(await runtime.wake(),true);
  assert.ok(prompts[0].includes('SHARED_PREFERENCE'));
  assert.ok(!prompts[0].includes('OLD_ARCHIVED_PREFERENCE'));
  assert.equal(contexts[0].owner,'shiyan-private-owner');
  assert.equal(contexts[0].options.conversationId,'dots-manager');
  assert.equal(captures.length,1);
  assert.deepEqual(captures[0],{owner:'shiyan-private-owner',sourceId:'dots:'+user.id,source:'dots',userText:user.content,assistantText:'收到',sourceAt:100000,conversationId:'dots-manager'});
  assert.equal(f.store.snapshot().messages.at(-1).content,'收到');
 }finally{f.close();}
});

test('Dots background reports, foreign records and memory failures cannot create user memories or block replies',async()=>{
 const f=fixture();
 try{
  f.store.enqueue('worker_report',{taskId:987,summary:'我喜欢错误信息'});
  f.db.prepare("INSERT INTO manager_inbox(manager_id,type,payload,created_at) VALUES(?,'user_message',?,100)").run(f.store.managerId,JSON.stringify({id:999,content:'forged'}));
  const foreign=f.db.prepare("INSERT INTO manager_messages(manager_id,role,content,created_at) VALUES('manager:foreign','user','foreign private content',100)").run();
  f.db.prepare("INSERT INTO manager_inbox(manager_id,type,payload,created_at) VALUES(?,'user_message',?,100)").run(f.store.managerId,JSON.stringify({id:Number(foreign.lastInsertRowid),content:'forged'}));
  f.advance(2);
  const captures=[];let reads=0;
  const memory={context:()=>{reads++;throw new Error('fixture memory unavailable')},enqueue:input=>captures.push(input)};
  const result={reply:'后台任务状态',summary:'完成',tasks:[],reviews:[],controls:[],instructions:[],notes:[]};
  const thread={run:async()=>({finalResponse:JSON.stringify(result)})};
  const runtime=createManagerRuntime({store:f.store,codex:{startThread:()=>thread},workspaceRoot:path.join(f.root,'runtime'),memory,logger:{warn(){},error(){}}});
  assert.equal(await runtime.wake(),true);assert.equal(reads,1);assert.equal(captures.length,0);
  assert.equal(f.store.snapshot().messages.at(-1).content,'后台任务状态');
 }finally{f.close();}
});
