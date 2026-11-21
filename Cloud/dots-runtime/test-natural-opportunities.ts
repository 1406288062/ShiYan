import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createManagerStore} from './manager-store.ts';
import {createManagerRuntime,buildProactivePrompt,PROACTIVE_SCHEMA} from './manager-runtime.ts';

const oldText='我在阳台种薄荷和迷迭香，想观察香草气味随季节的变化';
const newText='我拍到雨后阳台的薄荷叶上有水珠，准备试试逆光拍摄叶片的纹理';
const connection='你之前在留意香草随季节的气味，这次又拍下雨后的叶片纹理，同一座阳台有了嗅觉和视觉两种记录。';
const ordinary=(extra: any)=>({reply:'记住了。',summary:'交流已完成',awaiting_user_input:false,tasks:[],continuations:[],reviews:[],controls:[],instructions:[],notes:[],inspect_tasks:[],...extra});
let sequence=0;
function fixture(){
 const root=mkdtempSync(path.join(os.tmpdir(),'dots-natural-events-')),file=path.join(root,'db.sqlite');let clock=1792000000,db=new DatabaseSync(file),store: any;const runtimes=new Set<any>();
 db.exec(`CREATE TABLE goals(id INTEGER PRIMARY KEY,title TEXT,instruction TEXT,status TEXT,thread_id TEXT,workspace TEXT,created_at INTEGER,updated_at INTEGER,next_wake_at INTEGER,last_run_at INTEGER,last_summary TEXT DEFAULT '',run_count INTEGER DEFAULT 0);
 CREATE TABLE approvals(id INTEGER PRIMARY KEY,goal_id INTEGER,reason TEXT,command TEXT,status TEXT,created_at INTEGER,decided_at INTEGER,output TEXT);
 CREATE TABLE events(id INTEGER PRIMARY KEY,goal_id INTEGER,type TEXT,payload TEXT,created_at INTEGER,consumed_at INTEGER);`);
 // This suite isolates the original new-content lane. The default autonomous
 // initialization and its no-new-input behavior have a separate acceptance suite.
 const open=()=>{store=createManagerStore({db,now:()=>clock,workspaceRoot:path.join(root,'work')});store.initializeReflection=()=>null;};open();
 return {root,now:()=>clock,get db(){return db;},get store(){return store;},advance:(n: any)=>clock+=n,track:(r: any)=>{runtimes.add(r);return r;},reopen(){for(const r of runtimes)r.close();runtimes.clear();db.close();db=new DatabaseSync(file);open();},close(){for(const r of runtimes)r.close();db.close();rmSync(root,{recursive:true,force:true});}};
}
interface ExchangeOptions { text: string; key: string; title?: string; reply?: string; summary?: string; awaiting?: boolean; learn?: boolean; resultOverrides?: any; }
function exchange(f: any,{text,key,title=key,reply='记住了。',summary=text,awaiting=false,learn=true,resultOverrides={}}: ExchangeOptions){
 const user=f.store.message({message:text,requestId:'ordinary-'+(++sequence)}).message,run=f.store.claimManager();assert.ok(run);
 const result=f.store.completeManager(run,ordinary({reply,awaiting_user_input:awaiting,relationship:{topics:learn?[{key,title,summary,open_question:'',source_message_ids:[user.id],evidence:[text]}]:[]},...resultOverrides}));assert.equal(result.committed,true);
 return {user,topic:f.store.relationship.snapshot().topics.find((topic: any)=>topic.sourceMessageIds.includes(user.id)),reply:result.value.message};
}
function first(f: any){return exchange(f,{text:oldText,key:'garden.herbs',title:'阳台香草',reply:'记住了，你在观察阳台香草的气味。'});}
function second(f: any,extra={}){return exchange(f,{text:newText,key:'photo.leaves',title:'雨后叶片摄影',reply:'逆光时把曝光稍微降低，水珠边缘会更清楚。',learn:false,...extra});}
function seed(f: any){const a=first(f),b=second(f);return {a,b};}
function decision(a: any,b: any,extra={}){return {action:'send',message:connection,reason:'旧话题的香草气味和这次雨后叶片摄影形成了未讨论过的感官记录关联',new_connection:'同一座阳台有了嗅觉和视觉两种记录',not_covered_by_reply:'此前只回答逆光曝光，尚未谈到气味与纹理的两种记录',conversation_appropriate:true,source_quotes:[{message_id:a.user.id,quote:oldText},{message_id:b.user.id,quote:newText}],...extra};}
const proactive=(f: any)=>f.store.snapshot().messages.filter((message: any)=>message.origin==='proactive');
const candidateCount=(f: any)=>Number(f.db.prepare('SELECT COUNT(*) AS n FROM dots_relationship_event_candidates').get()!.n);
const settle=async()=>{for(let i=0;i<4;i++)await new Promise(resolve=>setImmediate(resolve));};
function runtime(f: any,run: any,extra={}){
 const options: any[]=[],prompts: any[]=[];const r=createManagerRuntime({store:f.store,workspaceRoot:f.root,codex:{startThread:(option: any)=>{options.push(option);return {run:async(prompt: any,turn: any)=>{prompts.push(prompt);return run(prompt,turn);}}},resumeThread:(id: any,option: any)=>{options.push(option);return {run:async(prompt: any,turn: any)=>{prompts.push(prompt);return run(prompt,turn);}}}},logger:{error(){},warn(){}},...extra});
 return {r:f.track(r),options,prompts};
}

