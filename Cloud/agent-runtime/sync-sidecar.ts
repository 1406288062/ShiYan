import { reconcileSyncImageResult } from './image-result-consistency.ts';
import { sendSyncAsset } from './sync-asset-response.ts';
import http from 'node:http';
import path from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import { authenticateDevice, digest } from './device-auth.ts';
import { SyncStore, materializeJob, hydrateMutation, hydrateCompactMutation, hydrateStoredMutation, readSyncAsset, withAcceptedSnapshots } from './sync-store.ts';
import { mobileSyncChange } from './sync-mobile-projection.ts';
import { SyncedSchedules } from './sync-schedules.ts';
import { createFilePathResolver } from './sync-file-paths.ts';
import { createRemoteFileChangeProjector } from './remote-file-changes.ts';
import { combinedRuntimeState } from './runtime-state.ts';

const ROOT=process.env.SHIYAN_ROOT||'/home/ubuntu/boss-codex-service/shiyan-v2';
const PORT=Number(process.env.SHIYAN_SYNC_PORT||4324);
const fail=(message: any,status=400)=>Object.assign(new Error(message),{status});
const json=(res: any,status: any,value: any)=>{const data=JSON.stringify(value);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Content-Length':Buffer.byteLength(data)});res.end(data);};
async function body(req: any,max: any){let total=0;const chunks: Buffer[]=[];for await(const chunk of req){total+=chunk.length;if(total>max)throw fail('上传内容过大',413);chunks.push(chunk);}const data=Buffer.concat(chunks);if(digest(data)!==req.headers['x-shiyan-body-sha'])throw fail('请求校验失败',401);try{return JSON.parse(data.toString()||'{}');}catch{throw fail('请求格式无效');}}

export function createSyncSidecar({root=ROOT,authenticate=authenticateDevice,store=new SyncStore(path.join(root,'data')),runtimeWrites=process.env.SHIYAN_SYNC_RUNTIME_WRITES==='1'}={}){
  let state: any={jobs:{},conversations:{},assets:{},requests:{}},version='';
  const resolvePaths=createFilePathResolver(root,store,{stateFallback:!runtimeWrites});
  const supplementChanges=createRemoteFileChangeProjector(root,store);
  const schedules=new SyncedSchedules(store);
  const jobVersions=new Map();
  const materialize=(force=false,owner=null)=>{for(const job of (Object.values(state.jobs||{}) as any[])){
    if(owner&&job.owner!==owner)continue;
    const conversation=state.conversations?.[job.conversationKey];
    const fingerprint=[job.updatedAt,job.status,job.threadId,conversation?.threadId,conversation?.title].join(':');
    if(!force&&jobVersions.get(job.id)===fingerprint)continue;
    materializeJob(store,job,conversation);jobVersions.set(job.id,fingerprint);
  }};
  const refresh=()=>{
    const files=['state.json','member-runtime-state.json'].map(name=>path.join(root,'data',name));
    const versions=files.map(file=>{try{const stat=statSync(file);return stat.mtimeMs+':'+stat.size;}catch{return '';}});
    const next=versions.join('|');if(next===version)return;
    state=combinedRuntimeState(files.map((file,index)=>versions[index]?JSON.parse(readFileSync(file,'utf8')):null));version=next;
    for(const asset of Object.values(state.assets||{}))store.registerGeneratedAsset(asset);
    materialize();
  };
  const server=http.createServer(async(req,res)=>{
    try{
      const auth=authenticate(req);if(!auth)return json(res,401,{ok:false,error:'服务连接未获授权'});
      const url=new URL(req.url||'/','http://localhost'),pathname=url.pathname.replace(/^\/shiyan/,'');const owner=auth.owner;
      const mobile=auth.platform==='ios'||req.headers['x-shiyan-sync-profile']==='mobile';
      // A compact desktop response must keep macOS execution authorization.
      const compact=mobile||req.headers['x-shiyan-sync-profile']==='compact';
      const projectChange=(change: any)=>{const resolved=resolvePaths(reconcileSyncImageResult(change,owner,store),owner);return compact?mobileSyncChange(resolved):resolved;};
      const fullProject=async (change: any)=>{const resolved=await supplementChanges(resolvePaths(reconcileSyncImageResult(change,owner,store),owner),owner);return compact?mobileSyncChange(resolved):resolved;};
      const project=async (response: any)=>{
        const changes: any[]=[];
        for(const change of response.changes)changes.push(await fullProject(change));
        const conflicts: any[]=[];
        for(const conflict of response.conflicts||[])conflicts.push({...conflict,current:conflict.current?await fullProject(conflict.current):conflict.current});
        return {...response,changes,...(response.conflicts?{conflicts}:{})};
      };
      // Explicit evidence can increase an otherwise small page. Keep its actual
      // delivery size bounded and advance only over rows that were delivered.
      const projectPage=async(response: any,after: any)=>{
        const candidates=new Map(response.changes.map((change: any)=>[change.kind+':'+change.id,change]));
        const selected=new Map();let bytes=0,consumed=0,cursor=Number(after||0);
        for(const entry of response.order){
          const key=entry.kind+':'+entry.id,change=candidates.get(key);
          const projected=await fullProject(change);
          const parentId=projected.kind==='messages'?projected.data?.conversationId:null;
          const parentKey=parentId?'conversations:'+parentId:null;
          const parent=parentKey&&!selected.has(parentKey)?candidates.get(parentKey):null;
          const projectedParent=parent?await fullProject(parent):null;
          const size=Buffer.byteLength(JSON.stringify(projected))+256;
          const parentSize=projectedParent?Buffer.byteLength(JSON.stringify(projectedParent))+256:0;
          const nextBytes=bytes-(selected.get(key)?.size||0)+size+parentSize;
          if(consumed&&nextBytes>96*1024)break;
          if(projectedParent)selected.set(parentKey,{change:projectedParent,size:parentSize});
          selected.set(key,{change:projected,size});bytes=nextBytes;consumed++;cursor=entry.seq;
        }
        const {order,...publicResponse}=response;
        return {...publicResponse,cursor,hasMore:consumed<order.length||response.hasMore,changes:[...selected.values()].map(value=>value.change)};
      };
      if(pathname!=='/v1/sync'&&!pathname.startsWith('/v1/sync/'))return json(res,404,{ok:false,error:'接口不存在'});
      // The executor already materializes every job into this shared SQLite DB.
      // Do not reparse its large execution archive on every read or timer tick.
      if(!runtimeWrites)refresh();
      const scheduled=pathname.match(/^\/v1\/sync\/schedules(?:\/([A-Za-z0-9_-]{1,120}))?(?:\/(claim))?$/);
      if(req.method==='POST'&&pathname==='/v1/sync/schedules/host')return json(res,200,schedules.host(auth,await body(req,256*1024)));
      if(req.method==='GET'&&pathname==='/v1/sync/schedules')return json(res,200,schedules.listing(auth));
      if(scheduled&&['POST','PATCH','DELETE'].includes(req.method||'')){
        const input=await body(req,256*1024);
        if(scheduled[2]==='claim'&&req.method!=='POST')return json(res,405,{ok:false,error:'执行声明只接受 POST'});
        if(scheduled[2]==='claim'&&req.method==='POST')return json(res,200,schedules.claim(auth,scheduled[1],input));
        return json(res,200,schedules.mutate({...auth,mobile},input,scheduled[1],req.method==='DELETE'));
      }
      if(req.method==='GET'&&pathname==='/v1/sync'){
        const after=Number(url.searchParams.get('after')||0);
        return json(res,200,await projectPage(store.list(owner,after,Number(url.searchParams.get('limit')||200),{mobile,projectChange,includeOrder:true}),after));
      }
      const details=pathname.match(/^\/v1\/sync\/messages\/([A-Za-z0-9_-]{1,120})\/details$/);
      if(req.method==='GET'&&details){
        const record=store.get(owner,'messages',details[1]);if(!record||record.deleted)return json(res,404,{ok:false,error:'消息不存在'});
        const enriched=await supplementChanges(resolvePaths(record,owner),owner);
        return json(res,200,{ok:true,revision:record.revision,rawResult:record.data.rawResult||null,fileChanges:enriched.data.fileChanges||[],displayItems:enriched.data.displayItems||[]});
      }
      if(req.method==='POST'&&pathname==='/v1/sync'){
        const input=await body(req,32*1024*1024);if(!Array.isArray(input.mutations)||input.mutations.length>200)throw fail('同步更新无效');
        const after=Number(input.after||0),limit=Number(input.limit||200);
        if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>500)throw fail('同步游标无效');
        // Validate original identity before any hydration/archive work. apply()
        // checks again in its transaction, including races with another writer.
        const replayed=new Set(input.mutations.filter((mutation: any)=>store.hasMutation(owner,mutation)));
        const unresolved: any[]=[];
        let mutations=input.mutations.map((original: any)=>{
          if(replayed.has(original))return original;
          const compactMutation=hydrateCompactMutation(original,owner,store);
          if(!runtimeWrites)return compactMutation;
          const storedMutation=hydrateStoredMutation(compactMutation,owner,store);
          if(storedMutation===compactMutation&&original.kind==='messages'&&!original.deleted&&(original.data?.requestId||original.data?.remoteJobId))unresolved.push(original);
          return storedMutation;
        });
        // Runtime-backed sync must never replay the entire execution archive.
        // Legacy/missing bindings are resolved only for this request's jobs.
        const requestState: any=runtimeWrites?{jobs:{},conversations:{},assets:{},requests:{}}:state;
        if(runtimeWrites&&unresolved.length){
          let archive;
          archive=combinedRuntimeState(['state.json','member-runtime-state.json'].map(name=>{
            try{return JSON.parse(readFileSync(path.join(root,'data',name),'utf8'));}
            catch(error){if((error as any).code!=='ENOENT')throw error;return null;}
          }));
          for(const mutation of unresolved){
            const data=mutation.data;
            const job=archive?.jobs?.[data.remoteJobId]||archive?.jobs?.[archive?.requests?.[owner+':'+data.requestId]];
            if(!job||job.owner!==owner)continue;
            requestState.jobs[job.id]=job;
            requestState.requests[owner+':'+job.requestId]=job.id;
            requestState.conversations[job.conversationKey]=archive.conversations?.[job.conversationKey];
            for(const asset of job.assets||[]){
              const full=archive.assets?.[asset.id];
              if(full?.owner===owner)store.registerGeneratedAsset(full);
            }
          }
        }
        mutations=mutations.map((mutation: any,i: any)=>replayed.has(input.mutations[i])?mutation:hydrateMutation(mutation,owner,requestState));
        const result=store.apply(owner,mutations,after,limit,{...auth,mobile},{includeDelta:false});
        if(!runtimeWrites)materialize(true,owner);
        else for(const job of (Object.values(requestState.jobs) as any[]))materializeJob(store,job,requestState.conversations[job.conversationKey]);
        const delta=await projectPage(store.list(owner,after,limit,{mobile,projectChange,includeOrder:true}),after);
        return json(res,200,await project(withAcceptedSnapshots({...result,...delta},store,owner)));
      }
      if(req.method==='POST'&&pathname==='/v1/sync/assets'){const input=await body(req,90*1024*1024);return json(res,200,{ok:true,asset:store.saveAsset(owner,input)});}
      const match=pathname.match(/^\/v1\/sync\/assets\/([A-Za-z0-9_-]{1,120})$/);
      if(req.method==='GET'&&match){
        if(runtimeWrites&&!store.asset(owner,match[1]))refresh();
        const asset=readSyncAsset(store,state,owner,match[1]);if(!asset)return json(res,404,{ok:false,error:'文件不存在'});
        const bytes=readFileSync(asset.file);return sendSyncAsset(res,url,asset,bytes);
      }
      return json(res,404,{ok:false,error:'接口不存在'});
    }catch(error){if(!res.headersSent)json(res,(error as any).status||500,{ok:false,error:String((error as any).message||error).slice(0,1000)});else res.end();}
    finally{if(runtimeWrites){state={jobs:{},conversations:{},assets:{},requests:{}};version='';}}
  });
  const timer=runtimeWrites?null:setInterval(()=>{try{refresh();}catch(error){console.error('[SyncRefresh]',String((error as any).message||error).slice(0,200));}},1500);timer?.unref();
  server.on('close',()=>{if(timer)clearInterval(timer);store.close();});
  return server;
}
if(process.env.SHIYAN_SYNC_NO_LISTEN!=='1')createSyncSidecar().listen(PORT,'127.0.0.1',()=>console.log('Shiyan sync listening on 127.0.0.1:'+PORT));
