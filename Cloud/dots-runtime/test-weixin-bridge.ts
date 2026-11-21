import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createWeixinBridge, plainText } from './weixin-bridge.ts';

const wait = ms => new Promise(r => setTimeout(r, ms));
function fakeWeixin() {
  const sent = [], calls = [];
  let delivered = false, qrPolls = 0;
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname; calls.push(path);
    const body = init.body ? JSON.parse(init.body) : {};
    const reply = value => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });
    if (path.endsWith('get_bot_qrcode')) return reply({ qrcode: 'q1', qrcode_img_content: 'https://liteapp.weixin.qq.com/q/x?qrcode=q1', ret: 0 });
    if (path.endsWith('get_qrcode_status')) return reply(++qrPolls < 2 ? { status: 'scaned' } : { status: 'confirmed', bot_token: 'tok', ilink_bot_id: 'bot1', baseurl: 'https://ilinkai.weixin.qq.com', ilink_user_id: 'me' });
    if (path.endsWith('getupdates')) {
      if (!delivered) { delivered = true; return { ok: true, status: 200, text: async () => '{"ret":0,"get_updates_buf":"b1","msgs":[{"message_id":12345678901234567890,"from_user_id":"me","message_type":1,"context_token":"ctx","item_list":[{"type":1,"text_item":{"text":"你好"}}]},{"message_id":2,"from_user_id":"stranger","message_type":1,"item_list":[{"type":1,"text_item":{"text":"spam"}}]}]}' }; }
      await wait(50); return reply({ ret: 0, msgs: [] });
    }
    if (path.endsWith('sendmessage')) { sent.push(body.msg); return reply({ ret: 0 }); }
    return reply({ ret: 0 });
  };
  return { fetchImpl, sent, calls };
}

test('plain text strips markdown for WeChat', () => {
  assert.equal(plainText('## 标题\n**粗体** 和 [链接](https://a.b)\n- 项目'), '标题\n粗体 和 链接（https://a.b）\n· 项目');
});

test('scan to bind, receive own message, reply goes back, strangers ignored', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE manager_messages(id INTEGER PRIMARY KEY,manager_id TEXT,role TEXT,content TEXT,origin TEXT,delivery_state TEXT,responds_to_message_ids TEXT)");
  const store = { db, managerId: 'm1' };
  const ingested = [];
  const ingest = (text, requestId) => {
    ingested.push({ text, requestId });
    const id = Number(db.prepare("INSERT INTO manager_messages(manager_id,role,content,origin,delivery_state,responds_to_message_ids) VALUES('m1','user',?,'reply','completed','[]')").run(text).lastInsertRowid);
    setTimeout(() => db.prepare("INSERT INTO manager_messages(manager_id,role,content,origin,delivery_state,responds_to_message_ids) VALUES('m1','assistant','**你好**，我在。','reply','completed',?)").run(`[${id}]`), 30);
    return { id };
  };
  const fake = fakeWeixin();
  const bridge = createWeixinBridge({ store, ingest, owner: 'o', fetchImpl: fake.fetchImpl, logger: {} });
  const started = await bridge.status();
  assert.equal(started.state, 'unbound');
  const login = await bridge.startLogin();
  assert.equal(login.state, 'login'); assert.match(login.qrSvg, /<svg/);
  for (let i = 0; i < 60 && (await bridge.status()).state !== 'connected'; i++) await wait(20);
  assert.equal((await bridge.status()).state, 'connected');
  for (let i = 0; i < 100 && !fake.sent.length; i++) await wait(20);
  bridge.close();
  assert.equal(ingested.length, 1);
  assert.equal(ingested[0].text, '你好');
  assert.equal(ingested[0].requestId, 'weixin:12345678901234567890');
  assert.equal(fake.sent[0].to_user_id, 'me');
  assert.equal(fake.sent[0].context_token, 'ctx');
  assert.equal(fake.sent[0].item_list[0].text_item.text, '你好，我在。');
});

