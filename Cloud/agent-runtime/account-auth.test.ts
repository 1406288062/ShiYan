import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync, createHash, randomUUID, sign } from 'node:crypto';

const root = mkdtempSync(path.join(os.tmpdir(), 'shiyan-accounts-test-'));
process.env.SHIYAN_ROOT = root;
const { AccountStore, PRIVATE_OWNER, getAccountStore } = await import('./accounts.ts');
const { RegistrationEmail } = await import('./registration-email.ts');
const { createAccountHandler } = await import('./account-http.ts');
const { authenticateDevice, authenticateLegacyDevice } = await import('./device-auth.ts');
const { SyncStore } = await import('./sync-store.ts');
const { MemoryStore } = await import('./memory-store.ts');
const { sendSyncAsset } = await import('./sync-asset-response.ts');
const password = 'test-only-password-42';
const hash = (value: any) => createHash('sha256').update(value).digest('hex');
const storeFor = (t: any) => { const store = new AccountStore(path.join(root, randomUUID())); t.after(() => store.close()); return store; };
const bootstrap = (store: any) => store.register({ email: 'owner@example.test', password, display_name: '管理员' }, { bootstrap: true, trustedOwner: PRIVATE_OWNER });
const register = (store: any, email = 'member@example.test') => store.register({ email, password });

test.after(() => { getAccountStore().close(); rmSync(root, { recursive: true, force: true }); });

test('optional blank display names work for registration and trusted administrator binding', async t => {
  const store = storeFor(t);
  const member = await store.register({ email: 'member@example.test', password, display_name: '' });
  const owner = await store.register({ email: 'owner@example.test', password, displayName: '   ' }, { bootstrap: true, trustedOwner: PRIVATE_OWNER });
  assert.equal(member.user.displayName, 'member');
  assert.equal(owner.user.displayName, 'owner');
  assert.equal(owner.user.role, 'admin');
});

test('authenticated full and partial asset downloads cannot remain in shared account HTTP caches', () => {
  const bytes = Buffer.from('private asset'), asset = { metadata: { mimeType: 'text/plain', filename: 'private.txt' } };
  for (const query of ['', '?offset=1&length=3']) {
    let status, headers, body;
    const response = { writeHead(code: any, values: any) { status = code; headers = values; }, end(value: any) { body = value; } };
    sendSyncAsset(response, new URL('http://localhost/asset' + query), asset, bytes);
    assert.equal(headers!['Cache-Control'], 'no-store');
    assert.equal(status, query ? 206 : 200);
    assert.deepEqual(body, query ? bytes.subarray(1, 4) : bytes);
  }
});

test('registration scopes every account and stores only salted password hashes and token digests', async t => {
  const store = storeFor(t);
  const a = await store.register({ email: 'Member@Example.Test', password, role: 'admin', owner: PRIVATE_OWNER, serverAccess: true });
  const b = await register(store, 'second@example.test');
  assert.equal(a.user.role, 'user'); assert.equal(a.user.serverAccess, false);
  assert.notEqual(a.user.owner, b.user.owner); assert.notEqual(a.user.owner, PRIVATE_OWNER);
  assert.equal(a.user.email, 'member@example.test'); assert.equal(store.bootstrapRequired(), true);
  const raw = JSON.stringify(store.db.prepare('SELECT * FROM account_users').all()) + JSON.stringify(store.db.prepare('SELECT * FROM account_sessions').all());
  assert(!raw.includes(password)); assert(!raw.includes(a.token));
  const users = store.db.prepare('SELECT password_hash,password_salt FROM account_users').all();
  assert.notEqual(users[0].password_hash, users[1].password_hash); assert.notEqual(users[0].password_salt, users[1].password_salt);
  assert.equal(store.authenticate(a.token)!.owner, a.user.owner);
  assert.equal(store.authenticate(a.token + 'a'), null);
});

test('only verified original owner can bootstrap and duplicate concurrent claims are atomic', async t => {
  const store = storeFor(t);
  await register(store);
  await assert.rejects(store.register({ email: 'admin@example.test', password }, { bootstrap: true, trustedOwner: 'other' }), { status: 403 });
  const results = await Promise.allSettled([bootstrap(store), bootstrap(store)]);
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
  const admin = results.find(value => value.status === 'fulfilled')!.value;
  assert.equal(admin.user.owner, PRIVATE_OWNER); assert.equal(admin.user.role, 'admin'); assert.equal(admin.user.serverAccess, true);
  assert.equal(store.bootstrapRequired(), false);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM account_users WHERE role='admin'").get()!.count, 1);
});

