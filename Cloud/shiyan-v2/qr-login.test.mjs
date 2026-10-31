import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AccountStore } from './accounts.mjs';
import { QRLogin } from './qr-login.mjs';
const root=mkdtempSync(path.join(os.tmpdir(),'shiyan-qr-'));
test.after(()=>rmSync(root,{recursive:true,force:true}));
async function setup(t){let now=Date.now();const store=new AccountStore(path.join(root,Math.random().toString()),{now:()=>now});t.after(()=>store.close());const phone=await store.register({email:'member@example.test',password:'test-password-only'});return {store,phone,qr:new QRLogin(store),advance:()=>now+=120001};}
const scan=x=>({id:x.id,scanSecret:new URL(x.payload).searchParams.get('secret')});
test('scan cannot redeem; confirmation issues an independent same-user session once',async t=>{
 const {store,phone,qr}=await setup(t),c=qr.create(),auth=store.authenticate(phone.token);
 assert.equal(qr.preview(scan(c)).code,c.code);assert.equal(qr.poll({id:c.id,pollSecret:c.pollSecret}).state,'pending');
 assert.throws(()=>qr.poll({id:c.id,pollSecret:scan(c).scanSecret}),{status:404});
 qr.approve(auth,{...scan(c),approve:true});assert.throws(()=>qr.approve(auth,{...scan(c),approve:true}),{status:409});
 const result=qr.poll({id:c.id,pollSecret:c.pollSecret});assert.equal(result.user.id,phone.user.id);assert.equal(result.user.role,'user');assert.notEqual(result.token,phone.token);assert.ok(store.authenticate(result.token));
 assert.throws(()=>qr.poll({id:c.id,pollSecret:c.pollSecret}),{status:409});
});
test('expired, rejected and revoked phone confirmations never authorize the desktop',async t=>{
 const {store,phone,qr,advance}=await setup(t),auth=store.authenticate(phone.token);
 const c=qr.create();qr.approve(auth,{...scan(c),approve:false});assert.equal(qr.poll({id:c.id,pollSecret:c.pollSecret}).state,'denied');
 const d=qr.create();qr.approve(auth,{...scan(d),approve:true});store.logout(phone.token);assert.throws(()=>qr.poll({id:d.id,pollSecret:d.pollSecret}),{status:401});
 const e=qr.create();advance();assert.throws(()=>qr.preview(scan(e)),{status:410});assert.throws(()=>qr.poll({id:e.id,pollSecret:e.pollSecret}),{status:410});
});

import http from 'node:http';
import { createAccountHandler } from './account-http.mjs';
test('HTTP QR routes require phone authentication and ignore forged roles',async t=>{
 const {store,phone}=await setup(t);const handler=createAccountHandler({store});
 const server=http.createServer(async(req,res)=>{if(!await handler(req,res)){res.writeHead(404);res.end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const post=async(route,body={},token)=>{
  const response=await fetch(`http://127.0.0.1:${server.address().port}/v1/auth/qr/${route}`,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
  return {status:response.status,value:await response.json()};
 };
 const c=(await post('create')).value;
 assert.equal((await post('preview',scan(c))).status,401);
 assert.equal((await post('approve',{...scan(c),approve:true})).status,401);
 assert.equal((await post('preview',scan(c),phone.token)).status,200);
 assert.equal((await post('approve',{...scan(c),approve:true,role:'admin',serverAccess:true},phone.token)).status,200);
 const exchange=await post('poll',{id:c.id,pollSecret:c.pollSecret});
 assert.equal(exchange.status,200);assert.equal(exchange.value.user.id,phone.user.id);assert.equal(exchange.value.user.role,'user');assert.equal(exchange.value.user.serverAccess,false);
 assert.equal((await post('poll',{id:c.id,pollSecret:c.pollSecret})).status,409);
});
