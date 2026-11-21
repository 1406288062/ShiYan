import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import {generateKeyPairSync,createHash,sign,randomUUID} from 'node:crypto';
const state=JSON.parse(readFileSync('data/state.json','utf8'));
const job=(Object.values(state.jobs) as any[]).find(j=>j.prompt.startsWith('Reply exactly')&&j.status==='completed');
if(!job)throw new Error('No QA text conversation');
const conversation=state.conversations[job.conversationKey];
const file='devices.json',load=()=>JSON.parse(readFileSync(file,'utf8'));
const save=x=>{writeFileSync(file+'.tmp',JSON.stringify(x),{mode:0o600});renameSync(file+'.tmp',file);};
const hash=x=>createHash('sha256').update(x).digest('hex');
const keys=generateKeyPairSync('ed25519'),raw=keys.publicKey.export({format:'der',type:'spki'}).subarray(-32),id=hash(raw);
const devices=load();devices[id]={publicKey:raw.toString('base64'),approved:true,owner:job.owner};save(devices);
const route='/shiyan/v1/title',body=JSON.stringify({conversationId:conversation.id});
const now=String(Date.now()),nonce=randomUUID(),sha=hash(body);
const headers={'Content-Type':'application/json','X-Shiyan-Device':id,'X-Shiyan-Time':now,'X-Shiyan-Nonce':nonce,'X-Shiyan-Body-Sha':sha,'X-Shiyan-Signature':sign(null,Buffer.from(['POST',route,now,nonce,sha].join('\n')),keys.privateKey).toString('base64')};
try{
 const r=await fetch('http://127.0.0.1:4323'+route,{method:'POST',headers,body,signal:AbortSignal.timeout(60000)});
 console.log('TITLE_STATUS',r.status,'RESULT',await r.text());
}finally{const x=load();delete x[id];save(x);}
