import { sendSyncAsset } from './sync-asset-response.mjs';
// Shiyan-only, authenticated job/event transport. Does not change the shared 4320 service.
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync=promisify(execFile);
import path from 'node:path';
import os from 'node:os';
import { promises as fs, watch, readFileSync, mkdirSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Codex } from '@openai/codex-sdk';
import { refreshCatalog, verifiedCatalog, getProvider, providerStatus } from './providers/index.mjs';
import { transcriptText, appendTranscript, retainTranscript } from './providers/transcript.mjs';
import { conversationTitle, memberConversationTitle } from './session-title.mjs';
import { createHubClient } from '/home/ubuntu/model-hub/client.mjs';
// 每轮普通对话结束后向模型中枢上报一条元数据（账号、模型、耗时、结果），不含对话内容。
const modelHub = createHubClient();
import { reconcileImageResultText, verifiedGeneratedImageCount } from './image-result-consistency.mjs';
import { generatedOutputVisible, generatedOutputs, generatedPathVisible } from './generated-output.mjs';
import {snapshotWorkspace,collectFileChanges} from './file-changes.mjs';
import {remoteChangeManifestPath} from './remote-file-changes.mjs';
import { normalizeHistory } from './edit-history.mjs';
import { agentPrompt } from './agent-input.mjs';
import { normalizeFiles, writeFileInputs } from './file-input.mjs';
import { createQuotaReader } from './account-quota.mjs';
const readQuota=createQuotaReader();
import { forkPreviousTurns } from './edit-fork.mjs';
import { JobImageUploads } from './job-image-uploads.mjs';
import { authenticateDevice as authenticate, enrollDevice, digest } from './device-auth.mjs';
import { SyncStore, materializeJob, hydrateMutation, readSyncAsset } from './sync-store.mjs';
import { displayItemsForJob, upsertDisplayItem, jobSnapshot, projectUsage } from './output-display.mjs';
import { createJobDeadline, jobFailure, jobTimeouts } from './job-deadline.mjs';
import { UserInputStore } from './user-input.mjs';
import { MemoryStore } from './memory-store.mjs';
import { createChatMemory } from './memory-chat.mjs';
import { handleAccountRequest } from './account-http.mjs';
import { accountAccess, getAccountStore, requestBearer } from './accounts.mjs';
import { createWorkspaceHandler } from './workspace-http.mjs';
import { createSpongeHTTPHandler } from './sponge-http.mjs';
import { MemberScheduleWorker } from './member-schedules.mjs';
import { loadRuntimeState } from './runtime-state.mjs';