test('ordinary interests without a task produce one sourced model review and a real proactive message',async()=>{
 const f=fixture();try{
  const a=first(f);let b: any,calls=0;
  const {r,options,prompts}=runtime(f,async()=>{calls++;return {finalResponse:JSON.stringify(decision(a,b))};});await settle();assert.equal(calls,0);
  b=second(f);await settle();assert.equal(calls,1);assert.equal(candidateCount(f),1);assert.equal(proactive(f).length,1);assert.equal(f.store.relationship.snapshot().topics.length,1);
  const message=proactive(f)[0];assert.equal(message.content,connection);assert.deepEqual(message.respondsToMessageIds,[]);assert.equal(message.deliveryState,'completed');assert.ok(message.topicId);assert.ok(message.proactiveReason);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM goals').get()!.n,0);assert.equal(options[0].allowTools,false);assert.equal(options[0].networkAccessEnabled,false);assert.equal(options[0].webSearchMode,'live');assert.ok(prompts[0].includes(oldText));assert.ok(prompts[0].includes(newText));
  assert.equal(await r.requestContentReview(),false);assert.equal(await r.wake(),false);assert.equal(calls,1);
 }finally{f.close();}
});

test('ordinary runtime replies lead to one separately reviewed connection about another everyday interest',async()=>{
 const f=fixture();try{
  const earlier='我喜欢城市里的老建筑，常常注意砖墙和窗框留下的年代痕迹',fresh='今天拍到雨水在老建筑的玻璃窗上折出一排倒影，同一扇窗在傍晚颜色完全不同';
  const sent='你注意过老建筑砖墙和窗框的年代痕迹，这次雨水里的玻璃倒影又留下了傍晚的颜色，同一扇窗同时记录着缓慢的年代和短暂的光线。';
  let calls=0,a: any,b: any;const {r}=runtime(f,async()=>{calls++;
   if(calls===1)return {finalResponse:JSON.stringify(ordinary({reply:'砖墙和窗框确实保留了建筑被使用过的痕迹。',relationship:{topics:[{key:'architecture.traces',title:'老建筑的痕迹',summary:earlier,open_question:'',source_message_ids:[a.id],evidence:[earlier]}]}}))};
   if(calls===2)return {finalResponse:JSON.stringify(ordinary({reply:'拍玻璃倒影时，可以调整相机角度避开自己的影子。',relationship:{topics:[]}}))};
   assert.equal(calls,3);return {finalResponse:JSON.stringify({action:'send',message:sent,reason:'老建筑的年代痕迹与雨中倒影形成长短时间的真实关联',new_connection:'同一扇窗同时记录着缓慢的年代和短暂的光线',not_covered_by_reply:'之前仅提到摄影角度，尚未联系年代痕迹和短暂光线',conversation_appropriate:true,source_quotes:[{message_id:a.id,quote:earlier},{message_id:b.id,quote:fresh}]})};
  });
  a=f.store.message({message:earlier,requestId:'architecture-old'}).message;assert.equal(await r.wake(),true);await settle();assert.equal(calls,1);
  b=f.store.message({message:fresh,requestId:'architecture-fresh'}).message;assert.equal(await r.wake(),true);await settle();
  assert.equal(calls,3);assert.equal(proactive(f).length,1);assert.equal(proactive(f)[0]!.content,sent);assert.equal(f.store.relationship.snapshot().topics.length,1);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM goals').get()!.n,0);
 }finally{f.close();}
});

