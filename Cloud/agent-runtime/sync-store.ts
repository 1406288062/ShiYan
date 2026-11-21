import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { displayItemsForJob, projectDisplayItem, projectUsage, terminalJobStatus } from './output-display.mjs';
import { mobileSyncChange } from './sync-mobile-projection.mjs';
import { prepareScheduleMutation, SCHEDULE_CONFIG, SCHEDULE_REPORT } from './sync-schedules.mjs';
import { generatedOutputs } from './generated-output.mjs';

const KINDS = new Set(['projects', 'conversations', 'messages', 'scheduledTasks']);
const LOCAL = new Set(['draft','queue','queuedMessages','pendingJobId','pendingMessageId','pendingRequestId','lastEventId','submissionFailed','fileChangeRoots','localPath','path','directory','url','publicURL']);
const KEYS = {
  scheduledTasks:['id',...SCHEDULE_CONFIG,...SCHEDULE_REPORT],
  projects:['id','name','createdAt','isPinned'],
  conversations:['id','title','projectId','createdAt','updatedAt','remoteConversationId','threadId','titleIsManual','isPinned'],
  messages:['id','conversationId','role','text','assets','createdAt','completedAt','state','phase','error','requestId','remoteJobId','reasoning','model','fileChanges','rawResult','displayItems','usage','requestStartedAt','updatedAt'],
};
const ASSET_KEYS=['id','syncAssetId','filename','mimeType','bytes','sha256','width','height'];
const hash = value => createHash('sha256').update(value).digest('hex');
const failure = (message,status=400) => Object.assign(new Error(message),{status});
const validId = value => typeof value==='string' && /^[A-Za-z0-9_-]{1,120}$/.test(value);
const stable = value => Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
const canonical = value => JSON.stringify(stable(value));
const SOURCE_FINGERPRINT = Symbol('sourceFingerprint');
const iso = value => typeof value==='number'?new Date(value).toISOString():value;

export function cleanSyncData(kind,id,input) {
  if(!KINDS.has(kind)||!validId(id)||!input||typeof input!=='object'||Array.isArray(input))throw failure('同步记录无效');
  const data={id};
  for(const key of KEYS[kind])if(key!=='id'&&!LOCAL.has(key)&&Object.hasOwn(input,key))data[key]=input[key];
  if(kind==='messages'){
    if(!validId(data.conversationId)||!['user','assistant','system'].includes(data.role))throw failure('消息同步记录无效');
    if(data.text!==undefined&&(typeof data.text!=='string'||data.text.length>2_000_000))throw failure('消息同步内容过大');
    if(data.displayItems!==undefined){
      if(!Array.isArray(data.displayItems))throw failure('输出显示记录无效');
      data.displayItems=displayItemsForJob({displayItems:data.displayItems.map(item=>projectDisplayItem(item)).filter(Boolean)});
    }
    if(data.usage!==undefined)data.usage=projectUsage(data.usage);
    data.assets=(data.role==='assistant'?generatedOutputs(data.assets):(Array.isArray(data.assets)?data.assets:[])).map(asset=>{
      if(!asset||typeof asset!=='object')return null;
      const identifier=asset.syncAssetId||asset.remoteId;
      if(!validId(identifier))return null;
      return Object.fromEntries(ASSET_KEYS.filter(key=>key!=='syncAssetId'&&Object.hasOwn(asset,key)).map(key=>[key,asset[key]]).concat([['syncAssetId',identifier]]));
    }).filter(Boolean);
  }
  if(kind==='conversations'&&data.projectId!==undefined&&data.projectId!==null&&!validId(data.projectId))throw failure('项目同步标识无效');
  const json=canonical(data);
  if(Buffer.byteLength(json)>4*1024*1024)throw failure('同步记录过大',413);
  return JSON.parse(json);
}

