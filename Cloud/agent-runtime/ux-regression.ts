// Regression test uses an ephemeral approved QA identity, never a user's active job.
import {generateKeyPairSync,createHash,sign,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import assert from 'node:assert/strict';
const file=new URL('./devices.json',import.meta.url), report: any[]=[];
const load=()=>JSON.parse(readFileSync(file,'utf8'));
const save=v=>{writeFileSync(file.pathname+'.tmp',JSON.stringify(v),{mode:0o600});renameSync(file.pathname+'.tmp',file);};
const {privateKey,publicKey}=generateKeyPairSync('ed25519');
const raw=publicKey.export({format:'der',type:'spki'}).subarray(-32);
const hash=v=>createHash('sha256').update(v).digest('hex'),id=hash(raw),owner='qa-ux-'+randomUUID();
const devices=load();devices[id]={id,publicKey:raw.toString('base64'),approved:true,owner};save(devices);
const signed=(method,route,value?: any)=>{
 const data=value===undefined?'':JSON.stringify(value),time=String(Date.now()),nonce=randomUUID(),sha=hash(data);
 return {method,headers:{'Content-Type':'application/json','X-Shiyan-Device':id,'X-Shiyan-Time':time,'X-Shiyan-Nonce':nonce,'X-Shiyan-Body-Sha':sha,'X-Shiyan-Signature':sign(null,Buffer.from([method,route,time,nonce,sha].join('\n')),privateKey).toString('base64')},body:data||undefined};
};
const base='http://127.0.0.1:4323';
async function request(method,path,data?: any): Promise<any> {const route='/shiyan/v1/'+path;const r=await fetch(base+route,{...signed(method,route,data),signal:AbortSignal.timeout(65000)});assert(r.ok,`${r.status} ${await r.clone().text()}`);return r.json();}
async function stream(job,onEvent){
 const route='/shiyan/v1/jobs/'+job+'/events?after=0&transport=metadata';
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),60000);let buffer='';
 try{const r=await fetch(base+route,{...signed('GET',route),signal:controller.signal});assert.equal(r.status,200);
 for await(const bytes of r.body!){buffer+=Buffer.from(bytes).toString();let end;
 while((end=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);const data=frame.split('\n').find(x=>x.startsWith('data: '));if(data){const event=JSON.parse(data.slice(6));assert(!event.data,'metadata transport must not contain image bytes');if(await onEvent(event)){controller.abort();return;}}}
 }}finally{clearTimeout(timer);controller.abort();}
}
let activeJob;
try{
 const requestID=randomUUID();const before=await request('POST','requests/'+requestID+'/cancel',{});assert.equal(before.status,'cancelled');
 const stopped=await request('POST','jobs',{conversationId:randomUUID(),requestId:requestID,prompt:'This canceled request must never run.',images:[],reasoning:'low'});
 assert.equal(stopped.status,'cancelled');const snap=await request('GET','jobs/'+stopped.jobId);
 assert.equal(snap.threadId,null);assert(snap.events.every(e=>e.type!=='thread'));report.push({test:'cancel_before_submission',passed:true});
 const rid=randomUUID();activeJob=(await request('POST','jobs',{conversationId:randomUUID(),requestId:rid,prompt:'请生成一张蓝色圆形、纯白背景的图片。',images:[],reasoning:'low'})).jobId;
 let canceled=false;
 await stream(activeJob,async e=>{
  if(e.type==='thread'&&!canceled){canceled=true;const start=performance.now();const result=await request('POST','requests/'+rid+'/cancel',{});assert.equal(result.status,'cancelled');report.push({test:'cancel_running_codex',passed:true,ack_ms:Math.round(performance.now()-start)});return true;}
  if(e.type==='completed')throw new Error('Job completed before cancellation could be exercised');return false;
 });
 assert(canceled);await new Promise(r=>setTimeout(r,1200));
 const after=await request('GET','jobs/'+activeJob);assert.equal(after.status,'cancelled');assert(!after.events.some(e=>e.type==='completed'));activeJob=null;
 const prompt='Reply exactly: SHIYAN_GENERIC_CHAT_OK';
 const textJob=(await request('POST','jobs',{conversationId:randomUUID(),requestId:randomUUID(),prompt,images:[],reasoning:'low'})).jobId;activeJob=textJob;
 let answer;
 await stream(textJob,async e=>{if(e.type==='completed'){answer=e;return true;}if(e.type==='failed')throw new Error(e.error);return false;});
 assert.equal(answer.text.trim(),'SHIYAN_GENERIC_CHAT_OK');assert.equal(answer.assets.length,0);
 const state=JSON.parse(readFileSync(new URL('./data/state.json',import.meta.url),'utf8'));
 assert.equal(state.jobs[textJob].prompt,prompt);report.push({test:'verbatim_generic_text_and_metadata_stream',passed:true});activeJob=null;
 writeFileSync(new URL('./ux-regression-results.json',import.meta.url),JSON.stringify(report,null,2));
 console.log(JSON.stringify(report,null,2));console.log('UX_BACKEND_REGRESSION_PASSED');
}finally{
 if(activeJob)await request('POST','jobs/'+activeJob+'/cancel',{}).catch(()=>{});
 const latest=load();delete latest[id];save(latest);
}
