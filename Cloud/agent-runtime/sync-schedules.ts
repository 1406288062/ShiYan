import { createHash, createPublicKey, verify } from 'node:crypto';
import { memberExecution, prepareMemberSchedule } from './member-schedules.ts';
import { verifiedCatalog } from './providers/index.ts';

export const SCHEDULE_CONFIG = ['title','instruction','emoji','enabled','repeat','time','timezone','startDate','endDate','runLocally','notificationMode','newChatEachRun','model','reasoning','projectId'];
export const SCHEDULE_REPORT = ['executorDeviceId','executionMode','status','nextRunAt','lastRunAt','lastRunState','lastError','conversationId','createdAt','updatedAt','source'];
const fail = (message,status=400) => Object.assign(new Error(message),{status});
const configHash = value => createHash('sha256').update(JSON.stringify(SCHEDULE_CONFIG.map(k=>[k,value[k]??null]))).digest('hex');
const id = value => typeof value==='string' && /^[A-Za-z0-9_-]{8,128}$/.test(value);
const date = value => typeof value==='string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value+'T12:00:00Z')) && new Date(value+'T12:00:00Z').toISOString().slice(0,10)===value;
// Account session IDs rotate at login. Schedules belong to the registered Mac,
// whose physical identity stays stable across those sessions.
const canonicalDevice = (store,owner,device) => typeof device==='string'
  ? store.db.prepare('SELECT device FROM schedule_host_sessions WHERE owner=? AND session_id=?').get(owner,device)?.device||device
  : device;
const executionDevice = (store,auth) => auth.accountSession ? canonicalDevice(store,auth.owner,auth.sessionId||auth.deviceID) : auth.deviceID;
function verifyHostProof(auth,input,device){
  try{
    const publicKey=Buffer.from(String(input.devicePublicKey||''),'base64'),signature=Buffer.from(String(input.deviceSignature||''),'base64');
    if(publicKey.length!==32||signature.length!==64||createHash('sha256').update(publicKey).digest('hex')!==device
      ||!Number.isSafeInteger(input.deviceTime)||Math.abs(Date.now()-input.deviceTime)>300000
      ||typeof input.deviceNonce!=='string'||!/^[A-Za-z0-9_-]{16,80}$/.test(input.deviceNonce))throw Error();
    const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),publicKey]),format:'der',type:'spki'});
    const message=['shiyan-schedule-host-v1',auth.owner,device,String(input.deviceTime),input.deviceNonce].join('\n');
    if(!verify(null,Buffer.from(message),key,signature))throw Error();
    return input.deviceNonce;
  }catch{throw fail('执行 Mac 身份校验失败',403);}
}

export function validateSchedule(data) {
  if(typeof data.title!=='string'||!data.title.trim()||data.title.length>200||typeof data.instruction!=='string'||!data.instruction.trim()||data.instruction.length>20000)throw fail('请输入有效的任务名称和说明');
  if(typeof data.enabled!=='boolean'||!['once','hourly','daily','weekdays','weekly','monthly'].includes(data.repeat)||typeof data.time!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(data.time))throw fail('执行频率或时间无效');
  try{if(typeof data.timezone!=='string'||data.timezone.length>100)throw Error();new Intl.DateTimeFormat('en',{timeZone:data.timezone});}catch{throw fail('时区无效');}
  if(!date(data.startDate)||(data.endDate!==null&&data.endDate!==undefined&&(!date(data.endDate)||data.endDate<data.startDate)))throw fail('开始或结束日期无效');
  if(typeof data.runLocally!=='boolean'||typeof data.newChatEachRun!=='boolean'||!['important','all','none'].includes(data.notificationMode))throw fail('运行选项无效');
  if(typeof data.model!=='string'||!data.model||data.model.length>160||typeof data.reasoning!=='string'||data.reasoning.length>30)throw fail('模型或强度无效');
  if(data.projectId!==null&&data.projectId!==undefined&&!id(data.projectId))throw fail('任务项目无效');
  if(data.emoji!==undefined&&(typeof data.emoji!=='string'||data.emoji.length>32))throw fail('任务图标无效');
  return data;
}

