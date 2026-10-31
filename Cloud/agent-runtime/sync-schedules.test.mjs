import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { SyncStore } from './sync-store.mjs';
import { SyncedSchedules, prepareScheduleMutation } from './sync-schedules.mjs';

const owner = 'schedule-test-owner';
const keys = [generateKeyPairSync('ed25519'), generateKeyPairSync('ed25519')];
const rawKey = pair => pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
const physical = createHash('sha256').update(rawKey(keys[0])).digest('hex');
const otherPhysical = createHash('sha256').update(rawKey(keys[1])).digest('hex');
const taskId = 'scheduled-task-1';
const account = (session, overrides = {}) => ({ owner, deviceID: session, sessionId: session,
  accountSession: true, platform: 'macos', ...overrides });
const schedule = () => ({ id: taskId, title: 'Daily report', instruction: 'Summarize available information',
  enabled: true, repeat: 'daily', time: '09:00', timezone: 'Asia/Shanghai', startDate: '2026-10-13', endDate: null,
  runLocally: true, newChatEachRun: false, notificationMode: 'important', model: 'test-model', reasoning: 'low',
  projectId: null, executorDeviceId: physical, nextRunAt: '2026-10-15T01:00:00Z', status: 'enabled' });
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'shiyan-schedule-'));
  const store = new SyncStore(root), scheduler = new SyncedSchedules(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { store, scheduler };
}
function mutation(data) { return { kind: 'scheduledTasks', id: taskId, data }; }
function proof(auth, deviceId = physical, { pair = keys[0], timestamp = Date.now(), nonce = randomUUID() } = {}) {
  const message = ['shiyan-schedule-host-v1', auth.owner, deviceId, String(timestamp), nonce].join('\n');
  return { deviceId, devicePublicKey: rawKey(pair).toString('base64'), deviceTime: timestamp,
    deviceNonce: nonce, deviceSignature: sign(null, Buffer.from(message), pair.privateKey).toString('base64') };
}
function claim(store, scheduler, auth, dueAt, requestId) {
  return scheduler.claim(auth, taskId, { dueAt, requestId, revision: store.get(owner, 'scheduledTasks', taskId).revision });
}

test('legacy tasks retain one physical executor across account logins, reports and daily claims', t => {
  const { store, scheduler } = fixture(t);
  const legacy = { owner, deviceID: physical, platform: 'macos' };
  scheduler.host(legacy, {});
  store.write(owner, 'scheduledTasks', taskId, schedule());
  const firstSession = account('login-session-1');
  scheduler.host(firstSession, proof(firstSession));
  const report = prepareScheduleMutation(store, owner, mutation({ ...schedule(), lastRunState: 'completed' }), firstSession);
  assert.equal(report.data.executorDeviceId, physical);
  store.write(owner, 'scheduledTasks', taskId, report.data);
  const first = claim(store, scheduler, firstSession, schedule().nextRunAt, 'daily-claim-20261015');
  assert.equal(first.replayed, false);

  // Reopening with a new account session must not steal or duplicate the slot.
  const secondSession = account('login-session-2');
  scheduler.host(secondSession, proof(secondSession));
  assert.equal(claim(store, scheduler, secondSession, schedule().nextRunAt, 'daily-claim-20261015').replayed, true);
  assert.throws(() => claim(store, scheduler, secondSession, schedule().nextRunAt, 'another-request-id'), { status: 409 });
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM schedule_claims').get().n, 1);

  const tomorrow = { ...report.data, nextRunAt: '2026-10-16T01:00:00Z' };
  store.write(owner, 'scheduledTasks', taskId, tomorrow);
  assert.equal(claim(store, scheduler, secondSession, tomorrow.nextRunAt, 'daily-claim-20261016').replayed, false);
  assert.deepEqual(store.db.prepare('SELECT DISTINCT device FROM schedule_claims').all().map(row => row.device), [physical]);
  assert.equal(scheduler.listing(secondSession).host.deviceId, physical);
});

test('older host heartbeat cannot downgrade an established physical mapping', t => {
  const { store, scheduler } = fixture(t), auth = account('login-session-1');
  scheduler.host(auth, proof(auth));
  scheduler.host(auth, { local: [] });
  store.write(owner, 'scheduledTasks', taskId, schedule());
  assert.equal(prepareScheduleMutation(store, owner, mutation(schedule()), auth).data.executorDeviceId, physical);
  assert.equal(scheduler.listing(auth).host.deviceId, physical);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM schedule_hosts WHERE device=?').get(auth.deviceID).n, 0);
  assert.throws(() => scheduler.host(auth, { deviceId: otherPhysical }), { status: 409 });
});

