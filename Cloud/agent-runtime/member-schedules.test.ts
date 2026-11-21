import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SyncStore } from './sync-store.ts';
import { prepareScheduleMutation, SyncedSchedules } from './sync-schedules.ts';
import { MemberScheduleWorker, nextMemberRun } from './member-schedules.ts';

const clock = Date.parse('2026-10-23T01:00:00Z');
const task = (): any => ({ id: 'schedule-test-id', title: 'Own task', instruction: 'Write my report', enabled: true, repeat: 'daily', time: '09:00', timezone: 'Asia/Shanghai', startDate: '2026-10-23', endDate: null, runLocally: true, notificationMode: 'all', newChatEachRun: false, model: 'test-model', reasoning: 'low', projectId: null });
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'shiyan-member-schedules-')), store = new SyncStore(root);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); }); return store;
}
test('member schedule mutations force isolated execution without a registered Mac and ignore forged reports', t => {
  const store = fixture(t), auth = { owner: 'alice', role: 'user', serverAccess: false, platform: 'macos' };
  const input = task(); input.lastRunState = 'completed'; input.executorDeviceId = 'host';
  const result = prepareScheduleMutation(store, 'alice', { kind: 'scheduledTasks', id: input.id, data: input }, auth).data;
  assert.equal(result.runLocally, false); assert.equal(result.executionMode, 'isolated'); assert.equal(result.executorDeviceId, 'isolated');
  assert.equal(result.lastRunState, undefined); assert(result.nextRunAt);
  const schedules = new SyncedSchedules(store);
  assert.equal(schedules.host(auth, {}).executionMode, 'isolated');
  assert.throws(() => schedules.claim(auth, input.id, {}), { status: 403 });
});
test('two accounts using the same task id execute independently and repeated ticks never duplicate a run', async t => {
  const store = fixture(t), submitted: any[] = [], statuses = new Map();
  for (const owner of ['alice', 'bob']) store.write(owner, 'scheduledTasks', 'same-task-id', { ...task(), id: 'same-task-id', runLocally: false, executionMode: 'isolated', executorDeviceId: 'isolated', nextRunAt: new Date(clock - 1000).toISOString() });
  const worker = new MemberScheduleWorker(store, { pollMs: 0, now: () => clock, access: () => ({ status: 'active' }),
    submit: async (input, owner) => { submitted.push({ input, owner }); const job = { id: 'job-' + owner, status: 'running' }; statuses.set(owner + ':' + job.id, job); return job; },
    jobStatus: (owner, id) => statuses.get(owner + ':' + id) });
  await Promise.all([worker.tick(), worker.tick()]); await worker.tick();
  assert.equal(submitted.length, 2); assert.notEqual(submitted[0].input.requestId, submitted[1].input.requestId);
  assert.notEqual(submitted[0].input.conversationId, submitted[1].input.conversationId);
  for (const owner of ['alice', 'bob']) assert.equal(store.get(owner, 'scheduledTasks', 'same-task-id')!.data.lastRunState, 'running');
  statuses.get('alice:job-alice').status = 'completed'; await worker.tick();
  assert.equal(store.get('alice', 'scheduledTasks', 'same-task-id')!.data.lastRunState, 'completed');
  assert.equal(store.get('bob', 'scheduledTasks', 'same-task-id')!.data.lastRunState, 'running');
});
test('disabled owners do not execute and hourly scheduling remains bounded across future dates', async t => {
  const store = fixture(t); let called = false;
  store.write('disabled', 'scheduledTasks', 'schedule-test-id', { ...task(), executionMode: 'isolated', nextRunAt: new Date(clock - 1000).toISOString() });
  const worker = new MemberScheduleWorker(store, { pollMs: 0, now: () => clock, access: () => ({ status: 'disabled' }), submit: async () => { called = true; } });
  await worker.tick(); assert(!called);
  assert.equal(nextMemberRun({ ...task(), repeat: 'hourly', time: '09:30' }, clock), '2026-10-23T01:30:00.000Z');
  const future = nextMemberRun({ ...task(), repeat: 'hourly', time: '09:30', startDate: '2028-01-01' }, clock);
  assert(future && Date.parse(future) >= Date.parse('2027-12-31T16:00:00Z'));
});