test('unrelated topics, near-paraphrases, covered answers and an outstanding question do not call an extra model',async t=>{
 const cases: [string, any][]=[
  ['unrelated',{text:'我刚学会煮意大利面，接下来想试不同番茄酱的酸甜比例',key:'cooking.pasta',title:'意大利面',reply:'可以先比较不同番茄品种。'}],
  ['near-paraphrase',{text:'我在阳台种着薄荷与迷迭香，仍想观察香草气味随四季的变化',key:'garden.herbs',title:'阳台香草',reply:'继续观察这两种香草即可。'}],
  ['already-covered',{reply:connection}],
  ['awaiting-user',{reply:'你希望优先记录气味，还是拍叶片纹理？',awaiting:true}],
  ['missing-question-signal',{resultOverrides:{awaiting_user_input:undefined}}],
  ['unsafe-fresh-evidence',{text:newText+'，测试用的密码是 SyntheticDummy0000'}]
 ];
 for(const [name,input]of cases)await t.test(name,async()=>{const f=fixture();try{first(f);let calls=0;const {r}=runtime(f,async()=>{calls++;throw new Error('No eligible new idea');});second(f,input);await settle();assert.equal(calls,0);assert.equal(candidateCount(f),0);assert.equal(await r.requestContentReview(),false);assert.equal(proactive(f).length,0);}finally{f.close();}});
});

test('clock advancement and normal wake neither create candidates nor claim an existing content event',async()=>{
 const f=fixture();try{
  first(f);let calls=0;const {r}=runtime(f,async()=>{calls++;throw new Error('Clock is not a content event');});await settle();
  for(let day=0;day<365;day++){f.advance(86400);assert.equal(await r.wake(),false);assert.equal(await r.requestContentReview(),false);}
  assert.equal(calls,0);assert.equal(candidateCount(f),0);assert.equal(proactive(f).length,0);r.close();
  second(f);assert.equal(candidateCount(f),1);for(let i=0;i<20;i++)assert.equal(f.store.claimManager(),null);
  assert.ok(f.store.claimContentReview());
 }finally{f.close();}
});

test('task dispatch and worker-only completion cannot masquerade as ordinary conversational observations',async()=>{
 const f=fixture();try{
  first(f);second(f,{resultOverrides:{tasks:[{key:'photo-sort',title:'整理照片',instruction:'整理本次上传的照片',resourceKey:'photos'}]}});
  assert.equal(candidateCount(f),0);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM goals').get()!.n,1);
  f.store.enqueue('worker_report',{taskId:1,status:'done',summary:newText});f.advance(3);f.store.completeManager(f.store.claimManager(),ordinary({reply:newText,relationship:{topics:[]}}));
  let calls=0;const {r}=runtime(f,async()=>{calls++;throw new Error('A report is not a fresh user observation');});await settle();assert.equal(await r.requestContentReview(),false);assert.equal(calls,0);assert.equal(candidateCount(f),0);
 }finally{f.close();}
});

test('restart consumes only a durable real content event once and never retries a terminal decision',async()=>{
 const f=fixture();try{
  const {a,b}=seed(f);assert.equal(candidateCount(f),1);f.reopen();let calls=0;
  runtime(f,async()=>{calls++;return {finalResponse:JSON.stringify(decision(a,b))};});await settle();assert.equal(calls,1);assert.equal(proactive(f).length,1);
  f.reopen();const {r}=runtime(f,async()=>{calls++;throw new Error('Already sent');});await settle();f.advance(500*86400);assert.equal(await r.requestContentReview(),false);assert.equal(await r.wake(),false);assert.equal(calls,1);assert.equal(proactive(f).length,1);
 }finally{f.close();}
});

