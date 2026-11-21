import {validateRegistrationEvent} from '../boss-codex-service/shiyan-v2/registration-events.ts';
import path from 'node:path';
import {createDotsRelationship} from './dots-relationship.ts';
import { mkdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';

const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const encode = value => JSON.stringify(stable(value));
// 2100-01-01（秒）。next_wake_at 不小于此值表示因模型登录失效而停放。
export const AUTH_PARKED_UNTIL = 4102444800;
const decode = (value, fallback = {}) => { try { return JSON.parse(value); } catch { return fallback; } };
const error = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode });
const terminal = status => ['done', 'cancelled'].includes(status);

// Logical managers share a database while all private state is bound to managerId.
// Only the original owner may adopt legacy records without an owner.
export interface ManagerStoreOptions {
  db: any;
  ownerId?: string;
  workspaceRoot?: string;
  now?: () => number;
  workerLimit?: number;
  leaseSeconds?: number;
  importLegacyGoals?: boolean;
}
export function createManagerStore({ db, ownerId = 'shiyan-private-owner', workspaceRoot, now = () => Math.floor(Date.now() / 1000), workerLimit = 2, leaseSeconds = 60, importLegacyGoals = ownerId === (process.env.DOTS_OWNER_ID || 'shiyan-private-owner') }: ManagerStoreOptions) {
  const managerId = 'manager:' + ownerId;
  let transactionId = 0,transactionDepth=0;
  const afterCommit=[];
  const committedEffect=fn=>{if(transactionDepth)afterCommit.push(fn);else fn();};
  const transaction = fn => {
    const name = 'manager_store_' + (++transactionId);
    const effectsStart=afterCommit.length;db.exec('SAVEPOINT ' + name);transactionDepth++;
    try { const result = fn(); db.exec('RELEASE ' + name);transactionDepth--;if(!transactionDepth)for(const effect of afterCommit.splice(0))try{effect();}catch{}return result; }
    catch (cause) { db.exec('ROLLBACK TO ' + name); db.exec('RELEASE ' + name);transactionDepth--;afterCommit.splice(effectsStart);throw cause; }
  };
  const columns = new Set(db.prepare('PRAGMA table_info(goals)').all().map(row => row.name));
  for (const [name, type] of Object.entries({manager_id:'TEXT', control_revision:'INTEGER NOT NULL DEFAULT 0', acceptance_status:"TEXT NOT NULL DEFAULT 'pending'", acceptance_criteria:"TEXT NOT NULL DEFAULT ''", resource_key:"TEXT NOT NULL DEFAULT ''", origin_host:"TEXT NOT NULL DEFAULT 'other'", legacy_imported:'INTEGER NOT NULL DEFAULT 0'})) {
    if (!columns.has(name)) db.exec('ALTER TABLE goals ADD COLUMN ' + name + ' ' + type);
  }
  const approvalColumns=new Set(db.prepare('PRAGMA table_info(approvals)').all().map(row=>row.name));
  for(const [name,type] of Object.entries({control_revision:'INTEGER',payload_hash:'TEXT'}))if(!approvalColumns.has(name))db.exec('ALTER TABLE approvals ADD COLUMN '+name+' '+type);
  db.exec(`
    CREATE TABLE IF NOT EXISTS manager_registration_notices(event_id TEXT PRIMARY KEY,source TEXT NOT NULL,username TEXT NOT NULL,email TEXT NOT NULL DEFAULT '',registered_at INTEGER NOT NULL,message_id INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS managers(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL UNIQUE,name TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',control_revision INTEGER NOT NULL DEFAULT 0,thread_id TEXT,last_summary TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,next_wake_at INTEGER);
    CREATE TABLE IF NOT EXISTS manager_messages(id INTEGER PRIMARY KEY AUTOINCREMENT,manager_id TEXT NOT NULL,role TEXT NOT NULL,content TEXT NOT NULL,task_id INTEGER,request_id TEXT,host TEXT,created_at INTEGER NOT NULL,responds_to_message_ids TEXT NOT NULL DEFAULT '[]');
    CREATE TABLE IF NOT EXISTS manager_notes(id INTEGER PRIMARY KEY AUTOINCREMENT,manager_id TEXT NOT NULL,scope TEXT NOT NULL,note_key TEXT NOT NULL,content TEXT NOT NULL,source_message_id INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(manager_id,scope,note_key));
    CREATE TABLE IF NOT EXISTS manager_inbox(id INTEGER PRIMARY KEY AUTOINCREMENT,manager_id TEXT NOT NULL,type TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL,consumed_at INTEGER);
    CREATE INDEX IF NOT EXISTS idx_manager_inbox ON manager_inbox(manager_id,consumed_at,id);
    CREATE TABLE IF NOT EXISTS manager_activity(id INTEGER PRIMARY KEY AUTOINCREMENT,manager_id TEXT NOT NULL,task_id INTEGER,kind TEXT NOT NULL,message TEXT NOT NULL,data TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS manager_requests(request_id TEXT PRIMARY KEY,operation TEXT NOT NULL,fingerprint TEXT NOT NULL,response TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS manager_scoped_requests(manager_id TEXT NOT NULL,request_id TEXT NOT NULL,operation TEXT NOT NULL,fingerprint TEXT NOT NULL,response TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(manager_id,request_id));
    CREATE TABLE IF NOT EXISTS manager_task_dependencies(task_id INTEGER NOT NULL,depends_on INTEGER NOT NULL,PRIMARY KEY(task_id,depends_on),CHECK(task_id<>depends_on));
    CREATE TABLE IF NOT EXISTS manager_runs(id TEXT PRIMARY KEY,manager_id TEXT NOT NULL,goal_id INTEGER,kind TEXT NOT NULL,state TEXT NOT NULL,worker_id TEXT NOT NULL,fence INTEGER NOT NULL,control_revision INTEGER NOT NULL,inbox_watermark INTEGER NOT NULL DEFAULT 0,lease_expires_at INTEGER NOT NULL,heartbeat_at INTEGER NOT NULL,thread_id TEXT,started_at INTEGER NOT NULL,finished_at INTEGER,summary TEXT NOT NULL DEFAULT '');
    CREATE UNIQUE INDEX IF NOT EXISTS idx_manager_live_task ON manager_runs(goal_id) WHERE state='running' AND kind='worker';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_manager_live_lane ON manager_runs(manager_id) WHERE state='running' AND kind='manager';
    CREATE TABLE IF NOT EXISTS manager_actions(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,ordinal INTEGER NOT NULL,payload TEXT NOT NULL,payload_hash TEXT NOT NULL,state TEXT NOT NULL,result TEXT,checkpoint TEXT,started_at INTEGER NOT NULL,finished_at INTEGER,UNIQUE(run_id,ordinal));
    CREATE TABLE IF NOT EXISTS manager_resources(resource_key TEXT PRIMARY KEY,run_id TEXT NOT NULL,lease_expires_at INTEGER NOT NULL);
  `);
  if (!db.prepare('PRAGMA table_info(manager_registration_notices)').all().some(column => column.name === 'email')) {
    db.exec("ALTER TABLE manager_registration_notices ADD COLUMN email TEXT NOT NULL DEFAULT ''");
  }
  if (!db.prepare('PRAGMA table_info(manager_messages)').all().some(column => column.name === 'responds_to_message_ids')) {
    db.exec("ALTER TABLE manager_messages ADD COLUMN responds_to_message_ids TEXT NOT NULL DEFAULT '[]'");
  }

  const deliveryColumns=new Set(db.prepare('PRAGMA table_info(manager_messages)').all().map(column=>column.name));
  for(const [name,type] of Object.entries({delivery_state:"TEXT NOT NULL DEFAULT 'completed'",revision:'INTEGER NOT NULL DEFAULT 0',stream_run_id:'TEXT',origin:"TEXT NOT NULL DEFAULT 'reply'",topic_id:'TEXT',proactive_reason:"TEXT NOT NULL DEFAULT ''",card:"TEXT NOT NULL DEFAULT ''"}))if(!deliveryColumns.has(name))db.exec('ALTER TABLE manager_messages ADD COLUMN '+name+' '+type);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_manager_message_stream_run ON manager_messages(stream_run_id) WHERE stream_run_id IS NOT NULL');

  const runColumns=new Set(db.prepare('PRAGMA table_info(manager_runs)').all().map(column=>column.name));
  for(const [name,type] of Object.entries({purpose:"TEXT NOT NULL DEFAULT 'reply'",content_candidate_id:'TEXT',reflection_id:'TEXT'}))if(!runColumns.has(name))db.exec('ALTER TABLE manager_runs ADD COLUMN '+name+' '+type);
  const conversationListeners=new Set();
  const subscribeConversationEvents=listener=>{conversationListeners.add(listener);return ()=>conversationListeners.delete(listener);};
  const conversationChanged=()=>committedEffect(()=>{for(const listener of conversationListeners)try{listener();}catch{}});
  const contentListeners=new Set();
  const subscribeContentEvents=listener=>{contentListeners.add(listener);return ()=>contentListeners.delete(listener);};
  let relationship,mailReplies=null;
  const managerRow = () => db.prepare('SELECT * FROM managers WHERE id=?').get(managerId);
  const goal = id => db.prepare('SELECT * FROM goals WHERE id=? AND manager_id=?').get(Number(id), managerId);
  const requireGoal = id => { const row = goal(id); if (!row) throw error('Task not found', 404); return row; };
  const requireOwner = value => { if (value !== undefined && value !== ownerId) throw error('Manager not found', 404); };
  const activityEvent = (kind, message, data = {}, taskId = null) => {
    const inserted = db.prepare('INSERT INTO manager_activity(manager_id,task_id,kind,message,data,created_at) VALUES(?,?,?,?,?,?)').run(managerId,taskId,kind,String(message),encode(data),now());
    return Number(inserted.lastInsertRowid);
  };
  const enqueue = (type, payload) => {
    db.prepare('INSERT INTO manager_inbox(manager_id,type,payload,created_at) VALUES(?,?,?,?)').run(managerId,type,encode(payload),now());
    const current=managerRow(),due=type==='worker_report'?now()+2:now();
    // 模型登录失效时总管处于“停放”状态：只有用户新消息能唤醒，后台事件不触发重试。
    if(current.next_wake_at>=AUTH_PARKED_UNTIL&&type!=='user_message')return;
    db.prepare('UPDATE managers SET next_wake_at=?,updated_at=? WHERE id=?').run(current.next_wake_at==null?due:Math.min(current.next_wake_at,due),now(),managerId);
  };
  const ensure = () => {
    db.prepare("INSERT OR IGNORE INTO managers(id,owner_id,name,created_at,updated_at) VALUES(?,?,'大内总管',?,?)").run(managerId,ownerId,now(),now());
    // Reparenting is metadata only: no status, due time or thread changes.
    if(importLegacyGoals)db.prepare("UPDATE goals SET manager_id=?,legacy_imported=1,acceptance_status=CASE WHEN status='done' THEN 'accepted' ELSE acceptance_status END WHERE manager_id IS NULL").run(managerId);
    return managerRow();
  };
  ensure();
  const approvalHash=(row,revision)=>createHash('sha256').update(encode({goalId:Number(row.goal_id),reason:row.reason,command:row.command,controlRevision:Number(revision)})).digest('hex');
  for(const row of db.prepare("SELECT * FROM approvals WHERE payload_hash IS NULL AND status='pending'").all()){
    const parent=goal(row.goal_id);if(parent)db.prepare('UPDATE approvals SET control_revision=?,payload_hash=? WHERE id=?').run(parent.control_revision,approvalHash(row,parent.control_revision),row.id);
  }
  const projectResourceKey = value => {
    const key=String(value||'');
    return key.startsWith('mac:/')?'mac:'+(path.posix.normalize(key.slice(4)).replace(/\/+$/,'')||'/'):key;
  };
  const taskResourceKey = row => {
    if(row.resource_key!=='mac:executor')return projectResourceKey(row.resource_key);
    // Older versions replaced project identity with the shared executor lock.
    // Recover the original project's durable Mac path, never treat that lock
    // name as permission to continue a task from an unrelated project.
    const actions=db.prepare("SELECT a.payload FROM manager_actions a JOIN manager_runs r ON r.id=a.run_id WHERE r.goal_id=? AND a.state<>'planned' ORDER BY a.started_at,a.ordinal,a.id").all(row.id);
    for(const record of actions){
      const action=decode(record.payload);
      if(action.type==='mac_codex'&&typeof action.path==='string'&&action.path.startsWith('/'))return projectResourceKey('mac:'+action.path);
    }
    return row.resource_key;
  };
  const task = row => ({id:Number(row.id),managerId,title:row.title,instruction:row.instruction,status:row.status,acceptanceStatus:row.acceptance_status,acceptanceCriteria:row.acceptance_criteria,dependencies:db.prepare('SELECT depends_on FROM manager_task_dependencies WHERE task_id=? ORDER BY depends_on').all(row.id).map(item=>Number(item.depends_on)),controlRevision:Number(row.control_revision),createdAt:row.created_at,updatedAt:row.updated_at,nextWakeAt:row.next_wake_at,lastSummary:row.last_summary,runCount:row.run_count,originHost:row.origin_host,resourceKey:taskResourceKey(row),legacyImported:Boolean(row.legacy_imported)});
  const messageRow = row => ({id:Number(row.id),role:row.role,content:row.content,taskId:row.task_id,requestId:row.request_id,host:row.host,createdAt:row.created_at,respondsToMessageIds:decode(row.responds_to_message_ids,[]),deliveryState:row.delivery_state||'completed',revision:Number(row.revision||0),origin:row.origin||'reply',topicId:row.topic_id||null,proactiveReason:row.proactive_reason||'',...(row.card?{card:decode(row.card,null)}:{}),...(row.origin==='proactive'?feedbackOf(row.id):{})});
  const feedbackOf=id=>{try{const f=db.prepare('SELECT value FROM dots_message_feedback WHERE manager_id=? AND message_id=?').get(managerId,Number(id));return f?{feedback:f.value}:{};}catch{return {};}};
  // Correlate the committed run's actual input, never the latest user message.
  // Background task reports do not complete a waiting voice turn. Checking the
  // persisted source also keeps malformed/foreign inbox payloads out of replies.
  const respondsToMessageIds = (run, inbox) => {
    if (run.manager_id !== managerId || run.kind !== 'manager') return [];
    const source = db.prepare("SELECT 1 FROM manager_messages WHERE id=? AND manager_id=? AND role='user'");
    return [...new Set(inbox.filter(item => item.type === 'user_message').map(item => decode(item.payload).id)
      .filter(id => Number.isSafeInteger(id) && id > 0 && source.get(id,managerId)))];
  };
  const snapshot = () => {
    const row = managerRow();
    const history=messages({limit:100});
    return {id:row.id,ownerId:row.owner_id,name:row.name,status:row.status,activityCursor:Number(db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM manager_activity WHERE manager_id=?').get(managerId).id),controlRevision:Number(row.control_revision),createdAt:row.created_at,updatedAt:row.updated_at,lastSummary:row.last_summary,workerLimit,runningWorkers:Number(db.prepare("SELECT COUNT(*) AS n FROM manager_runs WHERE manager_id=? AND kind='worker' AND state='running'").get(managerId).n),tasks:db.prepare('SELECT * FROM goals WHERE manager_id=? ORDER BY id DESC LIMIT 500').all(managerId).map(task),messages:history.messages,hasMoreMessages:history.hasMore,oldestMessageId:history.nextBeforeId,notes:db.prepare('SELECT * FROM manager_notes WHERE manager_id=? ORDER BY updated_at DESC LIMIT 50').all(managerId).map(note=>({id:note.id,key:note.note_key,scope:note.scope,content:note.content,sourceMessageId:note.source_message_id,updatedAt:note.updated_at})),capabilities:{manager:true,delegation:true,dependencies:true,durableRuns:true,workerConcurrency:workerLimit,apns:false,hardBudgets:false,recurringSchedules:false}};
  };
  const receipt = (requestId, operation, payload, mutate) => transaction(() => {
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestId)) throw error('A valid requestId is required',400);
    const fingerprint=createHash('sha256').update(encode(payload)).digest('hex');
    const prior=importLegacyGoals?db.prepare('SELECT * FROM manager_requests WHERE request_id=?').get(requestId):db.prepare('SELECT * FROM manager_scoped_requests WHERE manager_id=? AND request_id=?').get(managerId,requestId);
    if(prior){if(prior.operation!==operation||prior.fingerprint!==fingerprint)throw error('requestId was used for different content');return decode(prior.response);}
    const response=mutate();
    if(importLegacyGoals)db.prepare('INSERT INTO manager_requests(request_id,operation,fingerprint,response,created_at) VALUES(?,?,?,?,?)').run(requestId,operation,fingerprint,encode(response),now());
    else db.prepare('INSERT INTO manager_scoped_requests(manager_id,request_id,operation,fingerprint,response,created_at) VALUES(?,?,?,?,?,?)').run(managerId,requestId,operation,fingerprint,encode(response),now());
    return response;
  });
  // deferManager：先交给“对话订阅”识别，确认不是订阅请求后再 releaseToManager 交给总管。
  const message = (input,{deferManager=false}={}) => {
    const content=String(input.message||'').trim();
    if(!content||content.length>20000)throw error('message must contain 1–20000 characters',400);
    const taskId=input.taskId==null?null:Number(input.taskId);
    if(taskId!==null)requireGoal(taskId);
    const host=input.host||'other';if(!['shiyan_web','shiyan_desktop','shiyan_mobile','chatgpt','weixin','other'].includes(host))throw error('Invalid host',400);
    return receipt(input.requestId,'manager:message',{content,taskId,host},()=>{
      const result=db.prepare("INSERT INTO manager_messages(manager_id,role,content,task_id,request_id,host,created_at) VALUES(?,'user',?,?,?,?,?)").run(managerId,content,taskId,input.requestId,host,now());
      const row=messageRow(db.prepare('SELECT * FROM manager_messages WHERE id=?').get(Number(result.lastInsertRowid)));
      db.prepare('UPDATE managers SET control_revision=control_revision+1,updated_at=? WHERE id=?').run(now(),managerId);
      relationship.observeUser(row);
      if(!deferManager)enqueue('user_message',row);activityEvent('user_message',content,{message:row},taskId);
      return {ok:true,accepted:true,message:row,manager:snapshot()};
    });
  };
  const controlTask = (id, action, {message: instruction}={}) => {
    const row=requireGoal(id);
    if(terminal(row.status)){if(action==='cancel'&&row.status==='cancelled')return;throw error('Terminal tasks cannot be restarted');}
    const pending=db.prepare("SELECT id FROM approvals WHERE goal_id=? AND status IN ('pending','executing') LIMIT 1").get(row.id);
    if(['resume','wake','instruct'].includes(action)&&pending)throw error('Resolve pending approval first');
    if(action==='pause'||action==='cancel')db.prepare('UPDATE goals SET status=?,next_wake_at=NULL,control_revision=control_revision+1,updated_at=? WHERE id=?').run(action==='pause'?'paused':'cancelled',now(),row.id);
    else if(action==='resume'||action==='wake'||action==='instruct'){
      if(action==='resume'&&!['paused','blocked'].includes(row.status))throw error('Only paused or blocked tasks can resume');
      if(action==='instruct'&&row.status==='paused')throw error('Resume the paused task first');
      if(db.prepare("SELECT 1 FROM manager_actions a JOIN manager_runs r ON a.run_id=r.id WHERE r.goal_id=? AND a.state='unknown' LIMIT 1").get(row.id))throw error('An uncertain execution must be reconciled before retry');
      db.prepare("UPDATE goals SET status='active',control_revision=control_revision+1,next_wake_at=?,updated_at=? WHERE id=?").run(now(),now(),row.id);
      db.prepare('INSERT INTO events(goal_id,type,payload,created_at) VALUES(?,?,?,?)').run(row.id,action==='instruct'?'user_instruction':'manual_'+action,instruction||action,now());
    }else throw error('Unsupported task control',400);
    activityEvent('task_control',action+': '+row.title,{action},row.id);
  };
  const control = input => receipt(input.requestId||randomUUID(),'manager:control',{action:input.action},()=>{
    if(!['pause','resume','cancel','wake'].includes(input.action))throw error('Unsupported manager control',400);
    if(input.action==='wake'&&managerRow().status!=='active')throw error('Resume the manager explicitly before waking it');
    const status=input.action==='pause'?'paused':input.action==='cancel'?'cancelled':'active';
    db.prepare('UPDATE managers SET status=?,control_revision=control_revision+1,updated_at=?,next_wake_at=? WHERE id=?').run(status,now(),now(),managerId);
    if(input.action==='cancel')for(const row of db.prepare("SELECT id FROM goals WHERE manager_id=? AND status NOT IN ('done','cancelled')").all(managerId))controlTask(row.id,'cancel');
    activityEvent('manager_control',input.action,{action:input.action});enqueue('manager_control',{action:input.action});
    return {ok:true,manager:snapshot()};
  });
  const createTasks = (items, {host='other'}={}) => transaction(()=>{
    if(managerRow().status!=='active'&&items.length)throw error('Manager dispatch is paused');
    if(!Array.isArray(items)||items.length>8)throw error('At most 8 tasks per plan',400);
    const byKey=new Map();
    for(const item of items){if(typeof item.key!=='string'||!item.key.trim()||byKey.has(item.key))throw error('Task keys must be unique',400);byKey.set(item.key,item);if(!String(item.title||'').trim()||!String(item.instruction||'').trim())throw error('Task title and instruction required',400);}
    const issueTitle=value=>String(value).normalize('NFKC').replace(/\s+/gu,' ').trim().toLocaleLowerCase('en-US');
    const existing=db.prepare("SELECT id,title,resource_key FROM goals WHERE manager_id=? AND legacy_imported=0 AND (status NOT IN ('done','cancelled') OR (status='done' AND acceptance_status<>'accepted'))").all(managerId);
    const issueTitles=new Set(existing.map(row=>issueTitle(row.title)+'\0'+taskResourceKey(row)));
    for(const item of items){
      const title=issueTitle(String(item.title).slice(0,200))+'\0'+projectResourceKey(String(item.resourceKey||item.resource_key||'').slice(0,1000));
      if(issueTitles.has(title))throw error('This issue already has a task: '+String(item.title)+'. Continue the existing task with instructions, controls or review instead of creating a duplicate.',409);
      issueTitles.add(title);
    }
    const seen=new Set(),visiting=new Set();
    const visit=key=>{if(visiting.has(key))throw error('Dependency cycle',400);if(seen.has(key))return;visiting.add(key);for(const dependency of byKey.get(key).dependencies||[]){if(byKey.has(dependency))visit(dependency);else if(/^task:\d+$/.test(dependency))requireGoal(Number(dependency.slice(5)));else throw error('Unknown dependency '+dependency,400);}visiting.delete(key);seen.add(key);};
    for(const key of byKey.keys())visit(key);
    const ids=new Map();
    for(const item of items){
      const inserted=db.prepare("INSERT INTO goals(title,instruction,status,workspace,created_at,updated_at,next_wake_at,manager_id,acceptance_criteria,resource_key,origin_host) VALUES(?,?,'active','',?,?,?,?,?,?,?)").run(String(item.title).slice(0,200),String(item.instruction).slice(0,20000),now(),now(),now(),managerId,String(item.acceptanceCriteria||item.acceptance_criteria||'').slice(0,4000),String(item.resourceKey||item.resource_key||'').slice(0,1000),host);
      const id=Number(inserted.lastInsertRowid),workspace=path.join(workspaceRoot||'/tmp/dots-manager-workspaces',String(id));mkdirSync(workspace,{recursive:true});
      db.prepare('UPDATE goals SET workspace=? WHERE id=?').run(workspace,id);ids.set(item.key,id);activityEvent('task_created',item.title,{key:item.key},id);
    }
    for(const item of items)for(const dependency of item.dependencies||[])db.prepare('INSERT INTO manager_task_dependencies(task_id,depends_on) VALUES(?,?)').run(ids.get(item.key),ids.get(dependency)||Number(dependency.slice(5)));
    return [...ids.values()].map(id=>task(goal(id)));
  });
  const taskEligibility = id => {
    const row=goal(id);
    return Boolean(row&&row.status==='active'&&row.next_wake_at!==null&&row.next_wake_at<=now()&&managerRow().status==='active'&&!db.prepare("SELECT 1 FROM manager_task_dependencies d JOIN goals g ON g.id=d.depends_on WHERE d.task_id=? AND (g.status<>'done' OR g.acceptance_status<>'accepted') LIMIT 1").get(row.id)&&!db.prepare("SELECT 1 FROM approvals WHERE goal_id=? AND status IN ('pending','executing') LIMIT 1").get(row.id)&&!db.prepare("SELECT 1 FROM manager_actions a JOIN manager_runs r ON a.run_id=r.id WHERE r.goal_id=? AND a.state='unknown' LIMIT 1").get(row.id));
  };
  const claim = (kind, goalId, workerId) => transaction(()=>{
    // Obsolete unbacked opportunities are never ordinary manager input.
    if(kind==='manager')db.prepare("UPDATE manager_inbox SET consumed_at=? WHERE manager_id=? AND type='proactive_opportunity' AND consumed_at IS NULL").run(now(),managerId);
    const row=goalId==null?managerRow():goal(goalId);if(!row)return null;
    if(kind==='worker'&&(!taskEligibility(goalId)||Number(db.prepare("SELECT COUNT(*) AS n FROM manager_runs WHERE manager_id=? AND kind='worker' AND state='running'").get(managerId).n)>=workerLimit))return null;
    if(kind==='manager'&&(!db.prepare('SELECT 1 FROM manager_inbox WHERE manager_id=? AND consumed_at IS NULL LIMIT 1').get(managerId)||row.next_wake_at>now()))return null;
    if(db.prepare("SELECT 1 FROM manager_runs WHERE manager_id=? AND kind=? AND state='running' AND (goal_id=? OR (? IS NULL AND goal_id IS NULL))").get(managerId,kind,goalId,goalId))return null;
    const resource=kind==='worker'?(row.resource_key?((importLegacyGoals?'':managerId+':')+row.resource_key):'goal:'+goalId):'manager:'+managerId;
    if(db.prepare('SELECT 1 FROM manager_resources WHERE resource_key=?').get(resource))return null;
    const fence=Number(db.prepare('SELECT COALESCE(MAX(fence),0)+1 AS fence FROM manager_runs WHERE manager_id=? AND kind=? AND (goal_id=? OR (? IS NULL AND goal_id IS NULL))').get(managerId,kind,goalId,goalId).fence);
    const inboxWatermark=kind==='manager'?Number(db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM manager_inbox WHERE manager_id=? AND consumed_at IS NULL').get(managerId).id):Number(db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM events WHERE goal_id=? AND consumed_at IS NULL').get(goalId).id);
    const runId=randomUUID();
    db.prepare("INSERT INTO manager_runs(id,manager_id,goal_id,kind,state,worker_id,fence,control_revision,inbox_watermark,lease_expires_at,heartbeat_at,thread_id,started_at) VALUES(?,?,?,?,'running',?,?,?,?,?,?,?,?)").run(runId,managerId,goalId,kind,workerId||'runtime',fence,row.control_revision,inboxWatermark,now()+leaseSeconds,now(),row.thread_id||null,now());
    db.prepare('INSERT INTO manager_resources(resource_key,run_id,lease_expires_at) VALUES(?,?,?)').run(resource,runId,now()+leaseSeconds);
    if(goalId!=null)activityEvent('worker_started','开始办理：'+row.title,{runId},goalId);
    return db.prepare('SELECT * FROM manager_runs WHERE id=?').get(runId);
  });
  const claimContentReview=({workerId='content-review'}={})=>transaction(()=>{
    if(managerRow().status!=='active'||db.prepare('SELECT 1 FROM manager_inbox WHERE manager_id=? AND consumed_at IS NULL LIMIT 1').get(managerId)||db.prepare("SELECT 1 FROM manager_messages WHERE manager_id=? AND delivery_state='streaming' LIMIT 1").get(managerId)||db.prepare("SELECT 1 FROM manager_runs WHERE manager_id=? AND kind='manager' AND state='running'").get(managerId)||db.prepare('SELECT 1 FROM manager_resources WHERE resource_key=?').get('manager:'+managerId))return null;
    const candidate=relationship.nextCandidate();if(!candidate)return null;
    const runId=randomUUID(),row=managerRow(),fence=Number(db.prepare("SELECT COALESCE(MAX(fence),0)+1 AS fence FROM manager_runs WHERE manager_id=? AND kind='manager'").get(managerId).fence);
    db.prepare("INSERT INTO manager_runs(id,manager_id,goal_id,kind,state,worker_id,fence,control_revision,inbox_watermark,lease_expires_at,heartbeat_at,started_at,purpose,content_candidate_id,reflection_id) VALUES(?,?,NULL,'manager','running',?,?,?,0,?,?,?,'content_review',?,?)").run(runId,managerId,workerId,fence,row.control_revision,now()+leaseSeconds,now(),now(),candidate.kind==='reflection'?null:candidate.id,candidate.kind==='reflection'?candidate.id:null);
    db.prepare('INSERT INTO manager_resources(resource_key,run_id,lease_expires_at) VALUES(?,?,?)').run('manager:'+managerId,runId,now()+leaseSeconds);
    const run=db.prepare('SELECT * FROM manager_runs WHERE id=?').get(runId);
    if(!relationship.bindRun(candidate,run))throw error('Content candidate is no longer pending');
    return run;
  });
  const isCurrent = run => {
    if(!run||run.manager_id!==managerId)return false;
    const live=db.prepare('SELECT * FROM manager_runs WHERE id=?').get(run.id),row=run.goal_id==null?managerRow():goal(run.goal_id);
    return Boolean(live&&row&&live.state==='running'&&Number(live.fence)===Number(run.fence)&&live.lease_expires_at>now()&&Number(row.control_revision)===Number(run.control_revision)&&(run.kind==='manager'||(run.kind==='approval'?row.status==='waiting_approval':row.status==='active')));
  };
  const renewRun = (runId,fence) => transaction(()=>{
    const result=db.prepare("UPDATE manager_runs SET heartbeat_at=?,lease_expires_at=? WHERE id=? AND manager_id=? AND fence=? AND state='running' AND lease_expires_at>?").run(now(),now()+leaseSeconds,runId,managerId,fence,now());
    if(result.changes)db.prepare('UPDATE manager_resources SET lease_expires_at=? WHERE run_id=?').run(now()+leaseSeconds,runId);
    return Boolean(result.changes);
  });
  const checkpointThread = (run, threadId) => transaction(()=>{
    if(relationship?.forRun(run))return;
    if(!threadId||!db.prepare("SELECT 1 FROM manager_runs WHERE id=? AND manager_id=? AND fence=? AND state='running'").get(run.id,managerId,run.fence))return;
    db.prepare('UPDATE manager_runs SET thread_id=? WHERE id=?').run(threadId,run.id);
    // A late thread-start event is still useful recovery data, but cannot
    // override a newer run's thread after the lease has been fenced out.
    if(run.kind==='manager'&&db.prepare('SELECT purpose FROM manager_runs WHERE id=? AND fence=?').get(run.id,run.fence)?.purpose!=='content_review')db.prepare('UPDATE managers SET thread_id=? WHERE id=?').run(threadId,managerId);
    else db.prepare('UPDATE goals SET thread_id=? WHERE id=?').run(threadId,run.goal_id);
  });
  const planActions = (run,actions) => transaction(()=>{
    if(relationship.forRun(run))throw error('Content reviews cannot plan actions');
    if(!isCurrent(run))return false;
    for(const [ordinal,action] of (actions||[]).slice(0,8).entries()){
      const payload=encode(action),payloadHash=createHash('sha256').update(payload).digest('hex');
      db.prepare("INSERT OR IGNORE INTO manager_actions(id,run_id,ordinal,payload,payload_hash,state,started_at) VALUES(?,?,?,?,?,'planned',?)").run(run.id+':'+ordinal,run.id,ordinal,payload,payloadHash,now());
    }
    return true;
  });
  const beginAction = (run,ordinal,action) => transaction(()=>{
    if(relationship.forRun(run))throw error('Content reviews cannot execute actions');
    if(!isCurrent(run))throw error('Run superseded before action');
    const id=run.id+':'+ordinal,payload=encode(action),payloadHash=createHash('sha256').update(payload).digest('hex');
    const prior=db.prepare('SELECT * FROM manager_actions WHERE id=?').get(id);
    if(prior){if(prior.payload_hash!==payloadHash)throw error('Action identity conflict');if(prior.state==='succeeded'||prior.state==='failed')return prior;if(prior.state!=='planned')throw error('Action outcome is uncertain; reconciliation required');}
    if(action.type==='mac_codex'&&importLegacyGoals){
      const parent=requireGoal(run.goal_id),resource=taskResourceKey(parent);
      if(!parent.resource_key||parent.resource_key==='mac:executor')db.prepare('UPDATE goals SET resource_key=? WHERE id=?').run(resource&&resource!=='mac:executor'?resource:projectResourceKey('mac:'+action.path),run.goal_id);
      for(const resource of ['mac:executor','mac:'+path.posix.normalize(String(action.path))]){
        const lock=db.prepare('SELECT * FROM manager_resources WHERE resource_key=?').get(resource);
        if(lock&&lock.run_id!==run.id){
          db.prepare("INSERT INTO events(goal_id,type,payload,created_at) VALUES(?,'resource_wait',?,?)").run(run.goal_id,'Mac executor busy; the action did not start. Wait for the resource, then continue.',now());
          return {id,state:'deferred',deferred:true};
        }
        db.prepare('INSERT OR IGNORE INTO manager_resources(resource_key,run_id,lease_expires_at) VALUES(?,?,?)').run(resource,run.id,now()+leaseSeconds);
      }
    }
    if(prior)db.prepare("UPDATE manager_actions SET state='started',started_at=? WHERE id=?").run(now(),id);
    else db.prepare("INSERT INTO manager_actions(id,run_id,ordinal,payload,payload_hash,state,started_at) VALUES(?,?,?,?,?,'started',?)").run(id,run.id,ordinal,payload,payloadHash,now());
    return db.prepare('SELECT * FROM manager_actions WHERE id=?').get(id);
  });
  const finishAction = (actionId,result) => transaction(()=>{
    const action=db.prepare('SELECT * FROM manager_actions WHERE id=?').get(actionId);if(!action)return false;
    const run=db.prepare('SELECT * FROM manager_runs WHERE id=?').get(action.run_id);
    if(run?.state!=='running'||run.manager_id!==managerId||action.state!=='started')return false;
    db.prepare('UPDATE manager_actions SET state=?,result=?,finished_at=? WHERE id=?').run(result.uncertain?'unknown':result.ok?'succeeded':'failed',encode(result),now(),actionId);
    db.prepare("INSERT INTO events(goal_id,type,payload,created_at) VALUES(?,'tool_result',?,?)").run(run.goal_id,encode({...result,actionId}),now());
    activityEvent(result.ok?'worker_action':'worker_action_failed',result.type+': '+(result.ok?'完成':'失败'),{actionId,result},run.goal_id);
    if(result.uncertain){db.prepare("UPDATE goals SET status='blocked',next_wake_at=NULL,control_revision=control_revision+1 WHERE id=? AND status IN ('active','waiting_approval')").run(run.goal_id);reportGoal(run.goal_id,'blocked','执行结果不明，操作 '+actionId+' 已锁定；核查后可通过明确结果确认恢复。');}
    return true;
  });
  const finishRun = (run,{summary='',status='completed',threadId}={}) => {
    if(run?.manager_id!==managerId)return false;
    if(threadId)checkpointThread(run,threadId);
    db.prepare("UPDATE manager_runs SET state=?,finished_at=?,summary=? WHERE id=? AND fence=? AND state='running'").run(status,now(),String(summary).slice(0,12000),run.id,run.fence);
    if(!db.prepare("SELECT 1 FROM manager_actions WHERE run_id=? AND state='unknown' LIMIT 1").get(run.id))db.prepare('DELETE FROM manager_resources WHERE run_id=?').run(run.id);
  };
  const commitRun = (run,fn) => transaction(()=>{
    if(!isCurrent(run)){relationship?.cancelRun(run,'回合已被新输入取代');endManagerReply(run,'cancelled');finishRun(run,{status:'superseded'});return {committed:false};}
    const value=fn();finishRun(run,{summary:value?.summary||'',status:'completed'});return {committed:true,value};
  });
  const reportGoal = (id,status,summary) => {
    const row=requireGoal(id);
    if(status==='done'&&!row.legacy_imported)db.prepare("UPDATE goals SET acceptance_status='accepted' WHERE id=?").run(id);
    activityEvent('worker_report',summary||status,{status,acceptanceStatus:goal(id).acceptance_status},row.id);
    enqueue('worker_report',{taskId:row.id,status,summary});
  };
  const acceptTask = (id,{accepted,reason=''}) => {
    const row=requireGoal(id);if(row.status!=='done')throw error('Only reported completed tasks can be accepted');
    if(accepted)db.prepare("UPDATE goals SET acceptance_status='accepted',updated_at=? WHERE id=?").run(now(),row.id);
    else db.prepare("UPDATE goals SET acceptance_status='changes_requested',status='active',control_revision=control_revision+1,next_wake_at=?,updated_at=? WHERE id=?").run(now(),now(),row.id);
    if(!accepted)db.prepare("INSERT INTO events(goal_id,type,payload,created_at) VALUES(?,'review_changes',?,?)").run(row.id,String(reason),now());
    activityEvent(accepted?'task_accepted':'task_changes_requested',String(reason||'验收通过'),{accepted},row.id);
  };
  // The manager model chooses semantic identity; the store never merges tasks
  // by keyword similarity. A continuation must cite current, authenticated user
  // input and retain the existing task/thread, dependencies and action journal.
  const continueTask = (command, sourceIds) => {
    const row=requireGoal(command.task_id??command.taskId);
    if(row.status==='cancelled')throw error('Cancelled tasks cannot be continued');
    const sources=[...new Set(command.source_message_ids||[])];
    if(!sources.length||sources.some(id=>!Number.isSafeInteger(id)||!sourceIds.has(id)))throw error('Continuation requires current user message sources');
    const message=String(command.message||'').trim(),reason=String(command.reason||'').trim();
    if(!message||message.length>20000||!reason||reason.length>2000)throw error('Continuation requires a concrete requirement and matching reason',400);
    const resourceKey=projectResourceKey(String(command.resource_key||'').trim()),existingResource=taskResourceKey(row);
    if(existingResource&&existingResource!==resourceKey)throw error('Continuation project does not match the existing task');
    const approvals=db.prepare("SELECT * FROM approvals WHERE goal_id=? AND status IN ('pending','executing','unknown')").all(row.id);
    const uncertain=db.prepare("SELECT 1 FROM manager_actions a JOIN manager_runs r ON a.run_id=r.id WHERE r.goal_id=? AND a.state='unknown' LIMIT 1").get(row.id);
    const approvalInFlight=approvals.some(approval=>['executing','unknown'].includes(approval.status));
    const reevaluate=row.status!=='paused'&&!approvalInFlight&&!uncertain&&approvals.some(approval=>approval.status==='pending');
    if(reevaluate){
      for(const approval of approvals.filter(approval=>approval.status==='pending')){
        const output='Superseded by a new authenticated user requirement; reevaluate without executing this proposal. Source messages: '+sources.join(', ');
        const changed=db.prepare("UPDATE approvals SET status='superseded',decided_at=?,output=? WHERE id=? AND status='pending'").run(now(),output,approval.id);
        if(Number(changed.changes)!==1)throw error('Approval changed during requirement update');
        activityEvent('approval_superseded','新要求已使原审批失效，沿原事项重新评估。',{approvalId:approval.id,sourceMessageIds:sources,reason},row.id);
      }
    }
    const deferred=row.status==='paused'||approvalInFlight||Boolean(uncertain)||(row.status==='waiting_approval'&&!reevaluate);
    db.prepare("INSERT INTO events(goal_id,type,payload,created_at) VALUES(?,'user_instruction',?,?)").run(row.id,message,now());
    if(deferred)db.prepare('UPDATE goals SET updated_at=? WHERE id=?').run(now(),row.id);
    else db.prepare("UPDATE goals SET status='active',acceptance_status=CASE WHEN status='done' THEN 'changes_requested' ELSE acceptance_status END,control_revision=control_revision+1,next_wake_at=?,updated_at=? WHERE id=?").run(now(),now(),row.id);
    activityEvent('task_continued',message,{reason,sourceMessageIds:sources,deferred,previousStatus:row.status},row.id);
    return task(goal(row.id));
  };
  const routingTasks = () => db.prepare("SELECT id,title,substr(instruction,1,600) AS instruction,status,acceptance_status,substr(last_summary,1,600) AS last_summary,resource_key,updated_at FROM goals WHERE manager_id=? AND status<>'cancelled' ORDER BY CASE WHEN status='done' AND acceptance_status='accepted' THEN 1 ELSE 0 END,updated_at DESC,id DESC").all(managerId).map(row=>({id:Number(row.id),title:row.title,instruction:row.instruction,status:row.status,acceptanceStatus:row.acceptance_status,lastSummary:row.last_summary,resourceKey:taskResourceKey(row),updatedAt:row.updated_at}));
  const inspectRoutingTask = request => {
    if(request.task_id!=null){
      const row=requireGoal(request.task_id),full=task(row);
      return {task:full,latestInstructions:db.prepare("SELECT payload FROM events WHERE goal_id=? AND type='user_instruction' ORDER BY id DESC LIMIT 3").all(row.id).reverse().map(row=>String(row.payload).slice(0,20000))};
    }
    const query=String(request.query||'').trim();
    if(!query||query.length>200)throw error('Task inspection requires an existing task ID or a short search query',400);
    const pattern='%'+query.replace(/[\\%_]/g,value=>'\\'+value)+'%';
    const matches=db.prepare("SELECT id FROM goals WHERE manager_id=? AND status<>'cancelled' AND (title LIKE ? ESCAPE '\\' OR instruction LIKE ? ESCAPE '\\' OR last_summary LIKE ? ESCAPE '\\') ORDER BY updated_at DESC,id DESC LIMIT 12").all(managerId,pattern,pattern,pattern);
    const byId=new Map(routingTasks().map(task=>[task.id,task]));
    return {query,matches:matches.map(row=>byId.get(Number(row.id))).filter(Boolean)};
  };
  const taskContinuationContext = id => {
    requireGoal(id);
    return db.prepare("SELECT payload FROM events WHERE goal_id=? AND type='user_instruction' ORDER BY id DESC LIMIT 3").all(id).reverse().map(row=>String(row.payload).slice(0,2000));
  };
  // Partial user-facing replies are durable message snapshots with a stable
  // positive ID. Internal planner JSON is never stored in this projection.
  const streamManagerReply = (run,content) => transaction(()=>{
    if(relationship.forRun(run))throw error('Spontaneous messages cannot stream before their final decision');
    if(run?.kind!=='manager'||run.manager_id!==managerId||!isCurrent(run))return null;
    if(typeof content!=='string'||!content||content.length>12000)throw error('Invalid streamed manager reply',400);
    const prior=db.prepare('SELECT * FROM manager_messages WHERE manager_id=? AND stream_run_id=?').get(managerId,run.id);
    if(prior){
      if(prior.delivery_state!=='streaming')return null;
      if(prior.content===content)return messageRow(prior);
      if(!content.startsWith(prior.content))throw error('Manager streamed reply cannot rewrite delivered text');
      db.prepare('UPDATE manager_messages SET content=?,revision=revision+1 WHERE id=?').run(content,prior.id);
    }else{
      const inbox=db.prepare('SELECT * FROM manager_inbox WHERE manager_id=? AND id<=? AND consumed_at IS NULL ORDER BY id').all(managerId,run.inbox_watermark);
      db.prepare("INSERT INTO manager_messages(manager_id,role,content,created_at,responds_to_message_ids,delivery_state,revision,stream_run_id) VALUES(?,'assistant',?,?,?,'streaming',1,?)").run(managerId,content,now(),encode(respondsToMessageIds(run,inbox)),run.id);
    }
    const row=messageRow(db.prepare('SELECT * FROM manager_messages WHERE manager_id=? AND stream_run_id=?').get(managerId,run.id));
    activityEvent('assistant_delta',content,{message:row});return row;
  });
  const endManagerReply = (run,state) => {
    if(!['failed','cancelled'].includes(state)||run?.kind!=='manager'||run.manager_id!==managerId)return null;
    // Even a fenced-out process may terminalize its own old partial, never the
    // successor run's message. The run UUID and fence remain the authority.
    if(!db.prepare('SELECT 1 FROM manager_runs WHERE id=? AND manager_id=? AND fence=?').get(run.id,managerId,run.fence))return null;
    const prior=db.prepare("SELECT * FROM manager_messages WHERE manager_id=? AND stream_run_id=? AND delivery_state='streaming'").get(managerId,run.id);if(!prior)return null;
    db.prepare('UPDATE manager_messages SET delivery_state=?,revision=revision+1 WHERE id=?').run(state,prior.id);
    const row=messageRow(db.prepare('SELECT * FROM manager_messages WHERE id=?').get(prior.id));activityEvent('assistant_delta',row.content,{message:row});return row;
  };
  const completeManager = (run,result) => {
   run=run&&db.prepare('SELECT * FROM manager_runs WHERE manager_id=? AND id=? AND fence=?').get(managerId,run.id,run.fence);
   if(!run)return {committed:false};
   const committed=commitRun(run,()=>{
    const opportunity=relationship.forRun(run);
    if(opportunity){
      if(['tasks','continuations','reviews','controls','instructions','notes','inspect_tasks','mail_actions'].some(key=>result[key]?.length))throw error('Spontaneous conversation cannot dispatch or control work');
      const outcome=relationship.finish(opportunity,result,(content,metadata)=>{
        const inserted=db.prepare("INSERT INTO manager_messages(manager_id,role,content,created_at,responds_to_message_ids,delivery_state,revision,stream_run_id,origin,topic_id,proactive_reason) VALUES(?,'assistant',?,?,'[]','completed',1,?,?,?,?)").run(managerId,content,now(),run.id,metadata.origin,metadata.topicId,metadata.proactiveReason);
        const message=messageRow(db.prepare('SELECT * FROM manager_messages WHERE id=?').get(Number(inserted.lastInsertRowid)));
        activityEvent('assistant_message',content,{message,createdTaskIds:[],continuedTaskIds:[]});return message;
      });
      return {summary:outcome.message?.content||'',message:outcome.message,tasks:[],continuedTasks:[],proactive:true,decision:outcome.state};
    }
    if(result.inspect_tasks?.length)throw error('Read-only task inspection must finish before committing directives');
    const current=managerRow();
    if(current.status!=='active'&&(result.tasks?.length||result.continuations?.length||result.controls?.length||result.instructions?.length))throw error('Manager dispatch is paused');
    const inbox=db.prepare('SELECT * FROM manager_inbox WHERE manager_id=? AND id<=? AND consumed_at IS NULL ORDER BY id').all(managerId,run.inbox_watermark);
    const responseSources=respondsToMessageIds(run,inbox);
    if(result.mail_actions?.length){
      if(current.status!=='active')throw error('Manager dispatch is paused');
      if(!mailReplies)throw error('Mail replies are unavailable');
      if(['tasks','continuations','reviews','controls','instructions','notes','inspect_tasks'].some(key=>result[key]?.length))throw error('Mail reply cannot combine unrelated directives');
      mailReplies.enqueue(run,result.mail_actions,responseSources);
      committedEffect(()=>mailReplies.kick());
    }
    const origin=inbox.map(row=>decode(row.payload)).find(row=>row.host)?.host||'other';
    const created=createTasks(result.tasks||[],{host:origin});
    for(const review of result.reviews||[])acceptTask(review.task_id??review.taskId,{accepted:review.accepted,reason:review.reason});
    for(const command of result.controls||[])controlTask(command.task_id??command.taskId,command.action);
    if(result.continuations!==undefined&&(!Array.isArray(result.continuations)||result.continuations.length>20))throw error('At most 20 continuations per plan',400);
    const continued=[],continuedIds=new Set();
    for(const command of result.continuations||[]){
      const id=command.task_id??command.taskId;
      if(continuedIds.has(id))throw error('Each existing task must have only one continuation per plan');
      continuedIds.add(id);continued.push(continueTask(command,new Set(responseSources)));
    }
    for(const command of result.instructions||[])controlTask(command.task_id??command.taskId,'instruct',{message:command.message});
    for(const note of result.notes||[]){
      if(!['user_preference','decision'].includes(note.scope)||!String(note.key||'').trim()||!String(note.content||'').trim()||!db.prepare("SELECT 1 FROM manager_messages WHERE id=? AND manager_id=? AND role='user'").get(note.source_message_id,managerId))throw error('Durable notes require a user message source');
      db.prepare('INSERT INTO manager_notes(manager_id,scope,note_key,content,source_message_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(manager_id,scope,note_key) DO UPDATE SET content=excluded.content,source_message_id=excluded.source_message_id,updated_at=excluded.updated_at').run(managerId,note.scope,String(note.key).slice(0,128),String(note.content).slice(0,2000),note.source_message_id,now(),now());
    }
    const topicChanges=relationship.learn(result.relationship,responseSources,result.relationship_revision);
    const content=String(result.reply||result.summary||'已查看当前任务。').slice(0,12000).replace(/[\uD800-\uDBFF]$/, '');
    const prior=db.prepare('SELECT * FROM manager_messages WHERE manager_id=? AND stream_run_id=?').get(managerId,run.id);
    let messageId;
    if(prior){
      if(prior.delivery_state!=='streaming'||!content.startsWith(prior.content))throw error('Final manager reply differs from delivered stream');
      db.prepare("UPDATE manager_messages SET content=?,delivery_state='completed',revision=revision+1 WHERE id=?").run(content,prior.id);messageId=prior.id;
    }else{
      const inserted=db.prepare("INSERT INTO manager_messages(manager_id,role,content,created_at,responds_to_message_ids,delivery_state,revision,stream_run_id) VALUES(?,'assistant',?,?,?,'completed',1,?)").run(managerId,content,now(),encode(responseSources),run.id);messageId=Number(inserted.lastInsertRowid);
    }
    const row=messageRow(db.prepare('SELECT * FROM manager_messages WHERE id=?').get(messageId));
    activityEvent('assistant_message',content,{message:row,createdTaskIds:created.map(item=>item.id),continuedTaskIds:continued.map(item=>item.id)});
    db.prepare('UPDATE manager_inbox SET consumed_at=? WHERE manager_id=? AND id<=? AND consumed_at IS NULL').run(now(),managerId,run.inbox_watermark);
    const pending=db.prepare('SELECT 1 FROM manager_inbox WHERE manager_id=? AND consumed_at IS NULL LIMIT 1').get(managerId);
    db.prepare('UPDATE managers SET last_summary=?,updated_at=?,next_wake_at=? WHERE id=?').run(String(result.summary||content).slice(0,4000),now(),pending?now():null,managerId);
    const eligible=result.awaiting_user_input===false&&inbox.length>0&&inbox.every(event=>event.type==='user_message')&&!['tasks','continuations','reviews','controls','instructions','inspect_tasks','mail_actions'].some(key=>result[key]?.length);
    const ordinaryWork=['tasks','continuations','reviews','controls','instructions','inspect_tasks','mail_actions'].some(key=>result[key]?.length);
    relationship.noteConversation({replyMessageId:row.id,awaitingUserInput:result.awaiting_user_input,ordinaryWork,hasUserInput:responseSources.length>0});
    const contentCandidateId=relationship.recordContentEvent({runId:run.id,sourceIds:responseSources,replyMessageId:row.id,changes:topicChanges,eligible});
    const reflectionId=topicChanges.length?relationship.recordReflection({coveredCandidateId:contentCandidateId}):null;
    return {summary:result.summary||content,message:row,tasks:created,continuedTasks:continued,...(contentCandidateId?{contentCandidateId}:{}),...(reflectionId?{reflectionId}:{})};
   });
   // Never notify inside the transaction: a rolled-back reply must have no
   // opportunity side effect. Subscriber errors cannot undo a committed reply.
   if(committed.committed&&(committed.value.contentCandidateId||committed.value.reflectionId))committedEffect(()=>{for(const listener of contentListeners)try{listener(committed.value.contentCandidateId||committed.value.reflectionId);}catch{}});
   return committed;
  };
  const failManager = (run,cause) => transaction(()=>{
    run=run&&db.prepare('SELECT * FROM manager_runs WHERE manager_id=? AND id=? AND fence=?').get(managerId,run.id,run.fence);if(!run)return;
    if(!isCurrent(run)){relationship.cancelRun(run,'回合已被新输入取代');endManagerReply(run,'cancelled');finishRun(run,{status:'superseded',summary:String(cause)});return;}
    if(relationship.forRun(run)){relationship.cancelRun(run,'本次内容评估未完成');finishRun(run,{status:'cancelled',summary:String(cause)});return;}
    endManagerReply(run,'failed');
    const inbox=db.prepare('SELECT * FROM manager_inbox WHERE manager_id=? AND id<=? AND consumed_at IS NULL ORDER BY id').all(managerId,run.inbox_watermark);
    const responseSources=respondsToMessageIds(run,inbox);
    finishRun(run,{status:'failed',summary:String(cause)});
    const newer=db.prepare('SELECT 1 FROM manager_inbox WHERE manager_id=? AND id>? AND consumed_at IS NULL LIMIT 1').get(managerId,run.inbox_watermark);
    // 2026-10-29: 失败退避。鉴权失败(401/登录失效)重试无意义，直接等 2 小时；
    // 其他错误按连续失败次数指数退避 2→4→8…分钟，最长 2 小时。用户新消息仍立即处理。
    const errorText=String(cause).slice(0,2000);
    const authFailure=/\b401\b|unauthori[sz]ed|not logged in|login (?:has )?expired|token (?:has )?expired|invalid[_ ]grant|refresh token/i.test(errorText);
    let streak=0;for(const r of db.prepare("SELECT state FROM manager_runs WHERE manager_id=? AND kind='manager' AND goal_id IS NULL ORDER BY rowid DESC LIMIT 12").all(managerId)){if(r.state!=='failed')break;streak++;}
    const backoff=Math.min(7200,120*2**Math.max(0,Math.min(6,streak-1)));
    // 鉴权失败：后台不再重试，停放到用户发新消息为止。
    db.prepare('UPDATE managers SET next_wake_at=?,updated_at=? WHERE id=?').run(authFailure?AUTH_PARKED_UNTIL:(newer?now():now()+backoff),now(),managerId);
    activityEvent('manager_error',authFailure?'总管本轮处理失败：模型登录失效。后台不再自动重试，发新消息时再试。':'总管本轮处理失败，已保留待办并安排重试。',{error:errorText,respondsToMessageIds:responseSources});
    const sameError=db.prepare("SELECT id FROM manager_inbox WHERE manager_id=? AND type='previous_plan_error' AND consumed_at IS NULL AND payload=?").get(managerId,encode({error:errorText,instruction:'Correct invalid directives before retrying. Do not repeat the rejected plan.'}));
    if(!sameError)db.prepare('INSERT INTO manager_inbox(manager_id,type,payload,created_at) VALUES(?,?,?,?)').run(managerId,'previous_plan_error',encode({error:errorText,instruction:'Correct invalid directives before retrying. Do not repeat the rejected plan.'}),now());
  });
  const recoverExpired = () => transaction(()=>{
    // A run that ended without releasing its resource locks (e.g. superseded mid-action) must not block
    // later tasks on the same resource forever. Locks held only for an uncertain action stay until reconciled.
    db.prepare("DELETE FROM manager_resources WHERE run_id IN (SELECT id FROM manager_runs WHERE manager_id=? AND state<>'running') AND NOT EXISTS (SELECT 1 FROM manager_actions a WHERE a.run_id=manager_resources.run_id AND a.state='unknown')").run(managerId);
    const expired=db.prepare("SELECT * FROM manager_runs WHERE manager_id=? AND state='running' AND lease_expires_at<=?").all(managerId,now());
    for(const run of expired){
      if(run.purpose==='content_review'){relationship.cancelRun(run,'内容评估租约已结束');finishRun(run,{status:'cancelled',summary:'Content review lease expired'});continue;}
      const started=db.prepare("SELECT id FROM manager_actions WHERE run_id=? AND state='started'").all(run.id);
      db.prepare("UPDATE manager_actions SET state='unknown' WHERE run_id=? AND state='started'").run(run.id);
      if(run.kind==='approval')db.prepare("UPDATE approvals SET status='unknown',output='Execution interrupted; reconcile the durable action outcome before continuing.' WHERE goal_id=? AND status='executing'").run(run.goal_id);
      endManagerReply(run,'failed');
      finishRun(run,{status:started.length?'uncertain':'interrupted',summary:'Lease expired'});
      if(run.goal_id!=null){const row=goal(run.goal_id);if(row?.status==='active'||(run.kind==='approval'&&row?.status==='waiting_approval')){db.prepare('UPDATE goals SET status=?,next_wake_at=?,updated_at=?,control_revision=control_revision+? WHERE id=?').run(started.length?'blocked':'active',started.length?null:now(),now(),started.length?1:0,run.goal_id);reportGoal(run.goal_id,started.length?'blocked':'active',started.length?'执行结果不明，需要核查；不会自动重复执行。':'执行中断，保留线程和动作凭证后继续。');}}
      else db.prepare('UPDATE managers SET next_wake_at=? WHERE id=?').run(now(),managerId);
      activityEvent('run_recovered',started.length?'执行结果待核查':'中断任务已恢复',{runId:run.id,uncertain:started.length>0},run.goal_id);
    }
    return expired.length;
  });
  const recoverContentReviews=()=>transaction(()=>{
    const abandoned=db.prepare("SELECT * FROM manager_runs WHERE manager_id=? AND purpose='content_review' AND state='running'").all(managerId);
    let retired=0;
    for(const run of abandoned){
      const pid=/^content-review:(\d+)$/.exec(run.worker_id)?.[1];let dead=false;
      if(pid)try{process.kill(Number(pid),0);}catch(cause){dead=cause?.code==='ESRCH';}
      // A second runtime/store object is not proof that a live evaluation died.
      if(run.lease_expires_at>now()&&!dead)continue;
      relationship.cancelRun(run,'上次内容评估已中断');finishRun(run,{status:'cancelled',summary:'Content review interrupted by runtime restart'});retired++;
    }
    return retired;
  });
  const activity = ({afterId=0,limit=50}={}) => {
    if(!Number.isSafeInteger(Number(afterId))||Number(afterId)<0||!Number.isSafeInteger(Number(limit))||Number(limit)<1||Number(limit)>200)throw error('Invalid activity cursor or limit',400);
    const rows=db.prepare('SELECT * FROM manager_activity WHERE manager_id=? AND id>? ORDER BY id LIMIT ?').all(managerId,Number(afterId),Number(limit)+1);
    const visible=rows.slice(0,Number(limit));return {ok:true,activity:visible.map(row=>({id:Number(row.id),managerId:row.manager_id,taskId:row.task_id,kind:row.kind,message:row.message,data:decode(row.data),createdAt:row.created_at})),nextCursor:visible.at(-1)?.id??Number(afterId),hasMore:rows.length>Number(limit)};
  };
  const messages = ({beforeId=0,limit=100}={}) => {
    if(!Number.isSafeInteger(Number(beforeId))||Number(beforeId)<0||!Number.isSafeInteger(Number(limit))||Number(limit)<1||Number(limit)>200)throw error('Invalid message cursor or limit',400);
    const rows=db.prepare('SELECT * FROM manager_messages WHERE manager_id=? AND (?=0 OR id<?) ORDER BY id DESC LIMIT ?').all(managerId,Number(beforeId),Number(beforeId),Number(limit)+1);
    const selected=rows.slice(0,Number(limit)).reverse();return {ok:true,messages:selected.map(messageRow),hasMore:rows.length>Number(limit),nextBeforeId:selected[0]?.id??null};
  };
  const taskEvidence = id => {requireGoal(id);return ({outputs:db.prepare('SELECT id,status,summary,raw_result FROM agent_outputs WHERE goal_id=? ORDER BY id DESC LIMIT 2').all(id).map(row=>({...row,raw_result:String(row.raw_result||'').slice(0,10000)})),actions:db.prepare('SELECT a.id,a.state,a.payload,a.result FROM manager_actions a JOIN manager_runs r ON r.id=a.run_id WHERE r.goal_id=? ORDER BY a.started_at DESC LIMIT 8').all(id).map(row=>({id:row.id,state:row.state,payload:decode(row.payload),result:decode(row.result)})),uncertainActions:db.prepare("SELECT a.id,a.checkpoint FROM manager_actions a JOIN manager_runs r ON r.id=a.run_id WHERE r.goal_id=? AND a.state='unknown'").all(id).map(row=>({actionId:row.id,checkpoint:decode(row.checkpoint)}))});};
  const checkpointAction = (actionId,checkpoint) => {
    const action=db.prepare('SELECT a.* FROM manager_actions a JOIN manager_runs r ON r.id=a.run_id WHERE a.id=? AND r.manager_id=?').get(actionId,managerId);if(!action)return;
    db.prepare('UPDATE manager_actions SET checkpoint=? WHERE id=?').run(encode(checkpoint),actionId);
    const run=db.prepare('SELECT * FROM manager_runs WHERE id=?').get(action.run_id);
    const threadId=checkpoint.threadId||checkpoint.thread_id;
    if(threadId&&run?.state==='running')db.prepare('UPDATE goals SET mac_thread_id=?,mac_last_route=?,updated_at=? WHERE id=?').run(threadId,String(checkpoint.route||checkpoint.routeUsed||''),now(),run.goal_id);
  };
  const bindApproval = (id,reason,command) => transaction(()=>{
    const parent=requireGoal(id),row={goal_id:parent.id,reason:String(reason),command:String(command)};
    const fingerprint=approvalHash(row,parent.control_revision);
    const pending=db.prepare("SELECT * FROM approvals WHERE goal_id=? AND status='pending' ORDER BY id DESC LIMIT 1").get(parent.id);
    if(pending&&pending.control_revision===parent.control_revision&&pending.payload_hash===fingerprint)return pending.id;
    if(pending)db.prepare("UPDATE approvals SET status='superseded' WHERE id=?").run(pending.id);
    return Number(db.prepare("INSERT INTO approvals(goal_id,reason,command,status,created_at,control_revision,payload_hash) VALUES(?,?,?,'pending',?,?,?)").run(parent.id,row.reason,row.command,now(),parent.control_revision,fingerprint).lastInsertRowid);
  });
  const validateApproval = approval => {
    const parent=requireGoal(approval.goal_id);
    if(parent.status!=='waiting_approval'||approval.status!=='pending'||parent.control_revision!==approval.control_revision||approval.payload_hash!==approvalHash(approval,parent.control_revision))throw error('Approval is stale or the task is not awaiting approval; review the current task state');
    return parent;
  };
  const claimApproval = approval => transaction(()=>{
    const parent=validateApproval(approval),hostResource=(importLegacyGoals?'':managerId+':')+'host:executor';
    if(db.prepare("SELECT 1 FROM manager_resources WHERE resource_key IN (?,?) LIMIT 1").get(hostResource,'goal:'+parent.id))throw error('Host execution is busy or awaiting reconciliation');
    if(db.prepare("SELECT 1 FROM manager_actions a JOIN manager_runs r ON r.id=a.run_id WHERE r.manager_id=? AND a.state='unknown' AND json_extract(a.payload,'$.type')='host_command' LIMIT 1").get(managerId))throw error('A previous host execution must be reconciled');
    const id=randomUUID(),fence=Number(db.prepare("SELECT COALESCE(MAX(fence),0)+1 AS n FROM manager_runs WHERE goal_id=? AND kind='approval'").get(parent.id).n);
    db.prepare("INSERT INTO manager_runs(id,manager_id,goal_id,kind,state,worker_id,fence,control_revision,lease_expires_at,heartbeat_at,started_at) VALUES(?,?,?,'approval','running',?,?,?,?,?,?)").run(id,managerId,parent.id,'approval:'+approval.id,fence,parent.control_revision,now()+leaseSeconds,now(),now());
    for(const resource of [hostResource,'goal:'+parent.id])db.prepare('INSERT INTO manager_resources(resource_key,run_id,lease_expires_at) VALUES(?,?,?)').run(resource,id,now()+leaseSeconds);
    return db.prepare('SELECT * FROM manager_runs WHERE id=?').get(id);
  });
  // Older releases had executing approvals without any operation journal.
  // Adopt them as unknown rather than retrying a possibly completed command.
  for(const approval of db.prepare("SELECT * FROM approvals WHERE status='executing' AND NOT EXISTS (SELECT 1 FROM manager_runs r WHERE r.goal_id=approvals.goal_id AND r.kind='approval' AND r.state='running')").all())transaction(()=>{
    const parent=goal(approval.goal_id);if(!parent)return;
    const runId='legacy-approval:'+approval.id,actionId=runId+':0',payload=encode({type:'host_command',command:approval.command,approvalId:approval.id});
    db.prepare("INSERT OR IGNORE INTO manager_runs(id,manager_id,goal_id,kind,state,worker_id,fence,control_revision,lease_expires_at,heartbeat_at,started_at,finished_at,summary) VALUES(?,?,?,'approval','uncertain','legacy',1,?,?,?,?,?,'Legacy command outcome unknown')").run(runId,managerId,parent.id,parent.control_revision,now(),now(),now(),now());
    db.prepare("INSERT OR IGNORE INTO manager_actions(id,run_id,ordinal,payload,payload_hash,state,started_at) VALUES(?,?,0,?,?,'unknown',?)").run(actionId,runId,payload,createHash('sha256').update(payload).digest('hex'),now());
    for(const resource of [(importLegacyGoals?'':managerId+':')+'host:executor','goal:'+parent.id])db.prepare('INSERT OR IGNORE INTO manager_resources(resource_key,run_id,lease_expires_at) VALUES(?,?,?)').run(resource,runId,now());
    db.prepare("UPDATE approvals SET status='unknown',output=? WHERE id=?").run('Previous executing command has no confirmed receipt; reconcile '+actionId,approval.id);
    if(['active','waiting_approval'].includes(parent.status))db.prepare("UPDATE goals SET status='blocked',next_wake_at=NULL,control_revision=control_revision+1 WHERE id=?").run(parent.id);
    activityEvent('approval_unknown','旧审批执行结果待核查，未重复执行。',{approvalId:approval.id,actionId},parent.id);enqueue('approval_unknown',{taskId:parent.id,actionId});
  });
  const reconcileAction = input => receipt(input.requestId,'action:reconcile',{actionId:input.actionId,outcome:input.outcome,note:input.note},()=>{
    if(!['succeeded','failed'].includes(input.outcome)||!String(input.note||'').trim())throw error('Confirmed outcome and evidence note are required',400);
    const action=db.prepare('SELECT a.*,r.goal_id,r.manager_id FROM manager_actions a JOIN manager_runs r ON r.id=a.run_id WHERE a.id=?').get(input.actionId);
    if(!action||action.manager_id!==managerId)throw error('Action not found',404);
    if(action.state!=='unknown')throw error('Only uncertain actions need reconciliation');
    db.prepare('UPDATE manager_actions SET state=?,result=?,finished_at=? WHERE id=?').run(input.outcome,encode({confirmed:true,note:input.note}),now(),input.actionId);
    const payload=decode(action.payload);
    if(payload.type==='host_command'&&payload.approvalId)db.prepare('UPDATE approvals SET status=?,output=? WHERE id=?').run(input.outcome==='succeeded'?'executed':'failed',String(input.note),payload.approvalId);
    if(!db.prepare("SELECT 1 FROM manager_actions WHERE run_id=? AND state='unknown' LIMIT 1").get(action.run_id))db.prepare('DELETE FROM manager_resources WHERE run_id=?').run(action.run_id);
    const row=goal(action.goal_id),run=db.prepare('SELECT * FROM manager_runs WHERE id=?').get(action.run_id);
    if(payload.type==='mac_codex'&&input.verifiedThreadId&&/^[0-9a-f-]{20,64}$/i.test(input.verifiedThreadId))db.prepare('UPDATE goals SET mac_thread_id=?,mac_last_route=?,updated_at=? WHERE id=? AND control_revision=?').run(input.verifiedThreadId,String(input.verifiedRoute||''),now(),row.id,row.control_revision);
    if(input.autoResume&&row.status==='blocked'&&row.control_revision===run.control_revision+1&&managerRow().status==='active'&&!db.prepare("SELECT 1 FROM approvals WHERE goal_id=? AND status IN ('pending','executing')").get(row.id))db.prepare("UPDATE goals SET status='active',next_wake_at=?,control_revision=control_revision+1,updated_at=? WHERE id=?").run(now(),now(),row.id);
    db.prepare("INSERT INTO events(goal_id,type,payload,created_at) VALUES(?,'execution_reconciled',?,?)").run(action.goal_id,encode({actionId:input.actionId,outcome:input.outcome,note:input.note}),now());
    activityEvent('action_reconciled','已核查执行结果；该任务可显式恢复。',{actionId:input.actionId,outcome:input.outcome,note:input.note},action.goal_id);enqueue('action_reconciled',{taskId:action.goal_id,outcome:input.outcome});
    return {ok:true,manager:snapshot()};
  });
  const retireLegacyOpportunities=()=>{
    const retiredRuns=db.prepare("SELECT r.* FROM manager_runs r WHERE r.manager_id=? AND r.kind='manager' AND r.state='running' AND EXISTS (SELECT 1 FROM manager_inbox i WHERE i.manager_id=r.manager_id AND i.type='proactive_opportunity' AND i.consumed_at IS NULL AND i.id<=r.inbox_watermark)").all(managerId);
    for(const run of retiredRuns){
      endManagerReply(run,'cancelled');
      finishRun(run,{status:'superseded',summary:'基于时间的主动复审已移除'});
    }
    const retired=db.prepare("UPDATE manager_inbox SET consumed_at=? WHERE manager_id=? AND type='proactive_opportunity' AND consumed_at IS NULL").run(now(),managerId).changes;
    if(!retired)return;
    const pending=db.prepare('SELECT 1 FROM manager_inbox WHERE manager_id=? AND consumed_at IS NULL LIMIT 1').get(managerId);
    if(!pending)db.prepare('UPDATE managers SET next_wake_at=NULL WHERE id=?').run(managerId);
    else if(retiredRuns.length)db.prepare('UPDATE managers SET next_wake_at=? WHERE id=?').run(now(),managerId);
  };
  relationship=createDotsRelationship({db,managerId,now,transaction,retireLegacyOpportunities,activityEvent});
  // Public source discovery creates no user inbox item or task. Publication is
  // atomic with its source candidate receipt; drafts remain entirely private.
  const publishDiscovery=({content,reason,candidateId})=>{
    const candidate=db.prepare("SELECT state,message_id FROM dots_discovery_updates WHERE manager_id=? AND id=?").get(managerId,candidateId);
    if(candidate?.state!=='assessing'||candidate.message_id)throw error('Discovery candidate is no longer current');
    const inserted=db.prepare("INSERT INTO manager_messages(manager_id,role,content,created_at,responds_to_message_ids,delivery_state,revision,origin,proactive_reason) VALUES(?,'assistant',?,?,'[]','completed',1,'proactive',?)").run(managerId,String(content).slice(0,4000),now(),String(reason).slice(0,500));
    const message=messageRow(db.prepare('SELECT * FROM manager_messages WHERE id=?').get(Number(inserted.lastInsertRowid)));
    activityEvent('assistant_message',message.content,{message,createdTaskIds:[],continuedTaskIds:[]});
    return message;
  };
  const publishCognition=({intentId,content,reason})=>{
    const intent=db.prepare('SELECT state,message_id FROM dots_cognition_intents WHERE manager_id=? AND id=?').get(managerId,intentId);
    if(!intent||!['pending','held'].includes(intent.state)||intent.message_id)throw error('Cognitive intention is no longer current');
    const inserted=db.prepare("INSERT INTO manager_messages(manager_id,role,content,created_at,responds_to_message_ids,delivery_state,revision,origin,proactive_reason) VALUES(?,'assistant',?,?,'[]','completed',1,'proactive',?)").run(managerId,String(content).slice(0,5000),now(),String(reason).slice(0,1000));
    const message=messageRow(db.prepare('SELECT * FROM manager_messages WHERE id=?').get(Number(inserted.lastInsertRowid)));
    activityEvent('assistant_message',message.content,{message,createdTaskIds:[],continuedTaskIds:[]});return message;
  };
  // —— 对话订阅 ——
  db.exec('CREATE TABLE IF NOT EXISTS dots_subscription_intents(manager_id TEXT NOT NULL,message_id INTEGER NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(manager_id,message_id))');
  const claimSubscriptionIntent=messageId=>Boolean(db.prepare("INSERT OR IGNORE INTO dots_subscription_intents(manager_id,message_id,state,created_at) VALUES(?,?,'processing',?)").run(managerId,Number(messageId),now()).changes);
  const releaseToManager=messageId=>transaction(()=>{
    const row=db.prepare("SELECT * FROM manager_messages WHERE manager_id=? AND id=? AND role='user'").get(managerId,Number(messageId));if(!row)return false;
    db.prepare("UPDATE dots_subscription_intents SET state='released' WHERE manager_id=? AND message_id=?").run(managerId,Number(messageId));
    enqueue('user_message',messageRow(row));return true;
  });
  const postSubscriptionReply=({content,card=null,respondsTo})=>transaction(()=>{
    const inserted=db.prepare("INSERT INTO manager_messages(manager_id,role,content,created_at,responds_to_message_ids,delivery_state,revision,origin,card) VALUES(?,'assistant',?,?,?,'completed',1,'reply',?)").run(managerId,String(content).slice(0,4000),now(),encode(respondsTo?[Number(respondsTo)]:[]),card?encode(card):'');
    if(respondsTo)db.prepare("UPDATE dots_subscription_intents SET state='handled' WHERE manager_id=? AND message_id=?").run(managerId,Number(respondsTo));
    const message=messageRow(db.prepare('SELECT * FROM manager_messages WHERE id=?').get(Number(inserted.lastInsertRowid)));
    activityEvent('assistant_message',message.content,{message,createdTaskIds:[],continuedTaskIds:[]});conversationChanged();return message;
  });
  // 订阅成功/取消后，把对应的待填写卡片标记为已完成，凭据不写入消息。
  const resolveSubscriptionCards=(provider,action,state='done')=>transaction(()=>{
    let changed=0;
    for(const row of db.prepare("SELECT id,card,revision FROM manager_messages WHERE manager_id=? AND card<>''").all(managerId)){
      const card=decode(row.card,null);if(!card||card.provider!==provider||card.action!==action||card.state!=='open')continue;
      db.prepare('UPDATE manager_messages SET card=?,revision=revision+1 WHERE id=?').run(encode({...card,state,fields:(card.fields||[]).map(f=>f.secret?{...f,value:''}:f)}),row.id);changed++;
    }
    if(changed)conversationChanged();return changed;
  });
  const publishMail=({eventId,content})=>{
    const event=db.prepare('SELECT state,message_id FROM dots_mail_events WHERE id=? AND manager_id=?').get(eventId,managerId);
    if(!event||event.state!=='pending'||event.message_id)throw error('Mail event is no longer current');
    const inserted=db.prepare("INSERT INTO manager_messages(manager_id,role,content,created_at,responds_to_message_ids,delivery_state,revision,origin,proactive_reason) VALUES(?,'assistant',?,?,'[]','completed',1,'proactive','QQ邮箱新邮件事件')").run(managerId,String(content).slice(0,16000),now());
    const message=messageRow(db.prepare('SELECT * FROM manager_messages WHERE id=?').get(Number(inserted.lastInsertRowid)));
    activityEvent('assistant_message',message.content,{message,createdTaskIds:[],continuedTaskIds:[]});return message;
  };
  // 通用主动消息（每日简报等），带反馈记录表。
  db.exec("CREATE TABLE IF NOT EXISTS dots_message_feedback(manager_id TEXT NOT NULL,message_id INTEGER NOT NULL,value TEXT NOT NULL,reason TEXT NOT NULL DEFAULT '',excerpt TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,PRIMARY KEY(manager_id,message_id))");
  const publishProactive=({content,reason})=>{
    const inserted=db.prepare("INSERT INTO manager_messages(manager_id,role,content,created_at,responds_to_message_ids,delivery_state,revision,origin,proactive_reason) VALUES(?,'assistant',?,?,'[]','completed',1,'proactive',?)").run(managerId,String(content).slice(0,6000),now(),String(reason||'').slice(0,200));
    const message=messageRow(db.prepare('SELECT * FROM manager_messages WHERE id=?').get(Number(inserted.lastInsertRowid)));
    activityEvent('assistant_message',message.content,{message,createdTaskIds:[],continuedTaskIds:[]});conversationChanged?.();return message;
  };
  // 用户对主动消息的反馈：useful / not_useful / clear。只接受本账号的主动消息。
  const messageFeedback=({messageId,value})=>{
    const row=db.prepare("SELECT id,content,proactive_reason FROM manager_messages WHERE id=? AND manager_id=? AND role='assistant'").get(Number(messageId),managerId);
    if(!row)throw error('Message not found');
    if(value==='clear'){db.prepare('DELETE FROM dots_message_feedback WHERE manager_id=? AND message_id=?').run(managerId,row.id);return {ok:true,messageId:row.id,value:null};}
    if(!['useful','not_useful'].includes(value))throw error('Invalid feedback');
    db.prepare('INSERT INTO dots_message_feedback(manager_id,message_id,value,reason,excerpt,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(manager_id,message_id) DO UPDATE SET value=excluded.value,created_at=excluded.created_at').run(managerId,row.id,value,String(row.proactive_reason||''),String(row.content||'').replace(/\s+/g,' ').slice(0,160),now());
    return {ok:true,messageId:row.id,value};
  };
  const feedbackMap=ids=>{const out={};if(!ids.length)return out;for(const row of db.prepare('SELECT message_id,value FROM dots_message_feedback WHERE manager_id=? AND message_id IN ('+ids.map(()=>'?').join(',')+')').all(managerId,...ids))out[row.message_id]=row.value;return out;};
  const recentFeedback=(limit=20)=>db.prepare('SELECT value,reason,excerpt FROM dots_message_feedback WHERE manager_id=? ORDER BY created_at DESC LIMIT ?').all(managerId,limit);
  const publishAppEvent=({source,eventKey,content})=>{
    const event=db.prepare('SELECT message_id FROM dots_app_events WHERE manager_id=? AND source=? AND event_key=?').get(managerId,source,eventKey);
    if(!event||event.message_id)throw error('App event is no longer current');
    const inserted=db.prepare("INSERT INTO manager_messages(manager_id,role,content,created_at,responds_to_message_ids,delivery_state,revision,origin,proactive_reason) VALUES(?,'assistant',?,?,'[]','completed',1,'proactive',?)").run(managerId,String(content).slice(0,6000),now(),source.startsWith('github:')?'GitHub 仓库事件':'谷歌日历事件');
    const message=messageRow(db.prepare('SELECT * FROM manager_messages WHERE id=?').get(Number(inserted.lastInsertRowid)));
    activityEvent('assistant_message',message.content,{message,createdTaskIds:[],continuedTaskIds:[]});return message;
  };
  const refreshAppEvent=({source,eventKey,content})=>transaction(()=>{
    const event=db.prepare('SELECT message_id FROM dots_app_events WHERE manager_id=? AND source=? AND event_key=?').get(managerId,source,eventKey);
    if(!event?.message_id)return null;
    const changed=db.prepare("UPDATE manager_messages SET content=?,revision=revision+1 WHERE id=? AND manager_id=? AND role='assistant' AND origin='proactive' AND content<>?").run(String(content).slice(0,6000),event.message_id,managerId,String(content).slice(0,6000));
    const message=messageRow(db.prepare('SELECT * FROM manager_messages WHERE id=? AND manager_id=?').get(event.message_id,managerId));
    if(changed.changes)activityEvent('assistant_delta',message.content,{message});return message;
  });
  const refreshMail=({eventId,content})=>transaction(()=>{
    const event=db.prepare("SELECT message_id FROM dots_mail_events WHERE id=? AND manager_id=? AND state='sent'").get(eventId,managerId);
    if(!event?.message_id)throw error('Mail notification not found');
    db.prepare("UPDATE manager_messages SET content=?,revision=revision+1 WHERE id=? AND manager_id=? AND role='assistant' AND origin='proactive'").run(String(content).slice(0,16000),event.message_id,managerId);
    const message=messageRow(db.prepare('SELECT * FROM manager_messages WHERE id=?').get(event.message_id));
    activityEvent('assistant_delta',message.content,{message});return message;
  });
  const publishMailReplyResult=({jobId,content})=>{
    const job=db.prepare('SELECT state,result_message_id FROM dots_mail_reply_jobs WHERE id=? AND manager_id=?').get(jobId,managerId);
    if(!job||!['drafted','sent','failed','uncertain'].includes(job.state)||job.result_message_id)throw error('Mail reply result not current');
    const inserted=db.prepare("INSERT INTO manager_messages(manager_id,role,content,created_at,responds_to_message_ids,delivery_state,revision,origin,proactive_reason) VALUES(?,'assistant',?,?,'[]','completed',1,'proactive','用户请求的邮件回复结果')").run(managerId,String(content).slice(0,16000),now());
    const message=messageRow(db.prepare('SELECT * FROM manager_messages WHERE id=?').get(Number(inserted.lastInsertRowid)));activityEvent('assistant_message',message.content,{message,createdTaskIds:[],continuedTaskIds:[]});return message;
  };
  const registrationNotice=input=>transaction(()=>{
    // This store API is called only by the private service ingress; neither
    // prompt text nor MCP arguments can select the recipient.
    if(ownerId!=='shiyan-private-owner')throw error('Administrator notification unavailable',404);
    const event=validateRegistrationEvent(input);
    const prior=db.prepare('SELECT * FROM manager_registration_notices WHERE event_id=?').get(event.id);
    const source=event.source==='shiyan_web'?'拾燕网页端':'海绵宝宝 MCP 官网';
    const registered=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(event.registeredAt);
    const username=event.source==='shiyan_web'?(event.email||prior?.email||event.username):event.username;
    const content=`新用户注册成功\n注册来源：${source}\n用户名：${username}\n注册时间：${registered}（北京时间）`;
    if(prior){
      if(prior.source!==event.source||prior.username!==event.username||prior.registered_at!==event.registeredAt||(prior.email&&event.email&&prior.email!==event.email))throw error('Registration event conflict',409);
      if((!prior.email&&event.email)||db.prepare('SELECT content FROM manager_messages WHERE id=? AND manager_id=?').get(prior.message_id,managerId)?.content!==content){
        // Correct the same notice in place, retaining its identity and known email.
        db.prepare('UPDATE manager_registration_notices SET email=? WHERE event_id=?').run(event.email||prior.email,event.id);
        db.prepare('UPDATE manager_messages SET content=?,revision=revision+1 WHERE id=? AND manager_id=?').run(content,prior.message_id,managerId);
        const message=messageRow(db.prepare('SELECT * FROM manager_messages WHERE id=? AND manager_id=?').get(prior.message_id,managerId));
        activityEvent('proactive_message',content,{message,registration:event});
      }
      return {ok:true,durable:true,activityCursor:Number(db.prepare('SELECT COALESCE(MAX(id),0) AS cursor FROM manager_activity WHERE manager_id=?').get(managerId).cursor),message:messageRow(db.prepare('SELECT * FROM manager_messages WHERE id=? AND manager_id=?').get(prior.message_id,managerId))};
    }
    const inserted=db.prepare("INSERT INTO manager_messages(manager_id,role,content,request_id,host,created_at,delivery_state,revision,origin,proactive_reason) VALUES(?,'assistant',?,?,'other',?,'completed',1,'proactive','管理员注册提醒')").run(managerId,content,event.id,now());
    const message=messageRow(db.prepare('SELECT * FROM manager_messages WHERE id=?').get(Number(inserted.lastInsertRowid)));
    db.prepare('INSERT INTO manager_registration_notices(event_id,source,username,email,registered_at,message_id) VALUES(?,?,?,?,?,?)').run(event.id,event.source,event.username,event.email,event.registeredAt,message.id);
    const activityCursor=activityEvent('proactive_message',content,{message,registration:event});
    // No inbox, task, model call, cognition trigger or manager wake is added.
    return {ok:true,durable:true,activityCursor,message};
  });
  const initializeReflection=()=>transaction(()=>{
    const id=relationship.initializeReflection();
    if(id)committedEffect(()=>{for(const listener of contentListeners)try{listener(id);}catch{}});
    return id;
  });
  return {publishProactive,messageFeedback,feedbackMap,recentFeedback,claimSubscriptionIntent,releaseToManager,postSubscriptionReply,resolveSubscriptionCards,registrationNotice,refreshAppEvent,db,ownerId,managerId,workerLimit,relationship,subscribeConversationEvents,publishAppEvent,publishDiscovery,publishCognition,publishMail,refreshMail,publishMailReplyResult,setMailReplies:service=>{mailReplies=service;},mailReplyContext:()=>mailReplies?.context()||{available:false},initializeReflection,subscribeContentEvents,claimContentReview,recoverContentReviews,transaction,ensure,requireOwner,snapshot,routingTasks,inspectRoutingTask,taskContinuationContext,message:(...args)=>{const result=message(...args);conversationChanged();return result;},control:(...args)=>{const result=control(...args);conversationChanged();return result;},controlTask,activity,messages,taskEvidence,activityEvent,enqueue,createTasks,taskEligibility,claimGoal:(id,options={})=>claim('worker',Number(id),options.workerId),claimManager:(options={})=>claim('manager',null,options.workerId),renewRun,isCurrent,checkpointThread,planActions,beginAction,finishAction,checkpointAction,reconcileAction,bindApproval,validateApproval,claimApproval,finishRun,commitRun,reportGoal,acceptTask,streamManagerReply,completeManager:(...args)=>{const result=completeManager(...args);conversationChanged();return result;},failManager:(...args)=>{const result=failManager(...args);conversationChanged();return result;},recoverExpired,attachGoal:(id)=>{db.prepare('UPDATE goals SET manager_id=? WHERE id=? AND manager_id IS NULL').run(managerId,id);},unknownActions:()=>db.prepare("SELECT a.*,r.goal_id,r.control_revision FROM manager_actions a JOIN manager_runs r ON r.id=a.run_id WHERE r.manager_id=? AND a.state='unknown'").all(managerId),pendingManagerInbox:(run)=>db.prepare('SELECT id,type,payload FROM manager_inbox WHERE manager_id=? AND id<=? AND consumed_at IS NULL ORDER BY id').all(managerId,run.inbox_watermark)};
}
