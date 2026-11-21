import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { Codex } from '@openai/codex-sdk';
import { UserInputStore, normalizeQuestions } from './user-input.ts';
import { createInputSidecar, legacyOwnerReader } from './user-input-sidecar.ts';
import { digest } from './device-auth.ts';

const questions=[{id:'entry',header:'网页入口',question:'你使用哪个网页入口？',options:[{label:'本机网页',description:'Mac 本机'},{label:'服务器网页',description:'远程服务'}]}];
const answer={answers:{entry:{answers:['本机网页']}}};
function fixture(){const root=mkdtempSync(path.join(os.tmpdir(),'shiyan-input-test-'));return {root,store:new UserInputStore(root),cleanup(){rmSync(root,{recursive:true,force:true});}};}

test('legacy owner polling reads archived state only once per immutable job',()=>{
  let reads=0;const lookup=legacyOwnerReader('/unused',()=>{reads++;return JSON.stringify({jobs:{old_job:{owner:'alice'}}});});
  for(let i=0;i<100;i++)assert.equal(lookup('old_job'),'alice');
  assert.equal(reads,1);for(let i=0;i<100;i++)assert.equal(lookup('missing_job'),null);assert.equal(reads,2);
});

test('question validation, owner isolation, durable answers and first-answer wins',()=>{
  const f=fixture();let store=f.store;
  try{
    const token=store.registerJob({id:'job_one',owner:'alice'});
    assert.throws(()=>normalizeQuestions([{...questions[0],options:[questions[0].options[0],questions[0].options[0]]}]),/选项/);
    assert.throws(()=>store.create('job_one','wrong',{requestId:'request_one',questions}),/授权/);
    const request=store.create('job_one',token,{requestId:'request_one',questions});
    assert.equal(store.create('job_one',token,{requestId:'request_one',questions}).id,request.id);
    assert.throws(()=>store.list('bob','job_one'),{status:404});
    assert.throws(()=>store.answer('bob','job_one',request.id,answer),{status:404});
    assert.throws(()=>store.answer('alice','job_one',request.id,{answers:{}}),/所有问题/);
    assert.equal(store.hasPending('job_one'),true);
    const saved=store.answer('alice','job_one',request.id,answer);assert.equal(saved.status,'answered');
    assert.deepEqual(store.answer('alice','job_one',request.id,answer),saved);
    assert.throws(()=>store.answer('alice','job_one',request.id,{answers:{entry:{answers:['服务器网页']}}}),{status:409});
    store.close();store=new UserInputStore(f.root);
    assert.equal(store.list('alice','job_one')[0].status,'answered');assert.deepEqual(store.get('job_one',request.id,token).answers,answer.answers);
    const next=store.create('job_one',token,{requestId:'request_two',questions});store.finish('job_one','cancelled');
    assert.equal(store.get('job_one',next.id,token).status,'cancelled');
    assert.throws(()=>store.answer('alice','job_one',next.id,answer),{status:409});
  }finally{store.close();f.cleanup();}
});

