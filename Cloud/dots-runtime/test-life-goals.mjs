import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createLifeGoals, nextCheckin, bjDay } from './life-goals.mjs';

// 2026-10-30 10:00 北京时间
const T0 = Date.parse('2026-10-30T02:00:00Z');
assert.equal(new Date(nextCheckin(T0, 'daily', '20:00') * 1000).toISOString(), '2026-10-31T12:00:00.000Z');
assert.equal(new Date(nextCheckin(T0, 'weekly', '09:30') * 1000).toISOString(), '2026-11-06T01:30:00.000Z');
assert.equal(bjDay(Date.parse('2026-10-30T17:00:00Z')), '2026-10-31');

let clock = T0;
const db = new DatabaseSync(':memory:');
db.exec("CREATE TABLE manager_messages(id INTEGER PRIMARY KEY, manager_id TEXT, role TEXT, content TEXT, created_at INTEGER)");
const published = [], audits = [];
const store = { db, managerId: 'm1', publishProactive: m => { published.push(m); return { id: published.length }; } };
let planCalls = 0, failPlan = false;
const assess = async (data, schema, control) => {
  assert.equal(control.source, 'dots-goals');
  if (schema.required.includes('milestones')) {
    planCalls++; if (failPlan) throw new Error('model down');
    assert.match(data, /日语/);
    return { summary: '先打基础，再刷题。', milestones: [{ title: '背完 N4 单词', due: '2026-12-01' }, { title: '完成一套模拟题', due: 'bad-date' }, { title: '报名考试', due: '2027-03-01' }] };
  }
  assert.match(data, /背完 N4 单词/);
  return { content: '最近单词背得怎么样？' };
};
const goals = createLifeGoals({ store, assess, now: () => clock, intervalMs: 1e9, onAudit: (k, s) => audits.push(s), logger: { warn() {} } });

assert.throws(() => goals.create({ title: '  ' }), /请写下目标/);
assert.throws(() => goals.create({ title: 'x', cadence: 'hourly' }), /频率/);
assert.throws(() => goals.create({ title: 'x', targetDate: '2026/1/1' }), /日期/);
const { goal } = goals.create({ title: '日语过 N3', why: '去日本工作', targetDate: '2027-06-30', cadence: 'weekly', checkinTime: '20:00' });
assert.equal(goal.planState, 'planning');
await new Promise(r => setTimeout(r, 20));
let g = goals.list().goals[0];
assert.equal(g.planState, 'ready');
assert.equal(g.milestones.length, 3);
assert.equal(g.milestones[1].due, null, 'invalid model date dropped');
assert.equal(g.nextCheckinAt, nextCheckin(T0, 'weekly', '20:00'));
assert.match(published[0].content, /拟了一个计划/);
assert.equal(published[0].reason, '目标计划');

// not due yet
await goals.tick(); assert.equal(published.length, 1);
clock = g.nextCheckinAt * 1000 + 1000;
db.prepare("INSERT INTO manager_messages(manager_id,role,content,created_at) VALUES('m1','user','今天背了 50 个单词',?)").run(Math.floor(clock / 1000) - 10);
await goals.tick();
assert.equal(published.length, 2); assert.equal(published[1].reason, '目标检查'); assert.match(published[1].content, /单词/);
await goals.tick(); assert.equal(published.length, 2, 'rescheduled, no duplicate');
g = goals.list().goals[0]; assert.equal(g.checkins, 1); assert.ok(g.nextCheckinAt * 1000 > clock);

g = goals.milestone(g.id, { milestoneId: g.milestones[0].id, done: true }).goal; assert.equal(g.progress, 33);
g = goals.milestone(g.id, { add: '看一部日剧不开字幕', due: '2027-05-01' }).goal; assert.equal(g.milestones.length, 4);
g = goals.milestone(g.id, { remove: g.milestones[3].id }).goal; assert.equal(g.milestones.length, 3);
assert.throws(() => goals.milestone(g.id, { milestoneId: 'nope', done: true }), /不存在/);
g = goals.update(g.id, { status: 'paused' }).goal; assert.equal(g.nextCheckinAt, null);
clock += 30 * 86_400_000; await goals.tick(); assert.equal(published.length, 2, 'paused goals are quiet');
g = goals.update(g.id, { status: 'active' }).goal; assert.ok(g.nextCheckinAt * 1000 > clock, 'resume schedules from now, no backlog');
assert.throws(() => goals.update(999, { status: 'done' }), /不存在/);

failPlan = true;
const second = goals.create({ title: '日语口语练习', cadence: 'daily' }).goal;
await new Promise(r => setTimeout(r, 20));
assert.equal(goals.list().goals.find(x => x.id === second.id).planState, 'failed');
failPlan = false; goals.replan(second.id); await new Promise(r => setTimeout(r, 20));
assert.equal(goals.list().goals.find(x => x.id === second.id).planState, 'ready');
goals.remove(second.id); assert.equal(goals.list().goals.length, 1);
assert.ok(audits.some(a => a.includes('完成里程碑')));
console.log('PASS life goals: plan, check-in schedule, no duplicates, milestones, pause/resume, replan');
