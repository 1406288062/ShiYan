import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserExecutor, executorPrompt, inboxEvent, browserMcpServer, browserToolAllowlist } from './browser-executor.ts';

const toolDefs = async () => ({ EXEC_TOOLS: [{ name: 'snapshot', description: 's', inputSchema: { type: 'object' } }, { name: 'finish', description: 'f', inputSchema: { type: 'object' } }] });

test('executor runs a sandboxed agent per claimed task with task-bound host tools, then completes and relays events', async () => {
  const calls = [], delivered = [], reports = [];
  let claims = [{ task: { task_id: 'bt_1', owner: 'alice', origin: 'chat', identity: 'default', title: '买耳机', thread_id: null, resumed: false }, token: 'tok', new_inputs: [] }];
  let events = [{ id: 7, owner: 'alice', task_id: 'bt_1', type: 'browser_task_update', payload: { task_id: 'bt_1', status: 'done', summary: '完成' } }];
  const call = async (route, body) => {
    calls.push([route, body]);
    if (route === '/events/claim') { const out = events; events = []; return { ok: true, events: out }; }
    if (route === '/executor/claim') return { ok: true, claim: claims.shift() || null };
    if (route === '/exec/call') return { ok: true, result: { called: body.tool } };
    return { ok: true };
  };
  let seen = null;
  const executor = createBrowserExecutor({
    call, concurrency: 1, toolDefs, logger: { warn() {}, error() {} },
    route: async consumer => { assert.equal(consumer, 'dots.browser'); return { provider: 'anthropic', model: 'claude-sonnet-5-5', reasoning: 'medium' }; },
    runAgent: async args => { seen = args; const snap = await args.groups.browser.find(t => t.name === 'snapshot').handler({}); assert.deepEqual(snap, { called: 'snapshot' }); return { sessionRef: 'anthropic:sess-1', usage: { output_tokens: 3 } }; },
    report: (consumer, entry) => reports.push([consumer, entry]),
    deliver: async (owner, event) => delivered.push([owner, event]),
  });
  await executor.tick();
  await new Promise(resolve => setTimeout(resolve, 20));
  executor.close();
  assert.deepEqual(delivered.map(([owner, event]) => [owner, event.id]), [['alice', 7]]);
  assert.ok(calls.some(([route, body]) => route === '/events/ack' && body.ids.includes(7)));
  assert.equal(seen.owner, 'alice'); assert.equal(seen.provider, 'anthropic'); assert.equal(seen.cwd, '/workspace/dots/.browser/bt_1');
  assert.ok(calls.some(([route, body]) => route === '/exec/call' && body.token === 'tok' && body.task_id === 'bt_1'), 'host tool carries the claim token');
  assert.match(seen.prompt, /get_task/); assert.match(seen.prompt, /不要尝试破解或绕过/); assert.match(seen.prompt, /place_order/);
  assert.ok(calls.some(([route, body]) => route === '/executor/checkpoint' && body.thread_id === 'anthropic:sess-1'));
  assert.ok(calls.some(([route, body]) => route === '/executor/complete' && body.task_id === 'bt_1' && body.error === ''));
  assert.equal(reports[0][0], 'dots.browser'); assert.equal(reports[0][1].ok, true);
});

test('a failed agent run is reported to the host as an error', async () => {
  const calls = [];
  const call = async (route, body) => { calls.push([route, body]); if (route === '/executor/claim') return { ok: true, claim: calls.filter(c => c[0] === '/executor/claim').length === 1 ? { task: { task_id: 'bt_2', owner: 'bob', origin: 'scheduled', identity: 'default', title: 't' }, token: 't2', new_inputs: [] } : null }; return { ok: true, events: [] }; };
  const executor = createBrowserExecutor({ call, toolDefs, logger: { warn() {}, error() {} }, route: async () => ({ provider: 'openai', model: 'gpt', reasoning: 'low' }), runAgent: async () => { throw new Error('model unavailable'); }, deliver: async () => {} });
  await executor.tick(); await new Promise(resolve => setTimeout(resolve, 20)); executor.close();
  assert.equal(calls.find(([route]) => route === '/executor/complete')[1].error, 'model unavailable');
});

test('resumed prompt carries new inputs; Dots tools and inbox events are shaped for the manager', () => {
  const prompt = executorPrompt({ task_id: 'bt_3', title: 't', origin: 'chat', identity: 'default', resumed: true }, [{ kind: 'answer', text: '选白色' }]);
  assert.match(prompt, /继续执行/); assert.match(prompt, /选白色/);
  const server = browserMcpServer('alice', 'chat');
  assert.equal(server.env.SHIYAN_MCP_OWNER, 'alice'); assert.equal(server.env.SHIYAN_BROWSER_ORIGIN, 'chat');
  assert.deepEqual(browserToolAllowlist(), ['mcp__browser__browse', 'mcp__browser__windows', 'mcp__browser__search', 'mcp__browser__open', 'mcp__browser__find']);
  assert.deepEqual(inboxEvent({ type: 'weird', task_id: 'bt_4', payload: { a: 1 } }), { type: 'browser_task_update', payload: { a: 1, task_id: 'bt_4' } });
});
