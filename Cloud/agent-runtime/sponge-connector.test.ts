import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, copyFile, writeFile, rm, lstat, readFile, rename } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createHash, createHmac } from 'node:crypto';

// Test a copy with an explicit account-store fixture. No production account DB,
// network service, secret or member workspace is opened by these tests.
const bundle = await mkdtemp(path.join(os.tmpdir(), 'sponge-audit-module-'));
await copyFile(new URL('./sponge-connector.ts', import.meta.url), path.join(bundle, 'sponge-connector.ts'));
await writeFile(path.join(bundle, 'accounts.ts'), "export function getAccountStore(){throw Error('An account fixture is required');}\n");
const { SpongeConnector, createSpongeServer, prepareSpongeSocket, removeOwnedSpongeSocket } = await import(pathToFileURL(path.join(bundle, 'sponge-connector.ts')).href);
after(() => rm(bundle, { recursive: true, force: true }));
const issuer = 'https://mcp.yandot.ai';
const callback = issuer + '/shiyan/callback';
const sha = value => createHash('sha256').update(value).digest('hex');
const secret = Buffer.alloc(32, 7);
const response = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sponge-connector-audit-'));
  const time = { value: 1800000000000 };
  const accounts = new Map(['A', 'B'].map(owner => [owner, { userId: 'subject-' + owner, owner, status: 'active' }]));
  const sessions = new Set(['session-A', 'session-B']);
  const accountStore = { access: owner => accounts.get(owner), db: { prepare: () => ({ get: (id, subject) => sessions.has(id) && id === 'session-' + subject.slice(-1) ? { id } : undefined }) } };
  const f: any = { directory, time, accounts, sessions, calls: [], intercept: null, nextClient: 0, nextToken: 0, identityOverride: null };
  const access = new Map(), refresh = new Map();
  const normal = (route, body, options) => {
    if (route === '/oauth/register') return response({ client_id: 'client-' + (++f.nextClient), redirect_uris: [callback] });
    if (route === '/oauth/revoke') return response({});
    if (route === '/oauth/token') {
      const subject = body.grant_type === 'authorization_code' ? 'subject-' + body.code.slice(-1) : refresh.get(body.refresh_token);
      const id = ++f.nextToken, tokens = { token_type: 'Bearer', access_token: 'access-' + id, refresh_token: 'refresh-' + id, expires_in: 3600 };
      access.set(tokens.access_token, subject); refresh.set(tokens.refresh_token, subject);
      return response(tokens);
    }
    if (route === '/mcp') {
      const subject = access.get(options.headers.Authorization.slice(7));
      if (body.params.name === 'who_am_i') return response({ result: { structuredContent: { accountId: f.identityOverride || 'shiyan_' + sha(subject), devices: [] } } });
      if (body.method === 'tools/list') return response({ result: { tools: [{ name: 'list_devices', inputSchema: { type: 'object' } }] } });
      return response({ result: { content: [{ type: 'text', text: 'owned-result' }] } });
    }
    throw Error('Unexpected fixture route: ' + route);
  };
  f.connector = new SpongeConnector({ directory, secret, accountStore, now: () => time.value,
    fetchImpl: async (url, options) => {
      const route = new URL(url).pathname, body = JSON.parse(options.body);
      f.calls.push({ route, body, authorization: options.headers.Authorization });
      const intercepted = f.intercept ? await f.intercept(route, body, options, () => normal(route, body, options)) : undefined;
      return intercepted === undefined ? normal(route, body, options) : intercepted;
    },
  });
  f.auth = owner => ({ owner, userId: 'subject-' + owner, sessionId: 'session-' + owner, accountSession: true });
  f.begin = async (owner = 'A') => {
    const started = await f.connector.start(f.auth(owner)), url = new URL(started.authorizeUrl);
    return { url, state: url.searchParams.get('state'), code: 'code-' + owner, iss: issuer };
  };
  f.connect = async (owner = 'A') => { const flow = await f.begin(owner); await f.connector.complete(flow); return flow; };
  f.expire = owner => f.connector.db.prepare('UPDATE connections SET expires_at=? WHERE owner=?').run(time.value, owner);
  t.after(async () => { f.connector.close(); await rm(directory, { recursive: true, force: true }); });
  return f;
}

test('broker ticket binds subject, registered callback, random state and PKCE without leaking verifier', async t => {
  const f = await fixture(t), flow = await f.begin();
  const [payload, signature] = flow.url.searchParams.get('shiyan_ticket').split('.');
  assert.equal(signature, createHmac('sha256', secret).update(payload).digest('base64url'));
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString());
  const stored = f.connector.db.prepare('SELECT * FROM flows WHERE state_hash=?').get(sha(flow.state));
  assert.equal(decoded.subject, 'subject-A'); assert.equal(decoded.redirectUri, callback);
  assert.equal(decoded.clientId, stored.client_id); assert.equal(decoded.stateHash, sha(flow.state));
  assert.equal(decoded.challenge, createHash('sha256').update(stored.verifier).digest('base64url'));
  assert.equal(decoded.expiresAt, f.time.value + 300000); assert.equal(decoded.v, 1);
  assert.equal(flow.url.href.includes(stored.verifier), false);
  const completed = await f.connector.complete(flow);
  assert.deepEqual(completed, { ok: true, connected: true });
  assert.equal(JSON.stringify(completed).includes('access-'), false);
  await assert.rejects(f.connector.complete(flow), /已处理/);
});

