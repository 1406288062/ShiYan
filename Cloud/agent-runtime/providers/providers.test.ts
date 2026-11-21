import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { createClaudeEventMapper, claudeUsage } from './claude-events.ts';
import { registerProvider, unregisterProvider, refreshCatalog, verifiedCatalog, providerForModel, listProviders } from './registry.ts';
import { toCatalogModel, zodShape, claudeMcpConfig, streamClaude, effortOption, readEnvFile, claudeCredentialsConfigured } from './claude.ts';
import { codexMcpConfig } from './codex.ts';
import { transcriptText, appendTranscript, retainTranscript } from './transcript.ts';
import { writeFileSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const run = (mapper: any, messages: any) => messages.flatMap((m: any) => mapper.map(m));

test('Claude 流式文本与完整消息使用同一 item id', () => {
  const events = run(createClaudeEventMapper(), [
    { type: 'system', subtype: 'init', session_id: 'sess-1' },
    { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'm1' } } },
    { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } } },
    { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '，世界' } } },
    { type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', content: [{ type: 'text', text: '你好，世界' }] } },
  ]);
  assert.deepEqual(events[0], { type: 'thread.started', thread_id: 'sess-1' });
  const updates = events.filter((e: any) => e.type === 'item.updated');
  assert.equal(updates.at(-1).item.text, '你好，世界');
  const done = events.find((e: any) => e.type === 'item.completed');
  assert.equal(done.item.id, updates[0].item.id);
  assert.equal(done.item.type, 'agent_message');
});

test('同一条 API 消息拆成多个 SDK 消息时 id 不冲突', () => {
  const events = run(createClaudeEventMapper(), [
    { type: 'assistant', parent_tool_use_id: null, message: { id: 'm2', content: [{ type: 'text', text: '先看看' }] } },
    { type: 'assistant', parent_tool_use_id: null, message: { id: 'm2', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }] } },
    { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'a.txt' }] } },
    { type: 'assistant', parent_tool_use_id: null, message: { id: 'm2', content: [{ type: 'text', text: '完成' }] } },
  ]);
  const texts = events.filter((e: any) => e.item?.type === 'agent_message');
  assert.equal(new Set(texts.map((e: any) => e.item.id)).size, 2);
  const cmd = events.filter((e: any) => e.item?.type === 'command_execution');
  assert.equal(cmd[0].type, 'item.started'); assert.equal(cmd[0].item.command, 'ls');
  assert.equal(cmd[1].item.status, 'completed'); assert.equal(cmd[1].item.aggregated_output, 'a.txt'); assert.equal(cmd[1].item.exit_code, 0);
});

test('工具类型映射：文件、待办、MCP 图片结果、失败', () => {
  const events = run(createClaudeEventMapper(), [
    { type: 'assistant', parent_tool_use_id: null, message: { id: 'm3', content: [
      { type: 'tool_use', id: 'w', name: 'Write', input: { file_path: '/tmp/x.md', content: 'x' } },
      { type: 'tool_use', id: 't', name: 'TodoWrite', input: { todos: [{ content: '一', status: 'completed' }, { content: '二', status: 'pending' }] } },
      { type: 'tool_use', id: 'q', name: 'mcp__shiyan-input__ask_user', input: { question: '?' } },
      { type: 'tool_use', id: 'g', name: 'Grep', input: { pattern: 'a' } },
    ] } },
    { type: 'user', parent_tool_use_id: null, message: { content: [
      { type: 'tool_result', tool_use_id: 'q', content: [{ type: 'text', text: '选A' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] },
      { type: 'tool_result', tool_use_id: 'g', is_error: true, content: 'boom' },
    ] } },
  ]);
  const byId = (id: any) => events.filter((e: any) => e.item?.id === id);
  assert.deepEqual(byId('w')[0].item.changes, [{ path: '/tmp/x.md', kind: 'add' }]);
  assert.deepEqual(byId('t')[0].item.items, [{ text: '一', completed: true }, { text: '二', completed: false }]);
  const q = byId('q').at(-1).item;
  assert.equal(q.server, 'shiyan-input'); assert.equal(q.tool, 'ask_user');
  assert.deepEqual(q.result.content[1], { type: 'image', data: 'AAAA', mimeType: 'image/png' });
  const g = byId('g').at(-1).item;
  assert.equal(g.status, 'failed'); assert.equal(g.server, 'claude'); assert.equal(g.error.message, 'boom');
});

test('普通账号沙箱工具按终端/工作区展示', () => {
  const events = run(createClaudeEventMapper({ isolatedServer: 'workspace' }), [
    { type: 'assistant', parent_tool_use_id: null, message: { id: 'm4', content: [
      { type: 'tool_use', id: 'e', name: 'mcp__workspace__exec_command', input: { command: 'pwd' } },
      { type: 'tool_use', id: 'r', name: 'mcp__workspace__read_file', input: { path: '/workspace/a' } }] } },
    { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'e', content: JSON.stringify({ stdout: '/workspace\n', stderr: '', exitCode: 0 }) }] } },
  ]);
  const e = events.filter((x: any) => x.item?.id === 'e').at(-1).item;
  assert.equal(e.type, 'command_execution'); assert.equal(e.aggregated_output, '/workspace\n');
  assert.equal(events.find((x: any) => x.item?.id === 'r').item.server, 'workspace');
});