test('the same material under another event or topic key cannot create or send another candidate',async()=>{
 const f=fixture();try{
  const {a,b}=seed(f),review=f.store.claimContentReview();assert.ok(review);assert.equal(f.store.completeManager(review,decision(a,b)).committed,true);assert.equal(proactive(f).length,1);
  const count=candidateCount(f);second(f,{key:'photo.leaves.alias',title:'另一标题的叶片照片',learn:true});let calls=0;const {r}=runtime(f,async()=>{calls++;throw new Error('Duplicate material');});await settle();assert.equal(candidateCount(f),count);assert.equal(await r.requestContentReview(),false);assert.equal(calls,0);assert.equal(proactive(f).length,1);
 }finally{f.close();}
});

test('a new user message wins over pending content and gets the ordinary reply without task dispatch',async()=>{
 const f=fixture();try{
  seed(f);const user=f.store.message({message:'先回答另一个问题：今天这些照片存在哪里？',requestId:'priority-user'}).message;
  assert.equal(f.store.claimContentReview(),null);let calls=0;const {r,prompts}=runtime(f,async()=>{calls++;return {finalResponse:JSON.stringify(ordinary({reply:'照片位置还需要根据你保存的位置确认。'}))};});
  assert.equal(await r.wake(),true);await settle();assert.equal(calls,1);assert.ok(prompts[0].includes(user.content));assert.deepEqual(f.store.snapshot().messages.at(-1).respondsToMessageIds,[user.id]);assert.equal(proactive(f).length,0);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM goals').get()!.n,0);
 }finally{f.close();}
});

test('worker reports take priority and stay in the ordinary lane while content has a fixed private identity',()=>{
 const f=fixture();try{
  const {a,b}=seed(f);f.store.enqueue('worker_report',{taskId:77,status:'done',summary:'构建核对完成'});f.advance(3);assert.equal(f.store.claimContentReview(),null);
  const ordinaryRun=f.store.claimManager();assert.ok(ordinaryRun);assert.notEqual(ordinaryRun.purpose,'content_review');assert.equal(f.store.relationship.forRun(ordinaryRun),null);
  f.store.completeManager(ordinaryRun,ordinary({reply:'构建核对已完成。'}));assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM manager_inbox WHERE consumed_at IS NULL').get()!.n,0);
  const review=f.store.claimContentReview();assert.ok(review);assert.equal(review.purpose,'content_review');assert.ok(review.content_candidate_id);assert.ok(f.store.relationship.forRun(review));assert.throws(()=>f.store.streamManagerReply(review,'尚未决定的草稿'),/cannot stream|private|主动|content/i);assert.throws(()=>f.store.completeManager(review,{...decision(a,b),tasks:[{title:'不应创建的任务'}]}),/cannot dispatch|task|任务/i);f.store.failManager(review,'测试结束');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM goals').get()!.n,0);assert.equal(proactive(f).length,0);
 }finally{f.close();}
});

test('a private review carries real prior and fresh evidence without resurrecting unrelated deleted memories',()=>{
 const f=fixture();try{
  const secret=exchange(f,{text:'只在这里提过的秘密品种胡椒木',key:'garden.secret',title:'不保留的品种'});f.store.relationship.deleteTopic(secret.topic.id);
  const {a,b}=seed(f),run=f.store.claimContentReview();assert.ok(run);const context=f.store.relationship.forRun(run),prompt=buildProactivePrompt(f.store,context);
  assert.ok(prompt.includes(oldText));assert.ok(prompt.includes(newText));assert.ok(!prompt.includes('胡椒木'));
  assert.doesNotMatch(prompt,/Familiarity may affect|OBSERVED INTERACTION|Write a sent message naturally/);
  assert.equal(f.store.completeManager(run,decision(a,b)).value.message?.content,connection);
 }finally{f.close();}
});

