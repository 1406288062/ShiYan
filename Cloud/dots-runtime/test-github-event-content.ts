import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {formatGithubEvent} from './github-event-content.ts';
import {createAppSubscriptions} from './app-subscriptions.ts';
import {createGithubChangeSummarizer} from './github-change-summary.ts';
const repository='owner/repo',before='a'.repeat(40),head='b'.repeat(40);
const commit=(n: any,message='改善知识检索')=>({sha:n.toString(16).padStart(40,'0'),commit:{message}});
const push=(payload={})=>({id:'new',type:'PushEvent',repo:{name:repository},actor:{login:'yu'},payload:{ref:'refs/heads/main',before,head,...payload}});
const file=(filename: any,additions=5,deletions=2,status='modified')=>({filename,additions,deletions,status});
const run=async(event: any,load: any,extra={})=>(await formatGithubEvent(event,{repository,load,summarize:async({commits=[],description,title}: any)=>({text:commits.length?commits.map((c: any)=>c.commit?.message||c.message).join('；'):description||title||'已更新相关功能。'}),...extra}))!;
const compare=(commits: any[]=[commit(1)],files: any[]=[file('src/search.js')],total=commits.length)=>({commits,files,total_commits:total,status:'ahead'});

test('one unsupported summary point does not discard other independently verified points',async()=>{
 const summarize=createGithubChangeSummarizer({logger:{warn(){}} as any,assess:async()=>({changes:[{text:'修复登录状态恢复。',evidence_quotes:['Fix login restoration']},{text:'增加语音功能。',evidence_quotes:['invented evidence']}]})});
 const result=await summarize({commits:[commit(1,'Fix login restoration')]});assert.equal(result!.text,'修复登录状态恢复。');assert.equal(result!.partial,true);
});

test('failed summaries survive restart, back off and refresh the original notification once',async t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());let clock=1000,available=false,calls=0,updates=0,publishes=0;
 db.exec(`CREATE TABLE manager_messages(id INTEGER PRIMARY KEY,manager_id TEXT,content TEXT,revision INTEGER DEFAULT 1);CREATE TABLE dots_app_events(manager_id TEXT,source TEXT,event_key TEXT,message_id INTEGER,PRIMARY KEY(manager_id,source,event_key));`);
 const content='GitHub · owner/repo\n分支 / 标签：main\n改动摘要：暂未生成，可通过下方链接查看详情。\n代码总计：新增 5 行，删除 2 行\nhttps://github.com/owner/repo/compare/'+before+'...'+head;
 db.prepare('INSERT INTO manager_messages(id,manager_id,content) VALUES(240,?,?)').run('manager:fixture',content);
 db.prepare('INSERT INTO dots_app_events VALUES(?,?,?,240)').run('manager:fixture','github:'+repository,'push:refs/heads/main:'+head);
 const store={db,managerId:'manager:fixture',transaction:(fn: any)=>fn(),publishAppEvent:()=>{publishes++;throw Error('duplicate');},refreshAppEvent:({content}: any)=>{updates++;db.prepare('UPDATE manager_messages SET content=?,revision=revision+1 WHERE id=240').run(content);return {id:240};}};
 const options={store,dataDir:'/fixture',now:()=>clock,loadConfig:async (p: any)=>p.endsWith('github-events.json')?{repository}:null,githubToken:async()=>'fixture',logger:{warn(){}} as any,fetchImpl:async (raw: any)=>{const url=new URL(raw);if(url.pathname.endsWith('/events'))return new Response(null,{status:304});if(url.pathname.endsWith('/actions/runs'))return Response.json({workflow_runs:[]});if(url.pathname.includes('/compare/'))return Response.json(compare());throw Error('unused');},summarizeGithub:async()=>{calls++;return available?{text:'改善知识检索。'}:null;}};
 let subscription=createAppSubscriptions(options as any);await subscription.tick();
 let job=db.prepare('SELECT * FROM dots_github_summary_jobs').get();assert.equal(job!.attempts,1);assert.ok(Number(job!.retry_at)>clock);assert.equal(updates,0);subscription.close();
 subscription=createAppSubscriptions(options as any);await subscription.tick();assert.equal(calls,1);
 clock=Number(job!.retry_at)+1;available=true;await Promise.all([subscription.tick(),subscription.tick()]);
 assert.equal(updates,1);assert.equal(publishes,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM dots_github_summary_jobs').get()?.n,0);
 const message=db.prepare('SELECT * FROM manager_messages WHERE id=240').get();assert.equal(message!.revision,2);assert.match(String(message!.content),/改善知识检索/);assert.doesNotMatch(String(message!.content),/暂未生成/);
 await subscription.tick();assert.equal(updates,1);subscription.close();
});

