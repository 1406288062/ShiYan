import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createManagerStore} from './manager-store.mjs';
import {createManagerRuntime} from './manager-runtime.mjs';

const source='我喜欢在城市散步时找那些被藤蔓包围的旧门框，会用相机记录它们每天不同的光影';
const perspective='那些旧门框好像是一种慢镜头：建筑的年岁、藤蔓的生长和当天的光影，被你收进同一张照片。';
const ordinary=extra=>({reply:'我记住了你这个散步时的小习惯。',summary:'本次交流已结束',awaiting_user_input:false,tasks:[],continuations:[],reviews:[],controls:[],instructions:[],notes:[],inspect_tasks:[],relationship:{topics:[]},...extra});
let sequence=0;
function fixture(){
 const root=mkdtempSync(path.join(os.tmpdir(),'dots-autonomous-reflection-')),file=path.join(root,'db.sqlite');let clock=1792000000,db=new DatabaseSync(file),store;const runtimes=new Set();
 db.exec(`CREATE TABLE goals(id INTEGER PRIMARY KEY,title TEXT,instruction TEXT,status TEXT,thread_id TEXT,workspace TEXT,created_at INTEGER,updated_at INTEGER,next_wake_at INTEGER,last_run_at INTEGER,last_summary TEXT DEFAULT '',run_count INTEGER DEFAULT 0);
 CREATE TABLE approvals(id INTEGER PRIMARY KEY,goal_id INTEGER,reason TEXT,command TEXT,status TEXT,created_at INTEGER,decided_at INTEGER,output TEXT);
 CREATE TABLE events(id INTEGER PRIMARY KEY,goal_id INTEGER,type TEXT,payload TEXT,created_at INTEGER,consumed_at INTEGER);`);
 const open=()=>store=createManagerStore({db,now:()=>clock,workspaceRoot:path.join(root,'work')});open();
 return {root,now:()=>clock,get db(){return db;},get store(){return store;},advance:n=>clock+=n,track:r=>{runtimes.add(r);return r;},reopen(){for(const r of runtimes)r.close();runtimes.clear();db.close();db=new DatabaseSync(file);open();},close(){for(const r of runtimes)r.close();db.close();rmSync(root,{recursive:true,force:true});}};
}
function remember(f,{text=source,key='walk.doorframes',title='散步中的旧门框',reply,awaiting=false,learn=true,...extra}={}){
 const user=f.store.message({message:text,requestId:'reflection-source-'+(++sequence)}).message,run=f.store.claimManager();assert.ok(run);
 const result=f.store.completeManager(run,ordinary({...(reply?{reply}:{}),awaiting_user_input:awaiting,relationship:{topics:learn?[{key,title,summary:text,open_question:'',source_message_ids:[user.id],evidence:[text]}]:[]},...extra}));assert.equal(result.committed,true);
 return {user,reply:result.value.message,topic:f.store.relationship.snapshot().topics.find(topic=>topic.sourceMessageIds.includes(user.id))};
}
function decision(a,extra={}){return {action:'send',idea_kind:'perspective',message:perspective,reason:'已有散步记录可以形成尚未表达的时间视角',insight:'建筑的年岁、藤蔓的生长和当天的光影，在同一张旧门框照片里呈现三种时间尺度',not_covered_by_history:'此前只记住了散步习惯，没有讨论照片里不同时间尺度的叠加',conversation_appropriate:true,source_quotes:[{message_id:a.user.id,quote:a.user.content}],...extra};}
const settle=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};
const proactive=f=>f.store.snapshot().messages.filter(message=>message.origin==='proactive');
function activityCounts(f){return {
 users:f.db.prepare("SELECT COUNT(*) AS n FROM manager_messages WHERE role='user'").get().n,
 userWatermark:f.db.prepare("SELECT MAX(id) AS id FROM manager_messages WHERE role='user'").get().id,
 replies:f.db.prepare("SELECT COUNT(*) AS n FROM manager_messages WHERE role='assistant' AND origin='reply'").get().n,
 inbox:f.db.prepare('SELECT COUNT(*) AS n FROM manager_inbox').get().n,
 pending:f.db.prepare('SELECT COUNT(*) AS n FROM manager_inbox WHERE consumed_at IS NULL').get().n,
 tasks:f.db.prepare('SELECT COUNT(*) AS n FROM goals').get().n
};}
function runtime(f,respond){
 const options=[],prompts=[];let calls=0;
 const factory=option=>{options.push(option);return {run:async(prompt,turn)=>{calls++;prompts.push(prompt);return {finalResponse:JSON.stringify(await respond({prompt,turn,call:calls}))};}};};
 const r=f.track(createManagerRuntime({store:f.store,workspaceRoot:f.root,codex:{startThread:factory,resumeThread:(_id,option)=>factory(option)},logger:{error(){},warn(){}}}));
 return {r,options,prompts,get calls(){return calls;}};
}

