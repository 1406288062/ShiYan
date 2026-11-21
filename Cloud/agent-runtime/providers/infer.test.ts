import test from 'node:test';
import assert from 'node:assert/strict';
import { extractJson, validateJson, schemaInstruction, addUsage } from './json-output.ts';
import { inferClaude } from './claude.ts';

const SCHEMA = { type: 'object', additionalProperties: false, required: ['summary', 'score'], properties: { summary: { type: 'string', maxLength: 20 }, score: { type: 'integer', minimum: 0, maximum: 10 } } };

// 每次 query 依次返回脚本里的一段文本；记录收到的内容块与选项
function scripted(texts) {
  const seen = [];
  const sdk = async () => ({ query({ prompt, options }) {
    return (async function* () {
      const first = await prompt[Symbol.asyncIterator]().next();
      seen.push({ blocks: first.value.message.content, options });
      const text = texts.shift();
      yield { type: 'system', subtype: 'init', session_id: 's' };
      yield { type: 'assistant', parent_tool_use_id: null, message: { id: 'm' + seen.length, content: [{ type: 'text', text }] } };
      yield { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 10, output_tokens: 5 } };
    })();
  } });
  return { sdk, seen };
}
const creds = () => true;

test('extractJson：纯 JSON、代码块、前后有说明文字、字符串里含括号', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":[1,2]}\n```'), { a: [1, 2] });
  assert.deepEqual(extractJson('好的，结果如下：\n{"a":"x}y","b":{"c":2}}\n以上。'), { a: 'x}y', b: { c: 2 } });
  assert.deepEqual(extractJson('[1,2,3]'), [1, 2, 3]);
  assert.throws(() => extractJson('没有任何 JSON'), /不是有效的 JSON/);
  assert.throws(() => extractJson('  '), /没有返回内容/);
});

