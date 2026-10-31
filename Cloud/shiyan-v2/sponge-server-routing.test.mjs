import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {once} from 'node:events';
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
const close=server=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);});

test('runtime mounts Sponge only after real account authentication and keeps owner/session identity server-derived',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'shiyan-sponge-routes-'));
 process.env.SHIYAN_ROOT=root;process.env.SHIYAN_NO_LISTEN='1';process.env.SHIYAN_MEMBER_ONLY='1';
 process.env.SHIYAN_STATE_FILE=path.join(root,'data','member-state.json');
 process.env.SHIYAN_SPONGE_SOCKET=path.join(root,'connector.sock');
 process.env.DOTS_REGISTRATION_SOCKET=path.join(root,'unused-registration.sock');
 const calls=[];
 const connector=http.createServer(async(req,res)=>{
  const chunks=[];for await(const part of req)chunks.push(part);const input=JSON.parse(Buffer.concat(chunks).toString()||'{}');calls.push({route:req.url,input});
  const value=req.url==='/status'?{ok:true,connected:true,devices:[{id:input.owner+'-device',online:true,credential:'private'}],accessToken:'never-return-this'}:
   {ok:true,result:req.url==='/start'?{authorizeUrl:'https://mcp.yandot.ai/oauth/authorize?test=fixture'}:{}};
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(value));
 });
 connector.listen(process.env.SHIYAN_SPONGE_SOCKET);await once(connector,'listening');
 const {getAccountStore,PRIVATE_OWNER}=await import('./accounts.mjs');
 const store=getAccountStore();
 const admin=await store.register({username:'route_admin',password:'route-password'},{bootstrap:true,trustedOwner:PRIVATE_OWNER});
 const member=await store.register({username:'route_member',password:'route-password'});
 const other=await store.register({username:'route_other',password:'route-password'});
 const {createServer}=await import('./server.mjs');const runtime=createServer();const base='http://127.0.0.1:'+await listen(runtime);
 t.after(async()=>{await Promise.all([close(runtime),close(connector)]);store.close();await rm(root,{recursive:true,force:true});});
 const request=(route,token,{method='GET',body}={})=>fetch(base+route,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body===undefined?{}:{'Content-Type':'application/json'}),'x-shiyan-owner':'spoofed-admin','x-dots-owner':'spoofed-admin'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 for(const prefix of ['/v1','/shiyan/v1']){
  const before=calls.length;
  for(const token of [undefined,'invalid-session'])assert.equal((await request(prefix+'/integrations/sponge/status',token)).status,401);
  assert.equal(calls.length,before,'unauthenticated HTTP requests never reach the connector');
  for(const entry of [admin,member,other]){
   const status=await request(prefix+'/integrations/sponge/status',entry.token);assert.equal(status.status,200);
   const payload=await status.json();assert.equal(payload.connected,true);assert.equal(payload.devices[0].id,entry.user.owner+'-device');
   assert.equal(payload.devices[0].credential,undefined);assert.equal(payload.accessToken,undefined);
  }
  let result=await request(prefix+'/integrations/sponge/start',member.token,{method:'POST',body:{}});assert.equal(result.status,200);assert.ok((await result.json()).authorizeUrl);
  const submitted=calls.at(-1).input.auth,expected=store.authenticate(member.token);assert.equal(submitted.owner,expected.owner);assert.equal(submitted.userId,expected.userId);assert.equal(submitted.sessionId,expected.sessionId);
  assert.equal(submitted.token,undefined);assert.notEqual(submitted.owner,'spoofed-admin');
  const beforeSpoof=calls.length;
  result=await request(prefix+'/integrations/sponge/start',member.token,{method:'POST',body:{owner:other.user.owner,token:'forged',url:'https://evil.test'}});assert.equal(result.status,400);assert.equal(calls.length,beforeSpoof);
  result=await request(prefix+'/integrations/sponge/disconnect',member.token,{method:'POST',body:{}});assert.equal(result.status,200);assert.deepEqual(await result.json(),{ok:true,connected:false,devices:[],needsPairing:false});assert.equal(calls.at(-1).input.owner,member.user.owner);
  assert.equal((await request(prefix+'/integrations/sponge/status',member.token,{method:'POST',body:{}})).status,405);
  assert.equal((await request(prefix+'/integrations/sponge/unknown',member.token)).status,404);
 }
 const beforeRevoke=calls.length;store.logout(member.token);
 assert.equal((await request('/v1/integrations/sponge/status',member.token)).status,401);assert.equal(calls.length,beforeRevoke);
 assert.equal((await request('/v1/health',admin.token)).status,200,'existing authenticated routes remain usable');
});
