 
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync=promisify(execFile);
import path from 'node:path';
import os from 'node:os';
import { promises as fs, watch, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Codex } from '@openai/codex-sdk';
import { conversationTitle } from './session-title.ts';
import { authenticateDevice as authenticate, enrollDevice, digest } from './device-auth.ts';

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
const statePath = path.join(DATA,'state.json');
const state = readJSON(statePath,{jobs:{},conversations:{},assets:{},requests:{}});
for (const job of Object.values(state.jobs)) if (['queued','running'].includes(job.status)) {
  job.status='interrupted'; job.error='服务重新启动，本次处理已中断，请重试';
}
const codex = new Codex({codexPathOverride:'/home/ubuntu/.local/bin/codex'});
const listeners=new Map(), controls=new Map(), queue=[];
state.cancelledRequests ||= {};  
let active=0;
const save=()=>atomic(statePath,state);
save();
const sha=s=>createHash('sha256').update(s).digest('hex');
const validID=s=>typeof s==='string' && /^[A-Za-z0-9_-]{8,100}$/.test(s);
const terminal=s=>['completed','failed','cancelled','interrupted'].includes(s);
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
function capabilities(){
  const cache=readJSON(path.join(os.homedir(),'.codex/models_cache.json'),{});
  const model=(cache.models||[]).find(m=>m.slug===MODEL);
  const supported=(model?.supported_reasoning_levels||[]).map(x=>x.effort).filter(x=>['low','medium','high','xhigh','max'].includes(x));
  return {model:MODEL,reasoningEfforts:supported.length?supported:['low','medium','high'],defaultReasoning:'low',maxUploadImages:8,streams:true,resumable:true};
}
function sendEvent(res,event){
  let outgoing=event;
  if(event.type==='artifact'&&event.asset&&res.shiyanInlineArtifacts!==false){
    const asset=state.assets[event.asset.id];
    if(asset) outgoing={...event,data:readFileSync(asset.displayFile||asset.file).toString('base64'),dataMimeType:asset.displayFile?'image/jpeg':asset.mimeType,dataFilename:asset.displayFile?asset.filename.replace(/\.[^.]+$/,'.jpg'):asset.filename};
  }
   
  res.write('id: '+event.seq+'\nevent: update\ndata: '+JSON.stringify(outgoing)+'\n\n');
}
function emit(job,type,values={}) {
  const event={seq:(job.events.at(-1)?.seq||0)+1,type,at:Date.now(),...values};
  job.events.push(event);job.updatedAt=Date.now();
  if(job.events.length>12000)job.events.splice(0,job.events.length-12000);
  save();
  for(const res of listeners.get(job.id)||[])if(!res.destroyed)sendEvent(res,event);
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
  const roots=[path.join(WORKSPACES,job.conversationKey),job.threadId?path.join(GENERATED,job.threadId):null].filter(Boolean);
  if(!real||!roots.some(r=>real.startsWith(r+path.sep)))return;
  const base=path.basename(real);
  if(base.startsWith('.')||['.pem','.key','.cer','.env'].includes(ext)||/credentials|secret|token|auth\.json/i.test(base))return;
  const stat=await fs.stat(real).catch(()=>null);
  if(!stat?.isFile()||stat.size===0||stat.size>24*1024*1024||stat.mtimeMs<job.startedAt-2000)return;
  if(real.includes(path.sep+'inputs'+path.sep))return;
  const bytes=await fs.readFile(real);
  const isImage=['.png','.jpg','.jpeg','.webp'].includes(ext);
  if(isImage&&!imageValid(bytes,ext))return;
  if(imageOnly&&!isImage)return;
  const digest=sha(bytes);if(job.assets.some(x=>x.sha256===digest))return;
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
    }catch{ }
  }
  if(job.cancelRequested||job.status==='cancelled')return;
  job.assets.push(asset);
  emit(job,'phase',{phase:'receiving',label:'结果已生成，正在接收'});
  emit(job,'artifact',{asset});
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
  const deadline=setTimeout(()=>abort.abort(new Error('处理超过15分钟')),15*60*1000);
  let stopWatch=async()=>{};
  try{
    const conv=state.conversations[job.conversationKey];
    const dir=path.join(WORKSPACES,job.conversationKey);
    await fs.mkdir(dir,{recursive:true});
    const inputDir=path.join(dir,'inputs',job.id);await fs.mkdir(inputDir,{recursive:true});
    const inputs=[];
     
    if(job.prompt.length)inputs.push({type:'text',text:job.prompt});
    for(let i=0;i<job.uploads.length;i++){
      const upload=job.uploads[i];const file=path.join(inputDir,`image-${i+1}${upload.suffix}`);
      await fs.writeFile(file,Buffer.from(upload.data,'base64'),{mode:0o600});inputs.push({type:'local_image',path:file});
    }
    delete job.uploads;
    const options={model:MODEL,workingDirectory:dir,skipGitRepoCheck:true,sandboxMode:'read-only',approvalPolicy:'never',networkAccessEnabled:false,webSearchMode:'disabled',modelReasoningEffort:job.reasoning};
     
    const thread=conv.threadId?codex.resumeThread(conv.threadId,options):codex.startThread(options);
    if(conv.threadId){job.threadId=conv.threadId;stopWatch=await monitorGenerated(job);}
    emit(job,'phase',{phase:'processing',label:'拾燕 处理中',reasoning:job.reasoning});
    const input=inputs.length===1&&inputs[0].type==='text'?inputs[0].text:inputs;
    const {events}=await thread.runStreamed(input,{signal:abort.signal});
    const messages=new Map();
    for await(const event of events){
      if(abort.signal.aborted||job.cancelRequested)throw new Error('已停止处理');
      if(event.type==='thread.started'){
        conv.threadId=event.thread_id;job.threadId=event.thread_id;
        emit(job,'thread',{threadId:event.thread_id,reasoning:job.reasoning});
        await stopWatch();stopWatch=await monitorGenerated(job);
      }else if(event.type==='turn.failed'||event.type==='error'){
        throw new Error(event.error?.message||event.message||'拾燕 处理失败');
      }else if(event.type==='turn.completed'){
        job.usage=event.usage;
      }else if(event.item){
        const item=event.item;
        if(item.type==='agent_message'){
          messages.set(item.id,item.text||'');job.text=[...messages.values()].join('\n\n');
          emit(job,'text',{text:job.text});
        }else if(item.type==='reasoning'){
          emit(job,'phase',{phase:'thinking',label:'思考中'});
        }else if(['command_execution','mcp_tool_call','web_search','image_generation'].includes(item.type)){
          const label=item.type==='web_search'?'检索中':item.type==='image_generation'?'图片生成中':item.type==='command_execution'?'执行任务中':'调用工具中';
          emit(job,'phase',{phase:'tool',label:item.status==='completed'?'整理结果中':label});
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
          emit(job,'steps',{steps:item.items});
        }else if(item.type==='file_change'){
          for(const change of item.changes||[])if(change.kind!=='delete')await capture(job,path.resolve(dir,change.path));
        }
        if(event.type==='item.completed'&&item.type!=='reasoning'){
          job.items=job.items.filter(x=>x.id!==item.id);job.items.push(item);
        }
      }
    }
    await stopWatch();stopWatch=async()=>{};
     
    for(const match of (job.text||'').matchAll(/\]\((?:sandbox:)?([^\s)]+)\)/g)){
      const candidate=match[1];if(!candidate.startsWith('http'))await capture(job,path.isAbsolute(candidate)?candidate:path.resolve(dir,candidate));
    }
    if(abort.signal.aborted||job.cancelRequested)throw new Error('已停止处理');
    job.status='completed';conv.updatedAt=Date.now();
    emit(job,'completed',{text:job.text||'',assets:job.assets,items:job.items,usage:job.usage||null,threadId:job.threadId||null,reasoning:job.reasoning});
  }catch(error){
    const alreadyCancelled=job.status==='cancelled';
    job.status=abort.signal.aborted||job.cancelRequested?'cancelled':'failed';job.error=String(error.message||error).slice(0,2000);
    if(!alreadyCancelled)emit(job,job.status,{error:job.status==='cancelled'?'已停止处理':job.error});
  }finally{
    clearTimeout(deadline);await stopWatch().catch(()=>{});controls.delete(job.id);active--;save();
    for(const res of listeners.get(job.id)||[])res.end();listeners.delete(job.id);drain();
  }
}
function drain(){
  while(active<2&&queue.length){
    const index=queue.findIndex(id=>{const job=state.jobs[id];return !Object.values(state.jobs).some(j=>j.id!==id&&j.conversationKey===job.conversationKey&&j.status==='running');});
    if(index<0)return;const [id]=queue.splice(index,1);const job=state.jobs[id];if(job.status==='queued')void runJob(job);
  }
}

