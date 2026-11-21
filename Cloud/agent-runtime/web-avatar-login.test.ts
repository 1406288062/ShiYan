import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {mkdtempSync,rmSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {AccountStore} from './accounts.ts';
import {createAccountHandler} from './account-http.ts';
import {DeviceLogin} from './device-login.ts';

const password='fixture-password-42';
async function fixture(t) {
  const directory=mkdtempSync(path.join(os.tmpdir(),'shiyan-web-avatar-'));
  const accounts=new AccountStore(directory,{registrationSocketPath:false});
  const phone=await accounts.register({email:'avatar@example.test',password});
  const other=await accounts.register({email:'other@example.test',password});
  const handler=createAccountHandler({store:accounts,registrationEmail:{check:()=>()=>{}}});
  const server=http.createServer(async(req,res)=>{if(!await handler(req,res)){res.writeHead(404);res.end();}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',()=>resolve()));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));accounts.close();rmSync(directory,{recursive:true,force:true});});
  async function call(route: string, body?: any, token?: string, platform: string = 'web') {
    const response=await fetch(`http://127.0.0.1:${(server.address() as any).port}/v1/auth/${route}`,{
      method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-Shiyan-Platform':platform,...(token?{Authorization:'Bearer '+token}:{})},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,value:(await response.json()) as any};
  }
  return {accounts,phone,other,call};
}

test('browser password login remembers a separate device and requires its own phone approval',async t=>{
  const {accounts,phone,other,call}=await fixture(t);
  const login=await call('login',{email:'avatar@example.test',password,role:'admin',serverAccess:true});
  assert.equal(login.status,200);assert.equal(login.value.user.role,'user');
  const pair=login.value.device;
  assert.equal(pair.userId,phone.user.id);assert.equal(accounts.authenticate(pair.secret),null);
  const creds={deviceId:pair.id,deviceSecret:pair.secret};
  const challenge=(await call('device/request',creds)).value;
  const input={...creds,id:challenge.id,pollSecret:challenge.pollSecret};
  assert.equal((await call('device/poll',input)).value.state,'pending');
  assert.equal((await call('device/requests',undefined,other.token)).value.requests.length,0);
  const inbox=(await call('device/requests',undefined,phone.token)).value.requests;
  assert.equal(inbox[0].device,'拾燕网页版');
  assert.equal((await call('device/approve',{id:challenge.id,approve:true},other.token)).status,404);
  assert.equal((await call('device/approve',{id:challenge.id,approve:true},phone.token)).status,200);
  const approved=await call('device/poll',input);
  assert.equal(approved.status,200);assert.equal(approved.value.user.id,phone.user.id);
  assert.equal(approved.value.user.role,'user');assert.equal(approved.value.user.serverAccess,false);
  assert.equal((await call('device/poll',input)).status,409);
});

test('browser QR pairing retains its browser label through later avatar sign-in',async t=>{
  const {phone,call}=await fixture(t);
  const qr=(await call('qr/create',{})).value;
  const scan={id:qr.id,scanSecret:new URL(qr.payload).searchParams.get('secret')};
  assert.equal((await call('qr/preview',scan,phone.token)).value.device,'拾燕网页版');
  await call('qr/approve',{...scan,approve:true},phone.token);
  const pair=(await call('qr/poll',{id:qr.id,pollSecret:qr.pollSecret})).value.device;
  const request=(await call('device/request',{deviceId:pair.id,deviceSecret:pair.secret})).value;
  assert.equal((await call('device/requests',undefined,phone.token)).value.requests.find(x=>x.id===request.id).device,'拾燕网页版');
});

test('web registration also remembers the new account without changing its permissions',async t=>{
  const {call}=await fixture(t);
  const result=await call('register',{email:'new-avatar@example.test',password,role:'admin'});
  assert.equal(result.status,201);assert.equal(result.value.device.userId,result.value.user.id);
  assert.equal(result.value.user.role,'user');assert.equal(result.value.user.serverAccess,false);
});

test('browser pairing does not evict desktop devices and keeps the legacy table compatible',async t=>{
  const {accounts,phone}=await fixture(t),devices=new DeviceLogin(accounts);
  const row=accounts.db.prepare('SELECT * FROM account_users WHERE id=?').get(phone.user.id);
  const desktop=devices.pair(row);
  for(let i=0;i<12;i++)devices.pair(row,{platform:'web'});
  assert.equal(devices.device({deviceId:desktop.id,deviceSecret:desktop.secret}).id,phone.user.id);
  assert.equal(accounts.db.prepare("SELECT count(*) AS n FROM account_login_device_context WHERE platform='web'").get()!.n,10);
  // Running older account workers can continue using their four-column inserts.
  accounts.db.prepare('INSERT INTO account_desktop_devices VALUES(?,?,?,?)').run(randomBytes(32).toString('base64url'),'old-secret-hash',phone.user.id,Date.now()+10000);
});
