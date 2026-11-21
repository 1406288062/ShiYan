// Trusted, single-process OAuth/MCP connector. Tokens never enter a member's
// workspace, model input, or browser. The Unix socket is not mounted in sandboxes.
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs/promises';
import {chmodSync, mkdirSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes, createHash, createHmac} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {getAccountStore} from './accounts.ts';

const ROOT=process.env.SHIYAN_ROOT || '/home/ubuntu/boss-codex-service/shiyan-v2';
export const SPONGE_SOCKET=process.env.SHIYAN_SPONGE_SOCKET || path.join(ROOT,'data/sponge/connector.sock');
export const SPONGE_SECRET_FILE=process.env.SHIYAN_SPONGE_SECRET_FILE || '/home/ubuntu/.config/shiyan/sponge-link.key';
const sha=value=>createHash('sha256').update(value).digest('hex');
const nonce=()=>randomBytes(32).toString('base64url');
const failure=(message,status=400)=>Object.assign(new Error(message),{status});
const aliasId=subject=>'shiyan_'+sha(subject);
function decodeMcp(result){
  if(result?.isError)throw failure('海绵宝宝暂时无法确认当前账号，请重新连接',401);
  if(result?.structuredContent?.accountId)return result.structuredContent;
  for(const item of result?.content || [])if(item.type==='text'){
    try { const value=JSON.parse(item.text);if(value?.accountId)return value; } catch {}
  }
  throw failure('海绵宝宝账号响应无效',502);
}

