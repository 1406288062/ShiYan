import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createDailyBrief, briefDay } from './daily-brief.mjs';
import { createMemoryIntent } from './memory-intent.mjs';

function fakeStore() {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE manager_messages(id INTEGER PRIMARY KEY,manager_id TEXT,role TEXT,content TEXT,created_at INTEGER,origin TEXT,proactive_reason TEXT)");
  db.exec("CREATE TABLE goals(id INTEGER PRIMARY KEY,manager_id TEXT,title TEXT,status TEXT,last_summary TEXT,updated_at INTEGER)");
  const published = [], replies = [], claimed = new Set();
  return { db, managerId: 'm1', published, replies,
    publishProactive({ content, reason }) { const id = published.push({ content, reason }); return { id }; },
    postSubscriptionReply(value) { replies.push(value); },
    claimSubscriptionIntent(id) { if (claimed.has(id)) return false; claimed.add(id); return true; } };
}
// 2026-10-30 09:05 Beijing = 01:05 UTC
const at = (h, m) => Date.UTC(2026, 9, 30, h - 8, m);

const userSaid = (store, ms) => store.db.prepare("INSERT INTO manager_messages(manager_id,role,content,created_at,origin,proactive_reason) VALUES('m1','user','在吗',?,'reply','')").run(Math.floor(ms / 1000));

test('brief fires once per day inside the window and skips the model when there is nothing', async () => {
  const store = fakeStore(); let calls = 0; userSaid(store, at(8, 0));
  let clock = at(8, 59);
  const brief = createDailyBrief({ store, assess: async () => { calls++; return { content: 'x' }; }, settings: () => ({ dailyBrief: true, dailyBriefTime: '09:00' }), now: () => clock, logger: {} });
  await brief.tick(); assert.equal(store.published.length, 0);
  clock = at(9, 5); await brief.tick(); await brief.tick();
  assert.equal(store.published.length, 1); assert.equal(calls, 0);
  assert.match(store.published[0].content, /每日简报/);
  assert.equal(briefDay(clock), '2026-10-30');
});

test('brief uses the model with tasks and events, never after the 3h window, respects the switch', async () => {
  const store = fakeStore(); let input = ''; userSaid(store, at(8, 0));
  store.db.prepare("INSERT INTO goals(manager_id,title,status,last_summary,updated_at) VALUES('m1','整理发票','active','进行中',1)").run();
  const assess = async data => { input = data; return { content: '早上好' }; };
  const late = createDailyBrief({ store, assess, settings: () => ({ dailyBrief: true, dailyBriefTime: '09:00' }), now: () => at(13, 0), logger: {} });
  await late.tick(); assert.equal(store.published.length, 0);
  const off = createDailyBrief({ store, assess, settings: () => ({ dailyBrief: false, dailyBriefTime: '09:00' }), now: () => at(9, 1), logger: {} });
  await off.tick(); assert.equal(store.published.length, 0);
  const on = createDailyBrief({ store, assess, settings: () => ({ dailyBrief: true, dailyBriefTime: '09:00' }), now: () => at(9, 1), logger: {} });
  await on.tick(); assert.equal(store.published.length, 1); assert.match(input, /整理发票/);
});

test('brief is not sent when the user has said nothing since the last brief', async () => {
  const store = fakeStore(); let calls = 0;
  const settings = () => ({ dailyBrief: true, dailyBriefTime: '09:00' }), assess = async () => { calls++; return { content: 'x' }; };
  await createDailyBrief({ store, assess, settings, now: () => at(9, 1), logger: {} }).tick();
  assert.equal(store.published.length, 0, 'no user message in the last day');
  userSaid(store, at(8, 30));
  store.db.prepare("INSERT INTO manager_messages(manager_id,role,content,created_at,origin,proactive_reason) VALUES('m1','assistant','☀️ 每日简报',?,'proactive','每日简报')").run(Math.floor(at(8, 40) / 1000));
  const next = Date.UTC(2026, 9, 31, 1, 1);
  await createDailyBrief({ store, assess, settings, now: () => next, logger: {} }).tick();
  assert.equal(store.published.length, 0, 'user message came before the last brief');
  store.db.prepare("INSERT INTO manager_messages(manager_id,role,content,created_at,origin,proactive_reason) VALUES('m1','user','早',?,'reply','')").run(Math.floor(next / 1000) - 60);
  await createDailyBrief({ store, assess, settings, now: () => next + 86400_000, logger: {} }).tick();
  assert.equal(store.published.length, 1);
});

test('memory intent remembers, forgets and leaves other messages alone', async () => {
  const store = fakeStore(); const rows = [{ id: 'a', content: '用户不吃香菜' }, { id: 'b', content: '用户周末不看工作消息' }]; const removed = [];
  const memory = { settings: () => ({ enabled: true }), create: (_, v) => rows.push({ id: 'n', content: v.content }), list: () => ({ memories: rows }), remove: (_, id) => removed.push(id) };
  const answers = [{ action: 'remember', content: '用户喜欢喝美式', query: '' }, { action: 'forget', content: '', query: '香菜' }, { ids: ['a'] }, { action: 'none', content: '', query: '' }];
  const intent = createMemoryIntent({ store, memory, owner: 'o', assess: async () => answers.shift(), logger: {} });
  assert.equal(intent.candidate('今天天气怎么样'), false);
  assert.equal(await intent.process({ id: 1, content: '记住我喜欢喝美式' }), true);
  assert.equal(rows.at(-1).content, '用户喜欢喝美式');
  assert.equal(await intent.process({ id: 2, content: '忘掉我不吃香菜这件事' }), true);
  assert.deepEqual(removed, ['a']);
  assert.equal(await intent.process({ id: 3, content: '你还记住我昨天说的吗' }), false);
  assert.equal(store.replies.length, 2);
});