test('modern slim PushEvent reads real net diff, operations, total lines and change prose without file details',async()=>{
 const paths: string[]=[];const result=await run(push(),async (path: any)=>{paths.push(path);return compare([commit(1,'修复知识库同步\nmore'),commit(2,'增加单元测试')],[file('src/sync.js',12,3),file('test/sync.js',20,0,'added')]);});
 assert.equal(paths.length,1);assert.match(result.content,/具体操作：推送代码/);assert.doesNotMatch(result.content,/改动文件|主要文件|涉及范围|sync\.js/);assert.match(result.content,/代码总计：新增 32 行，删除 3 行（本次推送净变更）/);assert.match(result.content,/修复知识库同步/);assert.match(result.content,/操作人：yu/);assert.ok(result.content.indexOf('改动摘要')<result.content.indexOf('代码总计'));
});
test('large push paginates compare commits and commit files, deduplicating touched filenames',async()=>{
 const commits=Array.from({length:101},(_,n)=>commit(n+1,'提交 '+n));let comparePages=0,commitPages=0;
 const result=await run(push(),async (path: any)=>{
  if(path.startsWith('/compare/')){comparePages++;return compare(comparePages===1?commits.slice(0,100):commits.slice(100),Array.from({length:300},(_,n)=>file('truncated'+n)),101);}
  commitPages++;const id=parseInt(path.split('/')[2].split('?')[0],16),page=Number(new URL('https://fixture'+path).searchParams.get('page'));
  if(id===1&&page===1)return {stats:{additions:100,deletions:0},files:Array.from({length:100},(_,n)=>file('unique'+n,1,0))};
  if(id===1)return {stats:{additions:100,deletions:0},files:[file('last',0,0)]};
  return {stats:{additions:2,deletions:1},files:[file('shared.js',2,1)]};
 },{maxRequests:150});
 assert.equal(comparePages,2);assert.equal(commitPages,102);assert.doesNotMatch(result.content,/主要文件|改动文件|shared\.js/);assert.match(result.content,/代码总计：新增 300 行，删除 100 行（按提交累计，含多次修改）/);
});
test('request budget labels partial files and unknown totals, never presents truncated compare as complete',async()=>{
 const result=await run(push(),async (path: any)=>path.startsWith('/compare/')?compare([commit(1),commit(2)],Array.from({length:300},(_,n)=>file('partial'+n))):{stats:{additions:1,deletions:1},files:[file('seen.js',1,1)]},{maxRequests:2});
 assert.doesNotMatch(result.content,/partial0|seen\.js|主要文件|改动文件/);assert.match(result.content,/代码总计：暂未获取完整增减统计/);assert.match(result.content,/详情获取已达本轮上限/);assert.doesNotMatch(result.content,/改动文件：300 个/);
});
test('unknown payload, inaccessible compare, network error and missing stats never become zero',async()=>{
 for(const payload of [{before:undefined,head:undefined},{}]){
  const result=await run(push(payload),async()=>{throw Object.assign(Error('http_403'),{status:403});});
  assert.match(result.content,/未获取/);assert.doesNotMatch(result.content,/新增：0|删除：0|改动文件：0/);
 }
 const result=await run(push(),async()=>({commits:[commit(1)],total_commits:1}));
 assert.match(result.content,/暂未获取完整增减统计/);assert.doesNotMatch(result.content,/新增：0|删除：0|改动文件：0/);
});
test('new branch or inaccessible old commit uses head only as summary evidence and never substitutes its statistics for whole push',async()=>{
 for(const beforeValue of ['0'.repeat(40),before]){
  const result=await run(push({before:beforeValue}),async (path: any)=>{
   if(path.startsWith('/compare/'))throw Object.assign(Error('http_404'),{status:404});
   return {commit:{message:'初始构建'},stats:{additions:80,deletions:2},files:[file('src/app.js')]};
  });
  assert.match(result.content,/未获取整次推送的完整增减统计/);assert.doesNotMatch(result.content,/新增 80 行|src\/app\.js/);assert.match(result.content,/仅最近提交/);
 }
});
test('deleting reference has no code stats request; confirmed empty diff can show zero',async()=>{
 const deleted=await run(push({head:'0'.repeat(40)}),async()=>{throw Error('unexpected fetch');});
 assert.match(deleted.content,/删除分支或标签/);assert.match(deleted.content,/不适用（删除引用）/);
 const empty=await run(push(),async()=>compare([],[],0));assert.match(empty.content,/代码总计：新增 0 行，删除 0 行/);
});
test('non-fast-forward history is identified and duplicate compare pages do not claim completeness',async()=>{
 const result=await run(push(),async()=>({...compare(),status:'diverged'}));assert.match(result.content,/提交历史非快进/);
 const partial=await run(push(),async()=>compare([commit(1)],[file('net.js',2,1)],2));
 assert.match(partial.content,/部分提交/);assert.match(partial.content,/本次推送净变更/);
});
test('PR operations are translated and statistics explicitly describe current PR; comments/releases show actual content',async()=>{
 const pr=await run({id:'pr',type:'PullRequestEvent',actor:{login:'yu'},payload:{action:'closed',number:4}},async()=>({title:'修复登录',merged:true,changed_files:3,additions:24,deletions:7,body:'恢复扫码登录，去除重复入口',head:{ref:'fix-login'},base:{ref:'main'},html_url:'https://github.com/owner/repo/pull/4'}));
 assert.match(pr.content,/具体操作：合并 PR/);assert.doesNotMatch(pr.content,/改动文件|主要文件/);assert.match(pr.content,/代码总计：新增 24 行，删除 7 行（当前 PR）/);assert.match(pr.content,/恢复扫码登录/);
 const comment=await run({id:'c',type:'IssueCommentEvent',payload:{action:'created',issue:{number:3,title:'同步'},comment:{body:'已找到重复加载原因',html_url:'https://github.com/owner/repo/issues/3#comment'}}},async()=>{throw Error('unexpected fetch');});
 assert.match(comment.content,/评论内容：已找到重复加载原因/);assert.doesNotMatch(comment.content,/新增：0/);
 const release=await run({id:'r',type:'ReleaseEvent',payload:{action:'published',release:{name:'v1',body:'新增事件订阅详情'}}},async()=>{});assert.match(release.content,/具体操作：发布 版本/);assert.match(release.content,/新增事件订阅详情/);
});
test('untrusted summary text remains escaped and notification remains inside storage limit',async()=>{
 const result=await run(push(),async()=>compare(Array.from({length:10},(_,n)=>commit(n+1,'# hi <script> [link](url) '+ 'x'.repeat(1000))),Array.from({length:10},(_,n)=>file('src/'+n+'x'.repeat(1000),100,100))));
 assert.ok(result.content.length<6000);assert.match(result.content,/\\<script\\>/);assert.doesNotMatch(result.content,/<script>/);
});
test('subscription baseline, replay suppression, enrichment and ETag path never publish duplicate notifications',async t=>{
 const db=new DatabaseSync(':memory:'),published: any[]=[],calls: string[]=[];t.after(()=>db.close());
 let newest=push({head:'c'.repeat(40)}),baseline=true,unchanged=false,summaryCalls=0;
 const store={db,managerId:'manager:fixture',transaction:(fn: any)=>fn(),publishAppEvent:(event: any)=>{published.push(event);return {id:published.length};}};
 const fetchImpl=async(raw: any,options: any)=>{
  const url=new URL(raw);calls.push(url.pathname);
  if(url.pathname.endsWith('/events')){if(unchanged){assert.equal(options.headers['If-None-Match'],'fixture-etag');return new Response(null,{status:304});}return Response.json(baseline?[{...push(),id:'old'}]:[newest,{...push(),id:'old'}],{headers:{etag:'fixture-etag'}});}
  if(url.pathname.endsWith('/actions/runs'))return Response.json({workflow_runs:[]});
  if(url.pathname.includes('/compare/'))return Response.json(compare());
  throw Error('unexpected url '+raw);
 };
 const subscription=createAppSubscriptions({store,dataDir:'/fixture',fetchImpl,summarizeGithub:async()=>{summaryCalls++;return {text:'改善知识检索的更新行为。'};},loadConfig:async (path: any)=>path.endsWith('github-events.json')?{repository}:null,githubToken:async()=>'fixture',logger:{warn(){}} as any});t.after(()=>subscription.close());
 await subscription.tick();assert.equal(published.length,0);assert.equal(calls.filter(p=>p.includes('/compare/')).length,0);
 baseline=false;await subscription.tick();assert.equal(published.length,1);assert.match(published[0].content,/代码总计：新增 5 行，删除 2 行/);
 await subscription.tick();assert.equal(published.length,1);assert.equal(calls.filter(p=>p.includes('/compare/')).length,1);
 unchanged=true;await subscription.tick();assert.equal(published.length,1);
 assert.equal(summaryCalls,1);assert.match(published[0].content,/改善知识检索/);assert.equal(subscription.health().find(row=>row.provider==='github').status,'listening');
});


