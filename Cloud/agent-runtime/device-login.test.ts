import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {AccountStore} from './accounts.ts';
import {DeviceLogin} from './device-login.ts';
const root=mkdtempSync(path.join(os.tmpdir(),'device-login-'));test.after(()=>rmSync(root,{recursive:true,force:true}));
async function setup(t){let now=Date.now();const a=new AccountStore(path.join(root,Math.random().toString()),{now:()=>now});t.after(()=>a.close());const phone=await a.register({email:'phone@example.test',password:'test-password-42'}),other=await a.register({email:'other@example.test',password:'test-password-42'});const d=new DeviceLogin(a),row=a.db.prepare('SELECT * FROM account_users WHERE id=?').get(phone.user.id),device=d.pair(row);return {a,d,phone,other,creds:{deviceId:device.id,deviceSecret:device.secret},advance:()=>now+=120001};}
test('remembered device never authenticates until the correct phone explicitly approves, then exchanges once',async t=>{
 const {a,d,phone,other,creds}=await setup(t),c=d.create(creds),input={...creds,id:c.id,pollSecret:c.pollSecret};
 assert.equal(a.authenticate(creds.deviceSecret),null);assert.equal(d.poll(input).state,'pending');
 assert.equal(d.inbox(a.authenticate(other.token)).requests.length,0);
 assert.throws(()=>d.approve(a.authenticate(other.token),{id:c.id,approve:true}),{status:404});
 assert.equal(d.inbox(a.authenticate(phone.token)).requests[0].id,c.id);
 d.approve(a.authenticate(phone.token),{id:c.id,approve:true});
 const result=d.poll(input);assert.equal(result.user.id,phone.user.id);assert.equal(result.user.role,'user');assert.equal(result.user.serverAccess,false);
 assert.ok(a.authenticate(result.token));assert.throws(()=>d.poll(input),{status:409});
});
test('rejection, expiry, wrong device secret and revoked phone sessions never authorize',async t=>{
 const {a,d,phone,creds,advance}=await setup(t),auth=a.authenticate(phone.token);
 assert.throws(()=>d.create({...creds,deviceSecret:'z'.repeat(43)}),{status:401});
 const c=d.create(creds);d.approve(auth,{id:c.id,approve:false});assert.equal(d.poll({...creds,id:c.id,pollSecret:c.pollSecret}).state,'denied');
 const e=d.create(creds);d.approve(auth,{id:e.id,approve:true});a.logout(phone.token);assert.throws(()=>d.poll({...creds,id:e.id,pollSecret:e.pollSecret}),{status:401});
 const f=d.create(creds);advance();assert.throws(()=>d.poll({...creds,id:f.id,pollSecret:f.pollSecret}),{status:410});
});

import http from 'node:http';
import {createAccountHandler} from './account-http.ts';
test('HTTP first QR pairing enables subsequent phone-confirmed login without scanning',async t=>{
 const {a,phone,other}=await setup(t),handler=createAccountHandler({store:a});
 const server=http.createServer(async(req,res)=>{if(!await handler(req,res)){res.writeHead(404);res.end();}});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',()=>resolve()));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const call=async(route,body?: any,token?: any)=>{
  const r=await fetch(`http://127.0.0.1:${(server.address() as any).port}/v1/auth/${route}`,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:r.status,value:(await r.json()) as any};
 };
 const c=(await call('qr/create',{})).value,scan={id:c.id,scanSecret:new URL(c.payload).searchParams.get('secret')};
 assert.equal((await call('qr/approve',{...scan,approve:true},phone.token)).status,200);
 const pair=(await call('qr/poll',{id:c.id,pollSecret:c.pollSecret})).value.device;
 const creds={deviceId:pair.id,deviceSecret:pair.secret};
 const request=(await call('device/request',creds)).value;
 assert.equal((await call('device/requests')).status,401);
 assert.equal((await call('device/requests',undefined,other.token)).value.requests.length,0);
 assert.equal((await call('device/requests',undefined,phone.token)).value.requests[0].id,request.id);
 const input={...creds,id:request.id,pollSecret:request.pollSecret};
 assert.equal((await call('device/poll',input)).value.state,'pending');
 assert.equal((await call('device/approve',{id:request.id,approve:true},other.token)).status,404);
 assert.equal((await call('device/approve',{id:request.id,approve:true},phone.token)).status,200);
 const result=await call('device/poll',input);assert.equal(result.status,200);assert.equal(result.value.user.id,phone.user.id);assert.equal(result.value.user.role,'user');
 assert.equal((await call('device/poll',input)).status,409);
});
