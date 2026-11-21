 
import {generateKeyPairSync,createHash,sign,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import assert from 'node:assert/strict';
const file = new URL('./devices.json', import.meta.url);
const load = () => {try{return JSON.parse(readFileSync(file,'utf8'));}catch{return {};}};
const save = value => {writeFileSync(file.pathname+'.tmp',JSON.stringify(value),{mode:0o600});renameSync(file.pathname+'.tmp',file);};
const {privateKey,publicKey}=generateKeyPairSync('ed25519');
const raw=publicKey.export({format:'der',type:'spki'}).subarray(-32);
const hash=value=>createHash('sha256').update(value).digest('hex');
const id=hash(raw);
const devices=load();devices[id]={id,publicKey:raw.toString('base64'),approved:true,owner:'qa-'+randomUUID()};save(devices);
function request(method,route,payload?){
 const data=payload===undefined?'':JSON.stringify(payload);
 const time=String(Date.now()),nonce=randomUUID(),bodyHash=hash(data);
 const headers={'Content-Type':'application/json','X-Shiyan-Device':id,'X-Shiyan-Time':time,'X-Shiyan-Nonce':nonce,'X-Shiyan-Body-Sha':bodyHash,'X-Shiyan-Signature':sign(null,Buffer.from([method,route,time,nonce,bodyHash].join('\n')),privateKey).toString('base64')};
 return {method,headers,body:data||undefined};
}
const url='http://127.0.0.1:4323';
try{
 let response=await fetch(url+'/shiyan/v1/capabilities');assert.equal(response.status,401);console.log('PASS anonymous denied');
 const route='/shiyan/v1/capabilities',signed=request('GET',route);
 response=await fetch(url+route,signed);assert.equal(response.status,200);const caps=await response.json();assert(caps.reasoningEfforts.includes('low'));console.log('PASS approved signed request');
 response=await fetch(url+route,signed);assert.equal(response.status,401);console.log('PASS replay denied');
 const bad=request('GET',route);bad.headers['X-Shiyan-Signature']='AAAA';response=await fetch(url+route,bad);assert.equal(response.status,401);console.log('PASS invalid signature denied');
 const p='/shiyan/v1/jobs';const invalid={conversationId:randomUUID(),requestId:randomUUID(),prompt:'Do not execute this test',reasoning:'unsupported',images:[]};
 response=await fetch(url+p,request('POST',p,invalid));assert.equal(response.status,400);console.log('PASS unsupported reasoning rejected before inference');
 const changed=request('POST',p,invalid);changed.body=JSON.stringify({...invalid,prompt:'tampered'});response=await fetch(url+p,changed);assert.equal(response.status,401);console.log('PASS tampered body denied');
 response=await fetch(url+'/shiyan/v1/artifacts/'+randomUUID(),request('GET','/shiyan/v1/artifacts/missing-file'));
 assert.equal(response.status,401);console.log('PASS signed path tampering denied');
 console.log('AUTH_SMOKE_ALL_PASSED');
}finally{const latest=load();delete latest[id];save(latest);}
