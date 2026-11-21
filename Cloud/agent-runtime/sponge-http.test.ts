import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createSpongeHTTPHandler } from './sponge-http.ts';

async function fixture(t, overrides = {}) {
  const calls: any[] = [];
  const client = {
    status: async owner => { calls.push(['status', owner]); return { ok: true, connected: true, accountName: 'own-account', devices: [{ deviceId: 'own-device', name: 'Mac', ready: true, token: 'private-device-token' }], needsPairing: false, access_token: 'private-oauth' }; },
    start: async auth => { calls.push(['start', auth]); return { authorizeUrl: 'https://mcp.yandot.ai/oauth/authorize?state=test', refresh_token: 'private-refresh' }; },
    disconnect: async owner => { calls.push(['disconnect', owner]); return {}; }, rpc: async () => ({}), ...overrides,
  };
  const handler = createSpongeHTTPHandler({ client });
  const server = http.createServer(async (req, res) => {
    const auth = req.headers['x-fixture-owner'] ? { owner: req.headers['x-fixture-owner'], userId: 'user-A', sessionId: 'session-A', accountSession: true } : null;
    const readBody = async (req, limit) => {
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > limit) throw Object.assign(Error('too large'), { status: 413 }); chunks.push(chunk); }
      return JSON.parse(Buffer.concat(chunks).toString() || '{}');
    };
    if (!await handler(req, res, auth, readBody)) res.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const request = async (route, method = 'GET', body?: any, owner: any = 'A') => {
    const response = await fetch(`http://127.0.0.1:${(server.address() as any).port}${route}`, { method,
      headers: { ...(owner ? { 'X-Fixture-Owner': owner } : {}), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, value: (response.status === 404 ? null : await response.json()) as any, headers: response.headers };
  };
  return { calls, request };
}
const base = '/v1/integrations/sponge';

test('status is account-scoped and redacts all credential fields', async t => {
  const f = await fixture(t);
  const result = await f.request('/shiyan' + base + '/status?owner=B');
  assert.equal(result.status, 200);
  assert.deepEqual(result.value, { ok: true, connected: true, accountName: 'own-account', devices: [{ deviceId: 'own-device', name: 'Mac', ready: true }], needsPairing: false });
  assert.deepEqual(f.calls, [['status', 'A']]);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(JSON.stringify(result.value).includes('private-'), false);
  assert.equal((await f.request(base + '/status', 'GET', undefined, null)).status, 401);
});

test('start takes identity exclusively from authenticated request and returns only authorization URL', async t => {
  const f = await fixture(t);
  const result = await f.request(base + '/start', 'POST', {});
  assert.equal(result.status, 200);
  assert.deepEqual(result.value, { ok: true, authorizeUrl: 'https://mcp.yandot.ai/oauth/authorize?state=test' });
  assert.deepEqual(f.calls[0], ['start', { owner: 'A', userId: 'user-A', sessionId: 'session-A', accountSession: true }]);
  const before = f.calls.length;
  for (const input of [{ owner: 'B' }, { auth: { owner: 'B' } }, { socketPath: '/tmp/other.sock' }, { access_token: 'bad' }]) assert.equal((await f.request(base + '/start', 'POST', input)).status, 400);
  assert.equal(f.calls.length, before);
});

test('disconnect variants affect only the authenticated owner', async t => {
  const f = await fixture(t);
  assert.equal((await f.request(base, 'DELETE')).value.connected, false);
  assert.equal((await f.request(base + '/disconnect', 'POST', {}, 'B')).status, 200);
  assert.deepEqual(f.calls, [['disconnect', 'A'], ['disconnect', 'B']]);
  assert.equal((await f.request(base + '/disconnect', 'POST', { owner: 'A' }, 'B')).status, 400);
  assert.equal((await f.request(base + '/start', 'GET')).status, 405);
  assert.equal((await f.request('/unrelated')).status, 404);
});

test('broker authorization failures keep their safe status and rejected URLs never reach the browser', async t => {
  const f = await fixture(t, { status: async () => { throw Object.assign(Error('请重新连接海绵宝宝'), { status: 403 }); }, start: async () => ({ authorizeUrl: 'http://localhost/internal', token: 'private' }) });
  assert.deepEqual((await f.request(base + '/status')).value, { ok: false, error: '请重新连接海绵宝宝' });
  assert.equal((await f.request(base + '/status')).status, 403);
  const bad = await f.request(base + '/start', 'POST', {});
  assert.equal(bad.status, 502);
  assert.equal(JSON.stringify(bad.value).includes('private'), false);
});