const ROOT = process.env.SHIYAN_ROOT || '/home/ubuntu/boss-codex-service/shiyan-v2';
const PORT = Number(process.env.SHIYAN_PORT || 4323);
const MODEL = process.env.CODEX_MODEL || 'gpt-6-luna';
const DATA = path.join(ROOT, 'data');
const ARTIFACTS = path.join(DATA, 'artifacts');
const WORKSPACES = path.join(ROOT, 'workspaces');
const GENERATED = path.join(os.homedir(), '.codex/generated_images');
for (const dir of [DATA, ARTIFACTS, WORKSPACES]) mkdirSync(dir, {recursive:true,mode:0o700});
const atomic = (file, value) => { const tmp=file+'.tmp'; writeFileSync(tmp,JSON.stringify(value),{mode:0o600}); renameSync(tmp,file); };
const readJSON = (file, fallback) => {try {return JSON.parse(readFileSync(file,'utf8'));} catch {return fallback;}};
const MEMBER_ONLY=process.env.SHIYAN_MEMBER_ONLY==='1';
const {file:statePath,state}=loadRuntimeState({data:DATA,stateFile:process.env.SHIYAN_STATE_FILE,memberOnly:MEMBER_ONLY,access:accountAccess});
for(const job of Object.values(state.jobs))job.assets=generatedOutputs(job.assets);
const syncStore = new SyncStore(DATA);
const jobImageUploads = new JobImageUploads(DATA);
const userInputs = new UserInputStore(DATA);
const memoryStore = new MemoryStore(DATA);
const chatMemory = createChatMemory(memoryStore,{syncStore,state,logger:console});
for (const job of Object.values(state.jobs)) if (['queued','running'].includes(job.status)) {
  job.status='interrupted'; job.error='服务重新启动，本次处理已中断，请重试';
  userInputs.finish(job.id,'interrupted');
}
const codex = new Codex({codexPathOverride:'/home/ubuntu/.local/bin/codex'});
const listeners=new Map(), controls=new Map(), queue=[];
state.cancelledRequests ||= {}; // Tombstones cover cancel-before-submit races.
let active=0;
const diagnosticError=value=>value instanceof Error?(value.stack||value.message):String(value);
const listenerCount=()=>[...listeners.values()].reduce((sum,set)=>sum+set.size,0);
process.on('uncaughtException',error=>{
  console.error('[FatalUncaughtException]',diagnosticError(error));
  process.exit(1);
});
process.on('unhandledRejection',reason=>{
  console.error('[FatalUnhandledRejection]',diagnosticError(reason));
  process.exit(1);
});
let loopProbeAt=Date.now();
setInterval(()=>{
  const now=Date.now(),lagMs=Math.max(0,now-loopProbeAt-5000);loopProbeAt=now;
  if(lagMs>=1500){
    const m=process.memoryUsage();
    console.warn('[EventLoopLag]','lagMs',lagMs,'rssMB',Math.round(m.rss/1048576),'heapUsedMB',Math.round(m.heapUsed/1048576),'active',active,'queued',queue.length,'listeners',listenerCount());
  }
},5000).unref();
setInterval(()=>{
  const m=process.memoryUsage();
  console.log('[RuntimeHealth]','rssMB',Math.round(m.rss/1048576),'heapUsedMB',Math.round(m.heapUsed/1048576),'externalMB',Math.round(m.external/1048576),'active',active,'queued',queue.length,'listeners',listenerCount());
},60000).unref();
const PERSISTED_ACTIVE_EVENT_LIMIT=20;
const compactJobForDisk=job=>{
  const copy={...job};
  const terminalForDisk=['completed','failed','cancelled','interrupted'].includes(copy.status);
  // Completed jobs recover from their final snapshot; replaying cumulative stream events after a restart only duplicates data.
  copy.events=terminalForDisk?[]:(Array.isArray(job.events)?job.events:[]).slice(-PERSISTED_ACTIVE_EVENT_LIMIT);
  copy.displayItems=displayItemsForJob(job);
  delete copy.items;
  delete copy.displayItemOrder;
  delete copy.history;
  delete copy.uploads;
  delete copy.files;
  delete copy.lastModelText;
  if(['completed','failed','cancelled','interrupted'].includes(copy.status))delete copy.prompt;
  return copy;
};
const persistableState=()=>({...state,jobs:Object.fromEntries(Object.entries(state.jobs).map(([id,job])=>[id,compactJobForDisk(job)]))});
const save=()=>atomic(statePath,persistableState());
save();
const sha=s=>createHash('sha256').update(s).digest('hex');
const validID=s=>typeof s==='string' && /^[A-Za-z0-9_-]{8,100}$/.test(s);
const terminal=s=>['completed','failed','cancelled','interrupted'].includes(s);
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
function capabilities(modelId=MODEL){
  // 模型目录由 providers/ 统一汇总；默认模型不可用时退回目录中的第一个模型。
  const models=verifiedCatalog(),model=models.find(m=>m.id===modelId)||(modelId===MODEL?models[0]:null);
  if(!model)throw fail('当前模型能力不可用，请重新连接服务',503);
  return {model:model.id,provider:model.provider,reasoningEfforts:model.reasoningEfforts,defaultReasoning:model.defaultReasoning,models,providers:providerStatus(),capabilitiesSource:'shiyan providers',maxUploadImages:8,streams:true,resumable:true};
}
// 每个 provider 的会话上下文分开保存；openai 沿用 conv.threadId 兼容旧数据。
// 上一轮来自其它 provider 时返回 null：新开会话并带入对话记录。
function providerSession(conv,id){
  if(conv.lastProvider&&conv.lastProvider!==id)return null;
  return id==='openai'?(conv.threadId||null):(conv.sessions?.[id]||null);
}
function setProviderSession(conv,id,session){
  if(id==='openai')conv.threadId=session;else (conv.sessions||={})[id]=session;
  conv.lastProvider=id;
}
function jobProvider(job){return getProvider(job.provider||'openai');}
function sendEvent(res,event){
  if(event.type==='artifact'&&!generatedOutputVisible(event.asset))return;
  let outgoing=event;
  if(Array.isArray(event.assets))outgoing={...event,assets:generatedOutputs(event.assets)};
  if(event.type==='artifact'&&event.asset&&res.shiyanInlineArtifacts!==false){
    const asset=state.assets[event.asset.id];
    if(asset) outgoing={...event,data:readFileSync(asset.displayFile||asset.file).toString('base64'),dataMimeType:asset.displayFile?'image/jpeg':asset.mimeType,dataFilename:asset.displayFile?asset.filename.replace(/\.[^.]+$/,'.jpg'):asset.filename};
  }
  // Persist only artifact metadata; inline original bytes are attached to the live/replayed wire event.
  res.write('id: '+event.seq+'\nevent: update\ndata: '+JSON.stringify(outgoing)+'\n\n');
}
function emit(job,type,values={}) {
  const event={seq:(job.events.at(-1)?.seq||0)+1,type,at:Date.now(),...values};
  job.events.push(event);job.updatedAt=Date.now();
  if(job.events.length>12000)job.events.splice(0,job.events.length-12000);
  // Streaming events stay in memory and SQLite; avoid rewriting the whole JSON state on every event.
  try { materializeJob(syncStore,job,state.conversations[job.conversationKey]); } catch(error) { console.error('[SyncJob]',String(error.message||error).slice(0,200)); }
  for(const res of listeners.get(job.id)||[])if(!res.destroyed)sendEvent(res,event);
}
// Generated image files, not language-model guesses, determine delivery status.
function publishModelText(job, modelText, alwaysEmit=false) {
  const count=verifiedGeneratedImageCount(job,state.assets,existsSync);
  const corrected=reconcileImageResultText(modelText,count>0);
  if(corrected!==modelText) {
    job.originalModelText=modelText;
    job.consistencyCorrected=true;
  }
  const changed=corrected!==job.text;
  job.text=corrected;
  if(changed||alwaysEmit)emit(job,'text',{text:corrected,generatedImageCount:count});
}
function json(res,code,value){const body=JSON.stringify(value);res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(body),'Cache-Control':'no-store'});res.end(body);}
async function body(req,max=40*1024*1024){
  let total=0;const chunks=[];
  for await(const chunk of req){total+=chunk.length;if(total>max)throw fail('上传内容过大',413);chunks.push(chunk);}
  const data=Buffer.concat(chunks);
  if(req.headers['x-shiyan-body-sha']&&digest(data)!==req.headers['x-shiyan-body-sha'])throw fail('请求校验失败',401);
  try{return JSON.parse(data.toString()||'{}');}catch{throw fail('请求格式无效');}
}
function imageValid(bytes,ext){
  if(ext==='.png')return bytes.length>32 && bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')) && bytes.subarray(-8,-4).toString()==='IEND';
  if(['.jpg','.jpeg'].includes(ext))return bytes.length>4&&bytes[0]===255&&bytes[1]===216&&bytes.at(-2)===255&&bytes.at(-1)===217;
  if(ext==='.webp')return bytes.length>12&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'&&bytes.readUInt32LE(4)+8<=bytes.length;
  return false;
}
const mimeFor=ext=>({'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.pdf':'application/pdf','.txt':'text/plain','.md':'text/markdown','.csv':'text/csv','.json':'application/json','.html':'text/html','.zip':'application/zip','.mp3':'audio/mpeg','.wav':'audio/wav','.mp4':'video/mp4'}[ext]||'application/octet-stream');

