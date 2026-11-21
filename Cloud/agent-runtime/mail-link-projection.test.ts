import test from 'node:test';
import assert from 'node:assert/strict';
import {DotsAdapter} from './dots-adapter.ts';
test('mail history and stream message projection repairs URLs for all clients without changing user messages',()=>{
 const content='邮件中的链接：\n[1. https://sz.duoyi.com（电脑端登录），使用手机号12345678901](<https://sz.duoyi.com（电脑端登录），使用手机号12345678901>)';
 const context={attachments:{message:()=>null}};
 const message={id:1,role:'assistant',content,origin:'proactive',revision:2};
 const projected=DotsAdapter.prototype.presentManagerMessage.call(context,message,'account-test');
 assert(projected.content.includes('](<https://sz.duoyi.com>)（电脑端登录），使用手机号12345678901'));
 assert.equal(message.content,content,'historical stored data stays unchanged');
 assert.equal(projected.revision,2);
 assert.equal(DotsAdapter.prototype.presentManagerMessage.call(context,{...message,role:'user'},'account-test').content,content);
});


test('durable assistant mail replay is normalized just like live delivery and remains owner-bound',()=>{
 const adapter=Object.create(DotsAdapter.prototype);adapter.attachments={message:()=>null};
 const content='邮件中的链接：\n[1. https://sz.duoyi.com（电脑端登录）](<https://sz.duoyi.com（电脑端登录）>)';
 for(const kind of ['assistant_message','assistant_delta','proactive_message']){
  const event={type:'manager_activity',payload:{activity:{id:1,managerId:'manager:account-A',kind,data:{message:{id:1,role:'assistant',content,origin:'proactive',revision:1}}}}};
  const delivered=adapter.presentEvent('account-A',event);
  assert(delivered.payload.activity.data.message.content.includes('](<https://sz.duoyi.com>)（电脑端登录）'));
  assert.equal(event.payload.activity.data.message.content,content);
  assert.throws(()=>adapter.presentEvent('account-B',event),/归属不一致/);
 }
});