export class SyncStore {
  constructor(root,{databasePath=path.join(root,'sync.sqlite3')}={}) {
    mkdirSync(root,{recursive:true,mode:0o700});
    this.root=root;this.assetRoot=path.join(root,'sync-assets');mkdirSync(this.assetRoot,{recursive:true,mode:0o700});
    this.db=new DatabaseSync(databasePath);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS sync_entities(owner TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,deleted INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(owner,kind,id));
      CREATE TABLE IF NOT EXISTS sync_changes(seq INTEGER PRIMARY KEY AUTOINCREMENT,owner TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,deleted INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS sync_changes_owner_seq ON sync_changes(owner,seq);
      CREATE TABLE IF NOT EXISTS sync_mutations(owner TEXT NOT NULL,id TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(owner,id));
      CREATE INDEX IF NOT EXISTS sync_message_request ON sync_entities(owner,kind,json_extract(data,'$.requestId'));
      CREATE INDEX IF NOT EXISTS sync_message_job ON sync_entities(owner,kind,json_extract(data,'$.remoteJobId'));
      CREATE TABLE IF NOT EXISTS sync_assets(owner TEXT NOT NULL,id TEXT NOT NULL,filename TEXT NOT NULL,mime_type TEXT NOT NULL,bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,file_name TEXT NOT NULL,PRIMARY KEY(owner,id));
      CREATE TABLE IF NOT EXISTS sync_generated_assets(owner TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,file TEXT NOT NULL,PRIMARY KEY(owner,id));
      CREATE TABLE IF NOT EXISTS sync_job_workspaces(owner TEXT NOT NULL,job_id TEXT NOT NULL,conversation_id TEXT NOT NULL,workspace_key TEXT NOT NULL,PRIMARY KEY(owner,job_id,conversation_id));`);
    this.removeInternalGeneratedAttachments();
  }
  removeInternalGeneratedAttachments(){
    // Emit a new revision so already caught-up phones discard old helper cards.
    // The files and user uploads stay intact; only assistant references change.
    this.db.exec('BEGIN IMMEDIATE');
    try{
      // Iterate one JSON payload at a time; long execution archives must not all
      // become resident during startup. write() upserts the existing primary
      // key without replacing its row, so this cursor visits each record once.
      const rows=this.db.prepare("SELECT * FROM sync_entities WHERE kind='messages' AND deleted=0 AND json_extract(data,'$.role')='assistant'").iterate();
      for(const row of rows){
        const data=JSON.parse(row.data);
        if(!Array.isArray(data.assets))continue;
        const assets=generatedOutputs(data.assets);
        if(assets.length!==data.assets.length)this.write(row.owner,row.kind,row.id,{...data,assets});
      }
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  close(){this.db.close();}
  change(row){return row?{kind:row.kind,id:row.id,revision:Number(row.revision),deleted:Boolean(row.deleted),data:JSON.parse(row.data)}:null;}
  get(owner,kind,id){return this.change(this.db.prepare('SELECT * FROM sync_entities WHERE owner=? AND kind=? AND id=?').get(owner,kind,id));}
  recordJobWorkspace(owner,jobId,conversationId,workspaceKey){
    if(typeof owner!=='string'||!owner||!validId(jobId)||!validId(conversationId)||!/^[a-f0-9]{64}$/.test(workspaceKey||''))return false;
    this.db.prepare('INSERT OR IGNORE INTO sync_job_workspaces(owner,job_id,conversation_id,workspace_key) VALUES(?,?,?,?)').run(owner,jobId,conversationId,workspaceKey);
    return this.jobWorkspace(owner,jobId,conversationId)===workspaceKey;
  }
  jobWorkspace(owner,jobId,conversationId){
    if(!validId(jobId)||!validId(conversationId))return null;
    return this.db.prepare('SELECT workspace_key FROM sync_job_workspaces WHERE owner=? AND job_id=? AND conversation_id=?').get(owner,jobId,conversationId)?.workspace_key||null;
  }
  write(owner,kind,id,data,deleted=false){
    const current=this.get(owner,kind,id);
    const before=current?.data;
    const sameJob=before?.remoteJobId&&data.remoteJobId?before.remoteJobId===data.remoteJobId:before?.requestId&&before.requestId===data.requestId;
    if(!deleted&&kind==='messages'&&before?.role==='assistant'&&before.state==='completed'&&sameJob&&['submitting','pending','queued','running','thinking','reconnecting'].includes(data.state))return current;
    if(!deleted&&kind==='messages'&&before?.role==='assistant'&&['failed','cancelled'].includes(before.state)&&!before.remoteJobId&&!data.remoteJobId&&before.requestId&&before.requestId===data.requestId&&data.state==='submitting')return current;
    // A sync revision orders deliveries, not execution progress. Late clients
    // can submit an older snapshot against the latest revision of the same job.
    if(!deleted&&kind==='messages'&&before?.role==='assistant'&&sameJob){
      const previousAt=Date.parse(before.updatedAt||''),incomingAt=Date.parse(data.updatedAt||'');
      if(Number.isFinite(previousAt)&&Number.isFinite(incomingAt)&&incomingAt<previousAt)return current;
      const working=['submitting','pending','queued','running','thinking','reconnecting'];
      if(working.includes(data.state)&&(!Number.isFinite(incomingAt)||incomingAt===previousAt)
        &&typeof before.text==='string'&&typeof data.text==='string'
        &&before.text.length>data.text.length&&before.text.startsWith(data.text))return current;
    }
    const encoded=canonical(data);
    if(current?.deleted&&!deleted)return current;
    if(current&&current.deleted===deleted&&canonical(current.data)===encoded)return current;
    const revision=(current?.revision||0)+1;
    this.db.prepare('INSERT INTO sync_entities(owner,kind,id,revision,deleted,data) VALUES(?,?,?,?,?,?) ON CONFLICT(owner,kind,id) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted,data=excluded.data').run(owner,kind,id,revision,deleted?1:0,encoded);
    this.db.prepare('INSERT INTO sync_changes(owner,kind,id,revision,deleted,data) VALUES(?,?,?,?,?,?)').run(owner,kind,id,revision,deleted?1:0,encoded);
    return {kind,id,revision,deleted,data:JSON.parse(encoded)};
  }
  putAuthoritative(owner,kind,id,input){
    this.db.exec('BEGIN IMMEDIATE');try{const current=this.get(owner,kind,id);if(current?.deleted){this.db.exec('COMMIT');return current;}const data=cleanSyncData(kind,id,{...(current?.data||{}),...input});const result=this.write(owner,kind,id,data);this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  list(owner,after=0,limit=200,{mobile=false,projectChange=null,includeOrder=false}={}){
    after=Number(after);limit=Number(limit);
    if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>500)throw failure('同步游标无效');
    // A sync cursor tracks entity snapshots, not every intermediate tool update.
    // Group the entire backlog before paginating so old large records are sent
    // once, rather than once per historical window.
    const rows=this.db.prepare(`SELECT c.* FROM sync_changes c JOIN (
      SELECT MAX(seq) AS seq FROM sync_changes WHERE owner=? AND seq>?
      GROUP BY kind,id
    ) latest ON c.seq=latest.seq ORDER BY c.seq LIMIT ?`).all(owner,after,limit+1);
    const visible=new Map(),order=[];let bytes=0,consumed=0,cursor=after;
    const currentEntity=this.db.prepare('SELECT * FROM sync_entities WHERE owner=? AND kind=? AND id=?');
    for(const row of rows.slice(0,limit)){
      // iOS cannot import a message before its conversation exists. Include the
      // parent snapshot even if its last update lies on a later page.
      const parentId=row.kind==='messages'?JSON.parse(row.data).conversationId:null;
      const parent=parentId&&!visible.has('conversations:'+parentId)?currentEntity.get(owner,'conversations',parentId):null;
      const key=row.kind+':'+row.id,previous=visible.get(key);
      const projected=projectChange?projectChange(this.change(row)):mobile?mobileSyncChange(this.change(row)):null;
      const size=projected?Buffer.byteLength(JSON.stringify(projected))+256:Buffer.byteLength(row.data)+256;
      const parentSize=parent?Buffer.byteLength(parent.data)+256:0;
      const nextBytes=bytes-(previous?.size||0)+size+parentSize;
      // Always deliver one entity, even if it alone exceeds the page target.
      if(consumed&&nextBytes>96*1024)break;
      if(parent)visible.set('conversations:'+parentId,{row:parent,size:parentSize});
      visible.set(key,{row,size,projected});bytes=nextBytes;consumed++;cursor=Number(row.seq);
      if(includeOrder)order.push({kind:row.kind,id:row.id,seq:Number(row.seq)});
    }
    return {ok:true,cursor,hasMore:rows.length>consumed,changes:[...visible.values()].map(({row,projected})=>projected||this.change(row)),...(includeOrder?{order}:{})};
  }
  // Check the original wire fingerprint before hydration or archive fallback.
  // A replay still goes through apply() so receipt/conflict semantics stay intact.
  hasMutation(owner,mutation){
    if(!mutation||typeof mutation!=='object'||!validId(mutation.mutationId)||!KINDS.has(mutation.kind)||!validId(mutation.id)||!Number.isSafeInteger(mutation.baseRevision)||mutation.baseRevision<0||typeof mutation.deleted!=='boolean')throw failure('同步更新无效');
    const prior=this.db.prepare('SELECT fingerprint FROM sync_mutations WHERE owner=? AND id=?').get(owner,mutation.mutationId);
    if(!prior)return false;
    const fingerprint=mutation[SOURCE_FINGERPRINT]||hash(canonical(mutation));
    if(prior.fingerprint!==fingerprint)throw failure('同步更新标识已使用',409);
    return true;
  }
  apply(owner,mutations,after=0,limit=200,auth={},options={}){
    if(!Array.isArray(mutations)||mutations.length>200)throw failure('同步更新数量无效');
    // Validate before committing even when the HTTP layer will read the delta.
    after=Number(after);limit=Number(limit);
    if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>500)throw failure('同步游标无效');
    const accepted=[],conflicts=[];
    this.db.exec('BEGIN IMMEDIATE');
    try{
      for(const mutation of mutations){
        const {mutationId,kind,id}=mutation;
        if(!validId(mutationId)||!KINDS.has(kind)||!validId(id)||!Number.isSafeInteger(mutation.baseRevision)||mutation.baseRevision<0||typeof mutation.deleted!=='boolean')throw failure('同步更新无效');
        const fingerprint=mutation[SOURCE_FINGERPRINT]||hash(canonical(mutation));
        const prior=this.db.prepare('SELECT fingerprint,result FROM sync_mutations WHERE owner=? AND id=?').get(owner,mutationId);
        if(prior){if(prior.fingerprint!==fingerprint)throw failure('同步更新标识已使用',409);const result=JSON.parse(prior.result);(result.accepted?accepted:conflicts).push(result.accepted||result.conflict);continue;}
        const current=this.get(owner,kind,id);
        let result;
        if((current?.revision||0)!==mutation.baseRevision||(current?.deleted&&!mutation.deleted)){
          result={conflict:{mutationId,current:current||{kind,id,revision:0,deleted:false,data:{id}}}};conflicts.push(result.conflict);
        }else{
          const prepared=kind==='scheduledTasks'?prepareScheduleMutation(this,owner,mutation,auth):mutation;
          const data=mutation.deleted?(current?.data||{id}):cleanSyncData(kind,id,prepared.data);
          const next=this.write(owner,kind,id,data,mutation.deleted);
          result={accepted:{mutationId,kind,id,revision:next.revision}};accepted.push(result.accepted);
        }
        this.db.prepare('INSERT INTO sync_mutations(owner,id,fingerprint,result) VALUES(?,?,?,?)').run(owner,mutationId,fingerprint,JSON.stringify(result));
      }
      // HTTP requests already fetch/project their delta after apply(). Keep the
      // write transaction short and do not read/parse the same history twice.
      if(options.includeDelta===false){this.db.exec('COMMIT');return {ok:true,accepted,conflicts};}
      const delta=this.list(owner,after,limit);const response=withAcceptedSnapshots({...delta,accepted,conflicts},this,owner);this.db.exec('COMMIT');return response;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  matchingMessages(owner,requestId,jobId){
    // Two exact index lookups preserve OR semantics without parsing every
    // message JSON. Deduplicate records that match both identifiers.
    const rows=new Map();
    if(requestId!=null)for(const row of this.db.prepare("SELECT * FROM sync_entities WHERE owner=? AND kind='messages' AND deleted=0 AND json_extract(data,'$.requestId')=?").all(owner,requestId))rows.set(row.id,row);
    if(jobId!=null)for(const row of this.db.prepare("SELECT * FROM sync_entities WHERE owner=? AND kind='messages' AND deleted=0 AND json_extract(data,'$.remoteJobId')=?").all(owner,jobId))rows.set(row.id,row);
    return [...rows.values()].map(row=>this.change(row));
  }
  asset(owner,id){
    const row=this.db.prepare('SELECT * FROM sync_assets WHERE owner=? AND id=?').get(owner,id);
    if(!row){const generated=this.db.prepare('SELECT data FROM sync_generated_assets WHERE owner=? AND id=?').get(owner,id);return generated?JSON.parse(generated.data):null;}
    return {id:row.id,syncAssetId:row.id,filename:row.filename,mimeType:row.mime_type,bytes:Number(row.bytes),sha256:row.sha256};
  }
  assetFile(owner,id){const row=this.db.prepare('SELECT file_name FROM sync_assets WHERE owner=? AND id=?').get(owner,id);if(row)return path.join(this.assetRoot,row.file_name);return this.db.prepare('SELECT file FROM sync_generated_assets WHERE owner=? AND id=?').get(owner,id)?.file||null;}
  registerGeneratedAsset(asset){
    if(!asset?.owner||!validId(asset.id)||typeof asset.file!=='string'||!path.resolve(asset.file).startsWith(path.resolve(this.root,'artifacts')+path.sep))return null;
    const metadata={id:asset.id,syncAssetId:asset.id,filename:asset.filename,mimeType:asset.mimeType,bytes:asset.bytes,sha256:asset.sha256};
    this.db.prepare('INSERT OR IGNORE INTO sync_generated_assets(owner,id,data,file) VALUES(?,?,?,?)').run(asset.owner,asset.id,JSON.stringify(metadata),asset.file);
    return metadata;
  }
  saveAsset(owner,input){
    if(!validId(input.id)||typeof input.filename!=='string'||input.filename.length>255||typeof input.mimeType!=='string'||! /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+(?:;[a-zA-Z0-9= ._-]+)?$/.test(input.mimeType)||input.mimeType.length>120||typeof input.data!=='string'||input.data.length>90*1024*1024||!/^[A-Za-z0-9+/]*={0,2}$/.test(input.data))throw failure('同步附件无效');
    const bytes=Buffer.from(input.data,'base64');if(!bytes.length||bytes.length>64*1024*1024)throw failure('同步附件过大',413);
    const digest=hash(bytes),existing=this.asset(owner,input.id);if(existing){if(existing.sha256!==digest)throw failure('同步附件标识已使用',409);return existing;}
    const filename=path.basename(input.filename).replace(/[\x00-\x1f\x7f]/g,'_')||'attachment';
    const fileName=hash(owner+':'+input.id)+'.blob',file=path.join(this.assetRoot,fileName),temporary=file+'.'+randomUUID()+'.tmp';
    writeFileSync(temporary,bytes,{mode:0o600});
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const raced=this.asset(owner,input.id);
      if(raced){if(raced.sha256!==digest)throw failure('同步附件标识已使用',409);this.db.exec('COMMIT');return raced;}
      renameSync(temporary,file);
      this.db.prepare('INSERT INTO sync_assets(owner,id,filename,mime_type,bytes,sha256,file_name) VALUES(?,?,?,?,?,?,?)').run(owner,input.id,filename,input.mimeType,bytes.length,digest,fileName);
      this.db.exec('COMMIT');return this.asset(owner,input.id);
    }catch(error){this.db.exec('ROLLBACK');throw error;}
    finally{if(existsSync(temporary))unlinkSync(temporary);}
  }
}

export function withAcceptedSnapshots(response,store,owner){
  // A hydrated mutation may be accepted without creating a new revision. Its
  // receipt alone cannot tell a legacy client that its stale output was replaced.
  const changes=new Map(response.changes.map(change=>[change.kind+':'+change.id,change]));
  for(const receipt of response.accepted||[]){
    const current=store.get(owner,receipt.kind,receipt.id);if(!current)continue;
    if(current.kind==='messages'&&validId(current.data.conversationId)){
      const parent=store.get(owner,'conversations',current.data.conversationId);
      if(parent)changes.set(parent.kind+':'+parent.id,parent);
    }
    changes.set(current.kind+':'+current.id,current);
  }
  const rank={projects:0,conversations:1,messages:2,scheduledTasks:3};
  return {...response,changes:[...changes.values()].sort((a,b)=>rank[a.kind]-rank[b.kind])};
}

export function jobMessageData(job,base){
  const assistant=base.role==='assistant';
  const state=job.status==='completed'?'completed':job.status==='cancelled'?'cancelled':['failed','interrupted'].includes(job.status)?'failed':'running';
  const phase=[...(job.events||[])].reverse().find(event=>event.type==='phase');
  return {...base,requestId:job.requestId,remoteJobId:job.id,reasoning:job.reasoning,model:job.model,
    ...(assistant?{text:job.text||'',state,phase:terminalJobStatus(job.status)?'':phase?.label||base.phase||'',error:job.error||null,
      displayItems:displayItemsForJob(job),usage:projectUsage(job.usage),
      requestStartedAt:base.requestStartedAt||base.createdAt||iso(job.createdAt),completedAt:['completed','cancelled','failed'].includes(state)?iso(job.updatedAt):null,
      assets:generatedOutputs(job.assets).map(asset=>({...asset,syncAssetId:asset.id})),...(job.fileChanges?{fileChanges:job.fileChanges}:{})}:{state:'completed'}),
    ...(assistant?{updatedAt:iso(job.updatedAt)}:{})};
}

export function materializeJob(store,job,conversation){
  if(!job?.owner||!job.requestId)return;
  // A legacy phone can publish its empty conversation before its message batch.
  // Refresh that existing record independently; never invent message IDs or
  // recreate a missing/deleted conversation while waiting for the real batch.
  const remoteId=conversation?.id;
  if(typeof remoteId==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(remoteId)){
    const cid=remoteId.toLowerCase(),record=store.get(job.owner,'conversations',cid);
    if(record&&!record.deleted&&(!record.data.updatedAt||Date.parse(record.data.updatedAt)<=job.updatedAt)){
      const existing=record.data;
      store.putAuthoritative(job.owner,'conversations',cid,{id:cid,updatedAt:iso(job.updatedAt),
        remoteConversationId:remoteId,threadId:job.threadId||conversation?.threadId||existing.threadId||null,
        ...(!existing.titleIsManual&&conversation?.title?{title:conversation.title}:{}),
        ...(job.projectId!==undefined?{projectId:job.projectId}:{})});
    }
  }
  const found=store.matchingMessages(job.owner,job.requestId,job.id);
  if(validId(job.syncConversationId)){
    for(const [role,id] of [['user',job.userMessageId],['assistant',job.assistantMessageId]]){
      if(!validId(id)||store.get(job.owner,'messages',id)?.deleted||found.some(message=>message.id===id))continue;
      found.push({id,data:{id,conversationId:job.syncConversationId,role,text:role==='user'?job.prompt:'',createdAt:iso(job.createdAt),assets:[]}});
    }
  }
  for(const message of found){
    const cid=message.data.conversationId;
    if(!validId(cid)||store.get(job.owner,'conversations',cid)?.deleted)continue;
    store.recordJobWorkspace(job.owner,job.id,cid,conversation?.workspaceKey||job.conversationKey);
    const existing=store.get(job.owner,'conversations',cid)?.data||{};
    if(!existing.updatedAt||Date.parse(existing.updatedAt)<=job.updatedAt)store.putAuthoritative(job.owner,'conversations',cid,{id:cid,...(!existing.createdAt?{createdAt:iso(job.createdAt)}:{}),
      updatedAt:iso(job.updatedAt),remoteConversationId:conversation?.id||existing.remoteConversationId||cid,
      threadId:job.threadId||conversation?.threadId||existing.threadId||null,
      ...(!existing.titleIsManual&&conversation?.title?{title:conversation.title}:{}),
      ...(job.projectId!==undefined?{projectId:job.projectId}:{})});
    store.putAuthoritative(job.owner,'messages',message.id,jobMessageData(job,message.data));
  }
}

export function hydrateMutation(mutation,owner,state){
  if(mutation.kind!=='messages'||mutation.deleted||!mutation.data)return mutation;
  const data=mutation.data;
  const job=state.jobs?.[data.remoteJobId]||state.jobs?.[state.requests?.[owner+':'+data.requestId]];
  if(!job||job.owner!==owner)return mutation;
  return {...mutation,data:jobMessageData(job,data),[SOURCE_FINGERPRINT]:mutation[SOURCE_FINGERPRINT]||hash(canonical(mutation))};
}

// Compact clients edit message metadata without holding full execution records.
// Restore those records from this exact account/message before replacing it.
export function hydrateCompactMutation(mutation,owner,store){
  if(mutation.kind!=='messages'||mutation.deleted||!mutation.data)return mutation;
  const changed=mutation.data.executionDetailsChanged;
  if(changed!==undefined&&(!Array.isArray(changed)||new Set(changed).size!==changed.length
    ||changed.some(key=>!['rawResult','fileChanges','displayItems'].includes(key)||!Object.hasOwn(mutation.data,key))))
    throw failure('执行详情更新字段无效',400);
  if(mutation.data.executionDetailsAvailable!==true){
    if(changed?.length)throw failure('执行详情更新缺少同步标记',400);
    return mutation;
  }
  const current=store.get(owner,'messages',mutation.id),data=mutation.data;
  // Stale revisions and tombstones must reach normal conflict/idempotency handling.
  // They cannot be applied, so restoring details would only obstruct resolution.
  if(!current&&mutation.baseRevision!==0)return mutation;
  if(current&&(current.deleted||current.revision!==mutation.baseRevision))return mutation;
  if(!current||current.data.role!==data.role||current.data.conversationId!==data.conversationId)
    throw failure('完整执行记录暂不可用，请重新同步后重试',409);
  const restored={...data};
  for(const key of ['rawResult','fileChanges','displayItems']){
    if(changed?.includes(key))continue;
    if(Object.hasOwn(current.data,key))restored[key]=current.data[key];
    else delete restored[key];
  }
  delete restored.executionDetailsAvailable;
  delete restored.executionDetailsChanged;
  return {...mutation,data:restored,[SOURCE_FINGERPRINT]:mutation[SOURCE_FINGERPRINT]||hash(canonical(mutation))};
}

export function hydrateStoredMutation(mutation,owner,store){
  if(mutation.kind!=='messages'||mutation.deleted||!mutation.data)return mutation;
  const data=mutation.data;
  if(!data.requestId&&!data.remoteJobId)return mutation;
  const authoritative=store.matchingMessages(owner,data.requestId||null,data.remoteJobId||null)
    .filter(message=>message.data.role===data.role&&message.data.remoteJobId
      &&(!data.remoteJobId||message.data.remoteJobId===data.remoteJobId))
    .sort((a,b)=>{
      const updated=(Date.parse(b.data.updatedAt||'')||0)-(Date.parse(a.data.updatedAt||'')||0);
      if(updated)return updated;
      const completed=Number(b.data.state==='completed')-Number(a.data.state==='completed');
      return completed||String(b.data.text||'').length-String(a.data.text||'').length;
    })[0];
  if(!authoritative)return mutation;
  return {...mutation,data:{...data,...authoritative.data,id:mutation.id,
    conversationId:data.conversationId,role:data.role,
    ...(data.role==='user'?{text:data.text,assets:data.assets||[]}:{})},
    [SOURCE_FINGERPRINT]:mutation[SOURCE_FINGERPRINT]||hash(canonical(mutation))};
}

export function readSyncAsset(store,state,owner,id){
  const metadata=store.asset(owner,id);if(metadata)return {metadata,file:store.assetFile(owner,id)};
  const asset=state.assets?.[id];if(asset?.owner!==owner)return null;
  return {metadata:{id,syncAssetId:id,filename:asset.filename,mimeType:asset.mimeType,bytes:asset.bytes,sha256:asset.sha256},file:asset.file};
}