test('summary failure stays explicit and never falls back to filenames or raw English titles',async()=>{
 const result=await run(push(),async()=>compare([commit(1,'Sync Dots voice and Mac/iOS experience')],[file('Mac/secret.js',9,2)]),{summarize:async()=>{throw Error('offline');}});
 assert.match(result.content,/改动摘要：暂未生成/);assert.match(result.content,/代码总计：新增 9 行，删除 2 行/);assert.doesNotMatch(result.content,/secret|Sync Dots|主要文件|改动文件/);
});


test('Chinese content summary uses actual bounded patch evidence and never renders paths',async()=>{
 let input;const summarize=createGithubChangeSummarizer({assess:async(data)=>{input=JSON.parse(data);return {changes:[{text:'恢复扫码登录，并移除重复入口。',evidence_quotes:['useQRCodeLogin']}]};}});
 const files=[{...file('Mac/login.js',10,2),patch:'- usePasswordLogin();\n+ useQRCodeLogin();'}];
 const result=await run(push(),async()=>compare([commit(1,'Fix login flow')],files),{summarize});
 assert.match(result.content,/恢复扫码登录，并移除重复入口/);assert.match(result.content,/代码总计：新增 10 行，删除 2 行/);
 assert.doesNotMatch(result.content,/login\.js|Fix login flow|主要文件|涉及范围|改动文件/);
 assert.equal(input!.operation,'summarize_github_changes');assert.match(input!.evidence.diffs[0].patch,/useQRCodeLogin/);
});
test('invalid, ungrounded, English-only or path-centric model output degrades explicitly',async()=>{
 for(const change of [
  {text:'实现登录功能。',evidence_quotes:['not present']},
  {text:'Fix login flow',evidence_quotes:['Fix login']},
  {text:'修改 login.js 完成登录。',evidence_quotes:['Fix login']},
  {text:'新增 50 行。',evidence_quotes:['Fix login']}
 ]){
  const summarize=createGithubChangeSummarizer({assess:async()=>({changes:[change]})});
  const result=await run(push(),async()=>compare([commit(1,'Fix login')],[file('src/login.js')]),{summarize});
  assert.match(result.content,/改动摘要：暂未生成/);assert.doesNotMatch(result.content,/src\/login|实现登录功能/);
 }
});
test('large evidence is bounded and partial scope is exposed without file lists',async()=>{
 let seen;const summarize=createGithubChangeSummarizer({assess:async(data)=>{seen=JSON.parse(data);return {changes:[{text:'调整登录流程。',evidence_quotes:['Fix login']}]};}});
 const result=await summarize({commits:Array.from({length:50},()=>commit(1,'Fix login '+ 'x'.repeat(3000))),files:Array.from({length:100},(_,n)=>({...file('src/'+n+'.js'),patch:'p'.repeat(10000)}))});
 assert.ok(result!.partial);assert.ok(Buffer.byteLength(JSON.stringify(seen))<128*1024);assert.ok(seen!.evidence.diffs.length<=16);assert.ok(seen!.evidence.commits.length<=20);
 const unavailable=createGithubChangeSummarizer({assess:async()=>{throw Error('timeout');}});assert.equal(await unavailable({commits:[commit(1)]}),null);
});

