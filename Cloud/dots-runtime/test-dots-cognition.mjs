import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createManagerStore} from './manager-store.mjs';
import {createDotsCognition,UNDERSTANDING_SCHEMA,THINK_SCHEMA,MOMENT_SCHEMA} from './dots-cognition.mjs';
import {createPublicDiscovery,INTEREST_SCHEMA} from './public-discovery.mjs';
import {createManagerRuntime} from './manager-runtime.mjs';

const source='我散步时喜欢拍老房子的门框，尤其喜欢看藤蔓和光影落在旧木头上的样子。';
const question='同一张旧门框照片里，建筑、藤蔓与光影的变化能呈现怎样不同的时间尺度？';
const partial='旧门框保存着建筑被使用的痕迹，藤蔓则呈现生命正在生长的方向。';
const finalView='旧木头的磨损、藤蔓的生长和当天光影的移动，让同一张门框照片叠起了三种速度的时间。';
const nextQuestion='把当天移动的光影也放进来，三种速度的时间如何在同一张照片里相遇？';
const ordinary=extra=>({reply:'门框、藤蔓和光影确实是你散步拍照时留意的细节。',summary:'交流完成',awaiting_user_input:false,tasks:[],continuations:[],reviews:[],controls:[],instructions:[],notes:[],inspect_tasks:[],relationship:{topics:[]},...extra});
function fixture(){
 const root=mkdtempSync(path.join(os.tmpdir(),'dots-cognition-')),file=path.join(root,'db.sqlite');let clock=1792310000,db=new DatabaseSync(file),store;const engines=new Set();
 db.exec(`CREATE TABLE goals(id INTEGER PRIMARY KEY,title TEXT,instruction TEXT,status TEXT,thread_id TEXT,workspace TEXT,created_at INTEGER,updated_at INTEGER,next_wake_at INTEGER,last_run_at INTEGER,last_summary TEXT DEFAULT '',run_count INTEGER DEFAULT 0);CREATE TABLE approvals(id INTEGER PRIMARY KEY,goal_id INTEGER,reason TEXT,command TEXT,status TEXT,created_at INTEGER,decided_at INTEGER,output TEXT);CREATE TABLE events(id INTEGER PRIMARY KEY,goal_id INTEGER,type TEXT,payload TEXT,created_at INTEGER,consumed_at INTEGER);`);
 const open=()=>store=createManagerStore({db,workspaceRoot:root,now:()=>clock});open();
 const user=store.message({message:source,requestId:'historical-shared-experience'}).message;store.completeManager(store.claimManager(),ordinary());
 const reference={kind:'user',id:String(user.id),quote:source},memory={enabled:true,generation:0};
 const calls=[];let steps=0,decide=null,stepFn=null,planFn=null;
 const ready=()=>({action:'ready',contribution_kind:'insight',view:finalView,new_contribution:'把当天光影的移动与建筑磨损、植物生长联系起来，形成三种变化速度的完整视角。',understanding:'用户留意的是旧物与正在发生的生命、光线相遇时的画面，而不仅是建筑本身。',next_question:'',why_share:'这个三种时间速度的想法，与你喜欢记录门框、藤蔓和光影的共同经历有直接联系。',references:[reference]});
 const message=()=>({action:'send',expression_kind:'insight',message:finalView,new_value:finalView,context_clear:true,claims_supported:true,reason:'形成了此前没有交流过、与你实际拍照习惯有关的时间视角。',wait_for:'',worth_sharing:true,not_already_expressed:true,appropriate_now:true,references:[reference]});
 const create=options=>{
  const engine=createDotsCognition({store,now:()=>clock,memory:{settings:()=>({...memory})},logger:{warn(){}},assess:async(prompt,schema,control)=>{
   const phase=schema===UNDERSTANDING_SCHEMA?'understand':schema===THINK_SCHEMA?'think':'moment';calls.push({phase,prompt});
   if(phase==='understand')return planFn?planFn(prompt):{understanding:'用户喜欢散步拍摄门框、藤蔓与光影的相遇，更多原因仍有不确定性。',focuses:[{key:'photography.time',question,personal_meaning:'这来自用户真实提过的拍照偏好，可以进一步形成有关画面中时间感的想法。',references:[reference]}]};
   if(phase==='think'){steps++;return stepFn?stepFn({prompt,control,step:steps}):steps===1?{action:'continue',contribution_kind:'insight',view:partial,new_contribution:'先把建筑留下的使用痕迹与植物正在生长的方向区分开。',understanding:'用户的照片同时包含旧物和生长中的植物。',next_question:nextQuestion,why_share:'',references:[reference]}:ready();}
   return decide?decide({prompt,control}):message();
  },...options});engines.add(engine);return engine;
 };
 const counts=()=>({users:db.prepare("SELECT COUNT(*) n FROM manager_messages WHERE role='user'").get().n,inbox:db.prepare('SELECT COUNT(*) n FROM manager_inbox').get().n,tasks:db.prepare('SELECT COUNT(*) n FROM goals').get().n,replies:db.prepare("SELECT COUNT(*) n FROM manager_messages WHERE role='assistant' AND origin='reply'").get().n});
 return {root,user,reference,memory,create,ready,message,calls,counts,advance:n=>clock+=n,now:()=>clock,get db(){return db;},get store(){return store;},setDecision:fn=>decide=fn,setStep:fn=>stepFn=fn,setPlan:fn=>planFn=fn,messages:()=>store.snapshot().messages.filter(m=>m.origin==='proactive'),reopen(){for(const e of engines)e.close();engines.clear();db.close();db=new DatabaseSync(file);open();},close(){for(const e of engines)e.close();db.close();rmSync(root,{recursive:true,force:true});}};
}

