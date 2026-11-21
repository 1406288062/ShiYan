import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createWorkspaceHandler, virtualPath } from './workspace-http.ts';

async function fixture(t) {
  const files = new Map(), spawned = [];
  const handler = createWorkspaceHandler({ operations: async () => ({
    workspaceOperation: async (owner, input) => {
      const key = owner + ':' + virtualPath(input.path);
      if (input.operation === 'mkdir') return {};
      if (input.operation === 'write') { files.set(key, input.data || Buffer.from(input.content).toString('base64')); return {}; }
      if (input.operation === 'read') {
        if (!files.has(key)) throw Object.assign(Error('不存在'), { status: 404 });
        return { data: files.get(key) };
      }
      return { entries: [] };
    },
    spawnSandbox: async (owner, options) => {
      const child = new EventEmitter();
      Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill() { this.emit('close', 0); } });
      spawned.push({ owner, options, child }); return child;
    },
  }) });
  const server = http.createServer(async (req, res) => {
    try {
      const auth = req.headers['x-test-owner'] ? { owner: req.headers['x-test-owner'], role: 'user', serverAccess: false } : null;
      await handler(req, res, auth, async req => { const chunks = []; for await (const c of req) chunks.push(c); return JSON.parse(Buffer.concat(chunks).toString() || '{}'); });
    } catch (e) { res.writeHead(e.status || 500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const request = (owner, route, method = 'GET', body) => fetch(`http://127.0.0.1:${server.address().port}/shiyan/v1/workspace${route}`, {
    method, headers: { ...(owner ? { 'x-test-owner': owner } : {}), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { request, spawned, files };
}

test('members with no server access can concurrently create projects and edit private files', async t => {
  const { request } = await fixture(t), id = 'same-project-id';
  const result = await Promise.all(['alice', 'bob'].map(async owner => {
    let response = await request(owner, '/projects', 'POST', { id, name: owner }); assert.equal(response.status, 200);
    response = await request(owner, '/files/save-text', 'POST', { projectId: id, path: 'main.py', text: owner, confirmed: true }); assert.equal(response.status, 200);
    return (await response.json()).file;
  }));
  assert.equal(result[0].text, 'alice'); assert.equal(result[1].text, 'bob');
  assert.equal(result[0].path, result[1].path); assert(result[0].path.startsWith('/workspace/'));
  const stolen = await request('bob', '/files/read', 'POST', { fileId: result[0].fileId });
  assert.equal((await stolen.json()).file.text, 'bob');
  assert.equal((await (await request('alice', '/projects')).json()).projects[0].name, 'alice');
  assert.equal((await (await request('bob', '/projects')).json()).projects[0].name, 'bob');
});

test('anonymous users and host paths are rejected; capabilities do not expose host information', async t => {
  const { request } = await fixture(t);
  assert.equal((await request(null, '/bootstrap', 'POST', {})).status, 401);
  for (const path of ['/etc/passwd', '/home/ubuntu', '/workspace/../../etc/shadow']) {
    assert.equal((await request('alice', '/files/read', 'POST', { path })).status, 403);
  }
  const bootstrap = await (await request('alice', '/bootstrap', 'POST', {})).json();
  assert.equal(bootstrap.defaultDirectory, '/workspace'); assert.equal(bootstrap.terminalTransport, 'SSE');
  assert(!JSON.stringify(bootstrap).includes('/home/ubuntu'));
});

test('terminal state, input and lifecycle are bound to the authenticated owner', async t => {
  const { request, spawned } = await fixture(t);
  const response = await request('alice', '/terminals', 'POST', {}); assert.equal(response.status, 200);
  const { terminal } = await response.json(); assert(!Object.hasOwn(terminal, 'pid'));
  assert.equal((await request('bob', `/terminals/${terminal.id}/input`, 'POST', { data: 'pwd\n' })).status, 404);
  assert.equal((await request('bob', `/terminals/${terminal.id}`, 'DELETE')).status, 404);
  assert.equal((await request('alice', `/terminals/${terminal.id}/input`, 'POST', { data: 'pwd\n' })).status, 200);
  assert.equal(spawned[0].owner, 'alice'); assert.equal(spawned[0].options.cwd, '/workspace');
  assert.equal((await request('alice', `/terminals/${terminal.id}`, 'DELETE')).status, 200);
});

test('optimistic file saves prevent silent concurrent overwrites', async t => {
  const { request } = await fixture(t), route = '/files/save-text';
  const first = await (await request('alice', route, 'POST', { path: '/workspace/a.txt', text: 'first', confirmed: true })).json();
  await request('alice', route, 'POST', { path: '/workspace/a.txt', text: 'second', confirmed: true });
  assert.equal((await request('alice', route, 'POST', { path: '/workspace/a.txt', text: 'stale', contentHash: first.file.contentHash, confirmed: true })).status, 409);
});
