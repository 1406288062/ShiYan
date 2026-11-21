import path from 'node:path';
import {readFile,writeFile,rename,unlink,mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {mailServers} from './mail-servers.ts';
const providers={github:{file:'github-events.json',fields:['enabled','repository','token'],public:['repository'],secret:['token']},'google-calendar':{file:'google-calendar.json',fields:['enabled','clientId','clientSecret','refreshToken','calendarId','accountKey'],public:['calendarId','accountKey'],secret:['clientSecret','refreshToken']},email:{file:'qq-mail.json',fields:['enabled','address','authorizationCode'],public:['address'],secret:['authorizationCode']},rss:{file:'rss-feeds.json',fields:['enabled','feeds'],public:['feeds'],secret:[]}};
const failure=(message: any)=>Object.assign(Error(message),{statusCode:400});
export function createOwnerSubscriptions({store,dataDir,appSubscriptions,mailSubscription,now=()=>Date.now()}: any){
 const config=async (provider: any)=>{let value;try{value=JSON.parse(await readFile(path.join(dataDir,(providers as any)[provider].file),'utf8'));}catch(error){if((error as any).code!=='ENOENT')throw failure('订阅配置暂时不可读取');return null;}return value;};
 const list=async()=>{const subscriptions: any[]=[];for(const [provider,spec]of Object.entries(providers)){const value=await config(provider);const health=appSubscriptions.health().find((h: any)=>h.provider===provider);subscriptions.push({provider,configured:Boolean(value),enabled:Boolean(value&&value.enabled!==false),status:!value?'waiting_configuration':value.enabled===false?'paused':provider==='email'?mailSubscription.status().state:health?.status||'pending',...Object.fromEntries(spec.public.filter(k=>value?.[k]!==undefined).map(k=>[k,value[k]])),credentialsConfigured:spec.secret.every(k=>Boolean(value?.[k])),lastSuccessAt:health?.last_success?health.last_success*1000:null});}return {ok:true,subscriptions,isolatedByOwner:true};};
 const update=async(provider: any,input: any)=>{
  const spec=(providers as any)[provider];if(!spec||!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!spec.fields.includes(k)))throw failure('订阅配置包含不支持的字段');
  if(input.enabled!==undefined&&typeof input.enabled!=='boolean')throw failure('订阅开关无效');
  for(const [key,value]of Object.entries(input))if(key==='feeds'){if(!Array.isArray(value)||value.length>20||value.some(v=>typeof v!=='string'||v.length>2000))throw failure('RSS 地址无效');}else if(key!=='enabled'&&(typeof value!=='string'||value.length>8192||/[\u0000-\u001f]/.test(value)))throw failure('订阅配置内容无效');
  const value={...(await config(provider)||{}),...input,enabled:input.enabled??true};
  if(value.enabled){
   if(provider==='github'&&!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repository||''))throw failure('请填写 GitHub 仓库，格式为 owner/repository');
   if(provider==='google-calendar'&&['clientId','clientSecret','refreshToken'].some(k=>!value[k]))throw failure('请完成自己的谷歌日历授权');
   if(provider==='email'){value.authorizationCode=String(value.authorizationCode||'').replace(/\s+/g,'');if(!mailServers(value.address)||!/^[A-Za-z0-9-]{8,64}$/.test(value.authorizationCode))throw failure('请填写支持的邮箱（QQ、Foxmail、163、126、Gmail、iCloud、139、新浪、搜狐、阿里云）和它的授权码 / 应用专用密码');}
   if(provider==='rss'){const feeds=[...new Set((Array.isArray(value.feeds)?value.feeds:[]).map((f: any)=>String(f||'').trim()).filter(Boolean))];if(!feeds.length||feeds.length>20||feeds.some(f=>!/^https?:\/\/[^\s]+$/i.test(String(f))))throw failure('请提供 1–20 个 RSS / Atom 地址');value.feeds=feeds;}
  }
  await mkdir(dataDir,{recursive:true,mode:0o700});const target=path.join(dataDir,spec.file),temporary=target+'.'+randomUUID()+'.tmp';
  try{await writeFile(temporary,JSON.stringify(value),{mode:0o600,flag:'wx'});await rename(temporary,target);}finally{await unlink(temporary).catch(()=>{});}
  store.db.prepare('DELETE FROM dots_app_health WHERE manager_id=? AND provider IN (?,?)').run(store.managerId,provider,provider==='github'?'github-summary':provider);
  if(provider==='email')await mailSubscription.reload();else void appSubscriptions.tick();
  return list();
 };
 const remove=async (provider: any)=>{if(!(providers as any)[provider])throw failure('订阅来源无效');await unlink(path.join(dataDir,(providers as any)[provider].file)).catch(error=>{if(error.code!=='ENOENT')throw error;});if(provider==='email')await mailSubscription.reload();return list();};
 return {list,update,remove};
}