test('结果消息：成功用量换算、失败、未完成工具标记中断、之后忽略', () => {
  const ok = createClaudeEventMapper();
  ok.map({ type: 'assistant', parent_tool_use_id: null, message: { id: 'm', content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }] } });
  const out = ok.map({ type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 5, output_tokens: 7 } });
  assert.equal(out[0].item.status, 'interrupted');
  assert.deepEqual(out[1], { type: 'turn.completed', usage: { input_tokens: 105, cached_input_tokens: 90, output_tokens: 7 } });
  assert.equal(ok.finished, true);
  assert.deepEqual(ok.map({ type: 'assistant', message: { id: 'z', content: [{ type: 'text', text: 'late' }] } }), []);
  const bad = createClaudeEventMapper().map({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['认证失败'] });
  assert.deepEqual(bad, [{ type: 'turn.failed', error: { message: '认证失败' } }]);
  assert.equal(claudeUsage(null), null);
});

test('子代理内部消息不展示', () => {
  const events = run(createClaudeEventMapper(), [{ type: 'assistant', parent_tool_use_id: 'task1', message: { id: 's', content: [{ type: 'text', text: 'inner' }] } }]);
  assert.deepEqual(events, []);
});

test('注册表：合并、分组字段、id 冲突、不可用与出错的 provider 不影响其它', async () => {
  for (const p of listProviders()) unregisterProvider(p.id);
  const base = { runTurn() {}, runIsolatedJob() {} };
  registerProvider({ ...base, id: 'alpha', label: 'A', features: { imageGeneration: true }, listModels: async () => [
    { id: 'a1', displayName: 'A1', reasoningEfforts: ['low', 'high'], defaultReasoning: 'low' },
    { id: 'bad', reasoningEfforts: [], defaultReasoning: 'low' }] });
  registerProvider({ ...base, id: 'beta', label: 'B', listModels: async () => [
    { id: 'a1', reasoningEfforts: ['x'], defaultReasoning: 'x' }, { id: 'b1', reasoningEfforts: ['default'], defaultReasoning: 'default' }] });
  registerProvider({ ...base, id: 'gamma', available: () => false, listModels: async () => { throw new Error('不应调用'); } });
  registerProvider({ ...base, id: 'delta', listModels: async () => { throw new Error('网络错误'); } });
  const catalog = await refreshCatalog({ force: true });
  assert.deepEqual(catalog.map(m => [m.id, m.provider]), [['a1', 'alpha'], ['b1', 'beta']]);
  assert.equal(catalog[0].providerLabel, 'A'); assert.equal(catalog[0].features.imageGeneration, true);
  assert.equal(providerForModel('b1').id, 'beta');
  assert.throws(() => providerForModel('nope'), /不支持/);
  assert.equal(verifiedCatalog().length, 2);
  assert.throws(() => registerProvider({ ...base, id: 'alpha', listModels() {} }), /重复/);
  assert.throws(() => registerProvider({ id: 'zeta', listModels() {} }), /缺少/);
  for (const p of listProviders()) unregisterProvider(p.id);
  await assert.rejects(refreshCatalog({ force: true }), /未返回可用模型/);
});

test('Claude 模型信息转换与推理档位', () => {
  assert.equal(toCatalogModel({ value: 'default', displayName: 'Default' }), null);
  assert.deepEqual(toCatalogModel({ value: 'opus', resolvedModel: 'claude-opus-x', displayName: 'Opus', supportedEffortLevels: ['low', 'medium', 'high', 'max'] }),
    { id: 'claude-opus-x', displayName: 'Opus', reasoningEfforts: ['low', 'medium', 'high', 'max'], defaultReasoning: 'high' });
  assert.deepEqual(toCatalogModel({ value: 'haiku', displayName: 'Haiku', supportsEffort: false }),
    { id: 'haiku', displayName: 'Haiku', reasoningEfforts: ['default'], defaultReasoning: 'default' });
  assert.deepEqual(effortOption('default'), {}); assert.deepEqual(effortOption('max'), { effort: 'max' });
});