test('an independent reflection initiates from an existing shared topic without a new question, task or ordinary reply',async()=>{
 const f=fixture();try{
  const a=remember(f);const before=activityCounts(f);assert.equal(before.pending,0);assert.equal(before.tasks,0);assert.equal(proactive(f).length,0);
  const x=runtime(f,()=>decision(a));await settle();
  assert.equal(x.calls,1);assert.deepEqual(activityCounts(f),before);assert.equal(proactive(f).length,1);
  const message=proactive(f)[0];assert.equal(message.content,perspective);assert.deepEqual(message.respondsToMessageIds,[]);assert.equal(message.deliveryState,'completed');
  assert.ok(x.prompts[0].includes(source));assert.equal(x.options[0].allowTools,false);assert.equal(x.options[0].networkAccessEnabled,false);assert.equal(x.options[0].webSearchMode,'live');
  assert.equal(await x.r.wake(),false);assert.equal(await x.r.requestContentReview(),false);await settle();assert.equal(x.calls,1);
 }finally{f.close();}
});

test('reflection can connect two established interests without requiring a fresh lexical match',async()=>{
 const f=fixture();try{
  const a=remember(f,{text:'爵士乐最吸引我的是鼓点骤然停住的那一拍，旋律在无声处好像还在往前走',key:'music.silence',title:'鼓点之间的停顿'});
  const b=remember(f,{text:'我会专门拍老房子的窗框，框起来的天空和树影比墙面本身更迷人',key:'photo.windows',title:'老房子窗框'});
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM dots_relationship_event_candidates').get().n,0);
  const before=activityCounts(f),message='爵士乐里鼓点的停顿和老房子的窗框有个有趣的相似之处：真正留下余味的，有时候是空出来让声音、天空和树影经过的地方。';
  const x=runtime(f,()=>decision(a,{idea_kind:'connection',message,insight:'爵士鼓点的停顿与窗框空处都通过留出的空间承载主体之外的内容',not_covered_by_history:'过去分别聊过停顿和窗框，但没有联系两者留出空间的作用',source_quotes:[{message_id:a.user.id,quote:a.user.content},{message_id:b.user.id,quote:b.user.content}]}));await settle();
  assert.equal(x.calls,1);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM manager_runs WHERE reflection_id IS NOT NULL').get().n,1);assert.deepEqual(activityCounts(f),before);assert.equal(proactive(f).length,1);assert.equal(proactive(f)[0].content,message);
 }finally{f.close();}
});

test('no shared material means no thought call even after clock advances, ordinary wakes and restarts',async()=>{
 const f=fixture();try{
  let calls=0;
  for(let restart=0;restart<3;restart++){
   const x=runtime(f,()=>{calls++;throw new Error('There is no authenticated material to reflect on');});await settle();
   for(let day=0;day<20;day++){f.advance(86400);assert.equal(await x.r.wake(),false);assert.equal(await x.r.requestContentReview(),false);}
   f.reopen();
  }
  assert.equal(calls,0);assert.equal(proactive(f).length,0);assert.equal(activityCounts(f).users,0);
 }finally{f.close();}
});

