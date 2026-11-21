import assert from 'node:assert/strict';
import { claudeWindows, claudeExtraUsage, readClaudeUsage, createClaudeQuotaReader, createAccountQuotaReader } from './claude-quota.ts';

const usage = { five_hour: { utilization: 19, resets_at: '2026-10-30T06:00:00.416021+00:00' }, seven_day: { utilization: 60, resets_at: '2026-10-31T03:00:00+00:00' }, seven_day_opus: null, extra_usage: { is_enabled: false } };
assert.deepEqual(claudeWindows(usage, 'pro'), [
  { bucket: 'Claude Pro', period: '5 小时', remainingPercent: 81, resetsAt: Math.round(Date.parse('2026-10-30T06:00:00.416Z') / 1000) },
  { bucket: 'Claude Pro', period: '每周', remainingPercent: 40, resetsAt: Math.round(Date.parse('2026-10-31T03:00:00Z') / 1000) },
]);
assert.equal(claudeWindows({ five_hour: { utilization: 130 } })[0].remainingPercent, 0);
assert.equal(claudeWindows({ five_hour: { utilization: 5 } })[0].resetsAt, null);
assert.deepEqual(claudeWindows(null), []);
assert.equal(claudeExtraUsage(usage), null);
assert.deepEqual(claudeExtraUsage({ extra_usage: { is_enabled: true, utilization: 12, used_credits: 300, monthly_limit: 2000, currency: 'USD' } }), { utilization: 12, usedCredits: 300, monthlyLimit: 2000, currency: 'USD' });

await assert.rejects(readClaudeUsage({ credentials: async () => null }), e => (e as any).code === 'not_logged_in');
await assert.rejects(readClaudeUsage({ credentials: async () => ({ token: 't', expiresAt: Date.now() - 1 }) }), e => (e as any).code === 'expired');
let seen;
const ok = await readClaudeUsage({ credentials: async () => ({ token: 'tok', expiresAt: Date.now() + 1e6, plan: 'max' }), fetchImpl: async (url, init) => { seen = init!.headers; return { ok: true, status: 200, json: async () => usage }; } });
assert.equal(seen.Authorization, 'Bearer tok');
assert.equal(ok.plan, 'max');
await assert.rejects(readClaudeUsage({ credentials: async () => ({ token: 't' }), fetchImpl: async () => ({ ok: false, status: 401 }) }), e => (e as any).code === 'unauthorized');

let reads = 0;
const reader = createClaudeQuotaReader(async () => { reads++; return { plan: 'pro', usage }; });
const [a, b] = await Promise.all([reader(), reader()]);
assert.equal(reads, 1); assert.strictEqual(a, b);
assert.equal(a.plan, 'Claude Pro'); assert.equal(a.windows.length, 2);

const both = await createAccountQuotaReader({ codex: async () => { throw new Error('codex down'); }, claude: reader })();
assert.equal(both.available, false); assert.equal(both.claude.available, true); assert.deepEqual(both.windows, []);
const codexOnly = await createAccountQuotaReader({ codex: async () => ({ available: true, windows: [{ bucket: 'Codex' }], resetCredits: null }), claude: async () => { throw Object.assign(new Error('x'), { code: 'not_logged_in' }); } })();
assert.equal(codexOnly.available, true); assert.equal(codexOnly.claude.available, false); assert.equal(codexOnly.claude.error, '服务器尚未登录 Claude');
await assert.rejects(createAccountQuotaReader({ codex: async () => { throw new Error('a'); }, claude: async () => { throw new Error('b'); } })());
console.log('PASS claude quota windows, credentials, caching, combined degrade');
