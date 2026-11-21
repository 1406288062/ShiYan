import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserStore, SecretBox } from './browser-store.ts';
import { BrowserAgentHost, startBrowserAgentSocket, browserAgentRequest } from './browser-agent.ts';
import { BrowserSessionManager, identityProfilePath } from './browser-session.ts';

// ---- a scripted Chrome: pages are { url, elements: {ref: {name,type}}, text } ----------------------
function fakeChrome(host) {
  const cdp: any = new EventEmitter();
  const targets = new Map(); let seq = 0;
  const calls: any[] = [];
  const failed = new Set();
  const session = { owner: 'alice', cdp, closing: false, targetSessionId: 'viewer-sid', tabs: new Map() };
  const page = sid => [...targets.values()].find(t => t.sid === sid);
  cdp.send = async (method, params: any = {}, sid = null) => {
    calls.push({ method, params, sid });
    switch (method) {
      case 'Target.createTarget': { const id = 'T' + (++seq); targets.set(id, { id, sid: 'S' + seq, url: params.url, elements: {}, text: '' }); return { targetId: id }; }
      case 'Target.attachToTarget': return { sessionId: targets.get(params.targetId).sid };
      case 'Browser.getWindowForTarget': return { windowId: 1 };
      case 'Page.navigate': {
        const tab = page(sid), requestId = 'r' + (++seq);
        host.cdpEvent(session, { sessionId: sid, method: 'Fetch.requestPaused', params: { requestId, request: { url: params.url }, frameId: tab.id } });
        await new Promise(resolve => setTimeout(resolve, 5));
        if (failed.has(requestId)) return { errorText: 'net::ERR_BLOCKED_BY_CLIENT' };
        tab.url = params.url; tab.elements = fixtures[params.url]?.elements || {}; tab.text = fixtures[params.url]?.text || '';
        setTimeout(() => host.cdpEvent(session, { sessionId: sid, method: 'Page.loadEventFired', params: {} }), 1);
        return { frameId: tab.id };
      }
      case 'Fetch.failRequest': failed.add(params.requestId); return {};
      case 'Runtime.evaluate': {
        const tab = page(sid), expr = params.expression;
        if (expr.includes('MAX = 160')) return { result: { value: { url: tab.url, title: 'T', items: (Object.entries(tab.elements) as [string, any][]).map(([ref, el]) => ({ ref, tag: 'input', name: el.name, ...(el.type ? { type: el.type } : {}) })), text: tab.text, challenge: null, hasPassword: (Object.values(tab.elements) as any[]).some(el => el.type === 'password'), scroll: {}, gen: '1' } } };
        if (expr.includes('getBoundingClientRect') && expr.includes('scrollIntoView')) {
          const ref = expr.match(/\+ "(\w+)" \+/)?.[1]; const el = tab.elements[ref];
          return { result: { value: el ? { x: 10, y: 20, w: 5, h: 5, tag: 'input', type: el.type || '', name: el.name, secure: el.type === 'password' || el.secure, file: el.type === 'file', editable: true } : null } };
        }
        if (expr.includes('data-shiyan-secure')) { const ref = expr.match(/\+ "(\w+)" \+/)?.[1]; if (tab.elements[ref]) tab.elements[ref].secure = true; return { result: { value: true } }; }
        if (expr.includes("pick = document.querySelector('article')")) return { result: { value: { url: tab.url, title: 'T', text: tab.text, links: [] } } };
        return { result: { value: true } };
      }
      default: return {};
    }
  };
  return { cdp, session, calls, targets };
}
const fixtures = {
  'https://shop.example/': { text: '欢迎', elements: { 1: { name: '搜索' }, 2: { name: '密码', type: 'password' }, 3: { name: '提交订单' }, 4: { name: '账号' } } },
  'https://other.example/': { text: '另一个网站', elements: {} },
};
function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'shiyan-browser-'));
  const store = new BrowserStore(root, { secretBox: new SecretBox({ key: Buffer.alloc(32, 7).toString('base64') }) });
  const attachments: any = { files: new Map(), upload(owner, input) { this.files.set(input.id, { owner, ...input }); return { id: input.id }; }, download(owner, id) { const f = this.files.get(id); if (!f || f.owner !== owner) throw Object.assign(new Error('nope'), { status: 404 }); return { filename: f.filename, mimeType: f.mimeType, data: Buffer.from(f.data, 'base64') }; } };
  let chrome;
  const manager: any = { holds: 0, setAgentHook() {}, get activeSession() { return chrome.session; }, async acquireAgent() { this.holds++; return chrome.session; }, releaseAgent() { this.holds--; }, async showAgentTargets(s, t) { this.shown = t; }, async hideAgentTargets(s, ids) { this.hidden = ids; }, async createTicket() { return { ticket: 'tk' }; } };
  const host = new BrowserAgentHost({ manager, store, attachments, lxc: async () => ({ stdout: '', stderr: '', code: 0 }), logger: () => {} });
  chrome = fakeChrome(host);
  return { root, store, host, manager, chrome, attachments, cleanup() { host.close(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}
const claimTask = (f, owner = 'alice') => { const claim = f.host.claim('w1'); assert.ok(claim, 'task claimed'); assert.equal(claim.task.owner, owner); return claim; };
const until = async (check, ms = 2000) => { const end = Date.now() + ms; while (Date.now() < end) { const value = check(); if (value) return value; await new Promise(r => setTimeout(r, 10)); } throw new Error('timeout'); };

test('browse receipt, executor actions, secure-field guard and purchase guard', async () => {
  const f = setup();
  try {
    const receipt = await f.host.dotsCall('alice', 'chat', 'browse', { task_id: 'new', task: '在 shop.example 搜索耳机' });
    assert.equal(receipt.status, 'accepted'); assert.match(receipt.note, /受理不等于完成/);
    const { task, token } = claimTask(f);
    const info = await f.host.execCall(task.task_id, token, 'get_task');
    assert.equal(info.instructions[0].text, '在 shop.example 搜索耳机');
    await f.host.execCall(task.task_id, token, 'navigate', { url: 'https://shop.example/' });
    const snap = await f.host.execCall(task.task_id, token, 'snapshot');
    assert.equal(snap.elements.length, 4); assert.match(snap.password_note, /fill_saved_login/);
    await assert.rejects(f.host.execCall(task.task_id, token, 'type', { ref: '2', text: 'hunter2' }), /密码/);
    const click = await f.host.execCall(task.task_id, token, 'click', { ref: '3' });
    assert.equal(click.ok, false); assert.match(click.note, /place_order/);
    await f.host.execCall(task.task_id, token, 'type', { ref: '1', text: '耳机', submit: true });
    assert.ok(f.chrome.calls.some(c => c.method === 'Input.insertText' && c.params.text === '耳机'));
    await assert.rejects(f.host.execCall(task.task_id, 'wrong-token', 'snapshot'), /凭证无效/);
    // A follow-up instruction rides along with the next tool result.
    await f.host.dotsCall('alice', 'chat', 'browse', { task_id: task.task_id, task: '只要白色的' });
    const next = await f.host.execCall(task.task_id, token, 'snapshot');
    assert.deepEqual(next.new_instructions, ['只要白色的']);
  } finally { f.cleanup(); }
});

test('cart confirmation goes to Dots and is answered with answer_to; user-only kinds are refused', async () => {
  const f = setup();
  try {
    await f.host.dotsCall('alice', 'chat', 'browse', { task_id: 'new', task: '买一副白色耳机' });
    const { task, token } = claimTask(f);
    const asking = f.host.execCall(task.task_id, token, 'ask', { kind: 'cart_confirmation', question: '请确认购物车', cart: { items: ['白色耳机 x1'], total: '199' } });
    const event = await until(() => f.store.undeliveredEvents().find(e => e.type === 'browser_task_question'));
    assert.equal(event.payload.kind, 'cart_confirmation'); assert.deepEqual(event.payload.data.cart.items, ['白色耳机 x1']);
    assert.equal(f.store.row(task.task_id)!.status, 'waiting_user');
    await assert.rejects(f.host.execCall(task.task_id, token, 'ask', { kind: 'cart_confirmation', question: '再来一个' }), /一次只跑一个结账/);
    const answered = await f.host.dotsCall('alice', 'chat', 'browse', { task_id: task.task_id, answer_to: event.payload.question_id, task: '确认，和用户要求一致' });
    assert.equal(answered.status, 'answer_delivered');
    const result = await asking;
    assert.equal(result.answer, '确认，和用户要求一致'); assert.equal(f.store.row(task.task_id)!.status, 'running');
    // Secure input can never be answered by Dots.
    await f.host.execCall(task.task_id, token, 'navigate', { url: 'https://shop.example/' });
    await f.host.execCall(task.task_id, token, 'snapshot');
    const secure = f.host.execCall(task.task_id, token, 'request_secure_input', { ref: '2', label: '登录密码', kind: 'password' });
    const need = await until(() => f.store.undeliveredEvents().find(e => e.type === 'browser_task_needs_user'));
    await assert.rejects(f.host.dotsCall('alice', 'chat', 'browse', { task_id: task.task_id, answer_to: need.payload.question_id, task: 'hunter2' }), error => (error as any).code === 'user_only');
    await f.host.submitSecureInput('alice', need.payload.question_id, 'S3cret-Pass!');
    assert.equal((await secure).ok, true);
    assert.ok(f.chrome.calls.some(c => c.method === 'Input.insertText' && c.params.text === 'S3cret-Pass!'));
    assert.ok(!readFileSync(path.join(f.root, 'browser.sqlite3')).includes(Buffer.from('S3cret-Pass!')));
    // Another account cannot see or answer this task.
    await assert.rejects(f.host.dotsCall('mallory', 'chat', 'windows', { action: 'list', task_id: task.task_id }), /没有找到/);
  } finally { f.cleanup(); }
});

test('site access ask/deny gates navigation and the user decides', async () => {
  const f = setup();
  try {
    f.store.setPermissions('alice', { siteAccess: 'ask' });
    f.store.setSiteRule('alice', 'https://shop.example', 'allow');
    f.store.setSiteRule('alice', 'https://blocked.example', 'deny');
    await f.host.dotsCall('alice', 'chat', 'browse', { task_id: 'new', task: '看看另一个网站' });
    const { task, token } = claimTask(f);
    assert.equal((await f.host.execCall(task.task_id, token, 'navigate', { url: 'https://shop.example/' })).ok, true);
    const denied = await f.host.execCall(task.task_id, token, 'navigate', { url: 'https://blocked.example/' });
    assert.equal(denied.blocked_navigation.decision, 'deny');
    const asked = await f.host.execCall(task.task_id, token, 'navigate', { url: 'https://other.example/' });
    assert.equal(asked.blocked_navigation.decision, 'ask');
    const qid = asked.blocked_navigation.question_id; assert.ok(qid);
    await f.host.userAnswer('alice', qid, { decision: 'allow' });
    assert.equal((await f.host.execCall(task.task_id, token, 'wait_for_answer', { question_id: qid })).answer.decision, 'allow');
    assert.equal((await f.host.execCall(task.task_id, token, 'navigate', { url: 'https://other.example/' })).ok, true);
  } finally { f.cleanup(); }
});

test('payment needs user authorization, place_order runs once, unverified without merchant proof', async () => {
  const f = setup();
  try {
    await f.host.dotsCall('alice', 'chat', 'browse', { task_id: 'new', task: '下单' });
    const { task, token } = claimTask(f);
    await f.host.execCall(task.task_id, token, 'navigate', { url: 'https://shop.example/' });
    await f.host.execCall(task.task_id, token, 'snapshot');
    await assert.rejects(f.host.execCall(task.task_id, token, 'place_order', { ref: '3', authorization_id: 'q_x' }), error => (error as any).code === 'no_authorization');
    const pending = f.host.execCall(task.task_id, token, 'request_payment_authorization', { merchant: 'Shop', amount: '199', currency: 'CNY', items: ['耳机'] });
    const need = await until(() => f.store.undeliveredEvents().find(e => e.type === 'browser_task_needs_user' && e.payload.kind === 'payment_authorization'));
    await assert.rejects(f.host.dotsCall('alice', 'chat', 'browse', { task_id: task.task_id, answer_to: need.payload.question_id, task: '批准' }), error => (error as any).code === 'user_only');
    await f.host.userAnswer('alice', need.payload.question_id, { approved: true });
    const auth = await pending; assert.equal(auth.ok, true);
    assert.equal((await f.host.execCall(task.task_id, token, 'place_order', { ref: '3', authorization_id: auth.authorization_id })).ok, true);
    await assert.rejects(f.host.execCall(task.task_id, token, 'place_order', { ref: '3', authorization_id: auth.authorization_id }), error => (error as any).code === 'authorization_used');
    const done = await f.host.execCall(task.task_id, token, 'finish', { status: 'done', summary: '已下单' });
    assert.equal(done.status, 'unverified');
    const update = f.store.undeliveredEvents().find(e => e.type === 'browser_task_update');
    assert.match(update!.payload.note, /结果不明/);
  } finally { f.cleanup(); }
});

test('takeover only for chat tasks; executor waits while the user drives; handback resumes', async () => {
  const f = setup();
  try {
    await f.host.dotsCall('alice', 'scheduled', 'browse', { task_id: 'new', task: '定时检查' });
    let claim = claimTask(f);
    const refused = await f.host.execCall(claim.task.task_id, claim.token, 'request_takeover', { reason: '验证码' });
    assert.equal(refused.ok, false); assert.match(refused.note, /不能提供接管/);
    await assert.rejects(f.host.startTakeover('alice', claim.task.task_id), /不提供接管/);
    f.host.complete(claim.task.task_id, claim.token, {});

    await f.host.dotsCall('alice', 'chat', 'browse', { task_id: 'new', task: '登录网站' });
    claim = claimTask(f);
    const { task, token } = claim;
    await f.host.execCall(task.task_id, token, 'navigate', { url: 'https://shop.example/' });
    const waiting = f.host.execCall(task.task_id, token, 'request_takeover', { reason: '请完成人机验证' });
    await until(() => f.store.pendingQuestions('alice', task.task_id).find(q => q.kind === 'takeover'));
    const started = await f.host.startTakeover('alice', task.task_id);
    assert.equal(started.ticket, 'tk'); assert.equal(f.store.row(task.task_id)!.status, 'taken_over');
    await assert.rejects(f.host.execCall(task.task_id, token, 'click', { x: 1, y: 1 }), error => (error as any).code === 'taken_over');
    await f.host.handback('alice', task.task_id, { note: '验证完成' });
    const back = await waiting;
    assert.equal(back.handed_back, true); assert.match(back.note, /交还不等于批准购买/);
    assert.equal(f.store.row(task.task_id)!.status, 'running');
    assert.ok(f.manager.hidden?.length);
  } finally { f.cleanup(); }
});

test('Secure Vault fills without exposing the password; codes are single-use after approval', async () => {
  const f = setup();
  try {
    const entry = f.store.vaultSave('alice', { origin: 'https://shop.example', username: 'alice@x', password: 'Vault-Pass-9' });
    assert.equal(entry!.password, undefined); assert.ok(!JSON.stringify(f.store.vaultList('alice')).includes('Vault-Pass-9'));
    assert.ok(!readFileSync(path.join(f.root, 'browser.sqlite3')).includes(Buffer.from('Vault-Pass-9')));
    f.store.setPermissions('alice', { savedPasswords: 'allow' });
    const code = f.store.createCode('alice', { code: '482913', label: '短信验证码' });
    await f.host.dotsCall('alice', 'chat', 'browse', { task_id: 'new', task: '登录', verification_code: code.id });
    const share = f.store.pendingQuestions('alice').find(q => q.kind === 'verification_share');
    assert.ok(share);
    const { task, token } = claimTask(f);
    await f.host.execCall(task.task_id, token, 'navigate', { url: 'https://shop.example/' });
    await f.host.execCall(task.task_id, token, 'snapshot');
    const filled = await f.host.execCall(task.task_id, token, 'fill_saved_login', { username_ref: '4', password_ref: '2' });
    assert.equal(filled.ok, true); assert.ok(!JSON.stringify(filled).includes('Vault-Pass-9'));
    assert.ok(f.chrome.calls.some(c => c.method === 'Input.insertText' && c.params.text === 'Vault-Pass-9'));
    const entering = f.host.execCall(task.task_id, token, 'enter_verification_code', { ref: '1' });
    await new Promise(r => setTimeout(r, 20));
    await f.host.userAnswer('alice', share.id, { decision: 'allow' });
    assert.equal((await entering).ok, true);
    assert.ok(f.chrome.calls.some(c => c.method === 'Input.insertText' && c.params.text === '482913'));
    await assert.rejects(f.host.execCall(task.task_id, token, 'enter_verification_code', { ref: '1', code_ref: code.id }), /已失效/);
  } finally { f.cleanup(); }
});

test('expired executor lease is surfaced as interrupted, not silently re-run', async () => {
  const f = setup();
  try {
    await f.host.dotsCall('alice', 'chat', 'browse', { task_id: 'new', task: 'x' });
    const { task } = claimTask(f);
    f.store.db.prepare('UPDATE browser_tasks SET lease_until=1 WHERE id=?').run(task.task_id);
    assert.equal(f.host.claim('w2'), null);
    assert.equal(f.store.row(task.task_id)!.status, 'interrupted');
    assert.ok(f.store.undeliveredEvents().some(e => e.payload.status === 'interrupted'));
  } finally { f.cleanup(); }
});

test('private socket serves the Dots bridge with owner from the caller', async () => {
  const f = setup();
  const socket = path.join(f.root, 'agent.sock');
  const server = await startBrowserAgentSocket(f.host, socket);
  try {
    const opened = await browserAgentRequest(socket, '/dots/call', { owner: 'alice', origin: 'chat', tool: 'browse', args: { task_id: 'new', task: 'hello' } });
    assert.equal(opened.result.status, 'accepted');
    const listed = await browserAgentRequest(socket, '/dots/call', { owner: 'alice', tool: 'windows', args: { action: 'list' } });
    assert.equal(listed.result.windows.length, 1);
    const other = await browserAgentRequest(socket, '/dots/call', { owner: 'bob', tool: 'windows', args: { action: 'list' } });
    assert.equal(other.result.windows.length, 0);
    await assert.rejects(browserAgentRequest(socket, '/exec/call', { task_id: opened.result.task_id, token: 'nope', tool: 'snapshot' }), /凭证无效/);
  } finally { server.close(); f.cleanup(); }
});

test('session manager: agent lease keeps Chrome when the viewer closes; viewer attaches to it', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'shiyan-bsm-'));
  const turn = path.join(root, 'turn.conf'); writeFileSync(turn, 'static-auth-secret=abc\nlistening-port=3478\nexternal-ip=203.0.113.9\n');
  process.env.SHIYAN_TURN_CONFIG = turn;
  let launches = 0;
  const launch: any = async () => { launches++; const cdp: any = new EventEmitter(); cdp.send = async (method) => method === 'Runtime.evaluate' ? { result: { value: true } } : {}; cdp.close = () => {}; return { cdp, mainTargetId: 'M', targetSessionId: 'MS', transportSessionId: 'TS' }; };
  const manager = new BrowserSessionManager({ launch, allowOrigins: new Set() });
  try {
    const session = await manager.acquireAgent('alice');
    assert.equal(session.agentHolds, 1); assert.equal(launches, 1);
    const { ticket } = await manager.createTicket('alice');
    const viewer = await manager.exchangeTicket(ticket);
    assert.ok(viewer.sessionToken); assert.equal(launches, 1, 'viewer attached instead of restarting Chrome');
    await manager.closeOwner('alice');
    assert.equal(manager.activeSession, session, 'agent lease keeps the browser');
    await assert.rejects(manager.acquireAgent('bob'), error => (error as any).code === 'browser_busy');
    manager.releaseAgent(session);
    await manager.closeOwner('alice');
    assert.equal(manager.activeSession, null);
    assert.notEqual(identityProfilePath('alice'), identityProfilePath('bob'));
    assert.notEqual(identityProfilePath('alice'), identityProfilePath('alice', 'work'));
    assert.equal(identityProfilePath('alice'), identityProfilePath('alice', 'default'));
  } finally { await manager.close(); delete process.env.SHIYAN_TURN_CONFIG; rmSync(root, { recursive: true, force: true }); }
});
