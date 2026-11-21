import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { AccountStore, PRIVATE_OWNER } from './accounts.ts';
import { startRegistrationReceiver, postRegistrationEvent } from './registration-events.ts';

const password = 'isolated-notification-test-42';
const waitFor = async predicate => {
  const end = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > end) throw new Error('Event delivery did not finish'); await new Promise(resolve => setTimeout(resolve, 10)); }
};
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'registration-notices-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, socketPath: path.join(root, 'notices.sock') };
}
const rows = store => store.db.prepare('SELECT id,source,username,email,registered_at AS registeredAt FROM account_registration_outbox').all();

test('account event is atomic with successful registration, contains only notice fields, and excludes login/bootstrap/failure', async t => {
  const { root } = await fixture(t);
  const store = new AccountStore(root); t.after(() => store.close());
  await store.register({ username: 'the_admin', password }, { bootstrap: true, trustedOwner: PRIVATE_OWNER });
  assert.deepEqual(rows(store), []);
  const account = await store.register({ username: 'alice', email: 'alice@example.test', password, role: 'admin', source: 'attacker', owner: PRIVATE_OWNER });
  assert.deepEqual(JSON.parse(JSON.stringify(rows(store))), [{ id: 'registration:shiyan_web:' + account.user.id, source: 'shiyan_web', username: 'alice', email: 'alice@example.test', registeredAt: account.user.createdAt }]);
  await store.login({ username: 'alice', password });
  await assert.rejects(store.register({ username: 'alice', password }), { status: 409 });
  await assert.rejects(store.register({ username: 'unverified', password }, { verifyEmail() { throw new Error('bad code'); } }));
  assert.equal(rows(store).length, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM account_users WHERE username='unverified'").get()!.n, 0);
});

test('offline delivery survives account-store restart and acknowledgement loss replays the same immutable event', async t => {
  const { root, socketPath } = await fixture(t);
  let store = new AccountStore(root, { registrationSocketPath: socketPath });
  const account = await store.register({ username: 'offline_alice', email: 'offline@example.test', password });
  assert.equal(account.ok, true); assert.equal(rows(store).length, 1);
  store.close();
  const persisted = new Map(); let calls = 0;
  const receiver = await startRegistrationReceiver({ socketPath, ingest(event) {
    calls++; persisted.set(event.id, event);
    if (calls === 1) throw new Error('Lost response after durable insert');
  } });
  t.after(() => receiver.close());
  assert.equal((await stat(socketPath)).mode & 0o777, 0o600);
  store = new AccountStore(root, { registrationSocketPath: socketPath }); t.after(() => store.close());
  await waitFor(() => calls === 1 && !store.registrationEvents.running);
  assert.equal(rows(store).length, 1, 'failed acknowledgement must retain the outbox');
  clearTimeout(store.registrationEvents.timer);
  await store.registrationEvents.drain();
  assert.equal(rows(store).length, 0); assert.equal(calls, 2); assert.equal(persisted.size, 1);
  assert.equal([...persisted.values()][0].id, 'registration:shiyan_web:' + account.user.id);
  assert.equal([...persisted.values()][0].email, 'offline@example.test');
});

test('legacy pending outbox migration restores account email once and retains the registration snapshot', async t => {
  const { root } = await fixture(t);
  let store = new AccountStore(root);
  const account = await store.register({ email: 'legacy@example.test', password });
  const eventId = 'registration:shiyan_web:' + account.user.id;
  store.close();
  const legacy = new DatabaseSync(path.join(root, 'accounts.sqlite3'));
  try {
    legacy.exec('DROP TABLE account_registration_outbox; CREATE TABLE account_registration_outbox(id TEXT PRIMARY KEY,source TEXT NOT NULL,username TEXT NOT NULL,registered_at INTEGER NOT NULL)');
    legacy.prepare('INSERT INTO account_registration_outbox VALUES(?,?,?,?)').run(eventId, 'shiyan_web', account.user.username, account.user.createdAt);
  } finally { legacy.close(); }
  store = new AccountStore(root); t.after(() => store.close());
  assert.equal(rows(store)[0].email, 'legacy@example.test');
  assert.equal(rows(store)[0].id, eventId);
  assert.equal(rows(store)[0].registeredAt, account.user.createdAt);
  store.db.prepare('UPDATE account_users SET email=? WHERE id=?').run('changed@example.test', account.user.id);
  assert.equal(rows(store)[0].email, 'legacy@example.test', 'delivery reads the immutable outbox, not the current account email');
});

test('private receiver rejects owner injection, secrets, malformed sources and oversized events before ingest', async t => {
  const { socketPath } = await fixture(t); const received: any[] = [];
  const receiver = await startRegistrationReceiver({ socketPath, ingest: event => received.push(event) }); t.after(() => receiver.close());
  const event = { id: 'registration:shiyan_web:abc', source: 'shiyan_web', username: 'alice', email: 'alice@example.test', registeredAt: Date.now() };
  await postRegistrationEvent(socketPath, event); assert.equal(received.length, 1);
  assert.equal(received[0].email, 'alice@example.test');
  const rawPost = value => new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path: '/registration-events', method: 'POST' }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    request.on('error', reject); request.end(JSON.stringify(value));
  });
  const { email, ...legacyEvent } = event;
  assert.equal(await rawPost(legacyEvent), 200);
  assert.equal(received[1].email, '', 'old senders remain compatible without inventing an email');
  assert.equal(await rawPost({ ...event, owner: 'account:other' }), 400);
  assert.equal(await rawPost({ ...event, password: 'secret' }), 400);
  assert.equal(await rawPost({ ...event, source: 'login' }), 400);
  assert.equal(await rawPost({ ...event, email: 'not-an-email' }), 400);
  assert.equal(await rawPost({ ...event, email: 'alice@example.test\nInjected' }), 400);
  assert.equal(await rawPost({ ...event, email: null }), 400);
  assert.equal(await rawPost({ ...event, username: 'x'.repeat(3000) }), 413);
  assert.equal(received.length, 2);
});
