import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { authenticateDevice, digest } from './device-auth.ts';
import { MemoryStore } from './memory-store.ts';
import { createMemoryWorker } from './memory-extractor.ts';
import { createMemorySummary } from './memory-summary.ts';

const ROOT=process.env.SHIYAN_ROOT||'/home/ubuntu/boss-codex-service/shiyan-v2';
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const json=(res,status,value)=>{const body=JSON.stringify(value);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Content-Length':Buffer.byteLength(body)});res.end(body);};
async function body(req){let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>16384)throw fail('请求内容过大',413);chunks.push(chunk);}const bytes=Buffer.concat(chunks);if(digest(bytes)!==req.headers['x-shiyan-body-sha'])throw fail('请求校验失败',401);try{const data=JSON.parse(bytes.toString()||'{}');if(!data||typeof data!=='object'||Array.isArray(data))throw Error();return data;}catch{throw fail('请求格式无效');}}
function only(input,keys){if(Object.keys(input).some(key=>!keys.includes(key)))throw fail('记忆参数无效');}
const settingsResponse=({enabled,revision})=>({ok:true,enabled,revision});
export function createMemorySidecar({root=ROOT,store=new MemoryStore(path.join(root,'data')),authenticate=authenticateDevice,worker=true,extract,summaryOptions={}}={}){
  const background=worker?createMemoryWorker(store,{...(extract?{extract}:{})}):null;
  const summary=createMemorySummary(store,summaryOptions);
  const server=http.createServer(async(req,res)=>{
    try{
      const auth=authenticate(req);if(!auth)throw fail('服务连接未获授权',401);
      const pathname=new URL(req.url,'http://localhost').pathname.replace(/^\/shiyan/,'');const owner=auth.owner;
      if(pathname==='/v1/memory'){
        if(req.method==='GET')return json(res,200,store.list(owner,{query:new URL(req.url,'http://localhost').searchParams.get('query')||''}));
        if(req.method==='POST'){const input=await body(req);only(input,['content','category']);return json(res,200,store.create(owner,input));}
        if(req.method==='DELETE'){const input=await body(req);only(input,[]);return json(res,200,store.clear(owner));}
      }
      if(pathname==='/v1/memory/summary'&&req.method==='GET')return json(res,200,summary.get(owner));
      if(pathname==='/v1/memory/settings'){
        if(req.method==='GET')return json(res,200,settingsResponse(store.settings(owner)));
        if(req.method==='PATCH'){const input=await body(req);only(input,['enabled']);return json(res,200,settingsResponse(store.setEnabled(owner,input.enabled)));}
      }
      const match=pathname.match(/^\/v1\/memory\/([A-Za-z0-9_-]{1,120})$/);
      if(match&&req.method==='PATCH'){const input=await body(req);only(input,['content','revision']);return json(res,200,store.update(owner,match[1],input));}
      if(match&&req.method==='DELETE'){const input=await body(req);only(input,[]);return json(res,200,store.remove(owner,match[1]));}
      throw fail('接口不存在',404);
    }catch(error){if(!res.headersSent)json(res,error.status||500,{ok:false,error:error.status?error.message:'记忆暂时不可用，请重试'});else res.end();}
  });
  server.on('close',()=>{if(background)void background.close().finally(()=>store.close());else store.close();});server.memoryStore=store;server.memoryWorker=background;return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)createMemorySidecar().listen(Number(process.env.SHIYAN_MEMORY_PORT||4328),'127.0.0.1',()=>console.log('Shiyan owner-scoped memory ready'));
