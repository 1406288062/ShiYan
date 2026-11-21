import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createReminders, createProactivePreferences, parseLocal, formatLocal, nextOccurrence } from './reminders.mjs';
import { timeContext } from './time-context.mjs';

const fake = () => { const published = []; return { db: new DatabaseSync(':memory:'), managerId: 'm1', published, publishProactive(v) { published.push(v); return { id: published.length }; } }; };
const bj = (d, h, m) => Date.UTC(2026, 10, d, h - 8, m);

test('Beijing time parsing, weekday formatting and repeats', () => {
  assert.equal(parseLocal('2026-11-12 08:00') * 1000, bj(12, 8, 0));
  assert.equal(parseLocal('2026-02-30 08:00'), null);
  assert.equal(formatLocal(bj(13, 9, 5) / 1000), '2026-11-13 09:05 星期五');
  assert.equal(formatLocal(nextOccurrence(bj(13, 9, 0) / 1000, 'weekdays')), '2026-11-16 09:00 星期一');
  assert.match(timeContext(bj(11, 10, 0)), /2026-11-11 10:00 星期三.*明天11月12日 周四/);
});

test('a reminder fires once at its time without any model call; repeating ones roll forward', () => {
  const store = fake(); let clock = bj(11, 10, 0);
  const r = createReminders({ store, now: () => clock, logger: {} });
  const out = r.apply({ reminders: [{ at: '2026-11-11 10:30', text: '该喝水了', repeat: 'none' }, { at: '2026-11-11 22:00', text: '早点睡', repeat: 'daily' }, { at: '2026-11-10 08:00', text: '过去的', repeat: 'none' }], cancel_reminders: [] });
  assert.equal(out.added.length, 2); assert.deepEqual(out.failed, ['时间已经过去']);
  assert.equal(r.list().length, 2);
  r.tick(); assert.equal(store.published.length, 0);
  clock = bj(11, 10, 31); r.tick(); r.tick();
  assert.deepEqual(store.published.map(p => p.content), ['⏰ 提醒：该喝水了']);
  clock = bj(11, 22, 0); r.tick();
  assert.equal(store.published.at(-1).content, '⏰ 提醒：早点睡');
  assert.match(r.list()[0].at, /2026-11-12 22:00/);
});

test('reminders missed during a long outage are skipped; cancel stops them', () => {
  const store = fake(); let clock = bj(11, 10, 0);
  const r = createReminders({ store, now: () => clock, logger: {} });
  const { added } = r.apply({ reminders: [{ at: '2026-11-11 11:00', text: 'A', repeat: 'none' }, { at: '2026-11-11 12:00', text: 'B', repeat: 'daily' }] });
  clock = bj(11, 18, 0); r.tick(); assert.equal(store.published.length, 0);
  assert.equal(r.list().length, 1, 'the daily one moved to tomorrow');
  r.apply({ cancel_reminders: [added[1]] }); assert.equal(r.list().length, 0);
});

test('proactive preferences are stored as one text', () => {
  const store = fake(), p = createProactivePreferences({ store });
  assert.equal(p.get(), ''); p.set('GitHub 推送只在晚上汇总'); assert.equal(p.get(), 'GitHub 推送只在晚上汇总');
});