test('unchanged original evidence supports multiple private steps; only a formed intent can enter moment assessment',async()=>{
 const f=fixture(),e=f.create();try{
  const before=f.counts();await e.pump({maxSteps:1});assert.deepEqual(f.calls.map(c=>c.phase),['understand','think']);assert.equal(f.messages().length,0);assert.equal(f.db.prepare('SELECT frontier FROM dots_cognition_focuses').get().frontier,nextQuestion);
  await e.pump({maxSteps:1});assert.deepEqual(f.calls.map(c=>c.phase),['understand','think','think','moment']);assert.deepEqual(f.counts(),before);assert.equal(f.messages().length,1);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM dots_cognition_steps').get().n,2);assert.deepEqual(f.messages()[0].respondsToMessageIds,[]);
  assert.match(f.calls[2].prompt,/旧门框保存着建筑被使用的痕迹/);assert.match(f.calls[2].prompt,/当天移动的光影/);
 }finally{f.close();}
});
test('a held intent waits for a real contextual change, never for elapsed silence, clock ticks or restart',async()=>{
 const f=fixture();let e=f.create();try{
  f.setDecision(()=>({...f.message(),action:'hold',message:'',appropriate_now:false,reason:'当前这段交流还没有结束，保留想法即可。',wait_for:'当前交流自然结束，或者用户明确重新开启交流。'}));
  await e.pump();assert.equal(f.messages().length,0);assert.equal(f.db.prepare('SELECT state FROM dots_cognition_intents').get().state,'held');const calls=f.calls.length;
  for(let i=0;i<8;i++){f.advance(86400);await e.pump();}assert.equal(f.calls.length,calls);
  f.reopen();e=f.create();await e.pump();assert.equal(f.calls.length,calls);assert.equal(f.messages().length,0);
  f.store.message({message:'现在可以聊了',requestId:'new-context'});f.store.completeManager(f.store.claimManager(),ordinary({reply:'好。'}));f.setDecision(()=>f.message());await e.pump();assert.equal(f.messages().length,1);
 }finally{f.close();}
});
test('having an active task or worker is not a social prerequisite or a veto on sharing a ready thought',async()=>{
 const f=fixture();try{
  const [task]=f.store.createTasks([{key:'independent',title:'用户此前的独立事项',instruction:'保留当前执行',dependencies:[]}]);const worker=f.store.claimGoal(task.id);assert.ok(worker);
  const e=f.create();await e.pump();assert.equal(f.messages().length,1);assert.equal(f.store.isCurrent(worker),true);
  const prompt=f.calls.find(c=>c.phase==='moment').prompt;assert.ok(!prompt.includes('用户此前的独立事项'));assert.ok(!prompt.includes('next_wake_at'));
 }finally{f.close();}
});
test('a new input during moment assessment preserves the thought but prevents a stale expression',async()=>{
 const f=fixture(),e=f.create();try{
  f.setDecision(()=>{f.store.message({message:'先别聊，我想补充一下刚才的意思',requestId:'mid-assessment'});return f.message();});await e.pump();assert.equal(f.messages().length,0);assert.equal(f.db.prepare('SELECT state FROM dots_cognition_intents').get().state,'held');
  f.setDecision(()=>f.message());await e.pump();assert.equal(f.messages().length,0);
  f.store.completeManager(f.store.claimManager(),ordinary({reply:'好，刚才的补充已经说清楚了。'}));await e.pump();assert.equal(f.messages().length,1);
 }finally{f.close();}
});
test('understanding, continuing thought and formed intent survive restart without a fresh user event',async()=>{
 const f=fixture();let e=f.create();try{
  await e.pump({maxSteps:1});const before=f.counts();f.reopen();e=f.create();await e.pump({maxSteps:1});assert.equal(f.messages().length,1);assert.deepEqual(f.counts(),before);assert.equal(f.calls.filter(c=>c.phase==='understand').length,1);
 }finally{f.close();}
});
test('repeating a previous view or the same frontier settles the line of thought instead of spinning',async()=>{
 const f=fixture(),e=f.create();try{
  await e.pump({maxSteps:1});f.setStep(()=>({action:'continue',view:partial,new_contribution:'只是把刚才说过的观点重新表达了一次。',understanding:'',next_question:nextQuestion,why_share:'',references:[f.reference]}));await e.pump();
  assert.equal(f.db.prepare('SELECT state FROM dots_cognition_focuses').get().state,'resting');assert.equal(f.messages().length,0);const calls=f.calls.length;f.advance(999999);await e.pump();assert.equal(f.calls.length,calls);
 }finally{f.close();}
});
test('a genuine next frontier can create an independently advancing child from the same evidence',async()=>{
 const f=fixture(),e=f.create();try{
  f.setStep(({step})=>step===1?{...f.ready(),next_question:'如果把照片中的光线当作观看路径，门框会怎样改变人看见藤蔓的顺序？'}:{action:'rest',view:'',new_contribution:'',understanding:'',next_question:'',why_share:'',references:[f.reference]});await e.pump({maxSteps:1});assert.equal(f.db.prepare('SELECT COUNT(*) n FROM dots_cognition_focuses WHERE parent_id IS NOT NULL').get().n,1);
  const before=f.counts();await e.pump({maxSteps:1});assert.deepEqual(f.counts(),before);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM dots_cognition_steps').get().n,2);assert.equal(f.messages().length,1);
 }finally{f.close();}
});
test('withdrawn user evidence removes private understanding, steps, intents and derived context',async()=>{
 const f=fixture(),e=f.create();try{
  await e.pump();assert.equal(f.messages().length,1);
  f.db.prepare('INSERT INTO dots_relationship_forgotten_sources(manager_id,message_id) VALUES(?,?)').run(f.store.managerId,f.user.id);await e.pump();
  assert.equal(f.db.prepare('SELECT understanding FROM dots_cognition_state').get().understanding,'');assert.equal(f.db.prepare('SELECT state FROM dots_cognition_intents').get().state,'withdrawn');assert.equal(f.db.prepare('SELECT next_view FROM dots_cognition_steps LIMIT 1').get().next_view,'');assert.equal(f.messages().length,1);
 }finally{f.close();}
});
test('memory generation change during private thinking cannot form or deliver an old-source intent',async()=>{
 const f=fixture(),e=f.create();try{
  f.setStep(()=>{f.memory.generation++;return f.ready();});await e.pump({maxSteps:1});assert.equal(f.messages().length,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM dots_cognition_intents').get().n,0);
  await e.pump();assert.equal(f.db.prepare('SELECT state FROM dots_cognition_focuses').get().state,'withdrawn');
 }finally{f.close();}
});
test('a natural correction updates the person understanding and retires an incompatible held intention',async()=>{
 const f=fixture(),e=f.create();try{
  f.setDecision(()=>({...f.message(),action:'hold',message:'',appropriate_now:false,wait_for:'当前这段话题结束后再判断。'}));await e.pump();assert.equal(f.db.prepare('SELECT state FROM dots_cognition_intents').get().state,'held');
  const correction='我现在不太想拍旧门框这类照片了，这个偏好不用继续记着。';const user=f.store.message({message:correction,requestId:'correction'}).message;f.store.completeManager(f.store.claimManager(),ordinary({reply:'好，按你现在的意思来。'}));
  const ref={kind:'user',id:String(user.id),quote:correction};f.setPlan(()=>({understanding:'用户明确纠正：当前不再想拍旧门框，不应沿旧偏好继续主动延伸。',understanding_references:[ref],retire_focuses:[{key:'photography.time',reason:'用户明确表示不再沿这个偏好继续。',references:[ref]}],focuses:[]}));
  f.setDecision(()=>f.message());await e.pump();assert.equal(f.messages().length,0);assert.equal(f.db.prepare('SELECT state FROM dots_cognition_intents').get().state,'dropped');assert.equal(f.db.prepare('SELECT state FROM dots_cognition_focuses').get().state,'retired');assert.match(f.db.prepare('SELECT understanding FROM dots_cognition_state').get().understanding,/明确纠正/);
 }finally{f.close();}
});
test('new relevant evidence can release a held intention without a new user message or a timed retry',async()=>{
 const f=fixture(),e=f.create();try{
  f.setDecision(()=>({...f.message(),action:'hold',message:'',appropriate_now:false,wait_for:'这个观察还缺少可核对的公开例子，先保留。'}));await e.pump();assert.equal(f.messages().length,0);const before=f.counts();
  const event={key:'evidence',title:'旧建筑摄影展呈现建筑、植物与光线的不同时间尺度',summary:'展览公开介绍了不同时间尺度在旧建筑摄影中的表达。',publisher:'公共艺术馆',url:'https://news.google.com/rss/articles/evidence',published:f.now()};assert.equal(e.observe({id:'evidence',event,userReferences:[f.reference]}),true);
  const understanding=f.db.prepare('SELECT understanding FROM dots_cognition_state').get().understanding;f.setPlan(()=>({understanding,understanding_references:[f.reference],retire_focuses:[],focuses:[]}));f.setDecision(()=>({...f.message(),references:[f.reference,{kind:'observation',id:'evidence',quote:event.title}]}));
  await e.pump();assert.deepEqual(f.counts(),before);assert.equal(f.messages().length,1);assert.match(f.messages()[0].content,/来源/);
 }finally{f.close();}
});
test('forged quotations, routine rest and a negative expression assessment do not leak messages',async t=>{
 for(const kind of ['forged','rest','drop'])await t.test(kind,async()=>{
  const f=fixture(),e=f.create();try{
   if(kind==='forged')f.setStep(()=>({...f.ready(),references:[{...f.reference,quote:'用户从来没有说过的事情'}]}));
   if(kind==='rest')f.setStep(()=>({...f.ready(),action:'rest'}));
   if(kind==='drop')f.setDecision(()=>({...f.message(),action:'drop',message:'',worth_sharing:false}));
   await e.pump();assert.equal(f.messages().length,0);
  }finally{f.close();}
 });
});
test('compute allowances survive restart and only limit work; clock passage alone cannot create a thought',async()=>{
 const f=fixture();let e=f.create({callsPerHour:1});try{
  await e.pump();assert.deepEqual(f.calls.map(c=>c.phase),['understand']);f.reopen();e=f.create({callsPerHour:1});await e.pump();assert.equal(f.calls.length,1);assert.equal(f.messages().length,0);
  f.advance(3600);f.setStep(()=>({...f.ready(),action:'rest'}));await e.pump();assert.equal(f.messages().length,0);
 }finally{f.close();}
});
test('the process lease prevents two cognition runtimes from duplicating the same work',async()=>{
 const f=fixture();let release;const waiting=new Promise(resolve=>release=resolve);const e=f.create(),other=f.create();try{
  f.setPlan(async()=>{await waiting;return {understanding:'',focuses:[]};});const running=e.pump();await new Promise(resolve=>setImmediate(resolve));assert.equal(await other.pump(),false);release();await running;assert.equal(f.calls.length,1);
 }finally{release?.();f.close();}
});
test('public updates become observations without a direct news review or a direct message',async()=>{
 const f=fixture(),c=f.create();let available=false,newsCalls=0;try{
  const sourceEvent={key:'actual-external-event',title:'旧建筑展览公布新的光影摄影作品',summary:'公开展览介绍了旧建筑摄影作品。',publisher:'公共艺术馆',published:f.now()+1,url:'https://news.google.com/rss/articles/example'};
  const discovery=createPublicDiscovery({store:f.store,now:f.now,memory:{settings:()=>f.memory},readNews:async()=>available?[sourceEvent]:[],onObservation:o=>c.observe(o),assess:async(_prompt,schema)=>{if(schema!==INTEREST_SCHEMA){newsCalls++;throw new Error('Direct news expression must be retired');}return {interests:[{public_query:'建筑摄影',source_message_id:f.user.id,quote:source,ongoing_interest:true,public_subject:true,supporting_quotes:[]}]};},logger:{warn(){}}});
  await discovery.tick();available=true;f.advance(3600);await discovery.tick();assert.equal(newsCalls,0);assert.equal(f.messages().length,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM dots_cognition_observations').get().n,1);assert.equal(f.db.prepare('SELECT state FROM dots_discovery_updates').get().state,'observed');discovery.close();
 }finally{f.close();}
});
test('legacy reply-followup reviews are disabled when cognition owns spontaneous conversation',async()=>{
 const f=fixture(),e=f.create();let calls=0;const r=createManagerRuntime({store:f.store,workspaceRoot:f.root,codex:{startThread(){calls++;throw new Error('Legacy review used');}},contentReviewEnabled:false});try{
  assert.equal(await r.requestContentReview(),false);assert.equal(f.store.relationship.hasPending(),false);await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,0);
 }finally{r.close();f.close();}
});

test('an internal rule acknowledgment stays private even when the model marks it ready',async()=>{
 const f=fixture(),e=f.create();try{
  const before=f.counts();
  f.setStep(()=>({...f.ready(),contribution_kind:'internal_acknowledgment',view:'已接收并采用“任务核验卡”规则。',new_contribution:'今后遇到实际检查时，会提供原始输出，不会声称未经验证的结果。',why_share:'用于确认本轮对话规则已经生效。'}));
  await e.pump();
  assert.equal(f.messages().length,0);assert.deepEqual(f.counts(),before);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM dots_cognition_intents').get().n,0);
  assert.equal(f.db.prepare('SELECT state FROM dots_cognition_focuses').get().state,'resting');
  assert.ok(!f.calls.some(call=>call.phase==='moment'));
 }finally{f.close();}
});

test('expression checks reject opaque acknowledgments and unsupported adoption claims before publication',async t=>{
 for(const [name,override,reason]of [
  ['internal acknowledgment',{expression_kind:'internal_acknowledgment',message:'已接收并采用“任务核验卡”规则。'},/内部确认/],
  ['missing context',{context_clear:false,message:'规则已经生效，以后按这个处理。'},/上下文/],
  ['unsupported adoption',{claims_supported:false,message:'按照你刚确认的方案，我已经修改了系统设置。'},/证据支持/],
  ['no new value',{new_value:''},/新价值/],
  ['legacy unchecked response',{expression_kind:undefined,context_clear:undefined,claims_supported:undefined,new_value:undefined},/内部确认/],
 ])await t.test(name,async()=>{
  const f=fixture(),e=f.create();try{
   const before=f.counts();f.setDecision(()=>({...f.message(),...override}));await e.pump();
   assert.equal(f.messages().length,0);assert.deepEqual(f.counts(),before);
   const intent=f.db.prepare('SELECT state,reason FROM dots_cognition_intents').get();
   assert.equal(intent.state,'dropped');assert.match(intent.reason,reason);
   const calls=f.calls.length;f.advance(86400);await e.pump();assert.equal(f.calls.length,calls,'rejected text is not sent later just because time passed');
  }finally{f.close();}
 });
});

test('a contextual practical suggestion remains eligible without new user input or a fixed introduction',async()=>{
 const f=fixture(),e=f.create();try{
  const content='你之前说喜欢门框上的光影，我想到可以连续几天在同一时刻拍一张，更容易确认变化来自藤蔓生长还是光线移动。这是一个拍摄建议。';
  const contribution='在相同时刻连续拍摄，可以比较植物生长，同时减少每天光线位置不同造成的干扰。';
  f.setStep(()=>({...f.ready(),contribution_kind:'suggestion',view:content,new_contribution:contribution}));
  f.setDecision(()=>({...f.message(),expression_kind:'suggestion',message:content,new_value:contribution}));
  const before=f.counts();f.advance(86400*10);await e.pump();
  assert.equal(f.messages().length,1);assert.equal(f.messages()[0].content,content);assert.deepEqual(f.counts(),before);
  const prompt=f.calls.find(call=>call.phase==='moment').prompt;
  const data=JSON.parse(prompt.split('\nBACKGROUND_DATA_JSON\n')[1]);
  assert.equal(data.intent.newContribution,contribution);
  assert.equal(data.sourceContext[0].quote,source);
  assert.equal(data.sourceContext[0].id,f.reference.id);
  assert.ok(data.sourceContext[0].date<data.evaluatedAt.slice(0,10),'old source keeps its original date');
  assert.ok(data.exchange.every(message=>message.role!=='user'||message.content===source),'no synthetic user message was added');
 }finally{f.close();}
});

test('administrator registration notices are durable and never resume held cognition or enqueue Agent work',async()=>{
 const f=fixture(),e=f.create();try{
  f.setDecision(()=>({...f.message(),action:'hold',message:'',appropriate_now:false,reason:'等待真实对话变化',wait_for:'用户新消息'}));
  await e.pump();const calls=f.calls.length,state=e.workState(),counts=f.counts();
  const event={id:'registration:shiyan_web:test-notice-only',source:'shiyan_web',username:'u_fixture_internal',email:'fixture@example.test',registeredAt:Date.now()};
  const first=f.store.registrationNotice(event),replay=f.store.registrationNotice(event);
  assert.equal(first.message.id,replay.message.id);assert.equal(first.message.origin,'proactive');
  assert.match(first.message.content,/拾燕网页端/);assert.match(first.message.content,/用户名：fixture@example\.test/);
  assert(!first.message.content.includes(event.username));assert(!first.message.content.includes('邮箱：'));
  assert.equal(e.workState().inputKey,state.inputKey);assert.equal(e.workState().contextKey,state.contextKey);
  await e.pump();assert.equal(f.calls.length,calls);assert.deepEqual(f.counts(),counts);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM manager_inbox WHERE consumed_at IS NULL').get().n,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM manager_registration_notices').get().n,1);
  assert.throws(()=>f.store.registrationNotice({...event,username:'changed_username'}),error=>error.statusCode===409);
 }finally{f.close();}
});

