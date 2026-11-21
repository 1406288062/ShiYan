import {formatGithubEvent,isGithubEventSupported} from './github-event-content.ts';
import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const text=v=>String(v??'').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,' ').slice(0,800).replace(/[\\`*_{}\[\]()<>!|]/g,'\\$&');
export async function readSubscriptionConfig(file){
 let f;try{f=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);}catch(e){if((e as any).code==='ENOENT')return null;throw Error('config_unreadable');}
 try{const s=await f.stat();if(!s.isFile()||(s.mode&0o077)||s.uid!==process.getuid!()||s.size>16384)throw Error('config_permissions');const v=JSON.parse(await f.readFile('utf8'));return v.enabled===false?null:v;}finally{await f.close();}
}
export interface AppSubscriptionsOptions {
  store: any;
  dataDir: string;
  fetchImpl?: any;
  summarizeGithub?: ((input: any, control?: any) => Promise<any>) | null;
  loadConfig?: any;
  githubToken?: () => Promise<string>;
  now?: () => number;
  intervalMs?: number;
  cycleTimeoutMs?: number;
  logger?: Console;
}
export function createAppSubscriptions({store,dataDir,fetchImpl=fetch,summarizeGithub=null,loadConfig=readSubscriptionConfig,githubToken=async()=>{const r=await exec('/usr/bin/gh',['auth','token','--hostname','github.com'],{timeout:10000,maxBuffer:8192});return r.stdout.trim();},now=()=>Math.floor(Date.now()/1000),intervalMs=60000,cycleTimeoutMs=90000,logger=console}: AppSubscriptionsOptions){
 const {db,managerId}=store;let stopped=false,timer;const lanes=new Map(),tokens=new Map();
 if(!Number.isFinite(intervalMs)||intervalMs<1000||!Number.isFinite(cycleTimeoutMs)||cycleTimeoutMs<1000)throw Error('invalid_subscription_options');
 db.exec(`CREATE TABLE IF NOT EXISTS dots_app_sources(manager_id TEXT,source TEXT,cursor TEXT,status TEXT,error_code TEXT,updated_at INTEGER,PRIMARY KEY(manager_id,source));CREATE TABLE IF NOT EXISTS dots_app_events(manager_id TEXT,source TEXT,event_key TEXT,message_id INTEGER,PRIMARY KEY(manager_id,source,event_key));`);
 db.exec(`CREATE TABLE IF NOT EXISTS dots_app_health(manager_id TEXT,provider TEXT,failures INTEGER NOT NULL DEFAULT 0,retry_at INTEGER NOT NULL DEFAULT 0,last_success INTEGER,last_duration_ms INTEGER NOT NULL DEFAULT 0,checks INTEGER NOT NULL DEFAULT 0,status TEXT,error_code TEXT,PRIMARY KEY(manager_id,provider));`);
 db.exec(`CREATE TABLE IF NOT EXISTS dots_github_summary_jobs(manager_id TEXT,source TEXT,event_key TEXT,event_json TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,retry_at INTEGER NOT NULL DEFAULT 0,error_code TEXT NOT NULL DEFAULT '',PRIMARY KEY(manager_id,source,event_key));`);
 // Recover older delivered push notifications whose failed summaries had no retry receipt.
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='manager_messages'").get()){
  const rows=db.prepare("SELECT e.source,e.event_key,m.content FROM dots_app_events e JOIN manager_messages m ON m.id=e.message_id AND m.manager_id=e.manager_id WHERE e.manager_id=? AND e.source LIKE 'github:%' AND m.content LIKE '%改动摘要：暂未生成%' ORDER BY m.id DESC LIMIT 100").all(managerId);
  for(const row of rows){
   const repository=row.source.slice(7),match=row.content.match(/https:\/\/github\.com\/([^\s]+)\/compare\/([a-f0-9]{40})\.\.\.([a-f0-9]{40})/i);
   if(!match||match[1]!==repository)continue;
   const event={id:row.event_key,type:'PushEvent',actor:{login:repository.split('/')[0]},payload:{before:match[2],head:match[3],ref:'refs/heads/'+(row.content.match(/分支 \/ 标签：([^\n]+)/)?.[1]||'main')}};
   db.prepare('INSERT OR IGNORE INTO dots_github_summary_jobs(manager_id,source,event_key,event_json,retry_at,error_code) VALUES(?,?,?,?,?,?)').run(managerId,row.source,row.event_key,JSON.stringify(event),now(),'legacy_summary_unavailable');
  }
 }
 const state=s=>db.prepare('SELECT * FROM dots_app_sources WHERE manager_id=? AND source=?').get(managerId,s);
 const status=(s,v,e='')=>db.prepare('INSERT INTO dots_app_sources(manager_id,source,status,error_code,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(manager_id,source) DO UPDATE SET status=excluded.status,error_code=excluded.error_code,updated_at=excluded.updated_at').run(managerId,s,v,e,now());
 async function request(url,options={},signal){
  const r=await fetchImpl(url,{...options,redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(20000)])});
  if(r.status===304)return {unchanged:true};
  if(!r.ok)throw Object.assign(Error('http_'+r.status),{status:r.status,retryAfter:r.headers.get('retry-after'),rateReset:r.headers.get('x-ratelimit-reset'),rateRemaining:r.headers.get('x-ratelimit-remaining')});
  const reader=r.body?.getReader();let raw='';if(reader){const chunks: Buffer[]=[];let size=0;for(;;){const x=await reader.read();if(x.done)break;size+=x.value.length;if(size>4*1024*1024){await reader.cancel();throw Error('response_too_large');}chunks.push(Buffer.from(x.value));}raw=Buffer.concat(chunks).toString('utf8');}else raw=await r.text();
  return {data:JSON.parse(raw),etag:r.headers.get('etag')};
 }
 function commit(source,cursor,events,baseline=false,signal){
  if(stopped||signal.aborted)return;
  store.transaction(()=>{
   for(const event of events){
    if(db.prepare('SELECT 1 FROM dots_app_events WHERE manager_id=? AND source=? AND event_key=?').get(managerId,source,event.key))continue;
    db.prepare('INSERT INTO dots_app_events(manager_id,source,event_key) VALUES(?,?,?)').run(managerId,source,event.key);
    if(!baseline&&event.content){const content=event.summaryPending?event.content.replace('改动摘要：暂未生成，可通过下方链接查看详情。','改动摘要：生成未完成，正在自动重试。'):event.content;const message=store.publishAppEvent({source,eventKey:event.key,content});db.prepare('UPDATE dots_app_events SET message_id=? WHERE manager_id=? AND source=? AND event_key=?').run(message.id,managerId,source,event.key);
     if(event.summaryPending&&event.retryEvent)db.prepare('INSERT OR IGNORE INTO dots_github_summary_jobs(manager_id,source,event_key,event_json,retry_at,error_code) VALUES(?,?,?,?,?,?)').run(managerId,source,event.key,JSON.stringify(event.retryEvent),now()+60,'initial_summary_unavailable');
    }
   }
   db.prepare("INSERT INTO dots_app_sources(manager_id,source,cursor,status,error_code,updated_at) VALUES(?,?,?,'listening','',?) ON CONFLICT(manager_id,source) DO UPDATE SET cursor=excluded.cursor,status='listening',error_code='',updated_at=excluded.updated_at").run(managerId,source,JSON.stringify(cursor),now());
  });
 }
 async function github(signal){
  const cfg=await loadConfig(dataDir+'/github-events.json');if(!cfg){status('github','waiting_configuration');return 'waiting_configuration';}
  if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(cfg.repository))throw Error('github_config_invalid');
  const source='github:'+cfg.repository,prior=state(source),cursor=prior?.cursor?JSON.parse(prior.cursor):null;
  if(cursor?.retryAt>now())throw Object.assign(Error('github_backoff'),{retryAt:cursor.retryAt});
  const token=await githubToken();if(!token)throw Error('github_auth_missing');
  const headers={Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'ShiYan-Dots'};
  const observed: any[]=[],events: any[]=[],next={...cursor},base='https://api.github.com/repos/'+cfg.repository;
  // Keep enrichment bounded independently of event-list fetching. Failure to read
  // details publishes an accurate unavailable/partial label, never a made-up zero.
  const detailSignal=AbortSignal.any([signal,AbortSignal.timeout(55000)]),details=new Map();
  const load=path=>{if(!details.has(path))details.set(path,request(base+path,{headers},detailSignal).then(r=>r.data));return details.get(path);};
  for(const [kind,path] of [['events','/events'],['runs','/actions/runs']]){
   let page=1,matched=false;
   do{
    const h={...headers};if(page===1&&cursor?.[kind+'Etag'])h['If-None-Match']=cursor[kind+'Etag'];
    const result=await request(base+path+'?per_page=100&page='+page,{headers:h},signal);
    if(result.unchanged){matched=true;break;}
    if(page===1)next[kind+'Etag']=result.etag;
    const rows=kind==='events'?result.data:result.data.workflow_runs;if(!Array.isArray(rows))throw Error('github_payload_invalid');
    if(kind==='events')observed.push(...rows);
    for(const row of rows){
     if(kind==='events'){
      if(cursor?.eventHead===row.id){matched=true;break;}
      if(!isGithubEventSupported(row))continue;
      const head=row.payload?.head||row.payload?.after;
      const key=row.type==='PushEvent'&&/^[a-f0-9]{40,64}$/i.test(head||'')?'push:'+row.payload.ref+':'+head:'event:'+row.id;
      // Baseline and durable receipts suppress old-event detail requests as well
      // as old notifications, including events found again on later pages.
      const known=db.prepare('SELECT 1 FROM dots_app_events WHERE manager_id=? AND source=? AND event_key=?').get(managerId,source,key);
      const e=!cursor||known?{key,content:''}:await formatGithubEvent(row,{repository:cfg.repository,load,summarize:async input=>summarizeGithub?.(input,{signal:detailSignal})});
      if(e)events.push({...e,key,retryEvent:row});
     }
     else if(row.status==='completed')events.push({key:`run:${row.id}:${row.run_attempt}:${row.conclusion}`,content:`GitHub · ${text(cfg.repository)}\n\n构建：${text(row.name)}\n结果：${text(row.conclusion)}\n分支：${text(row.head_branch)}\n${/^https:\/\/github\.com\//.test(row.html_url||'')?row.html_url:''}`});
    }
    if(page===1&&kind==='events'&&rows[0])next.eventHead=rows[0].id;
    if(rows.length<100||!cursor||kind==='runs')matched=true;
    if(!matched&&page>=10)throw Error('github_backlog_exceeds_limit');
    page++;
   }while(!matched);
  }
  // Repository events can lag a successful push. Verify the default branch
  // independently and use the same durable key when the delayed event arrives.
  try {
   const repo=await load('');const branch=repo.default_branch;
   if(typeof branch!=='string'||!branch)throw Error('github_default_branch_missing');
   const ref='refs/heads/'+branch,current=await load('/git/ref/heads/'+encodeURIComponent(branch));
   const head=current.object?.sha;if(!/^[a-f0-9]{40,64}$/i.test(head||''))throw Error('github_head_invalid');
   let before=cursor?.branchName===branch?cursor.branchHead:null;
   if(!before&&cursor){
    const known=observed.filter(e=>e.type==='PushEvent'&&e.payload?.ref===ref&&db.prepare('SELECT 1 FROM dots_app_events WHERE manager_id=? AND source=? AND event_key=?').get(managerId,source,'event:'+e.id)).sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at));
    before=known[0]?.payload?.head;
   }
   const key='push:'+ref+':'+head;
   if(before&&before!==head&&!events.some(e=>e.key===key)&&!db.prepare('SELECT 1 FROM dots_app_events WHERE manager_id=? AND source=? AND event_key=?').get(managerId,source,key)){
    const e=await formatGithubEvent({id:'head:'+head,type:'PushEvent',actor:{login:repo.owner?.login},payload:{before,head,ref}},{repository:cfg.repository,load,summarize:async input=>summarizeGithub?.(input,{signal:detailSignal})});
    events.push({...e,key,retryEvent:{id:'head:'+head,type:'PushEvent',actor:{login:repo.owner?.login},payload:{before,head,ref}}});
   }
   next.branchName=branch;next.branchHead=head;
  }catch(error){logger.warn?.('[app-subscription] branch head check unavailable');}
  if(hash(await loadConfig(dataDir+'/github-events.json'))!==hash(cfg))return;
  commit(source,next,events.reverse(),!cursor,signal);return 'listening';
 }
 async function retryGithubSummary(signal){
  if(!summarizeGithub||!store.refreshAppEvent)return 'unavailable';
  const cfg=await loadConfig(dataDir+'/github-events.json');if(!cfg||!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(cfg.repository))return 'waiting_configuration';
  const source='github:'+cfg.repository;
  const job=db.prepare('SELECT * FROM dots_github_summary_jobs WHERE manager_id=? AND source=? AND retry_at<=? ORDER BY retry_at LIMIT 1').get(managerId,source,now());
  if(!job)return 'listening';
  try{
   const token=await githubToken();if(!token)throw Error('github_auth_missing');
   const result=await formatGithubEvent(JSON.parse(job.event_json),{repository:cfg.repository,load:async path=>(await request('https://api.github.com/repos/'+cfg.repository+path,{headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','User-Agent':'ShiYan-Dots'}},signal)).data,summarize:input=>summarizeGithub(input,{signal})});
   if(stopped||signal.aborted)return 'interrupted';
   if(!result||result.summaryPending)throw Error('github_summary_unavailable');
   if(hash(await loadConfig(dataDir+'/github-events.json'))!==hash(cfg))return 'configuration_changed';
   store.transaction(()=>{store.refreshAppEvent({source,eventKey:job.event_key,content:result.content});db.prepare('DELETE FROM dots_github_summary_jobs WHERE manager_id=? AND source=? AND event_key=?').run(managerId,source,job.event_key);});
  }catch(error){
   if(stopped)return 'interrupted';
   const attempts=job.attempts+1,delay=Math.min(21600,60*2**Math.min(attempts,9));
   const code=signal.aborted?'summary_deadline':/^http_\d+$/.test((error as any).message)?(error as any).message:'github_summary_unavailable';
   db.prepare('UPDATE dots_github_summary_jobs SET attempts=?,retry_at=?,error_code=? WHERE manager_id=? AND source=? AND event_key=?').run(attempts,now()+delay,code,managerId,source,job.event_key);
   logger.warn?.('[github-summary-retry] '+code+' attempt='+attempts);
  }
  return 'listening';
 }
 async function calendar(signal){
  const cfg=await loadConfig(dataDir+'/google-calendar.json');if(!cfg){tokens.clear();status('google-calendar','waiting_authorization');return 'waiting_authorization';}
  if(!cfg.clientId||!cfg.clientSecret||!cfg.refreshToken)throw Error('calendar_authorization_missing');
  const account=cfg.accountKey||hash(cfg.refreshToken).slice(0,16),calendarId=cfg.calendarId||'primary',source='calendar:'+account+':'+calendarId;
  const prior=state(source),cursor=prior?.cursor?JSON.parse(prior.cursor):null;
  const tokenKey=hash([cfg.clientId,cfg.clientSecret,cfg.refreshToken]);let auth=tokens.get(tokenKey);
  if(!auth||auth.expiresAt<=now()+60){
   const result=await request('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:cfg.clientId,client_secret:cfg.clientSecret,refresh_token:cfg.refreshToken,grant_type:'refresh_token'})},signal);
   if(typeof result.data.access_token!=='string'||!result.data.access_token)throw Error('calendar_authorization_failed');
   auth={accessToken:result.data.access_token,expiresAt:now()+Math.max(0,Math.min(3600,Number(result.data.expires_in)||0))};
   if(stopped||signal.aborted)return;tokens.clear();tokens.set(tokenKey,auth);
  }
  let pageToken,finalToken,events: any[]=[];
  for(let page=0;page<100;page++){
   const params=new URLSearchParams({maxResults:'2500',showDeleted:'true'});if(cursor?.syncToken)params.set('syncToken',cursor.syncToken);if(pageToken)params.set('pageToken',pageToken);
   let result;try{result=await request('https://www.googleapis.com/calendar/v3/calendars/'+encodeURIComponent(calendarId)+'/events?'+params,{headers:{Authorization:'Bearer '+auth.accessToken}},signal);}catch(e){if((e as any).status===410){db.prepare('UPDATE dots_app_sources SET cursor=NULL,status=?,error_code=? WHERE manager_id=? AND source=?').run('resync_required','expired_sync_token',managerId,source);return 'resync_required';}throw e;}
   for(const e of result.data.items||[]){
    const start=e.start?.dateTime||e.start?.date||'';
    if(start&&Date.parse(start)<now()*1000&&e.status!=='cancelled')continue;
    events.push({key:hash([e.id,e.updated,e.status,e.etag]),content:`谷歌日历 · ${e.status==='cancelled'?'日程取消':'日程更新'}\n\n${text(e.summary||'无标题日程')}\n时间：${text(start||'原日程已取消')}\n${e.location?'地点：'+text(e.location)+'\n':''}${text(e.description||'')}`});
   }
   pageToken=result.data.nextPageToken;finalToken=result.data.nextSyncToken;if(!pageToken)break;if(page===99)throw Error('calendar_backlog_exceeds_limit');
  }
  if(!finalToken)throw Error('calendar_sync_token_missing');
  if(hash(await loadConfig(dataDir+'/google-calendar.json'))!==hash(cfg))return;
  commit(source,{syncToken:finalToken},events,!cursor,signal);return 'listening';
 }
 // RSS / Atom：每 15 分钟检查一次；首次只记基线，之后每个源每轮最多推 5 条新内容。
 let rssCheckedAt=0;
 const unxml=v=>String(v||'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/<[^>]+>/g,' ').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();
 const tag=(block,name)=>{const m=block.match(new RegExp('<'+name+'(?:\\s[^>]*)?>([\\s\\S]*?)</'+name+'>','i'));return m?m[1]:'';};
 function publicFeedURL(raw){
  let u;try{u=new URL(raw);}catch{return null;}
  if(!['http:','https:'].includes(u.protocol)||u.username||u.password)return null;
  const h=u.hostname.toLowerCase();
  if(h==='localhost'||h.endsWith('.local')||h.endsWith('.internal')||/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)||h.includes(':'))return null;
  return u;
 }
 async function fetchFeed(url,signal){
  const r=await fetchImpl(url,{headers:{'User-Agent':'ShiYan-Dots/1.0 (+RSS)',Accept:'application/rss+xml,application/atom+xml,application/xml,text/xml;q=0.9,*/*;q=0.5'},redirect:'follow',signal:AbortSignal.any([signal,AbortSignal.timeout(20000)])});
  if(!r.ok)throw Object.assign(Error('http_'+r.status),{status:r.status});
  if(r.url&&!publicFeedURL(r.url))throw Error('feed_redirect_blocked');
  const raw=(await r.text()).slice(0,3*1024*1024);
  const title=unxml(tag(raw.replace(/<(item|entry)[\s>][\s\S]*$/i,''),'title'))||new URL(url).hostname;
  const blocks=raw.match(/<item[\s>][\s\S]*?<\/item>/gi)||raw.match(/<entry[\s>][\s\S]*?<\/entry>/gi)||[];
  const items=blocks.slice(0,50).map(b=>{const link=unxml(tag(b,'link'))||(b.match(/<link[^>]*href="([^"]+)"/i)?.[1]||'');const id=unxml(tag(b,'guid'))||unxml(tag(b,'id'))||link||unxml(tag(b,'title'));return {id,title:unxml(tag(b,'title'))||'（无标题）',link:/^https?:\/\//.test(link)?link:'',summary:unxml(tag(b,'description')||tag(b,'summary')).slice(0,240)};}).filter(i=>i.id);
  return {title,items};
 }
 async function rss(signal){
  const cfg=await loadConfig(dataDir+'/rss-feeds.json');if(!cfg||!Array.isArray(cfg.feeds)||!cfg.feeds.length){status('rss','waiting_configuration');return 'waiting_configuration';}
  if(now()-rssCheckedAt<900)return 'listening';rssCheckedAt=now();
  let failures=0;
  for(const url of cfg.feeds.slice(0,20)){
   if(!publicFeedURL(url)){failures++;continue;}
   const source='rss:'+hash(url).slice(0,24),prior=state(source);
   try{
    const feed=await fetchFeed(url,signal);
    const events=feed.items.slice(0,prior?5:50).reverse().map(i=>({key:hash(i.id).slice(0,32),content:`RSS · ${text(feed.title)}\n\n${text(i.title)}\n${i.summary?text(i.summary)+'\n':''}${i.link}`}));
    commit(source,{url},events,!prior,signal);
   }catch(error){if(signal.aborted)throw error;failures++;status(source,'backoff',String((error as any).message||'feed_failed').slice(0,60));}
  }
  if(failures&&failures===cfg.feeds.length)throw Error('rss_all_feeds_failed');
  return 'listening';
 }
 const health=provider=>db.prepare('SELECT * FROM dots_app_health WHERE manager_id=? AND provider=?').get(managerId,provider);
 function retryDelay(error,failures){
  const exponential=Math.min(3600,60*2**Math.min(failures-1,6));
  const raw=error.retryAfter,seconds=raw&&Number.isFinite(Number(raw))?Number(raw):raw?(Date.parse(raw)/1000-now()):0;
  const reset=error.rateRemaining==='0'?Number(error.rateReset)-now():0;
  return Math.max(exponential,Math.min(86400,Math.max(0,seconds||0,reset||0)));
 }
 async function runLane(provider,fn){
  if(stopped||lanes.has(provider)||health(provider)?.retry_at>now())return;
  const controller=new AbortController(),deadline=AbortSignal.timeout(cycleTimeoutMs),signal=AbortSignal.any([controller.signal,deadline]);
  lanes.set(provider,controller);const started=performance.now();
  try{
   const result=await fn(signal);if(stopped||signal.aborted)throw Error('subscription_deadline');
   db.prepare(`INSERT INTO dots_app_health(manager_id,provider,failures,retry_at,last_success,last_duration_ms,checks,status,error_code) VALUES(?,?,0,0,?,?,1,?,'') ON CONFLICT(manager_id,provider) DO UPDATE SET failures=0,retry_at=0,last_success=CASE WHEN excluded.status='listening' THEN excluded.last_success ELSE last_success END,last_duration_ms=excluded.last_duration_ms,checks=checks+1,status=excluded.status,error_code=''`).run(managerId,provider,result==='listening'?now():null,Math.round(performance.now()-started),result||'configuration_changed');
  }catch(e){
   if(stopped)return;
   const failures=(health(provider)?.failures||0)+1;
   const code=signal.aborted?'subscription_deadline':/^(http_\d+|[a-z_]+)$/.test((e as any).message)?(e as any).message:'subscription_failed';
   if(provider==='google-calendar'&&((e as any).status===401||(e as any).status===400))tokens.clear();
   const retryAt=Math.max(now()+retryDelay(e,failures),(e as any).retryAt||0);
   db.prepare(`INSERT INTO dots_app_health(manager_id,provider,failures,retry_at,last_duration_ms,checks,status,error_code) VALUES(?,?,?,?,?,1,'backoff',?) ON CONFLICT(manager_id,provider) DO UPDATE SET failures=excluded.failures,retry_at=excluded.retry_at,last_duration_ms=excluded.last_duration_ms,checks=checks+1,status='backoff',error_code=excluded.error_code`).run(managerId,provider,failures,retryAt,Math.round(performance.now()-started),code);
   status(provider,'backoff',code);logger.warn?.('[app-subscription] '+provider+' '+code);
  }finally{lanes.delete(provider);}
 }
 async function tick(){if(stopped)return;await Promise.all([runLane('github',github),runLane('google-calendar',calendar),runLane('github-summary',retryGithubSummary),runLane('rss',rss)]);}
 return {tick,health:()=>['github','google-calendar','rss'].map(p=>health(p)).filter(Boolean),start(){if(timer||stopped)return;void tick();timer=setInterval(()=>void tick(),intervalMs);timer.unref?.();},close(){stopped=true;clearInterval(timer);for(const controller of lanes.values())controller.abort();tokens.clear();}};
}
