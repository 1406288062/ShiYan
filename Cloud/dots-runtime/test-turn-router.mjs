import test from 'node:test';
import assert from 'node:assert/strict';
import { createTurnRouter, isTrivial, buildRoutePrompt } from './turn-router.mjs';

const ev = content => ({ type: 'user_message', payload: JSON.stringify({ id: 1, content }) });
const fake = (reply, calls = []) => async (data, schema, control) => { calls.push({ data, control }); if (reply instanceof Error) throw reply; return reply; };

test('纯寒暄由规则判为轻路，不调用模型', async () => {
  const calls = [];
  const route = createTurnRouter({ assess: fake({ route: 'full', reason: 'x' }, calls) });
  assert.equal((await route({ events: [ev('好的')] })).route, 'light');
  assert.equal((await route({ events: [ev('谢谢！'), ev('晚安')] })).by, 'rule');
  assert.equal(calls.length, 0);
});

test('带图片或非用户消息直接走重路', async () => {
  const calls = [];
  const route = createTurnRouter({ assess: fake({ route: 'light', reason: 'x' }, calls) });
  assert.equal((await route({ events: [ev('嗯')], hasImages: true })).route, 'full');
  assert.equal((await route({ events: [{ type: 'task_result', payload: '{}' }] })).route, 'full');
  assert.equal((await route({ events: [] })).route, 'full');
  assert.equal(calls.length, 0);
});

test('其余消息按模型判断，来源是 dots-route，并带上最近对话和任务', async () => {
  const calls = [], records = [];
  const route = createTurnRouter({ assess: fake({ route: 'light', reason: '查天气' }, calls), record: r => records.push(r) });
  const out = await route({ events: [ev('今天武汉天气怎么样')], recent: [{ role: 'assistant', content: '早' }], tasks: ['整理论文'] });
  assert.equal(out.route, 'light'); assert.equal(out.by, 'model');
  assert.equal(calls[0].control.source, 'dots-route');
  const prompt = JSON.parse(calls[0].data);
  assert.deepEqual(prompt.new_user_messages, ['今天武汉天气怎么样']);
  assert.deepEqual(prompt.active_tasks, ['整理论文']);
  assert.equal(records.length, 1);
});

test('模型判断失败时走重路', async () => {
  const route = createTurnRouter({ assess: fake(new Error('timeout')), logger: { warn() {} } });
  const out = await route({ events: [ev('现在进度呢')] });
  assert.equal(out.route, 'full'); assert.equal(out.by, 'fallback');
});

test('寒暄识别不吞掉带意图的短句', () => {
  assert.equal(isTrivial('嗯嗯'), true);
  assert.equal(isTrivial('好的，开始吧'), false);
  assert.equal(isTrivial('在吗？帮我看下'), false);
  assert.ok(buildRoutePrompt({ messages: ['x'.repeat(5000)] }).length < 4000);
});