test('image from WeChat is decrypted, saved and handed to Dots; typing is shown', async () => {
  const { createCipheriv } = await import('node:crypto');
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(40, 7)]);
  const key = Buffer.alloc(16, 3), cipher = createCipheriv('aes-128-ecb', key, null);
  const encrypted = Buffer.concat([cipher.update(png), cipher.final()]);
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE manager_messages(id INTEGER PRIMARY KEY,manager_id TEXT,role TEXT,content TEXT,origin TEXT,delivery_state TEXT,responds_to_message_ids TEXT)");
  const ingested = [], saved = [], typing = [];
  const ingest = text => {
    ingested.push(text);
    const id = Number(db.prepare("INSERT INTO manager_messages(manager_id,role,content,origin,delivery_state,responds_to_message_ids) VALUES('m1','user',?,'reply','completed','[]')").run(text).lastInsertRowid);
    setTimeout(() => db.prepare("INSERT INTO manager_messages(manager_id,role,content,origin,delivery_state,responds_to_message_ids) VALUES('m1','assistant','看到了','reply','completed',?)").run(`[${id}]`), 30);
    return { id };
  };
  let delivered = false, qrPolls = 0; const sent = [];
  const reply = value => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url), path = u.pathname, body = init.body ? JSON.parse(init.body) : {};
    if (u.hostname === 'novac2c.cdn.weixin.qq.com') return { ok: true, status: 200, arrayBuffer: async () => encrypted };
    if (path.endsWith('get_bot_qrcode')) return reply({ qrcode: 'q1', qrcode_img_content: 'https://liteapp.weixin.qq.com/q/x?qrcode=q1' });
    if (path.endsWith('get_qrcode_status')) return reply(++qrPolls < 2 ? { status: 'scaned' } : { status: 'confirmed', bot_token: 'tok', ilink_bot_id: 'bot1', baseurl: 'https://ilinkai.weixin.qq.com', ilink_user_id: 'me' });
    if (path.endsWith('getupdates')) {
      if (!delivered) { delivered = true; return reply({ ret: 0, msgs: [{ message_id: 9, from_user_id: 'me', message_type: 1, context_token: 'ctx', item_list: [{ type: 2, image_item: { aeskey: key.toString('hex'), media: { encrypt_query_param: 'abc' } } }] }] }); }
      await wait(50); return reply({ ret: 0, msgs: [] });
    }
    if (path.endsWith('getconfig')) return reply({ ret: 0, typing_ticket: 't1' });
    if (path.endsWith('sendtyping')) { typing.push(body.status); return reply({ ret: 0 }); }
    if (path.endsWith('sendmessage')) { sent.push(body.msg); return reply({ ret: 0 }); }
    return reply({ ret: 0 });
  };
  const bridge = createWeixinBridge({ store: { db, managerId: 'm1' }, ingest, owner: 'o', fetchImpl, logger: {},
    saveInbound: async ({ data, filename }) => { saved.push({ data, filename }); return '/workspace/inputs/' + filename; } });
  await bridge.startLogin();
  for (let i = 0; i < 100 && !sent.length; i++) await wait(20);
  bridge.close();
  assert.equal(saved.length, 1);
  assert.ok(saved[0].data.equals(png));
  assert.match(saved[0].filename, /\.png$/);
  assert.match(ingested[0], /\/workspace\/inputs\/weixin-.*\.png/);
  assert.equal(typing[0], 1);
  assert.equal(sent[0].item_list[0].text_item.text, '看到了');
});

test('mail pushed to WeChat is one compact message', async () => {
  const { weixinMailDigest } = await import('./weixin-bridge.ts');
  const mail = '收到一封 QQ 邮件\n\n发件人：腾讯云 · cloud\\_noreply@tencent.com\n主题：账单提醒\n收件时间：10/31 12:58\n\n正文：\n' + '内容很长。'.repeat(400) + '\n\n邮件中的链接：\n1. [查看](<https://a.b/c>)';
  const digest = weixinMailDigest(mail);
  assert.ok(digest.length < 900);
  assert.match(digest, /主题：账单提醒/);
  assert.doesNotMatch(digest, /邮件中的链接/);
  assert.equal(weixinMailDigest(mail.replace('收到一封 QQ 邮件', '收到一封 QQ 邮件（2/2）')), '');
});