test('沙箱工具 JSON Schema -> zod', () => {
  const shape = zodShape(z, { type: 'object', properties: { command: { type: 'string' }, timeout_ms: { type: 'integer', minimum: 1000, maximum: 120000 }, arguments: { type: 'object' } }, required: ['command'] });
  const schema = z.object(shape);
  assert.equal(schema.safeParse({ command: 'ls' }).success, true);
  assert.equal(schema.safeParse({}).success, false);
  assert.equal(schema.safeParse({ command: 'ls', timeout_ms: 5 }).success, false);
  assert.equal(schema.safeParse({ command: 'ls', arguments: { a: 1 } }).success, true);
});

test('统一 MCP 描述：secretEnv 只进环境', () => {
  const spec = { 'shiyan-input': { command: 'node', args: ['x.mjs'], env: { JOB: '1' }, secretEnv: { TOKEN: 's' }, timeoutSec: 7200 } };
  assert.deepEqual(claudeMcpConfig(spec), { 'shiyan-input': { type: 'stdio', command: 'node', args: ['x.mjs'], env: { JOB: '1', TOKEN: 's' } } });
  const codex = codexMcpConfig(spec);
  assert.deepEqual(codex.secret, { TOKEN: 's' });
  assert.deepEqual((codex.servers as any)['shiyan-input'], { command: 'node', args: ['x.mjs'], env: { JOB: '1' }, env_vars: ['TOKEN'], tool_timeout_sec: 7200 });
});

test('对话记录：追加、截取、编辑分支保留', () => {
  let t: any[] = [];
  for (let i = 1; i <= 12; i++) t = appendTranscript(t, 'q' + i, 'a' + i);
  assert.equal(t.length, 20); assert.equal(t[0].text, 'q3');
  assert.match(transcriptText(t), /用户：q12\n\n拾燕：a12$/);
  assert.equal(transcriptText([]), '');
  assert.deepEqual(retainTranscript(t, ['q3', 'q4']).map(x => x.text), ['q3', 'a3', 'q4', 'a4']);
});

test('认证配置检测与 env 文件解析', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'shiyan-claude-'));
  const file = path.join(dir, 'claude.env');
  writeFileSync(file, '# c\nexport ANTHROPIC_API_KEY="sk-x"\nOTHER = y\n');
  assert.deepEqual(readEnvFile(file), { ANTHROPIC_API_KEY: 'sk-x', OTHER: 'y' });
  assert.equal(claudeCredentialsConfigured({ HOME: dir }), false);
  assert.equal(claudeCredentialsConfigured({ HOME: dir, ANTHROPIC_API_KEY: 'k' }), true);
  assert.equal(claudeCredentialsConfigured({ HOME: dir, ANTHROPIC_API_KEY: 'k', SHIYAN_CLAUDE_DISABLED: '1' }), false);
});

test('streamClaude：输入流保持到 result，并输出统一事件', async () => {
  let closedBeforeResult: any = null, captured;
  const fakeSdk = async () => ({ query({ prompt, options }: any) {
    captured = options;
    return (async function* () {
      const it = prompt[Symbol.asyncIterator]();
      const first = await it.next();
      assert.equal(first.value.message.content[0].text, 'hi');
      let ended = false; it.next().then((r: any) => { ended = r.done; });
      yield { type: 'system', subtype: 'init', session_id: 'S' };
      yield { type: 'assistant', parent_tool_use_id: null, message: { id: 'm', content: [{ type: 'text', text: 'ok' }] } };
      await new Promise(r => setTimeout(r, 10)); closedBeforeResult = ended;
      yield { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 1, output_tokens: 2 } };
    })();
  } });
  const events: any[] = [];
  for await (const e of streamClaude({ content: [{ type: 'text', text: 'hi' }], options: { model: 'm' }, sdk: fakeSdk })) events.push(e);
  assert.equal(closedBeforeResult, false);
  assert.ok(captured!.abortController instanceof AbortController);
  assert.deepEqual(events.map(e => e.type), ['thread.started', 'item.completed', 'turn.completed']);
});

test('streamClaude：会话意外结束与中止', async () => {
  const empty = async () => ({ query() { return (async function* () {})(); } });
  const events: any[] = [];
  for await (const e of streamClaude({ content: [], options: {}, sdk: empty })) events.push(e);
  assert.equal(events.at(-1).type, 'turn.failed');
  const controller = new AbortController(); controller.abort(new Error('已停止处理'));
  await assert.rejects(async () => { for await (const _ of streamClaude({ content: [], options: {}, signal: controller.signal, sdk: empty })); }, /已停止处理/);
});
