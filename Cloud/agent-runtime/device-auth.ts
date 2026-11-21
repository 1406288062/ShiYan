// Device public-key registration. No service secret is distributed inside the app.
// A developer approves the public key over the existing trusted administration channel.
import path from 'node:path';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { getAccountStore, requestBearer, PRIVATE_OWNER } from './accounts.ts';
const root=process.env.SHIYAN_ROOT||'/home/ubuntu/boss-codex-service/shiyan-v2';
mkdirSync(root,{recursive:true,mode:0o700});
const registry=path.join(root,'devices.json');
const usedNonces=new Map();
const load=()=>{try{return JSON.parse(readFileSync(registry,'utf8'));}catch{return {};}};
const save=devices=>{writeFileSync(registry+'.tmp',JSON.stringify(devices),{mode:0o600});renameSync(registry+'.tmp',registry);};
export const digest=data=>createHash('sha256').update(data).digest('hex');
export function enrollDevice(input){
  const raw=Buffer.from(String(input.publicKey||''),'base64');
  if(raw.length!==32)throw new Error('设备标识无效');
  const id=digest(raw);const devices=load();
  if(!devices[id]){
    if(Object.keys(devices).length>=100)throw new Error('设备登记暂不可用');
    devices[id]={id,publicKey:raw.toString('base64'),approved:false,createdAt:Date.now()};save(devices);
  }
  return {ok:true,deviceID:id,approved:devices[id].approved===true};
}
export function authenticateLegacyDevice(req){
  const id=req.headers['x-shiyan-device'];const timestamp=Number(req.headers['x-shiyan-time']);
  const nonce=req.headers['x-shiyan-nonce'];const bodyHash=req.headers['x-shiyan-body-sha'];
  if(typeof id!=='string'||typeof nonce!=='string'||!/^[A-Za-z0-9-]{16,80}$/.test(nonce)||typeof bodyHash!=='string'||!/^[0-9a-f]{64}$/.test(bodyHash)||!Number.isFinite(timestamp)||Math.abs(Date.now()-timestamp)>300000)return null;
  const devices=load();const device=devices[id];if(!device?.approved||device.revoked)return null;
  const replayKey=id+':'+nonce;if(usedNonces.has(replayKey))return null;
  const raw=Buffer.from(device.publicKey,'base64');
  const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),raw]),format:'der',type:'spki'});
  const message=[req.method,req.url,String(timestamp),nonce,bodyHash].join('\n');
  const signature=Buffer.from(String(req.headers['x-shiyan-signature']||''),'base64');
  try{if(!verify(null,Buffer.from(message),key,signature))return null;}catch{return null;}
  usedNonces.set(replayKey,Date.now());
  if(usedNonces.size>10000)for(const [key,time] of usedNonces)if(Date.now()-time>300000)usedNonces.delete(key);
  return {owner:device.owner||id,deviceID:id,platform:device.platform};
}

// A supplied invalid account token can never fall back to the device owner's data.
// Legacy owner access ends atomically when that owner binds the first admin account.
export function authenticateDevice(req){
  const accounts=getAccountStore();
  if(req.headers.authorization!==undefined){
    const token=requestBearer(req);if(!token)return null;
    const auth=accounts.authenticate(token);if(!auth)return null;
    const platform=req.headers['x-shiyan-platform'];
    return {...auth,platform:platform==='ios'?'ios':platform==='macos'?'macos':undefined};
  }
  if(process.env.SHIYAN_REQUIRE_ACCOUNT_SESSION==='1'||req.headers['x-shiyan-account-required']==='1'||!accounts.bootstrapRequired())return null;
  const auth=authenticateLegacyDevice(req);
  if(!auth||auth.owner!==PRIVATE_OWNER)return null;
  return {...auth,role:'admin',serverAccess:true,legacy:true};
}