async function capture(job,file,{imageOnly=false}={}){
  if(job.cancelRequested||job.status==='cancelled')return;
  const ext=path.extname(file).toLowerCase();
  const real=await fs.realpath(file).catch(()=>null);
  const workspaceKey=state.conversations[job.conversationKey]?.workspaceKey||job.conversationKey;
  const roots=[path.join(WORKSPACES,workspaceKey),job.threadId?path.join(GENERATED,job.threadId):null].filter(Boolean);
  const captureRoot=real&&roots.find(r=>real.startsWith(r+path.sep));
  if(!captureRoot||!generatedPathVisible(path.relative(captureRoot,real)))return;
  const base=path.basename(real);
  if(base.startsWith('.')||['.pem','.key','.cer','.env'].includes(ext)||/credentials|secret|token|auth\.json/i.test(base))return;
  const stat=await fs.stat(real).catch(()=>null);
  if(!stat?.isFile()||stat.size===0||stat.size>24*1024*1024||stat.mtimeMs<job.startedAt-2000)return;
  if(real.includes(path.sep+'inputs'+path.sep))return;
  const bytes=await fs.readFile(real);
  const isImage=['.png','.jpg','.jpeg','.webp'].includes(ext);
  if(isImage&&!imageValid(bytes,ext))return;
  if(imageOnly&&!isImage)return;
  const digest=sha(bytes);if(job.assets.some(x=>x.sha256===digest)||job.uploadHashes?.includes(digest))return;
  const id=randomUUID();const stored=path.join(ARTIFACTS,id+ext);
  await fs.writeFile(stored,bytes,{mode:0o600});
  const asset={id,filename:base,mimeType:mimeFor(ext),bytes:bytes.length,sha256:digest};
  state.assets[id]={...asset,file:stored,owner:job.owner,conversationKey:job.conversationKey};
  if(isImage){
    const display=path.join(ARTIFACTS,id+'.display.jpg');
    try{
      await execFileAsync('python3',[path.join(ROOT,'display-image.py'),stored,display],{timeout:20000,maxBuffer:8192});
      const displayStat=await fs.stat(display);
      if(displayStat.size<bytes.length*0.8)state.assets[id].displayFile=display;
      else await fs.unlink(display).catch(()=>{});
    }catch{/* Lossless original remains available, including alpha images. */}
  }
  if(job.cancelRequested||job.status==='cancelled')return;
  job.assets.push(asset);
  emit(job,'phase',{phase:'receiving',label:'结果已生成，正在接收'});
  emit(job,'artifact',{asset});
  // Image may arrive before OR after a contradictory model message.
  publishModelText(job,job.lastModelText??job.text);
}
async function scanGenerated(job){
  if(!job.threadId)return;
  const dir=path.join(GENERATED,job.threadId);
  for(const entry of await fs.readdir(dir,{withFileTypes:true}).catch(()=>[]))if(entry.isFile())await capture(job,path.join(dir,entry.name),{imageOnly:true});
}
async function monitorGenerated(job){
  if(!job.threadId)return async()=>{};
  const dir=path.join(GENERATED,job.threadId);await fs.mkdir(dir,{recursive:true});
  let debounce,chain=Promise.resolve();
  const watcher=watch(dir,()=>{clearTimeout(debounce);debounce=setTimeout(()=>{chain=chain.then(()=>scanGenerated(job)).catch(()=>{});},250);});
  watcher.on('error',()=>{});
  return async()=>{watcher.close();clearTimeout(debounce);await chain;await scanGenerated(job);};
}
async function runJob(job){
  active++;job.status='running';job.startedAt=Date.now();
  const abort=new AbortController();controls.set(job.id,abort);
  const deadline=createJobDeadline({...jobTimeouts(),onExpire:error=>abort.abort(error)});
  // Waiting for an explicit answer is activity and renews the idle deadline.
  // No question content enters the large state payload.
  const inputHeartbeat=setInterval(()=>{if(userInputs.hasPending(job.id))deadline.touch();},5000);inputHeartbeat.unref();
  let privileged = false;
  const accessHeartbeat=setInterval(()=>{
    const access=accountAccess(job.owner);
    if(access.status!=='active'||(privileged&&(access.role!=='admin'||!access.serverAccess)))abort.abort(new Error('账户权限已变更，请重新登录'));
  },1000);accessHeartbeat.unref();
  let stopWatch=async()=>{},beforeChanges=null,changeRoot=null;
  try{
    const conv=state.conversations[job.conversationKey];
    const access=accountAccess(job.owner);
    if(access.status!=='active')throw fail('账户不可用，请重新登录',403);
    privileged=!MEMBER_ONLY&&access.role==='admin'&&access.serverAccess===true;
    if(!privileged){
      const history=conv.memberHistory||job.history||[];
      emit(job,'phase',{phase:'processing',label:'正在回复',reasoning:job.reasoning});
      const result=await jobProvider(job).runIsolatedJob(job,{history,memory:chatMemory.context(job),signal:abort.signal,
        onActivity:()=>deadline.touch(),onText:text=>{job.text=text;emit(job,'text',{text});},
        onEvent:event=>{
          if(event.type==='thread.started'){job.threadId=event.thread_id;emit(job,'thread',{threadId:event.thread_id,reasoning:job.reasoning});}
          if(event.item){const update=upsertDisplayItem(job.displayItems,event.item,event.type,job.displayItemOrder);job.displayItems=update.displayItems;job.displayItemOrder=update.displayItemOrder;emit(job,'output',{displayItems:job.displayItems});}
        }});
      if(abort.signal.aborted||job.cancelRequested)throw new Error('已停止处理');
      job.text=result.text;job.usage=result.usage;job.threadId=result.threadId||job.threadId;job.fileChanges=result.fileChanges||[];
      for(const output of result.artifacts||[]){
        const bytes=Buffer.from(output.data||'','base64'),ext=path.extname(output.filename||'').toLowerCase();
        if(!generatedOutputVisible(output)||!bytes.length||bytes.length>24*1024*1024||sha(bytes)!==output.sha256)continue;
        if(['.png','.jpg','.jpeg','.webp'].includes(ext)&&!imageValid(bytes,ext))continue;
        const id=randomUUID(),stored=path.join(ARTIFACTS,id+ext);
        await fs.writeFile(stored,bytes,{mode:0o600});
        const asset={id,filename:path.basename(output.filename),mimeType:mimeFor(ext),bytes:bytes.length,sha256:sha(bytes)};
        state.assets[id]={...asset,file:stored,owner:job.owner,conversationKey:job.conversationKey};syncStore.registerGeneratedAsset(state.assets[id]);job.assets.push(asset);emit(job,'artifact',{asset});
        job.text=job.text.replaceAll(']('+output.path+')','](/shiyan/v1/artifacts/'+id+')').replaceAll('](sandbox:'+output.path+')','](/shiyan/v1/artifacts/'+id+')');
      }
      job.status='completed';conv.updatedAt=Date.now();
      conv.memberHistory=[...history,{role:'user',text:job.prompt},{role:'assistant',text:job.text}].slice(-40);
      delete job.uploads;delete job.files;
      emit(job,'completed',{text:job.text,assets:job.assets,items:[],displayItems:job.displayItems,fileChanges:job.fileChanges,usage:projectUsage(job.usage),threadId:job.threadId||null,reasoning:job.reasoning,generatedImageCount:verifiedGeneratedImageCount(job,state.assets,existsSync)});
      chatMemory.completed(job);return;
    }
    const dir=path.join(WORKSPACES,conv.workspaceKey||job.conversationKey);
    await fs.mkdir(dir,{recursive:true});
    changeRoot=dir;beforeChanges=await snapshotWorkspace(dir);
    const inputDir=path.join(dir,'inputs',job.id);await fs.mkdir(inputDir,{recursive:true});
    const inputs=[];
    const remembered=chatMemory.context(job);
    if(remembered)inputs.push({type:'text',text:remembered});
    const uploadHashes=[];
    // Preserve user text; image-only input needs nonempty stdin for Codex CLI.
    inputs.push({type:'text',text:agentPrompt(job.prompt,job.history,job.uploads.length)});
    // Exact per-turn attribution, including resumed threads and shared fork workspaces.
    inputs.push({type:'text',text:`拾燕本轮文件变更记录元数据：jobId=${job.id}\nmanifest=${remoteChangeManifestPath(dir,job.id)}\n若通过远程工具修改源码，按工作区 AGENTS.md 记录实际绝对路径与修改前后原文及 SHA256；不要解析命令推测文件，也不要把辅助脚本当成远程源码。仅有检查或建议时不要创建文件变更记录。`});
    inputs.push({type:'text',text:'拾燕支持可点击的选择题。能够根据现有信息自主推进时不要提问；确实需要用户选择或补充关键信息时，调用 MCP 服务器 shiyan-input 的 ask_user 工具，提供明确选项，并使用工具返回的回答继续当前任务。不要用 request_user_input_async 或普通文字加选项列表替代该交互。该工具不是操作权限审批工具。'});
    for(let i=0;i<job.uploads.length;i++){
      const upload=job.uploads[i];const file=path.join(inputDir,`image-${i+1}${upload.suffix}`);
      const bytes=Buffer.from(upload.data,'base64');
      await fs.writeFile(file,bytes,{mode:0o600});uploadHashes.push(sha(bytes));inputs.push({type:'local_image',path:file});
    }
    const fileReferences=await writeFileInputs(job.files||[],inputDir);
    if(fileReferences)inputs.push({type:'text',text:fileReferences});
    delete job.files;
    job.uploadHashes=uploadHashes;
    delete job.uploads;
    const provider=jobProvider(job);
    const watchImages=provider.features?.imageGeneration===true;
    const session=providerSession(conv,provider.id);
    // 新会话（首次或切换了模型提供方）带入此前的对话记录。
    if(!session){const seed=transcriptText(conv.transcript||[]);if(seed)inputs.unshift({type:'text',text:seed});}
    const inputToken=userInputs.registerJob(job);
    // 单轮能力令牌只经子进程环境传递（secretEnv），不进入命令行、序列化任务或模型上下文。
    const mcpServers={'shiyan-input':{command:process.execPath,args:[path.join(ROOT,'user-input-mcp.mjs')],env:{SHIYAN_INPUT_JOB:job.id,SHIYAN_INPUT_URL:process.env.SHIYAN_INPUT_URL||'http://127.0.0.1:4327'},secretEnv:{SHIYAN_INPUT_TOKEN:inputToken},timeoutSec:7200}};
    if(session){job.threadId=session;if(watchImages)stopWatch=await monitorGenerated(job);}
    emit(job,'phase',{phase:'processing',label:'拾燕 处理中',reasoning:job.reasoning});
    const input=inputs.length===1&&inputs[0].type==='text'?inputs[0].text:inputs;
    const {events}=await provider.runTurn({model:job.model||MODEL,reasoning:job.reasoning,cwd:dir,resume:session,input,mcpServers,signal:abort.signal});
    const messages=new Map();
    for await(const event of events){
      deadline.touch();
      if(abort.signal.aborted||job.cancelRequested)throw new Error('已停止处理');
      if(event.type==='thread.started'){
        setProviderSession(conv,provider.id,event.thread_id);job.threadId=event.thread_id;
        emit(job,'thread',{threadId:event.thread_id,reasoning:job.reasoning});
        if(watchImages){await stopWatch();stopWatch=await monitorGenerated(job);}
      }else if(event.type==='turn.failed'||event.type==='error'){
        throw new Error(event.error?.message||event.message||'拾燕 处理失败');
      }else if(event.type==='turn.completed'){
        job.usage=event.usage;
      }else if(event.item){
        const item=event.item;
        const display=upsertDisplayItem(job.displayItems,item,event.type,job.displayItemOrder);
        const displayChanged=JSON.stringify(display.displayItems)!==JSON.stringify(job.displayItems||[]);
        job.displayItems=display.displayItems;job.displayItemOrder=display.displayItemOrder;
        const displayUpdate=displayChanged?{displayItems:job.displayItems}:{};
        if(item.type==='agent_message'){
          messages.set(item.id,item.text||'');
          job.lastModelText=[...messages.values()].join('\n\n');
          publishModelText(job,job.lastModelText,true);
        }else if(item.type==='reasoning'){
          emit(job,'phase',{phase:'thinking',label:'思考中',...displayUpdate});
        }else if(['command_execution','mcp_tool_call','web_search','image_generation','collab_tool_call'].includes(item.type)){
          const label=item.type==='web_search'?'检索中':item.type==='image_generation'?'图片生成中':item.type==='command_execution'?'执行任务中':item.type==='collab_tool_call'?'协作处理中':'调用工具中';
          emit(job,'phase',{phase:'tool',label:item.status==='failed'?'工具执行失败':item.status==='completed'?'整理结果中':label,...displayUpdate});
          if(item.type==='mcp_tool_call'&&item.result?.content){
            for(const part of item.result.content){
              if(part.type==='image'&&part.data){
                const ext=part.mimeType==='image/jpeg'?'.jpg':part.mimeType==='image/webp'?'.webp':'.png';
                const temp=path.join(dir,`tool-${randomUUID()}${ext}`);
                await fs.writeFile(temp,Buffer.from(part.data,'base64'));await capture(job,temp);
              }
            }
          }
        }else if(item.type==='todo_list'){
          emit(job,'steps',{steps:item.items,...displayUpdate});
        }else if(item.type==='file_change'){
          if(displayChanged)emit(job,'output',displayUpdate);
          for(const change of item.changes||[])if(change.kind!=='delete')await capture(job,path.resolve(dir,change.path));
        }else if(displayChanged){
          emit(job,'output',displayUpdate);
        }
        if(event.type==='item.completed'&&item.type!=='reasoning'){
          job.items=job.items.filter(x=>x.id!==item.id);job.items.push(item);
        }
      }
    }
    await stopWatch();stopWatch=async()=>{};
    // Explicit artifact links are served only when inside this conversation workspace.
    for(const match of (job.text||'').matchAll(/\]\((?:sandbox:)?([^\s)]+)\)/g)){
      const candidate=match[1];if(!candidate.startsWith('http'))await capture(job,path.isAbsolute(candidate)?candidate:path.resolve(dir,candidate));
    }
    if(abort.signal.aborted||job.cancelRequested)throw new Error('已停止处理');
    publishModelText(job,job.lastModelText??job.text);
    try{job.fileChanges=await collectFileChanges(dir,beforeChanges,job.items,{jobId:job.id});}catch{job.fileChanges=[];}
    if(abort.signal.aborted||job.cancelRequested)throw new Error('已停止处理');
    job.status='completed';conv.updatedAt=Date.now();
    conv.transcript=appendTranscript(conv.transcript,job.prompt,job.text);
    const generatedImageCount=verifiedGeneratedImageCount(job,state.assets,existsSync);
    emit(job,'completed',{text:job.text||'',assets:job.assets,items:job.items,displayItems:displayItemsForJob(job),fileChanges:job.fileChanges||[],usage:projectUsage(job.usage),threadId:job.threadId||null,reasoning:job.reasoning,generatedImageCount});
    chatMemory.completed(job);
  }catch(error){
    const alreadyCancelled=job.status==='cancelled';
    const failure=jobFailure(error,{expiration:deadline.expiration,cancelRequested:job.cancelRequested});
    job.status=failure.status;job.error=failure.error;
    if(!alreadyCancelled)emit(job,job.status,{error:job.status==='cancelled'?'已停止处理':job.error,displayItems:displayItemsForJob(job),fileChanges:job.fileChanges||[],usage:projectUsage(job.usage)});
  }finally{
    try{modelHub.report('shiyan.chat',{account:job.owner,provider:job.provider||'openai',model:job.model||MODEL,reasoning:job.reasoning||'',ok:job.status==='completed',cancelled:job.status==='cancelled',ms:Date.now()-(job.startedAt||Date.now()),error:job.status==='completed'?'':String(job.error||''),usage:job.usage||null});}catch{}
    clearInterval(accessHeartbeat);clearInterval(inputHeartbeat);userInputs.finish(job.id,job.status);deadline.dispose();await stopWatch().catch(()=>{});controls.delete(job.id);active--;save();
    for(const res of listeners.get(job.id)||[])res.end();listeners.delete(job.id);drain();
  }
}
function drain(){
  while(active<3&&queue.length){
    const index=queue.findIndex(id=>{const job=state.jobs[id];return !Object.values(state.jobs).some(j=>j.id!==id&&j.conversationKey===job.conversationKey&&j.status==='running');});
    if(index<0)return;const [id]=queue.splice(index,1);const job=state.jobs[id];if(job.status==='queued')void runJob(job);
  }
}