test('a worker report arriving during review cannot divert its result into ordinary streaming or dispatch',()=>{
 const f=fixture();try{
  const {a,b}=seed(f),run=f.store.claimContentReview();assert.ok(run);f.store.enqueue('worker_report',{taskId:78,status:'done',summary:'新的工作报告'});
  assert.ok(f.store.relationship.forRun(run));assert.throws(()=>f.store.streamManagerReply(run,'禁止的草稿'),/cannot stream|private|主动|content/i);
  const completed=f.store.completeManager(run,decision(a,b));assert.equal(proactive(f).length,0);assert.notEqual(completed.value?.message?.content,'已查看当前任务。');assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM manager_inbox WHERE type='worker_report' AND consumed_at IS NULL").get()!.n,1);
  f.advance(3);const normal=f.store.claimManager();assert.ok(normal);f.store.completeManager(normal,ordinary({reply:'已收到新的工作报告。'}));assert.equal(f.store.snapshot().messages.at(-1).content,'已收到新的工作报告。');assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM goals').get()!.n,0);
 }finally{f.close();}
});

test('new user input during a real streamed private review cancels the draft before any display or voice event',async()=>{
 const f=fixture();try{
  const {a,b}=seed(f);let entered: any,release;const ready=new Promise(resolve=>entered=resolve),hold=new Promise(resolve=>release=resolve);
  const thread={runStreamed:async()=>({events:(async function*(){yield{type:'item.updated',item:{type:'agent_message',text:JSON.stringify(decision(a,b))}};entered();await hold;yield{type:'item.completed',item:{type:'agent_message',text:JSON.stringify(decision(a,b))}};})()})};
  const r=f.track(createManagerRuntime({store:f.store,codex:{startThread:()=>thread},workspaceRoot:f.root,logger:{error(){},warn(){}}}));await ready;
  assert.equal(proactive(f).length,0);const before=f.store.activity().activity.filter((event: any)=>event.kind==='assistant_delta').length;
  const user=f.store.message({message:'我现在要说另一件事',requestId:'interrupt-user'}).message;r.interrupt();(release as any)?.();await settle();
  assert.equal(proactive(f).length,0);assert.equal(f.store.activity().activity.filter((event: any)=>event.kind==='assistant_delta').length,before);assert.ok(f.db.prepare("SELECT 1 FROM manager_inbox WHERE type='user_message' AND consumed_at IS NULL").get());
  r.close();const normal=f.store.claimManager();assert.ok(normal);const reply=f.store.completeManager(normal,ordinary({reply:'你说。'}));assert.deepEqual(reply.value.message.respondsToMessageIds,[user.id]);
 }finally{f.close();}
});

test('topic deletion, manual correction and memory withdrawal invalidate an already claimed review',async t=>{
 const changes=[['delete',(f: any,a: any)=>f.store.relationship.deleteTopic(a.topic.id)],['correct',(f: any,a: any)=>f.store.relationship.updateTopic(a.topic.id,{summary:'用户明确纠正了原来的共同话题'})],['withdraw',(f: any)=>f.store.relationship.memoryChanged({generation:1,enabled:true})]];
 for(const [name,change]of changes as [string, any][])await t.test(name,()=>{const f=fixture();try{f.store.relationship.memoryChanged({generation:0,enabled:true});const {a,b}=seed(f),run=f.store.claimContentReview();assert.ok(run);change(f,a);f.store.completeManager(run,decision(a,b));assert.equal(proactive(f).length,0);assert.equal(f.store.claimContentReview(),null);assert.equal(f.db.prepare('SELECT match_json FROM dots_relationship_event_candidates').get()!.match_json,'{}');}finally{f.close();}});
});

test('an outer transaction rollback neither emits a content event nor calls the review model',async()=>{
 const f=fixture();try{
  const a=first(f),before=f.store.snapshot().messages;let b: any,calls=0,notifications=0;
  const unsubscribe=f.store.subscribeContentEvents(()=>notifications++);runtime(f,async()=>{calls++;return {finalResponse:JSON.stringify(decision(a,b))};});await settle();
  assert.throws(()=>f.store.transaction(()=>{b=second(f);assert.equal(notifications,0);throw new Error('rollback ordinary reply');}),/rollback ordinary reply/);
  await settle();assert.equal(notifications,0);assert.equal(calls,0);assert.equal(candidateCount(f),0);assert.deepEqual(f.store.snapshot().messages,before);
  b=second(f);await settle();assert.equal(notifications,1);assert.equal(calls,1);assert.equal(proactive(f).length,1);unsubscribe();
 }finally{f.close();}
});

