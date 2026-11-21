import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {isAdvertisingMail,createMailPresenter} from './qq-mail-content.ts';
import {createMailEventStore} from './qq-mail-events.ts';
test('clear English and Chinese advertising is filtered; unsubscribe alone is insufficient',()=>{
 for(const mail of [{subject:'Limited time offer: 50% off'},{subject:'限时优惠，立即抢购'},{text:'Shop now for a discount. Unsubscribe here.'}])assert.equal(isAdvertisingMail(mail),true);
 for(const mail of [{text:'Your newsletter. Unsubscribe here.'},{subject:'Project update'},{text:'The sale field in your report is incorrect.'}])assert.equal(isAdvertisingMail(mail),false);
});
test('transactional mail survives promotional footers',()=>{
 for(const subject of ['Billing Problem','Your verification code','Payment failed','Security alert','Order confirmation','您的验证码','账单提醒'])assert.equal(isAdvertisingMail({subject,text:'Shop now! 50% off. Unsubscribe.'}),false);
});
test('filtered mail is not translated or published, is deduplicated and isolated',async()=>{
 const db=new DatabaseSync(':memory:');try{
 const store={db,managerId:'alice',transaction:f=>f(),publishMail:()=>{throw Error('must not publish')}};
 const present=createMailPresenter({store,assess:()=>{throw Error('must not translate')}});
 const presentation=await present({subject:'Special offer',text:'Shop now. Unsubscribe.'});assert.equal(presentation.kind,'ignored_advertisement');
 const events=createMailEventStore({store,accountKey:'a',now:()=>100});events.baseline({uidValidity:'1',uidNext:1});
 const input={uid:1,uidValidity:'1',internalDate:new Date(100000),presentation};
 assert.equal(events.receive(input),null);assert.equal(events.needsContent(input),false);assert.equal(events.receive(input),null);
 assert.equal(db.prepare('SELECT state FROM dots_mail_events').get().state,'ignored_advertisement');
 const other=createMailEventStore({store:{...store,managerId:'bob'},accountKey:'a',now:()=>100});other.baseline({uidValidity:'1',uidNext:1});assert.equal(other.needsContent(input),true);
 events.completeSync({uidValidity:'1',lastUid:1});assert.equal(events.state().last_uid,1);
 }finally{db.close()}
});

test('explicit advertising labels block image-only English product announcements',()=>{
 for(const subject of ['<广告> The new iPhone Duo is here.','【广告】新品发布','[Advertisement] New products','Re: <广告> The new iPhone Duo is here.','[AD] New iPhone'])assert.equal(isAdvertisingMail({subject}),true);
 assert.equal(isAdvertisingMail({subject:'Your advertisement account security alert'}),false);
});
test('delivery boundary blocks labelled advertisements even when body preparation fails',()=>{
 const db=new DatabaseSync(':memory:');try{
 const store={db,managerId:'alice',transaction:f=>f(),publishMail:()=>{throw Error('must not publish')}};
 const events=createMailEventStore({store,accountKey:'a',now:()=>100});events.baseline({uidValidity:'1',uidNext:1});
 const mail={uid:1,uidValidity:'1',internalDate:new Date(100000),envelope:{subject:'<广告> The new iPhone Duo is here.'},presentation:{kind:'body',text:'（本次未能读取邮件正文）'}};
 assert.equal(events.receive(mail),null);assert.equal(events.needsContent(mail),false);assert.equal(events.receive(mail),null);
 assert.equal(db.prepare('SELECT state FROM dots_mail_events').get().state,'ignored_advertisement');
 }finally{db.close()}
});