test('one completed or discarded reflection is not regenerated by silence, clocks, restart or its own output',async t=>{
 for(const action of ['send','discard'])await t.test(action,async()=>{
  const f=fixture();try{
   const a=remember(f);let calls=0;runtime(f,()=>{calls++;return decision(a,{action,...(action==='discard'?{message:''}:{})});});await settle();assert.equal(calls,1);
   const before=activityCounts(f);assert.equal(proactive(f).length,action==='send'?1:0);
   for(let pass=0;pass<3;pass++){f.reopen();f.advance(100*86400);const x=runtime(f,()=>{calls++;throw new Error('This corpus has already been considered');});await settle();assert.equal(await x.r.wake(),false);assert.equal(await x.r.requestContentReview(),false);}
   assert.equal(calls,1);assert.deepEqual(activityCounts(f),before);assert.equal(proactive(f).length,action==='send'?1:0);
  }finally{f.close();}
 });
});

test('an outstanding clarification prevents autonomous publication',async()=>{
 const f=fixture();try{
  const a=remember(f,{reply:'你想先记录门框上的藤蔓，还是下午的光影？',awaiting:true});const before=activityCounts(f);
  const x=runtime(f,()=>decision(a));await settle();assert.equal(x.calls,0);assert.equal(await x.r.requestContentReview(),false);assert.equal(proactive(f).length,0);assert.deepEqual(activityCounts(f),before);
 }finally{f.close();}
});

test('a worker-only report cannot answer an outstanding user clarification on the user behalf',async t=>{
 for(const reportedSignal of [false,undefined])await t.test(String(reportedSignal),async()=>{
  const f=fixture();try{
   const a=remember(f,{reply:'你想先记录门框上的藤蔓，还是下午的光影？',awaiting:true});
   f.store.enqueue('worker_report',{taskId:81,status:'done',summary:'另一事项已完成'});f.advance(3);const run=f.store.claimManager();assert.ok(run);
   f.store.completeManager(run,ordinary({reply:'另一事项的报告已经收到。',awaiting_user_input:reportedSignal}));const before=activityCounts(f);
   const x=runtime(f,()=>decision(a));await settle();assert.equal(x.calls,0);assert.equal(await x.r.requestContentReview(),false);assert.equal(proactive(f).length,0);assert.deepEqual(activityCounts(f),before);
  }finally{f.close();}
 });
});

test('ending an exchange is supplied to semantic review and an unsuitable decision never publishes',async()=>{
 const f=fixture();try{
  const a=remember(f,{text:source+'。今天先聊到这里，我要去睡觉了。',reply:'好，晚安。'});
  const x=runtime(f,({prompt})=>{assert.ok(prompt.includes('今天先聊到这里'));return decision(a,{conversation_appropriate:false});});await settle();
  assert.equal(proactive(f).length,0);assert.ok(x.calls<=1);assert.equal(await x.r.requestContentReview(),false);
 }finally{f.close();}
});

test('a pending user message wins and is not consumed by independent reflection',async()=>{
 const f=fixture();try{
  const a=remember(f),user=f.store.message({message:'我现在有个新问题，先看这个',requestId:'reflection-new-input'}).message;const before=activityCounts(f);
  const x=runtime(f,()=>decision(a));await settle();assert.equal(x.calls,0);assert.equal(proactive(f).length,0);assert.equal(await x.r.requestContentReview(),false);assert.deepEqual(activityCounts(f),before);
  assert.ok(f.store.pendingManagerInbox(f.store.claimManager()).some(event=>JSON.parse(event.payload).id===user.id));
 }finally{f.close();}
});

test('new user input while a thought runs invalidates its publication without streaming drafts',async()=>{
 const f=fixture();let release;try{
  const a=remember(f);let entered;const ready=new Promise(resolve=>entered=resolve),hold=new Promise(resolve=>release=resolve);
  const x=runtime(f,async()=>{entered();await hold;return decision(a);});await ready;
  assert.equal(proactive(f).length,0);const before=f.store.activity().activity.filter(event=>event.kind==='assistant_delta').length;
  f.store.message({message:'这件事先放下，我想聊另一件事',requestId:'reflection-interrupt'});x.r.interrupt();release();await settle();
  assert.equal(proactive(f).length,0);assert.equal(f.store.activity().activity.filter(event=>event.kind==='assistant_delta').length,before);assert.equal(activityCounts(f).pending,1);
 }finally{release?.();await settle();f.close();}
});

