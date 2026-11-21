import {mailServers} from './mail-servers.ts';
import {open,watch} from 'node:fs';
import {promisify} from 'node:util';
import {constants} from 'node:fs';
import path from 'node:path';
import {createMailEventStore,mailAccountKey} from './qq-mail-events.ts';
const openFile=promisify(open);
export async function readMailConfig(file: any){
 let fd;
 try{fd=await openFile(file,constants.O_RDONLY|constants.O_NOFOLLOW);}catch(error){if((error as any).code==='ENOENT')return null;throw Error('mail_config_unreadable');}
 // Numeric fd API avoids following a swapped symlink after the permission check.
 const fs=await import('node:fs');
 try{
  const stat=await promisify(fs.fstat)(fd);
  if(!stat.isFile()||(stat.mode&0o077)!==0||stat.uid!==process.getuid!()||stat.size>16384)throw Error('mail_config_permissions');
  const raw=await new Promise<string>((resolve,reject)=>fs.readFile(fd,'utf8',(error,data)=>error?reject(error):resolve(data as string)));
  let value;try{value=JSON.parse(raw);}catch{throw Error('mail_config_invalid');}
  if(value.enabled===false)return null;
  if(value.enabled!==true||typeof value.address!=='string'||! /^[A-Za-z0-9._%+-]+@(?:qq\.com|vip\.qq\.com|foxmail\.com)$/i.test(value.address)||typeof value.authorizationCode!=='string'||! /^[A-Za-z0-9]{16,64}$/.test(value.authorizationCode))throw Error('mail_config_invalid');
  return {address:value.address.toLowerCase(),authorizationCode:value.authorizationCode};
 }finally{await promisify(fs.close)(fd);}
}
export interface QQMailSubscriptionOptions {
  store: any;
  configPath: string;
  clientFactory: (options: any) => any;
  prepareMail?: ((client: any, message: any, control: any) => Promise<any>) | null;
  loadConfig?: any;
  logger?: Console;
  setTimer?: any;
  clearTimer?: any;
}
export function createQQMailSubscription({store,configPath,clientFactory,prepareMail=null,loadConfig=readMailConfig,logger=console,setTimer=setTimeout,clearTimer=clearTimeout}: QQMailSubscriptionOptions){
 let stopped=false,started=false,client: any=null,retry: any=null,watchdog: any=null,watcher: any=null,reloadTimer: any=null,generation=0,failures=0,status='waiting_configuration';
 let config: any=null,events: any=null,syncOwner: any=null,pending=false,connectionAbort: AbortController | null=null;
 const publishStatus=(code: any)=>{status=code;logger.info?.('[qq-mail]',code);};
 const dispatch=(promise: any)=>{void promise.catch(()=>publishStatus('mail_subscription_failed'));};
 const clearRetry=()=>{if(retry)clearTimer(retry);retry=null;};
 function disconnect(){connectionAbort?.abort();connectionAbort=null;clearRetry();if(watchdog)clearTimer(watchdog);watchdog=null;const old=client;client=null;try{old?.close();}catch{}}
 async function synchronize(current: any,version: any){
  if(stopped||version!==generation||current!==client)return;
  pending=true;if(syncOwner?.version===version)return;const lock={current,version};syncOwner=lock;
  try{while(pending&&!stopped&&version===generation&&current===client){
   pending=false;
   const cursor=events.state();const validity=String(current.mailbox?.uidValidity||'');
   if(!cursor||cursor.uid_validity!==validity)throw Error('mail_uidvalidity_changed');
   const found=await current.search({uid:`${cursor.last_uid+1}:*`},{uid:true});
   const ids: number[]=[...new Set<number>((found||[]).map(Number).filter((uid: any)=>Number.isInteger(uid)&&uid>cursor.last_uid&&uid<=0xffffffff))].sort((a,b)=>a-b);
   const batch=ids.slice(0,50),selected=new Set(batch),mails: any[]=[];
   if(batch.length)for await(const mail of current.fetch(batch.join(','),{uid:true,envelope:true,internalDate:true,bodyStructure:true},{uid:true})){
    if(stopped||version!==generation||current!==client)return;
    if(!selected.has(Number(mail.uid)))continue;
    const input={...mail,uidValidity:validity};
    if(!events.needsContent(input)){events.receive(input);continue;}
    mails.push(mail);
   }
   // Body downloads must begin AFTER metadata FETCH drains; issuing a nested
   // IMAP command from inside its generator can deadlock the connection.
   for(const mail of mails){
    if(stopped||version!==generation||current!==client)return;
    const presentation=prepareMail?await prepareMail(current,mail,{signal:connectionAbort?.signal}):undefined;
    if(stopped||version!==generation||current!==client)return;
    events.receive({uid:mail.uid,uidValidity:validity,envelope:mail.envelope,internalDate:mail.internalDate,presentation});
   }
   let highest=batch.length?batch.at(-1):cursor.last_uid;
   if(ids.length>batch.length)pending=true;
   if(stopped||version!==generation||current!==client)return;
   // Commit the high-water mark only after the entire stream. Interrupted fetch
   // is replayed; per-UID receipts suppress already delivered notifications.
   events.completeSync({uidValidity:validity,lastUid:highest});
   failures=0;status='listening';
  }}catch(error){if(!stopped&&version===generation&&current===client){events?.status('reconnecting','sync_failed');try{current.close();}catch{};scheduleReconnect(version);}}
  finally{if(syncOwner===lock){syncOwner=null;if(pending&&!stopped&&client&&version===generation)dispatch(synchronize(client,version));}}
 }
 function scheduleReconnect(version: any){
  if(stopped||version!==generation||retry)return;
  const delay=Math.min(60_000,1000*2**Math.min(failures++,6));
  publishStatus('reconnecting');retry=setTimer(()=>{retry=null;dispatch(connect(version));},delay);retry?.unref?.();
 }
 async function connect(version: any){
  if(stopped||version!==generation||!config)return;
  disconnect();connectionAbort=new AbortController();let ready=false;const current=clientFactory({host:mailServers(config.address)?.imap||'imap.qq.com',port:993,secure:true,clientInfo:{name:'ShiYan',version:'1.0.0'},auth:{user:config.address,pass:config.authorizationCode},logger:false,emitLogs:false,disableAutoIdle:false,autoIdleDelay:1000,maxIdleTime:25*60_000,connectionTimeout:20_000,greetingTimeout:15_000,socketTimeout:35*60_000,tls:{rejectUnauthorized:true,minVersion:'TLSv1.2'}});client=current;
  current.on('error',()=>{});
  current.on('close',()=>{if(!stopped&&version===generation&&current===client){if(watchdog)clearTimer(watchdog);watchdog=null;scheduleReconnect(version);}});
  current.on('exists',()=>{if(ready&&current.mailbox)dispatch(synchronize(current,version));});
  current.on('mailboxClose',()=>{if(!stopped&&version===generation&&current===client){try{current.close();}catch{};scheduleReconnect(version);}});
  try{
   publishStatus('connecting');await current.connect();
   if(current.capabilities&&!current.capabilities.has('IDLE'))throw Error('idle_unsupported');
   if(stopped||version!==generation||current!==client){current.close();return;}
   const mailbox=await current.mailboxOpen('INBOX',{readOnly:true});
   if(stopped||version!==generation||current!==client){current.close();return;}
   events.baseline({uidValidity:mailbox.uidValidity,uidNext:mailbox.uidNext});ready=true;
   publishStatus('listening');await synchronize(current,version);
   const keepAlive=()=>{if(stopped||version!==generation||current!==client)return;watchdog=setTimer(async()=>{watchdog=null;if(stopped||version!==generation||current!==client)return;try{await current.noop();await synchronize(current,version);}catch{try{current.close();}catch{};scheduleReconnect(version);}finally{keepAlive();}},30_000);watchdog?.unref?.();};keepAlive();
  }catch(error){
   if(stopped||version!==generation||current!==client)return;
   if((error as any).authenticationFailed||(error as any).message==='idle_unsupported'){clearRetry();client=null;try{current.close();}catch{};const code=(error as any).authenticationFailed?'authentication_failed':'idle_unsupported';publishStatus(code);events?.status(code,code);}
   else{try{current.close();}catch{};scheduleReconnect(version);}
  }
 }
 async function reload(){
  const version=++generation;disconnect();pending=false;syncOwner=null;config=null;
  let next;try{next=await loadConfig(configPath);}catch(error){if(version===generation&&!stopped)publishStatus(['mail_config_permissions','mail_config_invalid','mail_config_unreadable'].includes((error as any).message)?(error as any).message:'mail_config_invalid');return;}
  if(stopped||version!==generation)return;
  if(!next){publishStatus('waiting_configuration');return;}
  config=next;events=createMailEventStore({store,accountKey:mailAccountKey(config.address)});failures=0;await connect(version);
 }
 return {start(){if(started||stopped)return;started=true;
  try{watcher=watch(path.dirname(configPath),(_event,file)=>{if(String(file)!==path.basename(configPath)||stopped)return;if(reloadTimer)clearTimer(reloadTimer);reloadTimer=setTimer(()=>{reloadTimer=null;dispatch(reload());},250);reloadTimer?.unref?.();});watcher.on('error',()=>publishStatus('configuration_watch_failed'));watcher.unref?.();}catch{publishStatus('configuration_watch_failed');}
  dispatch(reload());
 },reload,close(){stopped=true;generation++;disconnect();watcher?.close();if(reloadTimer)clearTimer(reloadTimer);config=null;status='closed';},status(){return {state:status,configured:Boolean(config)};}};
}
