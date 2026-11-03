// Isolated contract tests: real in-memory SQLite, loopback-only fake runtime,
// injected webhook delivery. Never starts Codex, calls a Mac or executes a command.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as dns } from 'node:dns';
import { DatabaseSync } from 'node:sqlite';
import { createMcpBridge } from './mcp-events.mjs';

const TOKEN = 'fixture-token-never-used-in-production';
const CLIENT = { host: 'shiyan_desktop', conversation_id: 'conversation-A' };
const OTHER_CLIENT = { host: 'shiyan_mobile', conversation_id: 'conversation-B' };
const SIGNING_SECRET = 'whsec_' + Buffer.alloc(32, 7).toString('base64');
const now = () => Math.floor(Date.now() / 1000);

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return 'http://127.0.0.1:' + server.address().port;
}
async function closeServer(server) {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
async function fixture(t, injections = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE notifications (
    id INTEGER PRIMARY KEY, goal_id INTEGER, level TEXT NOT NULL,
    title TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL,
    output_id INTEGER, read_at INTEGER, delivered_at INTEGER
  );
  CREATE TABLE timeline (
    id INTEGER PRIMARY KEY, goal_id INTEGER, kind TEXT NOT NULL,
    message TEXT NOT NULL, data TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
  );`);
  const goals = new Map([
    [1, { id: 1, title: 'First', status: 'active' }],
    [2, { id: 2, title: 'Second', status: 'paused' }],
    [3, { id: 3, title: 'Finished', status: 'done' }],
    [4, { id: 4, title: 'Needs consent', status: 'waiting_approval' }],
  ]);
  const approvals = [{ id: 7, goal_id: 1, status: 'pending', command: 'printf reviewed', reason: 'Fixture only' }];
  const requests = [];
  const replayedRequests = new Map();
  let nextGoal = 10;
  const runtime = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = Buffer.concat(chunks).toString();
    const body = input ? JSON.parse(input) : null;
    requests.push({ method: req.method, path: req.url, body, authorized: req.headers.authorization === 'Bearer ' + TOKEN });
    const url = new URL(req.url, 'http://fixture');
    const reply = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (req.headers.authorization !== 'Bearer ' + TOKEN) return reply(401, { error: 'Fixture authorization failed' });
    if (req.method === 'POST' && url.pathname === '/v1/goals') {
      const replayKey = body.requestId ? 'create:' + body.requestId : null;
      const previous = replayKey ? replayedRequests.get(replayKey) : null;
      if (previous) {
        if (previous.fingerprint !== JSON.stringify(body)) return reply(409, { error: 'Request ID already used for different content' });
        return reply(200, previous.result);
      }
      const goal = { id: nextGoal++, title: body.title, instruction: body.instruction, status: body.runNow === false ? 'paused' : 'active' };
      goals.set(goal.id, goal);
      const result = { ok: true, goal };
      if (replayKey) replayedRequests.set(replayKey, { fingerprint: JSON.stringify(body), result });
      return reply(201, result);
    }
    if (req.method === 'GET' && url.pathname === '/v1/goals') return reply(200, { ok: true, goals: [...goals.values()] });
    const goalMatch = url.pathname.match(/^\/v1\/goals\/(\d+)(?:\/(pause|resume|cancel|wake|instruct))?$/);
    if (goalMatch) {
      const goal = goals.get(Number(goalMatch[1]));
      if (!goal) return reply(404, { error: 'goal not found' });
      if (req.method === 'GET' && !goalMatch[2]) return reply(200, { ok: true, goal });
      if (req.method === 'POST' && goalMatch[2]) {
        const action = goalMatch[2];
        goal.status = action === 'pause' ? 'paused' : action === 'cancel' ? 'cancelled' : 'active';
        return reply(200, { ok: true, goal });
      }
    }
    if (req.method === 'GET' && url.pathname === '/v1/outputs') {
      return reply(200, { ok: true, outputs: [{ id: 50, goal_id: Number(url.searchParams.get('goalId')), summary: 'Fixture result' }] });
    }
    if (req.method === 'GET' && url.pathname === '/v1/outputs/50') return reply(200, { ok: true, output: { id: 50, raw_result: 'Stored fixture output', summary: 'Fixture result' } });
    if (req.method === 'GET' && url.pathname === '/v1/approvals') return reply(200, { ok: true, approvals: approvals.filter(a => a.status === 'pending') });
    const decisionMatch = url.pathname.match(/^\/v1\/approvals\/(\d+)\/decision$/);
    if (req.method === 'POST' && decisionMatch) {
      const approval = approvals.find(a => a.id === Number(decisionMatch[1]) && a.status === 'pending');
      if (!approval) return reply(404, { error: 'pending approval not found' });
      // A decision is recorded by this fake; no shell command is ever executed.
      approval.status = body.decision === 'approve' ? 'approved' : 'rejected';
      return reply(200, { ok: true, approvalId: approval.id, state: approval.status });
    }
    if (url.pathname.startsWith('/v1/managers/')) {
      const owner=url.pathname.split('/')[3];
      if(owner!=='shiyan-private-owner')return reply(404,{error:'Manager not found'});
      if(url.pathname.endsWith('/activity'))return reply(200,{ok:true,activity:[],nextCursor:Number(url.searchParams.get('afterId')||0),hasMore:false});
      if(req.method==='GET'&&url.pathname.endsWith('/messages'))return reply(200,{ok:true,messages:[{id:1,role:'user',content:'Earlier fixture'}],hasMore:false,nextBeforeId:1});
      return reply(200,{ok:true,manager:{id:'manager:'+owner,name:'大内总管',status:'active',messages:[],tasks:[]},...(req.method==='POST'?{accepted:true,message:body}: {})});
    }
    if(req.method==='POST'&&url.pathname==='/v1/actions/action-1/reconcile')return reply(200,{ok:true,actionId:'action-1',outcome:body.outcome});
    reply(404, { error: 'Unknown fixture route' });
  });
  const runtimeBase = await listen(runtime);
  const options = { db, pathSecret: 'fixture-capability', runtimeToken: TOKEN, runtimeBase, retryIntervalMs: 0,
    deliver: async () => { throw new Error('No real webhook delivery is permitted in these tests'); },
    verify: async () => {}, ...injections };
  const f = { db, requests, goals, approvals, options, bridge: createMcpBridge(options), requestID: 0 };
  const transport = http.createServer((req, res) => {
    if (!f.bridge.matches(new URL(req.url, 'http://fixture').pathname)) { res.writeHead(404); res.end(); return; }
    f.bridge.handle(req, res).catch(error => { res.writeHead(500); res.end(String(error)); });
  });
  const base = await listen(transport);
  f.request = async (message, method = 'POST') => {
    const response = await fetch(base + f.bridge.endpointPath, { method, ...(method === 'POST' ? {
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: typeof message === 'string' ? message : JSON.stringify(message)
    } : {}) });
    const raw = await response.text();
    return { status: response.status, headers: response.headers, raw, body: raw ? JSON.parse(raw) : null };
  };
  f.rpc = (method, params = {}) => f.request({ jsonrpc: '2.0', id: ++f.requestID, method, params });
  f.call = (name, args = {}) => f.rpc('tools/call', { name, arguments: args });
  f.result = async (name, args = {}) => {
    const response = await f.call(name, args);
    assert.equal(response.status, 200);
    assert.equal(response.body.error, undefined, JSON.stringify(response.body));
    assert.notEqual(response.body.result.isError, true, JSON.stringify(response.body));
    assert.deepEqual(JSON.parse(response.body.result.content[0].text), response.body.result.structuredContent);
    return response.body.result.structuredContent;
  };
  f.rebuild = overrides => { f.bridge.close(); f.bridge = createMcpBridge({ ...options, ...overrides }); };
  t.after(async () => { f.bridge.close(); await closeServer(transport); await closeServer(runtime); db.close(); });
  return f;
}
function addContext(f, goalID, context = CLIENT) {
  f.db.prepare('INSERT INTO mcp_goal_context(goal_id,host,conversation_id) VALUES(?,?,?)').run(goalID, context.host, context.conversation_id);
}
function addNotification(f, id, goalID = 1) {
  f.db.prepare('INSERT INTO notifications(id,goal_id,level,title,body,created_at,output_id) VALUES(?,?,?,?,?,?,?)').run(id, goalID, 'info', 'Fixture goal', 'Fixture update ' + id, now(), id + 100);
}
function addSubscription(f, id = 'sub_fixture_0000000001', goalID = 1) {
  f.db.prepare(`INSERT INTO mcp_subscriptions(id,event_name,arguments_json,callback_url,secret,expires_at,active,created_at,updated_at)
    VALUES(?,?,?,?,?,NULL,1,?,?)`).run(id, 'goal.notification', JSON.stringify({ goal_id: goalID }), 'https://webhook.invalid/fixture', SIGNING_SECRET, now(), now());
  return id;
}
function toolFailure(response, pattern) {
  assert.equal(response.status, 200);
  assert.equal(response.body.error, undefined);
  assert.equal(response.body.result.isError, true);
  assert.match(response.body.result.content[0].text, pattern);
}

test('relationship tools expose only shared-topic memory and reject removed controls without runtime writes',async t=>{
  const f=await fixture(t);
  const listing=await f.rpc('tools/list',{}),names=listing.body.result.tools.map(tool=>tool.name);
  assert.ok(names.includes('dots_get_relationship'));assert.ok(!names.includes('dots_configure_relationship'));assert.ok(!names.includes('dots_relationship_feedback'));
  await f.result('dots_get_relationship');
  await f.result('dots_update_relationship_topic',{topicId:'shared-topic',summary:'User correction',revision:2});
  await f.result('dots_delete_relationship_topic',{topicId:'shared-topic'});
  assert.deepEqual(f.requests.map(r=>[r.method,r.path]),[
    ['GET','/v1/managers/shiyan-private-owner/relationship'],
    ['PATCH','/v1/managers/shiyan-private-owner/relationship/topics/shared-topic'],
    ['DELETE','/v1/managers/shiyan-private-owner/relationship/topics/shared-topic']
  ]);
  assert.deepEqual(f.requests[1].body,{summary:'User correction',revision:2});
  assert.ok(f.requests.every(r=>r.authorized));assert.equal(f.goals.size,4);
  for(const tool of ['dots_configure_relationship','dots_relationship_feedback']){
    const rejected=await f.call(tool,{});assert.equal(rejected.body.error.code,-32601);
  }
  assert.equal(f.requests.length,3);
  const foreign=await f.call('dots_get_relationship',{owner_id:'someone-else'});assert.equal(foreign.body.result.isError,true);
});

test('negotiates standard protocol without advertising experimental events', async t => {
  const f = await fixture(t);
  const standard = await f.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Fixture host', version: '1' } });
  assert.equal(standard.status, 200);
  assert.match(standard.headers.get('content-type'), /^application\/json/);
  assert.equal(standard.body.result.protocolVersion, '2025-06-18');
  assert.deepEqual(standard.body.result.capabilities, { tools: {} });
  const extended = await f.rpc('initialize', { protocolVersion: '2026-07-28' });
  assert.equal(extended.body.result.protocolVersion, '2026-07-28');
  assert.deepEqual(extended.body.result.capabilities, { tools: {}, events: {} });
  const fallback = await f.rpc('initialize', { protocolVersion: 'unsupported-version' });
  assert.equal(fallback.body.result.protocolVersion, '2025-06-18');
  const discovery = await f.rpc('server/discover');
  assert.ok(discovery.body.result.supportedVersions.includes('2025-06-18'));
  assert.ok(discovery.body.result.supportedVersions.includes('2026-07-28'));
  assert.deepEqual((await f.rpc('ping')).body.result, {});
  assert.equal(f.requests.length, 0);
  assert.equal(f.bridge.matches('/mcp/fixture-capability'), true);
  assert.equal(f.bridge.matches('/mcp/fixture-capability/extra'), false);
});

test('advertises all 23 tools with mirrored noauth and accurate lifecycle hints', async t => {
  const f = await fixture(t);
  const response = await f.rpc('tools/list');
  const tools = response.body.result.tools;
  assert.equal(tools.length, 23);
  assert.equal(new Set(tools.map(tool => tool.name)).size, 23);
  for (const tool of tools) {
    assert.deepEqual(tool.securitySchemes, [{ type: 'noauth' }]);
    assert.deepEqual(tool._meta.securitySchemes, tool.securitySchemes);
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.ok(Array.isArray(tool.inputSchema.required));
  }
  assert.equal(tools.find(tool => tool.name === 'dots_get_goal').annotations.readOnlyHint, true);
  assert.equal(tools.find(tool => tool.name === 'dots_control_goal').annotations.destructiveHint, true);
  assert.equal(tools.find(tool => tool.name === 'dots_decide_approval').annotations.openWorldHint, true);
  const capabilities = await f.result('dots_get_capabilities');
  assert.deepEqual(capabilities.tool_names.sort(), tools.map(tool => tool.name).sort());
  assert.equal(capabilities.shiyan_client_adapter_installed, false);
  assert.equal(capabilities.per_consumer_ack, true);
  assert.equal(capabilities.durable_webhook_outbox, true);
  assert.equal(capabilities.timeline_cursor, true);
  assert.equal(capabilities.idempotent_requests, true);
});

test('schema errors and unknown tools cannot reach runtime side effects', async t => {
  const f = await fixture(t);
  const cases = [
    ['dots_create_goal', { title: 'Task', instruction: 'Do work', run_now: 'false' }],
    ['dots_create_goal', { title: '   ', instruction: 'Do work' }],
    ['dots_create_goal', { title: 'Task', instruction: 'Do work', client_context: { ...CLIENT, token: 'unexpected' } }],
    ['dots_create_goal', { title: 'Task', instruction: 'Do work', client_context: { host: 'bad', conversation_id: 'A' } }],
    ['dots_create_goal', { title: 'Task' }],
    ['dots_create_goal', { title: 'Task', instruction: 'Do work', request_id: 'path/not-allowed' }],
    ['dots_create_goal', { title: 'Task', instruction: 'Do work', request_id: 'A'.repeat(129) }],
    ['dots_instruct_goal', { goal_id: 1, message: 'Continue', request_id: '' }],
    ['dots_get_goal', { goal_id: '1' }],
    ['dots_get_goal', { goal_id: 1.5 }],
    ['dots_get_goal', { goal_id: 0 }],
    ['dots_get_goal', { goal_id: Number.MAX_SAFE_INTEGER + 1 }],
    ['dots_control_goal', { goal_id: 1, action: 'execute' }],
    ['dots_list_notifications', { limit: 201 }],
    ['dots_list_notifications', { after_id: -1 }],
    ['dots_get_timeline', { goal_id: 1, after_id: -1 }],
    ['dots_decide_approval', { approval_id: 7, decision: 'yes' }],
    ['dots_get_capabilities', { arbitrary: true }],
    ['dots_get_capabilities', []],
  ];
  for (const [name, args] of cases) {
    const response = await f.call(name, args);
    assert.equal(response.body.error?.code, -32602, JSON.stringify({ name, args, response: response.body }));
  }
  assert.equal((await f.call('dots_unknown', {})).body.error.code, -32601);
  assert.equal(f.requests.length, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM mcp_goal_context').get().n, 0);
});

test('rejects malformed RPC and acknowledges notifications without responding or executing tools', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('{broken')).body.error.code, -32700);
  for (const msg of [null, [], { jsonrpc: '1.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 1, method: 'ping', params: [] }]) {
    const response = await f.request(msg);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, -32600);
  }
  const forbidden = await f.request({}, 'GET');
  assert.equal(forbidden.status, 405);
  assert.equal(forbidden.headers.get('allow'), 'POST');
  for (const method of ['notifications/initialized', 'notifications/unknown']) {
    const response = await f.request({ jsonrpc: '2.0', method });
    assert.equal(response.status, 202);
    assert.equal(response.raw, '');
  }
  const fireAndForget = await f.request({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'dots_create_goal', arguments: { title: 'Never create', instruction: 'Fixture side effect' } } });
  assert.equal(fireAndForget.status, 202);
  assert.equal(fireAndForget.raw, '');
  assert.equal(f.requests.length, 0);
  assert.equal((await f.rpc('unknown/method')).body.error.code, -32601);
});

test('create preserves run_now false and source context through later reads', async t => {
  const f = await fixture(t);
  const created = await f.result('dots_create_goal', { title: 'Deferred task', instruction: 'Fixture only', run_now: false, client_context: CLIENT, request_id: 'create-request-A' });
  assert.equal(created.goal.status, 'paused');
  assert.deepEqual(created.goal.client_context, CLIENT);
  assert.equal(created.realtime_delivery_confirmed, false);
  assert.equal(created.notification_subscription, 'ensure_active');
  assert.deepEqual(f.requests[0].body, { title: 'Deferred task', instruction: 'Fixture only', runNow: false, requestId: 'create-request-A', clientContext: CLIENT });
  assert.equal(f.requests[0].authorized, true);
  const read = await f.result('dots_get_goal', { goal_id: created.goal.id });
  assert.deepEqual(read.goal.client_context, CLIENT);
  const stored = f.db.prepare('SELECT * FROM mcp_goal_context WHERE goal_id=?').get(created.goal.id);
  assert.equal(stored.host, CLIENT.host);
  assert.equal(stored.conversation_id, CLIENT.conversation_id);
  const eager = await f.result('dots_create_goal', { title: 'Immediate task', instruction: 'Still fake' });
  assert.equal(eager.goal.status, 'active');
  assert.equal(eager.goal.client_context, null);
  assert.equal(f.requests.at(-1).body.runNow, true);
});

test('idempotent create replay preserves one context and rejects request reuse with another source', async t => {
  const f = await fixture(t);
  const args = { title: 'Replay safely', instruction: 'Fixture only', run_now: false, client_context: CLIENT, request_id: 'create-replay-A' };
  const first = await f.result('dots_create_goal', args);
  const again = await f.result('dots_create_goal', args);
  assert.equal(again.goal.id, first.goal.id);
  assert.deepEqual(again.goal.client_context, CLIENT);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM mcp_goal_context').get().n, 1);
  assert.equal(f.goals.size, 5, 'Only one fake goal should have been created');
  toolFailure(await f.call('dots_create_goal', { ...args, client_context: OTHER_CLIENT }), /different content/);
  assert.deepEqual((await f.result('dots_get_goal', { goal_id: first.goal.id })).goal.client_context, CLIENT);
});

test('does not implicitly resume paused/terminal goals or approve waiting goals', async t => {
  const f = await fixture(t);
  toolFailure(await f.call('dots_instruct_goal', { goal_id: 2, message: 'Continue' }), /Resume.*paused/i);
  toolFailure(await f.call('dots_control_goal', { goal_id: 2, action: 'wake' }), /Resume.*paused/i);
  toolFailure(await f.call('dots_control_goal', { goal_id: 3, action: 'resume' }), /terminal/i);
  toolFailure(await f.call('dots_control_goal', { goal_id: 4, action: 'resume' }), /pending approvals/i);
  assert.equal(f.requests.filter(request => request.method === 'POST').length, 0);
  const paused = await f.result('dots_control_goal', { goal_id: 1, action: 'pause' });
  assert.equal(paused.goal.status, 'paused');
  assert.match(paused.stop_semantics, /already running/);
  const resumed = await f.result('dots_control_goal', { goal_id: 1, action: 'resume' });
  assert.equal(resumed.goal.status, 'active');
  await f.result('dots_instruct_goal', { goal_id: 1, message: 'Reviewed follow-up', request_id: 'instruction-A' });
  assert.deepEqual(f.requests.at(-1).body, { message: 'Reviewed follow-up', requestId: 'instruction-A' });
  const cancelled = await f.result('dots_control_goal', { goal_id: 1, action: 'cancel' });
  assert.equal(cancelled.goal.status, 'cancelled');
  toolFailure(await f.call('dots_instruct_goal', { goal_id: 1, message: 'Do not restart' }), /terminal/i);
});

test('notification pagination is ascending, scoped and non-destructive', async t => {
  const f = await fixture(t);
  addContext(f, 1);
  addContext(f, 2, OTHER_CLIENT);
  for (let id = 1; id <= 6; id++) addNotification(f, id, id % 2 ? 1 : 2);
  const first = await f.result('dots_list_notifications', { after_id: 0, limit: 2 });
  assert.deepEqual(first.notifications.map(n => n.id), [1, 2]);
  assert.equal(first.next_cursor, 2);
  assert.equal(first.has_more, true);
  const second = await f.result('dots_list_notifications', { after_id: first.next_cursor, limit: 2 });
  assert.deepEqual(second.notifications.map(n => n.id), [3, 4]);
  const last = await f.result('dots_list_notifications', { after_id: 4, limit: 2 });
  assert.deepEqual(last.notifications.map(n => n.id), [5, 6]);
  assert.equal(last.has_more, false);
  const empty = await f.result('dots_list_notifications', { after_id: 6 });
  assert.equal(empty.next_cursor, 6);
  assert.deepEqual(empty.notifications, []);
  const scoped = await f.result('dots_list_notifications', { client_context: CLIENT, limit: 2 });
  assert.deepEqual(scoped.notifications.map(n => n.id), [1, 3]);
  assert.deepEqual(scoped.notifications.map(n => n.client_context), [CLIENT, CLIENT]);
  assert.equal(scoped.has_more, true);
  const oneGoal = await f.result('dots_list_notifications', { goal_id: 2, after_id: 2 });
  assert.deepEqual(oneGoal.notifications.map(n => n.id), [4, 6]);
  const mismatch = await f.result('dots_list_notifications', { goal_id: 2, client_context: CLIENT });
  assert.deepEqual(mismatch.notifications, []);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NOT NULL OR delivered_at IS NOT NULL').get().n, 0);
  assert.equal(f.requests.length, 0);
});

test('timeline cursor replays progress records in order and isolates goals', async t => {
  const f = await fixture(t);
  const insert = f.db.prepare('INSERT INTO timeline(id,goal_id,kind,message,data,created_at) VALUES(?,?,?,?,?,?)');
  for (let id = 1; id <= 5; id++) insert.run(id, id % 2 ? 1 : 2, 'progress', 'Fixture step ' + id, '{}', now());
  const first = await f.result('dots_get_timeline', { goal_id: 1, limit: 2 });
  assert.deepEqual(first.timeline.map(item => item.id), [1, 3]);
  assert.equal(first.next_cursor, 3);
  assert.equal(first.has_more, true);
  const rest = await f.result('dots_get_timeline', { goal_id: 1, after_id: first.next_cursor, limit: 2 });
  assert.deepEqual(rest.timeline.map(item => item.id), [5]);
  assert.equal(rest.next_cursor, 5);
  assert.equal(rest.has_more, false);
  const otherGoal = await f.result('dots_get_timeline', { goal_id: 2 });
  assert.deepEqual(otherGoal.timeline.map(item => item.id), [2, 4]);
  const empty = await f.result('dots_get_timeline', { goal_id: 1, after_id: 5 });
  assert.deepEqual(empty.timeline, []);
  assert.equal(empty.next_cursor, 5);
  assert.equal(f.requests.length, 4);
  assert.ok(f.requests.every(request => request.method === 'GET' && /^\/v1\/goals\/[12]$/.test(request.path)));
  toolFailure(await f.call('dots_get_timeline', { goal_id: 999 }), /goal not found/);
});

test('consumer acknowledgements are independent, monotonic, durable handoff only', async t => {
  const f = await fixture(t);
  for (let id = 1; id <= 5; id++) addNotification(f, id);
  const a = await f.result('dots_ack_notifications', { consumer_id: 'desktop-A', notification_id: 3 });
  assert.equal(a.acknowledged_cursor, 3);
  assert.equal(a.handoff_only, true);
  assert.equal((await f.result('dots_ack_notifications', { consumer_id: 'desktop-A', notification_id: 1 })).acknowledged_cursor, 3);
  assert.equal((await f.result('dots_ack_notifications', { consumer_id: 'desktop-A', notification_id: 3 })).acknowledged_cursor, 3);
  assert.deepEqual((await f.result('dots_list_notifications', { consumer_id: 'desktop-A' })).notifications.map(n => n.id), [4, 5]);
  const b = await f.result('dots_list_notifications', { consumer_id: 'mobile-B' });
  assert.equal(b.acknowledged_cursor, 0);
  assert.deepEqual(b.notifications.map(n => n.id), [1, 2, 3, 4, 5]);
  await f.result('dots_ack_notifications', { consumer_id: 'mobile-B', notification_id: 2 });
  assert.deepEqual((await f.result('dots_list_notifications', { consumer_id: 'mobile-B' })).notifications.map(n => n.id), [3, 4, 5]);
  // Explicit after_id allows replay; it never changes the stored ACK cursor.
  const replay = await f.result('dots_list_notifications', { consumer_id: 'desktop-A', after_id: 0, limit: 1 });
  assert.deepEqual(replay.notifications.map(n => n.id), [1]);
  assert.equal(replay.acknowledged_cursor, 3);
  toolFailure(await f.call('dots_ack_notifications', { consumer_id: 'unknown-C', notification_id: 999 }), /does not exist/);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM mcp_notification_cursors WHERE consumer_id=?').get('unknown-C').n, 0);
  f.rebuild({});
  assert.equal((await f.result('dots_list_notifications', { consumer_id: 'desktop-A' })).acknowledged_cursor, 3);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NOT NULL OR delivered_at IS NOT NULL').get().n, 0);
});

test('goal/output listing filters source sessions and preserves full result lookup', async t => {
  const f = await fixture(t);
  addContext(f, 1);
  addContext(f, 2);
  addContext(f, 3, OTHER_CLIENT);
  const listed = await f.result('dots_list_goals', { client_context: CLIENT, limit: 1 });
  assert.deepEqual(listed.goals.map(g => g.id), [1]);
  assert.equal(listed.has_more, true);
  assert.equal(listed.source_limit, 200);
  const paused = await f.result('dots_list_goals', { client_context: CLIENT, status: 'paused' });
  assert.deepEqual(paused.goals.map(g => g.id), [2]);
  const refs = await f.result('dots_list_outputs', { goal_id: 1, limit: 2 });
  assert.equal(f.requests.at(-1).path, '/v1/outputs?goalId=1&limit=2');
  const output = await f.result('dots_read_output', { output_id: refs.outputs[0].id });
  assert.equal(output.output.raw_result, 'Stored fixture output');
});

test('approval mismatch or stale ID never sends an execution decision', async t => {
  const f = await fixture(t);
  assert.equal((await f.result('dots_list_approvals', { goal_id: 1 })).approvals.length, 1);
  assert.equal((await f.result('dots_list_approvals', { goal_id: 2 })).approvals.length, 0);
  toolFailure(await f.call('dots_decide_approval', { approval_id: 7, decision: 'approve', confirmed_command: 'printf changed' }), /exactly match/);
  toolFailure(await f.call('dots_decide_approval', { approval_id: 7, decision: 'approve' }), /exactly match/);
  toolFailure(await f.call('dots_decide_approval', { approval_id: 999, decision: 'reject' }), /no longer pending/);
  assert.equal(f.requests.filter(request => request.method === 'POST').length, 0);
  assert.equal(f.approvals[0].status, 'pending');
  const approved = await f.result('dots_decide_approval', { approval_id: 7, decision: 'approve', confirmed_command: 'printf reviewed' });
  assert.equal(approved.state, 'approved');
  assert.deepEqual(f.requests.at(-1).body, { decision: 'approve' });
  assert.equal(f.requests.filter(request => request.method === 'POST').length, 1);
  toolFailure(await f.call('dots_decide_approval', { approval_id: 7, decision: 'approve', confirmed_command: 'printf reviewed' }), /no longer pending/);
  assert.equal(f.requests.filter(request => request.method === 'POST').length, 1);
});

test('rejecting an approval does not require a command confirmation', async t => {
  const f = await fixture(t);
  const rejected = await f.result('dots_decide_approval', { approval_id: 7, decision: 'reject' });
  assert.equal(rejected.state, 'rejected');
  assert.deepEqual(f.requests.at(-1).body, { decision: 'reject' });
});

test('failed webhook is stored, retries after bridge rebuild with stable identity, and never claims user receipt', async t => {
  const attempts = [];
  const f = await fixture(t, { deliver: async (subscription, event, messageID) => {
    attempts.push({ subscriptionID: subscription.id, event, messageID });
    return { status: 503, ok: false };
  } });
  addContext(f, 1);
  addNotification(f, 1);
  const subscriptionID = addSubscription(f);
  addSubscription(f, 'sub_fixture_other_goal', 2);
  const notification = { id: 1, goalId: 1, outputId: 101, level: 'info', title: 'Fixture goal', body: 'Fixture update 1', createdAt: now() };
  await f.bridge.emitNotification(notification);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].subscriptionID, subscriptionID);
  assert.equal(attempts[0].event.cursor, '1');
  assert.deepEqual(attempts[0].event.data.client_context, CLIENT);
  let row = f.db.prepare('SELECT * FROM mcp_delivery_outbox').get();
  assert.equal(row.state, 'pending');
  assert.equal(row.attempts, 1);
  assert.equal(row.last_status, 503);
  assert.equal(row.delivered_at, null);
  assert.equal(f.db.prepare('SELECT last_delivered_at FROM mcp_subscriptions WHERE id=?').get(subscriptionID).last_delivered_at, null);
  await f.bridge.emitNotification(notification);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM mcp_delivery_outbox').get().n, 1);
  assert.equal(attempts.length, 1, 'Replay before retry deadline should not re-deliver');
  const failedStatus = await f.result('dots_notification_status', { goal_id: 1 });
  assert.equal(failedStatus.subscriptions[0].pending, 1);
  assert.equal(failedStatus.subscriptions[0].last_webhook_accepted_at, null);
  assert.equal(failedStatus.conversation_display_confirmed, false);
  assert.ok(!JSON.stringify(failedStatus).includes('webhook.invalid'));
  assert.ok(!JSON.stringify(failedStatus).includes(SIGNING_SECRET));
  // Reconstruct the bridge retaining only SQLite state: no in-memory queue remains.
  f.rebuild({ deliver: async (subscription, event, messageID) => {
    attempts.push({ subscriptionID: subscription.id, event, messageID });
    return { status: 204, ok: true };
  } });
  f.db.prepare('UPDATE mcp_delivery_outbox SET next_retry_at=0').run();
  await f.bridge.flushDeliveries();
  assert.equal(attempts.length, 2);
  assert.equal(attempts[1].messageID, attempts[0].messageID);
  assert.deepEqual(attempts[1].event, attempts[0].event);
  row = f.db.prepare('SELECT * FROM mcp_delivery_outbox').get();
  assert.equal(row.state, 'delivered');
  assert.equal(row.attempts, 2);
  assert.equal(row.last_status, 204);
  assert.ok(Number.isInteger(row.delivered_at));
  assert.ok(Number.isInteger(f.db.prepare('SELECT last_delivered_at FROM mcp_subscriptions WHERE id=?').get(subscriptionID).last_delivered_at));
  await f.bridge.flushDeliveries();
  assert.equal(attempts.length, 2);
  const acceptedStatus = await f.result('dots_notification_status', { goal_id: 1 });
  assert.equal(acceptedStatus.subscriptions[0].delivered, 1);
  assert.equal(acceptedStatus.conversation_display_confirmed, false);
  const original = f.db.prepare('SELECT read_at,delivered_at FROM notifications WHERE id=1').get();
  assert.equal(original.read_at, null);
  assert.equal(original.delivered_at, null);
});

test('expired subscriptions and permanent webhook rejection cannot be marked delivered', async t => {
  let delivered = 0;
  const f = await fixture(t, { deliver: async () => { delivered++; return { status: 410, ok: false }; } });
  const subscriptionID = addSubscription(f);
  await f.bridge.emitNotification({ id: 1, goalId: 1, level: 'info', title: 'Fixture', body: 'No receipt', createdAt: now() });
  assert.equal(delivered, 1);
  const row = f.db.prepare('SELECT * FROM mcp_delivery_outbox').get();
  assert.equal(row.state, 'failed');
  assert.equal(row.delivered_at, null);
  const subscription = f.db.prepare('SELECT * FROM mcp_subscriptions WHERE id=?').get(subscriptionID);
  assert.equal(subscription.active, 0);
  assert.equal(subscription.last_delivered_at, null);
  const expired = addSubscription(f, 'sub_fixture_expired');
  f.db.prepare('UPDATE mcp_subscriptions SET expires_at=? WHERE id=?').run(now() - 1, expired);
  await f.bridge.emitNotification({ id: 2, goalId: 1, level: 'info', title: 'Fixture', body: 'Expired', createdAt: now() });
  assert.equal(delivered, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM mcp_delivery_outbox WHERE subscription_id=?').get(expired).n, 0);
});

test('subscription verification is required and renewal is idempotent without public requests', async t => {
  // DNS is injected too; verification and delivery never access the Internet.
  t.mock.method(dns, 'lookup', async () => [{ address: '203.0.113.10', family: 4 }]);
  let verified = 0;
  let failVerification = true;
  const f = await fixture(t, { verify: async () => {
    verified++;
    if (failVerification) throw new Error('callback challenge mismatch');
  } });
  const params = { name: 'goal.notification', arguments: { goal_id: 1 }, delivery: { mode: 'webhook', url: 'https://callback.invalid/fixture', secret: SIGNING_SECRET }, ttlMs: 600000 };
  const rejected = await f.rpc('events/subscribe', params);
  assert.equal(rejected.body.error.code, -32015);
  assert.equal(rejected.body.error.data.reason, 'challenge_failed');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM mcp_subscriptions').get().n, 0);
  failVerification = false;
  const subscribed = await f.rpc('events/subscribe', params);
  assert.ok(subscribed.body.result.id.startsWith('sub_'));
  const renewed = await f.rpc('events/subscribe', params);
  assert.equal(renewed.body.result.id, subscribed.body.result.id);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM mcp_subscriptions').get().n, 1);
  assert.equal(verified, 3);
  const invalid = await f.rpc('events/subscribe', { ...params, arguments: { goal_id: 1, unexpected: true } });
  assert.equal(invalid.body.error.code, -32015);
  assert.equal(verified, 3);
  const events = await f.rpc('events/list');
  assert.equal(events.body.result.events[0].name, 'goal.notification');
  assert.ok(events.body.result.events[0].payloadSchema.properties.client_context);
  await f.rpc('events/unsubscribe', params);
  assert.equal(f.db.prepare('SELECT active FROM mcp_subscriptions').get().active, 0);
  assert.equal(f.requests.length, 0);
});

test('manager tools preserve stable ownership, target and idempotency keys', async t => {
  const f=await fixture(t);
  assert.equal((await f.result('dots_get_manager')).manager.id,'manager:shiyan-private-owner');
  const sent=await f.result('dots_message_manager',{message:'查看进度',request_id:'manager-input-1',host:'chatgpt',task_id:1});
  assert.equal(sent.accepted,true);
  assert.deepEqual(f.requests.at(-1).body,{message:'查看进度',requestId:'manager-input-1',host:'chatgpt',taskId:1});
  assert.equal((await f.result('dots_get_manager_activity',{after_id:7,limit:2})).nextCursor,7);
  assert.equal(f.requests.at(-1).path,'/v1/managers/shiyan-private-owner/activity?afterId=7&limit=2');
  await f.result('dots_control_manager',{action:'pause',request_id:'manager-pause-1'});
  assert.deepEqual(f.requests.at(-1).body,{action:'pause',requestId:'manager-pause-1'});
  const before=f.requests.length;
  const bad=await f.call('dots_message_manager',{message:'Should not dispatch',request_id:'path/bad'});
  assert.equal(bad.body.error.code,-32602);
  assert.equal(f.requests.length,before);
  toolFailure(await f.call('dots_get_manager',{owner_id:'another-owner'}),/Manager not found/);
  const caps=await f.result('dots_get_capabilities');
  assert.equal(caps.manager,true);
  assert.equal(caps.manager_webhook,false);
  assert.equal(caps.hard_budgets,false);
});

test('web-originated Dots messages are mirrored to the bound WeChat exactly once', async t => {
  const sent=[];
  const f=await fixture(t,{weixin:()=>({send:async text=>{sent.push(text);return true;}})});
  const input={message:'内部附件路径不应发给微信',display_message:'帮我整理今天的计划',request_id:'web-message-001',host:'shiyan_web'};
  await f.result('dots_message_manager',input);
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.deepEqual(sent,['帮我整理今天的计划']);
  await f.result('dots_message_manager',input);
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.deepEqual(sent,['帮我整理今天的计划']);
});

test('manager history pagination and explicit reconciliation keep their exact contracts',async t=>{
 const f=await fixture(t);
 const page=await f.result('dots_get_manager_messages',{before_id:8,limit:2});
 assert.equal(page.messages[0].content,'Earlier fixture');
 assert.equal(f.requests.at(-1).path,'/v1/managers/shiyan-private-owner/messages?limit=2&beforeId=8');
 const response=await f.result('dots_reconcile_action',{action_id:'action-1',outcome:'succeeded',note:'User verified the saved result',request_id:'reconcile-1'});
 assert.equal(response.outcome,'succeeded');
 assert.deepEqual(f.requests.at(-1).body,{outcome:'succeeded',note:'User verified the saved result',requestId:'reconcile-1'});
 const before=f.requests.length;
 const invalid=await f.call('dots_reconcile_action',{action_id:'action-1',outcome:'succeeded',note:'',request_id:'reconcile-2'});
 assert.equal(invalid.body.error.code,-32602);assert.equal(f.requests.length,before);
});
