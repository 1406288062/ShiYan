// Minimal stdio MCP transport. Stdout contains JSON-RPC only, never secrets.
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const endpoint=process.env.SHIYAN_INPUT_URL||'http://127.0.0.1:4327';
const jobID=process.env.SHIYAN_INPUT_JOB,token=process.env.SHIYAN_INPUT_TOKEN;
const shutdown=new AbortController();
const headers={'Content-Type':'application/json',Authorization:'Bearer '+token};
const root=endpoint+'/internal/v1/jobs/'+encodeURIComponent(jobID||'')+'/questions';
const write=(value: any)=>{if(!process.stdout.destroyed)process.stdout.write(JSON.stringify(value)+'\n');};
const tool={name:'ask_user',description:'Ask the user one to three optional clarification questions with clickable choices in ShiYan. This tool waits for the user’s answer and returns it to the current run. Use this tool for choice questions instead of request_user_input_async or a plain bullet list. Never use it to request action permissions.',inputSchema:{type:'object',properties:{questions:{type:'array',minItems:1,maxItems:3,items:{type:'object',properties:{id:{type:'string'},header:{type:'string'},question:{type:'string'},options:{type:'array',minItems:2,maxItems:5,items:{type:'object',properties:{label:{type:'string'},description:{type:'string'}},required:['label'],additionalProperties:false}}},required:['id','header','question','options'],additionalProperties:false}}},required:['questions'],additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}};
async function request(url: any,options={}){
  for(let attempt=0;;attempt++){
    try{
      const response=await fetch(url,{...options,headers,signal:AbortSignal.any([shutdown.signal,AbortSignal.timeout(10000)])});
      const data=(await response.json()) as any;
      if(!response.ok||data.ok!==true)throw Object.assign(new Error('Question request failed'),{status:response.status});
      return data;
    }catch(error){
      if(shutdown.signal.aborted||attempt>=4||(error as any).status&&(error as any).status<500)throw error;
      // The same requestId/body survives transport retries, so a sidecar
      // restart or a lost POST response cannot create duplicate questions.
      await delay(Math.min(250*2**attempt,2000),undefined,{signal:shutdown.signal});
    }
  }
}
async function ask(input: any){
  let value=(await request(root,{method:'POST',body:JSON.stringify({requestId:randomUUID(),questions:input.questions})})).request;
  while(value.status==='pending'){
    await delay(500,undefined,{signal:shutdown.signal});
    value=(await request(root+'/'+encodeURIComponent(value.id))).request;
  }
  if(value.status!=='answered')return {content:[{type:'text',text:'The question was closed because the task ended. No user answer was received.'}],isError:true};
  return {content:[{type:'text',text:JSON.stringify({answers:value.answers})}],structuredContent:{answers:value.answers}};
}
async function handle(message: any){
  if(!Object.hasOwn(message,'id'))return;
  try{
    let result;
    if(message.method==='initialize')result={protocolVersion:message.params?.protocolVersion||'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'shiyan-input',version:'1.0.0'}};
    else if(message.method==='ping')result={};
    else if(message.method==='tools/list')result={tools:[tool]};
    else if(message.method==='tools/call'&&message.params?.name==='ask_user')result=await ask(message.params.arguments||{});
    else return write({jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Method not found'}});
    write({jsonrpc:'2.0',id:message.id,result});
  }catch(error){
    // The server's expected validation errors are safe; transport diagnostics
    // and environment values are deliberately not returned or logged.
    write({jsonrpc:'2.0',id:message.id,result:{content:[{type:'text',text:'问答未完成，请重试或让用户直接发送回复。'}],isError:true}});
  }
}
const input=createInterface({input:process.stdin,crlfDelay:Infinity});
input.on('line',line=>{try{const value=JSON.parse(line);void handle(value);}catch{write({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}});}});
input.on('close',()=>shutdown.abort());
process.on('SIGTERM',()=>{shutdown.abort();input.close();});
process.stdout.on('error',()=>shutdown.abort());