test('standalone Sponge identities cannot associate, and their issued grant is revoked', async t => {
  const f = await fixture(t), flow = await f.begin();
  f.identityOverride = 'account_independent';
  await assert.rejects(f.connector.complete(flow), { status: 403 });
  assert.equal(f.connector._row('A').token_json, null);
  assert.equal(f.calls.filter(call => call.route === '/oauth/revoke').length, 1);
});

test('logging out invalidates both pending callback and a start delayed in registration', async t => {
  const f = await fixture(t), registered = deferred(), release = deferred();
  f.intercept = async (route, body, options, normal) => {
    if (route === '/oauth/register') { registered.resolve(); await release.promise; return normal(); }
  };
  const pending = f.connector.start(f.auth('A'));
  await registered.promise; f.sessions.delete('session-A'); release.resolve();
  await assert.rejects(pending, { status: 401 });
  assert.equal(f.connector.db.prepare('SELECT COUNT(*) AS n FROM flows').get().n, 0);
  f.intercept = null; f.sessions.add('session-A'); const flow = await f.begin();
  f.sessions.delete('session-A');
  await assert.rejects(f.connector.complete(flow), { status: 400 });
  assert.equal(f.connector._row('A').token_json, null);
});

test('disconnect during callback prevents a late token response restoring credentials', async t => {
  const f = await fixture(t), flow = await f.begin(), exchanged = deferred(), release = deferred();
  f.intercept = async (route, body, options, normal) => {
    if (route === '/oauth/token') { exchanged.resolve(); await release.promise; return normal(); }
  };
  const completing = f.connector.complete(flow);
  await exchanged.promise; await f.connector.disconnect('A'); release.resolve();
  await assert.rejects(completing, { status: 409 });
  assert.equal(f.connector._row('A').token_json, null);
  assert.equal(f.calls.filter(call => call.route === '/oauth/revoke').length, 1);
});

test('account disable blocks device execution even if it occurs during identity verification', async t => {
  const f = await fixture(t); await f.connect();
  const identity = deferred(), release = deferred();
  f.intercept = async (route, body, options, normal) => {
    if (route === '/mcp' && body.params.name === 'who_am_i') { identity.resolve(); await release.promise; return normal(); }
  };
  const executing = f.connector.rpc('A', 'tools/call', { name: 'start_process', arguments: {} });
  await identity.promise; f.accounts.get('A').status = 'disabled'; release.resolve();
  await assert.rejects(executing, { status: 403 });
  assert.equal(f.calls.some(call => call.body.params?.name === 'start_process'), false);
});

test('parallel operations share one refresh rotation and owner B cannot reuse owner A state', async t => {
  const f = await fixture(t); await f.connect('A'); await f.connect('B'); f.expire('A');
  const results = await Promise.all([f.connector.rpc('A', 'tools/list'), f.connector.rpc('A', 'tools/list')]);
  assert.equal(results.length, 2);
  assert.equal(f.calls.filter(call => call.route === '/oauth/token' && call.body.grant_type === 'refresh_token').length, 1);
  assert.equal(f.connector._row('B').revision, 2);
  await f.connector.disconnect('A');
  assert.equal((await f.connector.status('B')).connected, true);
});

test('an uncertain refresh response clears the old refresh token instead of replaying it', async t => {
  const f = await fixture(t); await f.connect(); f.expire('A');
  f.intercept = async (route, body) => { if (route === '/oauth/token' && body.grant_type === 'refresh_token') throw Error('connection lost after rotation'); };
  await assert.rejects(f.connector.rpc('A', 'tools/list'), { status: 503 });
  assert.equal(f.connector._row('A').token_json, null);
  await assert.rejects(f.connector.rpc('A', 'tools/list'), { status: 409 });
  assert.equal(f.calls.filter(call => call.route === '/oauth/token' && call.body.grant_type === 'refresh_token').length, 1);
});

test('disconnect during refresh rejects late credentials and revokes the newly issued family token', async t => {
  const f = await fixture(t); await f.connect(); f.expire('A');
  const rotating = deferred(), release = deferred();
  f.intercept = async (route, body, options, normal) => {
    if (route === '/oauth/token' && body.grant_type === 'refresh_token') { rotating.resolve(); await release.promise; return normal(); }
  };
  const pending = f.connector.rpc('A', 'tools/list');
  await rotating.promise; await f.connector.disconnect('A'); release.resolve();
  await assert.rejects(pending, { status: 409 });
  assert.equal(f.connector._row('A').token_json, null);
  const revoked = f.calls.filter(call => call.route === '/oauth/revoke').map(call => call.body.token);
  assert.deepEqual(revoked, ['refresh-1', 'refresh-2']);
});

