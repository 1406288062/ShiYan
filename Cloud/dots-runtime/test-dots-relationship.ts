import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createManagerStore} from './manager-store.ts';
import {buildManagerPrompt,MANAGER_SCHEMA} from './manager-runtime.ts';

function fixture(){
  const root=mkdtempSync(path.join(os.tmpdir(),'dots-relationship-')),file=path.join(root,'db.sqlite');let clock=1792000000,db=new DatabaseSync(file),store;
  db.exec(`CREATE TABLE goals(id INTEGER PRIMARY KEY,title TEXT,instruction TEXT,status TEXT,thread_id TEXT,workspace TEXT,created_at INTEGER,updated_at INTEGER,next_wake_at INTEGER,last_run_at INTEGER,last_summary TEXT DEFAULT '',run_count INTEGER DEFAULT 0);
  CREATE TABLE approvals(id INTEGER PRIMARY KEY,goal_id INTEGER,reason TEXT,command TEXT,status TEXT,created_at INTEGER,decided_at INTEGER,output TEXT);
  CREATE TABLE events(id INTEGER PRIMARY KEY,goal_id INTEGER,type TEXT,payload TEXT,created_at INTEGER,consumed_at INTEGER);`);
  const open=()=>store=createManagerStore({db,now:()=>clock,workspaceRoot:path.join(root,'work')});open();
  return {root,get db(){return db;},get store(){return store;},advance:n=>clock+=n,now:()=>clock,reopen(){db.close();db=new DatabaseSync(file);open();},close(){db.close();rmSync(root,{recursive:true,force:true});}};
}
const ordinary=(extra: any={})=>({reply:'我记住这个话题了。',summary:'记录共同话题',tasks:[],continuations:[],reviews:[],controls:[],instructions:[],notes:[],inspect_tasks:[],...extra});
let sequence=0;
function seed(f,{key='garden.window',evidence='我喜欢在阳台种香草，还在想薄荷怎么搭配',summary='讨论阳台的香草搭配，希望以薄荷为基础',title='阳台的香草'}={}){
  const user=f.store.message({message:evidence,requestId:'u'+(++sequence)}).message,run=f.store.claimManager();
  const result=f.store.completeManager(run,ordinary({relationship:{topics:[{key,title,summary,open_question:'怎样组合香草更有趣',source_message_ids:[user.id],evidence:[evidence]}]}}));
  assert.equal(result.committed,true);
  return {user,topic:f.store.relationship.snapshot().topics.find(topic=>topic.title===title)};
}

test('a normal conversation records authenticated shared evidence without tasks or relationship controls',()=>{
 const f=fixture();try{
  const {user,topic}=seed(f);assert.deepEqual(topic.sourceMessageIds,[user.id]);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM goals').get()!.n,0);
  assert.deepEqual(Object.keys(f.store.relationship.snapshot()),['revision','topics']);
  for(const method of ['configure','feedback','prepare'])assert.equal(f.store.relationship[method],undefined);
  const before=f.store.relationship.snapshot();f.reopen();assert.deepEqual(f.store.relationship.snapshot(),before);
 }finally{f.close();}
});

test('foreign, assistant, missing and historical source IDs do not create shared topics',()=>{
 const f=fixture();try{
  const {user}=seed(f),assistant=f.store.snapshot().messages.at(-1);
  const foreign=Number(f.db.prepare("INSERT INTO manager_messages(manager_id,role,content,created_at) VALUES('manager:other','user','foreign',1)").run().lastInsertRowid);
  const draft=(id,text)=>({topics:[{key:'false.topic',title:'伪话题',summary:'不可保存',open_question:'',source_message_ids:[id],evidence:[text]}]});
  f.store.relationship.learn(draft(assistant.id,assistant.content),[assistant.id]);f.store.relationship.learn(draft(foreign,'foreign'),[foreign]);f.store.relationship.learn(draft(9999,'missing'),[9999]);f.store.relationship.learn(draft(user.id,user.content),[]);
  assert.equal(f.store.relationship.snapshot().topics.length,1);
  const prior=f.store.relationship.snapshot().topics[0];f.store.relationship.learn({topics:[{key:'garden.window',title:prior.title,summary:'旧来源不得重写',open_question:'',source_message_ids:[user.id],evidence:[user.content]}]},[user.id]);
  assert.equal(f.store.relationship.snapshot().topics[0].summary,prior.summary);
 }finally{f.close();}
});