test('a legacy registration notice gains email in the same message without duplicates or cognition work',async()=>{
 const f=fixture(),e=f.create();try{
  f.setDecision(()=>({...f.message(),action:'hold',message:'',appropriate_now:false,reason:'等待真实对话变化',wait_for:'用户新消息'}));
  await e.pump();const calls=f.calls.length,state=e.workState(),counts=f.counts();
  const legacy={id:'registration:shiyan_web:legacy-email-upgrade',source:'shiyan_web',username:'u_legacy_fixture',registeredAt:Date.now()};
  const first=f.store.registrationNotice(legacy);assert.match(first.message.content,/用户名：u_legacy_fixture/);
  const enriched={...legacy,email:'legacy@example.test'};
  const upgraded=f.store.registrationNotice(enriched);
  assert.equal(upgraded.message.id,first.message.id);assert.equal(upgraded.message.revision,first.message.revision+1);
  assert.match(upgraded.message.content,/用户名：legacy@example\.test/);assert(!upgraded.message.content.includes(legacy.username));
  assert(upgraded.activityCursor>first.activityCursor);
  for(const event of [enriched,legacy]){
   const replay=f.store.registrationNotice(event);
   assert.equal(replay.message.id,first.message.id);assert.equal(replay.message.revision,upgraded.message.revision);
   assert.equal(replay.message.content,upgraded.message.content,'old delivery cannot remove the known email');
  }
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM manager_messages WHERE proactive_reason='管理员注册提醒'").get().n,1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM manager_registration_notices').get().n,1);
  assert.equal(e.workState().inputKey,state.inputKey);assert.equal(e.workState().contextKey,state.contextKey);
  await e.pump();assert.equal(f.calls.length,calls);assert.deepEqual(f.counts(),counts);
  assert.throws(()=>f.store.registrationNotice({...enriched,email:'different@example.test'}),error=>error.statusCode===409);
 }finally{f.close();}
});

