import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createSpongeClient, createSpongeMcpAdapter } from './sponge-client.ts';

const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
async function fixture(t, handler) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sponge-client-'));
  const socketPath = path.join(directory, 'connector.sock');
  const received = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    received.push({ path: req.url, headers: req.headers, input });
    await handler(req, res, input);
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  return { socketPath, received };
}

test('Unix client uses the fixed socket, exact protocol, and no caller credential headers', async t => {
  const f = await fixture(t, (req, res, input) => json(res, 200, req.url === '/status' ?
    { ok: true, connected: input.owner === 'A', devices: [], needsPairing: false } : { ok: true, result: { accepted: true } }));
  const client = createSpongeClient({ socketPath: f.socketPath });
  assert.equal((await client.status('A')).connected, true);
  await client.start({ owner: 'A', userId: 'user-A', sessionId: 'session-A', accountSession: true, token: 'never-forward', role: 'admin' });
  await client.disconnect('A');
  assert.deepEqual(await client.rpc('A', 'tools/list', {}), { accepted: true });
  assert.deepEqual(f.received.map(r => r.path), ['/status', '/start', '/disconnect', '/rpc']);
  assert.deepEqual(f.received[1].input, { auth: { owner: 'A', userId: 'user-A', sessionId: 'session-A', accountSession: true } });
  for (const record of f.received) assert.equal(record.headers.authorization, undefined);
  assert.equal(JSON.stringify(f.received).includes('never-forward'), false);
  assert.throws(() => client.start({ owner: 'A', accountSession: false }), { status: 401 });
  assert.throws(() => client.rpc('A', 'arbitrary/url', {}), { status: 400 });
});

test('request size is checked before sending and response size is bounded', async t => {
  const f = await fixture(t, (req, res) => {
    if (req.url === '/status') { res.writeHead(200, { 'Content-Length': 8 * 1024 * 1024 + 1 }); res.end(' '); }
    else { res.writeHead(200); res.end(' '.repeat(8 * 1024 * 1024 + 1)); }
  });
  const client = createSpongeClient({ socketPath: f.socketPath });
  await assert.rejects(client.rpc('A', 'tools/call', { name: 'read_file', arguments: { text: 'x'.repeat(1024 * 1024) } }), { status: 413 });
  assert.equal(f.received.length, 0);
  await assert.rejects(client.status('A'), /返回内容过大/);
  await assert.rejects(client.rpc('A', 'tools/list', {}), /返回内容过大/);
});

test('HTTP errors and malformed responses fail without any retry', async t => {
  const f = await fixture(t, (req, res) => req.url === '/rpc' ? json(res, 403, { ok: false, error: '连接已撤销' }) : res.end('not-json'));
  const client = createSpongeClient({ socketPath: f.socketPath });
  await assert.rejects(client.rpc('A', 'tools/call', { name: 'write_file' }), { status: 403, message: '连接已撤销' });
  await assert.rejects(client.status('A'), /无效结果/);
  assert.equal(f.received.length, 2);
});

test('lost RPC connection reports uncertain execution and does not repeat the action', async t => {
  const f = await fixture(t, req => req.socket.destroy());
  const client = createSpongeClient({ socketPath: f.socketPath });
  await assert.rejects(client.rpc('A', 'tools/call', { name: 'start_process', arguments: { command: 'example' } }), error => error.status === 503 && error.uncertain === true && /勿重复/.test(error.message));
  assert.equal(f.received.length, 1);
});

test('timeout and AbortSignal stop a pending request without retrying', async t => {
  const f = await fixture(t, () => {});
  const client = createSpongeClient({ socketPath: f.socketPath, timeoutMs: 30 });
  await assert.rejects(client.rpc('A', 'tools/call', { name: 'start_process' }), error => error.status === 504 && error.uncertain === true);
  const controller = new AbortController();
  const pending = createSpongeClient({ socketPath: f.socketPath }).rpc('A', 'tools/list', {}, { signal: controller.signal });
  const reason = new Error('fixture cancelled');
  setTimeout(() => controller.abort(reason), 10);
  await assert.rejects(pending, error => error === reason);
  const before = f.received.length;
  await assert.rejects(client.status('A', { signal: controller.signal }), error => error === reason);
  assert.equal(f.received.length, before);
});

test('managed names cannot be shadowed and only connected owners discover Sponge', async () => {
  const operations = [];
  const adapter = createSpongeMcpAdapter({
    sandboxOperation: async (owner, input) => { operations.push([owner, input]); return { servers: [
      { name: 'sponge', transport: 'stdio' }, { name: ' 海绵宝宝 ', transport: 'http' }, { name: 'SPONGE', transport: 'stdio' }, { name: 'mine', transport: 'stdio' },
    ] }; },
    client: { status: async owner => ({ connected: owner === 'A' }) },
  });
  assert.deepEqual((await adapter('A', { operation: 'list_servers' })).servers, [{ name: 'mine', transport: 'stdio' }, { name: 'sponge', transport: 'managed' }]);
  assert.deepEqual((await adapter('B', { operation: 'list_servers' })).servers, [{ name: 'mine', transport: 'stdio' }]);
  assert.deepEqual(operations.map(i => i[0]), ['A', 'B']);
});

test('managed tools route the trusted owner and cannot replace transport/authentication', async () => {
  const calls = [], sandbox = [];
  const adapter = createSpongeMcpAdapter({ sandboxOperation: async (...args) => { sandbox.push(args); return { result: 'generic' }; },
    client: { rpc: async (...args) => { calls.push(args); return { content: [{ type: 'text', text: 'owned-result' }] }; } },
  });
  const signal = new AbortController().signal;
  const result = await adapter('A', { operation: 'call_tool', server: '海绵宝宝', owner: 'B', url: 'http://127.0.0.1', headers: { Authorization: 'bad' }, name: 'list_devices', arguments: {} }, { signal });
  assert.equal(result.result.content[0].text, 'owned-result');
  assert.deepEqual(calls[0], ['A', 'tools/call', { name: 'list_devices', arguments: {} }, { signal }]);
  await adapter('B', { operation: 'list_tools', server: 'sponge' });
  assert.deepEqual(calls[1].slice(0, 3), ['B', 'tools/list', {}]);
  assert.equal(sandbox.length, 0);
  const genericInput = { operation: 'list_tools', server: 'mine' };
  assert.deepEqual(await adapter('A', genericInput, { root: '/fixture' }), { result: 'generic' });
  assert.deepEqual(sandbox[0], ['A', genericInput, { root: '/fixture' }]);
});

test('connector downtime preserves other MCPs, but cancellation is not swallowed', async () => {
  const adapter = createSpongeMcpAdapter({ sandboxOperation: async () => ({ servers: [{ name: 'mine' }] }), client: { status: async () => { throw Error('broker down'); } } });
  assert.deepEqual(await adapter('A', { operation: 'list_servers' }), { servers: [{ name: 'mine' }] });
  const controller = new AbortController(); controller.abort(new Error('cancelled'));
  await assert.rejects(adapter('A', { operation: 'list_servers' }, { signal: controller.signal }), /cancelled/);
});