test('manual correction wins over in-flight ordinary extraction and optimistic revisions reject stale editing',()=>{
 const f=fixture();try{
  const {topic}=seed(f),user=f.store.message({message:'我想继续聊阳台',requestId:'edit-race'}).message,run=f.store.claimManager(),revision=f.store.relationship.snapshot().revision;
  f.store.relationship.updateTopic(topic.id,{summary:'人工纠正：实际更喜欢迷迭香',revision:topic.revision});
  f.store.completeManager(run,ordinary({relationship_revision:revision,relationship:{topics:[{key:'garden.window',title:'阳台的香草',summary:'旧模型覆盖',open_question:'',source_message_ids:[user.id],evidence:[user.content]}]}}));
  assert.equal(f.store.relationship.snapshot().topics[0].summary,'人工纠正：实际更喜欢迷迭香');
  assert.throws(()=>f.store.relationship.updateTopic(topic.id,{summary:'过期编辑',revision:topic.revision}),/已更新/);
  assert.throws(()=>f.store.relationship.updateTopic(topic.id,{unknown:1}),/不支持/);
 }finally{f.close();}
});

test('topic deletion is idempotent and old sources cannot return under another key or through ordinary extraction',()=>{
 const f=fixture();try{
  const {user,topic}=seed(f),next=f.store.message({message:'这个香草话题先放着',requestId:'delete-extraction-race'}).message,run=f.store.claimManager(),revision=f.store.relationship.snapshot().revision;
  f.store.relationship.deleteTopic(topic.id);const deleted=f.store.relationship.snapshot();f.store.relationship.deleteTopic(topic.id);assert.deepEqual(f.store.relationship.snapshot(),deleted);
  f.store.relationship.learn({topics:[{key:'garden.renamed',title:'另一种标题',summary:'旧话题',open_question:'',source_message_ids:[user.id],evidence:[user.content]}]},[user.id]);
  f.store.completeManager(run,ordinary({relationship_revision:revision,relationship:{topics:[{key:'garden.renamed-again',title:'旧模型改名',summary:'不应复活',open_question:'',source_message_ids:[next.id],evidence:[next.content]}]}}));
  assert.equal(f.store.relationship.snapshot().topics.length,0);
  assert.equal(f.store.relationship.safeHistory(f.store.snapshot().messages).some(message=>message.content.includes('薄荷')),false);
  f.reopen();assert.equal(f.store.relationship.snapshot().topics.length,0);
 }finally{f.close();}
});

test('memory withdrawal hides shared personalization and identical manual save explicitly reconfirms it',()=>{
 const f=fixture();try{
  f.store.relationship.memoryChanged({generation:0,revision:0,enabled:true});const {topic}=seed(f);
  f.store.relationship.memoryChanged({generation:1,revision:1,enabled:true});assert.equal(f.store.relationship.snapshot().topics[0].needsReview,true);assert.equal(f.store.relationship.context().topics.length,0);
  f.store.relationship.updateTopic(topic.id,{summary:topic.summary});assert.equal(f.store.relationship.snapshot().topics[0].needsReview,false);
  f.store.relationship.memoryChanged({generation:1,revision:99,enabled:true});assert.equal(f.store.relationship.snapshot().topics[0].needsReview,false);
  f.store.relationship.memoryChanged({generation:2,enabled:false});assert.equal(f.store.relationship.context().topics.length,0);
 }finally{f.close();}
});

test('topic context is bounded while durable shared memories remain available for editing',()=>{
 const f=fixture();try{
  const {topic}=seed(f);
  for(let i=0;i<40;i++)f.db.prepare('INSERT INTO dots_relationship_topics(id,manager_id,topic_key,title,summary,open_question,source_message_ids,evidence,created_at,updated_at,review_after,fingerprint) SELECT ?,manager_id,?,?,?,open_question,source_message_ids,evidence,created_at,updated_at,review_after,? FROM dots_relationship_topics WHERE id=?').run('large'+i,'large.'+i,'长话题'+i,'内容'.repeat(2000),'large-hash'+i,topic.id);
  assert.ok(JSON.stringify(f.store.relationship.context()).length<13000);assert.equal(f.store.relationship.snapshot().topics.length,41);
 }finally{f.close();}
});

test('manual punctuation and case corrections are preserved exactly',()=>{
 const f=fixture();try{
  const {topic}=seed(f);f.store.relationship.updateTopic(topic.id,{title:'Herbs',summary:'Mint, lemon.'});f.store.relationship.updateTopic(topic.id,{title:'HERBS',summary:'Mint; lemon!'});
  const corrected=f.store.relationship.snapshot().topics[0];assert.equal(corrected.title,'HERBS');assert.equal(corrected.summary,'Mint; lemon!');
 }finally{f.close();}
});

