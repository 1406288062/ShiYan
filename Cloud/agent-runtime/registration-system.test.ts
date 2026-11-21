// Both real signup routes, the private socket and the real Dots runtime. All
// databases, sockets, accounts and messages live under one temporary directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { AccountStore, PRIVATE_OWNER } from './accounts.ts';
import { createAccountHandler } from './account-http.ts';
import { DotsAdapter, createLocalDotsClient } from './dots-adapter.ts';
import { createDotsSidecar } from './dots-sidecar.ts';
import { postRegistrationEvent } from './registration-events.ts';
import { createApp as createSpongeApp } from '../../../yu-remote-commander/src/server.mjs';

const password = 'isolated-system-test-password-42';
const waitFor = async predicate => {
  const deadline = Date.now() + 12000;
  while (!await predicate()) { if (Date.now() > deadline) throw new Error('Isolated registration integration timed out'); await new Promise(resolve => setTimeout(resolve, 20)); }
};
const listen = async server => { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return 'http://127.0.0.1:' + server.address().port; };
const closeServer = async server => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
const post = (url, input, headers = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(input) });
async function freePort() { const server = net.createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve())); const port = (server.address() as any).port; await new Promise(resolve => server.close(resolve)); return port; }

test('concurrent notice delivery waits past an older shared activity sync before acknowledgement',async()=>{
  let release,cursor=0,inflight,syncCalls=0;const gate=new Promise(resolve=>{release=resolve;});
  const adapter={authorize(value){assert.equal(value,PRIVATE_OWNER);},clientFor(value){assert.equal(value,PRIVATE_OWNER);return{rpc:async(method,event)=>{assert.equal(method,'dots/internal/registration');return{activityCursor:event.order,message:{id:event.order}};}};},
    store:{manager(value){assert.equal(value,PRIVATE_OWNER);return{runtime_cursor:cursor};}},managerSnapshot:async()=>{},
    async syncManagerActivity(value){assert.equal(value,PRIVATE_OWNER);if(inflight)return inflight;const number=++syncCalls;const next=number===1?gate.then(()=>{cursor=1;}):Promise.resolve().then(()=>{cursor=2;});inflight=next;try{await next;}finally{if(inflight===next)inflight=null;}}
  };
  const first=DotsAdapter.prototype.registrationNotice.call(adapter,{order:1});await new Promise(resolve=>setImmediate(resolve));
  let secondAcknowledged=false;const second=DotsAdapter.prototype.registrationNotice.call(adapter,{order:2}).then(value=>{secondAcknowledged=true;return value;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(secondAcknowledged,false);release();
  await Promise.all([first,second]);assert.equal(cursor,2);assert.equal(syncCalls,2);assert.equal(secondAcknowledged,true);
});

test('both website signup routes push one admin Dots message, reconnect replays it, and ordinary accounts cannot obtain it', { timeout: 45000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'registration-system-'));
  const shiyanRoot = path.join(root, 'shiyan'), runtimeRoot = path.join(root, 'runtime'), socketPath = path.join(root, 'registration.sock');
  let runtime, accounts, accountServer, sponge, dots, reader, readLoop, db;
  let runtimeOutput = '';
  try {
    accounts = new AccountStore(path.join(shiyanRoot, 'data'), { registrationSocketPath: socketPath });
    const administrator = await accounts.register({ username: 'private_admin', password }, { bootstrap: true, trustedOwner: PRIVATE_OWNER });
    const port = await freePort();
    const runtimeEnv = { ...process.env,
      DOTS_ROOT: runtimeRoot, DOTS_PORT: String(port), DOTS_TOKEN: 'isolated-test-only-token',
      SHIYAN_ROOT: shiyanRoot, SHIYAN_MEMORY_DATA: path.join(shiyanRoot, 'data'),
      DOTS_REGISTRATION_SOCKET: socketPath, DOTS_LOOP_MS: '600000' };
    const runtimeSocket = path.join(runtimeRoot, 'local-ipc', 'mcp.sock');
    const startRuntime = async () => {
      runtime = spawn(process.execPath, ['/home/ubuntu/dots-runtime/server.mjs'], { env: runtimeEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      runtime.stdout.on('data', data => { runtimeOutput += data; }); runtime.stderr.on('data', data => { runtimeOutput += data; });
      await waitFor(async () => { if (runtime.exitCode !== null) throw new Error('Isolated Dots startup failed: ' + runtimeOutput); try { await access(runtimeSocket); return true; } catch { return false; } });
    };
    await startRuntime();
    const client = createLocalDotsClient({ socketPath: runtimeSocket });
    const makeDots = async () => {
      const adapter = new DotsAdapter({ root: path.join(root, 'gateway'), client,
        eventReader: { read: () => [], request(){return null;}, close() {} },
        activityReader: { read: () => [], close() {} } as any, recoverIntervalMs: 0, subscriptionRefreshMs: 0, managerPollMs: 0, schedulePollMs: 0 });
      const server: any = createDotsSidecar({ root: shiyanRoot, adapter, recover: false, registrationSocket: socketPath,
        authenticate: req => accounts.authenticate((req.headers.authorization || '').replace(/^Bearer /, '')) });
      const base = await listen(server); await server.registrationReady; return { server, adapter, base };
    };
    dots = await makeDots();
    const email = { configured: () => true, request: async () => ({ ok: true }), check: input => () => {
      if (input.code !== 'fixture-code') throw Object.assign(new Error('Invalid test verification code'), { status: 400 });
    } };
    const handler = createAccountHandler({ store: accounts, registrationEmail: email });
    accountServer = http.createServer((req, res) => { void handler(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end(); } }); });
    const accountBase = await listen(accountServer);
    sponge = await createSpongeApp({ port: 0, dataDir: path.join(root, 'sponge'), publicUrl: 'http://127.0.0.1:4341', registrationSocketPath: socketPath });
    const spongeAddress = await sponge.listen(), spongeBase = 'http://127.0.0.1:' + spongeAddress.port;
    const headers = { Authorization: 'Bearer ' + administrator.token };
    const stream = await fetch(dots.base + '/v1/dots/events?after=0', { headers });
    assert.equal(stream.status, 200); reader = stream.body!.getReader(); let streamed = '';
    readLoop = (async () => { try { while (true) { const item = await reader.read(); if (item.done) break; streamed += new TextDecoder().decode(item.value); } } catch {} })();
    assert.equal((await post(accountBase + '/v1/auth/register-code', { email: 'fixture@example.test' })).status, 200);
    assert.equal((await post(accountBase + '/v1/auth/register', { email: 'failed@example.test', password, code: 'bad' })).status, 400);
    const registeredEmail = 'fixture@example.test';
    const shiyanResponse = await post(accountBase + '/v1/auth/register', { email: registeredEmail, password, code: 'fixture-code', role: 'admin' });
    assert.equal(shiyanResponse.status, 201); const alice: any = await shiyanResponse.json();
    assert.match(alice.user.username, /^u_/);
    const spongeResponse = await post(spongeBase + '/api/auth/register', { username: 'sponge_bob', password, role: 'owner' });
    assert.equal(spongeResponse.status, 201); assert.equal(((await spongeResponse.json()) as any).account.role, 'user');
    await waitFor(() => streamed.includes('用户名：' + registeredEmail) && streamed.includes('海绵宝宝 MCP 官网') && streamed.includes('用户名：sponge_bob'));
    await waitFor(() => accounts.db.prepare('SELECT COUNT(*) AS n FROM account_registration_outbox').get().n === 0 && Object.keys(sponge.auth.state.registrationEvents).length === 0);
    assert.match(streamed, /拾燕网页端/); assert.match(streamed, /海绵宝宝 MCP 官网/);
    db = new DatabaseSync(path.join(runtimeRoot, 'data', 'dots.sqlite3'));
    const messages = () => db.prepare("SELECT * FROM manager_messages WHERE proactive_reason='管理员注册提醒' ORDER BY id").all();
    assert.equal(messages().length, 2); assert(messages().every(row => row.role === 'assistant' && row.origin === 'proactive' && !row.task_id));
    const shiyanMessage = messages().find(row => row.content.includes('拾燕网页端'));
    const spongeMessage = messages().find(row => row.content.includes('海绵宝宝 MCP 官网'));
    assert(shiyanMessage.content.includes('用户名：' + registeredEmail));
    assert(!shiyanMessage.content.includes(alice.user.username), 'notice displays the real email instead of the generated internal username');
    assert(!shiyanMessage.content.includes('邮箱：'));
    assert.match(spongeMessage.content, /用户名：sponge_bob/);
    assert(!spongeMessage.content.includes('未提供'));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM manager_inbox').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM goals').get().n, 0);
    const notices = db.prepare('SELECT event_id AS id,source,username,email,registered_at AS registeredAt FROM manager_registration_notices').all();
    for (const notice of notices) await postRegistrationEvent(socketPath, notice);
    assert.equal(messages().length, 2, 'duplicate delivery must not display twice');
    assert.equal((await post(accountBase + '/v1/auth/login', { email: registeredEmail, password: 'incorrect-fixture-password' })).status, 401);
    assert.equal((await post(accountBase + '/v1/auth/login', { email: registeredEmail, password })).status, 200);
    assert.equal((await post(spongeBase + '/api/auth/login', { username: 'sponge_bob', password })).status, 200);
    assert.equal(messages().length, 2);
    const memberHeaders = { Authorization: 'Bearer ' + alice.token };
    const memberManager = await (await fetch(dots.base + '/v1/dots/manager?owner=' + PRIVATE_OWNER, { headers: memberHeaders })).json();
    assert(!JSON.stringify(memberManager).includes('sponge_bob')); assert(!JSON.stringify(memberManager).includes('管理员注册提醒'));
    assert(!JSON.stringify(memberManager).includes(registeredEmail));
    const memberEvents = await (await fetch(dots.base + '/v1/dots/notifications?owner=' + PRIVATE_OWNER, { headers: memberHeaders })).json();
    assert(!JSON.stringify(memberEvents).includes('sponge_bob')); assert(!JSON.stringify(memberEvents).includes(registeredEmail));
    assert.equal((await post(dots.base + '/registration-events', notices[0], memberHeaders)).status, 404);
    const subscribeInput = { enabled: true, source: 'registrations', owner: PRIVATE_OWNER };
    const raw = JSON.stringify(subscribeInput);
    const { createHash } = await import('node:crypto');
    const subscribe = await post(dots.base + '/v1/dots/subscriptions/email', subscribeInput,
      { ...memberHeaders, 'X-Shiyan-Body-Sha': createHash('sha256').update(raw).digest('hex') });
    assert(subscribe.status >= 400, 'ordinary subscription cannot select registration events or an administrator recipient');
    await assert.rejects(client.forOwner(alice.user.owner).rpc('dots/internal/registration', notices[0]));
    await reader.cancel(); await readLoop; reader = null;
    await dots.server.registrationReady.then(receiver => receiver.close());
    await closeServer(dots.server); dots = null;
    const stopped = once(runtime, 'exit'); runtime.kill('SIGTERM'); await stopped;
    await startRuntime(); dots = await makeDots();
    const replay = await fetch(dots.base + '/v1/dots/events?after=0', { headers });
    reader = replay.body!.getReader(); const replayed = new TextDecoder().decode((await reader.read()).value);
    assert(replayed.includes(registeredEmail)); assert.match(replayed, /海绵宝宝 MCP 官网/);
    for (const notice of notices) await postRegistrationEvent(socketPath, notice);
    assert.equal(messages().length, 2, 'deduplication survives sidecar and runtime restart');
    const manager: any = await (await fetch(dots.base + '/v1/dots/manager', { headers })).json();
    assert.equal(manager.manager.messages.filter(message => message.proactiveReason === '管理员注册提醒').length, 2);
    assert(manager.manager.messages.some(message => message.id === shiyanMessage.id && message.content.includes('用户名：' + registeredEmail)));
    assert(!JSON.stringify(messages()).includes(password)); assert(!JSON.stringify(messages()).includes('fixture-code'));
  } catch (error) {
    (error as any).message += '\nIsolated Dots output: ' + runtimeOutput;
    if (accounts && !accounts.closed) (error as any).message += '\nPending website events: ' + accounts.db.prepare('SELECT COUNT(*) AS n FROM account_registration_outbox').get().n;
    if (sponge) (error as any).message += '\nPending MCP website events: ' + Object.keys(sponge.auth.state.registrationEvents).length;
    throw error;
  } finally {
    if (reader) await reader.cancel().catch(() => {});
    if (readLoop) await readLoop;
    if (dots) { await dots.server.registrationReady.then(receiver => receiver.close()).catch(() => {}); await closeServer(dots.server); }
    if (accountServer) await closeServer(accountServer);
    await sponge?.close(); accounts?.close(); db?.close();
    if (runtime && runtime.exitCode === null) { const exited = once(runtime, 'exit'); runtime.kill('SIGTERM'); await exited; }
    await rm(root, { recursive: true, force: true });
  }
});