test('withdrawn or corrected evidence cannot publish from a previously claimed thought',async t=>{
 for(const kind of ['delete','correct','memory-withdrawal'])await t.test(kind,async()=>{
  const f=fixture();let release;try{
   f.store.relationship.memoryChanged({generation:0,enabled:true});const a=remember(f);let entered;const ready=new Promise(resolve=>entered=resolve),hold=new Promise(resolve=>release=resolve);
   const x=runtime(f,async()=>{entered();await hold;return decision(a);});await ready;
   if(kind==='delete')f.store.relationship.deleteTopic(a.topic.id);
   else if(kind==='correct')f.store.relationship.updateTopic(a.topic.id,{summary:'用户已纠正：记录的是新建筑，并没有旧门框或藤蔓。'});
   else f.store.relationship.memoryChanged({generation:1,enabled:true});
   release();await settle();assert.equal(proactive(f).length,0);assert.equal(await x.r.requestContentReview(),false);
   for(const row of f.db.prepare('SELECT materials_json,thought_json FROM dots_relationship_reflections').all()){
    assert.ok(!row.materials_json.includes(source));assert.ok(!row.thought_json.includes(source));
   }
   f.reopen();const retry=runtime(f,()=>{throw new Error('Revoked evidence must not bootstrap again');});await settle();assert.equal(retry.calls,0);
  }finally{release?.();await settle();f.close();}
 });
});

test('a claimed thought cannot dispatch work or become an ordinary streamed reply',()=>{
 const f=fixture();try{
  const a=remember(f);f.store.initializeReflection();const run=f.store.claimContentReview();assert.ok(run);
  const stale={...run,purpose:'reply',reflection_id:null,content_candidate_id:null};assert.equal(f.store.relationship.forRun(stale)?.kind,'reflection');
  assert.throws(()=>f.store.streamManagerReply(stale,'尚未通过判断的思考草稿'),/cannot stream|private|主动|content/i);
  assert.throws(()=>f.store.completeManager(stale,{...decision(a),tasks:[{title:'不应生成的用户任务'}]}),/cannot dispatch|task|任务/i);
  f.store.failManager(stale,'测试结束');assert.equal(activityCounts(f).tasks,0);assert.equal(proactive(f).length,0);
 }finally{f.close();}
});

test('fabricated citations and content already expressed in a source-associated reply are rejected',async t=>{
 for(const kind of ['unknown-message','wrong-quote','covered-reply'])await t.test(kind,async()=>{
  const f=fixture();try{
   const a=remember(f,{...(kind==='covered-reply'?{reply:perspective}:{})});
   // The already-delivered idea must still count when its original reply has
   // fallen outside the recent-message window supplied to the model.
   if(kind==='covered-reply')for(let i=0;i<24;i++)remember(f,{text:'临时记录编号'+i+'，这一轮没有新增长期话题',learn:false,reply:'已收到这条临时记录。'});
   const result=decision(a,kind==='unknown-message'?{source_quotes:[{message_id:999999,quote:source}]}:kind==='wrong-quote'?{source_quotes:[{message_id:a.user.id,quote:'用户没有说过这句话'}]}:{message:'看那些旧门框的照片时，藤蔓与光影会让不同的时间速度在同一个画面里相遇。',insight:perspective});
   const x=runtime(f,()=>result);await settle();assert.equal(proactive(f).length,0);assert.equal(await x.r.requestContentReview(),false);
  }finally{f.close();}
 });
});

test('rolled-back confirmed material emits no thought work or model call',async()=>{
 const f=fixture();try{
  const x=runtime(f,()=>{throw new Error('A rolled-back topic is not authenticated material');});await settle();const before=activityCounts(f);
  assert.throws(()=>f.store.transaction(()=>{remember(f);throw new Error('rollback source');}),/rollback source/);await settle();
  assert.equal(x.calls,0);assert.equal(f.store.relationship.snapshot().topics.length,0);assert.equal(proactive(f).length,0);assert.deepEqual(activityCounts(f),before);
 }finally{f.close();}
});

