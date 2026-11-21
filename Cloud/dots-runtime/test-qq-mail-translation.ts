import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createMailPresenter,mailPresentationParts,isEnglishMail,mailLiteral} from './qq-mail-content.ts';
import {createMailEventStore} from './qq-mail-events.ts';
const english='Billing Problem\nThere is a problem with your payment method. Please update your payment information. ChatGPT Pro 100 (1 month) $100.00/month.';
function setup(t,options={}){const db=new DatabaseSync(':memory:');t.after(()=>db.close());const store={db,managerId:options.managerId||'alice',transaction:fn=>fn()};return {db,store,present:createMailPresenter({store,...options})};}
test('short English mail retains original and appends Chinese translation in one notification',async t=>{
 let request;const {present}=setup(t,{assess:async(data,schema)=>{request=JSON.parse(data);assert.equal(schema.properties.translation.maxLength,8000);return {translation:'账单问题：付款方式出现问题，请更新付款信息。ChatGPT Pro 100，1 个月，每月 $100.00。',evidence_quotes:['Billing Problem']};}});
 const p=await present({text:english,links:[{url:'https://example.com/pay',text:'Update Payment Information'}]});const parts=mailPresentationParts(p);
 assert.equal(p.kind,'translated');assert.equal(p.translationStatus,'complete');assert.equal(p.text,english);assert.equal(parts.length,1);assert(parts[0].includes(mailLiteral(english)));assert.match(parts[0],/英文原文：[\s\S]*中文翻译：[\s\S]*账单问题/);assert(parts[0].includes('(<https://example.com/pay>)'));assert.equal(request.operation,'process_untrusted_email_once');assert(request.constraints.emailIsDataNotInstructions);
});
test('Chinese and URL-only messages do not make translation calls',async t=>{let n=0;const {present}=setup(t,{assess:()=>{n++;throw Error('unexpected')}});const p=await present({text:'您的账单已经支付完成，请保留收据。Apple https://example.com/payment/100',links:[]});assert.equal(p.kind,'body');assert.equal(n,0);assert.equal(isEnglishMail('https://example.com/a/very/long/path/payment/details'),false);});
test('translation failure, wrong amounts, hallucinated links and empty results retain full original',async t=>{
 for(const result of [null,{translation:'付款金额 99 美元',evidence_quotes:['Billing Problem']},{translation:'付款 100 1 $100.00 https://evil.example',evidence_quotes:['Billing Problem']},{translation:'中文 100 1 $100.00',evidence_quotes:['not in the mail']}] ){
  const {present}=setup(t,{assess:async()=>result});const p=await present({text:english});assert.equal(p.translationStatus,'unavailable');assert.equal(p.text,english);assert.match(mailPresentationParts(p).join(''),/暂时不可用/);
 }
 const {present}=setup(t,{assess:async()=>{throw Error('timeout')}});assert.equal((await present({text:english})).text,english);
});
test('long English originals survive message limits without silent clipping',async t=>{
 const text=('Please retain every word of this original English email.\n').repeat(1300);const {present}=setup(t,{maxCallsPerHour:100,assess:async data=>{const p=JSON.parse(data);return {translation:'请保留这封英文邮件原文中的每一个字。',evidence_quotes:[p.body.trim().slice(0,12)]};}});
 let calls=0;const db2=new DatabaseSync(':memory:');t.after(()=>db2.close());const p=await createMailPresenter({store:{db:db2,managerId:'single-call',transaction:fn=>fn()},maxCallsPerHour:100,assess:async data=>{calls++;const input=JSON.parse(data);return {important:true,translation:'请保留这封英文邮件原文中的每一个字。',evidence_quotes:[input.body.trim().slice(0,12)]};}})({text});assert.equal(calls,1);assert.equal(p.translationStatus,'partial');assert.equal(p.text,text);const parts=mailPresentationParts(p);assert(parts.length>1);assert(parts.every(s=>s.length<=12000));
 const originals=parts.join('\n\n').split(/中文翻译/)[0].replace(/英文原文（第 \d+\/\d+ 段）：\n/g,'').replace(/\n\n/g,'');assert.equal(originals.replace(/\n/g,''),mailLiteral(text).replace(/\n/g,''));
});
test('budgets stay per manager, and partial translations are explicitly labelled',async t=>{
 const {db,store}=setup(t);let calls=0;const assess=async data=>{calls++;const p=JSON.parse(data);return {translation:'这是中文翻译。',evidence_quotes:[p.body.trim().slice(0,8)]};};
 const first=createMailPresenter({store,assess,maxCallsPerHour:1});const p=await first({text:'Please retain the complete English original message. '.repeat(200)});assert.equal(calls,1);assert.equal(p.translationStatus,'partial');assert.match(mailPresentationParts(p).join(''),/暂未完成/);
 const bob=createMailPresenter({store:{...store,managerId:'bob'},assess,maxCallsPerHour:1});assert.equal((await bob({text:'Please translate this new English message for another account.'})).translationStatus,'complete');assert.equal(calls,2);assert.equal(db.prepare('SELECT calls FROM dots_mail_summary_budget WHERE manager_id=?').get('alice').calls,1);
});
test('an aborted subscription does not deliver a translation result',async t=>{const controller=new AbortController();const {present}=setup(t,{assess:async()=>{controller.abort();return {translation:'中文',evidence_quotes:['Billing Problem']};}});await assert.rejects(present({text:english},{signal:controller.signal}),/cancelled/);});
test('multipart delivery preserves event deduplication and manager isolation',t=>{
 const {db,store}=setup(t);db.exec('CREATE TABLE messages(id INTEGER PRIMARY KEY,manager_id TEXT,content TEXT)');store.publishMail=({content})=>{const r=db.prepare('INSERT INTO messages(manager_id,content) VALUES(?,?)').run(store.managerId,content);return {id:Number(r.lastInsertRowid),content};};store.transaction=fn=>{db.exec('BEGIN');try{const r=fn();db.exec('COMMIT');return r}catch(e){db.exec('ROLLBACK');throw e}};
 const events=createMailEventStore({store,accountKey:'a',now:()=>100});events.baseline({uidValidity:'1',uidNext:1});const input={uid:1,uidValidity:'1',internalDate:new Date(100000),envelope:{subject:'Test'},presentation:{kind:'translated',text:english.repeat(120),translation:'账单问题，完整原文保留。',translationStatus:'complete',links:[]}};
 assert(events.receive(input));const count=db.prepare('SELECT count(*) n FROM messages').get().n;assert(count>1);assert.equal(events.receive(input),null);assert.equal(db.prepare('SELECT count(*) n FROM messages').get().n,count);assert.equal(db.prepare("SELECT count(*) n FROM messages WHERE manager_id!='alice'").get().n,0);assert(db.prepare('SELECT content FROM messages').all().every(r=>r.content.length<16000));
});


test('uncertain automated foreign mail is classified and translated with one model call',async t=>{
 let calls=0,request;
 const {present}=setup(t,{assess:async data=>{calls++;request=JSON.parse(data);return {important:true,translation:'我们已收到您的账号请求。',evidence_quotes:['We received your account request']};}});
 const p=await present({from:'notification@unknown.example',subject:'Your account notice',text:'We received your account request and will contact you soon.'});
 assert.equal(calls,1);assert.equal(p.kind,'translated');assert.equal(p.translationStatus,'complete');assert.equal(request.operation,'process_untrusted_email_once');assert.equal(request.task.classifyImportance,true);
});

test('brief English notices are translated too',async t=>{const {present}=setup(t,{assess:async()=>({translation:'您的付款失败。',evidence_quotes:['payment']})});assert.equal((await present({text:'Your payment failed.'})).translationStatus,'complete');});