test('DCR cache ages out, legacy records re-register, and parallel begins register once', async t => {
  const f = await fixture(t);
  await Promise.all([f.begin('A'), f.begin('B')]);
  assert.equal(f.nextClient, 1);
  await f.begin('A'); assert.equal(f.nextClient, 1);
  assert.equal(f.connector.clientPromise, null);
  f.time.value += 21 * 3600000;
  await Promise.all([f.begin('A'), f.begin('B')]); assert.equal(f.nextClient, 2);
  const saved = JSON.parse(f.connector.db.prepare("SELECT value FROM settings WHERE name='client'").get().value);
  delete saved.createdAt;
  f.connector.db.prepare("UPDATE settings SET value=? WHERE name='client'").run(JSON.stringify(saved));
  await f.begin(); assert.equal(f.nextClient, 3);
});

test('new DCR registration revokes existing connection using that grant’s original client id', async t => {
  const f = await fixture(t); await f.connect();
  const old = JSON.parse(f.connector._row('A').token_json);
  f.time.value += 21 * 3600000;
  const flow = await f.begin();
  assert.notEqual(flow.url.searchParams.get('client_id'), old.client_id);
  const revoke = f.calls.filter(call => call.route === '/oauth/revoke').at(-1);
  assert.equal(revoke.body.client_id, old.client_id); assert.equal(revoke.body.token, old.refresh_token);
});

test('global DCR rotation leaves another owner’s refresh bound to its original client', async t => {
  const f = await fixture(t); await f.connect('A');
  const old = JSON.parse(f.connector._row('A').token_json);
  f.time.value += 21 * 3600000;
  const newer = await f.begin('B');
  assert.notEqual(newer.url.searchParams.get('client_id'), old.client_id);
  await f.connector.rpc('A', 'tools/list');
  const rotated = f.calls.filter(call => call.route === '/oauth/token' && call.body.grant_type === 'refresh_token').at(-1);
  assert.equal(rotated.body.client_id, old.client_id);
  assert.equal(JSON.parse(f.connector._row('A').token_json).client_id, old.client_id);
});

test('fixed transport disallows public/custom targets and Unix start/disconnect match client result envelope', async t => {
  for (const transportBase of ['https://example.com', 'http://10.8.2.3', 'http://user:pass@127.0.0.1']) assert.throws(() => new SpongeConnector({ secret, transportBase }), /fixed loopback/);
  const connector = { start: async () => ({ ok: true, authorizeUrl: issuer + '/oauth/authorize' }), disconnect: async () => ({ ok: true, connected: false }), complete: async () => ({ ok: true, connected: true }) };
  const server = createSpongeServer(connector);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const post = async route => await (await fetch('http://127.0.0.1:' + server.address().port + route, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } })).json();
  assert.deepEqual(await post('/start'), { ok: true, result: { ok: true, authorizeUrl: issuer + '/oauth/authorize' } });
  assert.deepEqual(await post('/disconnect'), { ok: true, result: { ok: true, connected: false } });
  assert.deepEqual(await post('/complete'), { ok: true, connected: true });
});

const staleSocket = socketPath => promisify(execFile)('/usr/bin/python3', ['-c', 'import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); s.close()', socketPath]);

test('startup refuses a live socket and preserves its usable listener', async t => {
  const f = await fixture(t), socketPath = path.join(f.directory, 'live.sock');
  const server = net.createServer(socket => { socket.on('error', () => {}); socket.end('live'); });
  await new Promise<void>(resolve => server.listen(socketPath, () => resolve()));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const before = await lstat(socketPath);
  await assert.rejects(prepareSpongeSocket(socketPath), /already listening/);
  assert.equal((await lstat(socketPath)).ino, before.ino);
  const value = await new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath }); let text = '';
    socket.on('data', data => { text += data; }); socket.once('end', () => resolve(text)); socket.once('error', reject);
  });
  assert.equal(value, 'live');
});

test('startup removes only a refused stale socket and never overwrites an ordinary file', async t => {
  const f = await fixture(t), socketPath = path.join(f.directory, 'stale.sock');
  await staleSocket(socketPath);
  assert.equal((await lstat(socketPath)).isSocket(), true);
  await prepareSpongeSocket(socketPath);
  await assert.rejects(lstat(socketPath), { code: 'ENOENT' });
  await writeFile(socketPath, 'keep');
  await assert.rejects(prepareSpongeSocket(socketPath), /non-socket/);
  assert.equal(await readFile(socketPath, 'utf8'), 'keep');
});

test('shutdown leaves a replacement socket intact and removes only its owned inode', async t => {
  const f = await fixture(t), socketPath = path.join(f.directory, 'owned.sock');
  await staleSocket(socketPath); const old = await lstat(socketPath);
  await rename(socketPath, socketPath + '.previous'); await staleSocket(socketPath);
  const replacement = await lstat(socketPath);
  assert.notEqual(replacement.ino, old.ino);
  assert.equal(await removeOwnedSpongeSocket(socketPath, old), false);
  assert.equal((await lstat(socketPath)).ino, replacement.ino);
  assert.equal(await removeOwnedSpongeSocket(socketPath, replacement), true);
  assert.equal(await removeOwnedSpongeSocket(socketPath, replacement), false);
});
