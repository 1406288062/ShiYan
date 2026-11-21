import http from 'node:http';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { authenticateDevice, digest } from './device-auth.mjs';
import { UserInputStore } from './user-input.mjs';

const ROOT=process.env.SHIYAN_ROOT||'/home/ubuntu/boss-codex-service/shiyan-v2';
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const json=(res,status,value)=>{const data=JSON.stringify(value);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Content-Length':Buffer.byteLength(data)});res.end(data);};
async function body(req,signed=false){let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>32768)throw fail('请求内容过大',413);chunks.push(chunk);}const data=Buffer.concat(chunks);if(signed&&digest(data)!==req.headers['x-shiyan-body-sha'])throw fail('请求校验失败',401);try{return JSON.parse(data.toString()||'{}');}catch{throw fail('请求格式无效');}}
export function legacyOwnerReader(root,read=readFileSync){
  const owners=new Map();
  return id=>{
    if(owners.has(id))return owners.get(id);
    let owner=null;try{owner=JSON.parse(read(path.join(root,'data','state.json'),'utf8')).jobs?.[id]?.owner||null;}catch{}
    if(owners.size>=256)owners.delete(owners.keys().next().value);owners.set(id,owner);return owner;
  };
}

export function createInputSidecar({root=ROOT,authenticate=authenticateDevice,store=new UserInputStore(path.join(root,'data')),legacyJobOwner=legacyOwnerReader(root)
  // Old executors have no question mailbox. Read their owner only on that
  // compatibility path; never expose a job merely because its ID is known.
}={}){
  const server=http.createServer(async(req,res)=>{
    try{
      const url=new URL(req.url||'/','http://localhost'),pathname=url.pathname.replace(/^\/shiyan/,'');
      const internal=pathname.match(/^\/internal\/v1\/jobs\/([\w-]{1,160})\/questions(?:\/([\w-]{1,160}))?$/);
      if(internal){
        const token=String(req.headers.authorization||'').replace(/^Bearer /,'');
        if(req.method==='POST'&&!internal[2])return json(res,200,{ok:true,request:store.create(internal[1],token,await body(req))});
        if(req.method==='GET'&&internal[2])return json(res,200,{ok:true,request:store.get(internal[1],internal[2],token)});
        throw fail('接口不存在',404);
      }
      const auth=authenticate(req);if(!auth)throw fail('服务连接未获授权',401);
      const route=pathname.match(/^\/v1\/jobs\/([\w-]{1,160})\/questions(?:\/([\w-]{1,160})\/answer)?$/);
      if(!route)throw fail('接口不存在',404);
      const [_,jobID,requestID]=route;
      if(req.method==='GET'&&!requestID){
        if(!store.job(jobID)&&legacyJobOwner(jobID)===auth.owner)return json(res,200,{ok:true,pendingQuestions:[]});
        return json(res,200,{ok:true,pendingQuestions:store.list(auth.owner,jobID)});
      }
      if(req.method==='POST'&&requestID)return json(res,200,{ok:true,request:store.answer(auth.owner,jobID,requestID,await body(req,true))});
      throw fail('接口不存在',404);
    }catch(error){if(!res.headersSent)json(res,error.status||500,{ok:false,error:error.status?error.message:'问答暂时不可用，请重试'});else res.end();}
  });
  server.on('close',()=>store.close());return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)createInputSidecar().listen(Number(process.env.SHIYAN_INPUT_PORT||4327),'127.0.0.1',()=>console.log('Shiyan question mailbox ready'));
