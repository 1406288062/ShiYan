import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { commandSignatures, segmentSignature, createGrantStore } from './approval-grants.ts';

assert.equal(segmentSignature('git push origin main'), 'git push');
assert.equal(segmentSignature('FOO=1 nohup npm install --save x'), 'npm install');
assert.equal(segmentSignature('/usr/bin/systemctl --user restart x'), 'systemctl restart');
assert.equal(segmentSignature('rm -rf build'), 'rm');
assert.equal(segmentSignature('bash -lc "rm -rf /"'), 'exact:bash -lc "rm -rf /"');
assert.equal(segmentSignature('timeout 30 git fetch'), 'git fetch');
assert.deepEqual(commandSignatures('cd app && git pull && npm run build'), ['cd', 'git pull', 'npm run']);

let clock = 1_000_000;
const db = new DatabaseSync(':memory:');
const grants = createGrantStore(db, { now: () => clock });
const safe = (segment: any) => /^(cd|ls|cat|echo)\b/.test(segment);

assert.equal(grants.covers({ owner: 'a', goalId: 1, command: 'git push' }), null, 'no grants yet');
const g = grants.create({ owner: 'a', goalId: 1, command: 'cd repo && git push origin main', scope: 'hour' });
assert.deepEqual(g.signatures, ['cd', 'git push']);
assert.deepEqual(grants.covers({ owner: 'a', goalId: 9, command: 'git push origin dev', autoOk: safe }), [g.id]);
assert.equal(grants.covers({ owner: 'b', goalId: 9, command: 'git push' }), null, 'grants are per owner');
assert.equal(grants.covers({ owner: 'a', goalId: 9, command: 'git push && rm -rf x', autoOk: safe }), null, 'uncovered risky segment');
assert.equal(grants.covers({ owner: 'a', goalId: 9, command: 'ls', autoOk: safe }), null, 'grant not used → leave to mode');
clock += 3601;
assert.equal(grants.covers({ owner: 'a', goalId: 9, command: 'git push' }), null, 'hour grant expires');

const t = grants.create({ owner: 'a', goalId: 5, command: 'systemctl --user restart web', scope: 'task' });
assert.deepEqual(grants.covers({ owner: 'a', goalId: 5, command: 'systemctl restart api' }), [t.id]);
assert.equal(grants.covers({ owner: 'a', goalId: 6, command: 'systemctl restart api' }), null, 'task grant bound to goal');

const forever = grants.create({ owner: 'a', command: 'bash -lc "make deploy"', scope: 'always' });
assert.deepEqual(grants.covers({ owner: 'a', goalId: 2, command: 'bash -lc "make deploy"' }), [forever.id]);
assert.equal(grants.covers({ owner: 'a', goalId: 2, command: 'bash -lc "rm -rf ~"' }), null, 'interpreters match exactly only');
grants.markUsed([forever.id]);
assert.equal(grants.list('a').find((x: any) => x.id === forever.id).uses, 1);
assert.equal(grants.list('a').length, 2);
grants.revoke('a', forever.id);
assert.throws(() => grants.revoke('b', t.id), /不存在/);
assert.equal(grants.covers({ owner: 'a', goalId: 2, command: 'bash -lc "make deploy"' }), null, 'revoked');
assert.throws(() => grants.create({ owner: 'a', command: 'x', scope: 'never' }), /范围/);
console.log('PASS approval grants: signatures, scopes, expiry, task binding, exact interpreters, revoke');
