import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createWorkspaceHandler} from './workspace-http.ts';
import * as sandbox from './member-sandbox.ts';

test('real HTTP file, project and PTY routes isolate two simultaneously authenticated accounts',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'member-http-real-'));const handler=createWorkspaceHandler({operations:async()=>({workspaceOperation:(owner,input)=>sandbox.workspaceOperation(owner,input,{root}),spawnSandbox:(owner,input)=>sandbox.spawnSandbox(owner,{...input,root})})});
 const server=http.createServer(async(req,res)=>{try{await handler(req,res,req.headers['x-owner']?{owner:req.headers['x-owner'],serverAccess:false,role:'user'}:null,async req=>{const chunks=[];for await(const d of req)chunks.push(d);return JSON.parse(Buffer.concat(chunks).toString()||'{}');});}catch(e){res.writeHead(e.status||500,{'Content-Type':'application/json'}).end(JSON.stringify({error:e.message}));}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();server.close();await fs.rm(root,{recursive:true,force:true});});
 const request=(owner,route,method='GET',body)=>fetch('http://127.0.0.1:'+server.address().port+'/v1/workspace'+route,{method,headers:{'x-owner':owner,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const projectId='same-project-123';const results=await Promise.all(['alice','bob'].map(async owner=>{
  let response=await request(owner,'/projects','POST',{id:projectId,name:owner});assert.equal(response.status,200);
  response=await request(owner,'/files/write','POST',{projectId,path:'private.txt',text:owner+' private',confirmed:true});assert.equal(response.status,200);return(await response.json()).file;
 }));assert.equal(results[0].text,'alice private');assert.equal(results[1].text,'bob private');
 const replay=await request('bob','/files/read','POST',{fileId:results[0].fileId});assert.equal((await replay.json()).file.text,'bob private');
 for(const owner of ['alice','bob']){const response=await request(owner,'/files/read','POST',{path:'/home/ubuntu/.codex/auth.json'});assert.equal(response.status,403);}
 const opening=await request('alice','/terminals','POST',{projectId});assert.equal(opening.status,200);const terminal=(await opening.json()).terminal;
 assert.equal((await request('bob','/terminals/'+terminal.id+'/input','POST',{data:'echo bad\n'})).status,404);
 assert.equal((await request('alice','/terminals/'+terminal.id+'/resize','POST',{cols:120,rows:40})).status,200);
 assert.equal((await request('alice','/terminals/'+terminal.id+'/input','POST',{data:'printf terminal-owned > terminal.txt; stty size; echo done-private-pty; exit\n'})).status,200);
 const events=await request('alice','/terminals/'+terminal.id+'/events');const stream=await events.text();let output='';for(const match of stream.matchAll(/^data: (.+)$/gm)){const item=JSON.parse(match[1]);if(item.type==='data')output+=Buffer.from(item.data,'base64').toString();}assert.match(output,/done-private-pty/);assert.match(output,/40 120/);assert.doesNotMatch(output,/\/home\/ubuntu/);
 assert.equal((await sandbox.workspaceOperation('alice',{operation:'read',path:'/workspace/projects/'+projectId+'/terminal.txt'},{root})).text,'terminal-owned');await assert.rejects(sandbox.workspaceOperation('bob',{operation:'read',path:'/workspace/projects/'+projectId+'/terminal.txt'},{root}),/不存在/);
 assert.equal((await request('alice','/terminals/'+terminal.id,'DELETE')).status,200);
});