test('quoted evidence tolerates diff comment wrapping but not invented content',async()=>{
 const summarize=createGithubChangeSummarizer({assess:async()=>({changes:[{text:'结束通话后释放播放资源。',evidence_quotes:['ending the call tears it down immediately']}]})});
 const result=await summarize({files:[{...file('voice.swift'),patch:'+/// ending\n+/// the call tears it down immediately'}]});assert.equal(result!.text,'结束通话后释放播放资源。');
});

test('branch head detects a push before Events API and delayed event does not notify twice',async t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());const published: any[]=[];
 let head='a'.repeat(40),late=false;
 const store={db,managerId:'fallback',transaction:(fn: any)=>fn(),publishAppEvent:(e: any)=>{published.push(e);return {id:published.length};}};
 const fetchImpl=async (raw: any)=>{const path=new URL(raw).pathname;
  if(path.endsWith('/events'))return Response.json(late?[{id:'late',type:'PushEvent',payload:{ref:'refs/heads/main',before:'a'.repeat(40),head}}]:[]);
  if(path.endsWith('/actions/runs'))return Response.json({workflow_runs:[]});
  if(path.endsWith('/git/ref/heads/main'))return Response.json({object:{sha:head}});
  if(path.includes('/compare/'))return Response.json(compare());
  return Response.json({default_branch:'main',owner:{login:'fixture'}});
 };
 const sub=createAppSubscriptions({store,dataDir:'/fixture',fetchImpl,githubToken:async()=>'fixture',loadConfig:async (p: any)=>p.endsWith('github-events.json')?{repository}:null,summarizeGithub:async()=>({text:'调整登录布局。'}),logger:{warn(){}} as any});t.after(()=>sub.close());
 await sub.tick();assert.equal(published.length,0);
 head='b'.repeat(40);await sub.tick();assert.equal(published.length,1);assert.match(published[0].content,/调整登录布局/);
 late=true;await sub.tick();await sub.tick();assert.equal(published.length,1);
});
