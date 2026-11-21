import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync, sign, createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = await mkdtemp(path.join(path.dirname(fileURLToPath(import.meta.url)), '.quota-auth-test-'));
const originalRoot = process.env.SHIYAN_ROOT;
process.env.SHIYAN_ROOT = root;
const { createQuotaSidecar } = await import('./account-quota-sidecar.ts');
const { createQuotaReader } = await import('./account-quota.ts');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const emptyHash = hash(Buffer.alloc(0));
function makeDevice() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const id = hash(raw);
  return { id, privateKey, entry: { id, publicKey: raw.toString('base64'), owner: 'shiyan-private-owner', approved: true } };
}
const first = makeDevice(), second = makeDevice(), unapproved = makeDevice();
const registry = { [first.id]: first.entry, [second.id]: second.entry, [unapproved.id]: { ...unapproved.entry, approved: false } };
const saveRegistry = () => writeFile(path.join(root, 'devices.json'), JSON.stringify(registry), { mode: 0o600 });
await saveRegistry();
const endpoint = '/shiyan/v1/account/quota';
function headers(device = first, { method = 'GET', url = endpoint, nonce = randomUUID(), timestamp = Date.now(), bodyHash = emptyHash } = {}) {
  const message = [method, url, String(timestamp), nonce, bodyHash].join('\n');
  return {
    'x-shiyan-device': device.id,
    'x-shiyan-time': String(timestamp),
    'x-shiyan-nonce': nonce,
    'x-shiyan-body-sha': bodyHash,
    'x-shiyan-signature': sign(null, Buffer.from(message), device.privateKey).toString('base64')
  };
}
function request(server, { method = 'GET', url = endpoint, signed = headers(first, { method, url }), body, chunked = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: url, method, headers: { ...signed, ...(chunked ? { 'Transfer-Encoding': 'chunked' } : body ? { 'Content-Length': Buffer.byteLength(body) } : {}) } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('test HTTP timeout')));
    req.end(body);
  });
}
async function withServer(readQuota, callback) {
  const server = createQuotaSidecar({ readQuota });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await callback(server); }
  finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
const upstream = {
  rateLimits: { primary: { usedPercent: 62, windowDurationMins: 10080, resetsAt: 1792500000 } },
  rateLimitResetCredits: { availableCount: 3, credits: [{ id: 'card-1', resetType: 'codexRateLimits', status: 'available', grantedAt: 1792000000, expiresAt: 1793000000, title: 'Codex 重置卡', description: '可用重置卡', privateAccountId: 'must-not-leak' }] }
};

test('real signed GET returns normalized weekly quota and three reset credits', async () => {
  let reads = 0;
  await withServer(createQuotaReader(async () => { reads++; return upstream; }), async server => {
    const response = await request(server);
    assert.equal(response.status, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(Number(response.headers['content-length']), Buffer.byteLength(JSON.stringify(response.json)));
    assert.equal(response.json.ok, true);
    assert.equal(response.json.quota.resetCredits.availableCount, 3);
    assert.equal(response.json.quota.resetCredits.credits.length, 1, 'detail count must not replace authoritative count');
    assert.equal(response.json.quota.resetCredits.credits[0].resetType, 'codexRateLimits');
    assert.equal(response.json.quota.resetCredits.credits[0].privateAccountId, undefined);
    assert.equal(response.json.quota.windows[0].remainingPercent, 38);
    assert.equal(response.json.quota.windows[0].period, '每周');
    assert.equal(reads, 1);
  });
});

test('signature covers complete original URL and method; unauthenticated requests do not call upstream', async () => {
  let reads = 0;
  await withServer(async () => { reads++; return {}; }, async server => {
    for (const options of [
      { signed: {} },
      { signed: headers(unapproved) },
      { signed: headers(first, { timestamp: Date.now() - 600000 }) },
      { url: endpoint + '?refresh=2', signed: headers(first, { url: endpoint + '?refresh=1' }) },
      { url: '/shiyan/v1/account/other', signed: headers() },
      { method: 'POST', signed: headers() }
    ]) {
      const response = await request(server, options);
      assert.equal(response.status, 401);
      assert.equal(response.json.error, '服务连接未获授权');
    }
    assert.equal(reads, 0);
  });
});

test('same signed request cannot be replayed on the sidecar', async () => {
  let reads = 0;
  await withServer(async () => { reads++; return { available: true }; }, async server => {
    const signed = headers();
    assert.equal((await request(server, { signed })).status, 200);
    assert.equal((await request(server, { signed })).status, 401);
    assert.equal(reads, 1);
  });
});

test('device revocation takes effect after registry update, without restarting service', async () => {
  let reads = 0;
  await withServer(async () => { reads++; return {}; }, async server => {
    assert.equal((await request(server)).status, 200);
    registry[first.id] = { ...first.entry, revoked: true };
    await saveRegistry();
    try { assert.equal((await request(server)).status, 401); }
    finally { registry[first.id] = first.entry; await saveRegistry(); }
    assert.equal((await request(server)).status, 200);
    assert.equal(reads, 2);
  });
});

test('authenticated wrong method, wrong route and signed nonempty body are rejected before upstream', async () => {
  let reads = 0;
  await withServer(async () => { reads++; return {}; }, async server => {
    const method = await request(server, { method: 'POST' });
    assert.equal(method.status, 405);
    assert.equal(method.headers.allow, 'GET');
    assert.equal((await request(server, { url: '/shiyan/v1/account/reset' })).status, 404);
    const body = 'not permitted';
    assert.equal((await request(server, { body, signed: headers(first, { bodyHash: hash(body) }) })).status, 400);
    assert.equal((await request(server, { body, signed: headers() })).status, 400, 'empty declared digest cannot bypass nonempty Content-Length');
    assert.equal((await request(server, { body, chunked: true, signed: headers() })).status, 400, 'chunked content is rejected even with a signed empty digest');
    assert.equal(reads, 0);
  });
});

test('upstream failure returns generic unavailable result and never exception details', async () => {
  await withServer(async () => { throw new Error('secret-token: private upstream stack'); }, async server => {
    const response = await request(server);
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { ok: true, quota: { available: false, windows: [], resetCredits: null, error: '暂时无法获取账户额度与重置卡信息' } });
    assert.equal(JSON.stringify(response.json).includes('secret-token'), false);
  });
});

test('concurrent requests share one upstream read and cached account snapshot across approved devices', async () => {
  let reads = 0, enteredResolve, release;
  const entered = new Promise(resolve => { enteredResolve = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const readQuota = createQuotaReader(async () => { reads++; enteredResolve(); await gate; return upstream; });
  await withServer(readQuota, async server => {
    const one = request(server);
    await entered;
    const two = request(server, { signed: headers(second) });
    release();
    const results = await Promise.all([one, two]);
    assert.equal(reads, 1);
    for (const result of results) assert.equal(result.json.quota.resetCredits.availableCount, 3);
    assert.deepEqual(results[0].json, results[1].json);
    const cached = await request(server);
    assert.deepEqual(cached.json, results[0].json);
    assert.equal(reads, 1);
  });
});

test.after(async () => {
  if (originalRoot === undefined) delete process.env.SHIYAN_ROOT;
  else process.env.SHIYAN_ROOT = originalRoot;
  await rm(root, { recursive: true, force: true });
});