test('plain user boundaries remain context without mode controls, frequency-based familiarity or preset tone',()=>{
 const f=fixture();try{
  seed(f);const user=f.store.message({message:'我最近很忙，先不聊，不要主动找我。',requestId:'plain-wish'}).message,run=f.store.claimManager();
  const prompt=buildManagerPrompt(f.store,run);assert.ok(prompt.includes(user.content));assert.match(prompt,/Respect clearly expressed wishes/);
  assert.deepEqual(Object.keys(MANAGER_SCHEMA.properties.relationship.properties),['topics']);
  assert.doesNotMatch(prompt,/Ordinary conversation may be relaxed|repeated interaction to make phrasing|fixed relationship levels|OBSERVED INTERACTION|Respond naturally/);
  f.store.completeManager(run,ordinary({relationship:{topics:[],boundary:{action:'off',source_message_id:user.id,evidence:user.content}}}));assert.equal(Object.hasOwn(f.store.relationship.snapshot(),'settings'),false);
 }finally{f.close();}
});

// This is deliberately an old persisted database fixture, not a publication
// shortcut. No normal-content test inserts candidates or opportunity inbox rows.
test('legacy timed inbox migration preserves genuine inputs, old partial text and worker locks',()=>{
 const f=fixture();try{
  const {topic}=seed(f),user=f.store.message({message:'继续检查构建结果',requestId:'mixed-user'}).message;
  const task=f.store.createTasks([{key:'compile',title:'检查构建',instruction:'检查已有构建结果',resourceKey:'build-project'}])[0],worker=f.store.claimGoal(task.id);assert.ok(worker);f.store.reportGoal(task.id,'active','构建已通过');
  const id='legacy-private-run',manager=f.db.prepare('SELECT * FROM managers').get();
  f.db.prepare("INSERT INTO manager_inbox(manager_id,type,payload,created_at) VALUES(?,'proactive_opportunity',?,?)").run(f.store.managerId,JSON.stringify({candidateId:'legacy-candidate',cycle:1,topicId:topic.id}),f.now());
  const watermark=f.db.prepare('SELECT MAX(id) AS id FROM manager_inbox').get()!.id;
  f.db.prepare("INSERT INTO manager_runs(id,manager_id,kind,state,worker_id,fence,control_revision,inbox_watermark,lease_expires_at,heartbeat_at,started_at) VALUES(?,?,'manager','running','old-process',1,?,?,?,?,?)").run(id,f.store.managerId,manager!.control_revision,watermark,f.now()+60,f.now(),f.now());
  f.db.prepare('INSERT INTO manager_resources VALUES(?,?,?)').run('manager:'+f.store.managerId,id,f.now()+60);
  f.db.prepare("INSERT INTO manager_messages(manager_id,role,content,created_at,delivery_state,revision,stream_run_id) VALUES(?,'assistant','已显示的前半句',?,'streaming',1,?)").run(f.store.managerId,f.now(),id);
  const run=f.db.prepare('SELECT * FROM manager_runs WHERE id=?').get(id),pending=f.db.prepare("SELECT * FROM manager_inbox WHERE consumed_at IS NULL AND type<>'proactive_opportunity'").all(),workerLock=f.db.prepare('SELECT * FROM manager_resources WHERE run_id=?').all(worker.id),topics=f.store.relationship.snapshot().topics;
  f.db.prepare('UPDATE dots_relationship_state SET timed_review_retired=0').run();f.reopen();
  assert.deepEqual(f.store.relationship.snapshot().topics,topics);assert.deepEqual(f.db.prepare('SELECT * FROM manager_inbox WHERE consumed_at IS NULL').all(),pending);assert.deepEqual(f.db.prepare('SELECT * FROM manager_resources WHERE run_id=?').all(worker.id),workerLock);
  const partial=f.store.snapshot().messages.find(message=>message.content==='已显示的前半句');assert.equal(partial.deliveryState,'cancelled');assert.equal(partial.revision,2);
  assert.equal(f.store.completeManager(run,ordinary()).committed,false);assert.equal(f.store.streamManagerReply(run,'不应出现的后半句'),null);
  const successor=f.store.claimManager();assert.ok(successor);const result=f.store.completeManager(successor,ordinary());assert.deepEqual(result.value.message.respondsToMessageIds,[user.id]);
  const revision=f.store.relationship.snapshot().revision;f.reopen();assert.equal(f.store.relationship.snapshot().revision,revision);assert.ok(f.store.isCurrent(worker));
 }finally{f.close();}
});