test('after initial empty startup, a genuine committed topic queues one thought and a replay queues none',async()=>{
 const f=fixture();try{
  let a;const x=runtime(f,()=>decision(a));await settle();assert.equal(x.calls,0);
  a=remember(f);const before=activityCounts(f);assert.equal(proactive(f).length,0);await settle();
  assert.equal(x.calls,1);assert.deepEqual(activityCounts(f),before);assert.equal(proactive(f).length,1);
  assert.equal(f.store.initializeReflection(),null);await settle();assert.equal(x.calls,1);
 }finally{f.close();}
});

test('equivalent material under a new topic alias is not another invitation to think or speak',async()=>{
 const f=fixture();try{
  const a=remember(f);const x=runtime(f,()=>decision(a));await settle();assert.equal(x.calls,1);assert.equal(proactive(f).length,1);
  remember(f,{key:'walk.doorframes.alias',title:'同一件事的另一标题'});await settle();
  assert.equal(x.calls,1);assert.equal(proactive(f).length,1);assert.equal(await x.r.requestContentReview(),false);
 }finally{f.close();}
});

test('a failed reflection does not retry through the ordinary manager error lane or later startup',async()=>{
 const f=fixture();try{
  remember(f);const x=runtime(f,()=>{throw new Error('Synthetic reflection failure');});await settle();assert.equal(x.calls,1);assert.equal(proactive(f).length,0);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM manager_inbox WHERE type='previous_plan_error'").get().n,0);
  f.advance(500*86400);f.store.recoverExpired();f.reopen();const retry=runtime(f,()=>{throw new Error('A failed thought is terminal');});await settle();assert.equal(retry.calls,0);assert.equal(await retry.r.wake(),false);
 }finally{f.close();}
});

test('an expired claimed thought is terminal and reopening cannot invoke its model again',async()=>{
 const f=fixture();try{
  remember(f);f.store.initializeReflection();const run=f.store.claimContentReview();assert.ok(run);assert.equal(f.store.relationship.forRun(run)?.kind,'reflection');
  f.advance(61);f.store.recoverExpired();assert.equal(f.db.prepare('SELECT state FROM dots_relationship_reflections WHERE id=?').get(run.reflection_id).state,'cancelled');
  f.reopen();const x=runtime(f,()=>{throw new Error('A claimed thought must never be replayed after lease loss');});await settle();assert.equal(x.calls,0);assert.equal(await x.r.requestContentReview(),false);assert.equal(proactive(f).length,0);
 }finally{f.close();}
});

test('a live thought is not claimed again or cancelled by constructing another runtime',async()=>{
 const f=fixture();let release;try{
  const a=remember(f);let entered;const ready=new Promise(resolve=>entered=resolve),hold=new Promise(resolve=>release=resolve);
  const first=runtime(f,async()=>{entered();await hold;return decision(a);});await ready;
  const second=runtime(f,()=>{throw new Error('The first runtime still holds the thought lease');});await settle();assert.equal(first.calls,1);assert.equal(second.calls,0);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM manager_runs WHERE state='running' AND purpose='content_review'").get().n,1);
  release();await settle();assert.equal(proactive(f).length,1);assert.equal(first.calls,1);assert.equal(second.calls,0);
 }finally{release?.();await settle();f.close();}
});

test('an active ordinary run prevents a private thought from occupying the same manager lane',async()=>{
 const f=fixture();try{
  remember(f);f.store.initializeReflection();f.store.enqueue('worker_report',{taskId:71,status:'done',summary:'真正的事项已经完成'});f.advance(3);
  const normal=f.store.claimManager();assert.ok(normal);assert.equal(normal.purpose,'reply');
  const x=runtime(f,()=>{throw new Error('Ordinary manager work owns this lane');});await settle();assert.equal(x.calls,0);assert.equal(f.store.claimContentReview(),null);
  assert.equal(proactive(f).length,0);assert.ok(f.store.isCurrent(normal));assert.equal(activityCounts(f).pending,1);
 }finally{f.close();}
});

