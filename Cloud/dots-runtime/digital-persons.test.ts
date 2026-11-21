import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { DigitalPersonService } from './digital-persons.ts';
import { buildVoiceRule } from './manager-runtime.ts';

const vector=()=>Array.from({length:1024},(_,i)=>i===0?1:0);
function fixture(owner='account-a'){
  const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');
  const state={calls:0};
  const assess=async(prompt,schema)=>{
    state.calls++;assert.ok(Buffer.byteLength(prompt)<128*1024);
    if(schema.properties.styleProfile)return {styleProfile:{vocabulary:['嗯嗯'],expression:['短句'],rhythm:'简短',emotion:'克制',personality:['细心'],phrases:['知道啦'],addressing:'宝',punctuation:'很少用句号'},
      memories:[{category:'event',content:'双方曾一起去海边',evidence:'那年一起去了海边',occurredAt:null},{category:'other',content:'没有证据',evidence:'原文里不存在',occurredAt:null}]};
    return {reply:'记得呀'};
  };
  return {db,state,service:new DigitalPersonService({db,owner,assess,embed:async texts=>texts.map(()=>vector())})};
}
test('学习对象：导入只调用一次模型，并为 Dots 主对话提供说话方式',async()=>{
  const a=fixture(),b=fixture('account-b');
  const person=a.service.create({name:'小美',relationship:'女朋友'}).person;
  assert.equal(a.service.list().activePersonId,person.id);
  assert.equal(b.service.list().people.length,0);
  const messages: any[]=[];
  for(let i=0;i<300;i++){messages.push({speaker:'owner',content:i%7?'今天吃什么':'晚上去海边吗',sourceId:'f:'+(2*i)});messages.push({speaker:'person',content:i%5?'好的':'那年一起去了海边 哈哈',sourceId:'f:'+(2*i+1)});}
  messages.push({speaker:'other',content:'第三方隐私不应保存',sourceId:'f:9999'});
  let last;
  for(let i=0;i<messages.length;i+=40)last=await a.service.importBatch(person.id,{importId:'import_12345678',messages:messages.slice(i,i+40),final:i+40>=messages.length});
  assert.equal(a.state.calls,1);
  assert.equal(last.status,'completed');
  assert.equal(last.memoryCount,1);
  assert.equal(last.person.personMessages,300);
  assert.equal(Number(a.db.prepare("SELECT COUNT(*) AS n FROM digital_person_import_messages WHERE speaker='other'").get()!.n),0);
  const voice=JSON.parse(await a.service.voiceContext('还记得海边吗'));
  assert.equal(voice.person.name,'小美');
  assert.ok(voice.sample_exchanges.length>=10);
  assert.ok(voice.related_past_chats.length>0);
  assert.equal(voice.shared_memories.length,1);
  assert.match(buildVoiceRule(JSON.stringify(voice)),/VOICE/);
  assert.equal(buildVoiceRule(''),'');
  assert.equal(await b.service.voiceContext('海边'),'');
  await a.service.update(person.id,{active:false});
  assert.equal(await a.service.voiceContext('海边'),'');
  await a.service.update(person.id,{active:true,relearn:true});
  assert.equal(a.state.calls,2);
  a.service.remove(person.id);
  assert.equal(a.service.list().people.length,0);
  assert.equal(await a.service.voiceContext('海边'),'');
  assert.equal(Number(a.db.prepare('SELECT COUNT(*) AS n FROM digital_person_import_messages').get()!.n),0);
});
test('影子人：服务器端会隐藏聊天中的敏感信息',async()=>{
  const {DatabaseSync}=await import('node:sqlite');
  const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');
  const service=new DigitalPersonService({db,owner:'o',assess:async()=>({styleProfile:{vocabulary:[],expression:[],rhythm:'',emotion:'',personality:[],phrases:[],addressing:'',punctuation:''},memories:[]}),embed:async t=>t.map(()=>Array.from({length:1024},(_,i)=>i?0:1))});
  const p=service.create({name:'小美'}).person;
  await service.importBatch(p.id,{importId:'imp_redact_1',final:true,messages:[{speaker:'person',content:'我手机13812345678，卡号6222021234567890123，密码是abc123，验证码 384920',sourceId:'x:0'},{speaker:'owner',content:'晚上 8 点见，带 100 块',sourceId:'x:1'}]});
  const rows=db.prepare('SELECT content FROM digital_person_import_messages ORDER BY id').all().map(r=>r.content);
  assert.equal(rows[0],'我手机[手机号已隐藏]，卡号[卡号已隐藏]，[凭据已隐藏]，[验证码已隐藏]');
  assert.equal(rows[1],'晚上 8 点见，带 100 块');
});
