import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openToolServers, tool, toContent } from './agent-tools.ts';
import { createAgentRunner, parseSessionRef } from './agent-runner.ts';
import { createSandboxManager, fakeProcess } from './agent-sandbox.ts';
import { createWorkerAgent, buildWorkerAgentPrompt } from './dots-worker-agent.ts';

const RELAY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'agent-sandbox', 'mcp-relay.mjs');
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'dots-agent-'));

test('host tool socket + in-container relay speak MCP end to end', async () => {
  const dir = tmp(), calls: any[] = [];
  const servers = await openToolServers({ rpcDir: dir, groups: { dots: [tool('echo', 'echo', { text: { type: 'string' } }, ['text'], args => ({ said: args.text })), tool('boom', 'fails', {}, [], () => { throw new Error('nope'); })] }, onCall: call => calls.push(call) });
  try {
    const args = servers.claude.dots.args;
    assert.equal(servers.claude.dots.command, 'node'); assert.equal(servers.codex.dots.tool_timeout_sec, 7200);
    // Run the relay against the real host socket path (inside the container it is /run/shiyan/...).
    const relay = spawn(process.execPath, [RELAY, path.join(dir, path.basename(args[1]))], { stdio: ['pipe', 'pipe', 'inherit'] });
    const lines = createInterface({ input: relay.stdout }); const replies = new Map();
    lines.on('line', line => { const m = JSON.parse(line); replies.get(m.id)?.(m); });
    const ask = (id: any, method: any, params: any): Promise<any> => new Promise(resolve => { replies.set(id, resolve); relay.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
    assert.equal((await ask(1, 'initialize', {})).result.serverInfo.name, 'shiyan-dots');
    assert.deepEqual((await ask(2, 'tools/list', {})).result.tools.map((t: any) => t.name), ['echo', 'boom']);
    assert.deepEqual(JSON.parse((await ask(3, 'tools/call', { name: 'echo', arguments: { text: 'hi' } })).result.content[0].text), { said: 'hi' });
    const failed = (await ask(4, 'tools/call', { name: 'boom', arguments: {} })).result;
    assert.equal(failed.isError, true); assert.match(failed.content[0].text, /nope/);
    relay.stdin.end();
    assert.deepEqual(calls.map(c => [c.tool, c.ok]), [['echo', true], ['boom', false]]);
  } finally { servers.close(); rmSync(dir, { recursive: true, force: true }); }
  assert.deepEqual(toContent({ image: 'AAA', mimeType: 'image/png', url: 'u' }).content[0], { type: 'image', data: 'AAA', mimeType: 'image/png' });
});

test('sandbox manager creates one hardened container per account and execs inside it with an env file', async () => {
  const dir = tmp(), runs: any[] = [], spawns: any[] = [];
  const docker = { run: async (args: any) => { runs.push(args); if (args[0] === 'inspect') throw new Error('no such container'); return { stdout: '', stderr: '' }; }, spawn: (args: any) => { spawns.push(args); return fakeProcess(); } };
  const claudeEnv = path.join(dir, 'claude.env'); writeFileSync(claudeEnv, 'CLAUDE_CODE_OAUTH_TOKEN=secret-token\n');
  const creds = path.join(dir, 'cred.json'); writeFileSync(creds, '{"t":1}');
  const box = createSandboxManager({ docker, image: 'shiyan-agent:test', claudeBinary: creds, codexBinary: '/nonexistent', credentials: { claude: creds, claudeEnv, codex: '/nonexistent' }, logger: { info() {}, warn() {} },
    layoutFor: owner => ({ workspace: path.join(dir, owner, 'ws'), workspaceTarget: '/workspace', home: path.join(dir, owner, 'home'), rpc: path.join(dir, owner, 'rpc') }) });
  try {
    const a = await box.ensure('alice'), b = await box.ensure('bob');
    assert.notEqual(a.name, b.name);
    const create = runs.find(args => args[0] === 'run');
    for (const flag of ['--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '--pids-limit', 'shiyan-agent:test']) assert.ok(create.includes(flag), flag);
    assert.equal(runs.filter(args => args[0] === 'run').length, 2);
    assert.ok(existsSync(path.join(dir, 'alice', 'home', '.claude', '.credentials.json')), 'credentials copied into the agent home');
    const child = box.spawn('alice', { command: '/opt/shiyan/bin/claude', args: ['--print'], cwd: '/workspace/dots/7', env: { CLAUDE_CODE_ENTRYPOINT: 'sdk' } });
    const args = spawns[0];
    assert.equal(args[0], 'exec'); assert.ok(args.includes('/workspace/dots/7')); assert.ok(!args.join(' ').includes('secret-token'), 'secrets never on the command line');
    const envFile = args[args.indexOf('--env-file') + 1];
    assert.match(readFileSync(envFile, 'utf8'), /CLAUDE_CODE_OAUTH_TOKEN=secret-token/);
    child.kill('SIGTERM');
    assert.ok(runs.some(r => r[0] === 'exec' && r.join(' ').includes('kill -TERM')), 'kill reaches the in-container process');
  } finally { box.close(); rmSync(dir, { recursive: true, force: true }); }
});

function fakeSandbox(dir: any) {
  return { paths: { claude: '/opt/shiyan/bin/claude', codex: '/opt/shiyan/codex/codex', relay: '/opt/shiyan/mcp-relay.mjs' }, ensured: [] as any[], execs: [] as any[],
    async ensure(owner: any) { this.ensured.push(owner); return { layout: { rpc: dir } }; }, async exec(owner: any, argv: any) { this.execs.push(argv); return { stdout: '' }; }, spawn(_owner: any, _spec: any) { return fakeProcess(); } };
}

test('claude driver runs the Agent SDK inside the sandbox, resumes its session and maps tool steps', async () => {
  const dir = tmp(), sandbox = fakeSandbox(dir);
  let options: any = null;
  const claudeSdk = async () => ({ query({ prompt, options: opts }: any) { options = opts; return (async function* () {
    for await (const first of prompt) { assert.equal(first.message.content[0].text, 'do it'); break; }
    opts.spawnClaudeCodeProcess({ args: ['--x'], env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', SECRET_HOST_VAR: 'no' } });
    yield { type: 'system', subtype: 'init', session_id: 's-2' };
    yield { type: 'assistant', session_id: 's-2', message: { content: [{ type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'ls' } }] } };
    yield { type: 'user', session_id: 's-2', message: { content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'a.txt' }] } };
    yield { type: 'result', subtype: 'success', is_error: false, result: '完成', num_turns: 2, session_id: 's-2', usage: { input_tokens: 5, output_tokens: 7 } };
  })(); } });
  let spawned: any = null; sandbox.spawn = (owner, spec) => { spawned = { owner, spec }; return fakeProcess(); };
  const runner = createAgentRunner({ sandbox, claudeSdk });
  try {
    const out = await runner.runAgent({ owner: 'alice', provider: 'anthropic', model: 'claude-sonnet-5-5', reasoning: 'medium', sessionRef: 'anthropic:s-1', cwd: '/workspace/dots/3', prompt: 'do it', groups: { dots: [tool('x', 'x', {}, [], () => 1)] } });
    assert.equal(options.resume, 's-1'); assert.equal(options.permissionMode, 'bypassPermissions'); assert.equal(options.mcpServers.dots.command, 'node');
    assert.equal(spawned.spec.command, '/opt/shiyan/bin/claude'); assert.equal(spawned.spec.cwd, '/workspace/dots/3');
    assert.equal(spawned.spec.env.SECRET_HOST_VAR, undefined, 'host environment does not leak into the container');
    assert.equal(out.sessionRef, 'anthropic:s-2'); assert.equal(out.text, '完成');
    assert.deepEqual(out.items.map(i => [i.name, i.ok]), [['Bash', true]]);
    assert.deepEqual(sandbox.execs[0], ['mkdir', '-p', '/workspace/dots/3']);
    // A Codex session reference is not resumed by Claude.
    await runner.runAgent({ owner: 'alice', provider: 'anthropic', model: 'm', sessionRef: 'openai:t-1', cwd: '/w', prompt: 'do it' });
    assert.equal(options.resume, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.deepEqual(parseSessionRef('openai:abc'), { provider: 'openai', id: 'abc' });
});

test('codex driver runs app-server in the sandbox with full access and relay MCP servers', async () => {
  const dir = tmp(), sandbox = fakeSandbox(dir);
  let captured: any = null;
  const managerThread = ({ threadId, codexPath, options, spawnProcess }: any) => {
    captured = { threadId, codexPath, options, spawnProcess };
    return { id: threadId, async runStreamed(text: any) { captured.text = text; options.onItem({ type: 'commandExecution', command: 'pytest', aggregatedOutput: 'ok', status: 'completed' }); this.id = 'th-9';
      return { events: (async function* () { yield { type: 'item.completed', item: { type: 'agent_message', text: '好了' } }; yield { type: 'turn.completed', usage: { output_tokens: 1 } }; })() }; } };
  };
  const runner = createAgentRunner({ sandbox, managerThread });
  try {
    const out = await runner.runAgent({ owner: 'bob', provider: 'openai', model: 'gpt-6-luna', reasoning: 'high', sessionRef: 'openai:th-1', cwd: '/workspace/dots/4', system: 'SYS', prompt: 'go', groups: { browser: [tool('snapshot', 's', {}, [], () => 1)] } });
    assert.equal(captured.threadId, 'th-1'); assert.equal(captured.options.sandboxMode, 'danger-full-access'); assert.equal(captured.options.mcpServers.browser.command, 'node');
    assert.equal(captured.codexPath, '/opt/shiyan/codex/codex'); assert.match(captured.text, /SYS/);
    assert.equal(out.sessionRef, 'openai:th-9'); assert.equal(out.text, '好了'); assert.deepEqual(out.items.map(i => i.name), ['shell']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('worker agent: hub route, finish_run result, session resume and fallback when finish is missing', async () => {
  let seen: any = null;
  const runAgent = async (args: any) => { seen = args; await args.groups.dots.find((t: any) => t.name === 'finish_run').handler({ status: 'done', summary: '写好了报告', notify: true, notification: '报告已完成', memories: ['用 pandas'] }); args.onEvent({ type: 'tool_result', name: 'Bash', ok: true }); return { sessionRef: 'anthropic:w-1', text: 'x', usage: null }; };
  const steps: any[] = [];
  const worker = createWorkerAgent({ runAgent, route: async (consumer: any) => { assert.equal(consumer, 'dots.worker'); return { provider: 'anthropic', model: 'claude-sonnet-5-5', reasoning: 'medium' }; },
    toolGroups: async () => ({ groups: { browser: [tool('browse', 'b', {}, [], () => 1)] }, close() {} }) });
  const goal = { id: 12, title: '整理周报', instruction: '汇总数据', thread_id: 'anthropic:w-0', run_count: 3 };
  const out = await worker.run(goal, { owner: 'alice', memories: [], timeline: [], events: [], trigger: 'scheduler', onStep: s => steps.push(s) });
  assert.equal(out.result.status, 'done'); assert.equal(out.result.notification, '报告已完成'); assert.deepEqual(out.result.actions, []);
  assert.equal(out.sessionRef, 'anthropic:w-1'); assert.equal(seen.cwd, '/workspace/dots/12'); assert.equal(seen.sessionRef, 'anthropic:w-0');
  assert.match(seen.prompt, /新一轮唤醒/, 'same-provider session resumes with a short prompt');
  assert.ok(seen.groups.browser && seen.groups.dots); assert.equal(steps.length, 1);
  const lazy = createWorkerAgent({ runAgent: async () => ({ sessionRef: 'openai:z', text: '做了一半' }), route: async () => ({ provider: 'openai', model: 'g', reasoning: 'low' }), toolGroups: async () => ({ groups: {} }) });
  const partial = await lazy.run({ ...goal, thread_id: 'anthropic:w-1' }, { owner: 'alice' });
  assert.equal(partial.result.status, 'continue'); assert.match(partial.result.summary, /做了一半/);
  assert.match(buildWorkerAgentPrompt(goal, { cwd: '/workspace/dots/12' }), /Docker 沙箱/);
});
