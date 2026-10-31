import { PRIVATE_OWNER } from './accounts.mjs';
import { normalizeMailPresentationLinks } from '../../dots-runtime/qq-mail-content.mjs';
// Device owners never receive the private Dots capability or webhook signing key.
import http from 'node:http';
import path from 'node:path';
import { mkdirSync, chmodSync, readFileSync, realpathSync } from 'node:fs';
import { DotsAttachments } from './dots-attachments.mjs';
import { createDotsActivityReader, millis, readableResult } from './dots-activity.mjs';
import { DotsSchedules } from './dots-schedules.mjs';
import { DatabaseSync } from 'node:sqlite';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const fail=(message,status=400,code='invalid_request')=>Object.assign(new Error(message),{status,code});
const relationshipTools=new Set(['dots_get_relationship','dots_update_relationship_topic','dots_delete_relationship_topic']);
const relationshipErrors=new Map([
  ['共同话题包含不支持的字段',400],['请填写有效的共同话题',400],['共同话题不存在',404],
  ['共同话题已更新，请刷新后重试',409]
]);

// Installed older iOS builds require this response envelope to read memories.
// These constants are wire compatibility only: no stored preference or setter.
const relationshipResponse=result=>({...result,relationship:{...result.relationship,settings:{initiative:'natural',paused:false,quietUntil:0}}});

const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])])):value;
const encoded=value=>JSON.stringify(stable(value));
const hash=value=>createHash('sha256').update(value).digest('hex');
const fields=(value,keys)=>Object.fromEntries(keys.filter(k=>Object.hasOwn(value||{},k)).map(k=>[k,value[k]]));
const integer=(value,min=0,max=Number.MAX_SAFE_INTEGER)=>{const n=Number(value);if(!Number.isSafeInteger(n)||n<min||n>max)throw fail('标识或游标无效');return n;};
const identifier=(value,label='请求标识')=>{if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value))throw fail(label+'无效');return value;};
const text=(value,max,label)=>{if(typeof value!=='string'||!value.trim()||value.length>max)throw fail(label+'无效');return value.trim();};
const only=(input,keys)=>{if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!keys.includes(k)))throw fail('请求包含不支持的字段');};
const goalKeys=['id','title','instruction','status','created_at','updated_at','next_wake_at','last_run_at','last_summary','run_count','manager_id','managerId','parent_task_id','parentTaskId','dependencies','acceptance_status','acceptanceStatus','acceptance_criteria','acceptanceCriteria','resource_key','resourceKey','origin_host','legacy_imported','legacyImported','control_revision','controlRevision','execution_status','executionStatus','task_kind','taskKind','attempt_count','attemptCount','lease_expires_at','leaseExpiresAt','blockedReason','deliveryStatus'];
const managerKeys=['id','ownerId','name','status','controlRevision','activityCursor','createdAt','updatedAt','lastSummary','workerLimit','runningWorkers','capabilities','hasMoreMessages','oldestMessageId','hasMoreTasks'];
const managerTaskKeys=['id','managerId','title','instruction','status','acceptanceStatus','acceptanceCriteria','resourceKey','legacyImported','dependencies','controlRevision','createdAt','updatedAt','nextWakeAt','lastSummary','runCount','originHost','parentTaskId','executionStatus','taskKind','attemptCount','leaseExpiresAt','blockedReason','deliveryStatus'];
const managerMessageKeys=['id','role','content','taskId','requestId','host','createdAt','respondsToMessageIds','deliveryState','revision','origin','topicId','proactiveReason','card','feedback'];
// 对话订阅卡片：只含来源、动作、字段名与非机密的预填值；机密字段的值始终为空。
function validSubscriptionCard(card){
  if(card==null)return true;
  if(typeof card!=='object'||Array.isArray(card)||card.type!=='subscription')return false;
  if(!['github','email','google-calendar','rss'].includes(card.provider)||!['subscribe','unsubscribe'].includes(card.action)||!['open','done','cancelled'].includes(card.state))return false;
  if(!Array.isArray(card.fields)||card.fields.length>8)return false;
  return card.fields.every(f=>f&&typeof f.key==='string'&&/^[A-Za-z]{1,40}$/.test(f.key)&&typeof f.label==='string'&&f.label.length<=80&&(f.value===undefined||(typeof f.value==='string'&&f.value.length<=200&&!(f.secret&&f.value))))&&JSON.stringify(card).length<=4000;
}
const managerActivityKeys=['id','managerId','taskId','kind','message','data','createdAt'];
const outputKeys=['id','goal_id','run_number','status','summary','notification','created_at','raw_result'];
const approvalKeys=['id','goal_id','kind','command','reason','status','created_at','decided_at','output','grant_labels'];
const GRANT_SCOPES=['task','hour','day','always'];
const timelineKeys=['id','goal_id','kind','message','data','created_at'];

export function createLocalDotsClient({socketPath='/home/ubuntu/dots-runtime/local-ipc/mcp.sock',timeoutMs=25000,owner}={}) {
  const rpc=(method,params={})=>new Promise((resolve,reject)=>{
    const body=JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method,params});
    const req=http.request({socketPath,path:'/mcp',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body),...(owner?{'X-Dots-Owner':owner}:{})}},res=>{
      let size=0;const chunks=[];
      res.on('data',chunk=>{size+=chunk.length;if(size>16*1024*1024)req.destroy(fail('目标结果过大',502,'runtime_unavailable'));else chunks.push(chunk);});
      res.on('end',()=>{
        try {
          const parsed=JSON.parse(Buffer.concat(chunks).toString());
          if(res.statusCode===200&&!parsed.error&&parsed.result?.isError&&method==='tools/call'&&relationshipTools.has(params.name)){
            const error=parsed.result.structuredContent?.error;
            const expectedCode=error?.status===409?'relationship_conflict':error?.status===404?'relationship_not_found':'relationship_invalid';
            if(error&&relationshipErrors.get(error.reason)===error.status&&error.code===expectedCode)throw fail(error.reason,error.status,error.code);
          }
          // 设置、授权、记录、微信这类面向用户的 RPC：运行时自己写的提示可以原样给用户看。
          if(res.statusCode===200&&parsed.error?.code===-32000&&/^dots\/(settings|grants|audit|weixin|life-goals)\//.test(method)&&typeof parsed.error.message==='string'&&/[\u4e00-\u9fff]/.test(parsed.error.message))throw fail(parsed.error.message.slice(0,200),400,'runtime_rejected');
          if(res.statusCode!==200||parsed.error||parsed.result?.isError)throw fail('Dots 未能完成操作，请刷新目标状态后重试',502,'runtime_rejected');
          resolve(parsed.result);
        }catch(error){reject(error.status?error:fail('Dots 返回内容无效',502,'runtime_unavailable'));}
      });
    });
    req.setTimeout(timeoutMs,()=>req.destroy(fail('Dots 连接超时，请保留请求并重试',504,'runtime_unavailable')));
    req.on('error',error=>reject(error.status?error:fail('Dots 服务暂时无法连接',503,'runtime_unavailable')));
    req.end(body);
  });
  return {rpc,forOwner(value){return createLocalDotsClient({socketPath,timeoutMs,owner:value});},async tool(name,args={}){const result=await rpc('tools/call',{name,arguments:args});if(result?.structuredContent)return result.structuredContent;try{return JSON.parse(result.content.find(c=>c.type==='text').text);}catch{throw fail('Dots 返回内容无效',502,'runtime_unavailable');}}};
}

// Input events are not included by the upstream detail tool. This same-user,
// read-only projection fills that gap without writing the Dots database.
export function createDotsEventReader({databasePath='/home/ubuntu/dots-runtime/data/dots.sqlite3'}={}) {
  let db;
  return {read(goalId){db??=new DatabaseSync(databasePath,{readOnly:true});return db.prepare('SELECT id,goal_id,type,payload,created_at,consumed_at FROM events WHERE goal_id=? ORDER BY id DESC LIMIT 100').all(goalId).reverse();},request(requestId,owner){db??=new DatabaseSync(databasePath,{readOnly:true});return owner&&owner!==(process.env.SHIYAN_DOTS_OWNER||'shiyan-private-owner')?db.prepare('SELECT operation,goal_id,response_json FROM runtime_scoped_requests WHERE owner=? AND request_id=?').get(owner,requestId):db.prepare('SELECT operation,goal_id,response_json FROM runtime_requests WHERE request_id=?').get(requestId);},close(){db?.close();}};
}