test('validateJson：按完整 schema 校验（含 Claude 原生结构化输出不支持的 maxLength、minimum）', async () => {
  assert.equal((await validateJson(SCHEMA, { summary: '好', score: 3 })).ok, true);
  const long = await validateJson(SCHEMA, { summary: 'x'.repeat(21), score: 3 });
  assert.equal(long.ok, false); assert.match(long.errors, /summary/);
  assert.equal((await validateJson(SCHEMA, { summary: 'a', score: 11 })).ok, false);
  assert.equal((await validateJson(SCHEMA, { summary: 'a' })).ok, false);
  assert.equal((await validateJson({ $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' }, {})).ok, true);
  assert.equal((await validateJson({ type: 'object', properties: { a: { type: 'nope' } } }, {})).skipped, true); // 无法编译的 schema 不阻断调用
  assert.match(schemaInstruction({ type: 'object' }), /JSON Schema/);
  assert.deepEqual(addUsage({ input_tokens: 1 }, { input_tokens: 2, output_tokens: 3 }), { input_tokens: 3, output_tokens: 3 });
});

test('Claude 推理：纯文本，无工具、不落盘会话、替换系统提示词', async () => {
  const { sdk, seen } = scripted(['你好']);
  const out = await inferClaude({ model: 'claude-sonnet-5-5', reasoning: 'low', prompt: '问候一下', sdk, credentials: creds });
  assert.equal(out.text, '你好'); assert.deepEqual(out.usage, { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 });
  const { options, blocks } = seen[0];
  assert.deepEqual(options.tools, []); assert.equal(options.persistSession, false); assert.equal(options.effort, 'low');
  assert.deepEqual(options.settingSources, []); assert.equal(options.mcpServers, undefined); assert.equal(typeof options.systemPrompt, 'string');
  assert.equal(blocks[0].text, '问候一下');
});

test('Claude 推理：当前模型直接获得账号 MCP 工具，不切换 Codex', async () => {
  const { sdk, seen } = scripted(['已通过腾讯文档工具完成']);
  const mcpServers = { 'shiyan_tencent-docs': { command: 'node', args: ['/bridge.mjs'], env: { SHIYAN_MCP_OWNER: 'shiyan-private-owner' } } };
  const mcpToolAllowlist = ['mcp__shiyan_tencent-docs__create_doc', 'mcp__shiyan_tencent-docs__get_doc'];
  const out = await inferClaude({ model: 'claude-sonnet-5-5', prompt: '创建文档', mcpServers, mcpToolAllowlist, sdk, credentials: creds });
  assert.match(out.text, /腾讯文档工具/);
  const options = seen[0].options;
  assert.deepEqual(options.mcpServers, { 'shiyan_tencent-docs': { type: 'stdio', ...mcpServers['shiyan_tencent-docs'] } });
  assert.deepEqual(options.allowedTools, mcpToolAllowlist);
  assert.equal(options.permissionMode, 'dontAsk');
  assert.equal(options.maxTurns, 20);
  assert.match(options.systemPrompt, /MCP 服务/);
});

test('Claude 推理：历史、图片与 schema 提示进入内容块', async () => {
  const { sdk, seen } = scripted(['{"summary":"ok","score":2}']);
  const out = await inferClaude({ model: 'm', reasoning: 'default', prompt: '评分', schema: SCHEMA, history: [{ role: 'user', text: '上一页' }, { role: 'assistant', text: '上一页结果' }],
    images: [{ data: 'QUJD', suffix: '.jpg' }, { data: 'x', suffix: '.exe' }], sdk, credentials: creds });
  assert.equal(out.text, JSON.stringify({ summary: 'ok', score: 2 }));
  const blocks = seen[0].blocks;
  assert.match(blocks[0].text, /用户：上一页[\s\S]*评分[\s\S]*JSON Schema/);
  assert.equal(blocks.length, 2); assert.deepEqual(blocks[1], { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } });
  assert.equal(seen[0].options.effort, undefined); // reasoning=default 不传 effort
});

test('Claude 推理：输出不合规时带着错误重试一次，用量累加', async () => {
  const { sdk, seen } = scripted(['{"summary":"' + 'x'.repeat(30) + '","score":1}', '```json\n{"summary":"短","score":1}\n```']);
  const out = await inferClaude({ model: 'm', prompt: 'p', schema: SCHEMA, sdk, credentials: creds });
  assert.deepEqual(JSON.parse(out.text), { summary: '短', score: 1 }); assert.equal(out.usage.input_tokens, 20); assert.equal(seen.length, 2);
  assert.match(seen[1].blocks[0].text, /没有通过校验[\s\S]*summary/);
});

test('Claude 推理：两次都不合规则报错；没有认证、空输入、空回复', async () => {
  const bad = scripted(['不是 JSON', '还是不是']);
  await assert.rejects(inferClaude({ model: 'm', prompt: 'p', schema: SCHEMA, sdk: bad.sdk, credentials: creds }), error => error.code === 'invalid_output' && /未通过 JSON 校验/.test(error.message));
  await assert.rejects(inferClaude({ model: 'm', prompt: 'p', credentials: () => false }), error => error.code === 'unavailable' && error.status === 503);
  await assert.rejects(inferClaude({ model: 'm', prompt: '  ', credentials: creds }), /prompt or image/);
  const empty = scripted(['   ']);
  await assert.rejects(inferClaude({ model: 'm', prompt: 'p', sdk: empty.sdk, credentials: creds }), error => error.code === 'provider_error');
});

test('Claude 推理：SDK 报错（如未登录）原样带出原因', async () => {
  const sdk = async () => ({ query() { return (async function* () {
    yield { type: 'assistant', parent_tool_use_id: null, message: { id: 'm', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] } };
    yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Not logged in · Please run /login'] };
  })(); } });
  await assert.rejects(inferClaude({ model: 'm', prompt: 'p', sdk, credentials: creds }), error => error.code === 'provider_error' && /Not logged in/.test(error.message));
});
