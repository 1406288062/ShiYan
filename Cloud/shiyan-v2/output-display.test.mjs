import test from 'node:test';
import assert from 'node:assert/strict';
import { projectDisplayItem, upsertDisplayItem, displayItemsForJob, jobSnapshot, projectUsage } from './output-display.mjs';
import { cleanSyncData, jobMessageData } from './sync-store.mjs';

const command = (id, overrides = {}) => ({ id, type: 'command_execution', command: 'npm test', aggregated_output: '', status: 'in_progress', ...overrides });
const message = (overrides = {}) => ({ id: 'message-id', conversationId: 'conversation-id', role: 'assistant', text: 'answer', ...overrides });

test('commands retain factual status and exit code within display bounds, without modifying SDK item', () => {
  const raw = command('command-id', { command: 'c'.repeat(2000), aggregated_output: '\x1b[31m' + 'o'.repeat(8000) + '\x1b[0m', status: 'failed', exit_code: 2 });
  const snapshot = JSON.stringify(raw), result = projectDisplayItem(raw);
  assert.equal(result.command.length, 1000);
  assert.equal(result.aggregated_output.length, 4000);
  assert.equal(result.aggregated_output.includes('\x1b'), false);
  assert.equal(result.status, 'failed'); assert.equal(result.exit_code, 2);
  assert.equal(JSON.stringify(raw), snapshot);
});

test('MCP projection excludes arguments, images, binary strings and structured payloads', () => {
  const raw = { id: 'tool-id', type: 'mcp_tool_call', server: 'demo', tool: 'inspect', status: 'failed',
    arguments: { password: 'secret-argument' }, error: { message: 'Tool failed' },
    result: { content: [{ type: 'text', text: 'Readable result' }, { type: 'image', data: 'private-base64' },
      { type: 'text', text: 'binary\0data' }, { type: 'text', text: 'data:image/png;base64,private-data' }],
      structured_content: { private: 'private-structured' } } };
  const result = projectDisplayItem(raw), encoded = JSON.stringify(result);
  assert.equal(result.result_text, 'Readable result'); assert.equal(result.error.message, 'Tool failed');
  for (const value of ['secret-argument', 'private-base64', 'private-structured', 'binary', 'private-data']) assert.equal(encoded.includes(value), false);
  assert.deepEqual(projectDisplayItem(result), result, 'sanitizing an already projected sync item is idempotent');
});

test('MCP text-only output and errors are bounded independently', () => {
  const result = projectDisplayItem({ id: 'tool-id', type: 'mcp_tool_call', result: { content: [{ type: 'text', text: 'x'.repeat(10000) }] }, error: { message: 'e'.repeat(2000) } });
  assert.equal(result.result_text.length, 4000); assert.equal(result.error.message.length, 1000);
});

test('long command and tool output retain both the beginning and final diagnostics', () => {
  const output = 'START: build\n' + 'log line\n'.repeat(1000) + 'FAIL: final error details';
  const cmd = projectDisplayItem(command('command-id', { aggregated_output: output, status: 'failed', exit_code: 1 }));
  const tool = projectDisplayItem({ id: 'tool-id', type: 'mcp_tool_call', result: { content: [{ type: 'text', text: output }] } });
  for (const value of [cmd.aggregated_output, tool.result_text]) {
    assert.equal(value.length, 4000); assert.equal(value.startsWith('START: build\n'), true);
    assert.equal(value.endsWith('FAIL: final error details'), true); assert.equal(value.includes('\n…\n'), true);
  }
});

test('started items keep start order when later items finish first; replay replaces without duplicate', () => {
  let result = upsertDisplayItem([], command('first'), 'item.started');
  result = upsertDisplayItem(result.displayItems, command('second'), 'item.started', result.displayItemOrder);
  result = upsertDisplayItem(result.displayItems, command('second', { status: 'completed' }), 'item.completed', result.displayItemOrder);
  result = upsertDisplayItem(result.displayItems, command('first', { status: 'failed', exit_code: 1 }), 'item.completed', result.displayItemOrder);
  assert.deepEqual(result.displayItems.map(item => item.id), ['first', 'second']);
  assert.equal(result.displayItems[0].status, 'failed');
  const replay = upsertDisplayItem(result.displayItems, command('first', { status: 'failed', exit_code: 1 }), 'item.completed', result.displayItemOrder);
  assert.deepEqual(replay, result);
});