test('login aliases, password verification, expiry and logout enforce session boundaries', async t => {
  let now = 1000000;
  const store = new AccountStore(path.join(root, randomUUID()), { now: () => now, sessionDays: 1 }); t.after(() => store.close());
  const initial = await register(store);
  await assert.rejects(store.login({ email: initial.user.email, password: 'wrong-password' }), { status: 401 });
  const login = await store.login({ email: 'MEMBER@EXAMPLE.TEST', password });
  assert.equal(store.authenticate(login.token)!.userId, initial.user.id);
  store.logout(login.token); assert.equal(store.authenticate(login.token), null);
  assert(store.authenticate(initial.token)); now += 86400001; assert.equal(store.authenticate(initial.token), null);
  assert.equal(store.authenticate('not-a-token'), null);
});

test('admin permissions require current server role, revoke sessions and preserve original administrator', async t => {
  const store = storeFor(t), admin = await bootstrap(store), member = await register(store);
  const auth = store.authenticate(admin.token), userAuth = store.authenticate(member.token);
  assert.throws(() => store.listUsers(userAuth), { status: 403 });
  assert.throws(() => store.updateUser({ ...userAuth, role: 'admin' }, admin.user.id, { status: 'disabled' }), { status: 403 });
  assert.throws(() => store.updateUser(auth, admin.user.id, { status: 'disabled' }), { status: 409 });
  assert.throws(() => store.updateUser(auth, admin.user.id, { role: 'user' }), { status: 409 });
  assert.throws(() => store.updateUser(auth, admin.user.id, { serverAccess: false }), { status: 409 });
  assert.throws(() => store.updateUser(auth, member.user.id, { serverAccess: true }), { status: 400 });
  const promoted = store.updateUser(auth, member.user.id, { role: 'admin', serverAccess: true, revision: member.user.revision });
  assert.equal(promoted.sessionsRevoked, true); assert.equal(store.authenticate(member.token), null);
  assert.equal(store.access(member.user.owner).serverAccess, true);
  assert.throws(() => store.updateUser(auth, member.user.id, { status: 'disabled', revision: member.user.revision }), { status: 409 });
  const refreshed = await store.login({ identifier: member.user.email, password });
  assert.equal(store.listUsers(store.authenticate(refreshed.token)).users.length, 2);
  store.updateUser(auth, member.user.id, { status: 'disabled' });
  assert.equal(store.authenticate(refreshed.token), null); assert.equal(store.access(member.user.owner).serverAccess, false);
  assert.throws(() => store.listUsers({ ...userAuth, role: 'admin' }), { status: 403 });
  await assert.rejects(store.login({ identifier: member.user.email, password }), { status: 401 });
});

test('account disablement during password calculation cannot create a new session', async t => {
  const store = storeFor(t), admin = await bootstrap(store), member = await register(store);
  const pending = store.login({ email: member.user.email, password });
  store.updateUser(store.authenticate(admin.token), member.user.id, { status: 'disabled' });
  await assert.rejects(pending, { status: 401 });
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM account_sessions WHERE user_id=?').get(member.user.id)!.count, 0);
});

test('administrator without server access cannot grant that permission to self or another account', async t => {
  const store=storeFor(t),owner=await bootstrap(store),limited=await register(store),other=await register(store,'other@example.test');
  store.updateUser(store.authenticate(owner.token),limited.user.id,{role:'admin',serverAccess:false});
  const session=await store.login({email:limited.user.email,password}),auth=store.authenticate(session.token);
  assert.equal(auth!.role,'admin');assert.equal(auth!.serverAccess,false);
  assert.throws(()=>store.updateUser(auth,limited.user.id,{serverAccess:true}),{status:403});
  assert.throws(()=>store.updateUser(auth,other.user.id,{role:'admin',serverAccess:true}),{status:403});
  assert.equal(store.access(other.user.owner).role,'user');
  store.updateUser(auth,other.user.id,{status:'disabled'});
  assert.equal(store.access(other.user.owner).status,'disabled');
});

test('same object IDs never cross account sync, memory or attachment boundaries', async t => {
  const accounts = storeFor(t), a = await register(accounts), b = await register(accounts, 'b@example.test');
  const data = path.join(root, randomUUID()), sync = new SyncStore(data), memories = new MemoryStore(data);
  t.after(() => { sync.close(); memories.close(); });
  const id = randomUUID();
  sync.putAuthoritative(a.user.owner, 'projects', id, { id, name: 'Account A private' });
  assert.equal(sync.get(b.user.owner, 'projects', id), null);
  assert.equal(sync.list(b.user.owner).changes.length, 0);
  memories.create(a.user.owner, { content: '这是甲用户的私人偏好', category: 'preference' });
  assert.equal(memories.list(b.user.owner).memories.length, 0);
  sync.saveAsset(a.user.owner, { id, filename: 'private.txt', mimeType: 'text/plain', data: Buffer.from('only-account-a').toString('base64') });
  assert.equal(sync.asset(b.user.owner, id), null); assert.equal(sync.assetFile(b.user.owner, id), null);
});