export function prepareScheduleMutation(store,owner,mutation,auth) {
  if(mutation.kind!=='scheduledTasks'||mutation.deleted)return mutation;
  const current=store.get(owner,'scheduledTasks',mutation.id)?.data||{},input=mutation.data||{};
  const mobile=auth.platform==='ios'||auth.mobile===true;
  const config=Object.fromEntries(SCHEDULE_CONFIG.filter(k=>Object.hasOwn(input,k)).map(k=>[k,input[k]]));
  const defaults={enabled:true,repeat:'daily',time:'09:00',timezone:'Asia/Shanghai',startDate:new Date().toISOString().slice(0,10),endDate:null,runLocally:true,notificationMode:'important',newChatEachRun:false,projectId:null};
  const report=Object.fromEntries(SCHEDULE_REPORT.filter(k=>Object.hasOwn(current,k)).map(k=>[k,current[k]]));
  const host=memberExecution(auth)?null:store.db.prepare('SELECT device FROM schedule_hosts WHERE owner=? ORDER BY seen_at DESC LIMIT 1').get(owner)?.device;
  const data={...defaults,...current,...config,id:mutation.id,...(mobile?report:Object.fromEntries(SCHEDULE_REPORT.filter(k=>Object.hasOwn(input,k)).map(k=>[k,input[k]])))};
  if(memberExecution(auth)) {
    validateSchedule({...data,runLocally:false});
    return {...mutation,data:prepareMemberSchedule(current,data,auth)};
  }
  if(mobile){
    data.executorDeviceId=current.executorDeviceId||host||null;
    data.createdAt=current.createdAt||new Date().toISOString();data.updatedAt=new Date().toISOString();data.source='desktop';
    if(!current.id)data.status='pending';
  }else{
    const device=executionDevice(store,auth);
    if(auth.platform&& !['macos','mac','darwin'].includes(auth.platform))throw fail('此设备不能发布桌面任务状态',403);
    if(!store.db.prepare('SELECT 1 FROM schedule_hosts WHERE owner=? AND device=?').get(owner,device))throw fail('执行 Mac 尚未登记',403);
    if(current.executorDeviceId&&canonicalDevice(store,owner,current.executorDeviceId)!==device)throw fail('此任务由另一台 Mac 执行',409);
    if(data.executorDeviceId&&canonicalDevice(store,owner,data.executorDeviceId)!==device)throw fail('执行设备标识无效',403);
    data.executorDeviceId=device;
  }
  validateSchedule(data);
  if(mobile&&data.enabled&&(!current.id||['enabled','repeat','time','timezone','startDate','endDate'].some(k=>data[k]!==current[k]))){
    const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:data.timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date()).map(x=>[x.type,x.value]));
    const today=parts.year+'-'+parts.month+'-'+parts.day,clock=parts.hour+':'+parts.minute;
    if(data.endDate&&data.endDate<today||data.repeat==='once'&&(data.startDate<today||data.startDate===today&&data.time<=clock))throw fail('执行时间已过去，请选择未来时间');
  }
  return {...mutation,data};
}