export class SpongeConnector {
  db: DatabaseSync;
  now: () => number;
  constructor({directory=path.join(ROOT,'data/sponge'),secret,issuer='https://mcp.yandot.ai',
    transportBase='http://127.0.0.1:4341',callback=issuer+'/shiyan/callback',accountStore,
    fetchImpl=fetch,now=Date.now}={}){
    if(!Buffer.isBuffer(secret)||secret.length!==32)throw new Error('Missing connector signing key.');
    const target=new URL(transportBase);
    if(!['127.0.0.1','[::1]','localhost'].includes(target.hostname)||target.protocol!=='http:'||target.username||target.password||target.search||target.hash)throw new Error('Connector transport must be fixed loopback HTTP.');
    const authority=new URL(issuer);
    if(authority.protocol!=='https:'||authority.username||authority.password||authority.search||authority.hash)throw new Error('Invalid connector issuer.');
    if(callback!==issuer+'/shiyan/callback')throw new Error('The registered callback must remain fixed.');
    Object.assign(this,{directory,secret,issuer,transportBase:transportBase.replace(/\/$/,''),callback,accountStore,fetchImpl,now});
    this.resource=issuer+'/mcp';this.refreshes=new Map();this.controllers=new Map();
    mkdirSync(directory,{recursive:true,mode:0o700});chmodSync(directory,0o700);
    const filename=path.join(directory,'connections.sqlite3');this.db=new DatabaseSync(filename);chmodSync(filename,0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS connections (owner TEXT PRIMARY KEY,subject TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,
        token_json TEXT,expires_at INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS flows (state_hash TEXT PRIMARY KEY,owner TEXT NOT NULL,subject TEXT NOT NULL,session_id TEXT NOT NULL,
        verifier TEXT NOT NULL,client_id TEXT NOT NULL,revision INTEGER NOT NULL,expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS flows_owner ON flows(owner);`);
  }
  accounts(){return this.accountStore || getAccountStore();}
  access(owner){
    const a=this.accounts().access(owner);
    if(a?.status!=='active'||typeof a.userId!=='string')throw failure('当前账号无法使用海绵宝宝，请重新登录',403);
    return a;
  }
  sessionActive(subject,sessionId){
    return !!this.accounts().db.prepare('SELECT id FROM account_sessions WHERE id=? AND user_id=? AND expires_at>?').get(sessionId,subject,this.now());
  }
  _row(owner){return this.db.prepare('SELECT * FROM connections WHERE owner=?').get(owner);}
  _current(owner,revision){
    const access=this.access(owner),row=this._row(owner);
    if(!row||row.subject!==access.userId||row.revision!==revision)throw failure('连接已变更，请重新连接海绵宝宝',409);
    return row;
  }
  _abort(owner){for(const c of this.controllers.get(owner)||[])c.abort();}
  async _request(route,body,{owner,token,signal,timeout=15000}={}){
    const controller=new AbortController();
    if(owner){if(!this.controllers.has(owner))this.controllers.set(owner,new Set());this.controllers.get(owner).add(controller);}
    const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)controller.abort();
    const timer=setTimeout(abort,timeout);timer.unref();
    try{
      const response=await this.fetchImpl(this.transportBase+route,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json',
        ...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body),redirect:'error',signal:controller.signal});
      const reader=response.body?.getReader();if(!reader)throw failure('海绵宝宝响应为空',502);
      const chunks=[];let bytes=0;
      try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>8*1024*1024)throw failure('海绵宝宝返回内容过大',502);chunks.push(Buffer.from(value));}}
      finally{await reader.cancel().catch(()=>{});}
      const text=Buffer.concat(chunks).toString('utf8');let value;
      try{value=JSON.parse(text);}catch{
        for(const line of text.split('\n'))if(line.startsWith('data:')){try{const next=JSON.parse(line.slice(5));if(next.id!==undefined)value=next;}catch{}}
      }
      if(!response.ok)throw failure(response.status===401?'海绵宝宝授权已失效，请重新连接':'海绵宝宝请求未完成',response.status===401?401:response.status===400?400:503);
      if(!value||typeof value!=='object')throw failure('海绵宝宝响应无效',502);
      return value;
    }catch(error){
      if(error.status)throw error;
      throw failure('海绵宝宝连接中断，执行结果可能尚未返回；请勿自动重复设备操作',503);
    }finally{
      clearTimeout(timer);signal?.removeEventListener('abort',abort);
      if(owner){const set=this.controllers.get(owner);set?.delete(controller);if(!set?.size)this.controllers.delete(owner);}
    }
  }
  async _mcp(token,method,params,options={}){
    const value=await this._request('/mcp',{jsonrpc:'2.0',id:1,method,params},{token,...options});
    if(value.error)throw failure('海绵宝宝工具请求未完成',502);
    if(!Object.hasOwn(value,'result'))throw failure('海绵宝宝工具响应无效',502);
    return value.result;
  }
  async _revoke(tokens,clientId){
    // An expired access token may already have been pruned by the relay while
    // its refresh grant remains valid. Revoke through the durable family token.
    const token=tokens?.refresh_token || tokens?.access_token;
    if(token&&clientId)await this._request('/oauth/revoke',{token,client_id:clientId},{timeout:4000}).catch(()=>{});
  }
  async _client(){
    if(this.clientPromise)return this.clientPromise;
    const task=(async()=>{
      const saved=this.db.prepare("SELECT value FROM settings WHERE name='client'").get();
      if(saved){
        const client=JSON.parse(saved.value);
        if(client.issuer!==this.issuer||client.redirectUri!==this.callback)throw failure('海绵宝宝连接配置已变更',503);
        // The relay prunes an unused DCR client after 24h. Re-register before
        // that boundary; grants already issued retain their own client_id.
        if(Number.isFinite(client.createdAt)&&client.createdAt<=this.now()&&this.now()-client.createdAt<20*3600000)return client;
      }
      const value=await this._request('/oauth/register',{client_name:'拾燕',redirect_uris:[this.callback],token_endpoint_auth_method:'none'});
      if(typeof value.client_id!=='string'||!value.client_id||!Array.isArray(value.redirect_uris)||!value.redirect_uris.includes(this.callback))throw failure('海绵宝宝授权服务响应无效',502);
      const client={clientId:value.client_id,issuer:this.issuer,redirectUri:this.callback,createdAt:this.now()};
      this.db.prepare("INSERT OR REPLACE INTO settings VALUES('client',?)").run(JSON.stringify(client));return client;
    })().finally(()=>{if(this.clientPromise===task)this.clientPromise=null;});
    this.clientPromise=task;return task;
  }
  _clear(owner){
    const row=this._row(owner);this._abort(owner);
    this.db.prepare('UPDATE connections SET revision=revision+1,token_json=NULL,expires_at=0,updated_at=? WHERE owner=?').run(this.now(),owner);
    this.db.prepare('DELETE FROM flows WHERE owner=?').run(owner);
    return row?.token_json?JSON.parse(row.token_json):null;
  }
  async start(auth){
    const a=this.access(auth?.owner);
    if(!auth.accountSession||auth.userId!==a.userId||!this.sessionActive(a.userId,auth.sessionId))throw failure('请先登录当前拾燕账号',401);
    const client=await this._client();this.access(auth.owner);
    if(!this.sessionActive(a.userId,auth.sessionId))throw failure('发起连接的登录已失效，请重新登录',401);
    this.db.prepare('INSERT OR IGNORE INTO connections(owner,subject,updated_at) VALUES(?,?,?)').run(auth.owner,a.userId,this.now());
    const old=this._clear(auth.owner),row=this._row(auth.owner),state=nonce(),verifier=nonce(),challenge=createHash('sha256').update(verifier).digest('base64url');
    this.db.prepare('DELETE FROM flows WHERE expires_at<=?').run(this.now());
    this.db.prepare('INSERT INTO flows VALUES(?,?,?,?,?,?,?,?)').run(sha(state),auth.owner,a.userId,auth.sessionId,verifier,client.clientId,row.revision,this.now()+5*60000);
    const payload={v:1,subject:a.userId,clientId:client.clientId,redirectUri:this.callback,stateHash:sha(state),challenge,expiresAt:this.now()+5*60000,nonce:nonce()};
    const encoded=Buffer.from(JSON.stringify(payload)).toString('base64url');
    const ticket=encoded+'.'+createHmac('sha256',this.secret).update(encoded).digest('base64url');
    const params=new URLSearchParams({client_id:client.clientId,redirect_uri:this.callback,response_type:'code',resource:this.resource,scope:'mcp:tools offline_access',
      code_challenge_method:'S256',code_challenge:challenge,state,shiyan_ticket:ticket});
    if(old)await this._revoke(old,old.client_id);
    this._current(auth.owner,row.revision);
    if(!this.sessionActive(a.userId,auth.sessionId))throw failure('发起连接的登录已失效，请重新登录',401);
    return {ok:true,authorizeUrl:this.issuer+'/oauth/authorize?'+params};
  }
  async complete({state,code,iss,error}={}){
    if(typeof state!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(state))throw failure('连接请求无效或已过期',400);
    const flow=this.db.prepare('SELECT * FROM flows WHERE state_hash=?').get(sha(state));
    if(!flow)throw failure('连接请求无效或已处理，请回到拾燕重新连接',400);
    // Consume before any async operation: neither duplicate callbacks nor a
    // subsequent disconnect can write an old credential back into this owner.
    this.db.prepare('DELETE FROM flows WHERE state_hash=?').run(sha(state));
    if(error)throw failure('已取消连接海绵宝宝',400);
    if(flow.expires_at<=this.now()||iss!==this.issuer||!this.sessionActive(flow.subject,flow.session_id))throw failure('连接请求已失效，请从拾燕重新连接',400);
    const current=this._current(flow.owner,flow.revision);
    if(current.subject!==flow.subject||typeof code!=='string'||code.length>512||!code)throw failure('连接账号不匹配',403);
    let tokens;
    try{
      tokens=await this._request('/oauth/token',{grant_type:'authorization_code',client_id:flow.client_id,code,code_verifier:flow.verifier,redirect_uri:this.callback,resource:this.resource},{owner:flow.owner});
      this._validTokens(tokens);
      const identity=decodeMcp(await this._mcp(tokens.access_token,'tools/call',{name:'who_am_i',arguments:{}},{owner:flow.owner}));
      if(identity.accountId!==aliasId(flow.subject))throw failure('请使用发起连接的拾燕账号登录海绵宝宝，独立注册账号无法关联',403);
      this._current(flow.owner,flow.revision);
      if(!this.sessionActive(flow.subject,flow.session_id))throw failure('发起连接的登录已失效，请重新连接',401);
      const stored={access_token:tokens.access_token,refresh_token:tokens.refresh_token,client_id:flow.client_id};
      const changed=this.db.prepare('UPDATE connections SET token_json=?,expires_at=?,updated_at=? WHERE owner=? AND revision=?').run(JSON.stringify(stored),this.now()+tokens.expires_in*1000,this.now(),flow.owner,flow.revision);
      if(changed.changes!==1)throw failure('连接已取消，请重新发起',409);
      return {ok:true,connected:true};
    }catch(cause){if(tokens)await this._revoke(tokens,flow.client_id);throw cause;}
  }
  _validTokens(tokens){
    if(typeof tokens?.access_token!=='string'||tokens.access_token.length>4096||!tokens.access_token||typeof tokens.refresh_token!=='string'||!tokens.refresh_token||tokens.refresh_token.length>4096||tokens.token_type?.toLowerCase()!=='bearer'||!Number.isFinite(tokens.expires_in)||tokens.expires_in<=0||tokens.expires_in>86400)throw failure('海绵宝宝授权响应无效',502);
  }
  async _token(owner){
    const a=this.access(owner),row=this._row(owner);
    if(!row?.token_json||row.subject!==a.userId)throw failure('请先在拾燕设置中连接海绵宝宝，并使用当前拾燕账号登录',409);
    if(row.expires_at>this.now()+30000)return {row,tokens:JSON.parse(row.token_json)};
    if(this.refreshes.has(owner))return this.refreshes.get(owner);
    const task=(async()=>{
      const old=JSON.parse(row.token_json);let tokens;
      try{
        tokens=await this._request('/oauth/token',{grant_type:'refresh_token',client_id:old.client_id,refresh_token:old.refresh_token,resource:this.resource},{owner});
        this._validTokens(tokens);this._current(owner,row.revision);
        const identity=decodeMcp(await this._mcp(tokens.access_token,'tools/call',{name:'who_am_i',arguments:{}},{owner}));
        if(identity.accountId!==aliasId(a.userId))throw failure('海绵宝宝账号不匹配，请重新连接',403);
        this._current(owner,row.revision);const next={access_token:tokens.access_token,refresh_token:tokens.refresh_token,client_id:old.client_id};
        const updated=this.db.prepare('UPDATE connections SET token_json=?,expires_at=?,updated_at=? WHERE owner=? AND revision=? AND token_json IS NOT NULL').run(JSON.stringify(next),this.now()+tokens.expires_in*1000,this.now(),owner,row.revision);
        if(updated.changes!==1)throw failure('连接已取消',409);
        return {row:this._row(owner),tokens:next};
      }catch(cause){
        if(tokens)await this._revoke(tokens,old.client_id);
        // A failed response can follow a successful refresh rotation. Never
        // retry the stored old refresh token: reuse revokes the whole family.
        if(this._row(owner)?.revision===row.revision)this._clear(owner);
        throw cause;
      }
    })().finally(()=>{if(this.refreshes.get(owner)===task)this.refreshes.delete(owner);});
    this.refreshes.set(owner,task);return task;
  }
  async rpc(owner,method,params={},signal){
    if(!['tools/list','tools/call'].includes(method))throw failure('不支持的海绵宝宝请求');
    if(method==='tools/call'&&(typeof params?.name!=='string'||!params.name||params.name.length>200||!params.arguments||typeof params.arguments!=='object'||Array.isArray(params.arguments)))throw failure('工具请求无效');
    const {row,tokens}=await this._token(owner);
    try{
      const identity=decodeMcp(await this._mcp(tokens.access_token,'tools/call',{name:'who_am_i',arguments:{}},{owner,signal}));
      if(identity.accountId!==aliasId(row.subject))throw failure('海绵宝宝账号不匹配，请重新连接',403);
      this._current(owner,row.revision);
      const result=await this._mcp(tokens.access_token,method,params,{owner,signal,timeout:60000});
      this._current(owner,row.revision);return {ok:true,result};
    }catch(error){
      if([401,403].includes(error.status)&&this._row(owner)?.revision===row.revision)this._clear(owner);
      throw error; // No replay of device operations after a network failure.
    }
  }
  async status(owner){
    const access=this.access(owner),row=this._row(owner);
    if(!row?.token_json||row.subject!==access.userId)return {ok:true,connected:false,devices:[],needsPairing:false};
    try{
      const {tokens}=await this._token(owner);
      const identity=decodeMcp(await this._mcp(tokens.access_token,'tools/call',{name:'who_am_i',arguments:{}},{owner}));
      if(identity.accountId!==aliasId(access.userId))throw failure('海绵宝宝账号不匹配，请重新连接',403);
      this._current(owner,row.revision);
      const devices=(Array.isArray(identity.devices)?identity.devices:[]).filter(d=>d&&!d.revokedAt&&d.status!=='revoked').map(d=>({deviceId:d.deviceId,name:d.name,platform:d.platform,online:d.online===true,ready:d.ready===true,status:d.status}));
      return {ok:true,connected:true,devices,needsPairing:devices.length===0};
    }catch(error){
      if([400,401,403,409].includes(error.status)){
        if(this._row(owner)?.revision===row.revision)this._clear(owner);
        return {ok:true,connected:false,devices:[],needsPairing:false};
      }
      throw error;
    }
  }
  async disconnect(owner){
    this.access(owner);const tokens=this._clear(owner);
    if(tokens)await this._revoke(tokens,tokens.client_id);
    return {ok:true,connected:false,devices:[],needsPairing:false};
  }
  close(){for(const owner of this.controllers.keys())this._abort(owner);this.db.close();}
}

export function createSpongeServer(connector){
  return http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json; charset=utf-8');
    try{
      if(req.method!=='POST'||!['/start','/status','/disconnect','/rpc','/complete'].includes(req.url))throw failure('接口不存在',404);
      const chunks=[];let bytes=0;for await(const c of req){bytes+=c.length;if(bytes>1024*1024)throw failure('请求过大',413);chunks.push(c);}
      let value;try{value=JSON.parse(Buffer.concat(chunks).toString());}catch{throw failure('请求格式无效');}
      if(!value||typeof value!=='object'||Array.isArray(value))throw failure('请求格式无效');
      const controller=new AbortController();res.on('close',()=>{if(!res.writableEnded)controller.abort();});
      const result=req.url==='/start'?await connector.start(value.auth):req.url==='/status'?await connector.status(value.owner):
        req.url==='/disconnect'?await connector.disconnect(value.owner):req.url==='/complete'?await connector.complete(value):await connector.rpc(value.owner,value.method,value.params,controller.signal);
      const response=['/start','/disconnect'].includes(req.url)?{ok:true,result}:result;
      res.writeHead(200);res.end(JSON.stringify(response));
    }catch(error){res.writeHead(error.status||503);res.end(JSON.stringify({ok:false,error:error.status?error.message:'海绵宝宝连接服务暂时不可用'}));}
  });
}

// A second broker must never unlink the first broker's live entry point.
// The service also holds a process lock across this probe/bind boundary.
export async function prepareSpongeSocket(socketPath,{timeoutMs=500}={}){
  let before;try{before=await fs.lstat(socketPath);}catch(error){if(error.code==='ENOENT')return;throw error;}
  if(!before.isSocket())throw new Error('Refusing to replace a non-socket path.');
  await new Promise((resolve,reject)=>{
    const socket=net.createConnection({path:socketPath});let finished=false;
    const finish=error=>{if(finished)return;finished=true;clearTimeout(timer);socket.destroy();error?reject(error):resolve();};
    const timer=setTimeout(()=>finish(new Error('Cannot confirm socket is stale; refusing to replace it.')),timeoutMs);
    socket.once('connect',()=>finish(new Error('A Sponge connector is already listening on this socket.')));
    socket.once('error',error=>finish(error.code==='ECONNREFUSED'?null:error));
  });
  const current=await fs.lstat(socketPath);
  if(!current.isSocket()||current.dev!==before.dev||current.ino!==before.ino)throw new Error('Socket changed during startup; refusing to replace it.');
  await fs.unlink(socketPath);
}

export async function removeOwnedSpongeSocket(socketPath,owned){
  let current;try{current=await fs.lstat(socketPath);}catch(error){if(error.code==='ENOENT')return false;throw error;}
  if(!owned||!current.isSocket()||current.dev!==owned.dev||current.ino!==owned.ino)return false;
  await fs.unlink(socketPath);return true;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  process.umask(0o077);
  await fs.mkdir(path.dirname(SPONGE_SECRET_FILE),{recursive:true,mode:0o700});
  let secret;try{secret=await fs.readFile(SPONGE_SECRET_FILE);}catch(e){if(e.code!=='ENOENT')throw e;secret=randomBytes(32);await fs.writeFile(SPONGE_SECRET_FILE,secret,{flag:'wx',mode:0o600});}
  await fs.chmod(SPONGE_SECRET_FILE,0o600);
  const connector=new SpongeConnector({secret}),server=createSpongeServer(connector);
  await prepareSpongeSocket(SPONGE_SOCKET);
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(SPONGE_SOCKET,resolve);});await fs.chmod(SPONGE_SOCKET,0o600);
  const ownedSocket=await fs.lstat(SPONGE_SOCKET);
  console.log('ShiYan per-account Sponge connector ready');
  let stopping=false;const stop=()=>{if(stopping)return;stopping=true;server.close(()=>{connector.close();void removeOwnedSpongeSocket(SPONGE_SOCKET,ownedSocket).catch(()=>{});});};
  process.on('SIGTERM',stop);process.on('SIGINT',stop);
}
