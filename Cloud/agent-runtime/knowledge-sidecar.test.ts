import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { digest } from './device-auth.ts';
import { createKnowledgeSidecar, knowledgeRoute } from './knowledge-sidecar.ts';

async function serve(t, server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return 'http://127.0.0.1:' + server.address().port;
}
test('authenticated ownership and exact multipart bytes reach the private bridge', async t => {
  const received = [];
  const bridge = await serve(t, http.createServer(async (req, res) => {
    const parts = []; for await (const part of req) parts.push(part);
    received.push({ headers: req.headers, path: req.url, body: Buffer.concat(parts) });
    res.setHeader('Content-Type', 'application/json'); res.end('{"task_id":"task-1","status":"queued"}');
  }));
  const secret = 's'.repeat(48);
  const api = await serve(t, createKnowledgeSidecar({ upstream: bridge, secret,
    authenticate: req => req.headers.authorization === 'Bearer valid-user' ? { owner: 'account:A' } : null }));
  const boundary = 'shiyan-test-boundary';
  const bytes = Buffer.concat([Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="资料.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.7\n'), Buffer.from([0, 255, 1]), Buffer.from('\r\n--' + boundary + '--\r\n')]);
  const response = await fetch(api + '/shiyan/v1/knowledge/knowledge-bases/kb-1/documents', { method: 'POST', body: bytes,
    headers: { authorization: 'Bearer valid-user', 'x-shiyan-owner': 'attacker', 'x-shiyan-body-sha': digest(bytes), 'content-type': 'multipart/form-data; boundary=' + boundary } });
  assert.equal(response.status, 200); assert.equal((await response.json()).task_id, 'task-1');
  assert.equal(received.length, 1); assert.deepEqual(received[0].body, bytes);
  assert.equal(received[0].headers['x-shiyan-owner'], 'account:A');
  assert.equal(received[0].headers.authorization, 'Bearer ' + secret);
  assert.equal(received[0].path, '/api/knowledge-bases/kb-1/documents');
  const denied = await fetch(api + '/shiyan/v1/knowledge/spaces', { headers: { 'x-shiyan-body-sha': digest(Buffer.alloc(0)) } });
  assert.equal(denied.status, 401); assert.equal(received.length, 1);
  const tampered = await fetch(api + '/shiyan/v1/knowledge/query', { method: 'POST', body: '{"question":"changed"}',
    headers: { authorization: 'Bearer valid-user', 'content-type': 'application/json', 'x-shiyan-body-sha': digest(Buffer.from('{}')) } });
  assert.equal(tampered.status, 401); assert.equal(received.length, 1);
});
test('route allowlist retains history query and blocks auth, paths and unknown query fields', () => {
  assert.equal(knowledgeRoute('GET', '/shiyan/v1/knowledge/chat/history?knowledge_base_id=kb-1'), '/api/chat/history?knowledge_base_id=kb-1');
  for (const route of ['auth/login', 'spaces/kb%2Foutside/knowledge-bases', 'audit-logs', 'spaces?upstream=http://elsewhere'])
    assert.throws(() => knowledgeRoute('GET', '/shiyan/v1/knowledge/' + route));
  assert.throws(() => knowledgeRoute('POST', '/shiyan/v1/knowledge/tasks/task-1'));
});
test('a dropped read reconnects once while a mutation is never replayed', async t => {
  let reads = 0, writes = 0;
  const bridge = await serve(t, http.createServer(async (req, res) => {
    for await (const part of req) void part;
    if (req.method === 'GET' && ++reads > 1) { res.end('[]'); return; }
    if (req.method === 'POST') writes++;
    req.socket.destroy();
  }));
  const api = await serve(t, createKnowledgeSidecar({ upstream: bridge, secret: 's'.repeat(48), authenticate: () => ({ owner: 'account:test' }) }));
  const read = await fetch(api + '/shiyan/v1/knowledge/spaces', { headers: { 'x-shiyan-body-sha': digest(Buffer.alloc(0)) } });
  assert.equal(read.status, 200); assert.deepEqual(await read.json(), []); assert.equal(reads, 2);
  const body = Buffer.from('{"knowledge_base_id":"kb-1","question":"test"}');
  const write = await fetch(api + '/shiyan/v1/knowledge/query', { method: 'POST', body,
    headers: { 'content-type': 'application/json', 'x-shiyan-body-sha': digest(body) } });
  assert.equal(write.status, 503); assert.equal(writes, 1);
});
test('upstream validation and connection failures produce usable errors', async t => {
  assert.throws(() => createKnowledgeSidecar({ secret: 's'.repeat(48), upstream: 'http://example.com' }));
  const bridge = await serve(t, http.createServer((req, res) => { res.writeHead(422); res.end('{"detail":[{"loc":["body","name"]}]}'); }));
  const api = await serve(t, createKnowledgeSidecar({ secret: 's'.repeat(48), upstream: bridge, authenticate: () => ({ owner: 'account:A' }) }));
  const response = await fetch(api + '/shiyan/v1/knowledge/spaces', { headers: { 'x-shiyan-body-sha': digest(Buffer.alloc(0)) } });
  assert.equal(response.status, 422); assert.match((await response.json()).error, /检查/);
  const unavailable = await serve(t, createKnowledgeSidecar({ secret: 's'.repeat(48), upstream: 'http://127.0.0.1:1', authenticate: () => ({ owner: 'account:A' }) }));
  const offline = await fetch(unavailable + '/shiyan/v1/knowledge/spaces', { headers: { 'x-shiyan-body-sha': digest(Buffer.alloc(0)) } });
  assert.equal(offline.status, 503); const message=(await offline.json()).error; assert.match(message, /知识库服务/); assert.doesNotMatch(message, /Mac/);
});