function cancelJob(job){
  if(terminal(job.status))return job.status;
  job.cancelRequested=true; job.status='cancelled'; job.error='已停止处理';
  const at=queue.indexOf(job.id);if(at>=0)queue.splice(at,1);
  controls.get(job.id)?.abort(new Error('User cancelled'));
  emit(job,'cancelled',{error:'已停止处理'});
  for(const res of listeners.get(job.id)||[])res.end();listeners.delete(job.id);
  save();return job.status;
}
function snapshot(job){return {ok:true,id:job.id,status:job.status,text:job.text||'',assets:job.assets,threadId:job.threadId||null,events:job.events,error:job.error||null,reasoning:job.reasoning};}
async function makeJob(input,owner){
  if(!validID(input.conversationId)||!validID(input.requestId))throw fail('会话标识无效');
  const requestKey=owner+':'+input.requestId;
  if(state.requests[requestKey])return state.jobs[state.requests[requestKey]];
  const recent=Object.values(state.jobs).filter(j=>j.owner===owner&&Date.now()-j.createdAt<86400000);
  if(recent.length>=500)throw fail('今日请求较多，请稍后再试',429);
  if(recent.filter(j=>!terminal(j.status)).length>=8)throw fail('正在处理的任务较多，请稍后再试',429);
  const caps=capabilities();const reasoning=input.reasoning||caps.defaultReasoning;
  if(!caps.reasoningEfforts.includes(reasoning))throw fail('当前模型不支持所选推理档位');
  if(typeof input.prompt!=='string'||input.prompt.length>200000)throw fail('消息过长');
  const images=Array.isArray(input.images)?input.images:[];
  if(images.length>caps.maxUploadImages)throw fail('本次上传的图片过多');
  for(const image of images){
    if(!['.png','.jpg','.jpeg','.webp'].includes(image.suffix)||typeof image.data!=='string'||image.data.length>18*1024*1024)throw fail('图片格式或大小无效');
    if(!imageValid(Buffer.from(image.data,'base64'),image.suffix))throw fail('图片数据不完整');
  }
  if(!input.prompt.trim()&&!images.length)throw fail('请输入消息或选择图片');
  const conversationKey=sha(owner+':'+input.conversationId);
  state.conversations[conversationKey] ||= {owner,id:input.conversationId,threadId:null,createdAt:Date.now()};
  const job={id:randomUUID(),owner,conversationKey,requestId:input.requestId,prompt:input.prompt,uploads:images,reasoning,status:'queued',createdAt:Date.now(),updatedAt:Date.now(),events:[],items:[],assets:[],text:''};
  state.jobs[job.id]=job;state.requests[requestKey]=job.id;
  emit(job,'phase',{phase:'queued',label:active>=2?'等待处理':'请求已接收'});
  if(state.cancelledRequests[requestKey]){cancelJob(job);return job;}
  queue.push(job.id);setImmediate(drain);return job;
}