export function groupIssueTasks(tasks, memberships) {
  const membership=new Map(memberships.map(row=>[Number(row.goal_id),row])), groups=new Map();
  for(const task of tasks){
    const issue=membership.get(Number(task.id)),key=issue?'issue:'+issue.issue_key:'conversation:'+task.id;
    if(!groups.has(key))groups.set(key,{key,title:issue?.issue_title||task.title,tasks:[]});
    groups.get(key).tasks.push(task);
  }
  return [...groups.values()].map(group=>{
    const pending=group.tasks.filter(task=>!['done','completed','cancelled'].includes(task.status)||(task.status==='done'&&task.acceptanceStatus!=='accepted'));
    const rank=task=>({running:0,waiting_approval:1,active:2,pending:2,queued:2,blocked:3,paused:4}[task.status]??5);
    const task=(pending.length?pending:group.tasks).slice().sort((a,b)=>rank(a)-rank(b)||Number(b.updatedAt||0)-Number(a.updatedAt||0)||b.id-a.id)[0];
    return {...group,task,updatedAt:Math.max(...group.tasks.map(t=>Number(t.updatedAt||0))),createdAt:Math.min(...group.tasks.map(t=>Number(t.createdAt||0)))};
  });
}

export class DotsStore {
  constructor(root,{databasePath=path.join(root,'dots-adapter.sqlite3')}={}) {
    mkdirSync(root,{recursive:true,mode:0o700});this.db=new DatabaseSync(databasePath);
    try{chmodSync(databasePath,0o600);}catch{}
    this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS dots_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dots_goals(goal_id INTEGER PRIMARY KEY,owner TEXT NOT NULL,conversation_id TEXT NOT NULL,origin_host TEXT NOT NULL,snapshot TEXT NOT NULL,created_at INTEGER NOT NULL,create_request_id TEXT,UNIQUE(owner,conversation_id));
      CREATE INDEX IF NOT EXISTS dots_goals_owner ON dots_goals(owner,goal_id);
      CREATE TABLE IF NOT EXISTS dots_requests(owner TEXT NOT NULL,request_id TEXT NOT NULL,operation TEXT NOT NULL,fingerprint TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL,response TEXT,created_at INTEGER NOT NULL,PRIMARY KEY(owner,request_id));
      CREATE TABLE IF NOT EXISTS dots_conversation_claims(owner TEXT NOT NULL,conversation_id TEXT NOT NULL,create_request_id TEXT NOT NULL,PRIMARY KEY(owner,conversation_id));
      CREATE TABLE IF NOT EXISTS dots_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,owner TEXT NOT NULL,event_id TEXT NOT NULL UNIQUE,goal_id INTEGER NOT NULL,type TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS dots_events_owner_seq ON dots_events(owner,seq);
      CREATE TABLE IF NOT EXISTS dots_consumers(owner TEXT NOT NULL,consumer_id TEXT NOT NULL,cursor INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(owner,consumer_id));
      CREATE TABLE IF NOT EXISTS dots_subscriptions(goal_id INTEGER PRIMARY KEY,subscription_id TEXT,callback_url TEXT NOT NULL,expires_at INTEGER,updated_at INTEGER NOT NULL,last_error TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS dots_runtime_cursors(goal_id INTEGER PRIMARY KEY,cursor INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS dots_webhook_receipts(event_id TEXT PRIMARY KEY,body_hash TEXT NOT NULL,received_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS dots_managers(owner TEXT PRIMARY KEY,manager_id TEXT NOT NULL UNIQUE,snapshot TEXT NOT NULL,runtime_cursor INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS dots_issue_members(owner TEXT NOT NULL,goal_id INTEGER NOT NULL,issue_key TEXT NOT NULL,issue_title TEXT NOT NULL,PRIMARY KEY(owner,goal_id));
      CREATE TABLE IF NOT EXISTS dots_activity_reads(owner TEXT NOT NULL,activity_id TEXT NOT NULL,seen_at INTEGER NOT NULL,PRIMARY KEY(owner,activity_id));
    `);
    if(!this.db.prepare('PRAGMA table_info(dots_goals)').all().some(c=>c.name==='create_request_id'))this.db.exec('ALTER TABLE dots_goals ADD COLUMN create_request_id TEXT');
    let secret=this.db.prepare("SELECT value FROM dots_settings WHERE key='webhook_secret'").get()?.value;
    if(!secret){secret='whsec_'+randomBytes(32).toString('base64');this.db.prepare('INSERT INTO dots_settings(key,value) VALUES(?,?)').run('webhook_secret',secret);}
    this.webhookSecret=secret;
  }
  close(){this.db.close();}
  transaction(fn){this.db.exec('BEGIN IMMEDIATE');try{const value=fn();this.db.exec('COMMIT');return value;}catch(error){this.db.exec('ROLLBACK');throw error;}}
  mapping(owner,id){return this.db.prepare('SELECT * FROM dots_goals WHERE owner=? AND goal_id=?').get(owner,id);}
  mappedGoal(id){return this.db.prepare('SELECT * FROM dots_goals WHERE goal_id=?').get(id);}
  mappings(owner){return owner===undefined?this.db.prepare('SELECT * FROM dots_goals ORDER BY goal_id DESC').all():this.db.prepare('SELECT * FROM dots_goals WHERE owner=? ORDER BY goal_id DESC').all(owner);}
  manager(owner){return this.db.prepare('SELECT * FROM dots_managers WHERE owner=?').get(owner);}
  managerSnapshot(owner,manager){this.db.prepare('INSERT INTO dots_managers(owner,manager_id,snapshot,updated_at) VALUES(?,?,?,?) ON CONFLICT(owner) DO UPDATE SET snapshot=excluded.snapshot,updated_at=excluded.updated_at').run(owner,manager.id,encoded(manager),Date.now());}
  latestCursor(owner){return Number(this.db.prepare('SELECT MAX(seq) AS cursor FROM dots_events WHERE owner=?').get(owner)?.cursor||0);}
  receipt(owner,requestId){return this.db.prepare('SELECT * FROM dots_requests WHERE owner=? AND request_id=?').get(owner,requestId);}
  reserve(owner,requestId,operation,payload){
    const fingerprint=hash(encoded(payload));const prior=this.receipt(owner,requestId);
    if(prior){if(prior.operation!==operation||prior.fingerprint!==fingerprint)throw fail('此请求标识已用于不同内容',409,'request_conflict');return prior;}
    this.db.prepare('INSERT INTO dots_requests(owner,request_id,operation,fingerprint,payload,state,created_at) VALUES(?,?,?,?,?,?,?)').run(owner,requestId,operation,fingerprint,encoded(payload),'pending',Date.now());return this.receipt(owner,requestId);
  }
  finish(owner,requestId,response){this.db.prepare("UPDATE dots_requests SET state='completed',response=? WHERE owner=? AND request_id=?").run(encoded(response),owner,requestId);}
  bind(owner,conversationId,host,goal,requestId=null){
    const existing=this.db.prepare('SELECT * FROM dots_goals WHERE owner=? AND conversation_id=?').get(owner,conversationId);
    if(existing&&existing.goal_id!==goal.id)throw fail('此会话已绑定另一个目标',409,'conversation_conflict');
    const prior=this.mappedGoal(goal.id);if(prior&&(prior.owner!==owner||prior.conversation_id!==conversationId))throw fail('目标不存在',404,'not_found');
    this.db.prepare('INSERT OR IGNORE INTO dots_goals(goal_id,owner,conversation_id,origin_host,snapshot,created_at,create_request_id) VALUES(?,?,?,?,?,?,?)').run(goal.id,owner,conversationId,host,encoded(goal),Date.now(),requestId);
  }
  snapshot(id,goal){this.db.prepare('UPDATE dots_goals SET snapshot=? WHERE goal_id=?').run(encoded(goal),id);}
  append(owner,goalId,type,payload,eventId){
    const result=this.db.prepare('INSERT OR IGNORE INTO dots_events(owner,event_id,goal_id,type,payload,created_at) VALUES(?,?,?,?,?,?)').run(owner,eventId,goalId,type,encoded(payload),Date.now());
    if(!result.changes)return null;
    return this.event(this.db.prepare('SELECT * FROM dots_events WHERE seq=?').get(Number(result.lastInsertRowid)));
  }
  event(row){return {seq:Number(row.seq),eventId:row.event_id,goalId:Number(row.goal_id),type:row.type,payload:JSON.parse(row.payload),createdAt:Number(row.created_at)};}
  events(owner,after,limit){const rows=this.db.prepare('SELECT * FROM dots_events WHERE owner=? AND seq>? ORDER BY seq LIMIT ?').all(owner,after,limit+1);const visible=rows.slice(0,limit);return {ok:true,events:visible.map(row=>this.event(row)),cursor:visible.at(-1)?.seq??after,hasMore:rows.length>limit};}
  ack(owner,consumerId,cursor){
    if(cursor>0&&!this.db.prepare('SELECT seq FROM dots_events WHERE owner=? AND seq=?').get(owner,cursor))throw fail('通知游标不属于当前用户',400,'invalid_cursor');
    this.db.prepare('INSERT INTO dots_consumers(owner,consumer_id,cursor,updated_at) VALUES(?,?,?,?) ON CONFLICT(owner,consumer_id) DO UPDATE SET cursor=MAX(cursor,excluded.cursor),updated_at=excluded.updated_at').run(owner,consumerId,cursor,Date.now());
    return {ok:true,consumerId,cursor:this.db.prepare('SELECT cursor FROM dots_consumers WHERE owner=? AND consumer_id=?').get(owner,consumerId).cursor,handoffOnly:true};
  }
}

// 微信发来的图片/文件：给模型的附件说明不在界面上展示，只显示用户写的话和“[图片]”“[文件]”标签。
const WEIXIN_INPUTS=path.resolve(process.env.DOTS_WEIXIN_INPUTS||'/home/ubuntu/dots-runtime/workspaces/.manager/inputs/weixin')+path.sep;
// 微信图片登记为这条消息的附件，界面可直接显示。只收私人账号工作区 inputs/weixin 下的真实文件（不跟随符号链接）。
export function weixinImageAttachments(attachments,owner,message){
  const out=[];
  for(const match of String(message.content).matchAll(/"type":"image","filename":"([^"]+)","path":"([^"]+)"/g)){
    try{
      const file=path.resolve(match[2]);if(!file.startsWith(WEIXIN_INPUTS)||realpathSync(file)!==file)continue;
      const h=createHash('sha256').update(owner+'\0'+file).digest('hex'),id=[h.slice(0,8),h.slice(8,12),h.slice(12,16),h.slice(16,20),h.slice(20,32)].join('-');
      const filename=path.basename(match[1]);
      const known=attachments.db.prepare('SELECT * FROM dots_attachments WHERE owner=? AND id=?').get(owner,id);
      if(known){out.push(attachments.public(known));continue;}
      const data=readFileSync(file);if(!data.length||data.length>20*1024*1024)continue;
      const ext=path.extname(filename).toLowerCase(),mimeType=ext==='.png'?'image/png':ext==='.gif'?'image/gif':ext==='.webp'?'image/webp':'image/jpeg';
      out.push(attachments.upload(owner,{id,filename,mimeType,data:data.toString('base64')}));
    }catch{}
  }
  return out.slice(0,8);
}
export function weixinDisplay(message,shownImages=[]){
  if(message?.role!=='user'||typeof message.content!=='string')return message;
  const at=message.content.indexOf('[用户从微信发来的附件]');if(at<0)return message;
  const head=message.content.slice(0,at).trim().replace(/^（我从微信发来了[^）]*）$/,''),rest=message.content.slice(at);
  const count=type=>(rest.match(new RegExp('"type":"'+type+'"','g'))||[]).length,images=count('image'),files=count('file');
  const tag=[images?'[图片'+(images>1?' ×'+images:'')+']':'',files?'[文件'+(files>1?' ×'+files:'')+']':''].filter(Boolean).join(' ');
  // 图片能显示时不再写“[图片]”，只保留用户的文字。
  const shown=shownImages.length?[files?'[文件'+(files>1?' ×'+files:'')+']':''].filter(Boolean).join(''):tag;
  return {...message,content:[head,shown].filter(Boolean).join('\n'),...(shownImages.length?{attachments:shownImages}:{})};
}
export class DotsAdapter {
  weixinView(owner,message){if(message?.role!=='user'||typeof message.content!=='string'||!message.content.includes('[用户从微信发来的附件]'))return message;return weixinDisplay(message,owner===this.allowedOwner?weixinImageAttachments(this.attachments,owner,message):[]);}
  constructor({root,store=new DotsStore(root),client=createLocalDotsClient(),eventReader=createDotsEventReader(),activityReader=createDotsActivityReader(),allowedOwner='shiyan-private-owner',callbackURL='',importPrivateGoals=false,recoverIntervalMs=30000,subscriptionRefreshMs=4*3600000,managerPollMs=350,schedulePollMs=15000}={}) {
    this.store=store;this.attachments=new DotsAttachments(root,store.db);this.client=client;this.eventReader=eventReader;this.allowedOwner=allowedOwner;this.callbackURL=callbackURL;this.importPrivateGoals=importPrivateGoals;this.listeners=new Map();this.inflight=new Map();this.subscriptionInflight=new Map();this.managerSyncInflight=new Map();this.recovering=false;this.managerPollMs=managerPollMs;
    this.activityReader=activityReader;this.schedules=new DotsSchedules(this,{pollMs:schedulePollMs});
    this.timer=recoverIntervalMs>0?setInterval(()=>void this.recover().catch(()=>{}),recoverIntervalMs):null;this.timer?.unref();
    this.refreshTimer=subscriptionRefreshMs>0?setInterval(()=>void this.ensureSubscriptions().catch(()=>{}),subscriptionRefreshMs):null;this.refreshTimer?.unref();
    // The runtime currently has durable manager activity, but no manager
    // webhook subscription. Poll only while a client is listening; the slower
    // recovery timer still catches up after process or device disconnection.
    this.managerTimer=managerPollMs>0?setInterval(()=>{for(const [owner,listeners] of this.listeners)if(listeners.size&&this.store.manager(owner))void this.syncManagerActivity(owner).catch(()=>{});},managerPollMs):null;this.managerTimer?.unref();
  }
  close(){clearInterval(this.timer);clearInterval(this.refreshTimer);clearInterval(this.managerTimer);this.schedules.close();for(const listeners of this.listeners.values())for(const listener of listeners)listener.end();this.activityReader?.close();this.eventReader?.close();this.store.close();}
  authorize(owner){if(typeof owner!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(owner))throw fail('用户身份无效',401,'unauthorized');}
  clientFor(owner){this.authorize(owner);return this.client.forOwner?.(owner)||this.client;}
  async registrationNotice(event){
    // Only the private Unix receiver calls this method. No public route or AI
    // tool accepts a recipient, owner id or administrator subscription.
    this.authorize(PRIVATE_OWNER);
    const result=await this.clientFor(PRIVATE_OWNER).rpc('dots/internal/registration',event);
    await this.managerSnapshot(PRIVATE_OWNER);
    await this.syncManagerActivity(PRIVATE_OWNER);
    // A concurrent registration may have joined a sync that read its page
    // before this notice committed. Do not ACK that notice before replay/SSE
    // reaches its durable runtime cursor.
    const target=Number(result.activityCursor||0);
    for(let attempt=0;attempt<3&&Number(this.store.manager(PRIVATE_OWNER)?.runtime_cursor||0)<target;attempt++)await this.syncManagerActivity(PRIVATE_OWNER);
    if(Number(this.store.manager(PRIVATE_OWNER)?.runtime_cursor||0)<target)throw fail('注册提醒尚未同步，请重试',503,'runtime_unavailable');
    return {ok:true,durable:true,messageId:result.message.id};
  }
  async subscriptions(owner){this.authorize(owner);return this.clientFor(owner).rpc('dots/subscriptions/list');}
  async messageFeedback(owner,messageId,value){this.authorize(owner);if(!Number.isSafeInteger(Number(messageId))||Number(messageId)<1||!['useful','not_useful','clear'].includes(value))throw fail('反馈无效',400);return this.clientFor(owner).rpc('dots/messages/feedback',{messageId:Number(messageId),value});}
  async weixin(owner,action='status',input={}){this.authorize(owner);if(!['status','login','verify','unbind','push'].includes(action))throw fail('操作无效',400);const params=action==='verify'?{code:String(input.code||'')}:action==='push'?{enabled:input.enabled===true}:{};return this.clientFor(owner).rpc('dots/weixin/'+action,params);}
  async settings(owner){this.authorize(owner);return this.clientFor(owner).rpc('dots/settings/get');}
  async audit(owner,query={}){this.authorize(owner);const params={limit:Math.max(1,Math.min(200,Number(query.limit)||50))};if(query.before!==undefined&&query.before!==null&&query.before!==''){const before=Number(query.before);if(!Number.isSafeInteger(before)||before<1)throw fail('分页参数无效');params.before=before;}if(query.category){if(!['action','message','change'].includes(query.category))throw fail('类别无效');params.category=query.category;}return this.clientFor(owner).rpc('dots/audit/list',params);}
  async lifeGoals(owner,action='list',id=null,input={}){
    this.authorize(owner);
    if(!['list','create','update','milestone','replan','remove'].includes(action))throw fail('操作无效',400);
    const params={};
    if(action!=='list'&&action!=='create')params.id=integer(id,1);
    if(input!==null&&(typeof input!=='object'||Array.isArray(input)))throw fail('内容无效',400);
    const pick=(keys)=>Object.fromEntries(keys.filter(k=>k in (input||{})).map(k=>[k,input[k]]));
    if(action==='create'||action==='update')params.goal=pick(['title','why','targetDate','cadence','checkinTime','status']);
    if(action==='milestone')params.change=pick(['milestoneId','done','title','due','add','remove']);
    return this.clientFor(owner).rpc('dots/life-goals/'+action,params);
  }
  async approvalGrants(owner){this.authorize(owner);return this.clientFor(owner).rpc('dots/grants/list');}
  async revokeApprovalGrant(owner,id){this.authorize(owner);id=integer(id,1);return this.clientFor(owner).rpc('dots/grants/revoke',{id});}
  async updateSettings(owner,input){this.authorize(owner);const allowed={};for(const key of ['approvalMode','dailyBrief','dailyBriefTime'])if(key in (input||{}))allowed[key]=input[key];return this.clientFor(owner).rpc('dots/settings/update',allowed);}
  async updateSubscription(owner,provider,input){this.authorize(owner);return this.clientFor(owner).rpc('dots/subscriptions/update',{provider,config:input});}
  async deleteSubscription(owner,provider){this.authorize(owner);return this.clientFor(owner).rpc('dots/subscriptions/delete',{provider});}
  async relationship(owner){this.authorize(owner);return relationshipResponse(await this.clientFor(owner).tool('dots_get_relationship',{owner_id:owner}));}
  async updateRelationshipTopic(owner,topicId,input){
    this.authorize(owner);if(typeof topicId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(topicId))throw fail('共同话题标识无效');
    only(input,['title','summary','openQuestion','revision']);
    if(input.title!==undefined)text(input.title,200,'话题名称');
    for(const [key,max] of [['summary',4000],['openQuestion',2000]])if(input[key]!==undefined&&(typeof input[key]!=='string'||input[key].length>max))throw fail('话题内容无效');
    if(input.revision!==undefined)integer(input.revision);
    return relationshipResponse(await this.clientFor(owner).tool('dots_update_relationship_topic',{owner_id:owner,topicId,...input}));
  }
  async deleteRelationshipTopic(owner,topicId){
    this.authorize(owner);if(typeof topicId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(topicId))throw fail('共同话题标识无效');
    return relationshipResponse(await this.clientFor(owner).tool('dots_delete_relationship_topic',{owner_id:owner,topicId}));
  }
  requireGoal(owner,id){this.authorize(owner);const row=this.store.mapping(owner,integer(id,1));if(!row)throw fail('目标不存在',404,'not_found');return row;}
  presentGoal(goal,row){return {...fields(goal,goalKeys),conversationId:row.conversation_id,originHost:row.origin_host,...(goal.client_context?{originContext:fields(goal.client_context,['host','conversation_id'])}:{}),...(goal.timeline?{timeline:goal.timeline.map(t=>fields(t,timelineKeys))}:{}),...(goal.outputs?{outputs:goal.outputs.map(o=>fields(o,outputKeys))}:{}),...(goal.approvals?{approvals:goal.approvals.map(a=>fields(a,approvalKeys))}:{})};}
  presentEvent(owner,event){
    const activity=event?.payload?.activity;
    // Older durable notifications stored the runtime attachment instruction.
    // Project at delivery as well as ingestion so replay uses the same public
    // user message as a fresh acceptance response, without rewriting history.
    if(event?.type!=='manager_activity'||!['user_message','assistant_delta','assistant_message','proactive_message'].includes(activity?.kind))return event;
    return {...event,payload:{...event.payload,activity:this.presentManagerActivity(owner,activity)}};
  }
  publish(event,owner){if(!event)return;const target=owner||this.store.mappedGoal(event.goalId)?.owner,visible=this.presentEvent(target,event);for(const listener of this.listeners.get(target)||[])if(!listener.destroyed)listener.write(`id: ${visible.seq}\nevent: update\ndata: ${JSON.stringify(visible)}\n\n`);}
  async goal(owner,id){const row=this.requireGoal(owner,id);const result=await this.clientFor(owner).tool('dots_get_goal',{goal_id:Number(row.goal_id)});if(!result.goal)throw fail('目标不存在',404,'not_found');const goal=this.presentGoal(result.goal,row);try{goal.events=this.eventReader?.read(Number(row.goal_id))||[];}catch{goal.events=[];goal.eventsUnavailable=true;}this.store.snapshot(row.goal_id,goal);return {ok:true,goal,timeline:goal.timeline||[],outputs:goal.outputs||[],approvals:goal.approvals||[],events:goal.events};}
  async capabilities(owner){this.authorize(owner);let available=true;try{await this.client.rpc('ping');}catch{available=false;}const mapped=this.store.mappings(owner);const subs=this.store.db.prepare('SELECT * FROM dots_subscriptions').all();const configured=Boolean(this.callbackURL);const subscriptionsActive=mapped.length?mapped.every(g=>subs.some(s=>s.goal_id===g.goal_id&&s.subscription_id&&(!s.expires_at||s.expires_at>Date.now()))):false;return {ok:true,available,service:'Dots',adapterInstalled:true,sharedGoals:true,events:true,webhookConfigured:configured,realtimeAvailable:configured&&available&&subscriptionsActive,notificationTransport:configured?'signed-webhook-with-durable-replay':'durable-replay',subscriptionsActive,singleManager:true,managerTransport:'durable-activity-polling-with-SSE-replay',managerWebhook:false,managerPollIntervalMs:this.managerPollMs,managerRealtimeAvailable:available&&this.managerPollMs>0&&Boolean(this.store.manager(owner)),apns:false,modelsSelectable:false,budgetsSupported:false,stopSemantics:'暂停或取消会阻止后续步骤；已开始的命令可能仍会完成'};}
  presentManager(owner,source){
    const expected='manager:'+owner;
    if(!source||source.id!==expected||source.ownerId!==owner)throw fail('总管归属不一致',502,'runtime_rejected');
    // Runtime mutation receipts intentionally retain their original response.
    // Replaying one must not replace a newer manager/task cache with old state.
    const prior=this.store.manager(owner);
    if(prior&&source.activityCursor!==undefined){
      const cached=JSON.parse(prior.snapshot);
      if(cached.activityCursor!==undefined&&integer(source.activityCursor)<integer(cached.activityCursor))return cached;
    }
    const manager=fields(source,managerKeys);
    manager.messages=(source.messages||[]).map(message=>this.presentManagerMessage(message,owner)).sort((a,b)=>a.id-b.id);
    manager.tasks=(source.tasks||[]).map(task=>{
      if(task.managerId&&task.managerId!==expected)throw fail('子任务归属不一致',502,'runtime_rejected');
      return {...fields(task,managerTaskKeys),id:integer(task.id,1),managerId:expected};
    });
    // Only owner-scoped results may establish bindings. Keep the original
    // conversation/thread association of already imported goals intact.
    this.store.transaction(()=>{
      for(const task of manager.tasks){
        const row=this.store.mappedGoal(task.id);
        if(row&&row.owner!==owner)throw fail('子任务不存在',404,'not_found');
        const goal={id:task.id,title:task.title,instruction:task.instruction,status:task.status,created_at:task.createdAt,updated_at:task.updatedAt,next_wake_at:task.nextWakeAt,last_summary:task.lastSummary,run_count:task.runCount,manager_id:expected,managerId:expected,dependencies:task.dependencies,acceptanceStatus:task.acceptanceStatus,acceptanceCriteria:task.acceptanceCriteria,resourceKey:task.resourceKey,legacyImported:task.legacyImported,controlRevision:task.controlRevision,...fields(task,['parentTaskId','executionStatus','taskKind','attemptCount','leaseExpiresAt','blockedReason','deliveryStatus'])};
        if(!row)this.store.bind(owner,'dots-task-'+task.id,task.originHost||'other',goal);
        this.store.snapshot(task.id,this.presentGoal(goal,this.store.mappedGoal(task.id)));
      }
      this.store.managerSnapshot(owner,manager);
    });
    for(const task of manager.tasks)void this.ensureSubscription(task.id).catch(()=>{});
    return manager;
  }
  presentManagerMessage(message,owner){
    if(!['user','assistant','system'].includes(message.role)||typeof message.content!=='string')throw fail('总管消息格式无效',502,'runtime_rejected');
    if(message.respondsToMessageIds!==undefined&&(!Array.isArray(message.respondsToMessageIds)||message.respondsToMessageIds.some(id=>!Number.isSafeInteger(id)||id<1)))throw fail('总管回复归属格式无效',502,'runtime_rejected');
    if(message.deliveryState!==undefined&&!['streaming','completed','failed','cancelled'].includes(message.deliveryState))throw fail('总管回复状态无效',502,'runtime_rejected');
    if(message.revision!==undefined&&(!Number.isSafeInteger(message.revision)||message.revision<0))throw fail('总管回复版本无效',502,'runtime_rejected');
    if(message.origin!==undefined&&!['reply','proactive'].includes(message.origin))throw fail('消息来源格式无效',502,'runtime_rejected');
    if(message.topicId!=null&&(typeof message.topicId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(message.topicId)))throw fail('共同话题标识无效',502,'runtime_rejected');
    if(message.proactiveReason!=null&&(typeof message.proactiveReason!=='string'||message.proactiveReason.length>2000))throw fail('交流缘由格式无效',502,'runtime_rejected');
    if(!validSubscriptionCard(message.card))throw fail('订阅卡片格式无效',502,'runtime_rejected');
    if(message.feedback!=null&&!['useful','not_useful'].includes(message.feedback))throw fail('消息反馈格式无效',502,'runtime_rejected');
    const metadata=this.attachments.message(owner,message.requestId);
    const projected=message.role==='assistant'?{...message,content:normalizeMailPresentationLinks(message.content)}:this.weixinView(owner,message);
    return {...fields(projected,managerMessageKeys),...(Array.isArray(projected.attachments)&&projected.attachments.length?{attachments:projected.attachments}:{}),...(metadata?{content:metadata.text,attachments:metadata.attachments}:{}),id:integer(message.id,1),taskId:message.taskId==null?null:integer(message.taskId,1),respondsToMessageIds:[...new Set(message.respondsToMessageIds||[])]};
  }
  managerResponse(owner,manager,extra={}){return {ok:true,manager,messages:manager.messages||[],tasks:manager.tasks||[],...fields(manager,['hasMoreMessages','oldestMessageId','hasMoreTasks']),cursor:this.store.latestCursor(owner),...extra};}
  async managerSnapshot(owner){
    this.authorize(owner);
    const result=await this.clientFor(owner).tool('dots_get_manager',{owner_id:owner});
    return this.presentManager(owner,result.manager);
  }
  async manager(owner){
    this.authorize(owner);
    const before=Number(this.store.manager(owner)?.runtime_cursor||0);
    let manager;
    try{manager=await this.managerSnapshot(owner);}catch(error){
      const cached=this.store.manager(owner);
      if(!cached||!['runtime_unavailable','runtime_rejected'].includes(error.code))throw error;
      return this.managerResponse(owner,JSON.parse(cached.snapshot),{stale:true,realtimeUnavailable:true});
    }
    // HTTP acceptance and SSE replay share the same durable event projection.
    // A failed activity read does not invent a successful webhook connection.
    try{
      await this.syncManagerActivity(owner);
      const activityCursor=Number(this.store.manager(owner)?.runtime_cursor||0);
      if(activityCursor>Number(manager.activityCursor??before))manager=await this.managerSnapshot(owner);
      return this.managerResponse(owner,manager);
    }catch{return this.managerResponse(owner,manager,{realtimeUnavailable:true});}
  }
  async messageManager(owner,input){
    this.authorize(owner);only(input,['requestId','message','host','taskId','attachments']);
    const attachments=this.attachments.resolve(owner,input.attachments||[]);
    const payload={message:text(input.message,20000,'总管指令'),host:input.host,...(attachments.length?{attachments:attachments.map(a=>a.id)}:{}),...(input.taskId==null?{}:{taskId:integer(input.taskId,1)})};
    if(!['shiyan_desktop','shiyan_mobile'].includes(payload.host))throw fail('指令来源无效');
    if(payload.taskId)this.requireGoal(owner,payload.taskId);
    return this.mutation(owner,input.requestId,'manager:message',payload,async()=>{
      const remoteId=this.remoteRequestId(owner,input.requestId);
      const instruction=await this.attachments.bindRuntimeMessage(owner,remoteId,payload.message,attachments,{privateOwner:this.allowedOwner});
      const result=await this.clientFor(owner).tool('dots_message_manager',{owner_id:owner,message:instruction,host:payload.host,request_id:remoteId,...(payload.taskId?{task_id:payload.taskId}:{})});
      const manager=this.presentManager(owner,result.manager);
      const message=manager.messages.find(m=>m.id===result.message?.id)||this.presentManagerMessage(result.message||{},owner);
      if(result.accepted!==true||!Number.isSafeInteger(message.id)||message.role!=='user'||message.content!==payload.message)throw fail('总管未确认接收此指令',502,'runtime_rejected');
      this.publish(this.store.append(owner,0,'manager_snapshot',{manager:fields(manager,managerKeys),managerId:manager.id,message},'manager-message:'+hash(owner)+':'+input.requestId),owner);
      void this.syncManagerActivity(owner).catch(()=>{});
      return this.managerResponse(owner,manager,{accepted:true,message});
    },{replaySafe:true});
  }
  async controlManager(owner,input){
    this.authorize(owner);only(input,['requestId','action']);
    if(!['pause','resume','cancel','wake'].includes(input.action))throw fail('总管操作不支持');
    return this.mutation(owner,input.requestId,'manager:control',{action:input.action},async()=>{
      const result=await this.clientFor(owner).tool('dots_control_manager',{owner_id:owner,action:input.action,request_id:this.remoteRequestId(owner,input.requestId)});
      const manager=this.presentManager(owner,result.manager);
      this.publish(this.store.append(owner,0,'manager_snapshot',{manager:fields(manager,managerKeys),managerId:manager.id},'manager-control:'+hash(owner)+':'+input.requestId),owner);
      void this.syncManagerActivity(owner).catch(()=>{});
      return this.managerResponse(owner,manager);
    },{replaySafe:true});
  }
  async managerMessages(owner,{before=0,limit=100}={}){
    this.authorize(owner);before=integer(before);limit=integer(limit,1,200);
    const result=await this.clientFor(owner).tool('dots_get_manager_messages',{owner_id:owner,before_id:before,limit});
    const messages=(result.messages||[]).map(message=>this.presentManagerMessage(message,owner)).sort((a,b)=>a.id-b.id);
    if(before&&messages.some(message=>message.id>=Number(before)))throw fail('总管历史分页顺序无效',502,'runtime_rejected');
    return {ok:true,messages,hasMore:Boolean(result.hasMore),nextBeforeId:result.nextBeforeId==null?null:integer(result.nextBeforeId)};
  }
  async managerActivity(owner,{after=0,limit=50}={}){
    this.authorize(owner);
    const result=await this.clientFor(owner).tool('dots_get_manager_activity',{owner_id:owner,after_id:integer(after),limit:integer(limit,1,200)});
    const activity=(result.activity||[]).map(item=>this.presentManagerActivity(owner,item));
    return {ok:true,activity,nextCursor:integer(result.nextCursor??after),hasMore:Boolean(result.hasMore),cursor:this.store.latestCursor(owner)};
  }
  presentManagerActivity(owner,item){
    if(item.managerId!=='manager:'+owner)throw fail('总管活动归属不一致',502,'runtime_rejected');
    const data=item.data;
    const projected=data?.message&&['assistant_delta','assistant_message','proactive_message','user_message'].includes(item.kind)
      ?{...data,message:this.presentManagerMessage(data.message,owner)}:data;
    return {...fields(item,managerActivityKeys),...(projected!==undefined?{data:projected}:{}),...(item.kind==='user_message'&&projected?.message?{message:projected.message.content}:{}),id:integer(item.id,1),taskId:item.taskId==null?null:integer(item.taskId,1)};
  }
  async syncManagerActivity(owner){
    this.authorize(owner);
    if(this.managerSyncInflight.has(owner))return this.managerSyncInflight.get(owner);
    const promise=(async()=>{
      if(!this.store.manager(owner))return;
      let after=Number(this.store.manager(owner).runtime_cursor);
      for(let page=0;page<10;page++){
        const result=await this.managerActivity(owner,{after,limit:200});
        if(result.activity.some(a=>a.taskId&&!this.store.mapping(owner,a.taskId)))await this.managerSnapshot(owner);
        if(result.activity.some(a=>a.taskId&&!this.store.mapping(owner,a.taskId)))throw fail('总管活动子任务不存在',502,'runtime_rejected');
        const events=[];
        this.store.transaction(()=>{
          let previous=after;
          for(const activity of result.activity){
            if(activity.id<=previous)throw fail('总管活动顺序无效',502,'runtime_rejected');
            previous=activity.id;
            const event=this.store.append(owner,activity.taskId||0,'manager_activity',{activity,managerId:activity.managerId},'dots-manager-activity:'+hash(owner)+':'+activity.id);
            if(event)events.push(event);
          }
          if(result.nextCursor<previous||result.nextCursor<after)throw fail('总管活动游标无效',502,'runtime_rejected');
          if(result.hasMore&&result.nextCursor===after)throw fail('总管活动游标没有前进',502,'runtime_rejected');
          after=result.nextCursor;
          this.store.db.prepare('UPDATE dots_managers SET runtime_cursor=MAX(runtime_cursor,?),updated_at=? WHERE owner=?').run(after,Date.now(),owner);
        });
        for(const event of events)this.publish(event,owner);
        if(!result.hasMore)break;
      }
    })();this.managerSyncInflight.set(owner,promise);
    try{return await promise;}finally{this.managerSyncInflight.delete(owner);}
  }
  async list(owner,{after=0,limit=50,status}={}){
    this.authorize(owner);after=integer(after);limit=integer(limit,1,200);
    if(status&&!['active','paused','done','blocked','waiting_approval','cancelled'].includes(status))throw fail('目标状态无效');
    let source=new Map(),stale=false;
    try{const result=await this.clientFor(owner).tool('dots_list_goals',{limit:200});source=new Map((result.goals||[]).map(g=>[g.id,g]));}catch{stale=true;}
    const rows=this.store.mappings(owner).filter(row=>(!after||row.goal_id<after)&&(!status||(source.get(row.goal_id)||JSON.parse(row.snapshot)).status===status));
    const selected=rows.slice(0,limit+1),goals=[];
    for(const row of selected.slice(0,limit)){const fresh=source.get(row.goal_id);const goal=fresh?this.presentGoal(fresh,row):JSON.parse(row.snapshot);if(fresh)this.store.snapshot(row.goal_id,goal);goals.push({...fields(goal,[...goalKeys,'conversationId','originHost','originContext']),...(stale?{stale:true}:{})});}
    return {ok:true,goals,cursor:selected.slice(0,limit).at(-1)?.goal_id??after,hasMore:selected.length>limit,sourceTruncated:Boolean(this.importSourceTruncated)};
  }
  remoteRequestId(owner,requestId){return 'shiyan:'+hash(owner+':'+requestId);}
  async mutation(owner,requestId,operation,payload,execute,{replaySafe=false,reconcile}={}) {
    this.authorize(owner);identifier(requestId);const key=owner+':'+requestId;
    const hadReceipt=Boolean(this.store.receipt(owner,requestId));const receipt=this.store.reserve(owner,requestId,operation,payload);
    if(receipt.state==='completed')return JSON.parse(receipt.response);
    if(this.inflight.has(key))return this.inflight.get(key);
    // A receipt created before this invocation means the previous connection or
    // process may have lost its reply. Only runtime-deduplicated writes retry.
    const promise=(async()=>{
      if(hadReceipt&&!replaySafe){
        const resolved=reconcile?await reconcile():null;
        if(resolved){this.store.finish(owner,requestId,resolved);return resolved;}
        throw fail('上次操作结果尚不确定，请刷新目标状态；不会重复执行',409,'action_uncertain');
      }
      const response=await execute();this.store.finish(owner,requestId,response);return response;
    })();this.inflight.set(key,promise);
    try{return await promise;}finally{this.inflight.delete(key);}
  }
  async create(owner,input){
    this.authorize(owner);only(input,['requestId','conversationId','title','instruction','runNow','host']);
    const payload={conversationId:identifier(input.conversationId,'会话标识'),title:text(input.title,200,'目标标题'),instruction:text(input.instruction,20000,'目标内容'),runNow:input.runNow!==false,host:input.host};
    if(!['shiyan_desktop','shiyan_mobile'].includes(payload.host)||input.runNow!==undefined&&typeof input.runNow!=='boolean')throw fail('目标来源或启动选项无效');
    return this.mutation(owner,input.requestId,'create',payload,async()=>{
      // Reserve the conversation before yielding to the runtime. Two devices
      // with different request IDs must not create two goals for one session.
      this.store.db.prepare('INSERT OR IGNORE INTO dots_conversation_claims(owner,conversation_id,create_request_id) VALUES(?,?,?)').run(owner,payload.conversationId,input.requestId);
      const claim=this.store.db.prepare('SELECT create_request_id FROM dots_conversation_claims WHERE owner=? AND conversation_id=?').get(owner,payload.conversationId);
      if(claim.create_request_id!==input.requestId)throw fail('此会话正在创建或已有目标，请刷新后追加指令',409,'conversation_conflict');
      const existing=this.store.db.prepare('SELECT * FROM dots_goals WHERE owner=? AND conversation_id=?').get(owner,payload.conversationId);
      if(existing){if(existing.create_request_id===input.requestId)return this.goal(owner,existing.goal_id);throw fail('此会话已有目标，请追加指令',409,'conversation_conflict');}
      const result=await this.clientFor(owner).tool('dots_create_goal',{title:payload.title,instruction:payload.instruction,run_now:payload.runNow,request_id:this.remoteRequestId(owner,input.requestId),client_context:{host:payload.host,conversation_id:payload.conversationId}});
      if(!Number.isSafeInteger(result.goal?.id)||result.goal.id<1)throw fail('Dots 目标创建结果无效',502);
      this.store.bind(owner,payload.conversationId,payload.host,result.goal,input.requestId);
      const row=this.store.mapping(owner,result.goal.id);const goal=this.presentGoal(result.goal,row);this.store.snapshot(goal.id,goal);
      this.publish(this.store.append(owner,goal.id,'goal',{goal},'goal-create:'+owner+':'+input.requestId));
      void this.ensureSubscription(goal.id).catch(()=>{});
      return {ok:true,goal,timeline:goal.timeline||[],outputs:goal.outputs||[],approvals:goal.approvals||[]};
    },{replaySafe:true});
  }
  async instruct(owner,id,input){
    this.requireGoal(owner,id);only(input,['requestId','message']);const message=text(input.message,20000,'追加指令');
    return this.mutation(owner,input.requestId,'instruct:'+id,{message},async()=>{
      let saved;try{saved=this.eventReader?.request?.(this.remoteRequestId(owner,input.requestId),owner);}catch{}
      // The upstream MCP preflight rejects terminal goals even when a previous
      // instruct succeeded. Its durable receipt proves that exact request was
      // already accepted; query the current goal rather than appending again.
      if(!saved||saved.operation!=='goal:instruct:'+Number(id)||saved.goal_id!==Number(id))await this.clientFor(owner).tool('dots_instruct_goal',{goal_id:Number(id),message,request_id:this.remoteRequestId(owner,input.requestId)});
      const response=await this.goal(owner,id);this.publish(this.store.append(owner,Number(id),'goal',{goal:response.goal},'goal-instruct:'+owner+':'+input.requestId));return response;
    },{replaySafe:true});
  }
  async control(owner,id,input){this.requireGoal(owner,id);only(input,['requestId','action']);if(!['pause','resume','cancel','wake'].includes(input.action))throw fail('目标操作不支持');return this.mutation(owner,input.requestId,'control:'+id,{action:input.action},async()=>{await this.clientFor(owner).tool('dots_control_goal',{goal_id:Number(id),action:input.action});const result=await this.goal(owner,id);this.publish(this.store.append(owner,Number(id),'goal',{goal:result.goal},'goal-control:'+owner+':'+input.requestId));return result;},{reconcile:async()=>{const result=await this.goal(owner,id);return ({pause:'paused',cancel:'cancelled',resume:'active'})[input.action]===result.goal.status?result:null;}});}
  async timeline(owner,id,{after=0,limit=50}={}){this.requireGoal(owner,id);const result=await this.clientFor(owner).tool('dots_get_timeline',{goal_id:Number(id),after_id:integer(after),limit:integer(limit,1,200)});return {ok:true,timeline:(result.timeline||[]).map(t=>fields(t,timelineKeys)),nextCursor:result.next_cursor,hasMore:result.has_more};}
  async outputs(owner,id,{limit=50}={}){this.requireGoal(owner,id);const result=await this.clientFor(owner).tool('dots_list_outputs',{goal_id:Number(id),limit:integer(limit,1,200)});return {ok:true,outputs:(result.outputs||[]).map(o=>fields(o,outputKeys))};}
  async output(owner,id){this.authorize(owner);id=integer(id,1);const result=await this.clientFor(owner).tool('dots_read_output',{output_id:id});if(!result.output||!this.store.mapping(owner,Number(result.output.goal_id)))throw fail('输出不存在',404,'not_found');return {ok:true,output:fields(result.output,outputKeys)};}
  async activity(owner,{limit=100}={}){
    this.authorize(owner);limit=integer(limit,1,500);
    const current=await this.manager(owner),schedules=this.schedules.list(owner);
    // Imported history includes the old runtime and integration acceptance runs.
    // Keep those records accessible without mixing them into current activity.
    const tasks=current.tasks.filter(task=>!task.legacyImported);
    const memberships=this.store.db.prepare('SELECT goal_id,issue_key,issue_title FROM dots_issue_members WHERE owner=?').all(owner);
    const conversations=groupIssueTasks(tasks,memberships).map(group=>({id:group.key,type:'conversation',taskId:group.task.id,title:group.title,status:group.task.status,createdAt:millis(group.createdAt),updatedAt:millis(group.updatedAt),lastSummary:group.task.lastSummary||'',runCount:group.tasks.reduce((n,t)=>n+Number(t.runCount||0),0),relatedTaskIds:group.tasks.map(t=>t.id),unread:false,isNew:false}));
    const scheduled=schedules.schedules.map(schedule=>({id:'schedule:'+schedule.id,type:'schedule',scheduleId:schedule.id,taskId:schedule.lastTaskId,title:schedule.title,status:schedule.status,createdAt:schedule.createdAt,updatedAt:schedule.updatedAt,lastSummary:'',schedule,unread:false,isNew:false}));
    let outputs=[];try{outputs=await this.activityReader?.outputs(tasks.map(t=>t.id),owner,{limit})||[];}catch{}
    const reads=new Map(this.store.db.prepare('SELECT activity_id,seen_at FROM dots_activity_reads WHERE owner=?').all(owner).map(row=>[row.activity_id,row.seen_at]));
    const activities=[...conversations,...scheduled].sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,limit).map(item=>({...item,unread:!reads.has(item.id)||item.updatedAt>reads.get(item.id),isNew:!reads.has(item.id)}));
    return {ok:true,activities,outputs,cursor:current.cursor,scheduler:schedules.scheduler,...(current.stale?{stale:true}:{}),hasMore:conversations.length+scheduled.length>limit};
  }
  markActivityRead(owner,id){this.authorize(owner);this.store.db.prepare('INSERT INTO dots_activity_reads(owner,activity_id,seen_at) VALUES(?,?,?) ON CONFLICT(owner,activity_id) DO UPDATE SET seen_at=excluded.seen_at').run(owner,id,Date.now());}
  async conversation(owner,id,{ungrouped=false}={}){
    this.authorize(owner);id=integer(id,1);
    const issue=ungrouped?null:this.store.db.prepare('SELECT issue_key,issue_title FROM dots_issue_members WHERE owner=? AND goal_id=?').get(owner,id);
    if(issue){
      const ids=this.store.db.prepare('SELECT goal_id FROM dots_issue_members WHERE owner=? AND issue_key=? ORDER BY goal_id').all(owner,issue.issue_key).map(row=>Number(row.goal_id));
      const parts=await Promise.all(ids.map(member=>this.conversation(owner,member,{ungrouped:true})));
      const selected=parts.find(part=>Number(part.goal.id)===id),messages=parts.flatMap(part=>part.messages.map(message=>({...message,id:'issue:'+part.goal.id+':'+message.id,sourceTaskId:part.goal.id}))).sort((a,b)=>Number(a.createdAt||0)-Number(b.createdAt||0));
      this.markActivityRead(owner,'issue:'+issue.issue_key);
      return {...selected,goal:{...selected.goal,title:issue.issue_title},messages,outputs:parts.flatMap(part=>part.outputs||[]),relatedGoals:parts.map(part=>({id:part.goal.id,title:part.goal.title,status:part.goal.status,summary:part.goal.last_summary||''})),transcriptAvailable:parts.some(part=>part.transcriptAvailable)};
    }
    if(!this.store.mapping(owner,id))await this.managerSnapshot(owner);
    const result=await this.goal(owner,id);let projection;
    try{projection=this.activityReader?.conversation(id,owner);}catch(error){if(error.status===404)throw error;}
    if(!projection){
      const messages=[{id:'instruction:'+id,role:'user',content:result.goal.instruction||'',createdAt:millis(result.goal.created_at),source:'task_instruction'}];
      for(const event of result.events||[]){if(!['user_instruction','user_message'].includes(event.type))continue;let content=event.payload;try{const parsed=JSON.parse(content);content=typeof parsed==='string'?parsed:parsed.message||parsed.content||content;}catch{}if(content)messages.push({id:'input:'+event.id,role:'user',content,createdAt:millis(event.created_at),source:'user_instruction'});}
      for(const output of result.outputs||[]){const content=readableResult(output.raw_result)||output.notification||output.summary;if(content)messages.push({id:'output:'+output.id,role:'assistant',content,createdAt:millis(output.created_at),source:'worker_summary',runNumber:output.run_number});}
      projection={messages:messages.filter(m=>m.content).sort((a,b)=>a.createdAt-b.createdAt),outputs:result.outputs||[],transcriptAvailable:false};
    }
    projection.messages=projection.messages.map(message=>{const metadata=message.requestId?this.attachments.message(owner,message.requestId):null;return metadata?{...message,content:metadata.text,attachments:metadata.attachments}:this.weixinView(owner,message);});
    this.markActivityRead(owner,'conversation:'+id);return {ok:true,goal:result.goal,...projection};
  }
  async outputFile(owner,id,{format='txt'}={}){
    if(!['txt','json'].includes(format))throw fail('输出格式无效');const {output}=await this.output(owner,id);
    const content=format==='json'?JSON.stringify(output,null,2):readableResult(output.raw_result)||output.notification||output.summary||'';
    const data=Buffer.from(content);return {filename:'任务-'+output.goal_id+'-第'+output.run_number+'次回复.'+format,mimeType:format==='json'?'application/json':'text/plain; charset=utf-8',data,bytes:data.length,sha256:hash(data)};
  }
  artifact(owner,id,key){this.requireGoal(owner,id);return this.activityReader.artifact(integer(id,1),key,owner);}
  async approvals(owner,id){this.requireGoal(owner,id);const result=await this.clientFor(owner).tool('dots_list_approvals',{goal_id:Number(id)});return {ok:true,approvals:(result.approvals||[]).filter(a=>a.goal_id===Number(id)).map(a=>fields(a,approvalKeys))};}
  async decide(owner,id,approvalId,input){
    this.requireGoal(owner,id);approvalId=integer(approvalId,1);only(input,['requestId','decision','confirmedCommand','scope']);if(!['approve','reject'].includes(input.decision))throw fail('审批选项无效');
    if(input.scope!==undefined&&input.scope!=='once'&&!GRANT_SCOPES.includes(input.scope))throw fail('授权范围无效');
    const scope=input.decision==='approve'&&GRANT_SCOPES.includes(input.scope)?input.scope:null;
    const payload={decision:input.decision,...(input.confirmedCommand!==undefined?{confirmedCommand:input.confirmedCommand}:{}),...(scope?{scope}:{})};
    return this.mutation(owner,input.requestId,'approval:'+id+':'+approvalId,payload,async()=>{
      const approval=(await this.approvals(owner,id)).approvals.find(a=>a.id===approvalId);if(!approval)throw fail('审批不存在或已处理',409,'approval_changed');
      if(input.decision==='approve'&&(typeof input.confirmedCommand!=='string'||input.confirmedCommand!==approval.command))throw fail('请确认当前显示的完整命令，命令必须完全一致',409,'approval_changed');
      await this.clientFor(owner).tool('dots_decide_approval',{approval_id:approvalId,decision:input.decision,...(input.decision==='approve'?{confirmed_command:input.confirmedCommand}:{})});
      let grant=null,grantError=null;
      if(scope){try{grant=(await this.clientFor(owner).rpc('dots/grants/create',{approvalId,scope})).grant||null;}catch(cause){grantError=cause?.message||'授权未能保存';}}
      const result={...(await this.goal(owner,id)),...(grant?{grant}:{}),...(grantError?{grantError}:{})};this.publish(this.store.append(owner,Number(id),'goal',{goal:result.goal},'goal-approval:'+owner+':'+input.requestId));return result;
    },{reconcile:async()=>{const result=await this.goal(owner,id);const approval=result.approvals.find(a=>a.id===approvalId);return approval&&(input.decision==='reject'?approval.status==='rejected':['approved','executed','failed'].includes(approval.status))?result:null;}});
  }
  async ensureSubscription(id){
    if(!this.callbackURL)return false;
    if(this.subscriptionInflight.has(id))return this.subscriptionInflight.get(id);
    const owner=this.store.mappedGoal(id)?.owner;if(!owner)throw fail('目标不存在',404,'not_found');
    const row=this.store.db.prepare('SELECT * FROM dots_subscriptions WHERE goal_id=?').get(id);
    if(row?.subscription_id&&row.callback_url===this.callbackURL&&(!row.expires_at||row.expires_at>Date.now()+86400000))return true;
    const promise=(async()=>{
      try{const result=await this.clientFor(owner).rpc('events/subscribe',{name:'goal.notification',arguments:{goal_id:Number(id)},delivery:{mode:'webhook',url:this.callbackURL,secret:this.store.webhookSecret},ttlMs:7*86400000});
        if(!result.id)throw fail('Dots 通知订阅未确认',503);
        this.store.db.prepare('INSERT INTO dots_subscriptions(goal_id,subscription_id,callback_url,expires_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(goal_id) DO UPDATE SET subscription_id=excluded.subscription_id,callback_url=excluded.callback_url,expires_at=excluded.expires_at,updated_at=excluded.updated_at,last_error=\'\'').run(id,result.id,this.callbackURL,result.refreshBefore?Date.parse(result.refreshBefore):null,Date.now());return true;
      }catch(error){this.store.db.prepare("INSERT INTO dots_subscriptions(goal_id,callback_url,updated_at,last_error) VALUES(?,?,?,'subscription_unavailable') ON CONFLICT(goal_id) DO UPDATE SET last_error='subscription_unavailable'").run(id,this.callbackURL,Date.now());return false;}
    })();this.subscriptionInflight.set(id,promise);try{return await promise;}finally{this.subscriptionInflight.delete(id);}
  }
  async ensureSubscriptions(){for(const row of this.store.mappings())await this.ensureSubscription(row.goal_id);}
  async importGoals(){
    if(!this.importPrivateGoals)return;
    const result=await this.clientFor(this.allowedOwner).tool('dots_list_goals',{limit:200});
    for(const goal of result.goals||[]){
      if(this.store.mappedGoal(goal.id)||goal.manager_id&&goal.manager_id!=='manager:'+this.allowedOwner)continue;
      const context=goal.client_context;
      if(context?.host?.startsWith('shiyan_')&&this.store.db.prepare('SELECT conversation_id FROM dots_conversation_claims WHERE owner=? AND conversation_id=?').get(this.allowedOwner,context.conversation_id))continue;
      this.store.bind(this.allowedOwner,'dots-goal-'+goal.id,context?.host||'other',goal);
      const row=this.store.mappedGoal(goal.id),snapshot=this.presentGoal(goal,row);
      if(context)snapshot.originContext=fields(context,['host','conversation_id']);
      this.store.snapshot(goal.id,snapshot);
    }
    this.importSourceTruncated=Boolean(result.source_truncated||result.has_more);
  }
  notification(owner,goalId,notification){
    const eventId='dots-notification:'+goalId+':'+notification.notification_id;
    return this.store.append(owner,goalId,'notification',notification,eventId);
  }
  verifyWebhook(headers,raw){
    const eventId=headers['webhook-id'],stamp=headers['webhook-timestamp'],signature=headers['webhook-signature'];
    if(typeof eventId!=='string'||eventId.length>200||!eventId||typeof stamp!=='string'||!/^\d+$/.test(stamp)||Math.abs(Date.now()/1000-Number(stamp))>300||typeof signature!=='string')throw fail('通知签名无效',401,'invalid_signature');
    const expected=createHmac('sha256',Buffer.from(this.store.webhookSecret.slice(6),'base64')).update(eventId+'.'+stamp+'.').update(raw).digest();
    const valid=signature.split(/\s+/).some(piece=>{const [version,value]=piece.split(',');if(version!=='v1'||!value)return false;const actual=Buffer.from(value,'base64');return actual.length===expected.length&&timingSafeEqual(actual,expected);});
    if(!valid)throw fail('通知签名无效',401,'invalid_signature');return eventId;
  }
  async webhook(headers,raw){
    const webhookId=this.verifyWebhook(headers,raw);let body;try{body=JSON.parse(raw.toString());}catch{throw fail('通知格式无效');}
    if(body.type==='verification'){if(typeof body.challenge!=='string'||body.challenge.length>500)throw fail('通知验证格式无效');return {challenge:body.challenge};}
    if(body.name!=='goal.notification'||body.eventId!==webhookId||!body.data)throw fail('通知类型无效');
    const data=body.data,goalId=integer(data.goal_id,1),notificationId=integer(data.notification_id,1),row=this.store.mappedGoal(goalId);
    if(!row)throw fail('通知目标不存在',404,'not_found');
    const sub=this.store.db.prepare('SELECT subscription_id FROM dots_subscriptions WHERE goal_id=?').get(goalId);
    if(!sub?.subscription_id||sub.subscription_id!==headers['x-mcp-subscription-id'])throw fail('通知订阅尚未登记',503,'subscription_unavailable');
    const payload={goal_id:goalId,notification_id:notificationId,output_id:data.output_id===null?null:integer(data.output_id,1),level:text(data.level,100,'通知级别'),title:text(data.title,200,'通知标题'),message:text(data.message,50000,'通知内容')};
    let event;
    this.store.transaction(()=>{
      const prior=this.store.db.prepare('SELECT body_hash FROM dots_webhook_receipts WHERE event_id=?').get(webhookId);const fingerprint=hash(raw);
      if(prior&&prior.body_hash!==fingerprint)throw fail('通知标识冲突',409,'event_conflict');
      this.store.db.prepare('INSERT OR IGNORE INTO dots_webhook_receipts(event_id,body_hash,received_at) VALUES(?,?,?)').run(webhookId,fingerprint,Date.now());event=this.notification(row.owner,goalId,payload);
    });
    this.publish(event);
    // Acceptance follows durable commit. Runtime ACK and snapshot refresh are
    // separate recovery work, and never mean that a human read the message.
    void this.goal(row.owner,goalId).catch(()=>{});return {ok:true,durable:true};
  }
  async recover(){
    if(this.recovering)return;this.recovering=true;
    try{for(const row of this.store.db.prepare('SELECT owner FROM dots_managers').all())try{await this.syncManagerActivity(row.owner);}catch{}await this.importGoals();for(const row of this.store.mappings()){
      const owner=row.owner;
      await this.ensureSubscription(row.goal_id);
      let after=this.store.db.prepare('SELECT cursor FROM dots_runtime_cursors WHERE goal_id=?').get(row.goal_id)?.cursor||0;
      const consumer='shiyan:'+hash(row.owner)+':goal:'+row.goal_id;
      for(let page=0;page<10;page++){
        const result=await this.clientFor(owner).tool('dots_list_notifications',{goal_id:Number(row.goal_id),after_id:after,limit:200,consumer_id:consumer});const events=[];
        this.store.transaction(()=>{
          for(const n of result.notifications||[]){if(n.goal_id!==row.goal_id)throw fail('Dots 通知归属不一致',502);const event=this.notification(row.owner,row.goal_id,{goal_id:n.goal_id,notification_id:n.id,output_id:n.output_id??null,level:n.level,title:n.title,message:n.body});if(event)events.push(event);}
          after=integer(result.next_cursor??after);this.store.db.prepare('INSERT INTO dots_runtime_cursors(goal_id,cursor) VALUES(?,?) ON CONFLICT(goal_id) DO UPDATE SET cursor=MAX(cursor,excluded.cursor)').run(row.goal_id,after);
        });
        for(const event of events)this.publish(event);
        if(after>0)await this.clientFor(owner).tool('dots_ack_notifications',{consumer_id:consumer,notification_id:after});
        if(!result.has_more)break;
      }
    }}finally{this.recovering=false;}
  }
  events(owner,{after=0,limit=100}={}){this.authorize(owner);const batch=this.store.events(owner,integer(after),integer(limit,1,500));return {...batch,events:batch.events.map(event=>this.presentEvent(owner,event))};}
  acknowledge(owner,input){this.authorize(owner);only(input,['consumerId','cursor']);return this.store.ack(owner,identifier(input.consumerId,'设备接收标识'),integer(input.cursor));}
  stream(owner,res,after=0){
    this.authorize(owner);after=integer(after);res.socket?.setNoDelay(true);res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'close','X-Accel-Buffering':'no'});res.flushHeaders();
    // Registration and replay run synchronously, so callbacks cannot land in a
    // gap between reading the durable cursor and attaching the live listener.
    if(!this.listeners.has(owner))this.listeners.set(owner,new Set());this.listeners.get(owner).add(res);
    let cursor=after;do{const batch=this.events(owner,{after:cursor,limit:500});for(const event of batch.events)res.write(`id: ${event.seq}\nevent: update\ndata: ${JSON.stringify(event)}\n\n`);cursor=batch.cursor;if(!batch.hasMore)break;}while(!res.destroyed);
    const ping=setInterval(()=>{if(!res.destroyed)res.write(': keepalive\n\n');},15000);ping.unref();res.on('close',()=>{clearInterval(ping);this.listeners.get(owner)?.delete(res);});
  }
}