export class SyncedSchedules {
  constructor(store){
    this.store=store;store.db.exec(`CREATE TABLE IF NOT EXISTS schedule_hosts(owner TEXT NOT NULL,device TEXT NOT NULL,seen_at INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(owner,device));
      CREATE TABLE IF NOT EXISTS schedule_host_sessions(owner TEXT NOT NULL,session_id TEXT NOT NULL,device TEXT NOT NULL,PRIMARY KEY(owner,session_id));
      CREATE TABLE IF NOT EXISTS schedule_host_proofs(owner TEXT NOT NULL,device TEXT NOT NULL,nonce TEXT NOT NULL,session_id TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(owner,device,nonce));
      CREATE TABLE IF NOT EXISTS schedule_claims(owner TEXT NOT NULL,task_id TEXT NOT NULL,due_at TEXT NOT NULL,device TEXT NOT NULL,request_id TEXT NOT NULL,revision INTEGER NOT NULL,created_at INTEGER NOT NULL,config_hash TEXT NOT NULL,PRIMARY KEY(owner,task_id,due_at));`);
  }
  host(auth,input){
    if(memberExecution(auth))return {ok:true,executionMode:'isolated'};
    if(auth.platform&&!['macos','mac','darwin'].includes(auth.platform))throw fail('执行设备无效',403);
    let device=executionDevice(this.store,auth),proofNonce=null;
    if(input.deviceId!==undefined){
      if(typeof input.deviceId!=='string'||!/^[a-f0-9]{64}$/.test(input.deviceId))throw fail('执行 Mac 标识无效');
      if(!auth.accountSession&&input.deviceId!==auth.deviceID)throw fail('执行 Mac 标识不匹配',403);
      const existing=auth.accountSession&&this.store.db.prepare('SELECT device FROM schedule_host_sessions WHERE owner=? AND session_id=?').get(auth.owner,auth.sessionId||auth.deviceID);
      if(existing&&existing.device!==input.deviceId)throw fail('此登录会话已绑定另一台 Mac，请重新登录',409);
      device=input.deviceId;
      if(auth.accountSession&&!existing&&device!==auth.deviceID)proofNonce=verifyHostProof(auth,input,device);
    }
    const clean=value=>(Array.isArray(value)?value:[]).slice(0,100).map(x=>({id:String(x.id||'').slice(0,160),name:String(x.name||x.id||'').slice(0,160),reasoningEfforts:(x.reasoningEfforts||[]).filter(v=>typeof v==='string').slice(0,10),defaultReasoning:String(x.defaultReasoning||'medium').slice(0,30)})).filter(x=>x.id);
    const data={local:clean(input.local),cloud:clean(input.cloud),deviceName:'Mac',defaultModel:input.defaultModel||null};
    const db=this.store.db;db.exec('BEGIN IMMEDIATE');
    try{
      if(proofNonce){
        const prior=db.prepare('SELECT session_id FROM schedule_host_proofs WHERE owner=? AND device=? AND nonce=?').get(auth.owner,device,proofNonce);
        if(prior&&prior.session_id!==(auth.sessionId||auth.deviceID))throw fail('执行 Mac 身份证明已使用，请重新登记',403);
        db.prepare('INSERT OR IGNORE INTO schedule_host_proofs VALUES(?,?,?,?,?)').run(auth.owner,device,proofNonce,auth.sessionId||auth.deviceID,Date.now());
      }
      db.prepare('INSERT INTO schedule_hosts VALUES(?,?,?,?) ON CONFLICT(owner,device) DO UPDATE SET seen_at=excluded.seen_at,data=excluded.data').run(auth.owner,device,Date.now(),JSON.stringify(data));
      if(auth.accountSession&&device!==auth.deviceID){
        const session=auth.sessionId||auth.deviceID;
        db.prepare('INSERT INTO schedule_host_sessions(owner,session_id,device) VALUES(?,?,?) ON CONFLICT(owner,session_id) DO UPDATE SET device=excluded.device').run(auth.owner,session,device);
        // An older account client could publish its session as the executor.
        // Only this authenticated session's records move to its proven Mac.
        const rows=db.prepare("SELECT id,data FROM sync_entities WHERE owner=? AND kind='scheduledTasks' AND deleted=0 AND json_extract(data,'$.executorDeviceId')=?").all(auth.owner,session);
        for(const row of rows)this.store.write(auth.owner,'scheduledTasks',row.id,{...JSON.parse(row.data),executorDeviceId:device});
        db.prepare('UPDATE schedule_claims SET device=? WHERE owner=? AND device=?').run(device,auth.owner,session);
      }
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    return {ok:true};
  }
  listing(auth){
    const rows=this.store.db.prepare("SELECT * FROM sync_entities WHERE owner=? AND kind='scheduledTasks' AND deleted=0").all(auth.owner);
    const host=this.store.db.prepare('SELECT * FROM schedule_hosts WHERE owner=? ORDER BY seen_at DESC LIMIT 1').get(auth.owner);
    return {ok:true,tasks:rows.map(r=>({...JSON.parse(r.data),revision:Number(r.revision)})),host:memberExecution(auth)?{deviceId:'isolated',deviceName:'独立工作区',online:true,local:[],cloud:verifiedCatalog(),executionMode:'isolated'}:host?{deviceId:host.device,online:Date.now()-host.seen_at<45000,...JSON.parse(host.data)}:null};
  }
  mutate(auth,input,taskId=null,remove=false){
    if(!id(input.requestId)||!id(input.id||taskId)||!Number.isSafeInteger(input.revision)||input.revision<0)throw fail('缺少有效请求标识或版本');
    const identifier=taskId||input.id;
    const data=input.task||{};
    // A transport receipt is tied to the exact frozen mobile payload. Hydrating
    // live Mac state must not alter its fingerprint on a retry.
    const raw={mutationId:input.requestId,kind:'scheduledTasks',id:identifier,baseRevision:input.revision,deleted:remove,data:remove?null:data};
    const result=this.store.apply(auth.owner,[raw],0,1,auth);
    if(result.conflicts?.length)throw fail('任务已在另一端更新，请刷新后重新编辑',409);
    const current=this.store.get(auth.owner,'scheduledTasks',identifier);
    return {ok:true,...(current?.deleted?{id:identifier,deleted:true}:{task:{...current.data,revision:current.revision}})};
  }
  claim(auth,taskId,input){
    if(memberExecution(auth))throw fail('此任务由独立工作区调度执行',403);
    if((auth.platform&&!['macos','mac','darwin'].includes(auth.platform))||!id(input.requestId)||!Number.isSafeInteger(input.revision)||typeof input.dueAt!=='string'||!Number.isFinite(Date.parse(input.dueAt)))throw fail('执行声明无效',403);
    const device=executionDevice(this.store,auth),db=this.store.db;db.exec('BEGIN IMMEDIATE');
    try{
      const prior=db.prepare('SELECT * FROM schedule_claims WHERE owner=? AND task_id=? AND due_at=?').get(auth.owner,taskId,input.dueAt);
      const current=this.store.get(auth.owner,'scheduledTasks',taskId);
      const registered=db.prepare('SELECT 1 FROM schedule_hosts WHERE owner=? AND device=?').get(auth.owner,device);
      if(!registered)throw fail('执行 Mac 尚未登记',403);
      if(prior){
        if(canonicalDevice(this.store,auth.owner,prior.device)!==device||prior.request_id!==input.requestId)throw fail('该时间段已经由其他执行处理',409);
        if(!current||current.deleted||!current.data.enabled||canonicalDevice(this.store,auth.owner,current.data.executorDeviceId)!==device||configHash(current.data)!==prior.config_hash)throw fail('任务配置已修改，本次执行已停止',409);
        db.exec('COMMIT');return {ok:true,claimed:true,replayed:true};
      }
      if(!current||current.deleted||current.revision!==input.revision||!current.data.enabled||canonicalDevice(this.store,auth.owner,current.data.executorDeviceId)!==device||current.data.nextRunAt!==input.dueAt)throw fail('任务配置已经更新，请同步后继续',409);
      db.prepare('INSERT INTO schedule_claims VALUES(?,?,?,?,?,?,?,?)').run(auth.owner,taskId,input.dueAt,device,input.requestId,current.revision,Date.now(),configHash(current.data));
      db.exec('COMMIT');return {ok:true,claimed:true,replayed:false};
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
}
