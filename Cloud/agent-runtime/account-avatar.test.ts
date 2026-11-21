import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { AccountStore, PRIVATE_OWNER } from './accounts.ts';
import { createAccountAvatarHandler } from './account-avatar.ts';

function python(code, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-c', code]), chunks = [];
    child.stdout.on('data', chunk => chunks.push(chunk)); child.stderr.on('data', () => {});
    child.on('error', reject); child.on('close', status => status === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error('fixture failed')));
    child.stdin.end(input);
  });
}
const fixture = async format => (await python(`from PIL import Image\nimport io,sys\nb=io.BytesIO()\nexif=Image.Exif();exif[271]='test-camera';exif[274]=6\nImage.new('RGB',(700,500),'#4174aa').save(b,'${format}',exif=exif)\nsys.stdout.buffer.write(b.getvalue())`)).toString('base64');
const jpeg = await fixture('JPEG'), png = await fixture('PNG');
const password = 'avatar-test-password-2026';

async function setup(t, options = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'shiyan-avatar-test-'));
  const store = new AccountStore(root);
  const a = await store.register({ username: 'avatar-a', password });
  const b = await store.register({ username: 'avatar-b', password });
  const admin = await store.register({ username: 'avatar-admin', password }, { bootstrap: true, trustedOwner: PRIVATE_OWNER });
  const handler = (options.createHandler || createAccountAvatarHandler)({ store, heartbeatMs: 25, ...options });
  const server = http.createServer(async (req, res) => { if (!await handler(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/shiyan/v1/account/avatar`;
  const streams = [];
  t.after(async () => {
    for (const stream of streams) stream.stop();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(root, { recursive: true, force: true });
  });
  async function request(token, method = 'GET', input, suffix = '', headers = {}) {
    const response = await fetch(base + suffix, { method, headers: {
      ...(token ? { Authorization: 'Bearer ' + token } : {}), 'Content-Type': 'application/json', ...headers
    }, ...(input === undefined ? {} : { body: typeof input === 'string' ? input : JSON.stringify(input) }) });
    return { status: response.status, headers: response.headers, body: await response.json() };
  }
  async function subscribe(token) {
    const controller = new AbortController(), events = [], waiters = [];
    let ended = false;
    const response = await fetch(base + '/events', { headers: { Authorization: 'Bearer ' + token }, signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const reading = (async () => {
      let buffer = '';
      try {
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          buffer += Buffer.from(value).toString();
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            if (!frame.includes('event: avatar')) continue;
            const data = frame.split('\n').find(line => line.startsWith('data: '));
            if (data) { events.push(JSON.parse(data.slice(6))); for (const waiter of waiters.splice(0)) waiter(); }
          }
        }
      } catch (error) { if (error.name !== 'AbortError') throw error; }
      finally { ended = true; for (const waiter of waiters.splice(0)) waiter(); }
    })();
    const stream = { events, get ended() { return ended; }, stop() { controller.abort(); }, async until(predicate) {
      const deadline = Date.now() + 2000;
      while (!predicate()) {
        if (Date.now() > deadline) assert.fail('Timed out waiting for avatar SSE');
        await new Promise(resolve => { const timer = setTimeout(resolve, 20); waiters.push(() => { clearTimeout(timer); resolve(); }); });
      }
    }, reading };
    streams.push(stream);
    await stream.until(() => events.length === 1);
    return stream;
  }
  return { store, root, a, b, admin, request, subscribe, base };
}

test('avatar writes are account scoped, persist, and never alter permission revision or sessions', async t => {
  const { store, root, a, b, request } = await setup(t);
  const before = store.authenticate(a.token).user.revision;
  assert.equal((await request(null)).status, 401);
  assert.equal((await request('a'.repeat(43))).status, 401);
  assert.deepEqual((await request(a.token)).body.avatar, { data: null, mimeType: 'image/jpeg', revision: 0, updatedAt: null });
  const saved = await request(a.token, 'PUT', { data: jpeg, expectedRevision: 0 });
  assert.equal(saved.status, 200); assert.equal(saved.body.avatar.revision, 1);
  assert.equal(saved.headers.get('cache-control'), 'no-store');
  assert(saved.body.avatar.updatedAt > 0);
  const decoded = await python("from PIL import Image\nimport sys,io,json\nim=Image.open(io.BytesIO(sys.stdin.buffer.read()))\nprint(json.dumps([im.format,im.size,dict(im.getexif())]))", Buffer.from(saved.body.avatar.data, 'base64'));
  assert.deepEqual(JSON.parse(decoded), ['JPEG', [500, 500], {}]);
  assert.equal((await request(a.token)).body.avatar.data, saved.body.avatar.data);
  assert.equal((await request(b.token, 'GET', undefined, '?userId=' + a.user.id)).body.avatar.data, null);
  assert.equal(store.authenticate(a.token).user.revision, before);
  assert.equal(store.authenticate(b.token).user.revision, 1);
  const reopened = new AccountStore(root);
  try { assert.equal(reopened.db.prepare('SELECT data FROM account_avatars WHERE user_id=?').get(a.user.id).data, saved.body.avatar.data); }
  finally { reopened.close(); }
});

test('invalid, oversized, spoofed and cross-account avatar inputs are rejected', async t => {
  const { a, b, request } = await setup(t);
  for (const input of [ { data: jpeg, userId: b.user.id }, { data: jpeg, owner: 'x' }, { data: jpeg, expectedRevision: -1 },
    { data: jpeg, expectedRevision: true }, { data: 'a=== ' }, { data: '' }, { data: 42 } ])
    assert.equal((await request(a.token, 'PUT', input)).status, 400);
  assert.equal((await request(a.token, 'PUT', { data: png })).status, 422);
  assert.equal((await request(a.token, 'PUT', { data: Buffer.from('fake jpeg').toString('base64') })).status, 422);
  const hugePixels = await python("from PIL import Image\nimport io,sys\nb=io.BytesIO();Image.new('RGB',(5000,5000)).save(b,'JPEG');sys.stdout.buffer.write(b.getvalue())");
  assert.equal((await request(a.token, 'PUT', { data: hugePixels.toString('base64') })).status, 422);
  assert.equal((await request(a.token, 'PUT', { data: jpeg }, '', { 'X-Shiyan-Body-Sha': '0'.repeat(64) })).status, 401);
  assert.equal((await request(a.token, 'PUT', '{bad json')).status, 400);
  assert.equal((await request(a.token, 'PUT', { data: 'A'.repeat(1400000) })).status, 413);
  assert.equal((await request(a.token, 'DELETE', { userId: b.user.id })).status, 405);
  assert.equal((await request(a.token)).body.avatar.revision, 0);
});

test('revision-zero migration is atomic and unsupported deletions preserve the avatar', async t => {
  const { a, request } = await setup(t);
  const responses = await Promise.all([
    request(a.token, 'PUT', { data: jpeg, expectedRevision: 0 }),
    request(a.token, 'PUT', { data: jpeg, expectedRevision: 0 })
  ]);
  assert.deepEqual(responses.map(x => x.status).sort(), [200, 409]);
  assert.equal((await request(a.token, 'DELETE', { expectedRevision: 1 })).status, 405);
  assert.equal((await request(a.token, 'PUT', { data: jpeg, expectedRevision: 0 })).status, 409);
  assert.equal((await request(a.token)).body.avatar.revision, 1);
  assert.equal((await request(a.token, 'PUT', { data: jpeg })).body.avatar.revision, 2);
});

test('SSE shares only the same account, propagates updates and closes revoked sessions', async t => {
  const { store, a, b, admin, request, subscribe } = await setup(t);
  const aSecond = await store.login({ username: 'avatar-a', password });
  const first = await subscribe(a.token), second = await subscribe(aSecond.token), other = await subscribe(b.token);
  await request(a.token, 'PUT', { data: jpeg });
  await Promise.all([first.until(() => first.events.length === 2), second.until(() => second.events.length === 2)]);
  assert.equal(first.events[1].avatar.revision, 1); assert.equal(second.events[1].avatar.data, first.events[1].avatar.data);
  assert.equal(other.events.length, 1);
  await request(a.token, 'PUT', { data: jpeg });
  await first.until(() => first.events.length === 3); assert.equal(first.events[2].avatar.revision, 2);
  store.logout(a.token);
  await first.until(() => first.ended);
  await request(aSecond.token, 'PUT', { data: jpeg });
  await second.until(() => second.events.length === 4);
  assert.equal(first.events.length, 3); assert.equal(other.events.length, 1);
  store.updateUser(store.authenticate(admin.token), b.user.id, { status: 'disabled' });
  await other.until(() => other.ended);
  assert.equal((await request(b.token)).status, 401);
});

test('a revoked login cannot commit after asynchronous image processing', async t => {
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const pendingImage = new Promise(resolve => { release = resolve; });
  const { store, a, request } = await setup(t, { normalizeImage: async () => { started(); return await pendingImage; } });
  const writing = request(a.token, 'PUT', { data: jpeg });
  await ready; store.logout(a.token); release(jpeg);
  assert.equal((await writing).status, 401);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM account_avatars').get().count, 0);
});

test('existing account handler mounts avatar routes and preserves auth/me', async t => {
  const deviceRoot = mkdtempSync(path.join(os.tmpdir(), 'shiyan-avatar-device-test-'));
  process.env.SHIYAN_ROOT = deviceRoot;
  t.after(() => rmSync(deviceRoot, { recursive: true, force: true }));
  const { createAccountHandler } = await import('./account-http.ts');
  const { a, request, base } = await setup(t, { createHandler: createAccountHandler });
  const response = await fetch(base.replace('/account/avatar', '/auth/me'), { headers: { Authorization: 'Bearer ' + a.token } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).user.id, a.user.id);
  assert.equal((await request(a.token, 'PUT', { data: jpeg })).status, 200);
  assert.equal((await request(a.token)).body.avatar.revision, 1);
});
