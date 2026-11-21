import test from 'node:test';
import assert from 'node:assert/strict';
import {createSubscriptionIntent} from './subscription-intent.ts';
function fixture(decision,{repoStatus=200,isPrivate=false,configured=[]}: any={}){
  const replies: any[]=[],updates: any[]=[],claimed=new Set();
  const store={claimSubscriptionIntent:id=>claimed.has(id)?false:(claimed.add(id),true),postSubscriptionReply:r=>replies.push(r)};
  const subscriptions={list:async()=>configured,update:async(p,i)=>updates.push([p,i])};
  const assess=async()=>decision;
  const fetchImpl: any=async()=>({status:repoStatus,ok:repoStatus===200,json:async()=>({private:isPrivate})});
  return {intent:createSubscriptionIntent({store,subscriptions,assess,fetchImpl,logger:{warn(){}} as any}),replies,updates};
}
const msg=(id,content)=>({id,content});
test('prefilter only triggers on subscription-ish words',()=>{
  const {intent}=fixture({action:'none'});
  assert.equal(intent.candidate('今天天气怎么样'),false);
  assert.equal(intent.candidate('帮我订阅 openai/codex 仓库'),true);
});
test('public github repo is subscribed directly without a card',async()=>{
  const f=fixture({action:'subscribe',provider:'github',repository:'https://github.com/openai/codex',address:''});
  assert.equal(await f.intent.process(msg(1,'订阅 https://github.com/openai/codex')),true);
  assert.deepEqual(f.updates,[['github',{enabled:true,repository:'openai/codex'}]]);
  assert.equal(f.replies[0].card,null);assert.match(f.replies[0].content,/已订阅 openai\/codex/);
});
test('private repo gets a token card and nothing is saved',async()=>{
  const f=fixture({action:'subscribe',provider:'github',repository:'me/secret',address:''},{repoStatus:404});
  await f.intent.process(msg(2,'订阅我的仓库 me/secret'));
  assert.equal(f.updates.length,0);
  const card=f.replies[0].card;assert.equal(card.provider,'github');assert.equal(card.state,'open');
  assert.ok(card.fields.find(x=>x.key==='token').secret);assert.equal(card.fields.find(x=>x.key==='token').value,undefined);
});
test('email subscription asks for the authorization code in a card',async()=>{
  const f=fixture({action:'subscribe',provider:'email',repository:'',address:'a@qq.com'});
  await f.intent.process(msg(3,'有新邮件时通知我 a@qq.com'));
  const fields=f.replies[0].card.fields;assert.equal(fields[0].value,'a@qq.com');assert.ok(fields[1].secret);
});
test('unsubscribe asks for confirmation',async()=>{
  const f=fixture({action:'unsubscribe',provider:'github',repository:'',address:''},{configured:[{provider:'github',configured:true,enabled:true,repository:'o/r'}]});
  await f.intent.process(msg(4,'取消订阅 GitHub'));
  assert.equal(f.replies[0].card.action,'unsubscribe');
});
test('non-subscription messages are handed back to the manager',async()=>{
  const f=fixture({action:'none',provider:'',repository:'',address:''});
  assert.equal(await f.intent.process(msg(5,'帮我总结一下这封邮件')),false);assert.equal(f.replies.length,0);
});
test('a repeated request is never processed twice',async()=>{
  const f=fixture({action:'list',provider:'',repository:'',address:''});
  await f.intent.process(msg(6,'我订阅了什么'));await f.intent.process(msg(6,'我订阅了什么'));
  assert.equal(f.replies.length,1);
});
test('classifier failure hands the message back',async()=>{
  const {intent}=createSubscriptionIntent.length?fixture(null):fixture(null);
  const f=fixture(null);f.intent;assert.equal(await createSubscriptionIntent({store:{claimSubscriptionIntent:()=>true,postSubscriptionReply(){}},subscriptions:{list:async()=>[]},assess:async()=>{throw new Error('hub down')},logger:{warn(){}} as any}).process(msg(7,'订阅')),false);
});