test('HTTP routes reject anonymous admin, invalid hashes and forged bootstrap; support new-device sessions', async t => {
  const store = storeFor(t);
  const codes = new Map();
  const registrationEmail = new RegistrationEmail(store, {configured:()=>true, send:async message=>{codes.set(message.to,message.text.match(/\d{6}/)[0]);}});
  const handler = createAccountHandler({ store, registrationEmail, authenticateLegacy: req => req.headers['x-test-trusted'] === 'yes' ? { owner: PRIVATE_OWNER, deviceID: 'test', platform: 'test' } : null });
  const server = http.createServer(async (req, res) => { if (!await handler(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve())); t.after(() => new Promise(resolve => server.close(resolve)));
  const url = 'http://127.0.0.1:' + (server.address() as any).port;
  const request = (route: any, method = 'GET', data?: any, headers = {}) => fetch(url + '/shiyan/v1/' + route, { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  let response = await request('auth/status'); assert.deepEqual(await response.json(), { ok: true, registrationEnabled: true, bootstrapRequired: true, canBootstrap: false, emailVerificationRequired: true, emailDeliveryAvailable: true });
  response = await request('admin/users'); assert.equal(response.status, 401);
  response = await request('auth/bootstrap', 'POST', { email: 'owner@example.test', password }); assert.equal(response.status, 403);
  response = await request('auth/register', 'POST', { email: 'a@example.test', password }, { 'x-shiyan-body-sha': '0'.repeat(64) }); assert.equal(response.status, 401);
  response = await request('auth/register', 'POST', { email: 'a@example.test', password }); assert.equal(response.status, 400);
  response = await request('auth/register-code', 'POST', { email: 'a@example.test' }); assert.equal(response.status, 200);
  response = await request('auth/register', 'POST', { email: 'a@example.test', password, verificationCode:codes.get('a@example.test') }); assert.equal(response.status, 201);
  const account: any = await response.json(), bearer = { Authorization: 'Bearer ' + account.token };
  response = await request('auth/me', 'GET', undefined, bearer); assert.equal(((await response.json()) as any).user.id, account.user.id);
  response = await request('admin/users', 'GET', undefined, bearer); assert.equal(response.status, 403);
  response = await request('auth/register-code', 'POST', { email: 'owner@example.test' }); assert.equal(response.status, 200);
  response = await request('auth/bootstrap', 'POST', { email: 'owner@example.test', password, verificationCode:codes.get('owner@example.test') }, { 'x-test-trusted': 'yes' }); assert.equal(response.status, 201);
  response = await request('auth/logout', 'POST', {}, bearer); assert.equal(response.status, 200);
  response = await request('auth/me', 'GET', undefined, bearer); assert.equal(response.status, 401);
  response = await request('auth/me', 'GET', undefined, { Cookie: 'shiyan_session=' + account.token }); assert.equal(response.status, 401);
});

test('signed owner bootstrap disables legacy fallback, including invalid-token and logout requests', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32), id = hash(raw);
  writeFileSync(path.join(root, 'devices.json'), JSON.stringify({ [id]: { id, publicKey: raw.toString('base64'), owner: PRIVATE_OWNER, approved: true } }));
  const signed = () => {
    const method = 'GET', url = '/shiyan/v1/sync', time = String(Date.now()), nonce = randomUUID(), bodyHash = hash('');
    return { method, url, headers: { 'x-shiyan-device': id, 'x-shiyan-time': time, 'x-shiyan-nonce': nonce, 'x-shiyan-body-sha': bodyHash,
      'x-shiyan-signature': sign(null, Buffer.from([method, url, time, nonce, bodyHash].join('\n')), privateKey).toString('base64') } };
  };
  assert.equal(authenticateDevice(signed()).owner, PRIVATE_OWNER);
  const invalid = signed(); (invalid.headers as any).authorization = 'Bearer ' + 'x'.repeat(43); assert.equal(authenticateDevice(invalid), null);
  const required = signed(); (required.headers as any)['x-shiyan-account-required'] = '1'; assert.equal(authenticateDevice(required), null);
  const replay = signed(); assert(authenticateLegacyDevice(replay)); assert.equal(authenticateLegacyDevice(replay), null);
  const store = getAccountStore(), admin = await bootstrap(store);
  assert.equal(authenticateDevice(signed()), null);
  const active = signed(); (active.headers as any).authorization = 'Bearer ' + admin.token;
  assert.equal(authenticateDevice(active).owner, PRIVATE_OWNER);
  store.logout(admin.token); assert.equal(authenticateDevice(active), null); assert.equal(authenticateDevice(signed()), null);
  assert(!readFileSync(path.join(root, 'data/accounts.sqlite3')).includes(Buffer.from(password)));
});