function cancelJob(job){
  if(terminal(job.status))return job.status;
  job.cancelRequested=true; job.status='cancelled'; job.error='已停止处理';
  const at=queue.indexOf(job.id);if(at>=0)queue.splice(at,1);
  controls.get(job.id)?.abort(new Error('User cancelled'));
  emit(job,'cancelled',{error:'已停止处理',displayItems:displayItemsForJob(job),fileChanges:job.fileChanges||[],usage:projectUsage(job.usage)});
  for(const res of listeners.get(job.id)||[])res.end();listeners.delete(job.id);
  save();return job.status;
}
function snapshot(job){return jobSnapshot(job);}
// Fork before the edited message. The original server conversation and Codex history stay untouched.
async function forkConversation(input,owner){
  if(!validID(input.sourceConversationId)||!validID(input.targetConversationId)||input.sourceConversationId===input.targetConversationId)
    throw fail('编辑分支标识无效');
  const sourceKey=sha(owner+':'+input.sourceConversationId), targetKey=sha(owner+':'+input.targetConversationId);
  const source=state.conversations[sourceKey];
  if(!source||source.owner!==owner)throw fail('原会话不存在',404);
  const existing=state.conversations[targetKey];
  if(existing){
    if(existing.owner===owner&&existing.forkParent===sourceKey)
      return {ok:true,threadId:existing.threadId||null,...(Array.isArray(existing.memberHistory)||existing.historyRetained?{historyRetained:true}:{})};
    throw fail('编辑分支已被占用');
  }
  const prompts=input.retainedPrompts;
  if(!Array.isArray(prompts)||prompts.length>500||prompts.some(t=>typeof t!=='string')||
     typeof input.replacedPrompt!=='string'||input.replacedPrompt.length>200000)
    throw fail('编辑历史参数无效');
  if(Object.values(state.jobs).some(j=>j.conversationKey===sourceKey&&!terminal(j.status)))
    throw fail('原会话正在处理，请结束后再编辑');
  if(MEMBER_ONLY||accountAccess(owner).role!=='admin'||!accountAccess(owner).serverAccess){
    const history=source.memberHistory||[],retained=[];let count=0;
    for(const item of history){
      if(item.role==='user'){
        if(count===prompts.length)break;
        if(item.text!==prompts[count++])throw fail('云端历史与保留消息不一致');
      }
      retained.push(item);
    }
    if(count!==prompts.length)throw fail('云端历史与保留消息不一致');
    state.conversations[targetKey]={owner,id:input.targetConversationId,threadId:null,createdAt:Date.now(),memberHistory:retained,forkParent:sourceKey};
    save();return {ok:true,threadId:null,historyRetained:true};
  }
  if(source.lastProvider&&source.lastProvider!=='openai'){
    // 非 Codex 会话：保留被保留消息对应的对话记录，新分支首轮作为上下文带入。
    state.conversations[targetKey]={owner,id:input.targetConversationId,threadId:null,createdAt:Date.now(),
      workspaceKey:source.workspaceKey||sourceKey,forkParent:sourceKey,transcript:retainTranscript(source.transcript,prompts),historyRetained:true};
    save();return {ok:true,threadId:null,historyRetained:true};
  }
  if(prompts.length&&!source.threadId)throw fail('云端尚无可保留的上下文；原消息未修改');
  // A branch starts with a fresh server-side conversation key; no original state is mutated.
  // Only strip integration metadata belonging to this conversation's verified
  // server jobs (and its retained fork ancestors), never arbitrary client text.
  const lineage=new Set();
  for(let key=sourceKey;key&&!lineage.has(key);){
    const conversation=state.conversations[key];
    if(!conversation||conversation.owner!==owner)break;
    lineage.add(key);key=conversation.forkParent;
  }
  const trustedInputs=Object.fromEntries(Object.values(state.jobs)
    .filter(job=>job.owner===owner&&lineage.has(job.conversationKey))
    .map(job=>[job.id,remoteChangeManifestPath(path.join(WORKSPACES,
      state.conversations[job.conversationKey].workspaceKey||job.conversationKey),job.id)]));
  const threadId=prompts.length
    ?await forkPreviousTurns(source.threadId,prompts,{replacedPrompt:input.replacedPrompt,trustedInputs})
    :null;
  if(state.conversations[targetKey])throw fail('编辑分支冲突，请重试');
  state.conversations[targetKey]={
    owner,id:input.targetConversationId,threadId,createdAt:Date.now(),
    workspaceKey:source.workspaceKey||sourceKey,forkParent:sourceKey
  };
  save();
  return {ok:true,threadId};
}
async function makeJob(input,owner){
  if(!validID(input.conversationId)||!validID(input.requestId))throw fail('会话标识无效');
  for(const key of ['syncConversationId','userMessageId','assistantMessageId'])if(input[key]!==undefined&&!validID(input[key]))throw fail('同步消息标识无效');
  if(input.projectId!==undefined&&input.projectId!==null&&!validID(input.projectId))throw fail('同步项目标识无效');
  const requestKey=owner+':'+input.requestId;
  if(state.requests[requestKey])return state.jobs[state.requests[requestKey]];
  const recent=Object.values(state.jobs).filter(j=>j.owner===owner&&Date.now()-j.createdAt<86400000);
  if(recent.length>=500)throw fail('今日请求较多，请稍后再试',429);
  if(recent.filter(j=>!terminal(j.status)).length>=8)throw fail('正在处理的任务较多，请稍后再试',429);
  await refreshCatalog();const caps=capabilities(input.model||MODEL);const reasoning=input.reasoning||caps.defaultReasoning;
  if(!caps.reasoningEfforts.includes(reasoning))throw fail('当前模型不支持所选推理档位');
  if(typeof input.prompt!=='string'||input.prompt.length>200000)throw fail('消息过长');
  const requestedImages=Array.isArray(input.images)?input.images:[];
  if(requestedImages.length>caps.maxUploadImages)throw fail('本次上传的图片过多');
  const images=await jobImageUploads.resolve(owner,requestedImages);
  for(const image of images){
    if(!['.png','.jpg','.jpeg','.webp'].includes(image.suffix)||typeof image.data!=='string'||image.data.length>18*1024*1024)throw fail('图片格式或大小无效');
    if(!imageValid(Buffer.from(image.data,'base64'),image.suffix))throw fail('图片数据不完整');
  }
  const files=normalizeFiles(input.files,images,caps.maxUploadImages);
  if(!input.prompt.trim()&&!images.length&&!files.length)throw fail('请输入消息或选择附件');
  const history=normalizeHistory(input.history);
  const conversationKey=sha(owner+':'+input.conversationId);
  if(history.length && state.conversations[conversationKey]?.threadId)throw fail('编辑分支必须使用新的云端会话',409);
  state.conversations[conversationKey] ||= {owner,id:input.conversationId,threadId:null,createdAt:Date.now()};
  const job={id:randomUUID(),owner,conversationKey,requestId:input.requestId,prompt:input.prompt,history,uploads:images,files,reasoning,model:caps.model,provider:caps.provider,status:'queued',createdAt:Date.now(),updatedAt:Date.now(),events:[],items:[],assets:[],text:''};
  for(const key of ['syncConversationId','projectId','userMessageId','assistantMessageId'])if(input[key]!==undefined)job[key]=input[key];
  if(!job.syncConversationId&&(job.userMessageId||job.assistantMessageId))job.syncConversationId=input.conversationId;
  // The model capability refresh yields; recheck idempotency before reserving a job.
  if(state.requests[requestKey])return state.jobs[state.requests[requestKey]];
  state.jobs[job.id]=job;state.requests[requestKey]=job.id;
  emit(job,'phase',{phase:'queued',label:active>=3?'等待处理':'请求已接收'});
  save();
  if(state.cancelledRequests[requestKey]){cancelJob(job);return job;}
  queue.push(job.id);setImmediate(drain);return job;
}

