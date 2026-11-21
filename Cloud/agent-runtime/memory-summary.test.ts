import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from './memory-store.ts';
import { buildMemorySummary, createMemorySummary } from './memory-summary.ts';

test('memory summary is deterministic, cached by revision, and never needs an LLM', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shiyan-memory-summary-'));
  const store = new MemoryStore(root);
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const owner = 'summary-test-owner';
  store.create(owner, { category: 'profile', content: '长期从事软件开发' });
  store.create(owner, { category: 'preference', content: '偏好简洁直接的回答' });
  store.create(owner, { category: 'preference', content: '偏好简洁直接的回答' });
  store.create(owner, { category: 'project', content: '拾燕项目使用 Node.js' });

  const summary = createMemorySummary(store, { now: () => 123456 });
  const first = summary.get(owner);
  assert.equal(first.state, 'ready');
  assert.equal(first.generatedAt, 123456);
  assert.deepEqual(first.sections.map(section => section.id), ['profile', 'preference', 'project']);
  assert.equal(first.sections.find(section => section.id === 'preference').points.length, 1);

  const second = summary.get(owner);
  assert.deepEqual(second, first);
  store.create(owner, { category: 'context', content: '正在优化记忆页面' });
  const updated = summary.get(owner);
  assert.equal(updated.generatedAt, 123456);
  assert.deepEqual(updated.sections.map(section => section.id), ['profile', 'preference', 'project', 'context']);
});

test('summary builder preserves category order and limits each section', () => {
  const memories = Array.from({ length: 12 }, (_, index) => ({
    category: 'preference', content: '偏好 ' + index
  }));
  const result = buildMemorySummary(memories);
  assert.equal(result.length, 1);
  assert.equal(result[0].points.length, 8);
});
