// Query the actual Codex runtime; no assumed model names or reasoning levels.
import {spawn} from 'node:child_process';
let cached=[],checkedAt=0,inflight=null;
export async function refreshModels(){
 if(cached.length&&Date.now()-checkedAt<300000)return cached;
 if(inflight)return inflight;
 inflight=new Promise((resolve,reject)=>{
  const child=spawn('/home/ubuntu/.local/bin/codex',['app-server'],{stdio:['pipe','pipe','ignore']});
  let text='',finished=false,requestId=2,models=[];
  const timer=setTimeout(()=>done(new Error('模型能力读取超时')),30000);
  const send=v=>{
   if(finished||!child.stdin.writable)return;
   child.stdin.write(JSON.stringify(v)+'\n',error=>{
    if(error&&!finished){
     console.error('[ModelCapabilitiesWrite]',error.code||error.name||'error','pid',child.pid,'requestId',requestId,'writable',child.stdin.writable,'destroyed',child.stdin.destroyed);
     done(error);
    }
   });
  };
  function done(error){if(finished)return;finished=true;clearTimeout(timer);if(!child.killed)child.kill('SIGTERM');if(error)reject(error);else{cached=models;checkedAt=Date.now();resolve(cached);}}
  child.stdin.on('error',error=>{
   if(!finished)console.error('[ModelCapabilitiesStdin]',error.code||error.name||'error','pid',child.pid,'requestId',requestId,'writable',child.stdin.writable,'destroyed',child.stdin.destroyed);
   done(error);
  });
  child.on('error',done);child.on('exit',(code,signal)=>{if(!finished)done(new Error('模型能力进程提前退出 code='+String(code)+' signal='+String(signal)));});
  child.stdout.on('data',chunk=>{
   text+=chunk.toString();let end;
   while((end=text.indexOf('\n'))>=0){const line=text.slice(0,end);text=text.slice(end+1);if(!line.trim())continue;let value;try{value=JSON.parse(line);}catch{continue;}
    if(value.error){done(new Error(value.error.message||'模型能力读取失败'));return;}
    if(value.id===1){send({method:'initialized'});send({id:requestId,method:'model/list',params:{includeHidden:false}});}
    if(value.id===requestId&&value.result){
     for(const m of value.result.data||[]){const levels=(m.supportedReasoningEfforts||[]).map(x=>x.reasoningEffort);if(m.hidden||!levels.length||!levels.includes(m.defaultReasoningEffort))continue;models.push({id:m.model||m.id,displayName:m.displayName,reasoningEfforts:levels,defaultReasoning:m.defaultReasoningEffort});}
     if(value.result.nextCursor){requestId++;send({id:requestId,method:'model/list',params:{includeHidden:false,cursor:value.result.nextCursor}});}
     else if(!models.length)done(new Error('未返回可用模型'));else done();
    }
   }
  });
  send({id:1,method:'initialize',params:{clientInfo:{name:'shiyan-mac',version:'2.2'},capabilities:{experimentalApi:true}}});
 });
 try{return await inflight;}finally{inflight=null;}
}
export function verifiedModels(){return cached;}