test('redelivering a notice repairs the former email label in place while preserving each signup identity',async()=>{
 const f=fixture(),e=f.create();try{
  f.setDecision(()=>({...f.message(),action:'hold',message:'',appropriate_now:false,reason:'等待真实对话变化',wait_for:'用户新消息'}));
  await e.pump();const calls=f.calls.length,state=e.workState(),counts=f.counts();
  const events=[
   {id:'registration:shiyan_web:repair-label',source:'shiyan_web',username:'u_internal_repair',email:'repair@example.test',registeredAt:Date.now()},
   {id:'registration:spongebob_mcp_web:repair-label',source:'spongebob_mcp_web',username:'sponge_bob',email:'not-displayed@example.test',registeredAt:Date.now()}
  ];
  for(const event of events){
   const expected=event.source==='shiyan_web'?event.email:event.username;
   const first=f.store.registrationNotice(event);
   const oldContent=first.message.content.replace('用户名：'+expected,'邮箱：'+(event.email||'未提供'));
   assert.notEqual(oldContent,first.message.content);
   f.db.prepare('UPDATE manager_messages SET content=? WHERE id=?').run(oldContent,first.message.id);
   const repaired=f.store.registrationNotice(event);
   assert.equal(repaired.message.id,first.message.id);assert.equal(repaired.message.revision,first.message.revision+1);
   assert(repaired.message.content.includes('用户名：'+expected));assert(!repaired.message.content.includes('邮箱：'));assert(!repaired.message.content.includes('未提供'));
   if(event.source==='spongebob_mcp_web')assert(!repaired.message.content.includes(event.email),'MCP website always displays its signup account, even if an email is present');
   assert(repaired.activityCursor>first.activityCursor);
   const replay=f.store.registrationNotice(event);assert.equal(replay.message.id,repaired.message.id);assert.equal(replay.message.revision,repaired.message.revision);
  }
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM manager_messages WHERE proactive_reason='管理员注册提醒'").get().n,2);
  assert.equal(e.workState().inputKey,state.inputKey);assert.equal(e.workState().contextKey,state.contextKey);
  await e.pump();assert.equal(f.calls.length,calls);assert.deepEqual(f.counts(),counts);
 }finally{f.close();}
});
