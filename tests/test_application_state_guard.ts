import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../shared/frontend/app.js', import.meta.url), 'utf8');
const declaration = source.match(/function isApplicationStateSnapshot\(value\) \{[\s\S]*?\n  \}/)?.[0];
assert.ok(declaration, 'application state snapshot guard must exist');
const context: any = {};
vm.runInNewContext(`${declaration}; this.isApplicationStateSnapshot = isApplicationStateSnapshot;`, context);

test('domain status strings never qualify as application snapshots', () => {
  for (const state of ['login', 'connected', 'login_expired', 'wait', '']) {
    assert.equal(context.isApplicationStateSnapshot(state), false, state);
  }
});

test('partial objects and arrays cannot replace the global application state', () => {
  for (const state of [null, undefined, [], {}, { state: 'connected' }, { history: [] }, { conversations: {} }]) {
    assert.equal(context.isApplicationStateSnapshot(state), false);
  }
});

test('a complete application snapshot with conversations is accepted', () => {
  const snapshot = { conversations: [], history: [], selectedConversationId: null, version: 1 };
  assert.equal(context.isApplicationStateSnapshot(snapshot), true);
});

test('the shared API applies only complete application snapshots', () => {
  assert.match(source, /if\(isApplicationStateSnapshot\(data\.state\)\) applyState\(data\.state\);/);
  assert.doesNotMatch(source, /if\(data\.state\) applyState\(data\.state\);/);
});