test('a status-only report cannot hide an actual unfinished task from the reflection guard',async()=>{
 const f=fixture();try{
  const a=remember(f,{tasks:[{key:'photos-classify',title:'整理散步照片',instruction:'将散步照片按地点分类',resourceKey:'photos'}]});
  const task=f.db.prepare('SELECT id,status FROM goals').get();assert.equal(task.status,'active');
  f.store.enqueue('worker_report',{taskId:task.id,status:'active',summary:'照片整理仍在进行'});f.advance(3);const run=f.store.claimManager();assert.ok(run);
  f.store.completeManager(run,ordinary({reply:'照片整理还在继续。'}));const before=activityCounts(f);
  const x=runtime(f,()=>decision(a));await settle();assert.equal(x.calls,0);assert.equal(await x.r.requestContentReview(),false);assert.equal(proactive(f).length,0);assert.deepEqual(activityCounts(f),before);
 }finally{f.close();}
});

test('a future-scheduled active task alone does not prevent an independent reflection',async()=>{
 const f=fixture();try{
  const a=remember(f,{tasks:[{key:'photos-later',title:'稍后整理散步照片',instruction:'等照片传输完成后分类',resourceKey:'photos-later'}]});
  const task=f.db.prepare('SELECT id FROM goals').get(),worker=f.store.claimGoal(task.id);assert.ok(worker);
  // This is the worker's durable wait result, not a fabricated reflection or
  // user message. The active task remains real but has no work due now.
  const committed=f.store.commitRun(worker,()=>{f.db.prepare("UPDATE goals SET status='active',next_wake_at=? WHERE id=?").run(f.now()+3600,task.id);return {summary:'等待已安排的后续处理'};});assert.equal(committed.committed,true);
  const before=activityCounts(f);assert.equal(before.pending,0);assert.equal(before.tasks,1);assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM manager_runs WHERE state='running'").get().n,0);
  const x=runtime(f,()=>decision(a));await settle();
  assert.equal(x.calls,1);assert.equal(proactive(f).length,1);assert.equal(proactive(f)[0].content,perspective);assert.deepEqual(activityCounts(f),before);
  assert.equal(f.db.prepare('SELECT next_wake_at FROM goals WHERE id=?').get(task.id).next_wake_at,f.now()+3600);
 }finally{f.close();}
});

test('duplicating one citation cannot support a claimed connection between distinct shared materials',async()=>{
 const f=fixture();try{
  const a=remember(f),quote={message_id:a.user.id,quote:source};
  const x=runtime(f,()=>decision(a,{idea_kind:'connection',source_quotes:[quote,quote]}));await settle();
  assert.equal(x.calls,1);assert.equal(proactive(f).length,0);assert.equal(await x.r.requestContentReview(),false);
 }finally{f.close();}
});

test('withdrawing either source removes a derived multi-topic insight from later model context',async()=>{
 const f=fixture();try{
  const a=remember(f),b=remember(f,{text:'爵士乐最吸引我的是鼓点骤然停住的那一拍，旋律在无声处好像还在往前走',key:'music.silence',title:'爵士乐的停顿'});
  const message='旧门框上的藤蔓和爵士乐的鼓点都有一种有趣的节奏：前者缓慢留下生长的轨迹，后者用瞬间的停顿留下听觉的轨迹。';
  const x=runtime(f,({call,prompt})=>{
   if(call===1)return decision(a,{idea_kind:'connection',message,insight:'藤蔓在旧门框留下生长轨迹，爵士乐鼓点在听觉中留下时间轨迹，两种节奏通过痕迹被感知',not_covered_by_history:'既有回复没有联系藤蔓的生长轨迹与爵士乐的听觉轨迹',source_quotes:[{message_id:a.user.id,quote:a.user.content},{message_id:b.user.id,quote:b.user.content}]});
   assert.equal(call,2);assert.ok(!prompt.includes(message));assert.ok(prompt.includes(source));return decision(a,{action:'discard',message:''});
  });await settle();assert.equal(proactive(f).length,1);assert.equal(proactive(f)[0].topicId,a.topic.id);
  f.store.relationship.deleteTopic(b.topic.id);assert.equal(proactive(f).length,1);
  remember(f,{text:'深海章鱼的触腕可以独立探索，感兴趣的是它怎样协调各个方向的动作',key:'nature.octopus',title:'章鱼的触腕'});await settle();
  assert.equal(x.calls,2);assert.equal(proactive(f).length,1);assert.ok(f.store.snapshot().messages.some(item=>item.content===message));
 }finally{f.close();}
});