export function createServer(){return http.createServer(async(req,res)=>{
  const diagnosticPath=(req.url||'').split('?')[0];
  if(diagnosticPath.includes('/artifacts/')){
    console.log('[ArtifactRequest]',req.method,diagnosticPath,'length',req.headers['content-length']||'none','encoding',req.headers['transfer-encoding']||'none');
    res.on('finish',()=>console.log('[ArtifactResponse]',res.statusCode,res.getHeader('Content-Length')||0));
  }
  try{
    if(req.method==='POST'&&req.url==='/shiyan/v1/enroll')return json(res,200,enrollDevice(await body(req,8192)));
    const auth=authenticate(req);if(!auth)return json(res,401,{ok:false,error:'服务连接未获授权'});
    const owner=auth.owner;const url=new URL(req.url,'http://localhost');const pathname=url.pathname.replace(/^\/shiyan/,'');
    if(req.method==='GET'&&pathname==='/v1/health')return json(res,200,{ok:true,service:'shiyan-v2',active,queued:queue.length});
    if(req.method==='GET'&&pathname==='/v1/capabilities')return json(res,200,{ok:true,...capabilities()});
    if(req.method==='POST'&&pathname==='/v1/jobs'){const job=await makeJob(await body(req),owner);return json(res,202,{ok:true,jobId:job.id,status:job.status});}
    if(req.method==='POST'&&pathname==='/v1/title'){
      const input=await body(req,8192);
      if(!validID(input.conversationId))throw fail('会话标识无效');
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
        const ping=setInterval(()=>{if(!res.destroyed)res.write(': keepalive\n\n');},15000);
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
      const headers={'Content-Type':mime,'Content-Length':bytes.length,'Accept-Ranges':'bytes','X-Content-SHA256':sha(bytes),'Cache-Control':'private, max-age=3600','X-Content-Type-Options':'nosniff','Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(name)};
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
  }catch(error){if(!res.headersSent)json(res,error.status||500,{ok:false,error:String(error.message||error).slice(0,1000)});else res.end();}
}).on('clientError',(error,socket)=>{
  const raw=error.rawPacket?.toString('latin1')||'';
  const safe=raw.split('\r\n').filter((line,i)=>i===0||/^(content-length|transfer-encoding|connection):/i.test(line)).join(' | ');
  console.error('[ShiyanHTTPParse]',error.code,error.reason,error.bytesParsed,safe.slice(0,600));
  if(socket.writable)socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
});}
if(process.env.SHIYAN_NO_LISTEN!=='1')createServer().listen(PORT,'127.0.0.1',()=>console.log('Shiyan v2 listening on 127.0.0.1:'+PORT));
