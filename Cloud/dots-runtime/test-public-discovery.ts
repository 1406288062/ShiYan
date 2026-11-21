import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createManagerStore} from './manager-store.ts';
import {createPublicDiscovery,parseNewsFeed,readPublicNews,newsUrl,INTEREST_SCHEMA} from './public-discovery.ts';

const quote='我一直喜欢看天文学的新发现，尤其是韦布望远镜拍到的星系。';
const ordinary={reply:'记下了你对天文学和韦布望远镜的兴趣。',summary:'交流结束',awaiting_user_input:false,tasks:[],continuations:[],reviews:[],controls:[],instructions:[],notes:[],inspect_tasks:[],relationship:{topics:[]}};
function fixture(){
 const root=mkdtempSync(path.join(os.tmpdir(),'dots-public-updates-'));let clock=1792310000;
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE goals(id INTEGER PRIMARY KEY,title TEXT,instruction TEXT,status TEXT,thread_id TEXT,workspace TEXT,created_at INTEGER,updated_at INTEGER,next_wake_at INTEGER,last_run_at INTEGER,last_summary TEXT DEFAULT '',run_count INTEGER DEFAULT 0);CREATE TABLE approvals(id INTEGER PRIMARY KEY,goal_id INTEGER,reason TEXT,command TEXT,status TEXT,created_at INTEGER,decided_at INTEGER,output TEXT);CREATE TABLE events(id INTEGER PRIMARY KEY,goal_id INTEGER,type TEXT,payload TEXT,created_at INTEGER,consumed_at INTEGER);`);
 const store=createManagerStore({db,workspaceRoot:root,now:()=>clock});
 const user=store.message({message:quote,requestId:'old-interest'}).message;
 store.completeManager(store.claimManager(),ordinary);
 const settings={enabled:true,generation:0};let items=[],fetches=0,calls=0,decision;
 const event=(key='new',title='韦布望远镜发现遥远星系的新结构')=>({key,title,summary:title+'，研究团队公布了观测结果。',publisher:'NASA',published:clock,url:'https://news.google.com/rss/articles/'+key});
 const counts=()=>({users:db.prepare("SELECT COUNT(*) n FROM manager_messages WHERE role='user'").get().n,tasks:db.prepare('SELECT COUNT(*) n FROM goals').get().n,inbox:db.prepare('SELECT COUNT(*) n FROM manager_inbox').get().n,replies:db.prepare("SELECT COUNT(*) n FROM manager_messages WHERE origin='reply' AND role='assistant'").get().n});
 const create=options=>createPublicDiscovery({store,now:()=>clock,memory:{settings:()=>({...settings})},readNews:async()=>{fetches++;return items;},assess:async(prompt,schema,control)=>{
   calls++;if(schema===INTEREST_SCHEMA)return {interests:[{public_query:'韦布望远镜',source_message_id:user.id,quote,ongoing_interest:true,public_subject:true}]};
   return typeof decision==='function'?decision(prompt,control):decision||{action:'send',message:'NASA 报道了一项韦布望远镜对遥远星系的新观测，你一直关注的星系研究又多了一份材料。',reason:'有实际的新星系观测',interest_quote:quote,event_quote:items[0].title,relevant:true,novel:true,appropriate:true};
 },logger:{warn(){}},...options});
 return {db,store,user,settings,event,counts,create,now:()=>clock,advance:n=>clock+=n,setItems:x=>items=x,setDecision:x=>decision=x,get fetches(){return fetches;},get calls(){return calls;},messages:()=>store.snapshot().messages.filter(m=>m.origin==='proactive'),close(){db.close();rmSync(root,{recursive:true,force:true});}};
}
test('after six hours without a user message or task, a real source change initiates a sourced proactive message',async()=>{
 const f=fixture(),r=f.create();try{
  f.setItems([f.event('old','此前公布的韦布望远镜图像')]);const before=f.counts();await r.tick();assert.equal(f.messages().length,0);
  f.advance(21600);f.setItems([f.event('new'),f.event('old','此前公布的韦布望远镜图像')]);await r.tick();
  assert.deepEqual(f.counts(),before);assert.equal(f.messages().length,1);assert.match(f.messages()[0].content,/来源：\[NASA\]\(https:\/\/news.google.com\/rss\/articles\/new\)/);assert.deepEqual(f.messages()[0].respondsToMessageIds,[]);
  assert.equal(f.db.prepare('SELECT state FROM dots_discovery_updates').get().state,'sent');
 }finally{r.close();f.close();}
});
test('clock passage, unchanged feeds, empty feeds and restart never create a greeting',async()=>{
 const f=fixture();let r=f.create();try{
  await r.tick();for(let i=0;i<5;i++){f.advance(36000);await r.tick();}
  r.close();r=f.create();f.advance(36000);await r.tick();assert.equal(f.messages().length,0);assert.equal(f.calls,1);
 }finally{r.close();f.close();}
});
test('an initial feed is a baseline, and old or future publication dates cannot manufacture new updates',async()=>{
 const f=fixture(),r=f.create();try{
  f.setItems([f.event('initial')]);await r.tick();f.advance(3600);
  f.setItems([{...f.event('stale'),published:f.now()-200000},{...f.event('future'),published:f.now()+1000}]);await r.tick();assert.equal(f.messages().length,0);assert.equal(f.calls,1);
 }finally{r.close();f.close();}
});
test('duplicates across changed IDs and process restarts are not delivered twice',async()=>{
 const f=fixture();let r=f.create();try{
  await r.tick();f.advance(3600);f.setItems([f.event()]);await r.tick();assert.equal(f.messages().length,1);
  r.close();r=f.create();f.advance(3600);f.setItems([f.event('different-id')]);await r.tick();assert.equal(f.messages().length,1);
 }finally{r.close();f.close();}
});
test('fetch failure does not establish a baseline or claim that a new discovery happened',async()=>{
 const f=fixture();let fail=true;
 const r=f.create({readNews:async()=>{if(fail)throw new Error('unavailable');return [f.event()];}});try{
  await r.tick();assert.equal(f.db.prepare('SELECT initialized FROM dots_discovery_interests').get().initialized,0);
  fail=false;f.advance(3600);await r.tick();assert.equal(f.messages().length,0);assert.equal(f.db.prepare('SELECT initialized FROM dots_discovery_interests').get().initialized,1);
 }finally{r.close();f.close();}
});
test('irrelevant, already covered, unsuitable and ungrounded model decisions are discarded',async t=>{
 for(const update of [{relevant:false},{novel:false},{appropriate:false},{event_quote:'并不存在的新闻事件'},{interest_quote:'用户没有说过的兴趣'},{message:'https://invented.example/fake'}])await t.test(JSON.stringify(update),async()=>{
  const f=fixture(),r=f.create();try{
   await r.tick();f.advance(3600);f.setItems([f.event()]);f.setDecision({action:'send',message:'NASA 报道了韦布望远镜发现遥远星系的新结构。',reason:'新观测',interest_quote:quote,event_quote:f.event().title,relevant:true,novel:true,appropriate:true,...update});await r.tick();assert.equal(f.messages().length,0);assert.equal(f.db.prepare('SELECT state FROM dots_discovery_updates').get().state,'discarded');
  }finally{r.close();f.close();}
 });
});
test('pending user input defers the update without occupying the task or ordinary reply lane',async()=>{
 const f=fixture(),r=f.create();try{
  await r.tick();f.advance(3600);f.store.message({message:'请先回答现在这个问题',requestId:'pending'});f.setItems([f.event()]);await r.tick();assert.equal(f.messages().length,0);assert.equal(f.db.prepare('SELECT state FROM dots_discovery_updates').get().state,'pending');
  f.store.completeManager(f.store.claimManager(),ordinary);await r.tick();assert.equal(f.messages().length,1);
 }finally{r.close();f.close();}
});
test('a new user message arriving during assessment prevents the stale thought from publishing',async()=>{
 const f=fixture(),r=f.create();try{
  await r.tick();f.advance(3600);f.setItems([f.event()]);f.setDecision(()=>{f.store.message({message:'先别聊了',requestId:'interrupt'});return {action:'send',message:'NASA 报道了韦布望远镜发现遥远星系的新结构。',reason:'新观测',interest_quote:quote,event_quote:f.event().title,relevant:true,novel:true,appropriate:true};});
  await r.tick();assert.equal(f.messages().length,0);assert.equal(f.db.prepare('SELECT state FROM dots_discovery_updates').get().state,'superseded');
 }finally{r.close();f.close();}
});
test('memory disable/withdrawal clears private candidates and never reimports old interests',async()=>{
 const f=fixture(),r=f.create();try{
  await r.tick();f.advance(3600);f.setItems([f.event()]);f.setDecision(()=>{f.settings.enabled=false;return {};});await r.tick();assert.equal(f.messages().length,0);
  await r.tick();assert.equal(f.db.prepare('SELECT COUNT(*) n FROM dots_discovery_interests WHERE active=1').get().n,0);
  f.settings.enabled=true;f.settings.generation++;await r.tick();assert.equal(f.messages().length,0);
 }finally{r.close();f.close();}
});
test('empty supported interests cause no network requests or invented tasks',async()=>{
 const f=fixture(),r=f.create({assess:async()=>({interests:[]})});try{await r.tick();f.advance(86400);await r.tick();assert.equal(f.fetches,0);assert.equal(f.messages().length,0);assert.equal(f.counts().tasks,0);}finally{r.close();f.close();}
});
test('one recitation request cannot become a lasting interest even if the model claims it is one',async()=>{
 const f=fixture();f.db.prepare('UPDATE manager_messages SET content=? WHERE id=?').run('你会背出师表吗',f.user.id);
 const r=f.create({assess:async()=>({interests:[{public_query:'出师表',source_message_id:f.user.id,quote:'你会背出师表吗',ongoing_interest:true,public_subject:true,supporting_quotes:[]}]})});
 try{await r.tick();assert.equal(f.fetches,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM dots_discovery_interests WHERE active=1').get().n,0);}finally{r.close();f.close();}
});
test('inferred interests require another authentic supporting occasion, not a fabricated citation',async t=>{
 for(const forged of [false,true])await t.test(String(forged),async()=>{
  const f=fixture(),first='今天有哪些值得了解的国际热点新闻',second='再看看这几天的国际社会热点有什么变化';
  f.db.prepare('UPDATE manager_messages SET content=? WHERE id=?').run(first,f.user.id);
  const other=f.store.message({message:second,requestId:'another-occasion'}).message;f.store.completeManager(f.store.claimManager(),ordinary);
  const r=f.create({assess:async()=>({interests:[{public_query:'国际热点新闻',source_message_id:f.user.id,quote:first,ongoing_interest:true,public_subject:true,supporting_quotes:[{source_message_id:forged?99999:other.id,quote:second}]}]})});
  try{await r.tick();assert.equal(f.fetches,forged?0:1);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM dots_discovery_interests WHERE active=1').get().n,forged?0:1);}finally{r.close();f.close();}
 });
});
test('a burst of source updates is considered together and only the selected update is shared',async()=>{
 const f=fixture(),r=f.create();try{
  await r.tick();f.advance(3600);f.setItems([f.event('one','韦布望远镜公布一组新图像'),f.event('two','韦布望远镜发现星系新结构')]);
  f.setDecision({selected_event_key:'two',action:'send',message:'NASA 公布了韦布望远镜发现星系新结构的观测，与你一直关注的星系研究有关。',reason:'这批观测中星系结构更新更有实质内容',interest_quote:quote,event_quote:'韦布望远镜发现星系新结构',relevant:true,novel:true,appropriate:true});
  await r.tick();assert.equal(f.messages().length,1);assert.match(f.messages()[0].content,/articles\/two/);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM dots_discovery_updates WHERE state='pending'").get().n,0);
  const calls=f.calls;await r.tick();assert.equal(f.calls,calls);assert.equal(f.messages().length,1);
 }finally{r.close();f.close();}
});
test('RSS parsing is bounded, rejects entities/local links, and preserves publisher/date evidence',async()=>{
 const xml='<rss><channel><item><title><![CDATA[Webb &amp; galaxies]]></title><link>https://news.google.com/rss/articles/abc</link><guid>abc</guid><pubDate>Sun, 18 Oct 2026 09:00:00 GMT</pubDate><description><![CDATA[<a href="https://example.org">Observed &amp; published</a>]]></description><source url="https://example.org">NASA</source></item></channel></rss>';
 const result=parseNewsFeed(xml);assert.equal(result.length,1);assert.equal(result[0].title,'Webb & galaxies');assert.equal(result[0].summary,'Observed & published');assert.equal(result[0].publisher,'NASA');
 assert.throws(()=>parseNewsFeed('<!DOCTYPE rss>'+xml));assert.equal(parseNewsFeed(xml.replace('https://news.google.com/rss/articles/abc','http://127.0.0.1/secret')).length,0);assert.throws(()=>parseNewsFeed(xml+' '.repeat(512*1024)));
 const requests=[];await readPublicNews('韦布望远镜',{fetchImpl:async(url,options)=>{requests.push({url,options});return new Response(xml);}});assert.equal(requests[0].url,newsUrl('韦布望远镜'));assert.equal(requests[0].options.redirect,'error');
});