test('persisted review identity overrides a caller object that omits its private purpose',()=>{
 const f=fixture();try{
  const {a,b}=seed(f),run=f.store.claimContentReview();assert.ok(run);const stale={...run,purpose:'reply',content_candidate_id:null};
  assert.ok(f.store.relationship.forRun(stale));assert.throws(()=>f.store.streamManagerReply(stale,'私有草稿不可展示'),/cannot stream|private|主动|content/i);
  assert.throws(()=>f.store.completeManager(stale,{...decision(a,b),tasks:[{title:'私有评估不能派工'}]}),/cannot dispatch|task|任务/i);
  f.store.failManager(stale,'模拟旧调用方对象');assert.equal(f.db.prepare('SELECT state FROM dots_relationship_event_candidates').get()!.state,'cancelled');
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM manager_inbox WHERE type='previous_plan_error'").get()!.n,0);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM goals').get()!.n,0);assert.equal(proactive(f).length,0);
 }finally{f.close();}
});

test('two database connections cannot claim or publish the same real content twice',()=>{
 const f=fixture();let otherDB;try{
  const {a,b}=seed(f);otherDB=new DatabaseSync(path.join(f.root,'db.sqlite'));const other=createManagerStore({db:otherDB,now:f.now,workspaceRoot:path.join(f.root,'work')});
  const run=f.store.claimContentReview({workerId:'first-runtime'});assert.ok(run);assert.equal(other.claimContentReview({workerId:'other-runtime'}),null);
  assert.equal(f.store.completeManager(run,decision(a,b)).value.decision,'sent');assert.equal(other.completeManager(run,decision(a,b)).committed,false);
  assert.equal(proactive(f).length,1);assert.equal(other.claimContentReview(),null);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM dots_relationship_deliveries').get()!.n,1);
 }finally{otherDB?.close();f.close();}
});

test('constructing another runtime preserves a live review and never runs its model twice',async()=>{
 const f=fixture();let release;try{
  const {a,b}=seed(f);let entered: any,calls=0;const ready=new Promise(resolve=>entered=resolve),hold=new Promise(resolve=>release=resolve);
  runtime(f,async()=>{calls++;entered();await hold;return {finalResponse:JSON.stringify(decision(a,b))};});await ready;
  runtime(f,async()=>{calls++;throw new Error('The existing review still owns its lease');});await settle();
  assert.equal(calls,1);assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM manager_runs WHERE purpose='content_review' AND state='running'").get()!.n,1);
  (release as any)?.();await settle();assert.equal(calls,1);assert.equal(proactive(f).length,1);
 }finally{(release as any)?.();await settle();f.close();}
});

test('a topic overwritten by the current authenticated conversation cannot supply its superseded prior evidence',async()=>{
 const f=fixture();try{
  first(f);let calls=0;runtime(f,async()=>{calls++;throw new Error('Replaced evidence is not a separate shared topic');});await settle();
  second(f,{key:'garden.herbs',title:'更新后的阳台记录',learn:true});await settle();assert.equal(f.store.relationship.snapshot().topics.length,1);assert.equal(f.store.relationship.snapshot().topics[0].summary,newText);assert.equal(candidateCount(f),0);assert.equal(calls,0);
 }finally{f.close();}
});

test('deleting a separately saved fresh topic retracts candidate evidence even without a fresh topic ID',()=>{
 const f=fixture();try{
  const a=first(f),b=second(f,{learn:true}),run=f.store.claimContentReview();assert.ok(run);assert.ok(b.topic);
  assert.equal(f.store.relationship.forRun(run).match.fresh.topicId,undefined);f.store.relationship.deleteTopic(b.topic.id);
  assert.equal(f.db.prepare('SELECT match_json FROM dots_relationship_event_candidates').get()!.match_json,'{}');
  f.store.completeManager(run,decision(a,b));assert.equal(proactive(f).length,0);assert.equal(f.store.relationship.safeHistory(f.store.snapshot().messages).some((message: any)=>message.content===newText),false);
 }finally{f.close();}
});

