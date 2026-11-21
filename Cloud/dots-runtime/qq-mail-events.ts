import {mailPresentationParts,isAdvertisingMail} from './qq-mail-content.ts';
import {createHash} from 'node:crypto';
const clean=(value,limit)=>String(value??'').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,' ').replace(/\s+/g,' ').trim().slice(0,limit);
const literal=(value,limit)=>clean(value,limit).replace(/[\\`*_{}\[\]()<>!|]/g,'\\$&');
export const mailAccountKey=address=>createHash('sha256').update(address.trim().toLowerCase()).digest('hex');
const uidNumber=value=>{const n=Number(value);if(!Number.isInteger(n)||n<1||n>0xffffffff)throw Error('invalid_mail_uid');return n;};
export function createMailEventStore({store,accountKey,now=()=>Math.floor(Date.now()/1000)}){
 const {db,managerId}=store;
 db.exec(`CREATE TABLE IF NOT EXISTS dots_mail_accounts(manager_id TEXT NOT NULL,account_key TEXT NOT NULL,uid_validity TEXT NOT NULL,last_uid INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'ready',last_error TEXT NOT NULL DEFAULT '',updated_at INTEGER NOT NULL,PRIMARY KEY(manager_id,account_key));
 CREATE TABLE IF NOT EXISTS dots_mail_events(id TEXT PRIMARY KEY,manager_id TEXT NOT NULL,account_key TEXT NOT NULL,uid_validity TEXT NOT NULL,uid INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'pending',message_id INTEGER,created_at INTEGER NOT NULL,UNIQUE(manager_id,account_key,uid_validity,uid));`);
 db.exec('CREATE TABLE IF NOT EXISTS dots_mail_repeats(manager_id TEXT NOT NULL,repeat_key TEXT NOT NULL,last_at INTEGER NOT NULL,PRIMARY KEY(manager_id,repeat_key))');
 if(!db.prepare('PRAGMA table_info(dots_mail_accounts)').all().some(row=>row.name==='activated_at')){db.exec('ALTER TABLE dots_mail_accounts ADD COLUMN activated_at INTEGER NOT NULL DEFAULT 0');db.prepare('UPDATE dots_mail_accounts SET activated_at=updated_at WHERE activated_at=0').run();}
 const state=()=>db.prepare('SELECT * FROM dots_mail_accounts WHERE manager_id=? AND account_key=?').get(managerId,accountKey);
 const baseline=({uidValidity,uidNext})=>store.transaction(()=>{
  const validity=String(uidValidity);if(!/^\d{1,20}$/.test(validity)||BigInt(validity)<1n)throw Error('invalid_mail_uid_validity');
  const cursor=uidNumber(uidNext)-1,prior=state();
  if(!prior||prior.uid_validity!==validity){db.prepare("INSERT INTO dots_mail_accounts(manager_id,account_key,uid_validity,last_uid,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(manager_id,account_key) DO UPDATE SET uid_validity=excluded.uid_validity,last_uid=excluded.last_uid,status='ready',last_error='',updated_at=excluded.updated_at").run(managerId,accountKey,validity,cursor,now());db.prepare('UPDATE dots_mail_accounts SET activated_at=? WHERE manager_id=? AND account_key=?').run(prior?.activated_at||now(),managerId,accountKey);return {initialized:true,...state()};}
  return {initialized:false,...prior};
 });
 function receive({uid,uidValidity,envelope,internalDate,presentation}){
  uid=uidNumber(uid);const validity=String(uidValidity),prior=state();
  if(!prior||prior.uid_validity!==validity)throw Error('stale_mail_epoch');
  if(uid<=prior.last_uid)return null;
  const id=createHash('sha256').update(JSON.stringify([managerId,accountKey,validity,uid])).digest('hex');
  return store.transaction(()=>{
   const current=state();if(current?.uid_validity!==validity)throw Error('stale_mail_epoch');
   const existing=db.prepare('SELECT message_id,state FROM dots_mail_events WHERE id=? AND manager_id=?').get(id,managerId);if(existing?.message_id||['ignored_history','ignored_advertisement','ignored_unimportant','ignored_duplicate'].includes(existing?.state))return null;
   db.prepare('INSERT OR IGNORE INTO dots_mail_events(id,manager_id,account_key,uid_validity,uid,created_at) VALUES(?,?,?,?,?,?)').run(id,managerId,accountKey,validity,uid,now());
   const actualDate=internalDate instanceof Date?internalDate:new Date(internalDate);
   if(Number.isFinite(actualDate.getTime())&&actualDate.getTime()<current.activated_at*1000-60_000){db.prepare("UPDATE dots_mail_events SET state='ignored_history' WHERE id=? AND manager_id=?").run(id,managerId);return null;}
   if(presentation?.kind==='ignored_advertisement'||isAdvertisingMail({subject:envelope?.subject,text:presentation?.text})){db.prepare("UPDATE dots_mail_events SET state='ignored_advertisement' WHERE id=? AND manager_id=?").run(id,managerId);return null;}
   if(presentation?.kind==='ignored_unimportant'){db.prepare("UPDATE dots_mail_events SET state='ignored_unimportant' WHERE id=? AND manager_id=?").run(id,managerId);return null;}
   const from=envelope?.from?.slice(0,3).map(item=>[item.name,item.address].filter(Boolean).map(v=>literal(v,160)).join(' · ')).join('；')||'未知发件人';
   const subject=literal(envelope?.subject||'（无主题）',320);
   // 同一发件人、同一主题的通知（比如反复的登录提醒）12 小时内只提醒一次。
   const repeatKey=createHash('sha256').update(JSON.stringify([String(envelope?.from?.[0]?.address||'').toLowerCase(),clean(envelope?.subject,320).replace(/\d{1,4}([-/:.]\d{1,4})+/g,'#')])).digest('hex');
   // 验证码、登录链接这类邮件每封都有用，不做重复合并。
   const codeMail=/验证码|校验码|动态密码|登录代码|登录链接|verification code|one.time (?:code|password)|login code|sign.in code|secure link|magic link|passkey|\b\d{4,8}\b.{0,20}(?:是|为|is)/i.test(String(envelope?.subject||'')+' '+String(presentation?.text||'').slice(0,400));
   const repeated=codeMail?null:db.prepare('SELECT last_at FROM dots_mail_repeats WHERE manager_id=? AND repeat_key=?').get(managerId,repeatKey);
   if(repeated&&now()-repeated.last_at<12*3600){db.prepare("UPDATE dots_mail_events SET state='ignored_duplicate' WHERE id=? AND manager_id=?").run(id,managerId);return null;}
   if(!codeMail)db.prepare('INSERT INTO dots_mail_repeats(manager_id,repeat_key,last_at) VALUES(?,?,?) ON CONFLICT(manager_id,repeat_key) DO UPDATE SET last_at=excluded.last_at').run(managerId,repeatKey,now());
   const date=internalDate instanceof Date?internalDate:new Date(internalDate);
   const received=Number.isFinite(date.getTime())?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(date):'时间未知';
   const parts=mailPresentationParts(presentation);
   let message;
   for(const [index,body]of parts.entries()){
    const content=`收到一封 QQ 邮件${parts.length>1?'（'+(index+1)+'/'+parts.length+'）':''}\n\n发件人：${from}\n主题：${subject}\n收件时间：${received}\n\n${body}`;
    const published=store.publishMail({eventId:id,content});
    message ||= published;
   }
   db.prepare("UPDATE dots_mail_events SET state='sent',message_id=? WHERE id=? AND manager_id=?").run(message.id,id,managerId);
   return message;
  });
 }
 const needsContent=({uid,uidValidity,internalDate})=>{
  const prior=state();if(!prior||prior.uid_validity!==String(uidValidity)||Number(uid)<=prior.last_uid)return false;
  const date=internalDate instanceof Date?internalDate:new Date(internalDate);
  if(Number.isFinite(date.getTime())&&date.getTime()<prior.activated_at*1000-60_000)return false;
  return !db.prepare('SELECT 1 FROM dots_mail_events WHERE manager_id=? AND account_key=? AND uid_validity=? AND uid=? AND (message_id IS NOT NULL OR state IN (?, ?, ?, ?))').get(managerId,accountKey,String(uidValidity),Number(uid),'ignored_history','ignored_advertisement','ignored_unimportant','ignored_duplicate');
 };
 const completeSync=({uidValidity,lastUid})=>store.transaction(()=>{
  const prior=state();if(prior?.uid_validity!==String(uidValidity))throw Error('stale_mail_epoch');
  if(!Number.isInteger(lastUid)||lastUid<0||lastUid>0xffffffff)throw Error('invalid_mail_uid');
  db.prepare("UPDATE dots_mail_accounts SET last_uid=MAX(last_uid,?),status='listening',last_error='',updated_at=? WHERE manager_id=? AND account_key=?").run(lastUid,now(),managerId,accountKey);
 });
 return {state,baseline,receive,needsContent,completeSync,status(code,error=''){db.prepare('UPDATE dots_mail_accounts SET status=?,last_error=?,updated_at=? WHERE manager_id=? AND account_key=?').run(clean(code,40),clean(error,40),now(),managerId,accountKey);}};
}
