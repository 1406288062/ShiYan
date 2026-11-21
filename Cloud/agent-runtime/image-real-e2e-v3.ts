// User-authorized live end-to-end QA. Uses a temporary device identity and
// isolated conversations; deletes only its temporary authorization on exit.
import {generateKeyPairSync,createHash,sign,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,renameSync,existsSync} from 'node:fs';
import assert from 'node:assert/strict';
const file=new URL('./devices.json',import.meta.url);
const stateFile=new URL('./data/state.json',import.meta.url);
const report: any[]=[];
const load=()=>JSON.parse(readFileSync(file,'utf8'));
const save=o=>{const tmp=file.pathname+'.v3-qa-tmp';writeFileSync(tmp,JSON.stringify(o),{mode:0o600});renameSync(tmp,file.pathname)};
const {privateKey,publicKey}=generateKeyPairSync('ed25519');
const raw=publicKey.export({format:'der',type:'spki'}).subarray(-32);
const sha=v=>createHash('sha256').update(v).digest('hex');
const id=sha(raw),owner='shiyan-v3-qa-'+randomUUID();
const base='http://127.0.0.1:4323/shiyan/v1/';
function signed(method,route,obj?: any){
 const data=obj===undefined?'':JSON.stringify(obj),time=String(Date.now()),nonce=randomUUID(),hash=sha(data);
 return {method,headers:{'Content-Type':'application/json','X-Shiyan-Device':id,'X-Shiyan-Time':time,'X-Shiyan-Nonce':nonce,'X-Shiyan-Body-Sha':hash,'X-Shiyan-Signature':sign(null,Buffer.from([method,'/shiyan/v1/'+route,time,nonce,hash].join('\n')),privateKey).toString('base64')},body:data||undefined};
}
async function req(method,route,obj?: any){
 const res=await fetch(base+route,{...signed(method,route,obj),signal:AbortSignal.timeout(40000)});
 const body=await res.text();
 if(!res.ok)throw Error(method+' '+route+' '+res.status+' '+body.slice(0,250));
 return JSON.parse(body);
}
async function stream(job){
 const route='jobs/'+job+'/events?after=0&transport=metadata',controller=new AbortController();
 const timeout=setTimeout(()=>controller.abort(),240000);
 let buf='',artifactCount=0,contradictoryAfterArtifact=0,terminal;
 try {
  const res=await fetch(base+route,{...signed('GET',route),signal:controller.signal});
  assert.equal(res.status,200);
  for await(const chunk of res.body!){
   buf+=Buffer.from(chunk).toString();
   let end;
   while((end=buf.indexOf('\n\n'))>=0) {
    const frame=buf.slice(0,end);buf=buf.slice(end+2);
    const data=frame.split('\n').find(x=>x.startsWith('data: '));
    if(!data)continue;
    const e=JSON.parse(data.slice(6));
    if(e.type==='artifact')artifactCount++;
    if(artifactCount>0 && e.type==='text' && /图片生成没有返回可展示的结果/.test(e.text||''))contradictoryAfterArtifact++;
    if(['completed','failed','cancelled','interrupted'].includes(e.type)){terminal=e;break;}
   }
   if(terminal)break;
  }
 } finally {clearTimeout(timeout);controller.abort();}
 return {terminal,artifactCount,contradictoryAfterArtifact};
}
const devices=load();
devices[id]={id,publicKey:raw.toString('base64'),approved:true,owner,revoked:false};
save(devices);
let active: any=null;
try {
 const reference='/home/ubuntu/boss-codex-service/shiyan-v2/workspaces/3a11beeda02febf10a10075137814668c24f19019ac8976cef01e7816e490b02/inputs/228d4e40-3cf4-4f2e-96c2-a0baaf90dab9/image-1.jpg';
 const sameConversation=randomUUID();
 const scenarios=[
  {label:'new-image-no-reference',conversationId:sameConversation,prompt:'请调用绘图能力生成一张原创简洁插画：白色背景上有一只蓝色小鸟和一朵黄色花，并交付真实生成图片。',images:[]},
  {label:'reference-based-image',conversationId:randomUUID(),prompt:'以这张图作为风格参考，生成一张不同构图的原创插画，仍有窗边书房和人物，请交付新图片。',images:[{data:readFileSync(reference).toString('base64'),suffix:'.jpg'}]},
  {label:'regenerate-in-same-thread',conversationId:sameConversation,prompt:'请重新生成一张不同构图的原创插画，画面改为蓝色天空下的小猫和红色花朵，并交付新图片。',images:[]},
 ];
 for(const scenario of scenarios){
   const requestID=randomUUID();
   const job=await req('POST','jobs',{conversationId:scenario.conversationId,requestId:requestID,prompt:scenario.prompt,reasoning:'low',images:scenario.images});
   active=job.jobId;
   console.log('QA_STARTED',scenario.label,active,flush());
   const wire=await stream(active);
   assert(wire.terminal,'missing terminal event');
   const snapshot=await req('GET','jobs/'+active);
   const item=JSON.parse(readFileSync(stateFile,'utf8')).jobs[active];
   const count=(item.assets||[]).filter(a=>a.mimeType.startsWith('image/')&&a.sha256).length;
   assert.equal(snapshot.status,wire.terminal.type,'status alignment');
   assert.equal(snapshot.text,wire.terminal.text||snapshot.text,'text alignment');
   assert.equal(wire.contradictoryAfterArtifact,0,'contradictory streaming AFTER confirmed image');
   if(count>0){
     assert(!/图片生成没有返回可展示的结果/.test(snapshot.text),'success but no-image claim');
     assert.equal(wire.terminal.generatedImageCount,count,'authoritative completed image count');
   }
   const row={scenario:scenario.label,jobId:active,status:snapshot.status,images:count,artifactEvents:wire.artifactCount,contradictionsAfterArtifact:wire.contradictoryAfterArtifact,consistent:true};
   report.push(row);console.log('QA_RESULT',JSON.stringify(row),flush());
   active=null;
 }
} finally{
 if(active) await req('POST','jobs/'+active+'/cancel',{}).catch(()=>{});
 const current=load(); if(current[id]?.owner===owner){delete current[id];save(current)}
 console.log('QA_FINAL',JSON.stringify(report));
 console.log('QA_DEVICE_AUTH_CLEANED');
}
function flush(){return ''}