test('another Mac and another account cannot claim or publish the original executor state', t => {
  const { store, scheduler } = fixture(t);
  const original = account('original-session');
  scheduler.host(original, proof(original));
  store.write(owner, 'scheduledTasks', taskId, schedule());
  claim(store, scheduler, original, schedule().nextRunAt, 'original-slot-claim');
  const anotherMac = account('different-mac-session');
  scheduler.host(anotherMac, proof(anotherMac, otherPhysical, { pair: keys[1] }));
  assert.throws(() => prepareScheduleMutation(store, owner, mutation(schedule()), anotherMac), { status: 409 });
  assert.throws(() => claim(store, scheduler, anotherMac, schedule().nextRunAt, 'other-mac-claim'), { status: 409 });
  assert.throws(() => claim(store, scheduler, anotherMac, schedule().nextRunAt, 'original-slot-claim'), { status: 409 });
  const anotherOwner = account('original-session', { owner: 'another-owner' });
  scheduler.host(anotherOwner, {});
  assert.equal(scheduler.listing(anotherOwner).host.deviceId, 'original-session');
  assert.throws(() => scheduler.claim(anotherOwner, taskId, { dueAt: schedule().nextRunAt, requestId: 'other-owner-claim', revision: 1 }), { status: 409 });
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM schedule_claims').get().n, 1);
});

test('registration preserves legacy clients and rejects invalid devices and mobile host claims', t => {
  const { scheduler } = fixture(t);
  const oldAccount = account('old-client-session');
  scheduler.host(oldAccount, {});
  assert.equal(scheduler.listing(oldAccount).host.deviceId, oldAccount.deviceID);
  assert.throws(() => scheduler.host(account('invalid'), { deviceId: 'not-a-physical-key' }), { status: 400 });
  assert.throws(() => scheduler.host(account('mobile', { platform: 'ios' }), { deviceId: physical }), { status: 403 });
  assert.throws(() => scheduler.host({ owner, deviceID: physical, platform: 'macos' }, { deviceId: otherPhysical }), { status: 403 });
});

test('a same-owner session cannot spoof a Mac or replay its proof across sessions or owners', t => {
  const { store, scheduler } = fixture(t), original = account('original-session');
  const signed = proof(original);
  scheduler.host(original, signed);
  const attacker = account('another-session');
  assert.throws(() => scheduler.host(attacker, { deviceId: physical }), { status: 403 });
  assert.throws(() => scheduler.host(attacker, proof(attacker, physical, { pair: keys[1] })), { status: 403 });
  assert.throws(() => scheduler.host(attacker, signed), { status: 403 });
  assert.throws(() => scheduler.host(account('another-owner-session', { owner: 'another-owner' }), signed), { status: 403 });
  assert.throws(() => scheduler.host(attacker, proof(attacker, physical, { timestamp: Date.now() - 301000 })), { status: 403 });
  assert.throws(() => scheduler.host(attacker, proof(attacker, physical, { timestamp: Date.now() + 301000 })), { status: 403 });
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM schedule_host_sessions').get().n, 1);
  scheduler.host(original, {});
  assert.equal(scheduler.listing(original).host.deviceId, physical);
});

test('upgrading a session-owned old-client task preserves its schedule, reports and claimed slot', t => {
  const { store, scheduler } = fixture(t), auth = account('old-account-session');
  scheduler.host(auth, {});
  const oldTask = { ...schedule(), executorDeviceId: auth.deviceID };
  store.write(owner, 'scheduledTasks', taskId, oldTask);
  claim(store, scheduler, auth, oldTask.nextRunAt, 'old-client-claim');
  const foreignOwner = 'different-owner';
  store.write(foreignOwner, 'scheduledTasks', taskId, oldTask);
  scheduler.host(auth, proof(auth));
  const upgraded = store.get(owner, 'scheduledTasks', taskId);
  assert.deepEqual(upgraded.data, { ...oldTask, executorDeviceId: physical });
  assert.equal(store.get(foreignOwner, 'scheduledTasks', taskId).data.executorDeviceId, auth.deviceID);
  assert.equal(store.db.prepare('SELECT device FROM schedule_claims WHERE owner=?').get(owner).device, physical);
  assert.equal(claim(store, scheduler, auth, oldTask.nextRunAt, 'old-client-claim').replayed, true);
  assert.equal(prepareScheduleMutation(store, owner, mutation(oldTask), auth).data.executorDeviceId, physical);
  scheduler.host(auth, {});
  assert.equal(scheduler.listing(auth).host.deviceId, physical);
});