test('plan, search, file changes, collaboration and nonfatal errors have compact factual schemas', () => {
  assert.deepEqual(projectDisplayItem({ id: 'plan', type: 'todo_list', items: [{ text: 'Inspect', completed: true }] }).items, [{ text: 'Inspect', completed: true }]);
  assert.equal(projectDisplayItem({ id: 'search', type: 'web_search', query: 'reference' }, 'item.started').status, 'in_progress');
  assert.equal(projectDisplayItem({ id: 'search', type: 'web_search', query: 'reference' }, 'item.completed').status, 'completed');
  assert.deepEqual(projectDisplayItem({ id: 'files', type: 'file_change', changes: [{ path: 'app.js', kind: 'update', diff: 'not included' }] }).changes, [{ path: 'app.js', kind: 'update' }]);
  const collaboration = projectDisplayItem({ id: 'team', type: 'collab_tool_call', tool: 'spawn_agent', receiver_thread_ids: ['one', 'two'], prompt: 'private context' });
  assert.equal(collaboration.count, 2); assert.deepEqual(projectDisplayItem(collaboration), collaboration); assert.equal('prompt' in collaboration, false);
  assert.equal(projectDisplayItem({ id: 'error', type: 'error', message: 'Retryable error' }).status, 'failed');
});

test('unknown types and malformed records are ignored; assistant text is not duplicated', () => {
  for (const item of [null, {}, { id: 'unknown', type: 'future_item', data: 'private' }, { id: 'message', type: 'agent_message', text: 'answer' }, { id: 'empty-thought', type: 'reasoning', text: '  ' }]) assert.equal(projectDisplayItem(item), null);
  assert.deepEqual(projectDisplayItem({ id: 'thinking', type: 'reasoning', text: '先看日志' }), { id: 'thinking', type: 'reasoning', status: 'completed', text: '先看日志' });
});

test('whole projection is bounded and late completion cannot reorder an evicted earlier item', () => {
  let result = { displayItems: [], displayItemOrder: [] };
  for (let n = 0; n < 160; n++) result = upsertDisplayItem(result.displayItems, command(String(n), { aggregated_output: 'x'.repeat(4000) }), 'item.started', result.displayItemOrder);
  assert.equal(result.displayItems.length <= 128, true);
  assert.equal(Buffer.byteLength(JSON.stringify(result.displayItems)) <= 64 * 1024, true);
  const before = result.displayItems.map(item => Number(item.id));
  result = upsertDisplayItem(result.displayItems, command('0', { status: 'completed' }), 'item.completed', result.displayItemOrder);
  assert.deepEqual(result.displayItems.map(item => Number(item.id)), before);
});

test('snapshots restore display details, code cards and validated usage when reconnecting', () => {
  const job = { id: 'job', status: 'completed', text: 'answer', items: [command('one', { status: 'completed', exit_code: 0 })],
    fileChanges: [{ path: 'app.js', added: 2, removed: 1 }], usage: { input_tokens: 12, cached_input_tokens: 5, output_tokens: 8, secret: 'excluded' } };
  const snapshot = jobSnapshot(job);
  assert.equal(snapshot.displayItems[0].exit_code, 0); assert.deepEqual(snapshot.fileChanges, job.fileChanges);
  assert.deepEqual(snapshot.usage, { input_tokens: 12, cached_input_tokens: 5, output_tokens: 8 });
  assert.deepEqual(displayItemsForJob({ ...job, displayItems: [] }), [], 'explicit empty projection is authoritative');
});

test('authoritative sync preserves details and usage, and clears phase for every terminal status', () => {
  const base = message({ phase: 'Old phase' });
  for (const status of ['completed', 'cancelled', 'failed', 'interrupted']) {
    const data = jobMessageData({ id: 'job', status, text: 'answer', items: [command('one', { status: 'failed' })],
      events: [{ type: 'phase', label: 'Calling tool' }], usage: { input_tokens: 12, output_tokens: 8 }, updatedAt: 100 }, base);
    assert.equal(data.phase, ''); assert.equal(data.displayItems[0].status, 'failed'); assert.equal(data.usage.output_tokens, 8);
  }
  assert.equal(jobMessageData({ status: 'running', events: [{ type: 'phase', label: 'Calling tool' }] }, base).phase, 'Calling tool');
});

test('sync whitelist retains sanitized display fields and strips unrelated fields and invalid counters', () => {
  const projected = projectDisplayItem({ id: 'tool-id', type: 'mcp_tool_call', server: 'demo', tool: 'inspect', result: { content: [{ type: 'text', text: 'result' }] } });
  const clean = cleanSyncData('messages', 'message-id', message({ displayItems: [projected], usage: { input_tokens: 7, cached_input_tokens: -1, output_tokens: 3.5, extra: 12 }, privateField: 'not syncable' }));
  assert.deepEqual(clean.displayItems, [projected]); assert.deepEqual(clean.usage, { input_tokens: 7 }); assert.equal('privateField' in clean, false);
  assert.throws(() => cleanSyncData('messages', 'message-id', message({ displayItems: 'bad' })), /输出显示/);
  assert.equal(projectUsage({ input_tokens: NaN, cached_input_tokens: Infinity, output_tokens: '20' }), null);
});