const spongeHandler=createSpongeHTTPHandler();
const workspaceHandler=createWorkspaceHandler({revalidate:auth=>accountAccess(auth.owner).status==='active'&&(!auth.accountSession||Boolean(getAccountStore().db.prepare('SELECT 1 FROM account_sessions WHERE id=? AND expires_at>?').get(auth.sessionId,Date.now()))),getAsset:async(owner,id)=>{const asset=readSyncAsset(syncStore,state,owner,id);if(!asset)return null;return {filename:asset.filename,bytes:await fs.readFile(asset.file)};}});
const memberScheduleWorker=new MemberScheduleWorker(syncStore,{submit:makeJob,access:accountAccess,jobStatus:(owner,id)=>state.jobs[id]?.owner===owner?state.jobs[id]:null,pollMs:MEMBER_ONLY&&process.env.SHIYAN_NO_LISTEN!=='1'?15000:0});
export function createServer(){return http.createServer(async(req,res)=>{
  const requestStartedAt=Date.now();
  const diagnosticPath=(req.url||'').split('?')[0];
  const longLivedRequest=diagnosticPath.endsWith('/events');
  let responseFinished=false;
  res.on('finish',()=>{
    responseFinished=true;
    const elapsedMs=Date.now()-requestStartedAt;
    if(!longLivedRequest&&elapsedMs>=5000)console.warn('[SlowRequest]',req.method,diagnosticPath,'status',res.statusCode,'ms',elapsedMs);
  });
  res.on('close',()=>{
    if(responseFinished||longLivedRequest)return;
    console.warn('[ClientClosedEarly]',req.method,diagnosticPath,'status',res.statusCode,'ms',Date.now()-requestStartedAt,'contentLength',req.headers['content-length']||'none');
  });
  req.on('aborted',()=>console.warn('[RequestAborted]',req.method,diagnosticPath,'ms',Date.now()-requestStartedAt,'contentLength',req.headers['content-length']||'none'));
  if(diagnosticPath.includes('/artifacts/')){
    console.log('[ArtifactRequest]',req.method,diagnosticPath,'length',req.headers['content-length']||'none','encoding',req.headers['transfer-encoding']||'none');
    res.on('finish',()=>console.log('[ArtifactResponse]',res.statusCode,res.getHeader('Content-Length')||0));
  }
  try{
    if(await handleAccountRequest(req,res))return;
    if(req.method==='POST'&&req.url==='/shiyan/v1/enroll')return json(res,200,enrollDevice(await body(req,8192)));
    const auth=authenticate(req);if(!auth)return json(res,401,{ok:false,error:'服务连接未获授权'});
    const owner=auth.owner;const url=new URL(req.url,'http://localhost');const pathname=url.pathname.replace(/^\/shiyan/,'');
    if(await spongeHandler(req,res,auth,body))return;
    if(await memberScheduleWorker.handle(req,res,auth,body))return;
    if(await workspaceHandler(req,res,auth,body))return;
    const imageUpload=pathname.match(/^\/v1\/job-images\/([a-f0-9]{64})$/);
    if(imageUpload&&req.method==='GET')return json(res,200,await jobImageUploads.inspect(owner,imageUpload[1]));
    if(imageUpload&&req.method==='POST')return json(res,200,await jobImageUploads.append(owner,imageUpload[1],await body(req,96*1024)));
    if(req.method==='GET'&&pathname==='/v1/sync')return json(res,200,syncStore.list(owner,url.searchParams.get('after')||0,url.searchParams.get('limit')||200));
    if(req.method==='POST'&&pathname==='/v1/sync'){
      const input=await body(req,32*1024*1024);if(!Array.isArray(input.mutations))throw fail('同步更新无效');
      const result=syncStore.apply(owner,input.mutations.map(mutation=>hydrateMutation(mutation,owner,state)),input.after||0,input.limit||200,auth);
      for(const job of Object.values(state.jobs))if(job.owner===owner)materializeJob(syncStore,job,state.conversations[job.conversationKey]);
      return json(res,200,{...result,...syncStore.list(owner,input.after||0,input.limit||200)});
    }
    if(req.method==='POST'&&pathname==='/v1/sync/assets')return json(res,200,{ok:true,asset:syncStore.saveAsset(owner,await body(req,90*1024*1024))});
    const syncAssetMatch=pathname.match(/^\/v1\/sync\/assets\/([A-Za-z0-9_-]{1,120})$/);
    if(req.method==='GET'&&syncAssetMatch){
      const asset=readSyncAsset(syncStore,state,owner,syncAssetMatch[1]);if(!asset)return json(res,404,{ok:false,error:'文件不存在'});
      const bytes=await fs.readFile(asset.file);return sendSyncAsset(res,url,asset,bytes);
    }
    if(req.method==='GET'&&pathname==='/v1/health')return json(res,200,{ok:true,...(auth.serverAccess?{service:'agent-runtime',active,queued:queue.length}:{})});
    if(req.method==='GET'&&pathname==='/v1/capabilities'){await refreshCatalog();const hostAccess=auth.role==='admin'&&auth.serverAccess===true;return json(res,200,{ok:true,...capabilities(),serverAccess:hostAccess,executionMode:hostAccess?'server':'isolated',features:{chat:true,models:true,uploads:true,history:true,dots:true,agent:true,mcp:true,coding:true,files:true,terminal:true,executionHistory:true,memories:true,topics:true,schedules:true,projects:true,serverManagement:hostAccess}});}
    if(req.method==='GET'&&pathname==='/v1/account/quota'){
      if(!auth.serverAccess||auth.role!=='admin')throw fail('需要服务器访问权限',403);
      try{return json(res,200,{ok:true,quota:await readQuota()});}
      catch{return json(res,200,{ok:true,quota:{available:false,windows:[],error:'暂时无法获取剩余额度'}});}
    }
    if(req.method==='POST'&&pathname==='/v1/jobs'){const job=await makeJob(await body(req),owner);return json(res,202,{ok:true,jobId:job.id,status:job.status});}
    if(req.method==='POST'&&pathname==='/v1/conversations/fork'){return json(res,200,await forkConversation(await body(req,3*1024*1024),owner));}
    if(req.method==='POST'&&pathname==='/v1/title'){
      const input=await body(req,8192);
      if(!validID(input.conversationId))throw fail('会话标识无效');
      if(!auth.serverAccess){
        const conv=state.conversations[sha(owner+':'+input.conversationId)];
        if(!conv||conv.owner!==owner)return json(res,200,{ok:true,title:null});
        if(!conv.title){
          const history=conv.memberHistory||[],user=history.find(item=>item.role==='user')?.text?.trim()||'',assistant=history.find(item=>item.role==='assistant')?.text||'';
          try{conv.title=await memberConversationTitle({owner,user,assistant});}catch{}
          conv.title||=user.slice(0,24)||null;
        }
        save();return json(res,200,{ok:true,title:conv.title});
      }
      const title=await conversationTitle({codex,state,key:sha(owner+':'+input.conversationId),owner,model:MODEL,workspaces:WORKSPACES,save});
      return json(res,200,{ok:true,title});
    }
    const cancelledRequest=pathname.match(/^\/v1\/requests\/([\w-]+)\/cancel$/);
    if(req.method==='POST'&&cancelledRequest){
      if(!validID(cancelledRequest[1]))throw fail('请求标识无效');
      await body(req,8192);
      const key=owner+':'+cancelledRequest[1];state.cancelledRequests[key]=Date.now();
      for(const [k,t] of Object.entries(state.cancelledRequests))if(Date.now()-t>86400000)delete state.cancelledRequests[k];
      const job=state.jobs[state.requests[key]];const status=job?cancelJob(job):'cancelled';save();
      return json(res,200,{ok:true,status});
    }
    const match=pathname.match(/^\/v1\/jobs\/([\w-]+)(?:\/(events|cancel))?$/);
    if(match){
      const job=state.jobs[match[1]];if(!job||job.owner!==owner)return json(res,404,{ok:false,error:'任务不存在'});
      if(req.method==='GET'&&!match[2])return json(res,200,snapshot(job));
      if(req.method==='POST'&&match[2]==='cancel'){
        await body(req,8192);return json(res,200,{ok:true,status:cancelJob(job)});
      }
      if(req.method==='GET'&&match[2]==='events'){
        res.shiyanInlineArtifacts=url.searchParams.get('transport')!=='metadata';
        res.socket?.setNoDelay(true);
        res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'close','X-Accel-Buffering':'no'});res.flushHeaders();
        const after=Number(url.searchParams.get('after')||req.headers['last-event-id']||0);
        for(const event of job.events)if(event.seq>after)sendEvent(res,event);
        if(terminal(job.status)){
          if(!job.events.some(event=>terminal(event.type)))res.write('data: '+JSON.stringify({seq:after+1,type:job.status,error:job.error})+'\n\n');
          res.end();return;
        }
        if(!listeners.has(job.id))listeners.set(job.id,new Set());listeners.get(job.id).add(res);
        const ping=setInterval(()=>{if(auth.accountSession&&!getAccountStore().authenticate(requestBearer(req))){res.end();return;}if(!res.destroyed)res.write(': keepalive\n\n');},2000);
        res.on('close',()=>{clearInterval(ping);listeners.get(job.id)?.delete(res);});return;
      }
    }
    const file=pathname.match(/^\/v1\/artifacts\/([\w-]+)$/);
    if(req.method==='GET'&&file){
      const asset=state.assets[file[1]];if(!asset||asset.owner!==owner)return json(res,404,{ok:false,error:'文件不存在'});
      const display=url.searchParams.get('display')==='1'&&asset.displayFile;
      const bytes=await fs.readFile(display||asset.file);
      const mime=display?'image/jpeg':asset.mimeType;
      const name=display?asset.filename.replace(/\.[^.]+$/,'.jpg'):asset.filename;
      const headers={'Content-Type':mime,'Content-Length':bytes.length,'Accept-Ranges':'bytes','X-Content-SHA256':sha(bytes),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(name)};
      res.socket?.setNoDelay(true);
      if(url.searchParams.has('offset')){
        const start=Number(url.searchParams.get('offset')),length=Number(url.searchParams.get('length')||131072);
        if(!Number.isSafeInteger(start)||start<0||start>=bytes.length||!Number.isSafeInteger(length)||length<1||length>262144)return json(res,416,{ok:false,error:'文件范围无效'});
        const end=Math.min(start+length,bytes.length),chunk=bytes.subarray(start,end);
        res.writeHead(206,{...headers,'Content-Length':chunk.length,'Content-Range':`bytes ${start}-${end-1}/${bytes.length}`});return res.end(chunk);
      }
      res.writeHead(200,headers);return res.end(bytes);
    }
    return json(res,404,{ok:false,error:'接口不存在'});
  }catch(error){
    const status=error.status||500;
    if(status>=500)console.error('[RequestError]',req.method,diagnosticPath,'status',status,'ms',Date.now()-requestStartedAt,diagnosticError(error));
    if(!res.headersSent)json(res,status,{ok:false,error:status>=500?'服务暂不可用，请稍后重试':String(error.message||error).slice(0,1000)});else res.end();
  }
}).on('clientError',(error,socket)=>{
  const raw=error.rawPacket?.toString('latin1')||'';
  const safe=raw.split('\r\n').filter((line,i)=>i===0||/^(content-length|transfer-encoding|connection):/i.test(line)).join(' | ');
  console.error('[ShiyanHTTPParse]',error.code,error.reason,error.bytesParsed,safe.slice(0,600));
  if(socket.writable)socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
});}
if(process.env.SHIYAN_NO_LISTEN!=='1')createServer().listen(PORT,'127.0.0.1',()=>console.log('Shiyan v2 listening on 127.0.0.1:'+PORT));