test('real stdio MCP waits, UI submits, and same in-flight call receives the answer',async()=>{
  const f=fixture();const token=f.store.registerJob({id:'job_stdio',owner:'alice'});
  const server=createInputSidecar({store:f.store,authenticate:req=>req.headers['x-test-owner']?{owner:req.headers['x-test-owner']}:null,legacyJobOwner:id=>id==='legacy_one'?'alice':null});
  server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+(server.address() as any).port;
  const child=spawn(process.execPath,[new URL('./user-input-mcp.ts',import.meta.url).pathname],{env:{...process.env,SHIYAN_INPUT_URL:base,SHIYAN_INPUT_JOB:'job_stdio',SHIYAN_INPUT_TOKEN:token},stdio:['pipe','pipe','pipe']});
  const lines=createInterface({input:child.stdout});const replies=new Map(),waiters=new Map();let output='',error='';
  child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>error+=data);
  lines.on('line',line=>{const value=JSON.parse(line);replies.set(value.id,value);waiters.get(value.id)?.(value);});
  const send=(id: any,method: any,params: any)=>{const result=new Promise<any>(resolve=>waiters.set(id,resolve));child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');return result;};
  const get=async(job: any,owner='alice')=>{const response=await fetch(base+'/shiyan/v1/jobs/'+job+'/questions',{headers:{'x-test-owner':owner}});return {status:response.status,data:(await response.json()) as any};};
  try{
    const init=await send(1,'initialize',{protocolVersion:'2024-11-05'});assert.equal(init.result.serverInfo.name,'shiyan-input');
    assert.equal((await send(2,'tools/list',{})).result.tools[0].name,'ask_user');
    const waiting=send(3,'tools/call',{name:'ask_user',arguments:{questions}});
    let request;
    for(let i=0;i<60&&!request;i++){await delay(25);request=(await get('job_stdio')).data.pendingQuestions?.[0];}
    assert.ok(request);assert.equal(request.status,'pending');assert.equal(replies.has(3),false,'MCP has not returned a fake empty answer');
    assert.equal((await get('job_stdio','bob')).status,404);
    assert.deepEqual((await get('legacy_one')).data.pendingQuestions,[]);
    assert.equal((await get('missing_one')).status,404);
    const url=base+'/shiyan/v1/jobs/job_stdio/questions/'+request.id+'/answer';
    const data=JSON.stringify(answer),headers={'Content-Type':'application/json','x-test-owner':'alice','x-shiyan-body-sha':digest(data)};
    const invalid=await fetch(url,{method:'POST',headers:{...headers,'x-shiyan-body-sha':'0'.repeat(64)},body:data});assert.equal(invalid.status,401);
    const submitted=await fetch(url,{method:'POST',headers,body:data});assert.equal(submitted.status,200);
    const completed=await Promise.race([waiting,delay(3000).then(()=>{throw new Error('MCP did not resume');})]);
    assert.deepEqual(completed.result.structuredContent.answers,answer.answers);
    assert.equal((await get('job_stdio')).data.pendingQuestions[0].status,'answered');
    assert.equal(output.includes(token),false);assert.equal(error.includes(token),false);
  }finally{child.kill('SIGTERM');await once(child,'exit');lines.close();await new Promise(resolve=>server.close(resolve));f.cleanup();}
});

test('SDK injects stdio MCP configuration and token via environment, not argv',async()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'shiyan-input-sdk-'));const executable=path.join(root,'fake-codex'),record=path.join(root,'record.json');
  writeFileSync(executable,'#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.INPUT_TEST_RECORD,JSON.stringify({args:process.argv.slice(2),token:process.env.SHIYAN_INPUT_TOKEN}));console.log(JSON.stringify({type:"thread.started",thread_id:"thread_test"}));console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,cached_input_tokens:0,output_tokens:1}}));',{mode:0o700});
  const token='a'.repeat(64);
  try{
    const codex=new Codex({codexPathOverride:executable,env:{...process.env,INPUT_TEST_RECORD:record,SHIYAN_INPUT_TOKEN:token},config:{mcp_servers:{'shiyan-input':{command:process.execPath,args:['/tmp/tool.mjs'],env:{SHIYAN_INPUT_JOB:'job_test'},env_vars:['SHIYAN_INPUT_TOKEN'],tool_timeout_sec:7200}}}});
    const {events}=await codex.startThread({skipGitRepoCheck:true}).runStreamed('fixture');for await(const _ of events){}
    const value=JSON.parse(readFileSync(record,'utf8'));assert.equal(value.token,token);assert.equal(JSON.stringify(value.args).includes(token),false);
    assert.ok(value.args.some((arg: any)=>arg==='mcp_servers.shiyan-input.env_vars=["SHIYAN_INPUT_TOKEN"]'));
    assert.ok(value.args.some((arg: any)=>arg==='mcp_servers.shiyan-input.tool_timeout_sec=7200'));
  }finally{rmSync(root,{recursive:true,force:true});}
});
