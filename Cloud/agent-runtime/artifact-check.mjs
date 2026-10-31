import http from 'node:http';
import https from 'node:https';
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import {generateKeyPairSync,createHash,sign,randomUUID} from 'node:crypto';
const state=JSON.parse(readFileSync('data/state.json','utf8'));
const asset=Object.values(state.assets).at(-1);
if(!asset)throw new Error('No output artifact to inspect');
const file='devices.json',load=()=>JSON.parse(readFileSync(file,'utf8'));
const save=x=>{writeFileSync(file+'.tmp',JSON.stringify(x),{mode:0o600});renameSync(file+'.tmp',file);};
const hash=x=>createHash('sha256').update(x).digest('hex');
const keys=generateKeyPairSync('ed25519'),raw=keys.publicKey.export({format:'der',type:'spki'}).subarray(-32),id=hash(raw);
const devices=load();devices[id]={publicKey:raw.toString('base64'),approved:true,owner:asset.owner};save(devices);
const certificate=readFileSync('/home/ubuntu/boss-codex-service/tls/server.crt');
const route='/shiyan/v1/artifacts/'+asset.id;
async function inspect(port,tls=false){
 const now=String(Date.now()),nonce=randomUUID(),sha=hash('');
 const headers={'X-Shiyan-Device':id,'X-Shiyan-Time':now,'X-Shiyan-Nonce':nonce,'X-Shiyan-Body-Sha':sha,'X-Shiyan-Signature':sign(null,Buffer.from(['GET',route,now,nonce,sha].join('\n')),keys.privateKey).toString('base64'),'Content-Type':'application/json','Content-Length':0,'Host':'129.226.81.110'};
 await new Promise((resolve,reject)=>{
  const req=(tls?https:http).request({host:'127.0.0.1',port,path:route,method:'GET',headers,ca:certificate,checkServerIdentity:()=>undefined},res=>{
   const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>{const data=Buffer.concat(chunks);console.log({port,status:res.statusCode,contentType:res.headers['content-type'],bytes:data.length,shaMatches:hash(data)===asset.sha256,bodyError:res.statusCode===200?undefined:data.toString().slice(0,700)});resolve();});
  });req.on('error',reject);req.end();
 });
}
try {await inspect(4323);await inspect(4320);await inspect(443,true);} finally {const x=load();delete x[id];save(x);}