test('manual correction keeps the corrected shared memory but retires its old automatic matching evidence',async()=>{
 const f=fixture();try{
  const old=first(f),corrected='人工纠正：阳台实际养的是番茄和辣椒。';f.store.relationship.updateTopic(old.topic.id,{summary:corrected});
  let calls=0;const {r}=runtime(f,async()=>{calls++;throw new Error('A withdrawn old fact must not be matched again');});second(f);await settle();
  assert.equal(calls,0);assert.equal(candidateCount(f),0);assert.equal(f.store.relationship.context().topics.find((topic: any)=>topic.id===old.topic.id).summary,corrected);r.close();
  const a=first(f),b=second(f),run=f.store.claimContentReview();assert.ok(run);assert.equal(f.store.completeManager(run,decision(a,b)).value.decision,'sent');assert.equal(proactive(f).length,1);
 }finally{f.close();}
});

test('unproven source quotes, unsuitable timing and pressure cannot publish a private candidate',async t=>{
 const values: [string, any][]=[['forged-quote',{source_quotes:[{message_id:999,quote:'没有真实来源的证据引用'}]}],['not-appropriate',{conversation_appropriate:false}],['pressure',{message:'为什么还没有回复我？'}],['generic',{message:'最近怎么样？'}]];
 for(const [name,change]of values)await t.test(name,()=>{const f=fixture();try{const {a,b}=seed(f),run=f.store.claimContentReview();assert.ok(run);f.store.completeManager(run,decision(a,b,change));assert.equal(proactive(f).length,0);assert.equal(f.store.claimContentReview(),null);}finally{f.close();}});
});

test('discard, old defer, failures and expired claimed reviews are terminal without timed retries',async t=>{
 for(const kind of ['discard','defer','failure','expired'])await t.test(kind,async()=>{const f=fixture();try{const {a,b}=seed(f),run=f.store.claimContentReview();assert.ok(run);if(kind==='failure')f.store.failManager(run,'测试模型故障');else if(kind==='expired'){f.advance(61);f.store.recoverExpired();}else f.store.completeManager(run,decision(a,b,{action:kind,message:''}));f.reopen();let calls=0;const {r}=runtime(f,async()=>{calls++;throw new Error('Terminal candidate must not retry');});await settle();for(let i=0;i<20;i++){f.advance(30*86400);assert.equal(await r.requestContentReview(),false);assert.equal(await r.wake(),false);}assert.equal(calls,0);assert.equal(proactive(f).length,0);}finally{f.close();}});
 assert.deepEqual(PROACTIVE_SCHEMA.properties.action.enum,['send','discard']);
});

test('an unanswered proactive message is never repeated by another wake, reconnect or elapsed time',async()=>{
 const f=fixture();try{
  const {a,b}=seed(f),run=f.store.claimContentReview();f.store.completeManager(run,decision(a,b));assert.equal(proactive(f).length,1);const messages=f.store.snapshot().messages;
  f.reopen();let calls=0;const {r}=runtime(f,async()=>{calls++;throw new Error('Silence is not new evidence');});await settle();for(let i=0;i<100;i++){f.advance(86400);assert.equal(await r.wake(),false);assert.equal(await r.requestContentReview(),false);}assert.equal(calls,0);assert.deepEqual(f.store.snapshot().messages,messages);
 }finally{f.close();}
});

test('a restarted legacy opportunity cannot publish through the new content protocol',()=>{
 const f=fixture();try{
  first(f);f.db.prepare("INSERT INTO manager_inbox(manager_id,type,payload,created_at) VALUES(?,'proactive_opportunity','{}',1)").run(f.store.managerId);
  assert.equal(f.store.claimContentReview(),null);assert.equal(f.store.claimManager(),null);
  assert.equal(proactive(f).length,0);assert.equal(candidateCount(f),0);
 }finally{f.close();}
});
