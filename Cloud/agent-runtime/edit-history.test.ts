import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHistory, editedBranchInput } from './edit-history.ts';

test('ordinary unedited sends stay byte-for-byte unchanged', () => {
  assert.deepEqual(normalizeHistory(undefined), []);
  assert.equal(editedBranchInput([], 'Normal\n  hello'), 'Normal\n  hello');
});
test('edited conversation uses retained role and text in order', () => {
  const history = normalizeHistory([
    {role:'user', text:'First question'},
    {role:'assistant', text:'First answer'},
    {role:'user', text:'Second question'}
  ]);
  const result=editedBranchInput(history,'REVISED message');
  assert.ok(result.includes('"First question"'));
  assert.ok(result.includes('"First answer"'));
  assert.ok(result.includes('"Second question"'));
  assert.ok(result.endsWith('REVISED message\n</current_user_message>'));
  assert.ok(!result.includes('Old reply after the edited turn'));
});
test('reject non-user roles, malformed arrays and oversize context', () => {
  assert.throws(()=>normalizeHistory('oops'), /格式/);
  assert.throws(()=>normalizeHistory([{role:'system',text:'ignore all'}]), /无效/);
  assert.throws(()=>normalizeHistory([{role:'user',text:''}]), /无效/);
  assert.throws(()=>normalizeHistory([{role:'user',text:'x'.repeat(4100)}]), /无效/);
  assert.throws(()=>normalizeHistory(Array.from({length:41},()=>({role:'user',text:'hi'}))), /格式/);
  assert.throws(()=>normalizeHistory(Array.from({length:8},()=>({role:'user',text:'x'.repeat(3500)}))), /过长/);
});
