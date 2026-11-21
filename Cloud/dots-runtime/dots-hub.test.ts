import test from 'node:test';
import assert from 'node:assert/strict';
import { createDotsHub, dotsConsumer } from './dots-hub.ts';

const client = (route, reply: any = {}) => {
  const calls: any[] = [];
  return { calls, route: async consumer => { calls.push(['route', consumer]); return route; },
    infer: async (consumer, body, options) => { calls.push(['infer', consumer, body, options]); if (reply.error) throw new Error(reply.error); return { finalResponse: reply.text ?? '{"ok":true}' }; } };
};
const GPT = { provider: 'openai', model: 'gpt-6-sol', reasoning: 'high' };
const CLAUDE = { provider: 'anthropic', model: 'claude-sonnet-5-5', reasoning: 'low' };

test('来源到调用方的映射', () => {
  assert.equal(dotsConsumer('dots-mail-summary'), 'dots.mail');
  assert.equal(dotsConsumer('dots-github-summary'), 'dots.github');
  assert.equal(dotsConsumer('dots-proactive'), 'dots.proactive');
  assert.equal(dotsConsumer(undefined), 'dots.proactive');
});

test('中枢不可用：返回空对象，沿用原有默认', async () => {
  const c = client(null);
  assert.deepEqual(await createDotsHub(c).plan('dots-proactive', { data: 'x', schema: {} }), {});
  assert.equal(c.calls.some(call => call[0] === 'infer'), false);
});

test('GPT 路由：仍由 Codex 执行，只带回中枢指定的模型与强度', async () => {
  const c = client(GPT);
  assert.deepEqual(await createDotsHub(c).plan('dots-mail-summary', { data: 'x', schema: {} }), { settings: { model: 'gpt-6-sol', effort: 'high' } });
  assert.deepEqual(c.calls, [['route', 'dots.mail']]);
});

test('Claude 路由：交给中枢，返回解析好的 JSON，并带上取消信号', async () => {
  const c = client(CLAUDE, { text: '{"action":"discard","reason":"测试"}' });
  const controller = new AbortController();
  const out = await createDotsHub(c).plan('dots-github-summary', { data: '提示词', schema: { type: 'object' }, signal: controller.signal });
  assert.deepEqual(out, { result: { action: 'discard', reason: '测试' } });
  const infer = c.calls.find(call => call[0] === 'infer')!;
  assert.equal(infer[1], 'dots.github'); assert.deepEqual(infer[2], { prompt: '提示词', outputSchema: { type: 'object' } }); assert.equal(infer[3].signal, controller.signal);
});

test('Claude 路由出错：错误向上抛出（与 Codex 失败时一致）；返回内容不是 JSON 也会抛出', async () => {
  await assert.rejects(createDotsHub(client(CLAUDE, { error: '额度不足' })).plan('dots-proactive', { data: 'x', schema: {} }), /额度不足/);
  await assert.rejects(createDotsHub(client(CLAUDE, { text: '不是 JSON' })).plan('dots-proactive', { data: 'x', schema: {} }), SyntaxError);
});
