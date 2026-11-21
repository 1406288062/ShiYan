import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createComputeBroker } from '../apps/compute/broker.ts';

const clientToken = 'test-client-' + 'c'.repeat(40);
const workerToken = 'test-worker-' + 'w'.repeat(40);
const workerId = 'worker-test-mac';
const ownerA = 'account:a', ownerB = 'account:b';
const sha = data => createHash('sha256').update(data).digest('hex');
const vector = () => Array.from({ length: 1024 }, (_, index) => index === 0 ? 1 : 0);
function png(width = 2, height = 3) {
  const bytes = Buffer.alloc(33); Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);
  bytes.writeUInt32BE(13, 8); bytes.write('IHDR', 12); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
  return bytes;
}
function jpeg(width = 8, height = 12) {
  // A minimal SOF header fixture; the broker deliberately does not invoke an image decoder.
  const bytes = Buffer.from('ffd8ffc0001108000c000803011100021100031100ffd9', 'hex');
  bytes.writeUInt16BE(height, 7); bytes.writeUInt16BE(width, 9); return bytes;
}
async function fixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'shiyan-compute-test-'));
  const active = new Set([ownerA, ownerB]); let authorizedWorker = true, clock = 1000000;
  const config = { dataDir: path.join(root, 'data'), clientToken, workerToken, workerId,
    allowedOwners: [ownerA, ownerB], now: () => clock, authorizeOwner: owner => active.has(owner),
    authorizeWorker: () => authorizedWorker, ...overrides };
  let server, base;
  async function start() {
    server = createComputeBroker(config);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() {
    if (!server) return;
    const closing = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeIdleConnections(); await closing; server = undefined;
  }
  t.after(async () => { await stop(); await rm(root, { recursive: true, force: true }); });
  await start();
  async function call(route, { token = clientToken, owner = ownerA, lease, method = 'GET', body, bytes, headers = {} } = {}) {
    const allHeaders = { Authorization: `Bearer ${token}`, ...headers };
    if (owner !== null) allHeaders['X-Shiyan-Owner'] = owner;
    if (lease) allHeaders['X-Task-Lease'] = lease;
    let payload = bytes;
    if (body !== undefined) { payload = JSON.stringify(body); allHeaders['Content-Type'] = 'application/json'; }
    if (bytes) allHeaders['Content-Length'] = String(bytes.length);
    const response = await fetch(base + route, { method, headers: allHeaders, body: payload });
    const data = response.headers.get('content-type')?.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer());
    return { status: response.status, data };
  }
  async function submitEmbed(request_id = 'embedding-1', owner = ownerA, params = {}) {
    return call('/v1/tasks', { method: 'POST', owner, body: { kind: 'embed', request_id,
      params: { texts: ['sample PDF text'], operation: 'document_embedding', instruction: '', ...params } } });
  }
  async function claim() { return call('/v1/worker/claim', { token: workerToken, owner: null, method: 'POST', body: {} }); }
  async function complete(task, embeddings = [vector()]) {
    return call(`/v1/worker/tasks/${task.id}/result`, { token: workerToken, owner: null, lease: task.lease_token,
      method: 'PUT', body: { embeddings, device: 'mps', dimensions: 1024 } });
  }
  return { root, config, active, call, submitEmbed, claim, complete, stop, start,
    advance: ms => { clock += ms; }, disableWorker: () => { authorizedWorker = false; } };
}

test('credentials and trusted owner binding guard every task route', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/v1/tasks', { token: 'wrong' })).status, 401);
  assert.equal((await f.call('/v1/tasks', { token: workerToken })).status, 403);
  assert.equal((await f.call('/v1/worker/claim', { method: 'POST', body: {} })).status, 403);
  assert.equal((await f.submitEmbed('unbound', 'account:unbound')).status, 403);
  const created = await f.submitEmbed(); const id = created.data.task.id;
  for (const [method, suffix] of [['GET', ''], ['DELETE', ''], ['GET', '/result'], ['PUT', '/input']]) {
    assert.equal((await f.call(`/v1/tasks/${id}${suffix}`, { method, owner: ownerB })).status, 404);
  }
  const status = await f.call(`/v1/tasks/${id}`);
  assert.equal(status.status, 200);
  assert.equal(status.data.task.label, '等待 Mac 上线');
  assert.equal(JSON.stringify(status.data).includes('sample PDF text'), false);
  assert.equal((await f.call('/v1/tasks?owner=account:b')).status, 400);
});

test('per-owner immutable request deduplication survives a broker restart', async t => {
  const f = await fixture(t);
  const first = await f.submitEmbed('same');
  const duplicate = await f.submitEmbed('same');
  assert.equal(first.data.task.id, duplicate.data.task.id);
  assert.equal((await f.submitEmbed('same', ownerA, { texts: ['different'] })).status, 409);
  const other = await f.submitEmbed('same', ownerB);
  assert.notEqual(other.data.task.id, first.data.task.id);
  await f.stop(); await f.start();
  assert.equal((await f.submitEmbed('same')).data.task.id, first.data.task.id);
});

test('only fixed computation kinds and bounded parameter schemas are accepted', async t => {
  const f = await fixture(t);
  const task = (kind, params) => f.call('/v1/tasks', { method: 'POST', body: { kind, request_id: 'invalid', params } });
  assert.equal((await task('shell', { command: 'id' })).status, 400);
  assert.equal((await f.submitEmbed('huge', ownerA, { texts: Array(9).fill('x') })).status, 400);
  assert.equal((await f.submitEmbed('huge', ownerA, { texts: ['x'.repeat(16385)] })).status, 400);
  assert.equal((await f.submitEmbed('huge', ownerA, { texts: Array(8).fill('x'.repeat(10000)) })).status, 400);
  assert.equal((await f.submitEmbed('path', ownerA, { path: '/etc/passwd' })).status, 400);
  assert.equal((await f.submitEmbed('op', ownerA, { operation: 'run_code' })).status, 400);
  assert.equal((await task('enhance', { model: 'general', width: 3001, height: 2, input_sha256: 'a'.repeat(64), input_bytes: 100 })).status, 400);
  assert.equal((await task('enhance', { model: 'general', width: 2, height: 2, input_sha256: 'a'.repeat(64), input_bytes: 40 * 1024 * 1024 + 1 })).status, 400);
  assert.equal((await f.call('/v1/worker/claim', { token: workerToken, method: 'POST', body: { owner: ownerB } })).status, 400);
});

test('single Mac worker lease is renewed and online state comes only from heartbeat', async t => {
  const f = await fixture(t, { leaseMs: 120000 });
  await f.submitEmbed('one'); await f.submitEmbed('two');
  assert.equal((await f.call('/v1/health')).data.workerOnline, false);
  const claimed = (await f.claim()).data.task;
  assert.equal((await f.call('/v1/health')).data.workerOnline, true);
  assert.equal((await f.claim()).data.task, null);
  f.advance(55000);
  const update = await f.call(`/v1/worker/tasks/${claimed.id}/progress`, { token: workerToken, method: 'POST', lease: claimed.lease_token,
    body: { progress: 0.5, label: 'Mac 正在向量化', details: { device: 'mps', completed: 1, private_path: '/private/model' } } });
  assert.equal(update.status, 200);
  f.advance(70000);
  assert.equal((await f.call('/v1/health')).data.workerOnline, false);
  assert.equal((await f.claim()).data.task, null, 'renewed lease still blocks a second computation');
  const status = (await f.call(`/v1/tasks/${claimed.id}`)).data.task;
  assert.equal(status.progress, 0.5); assert.deepEqual(status.details, { device: 'mps', completed: 1 });
});

test('expired lease is reclaimed and old worker cannot progress, fail, or complete', async t => {
  const f = await fixture(t, { leaseMs: 1000 });
  await f.submitEmbed(); const old = (await f.claim()).data.task;
  f.advance(1001);
  const current = (await f.claim()).data.task;
  assert.equal(current.id, old.id); assert.notEqual(current.lease_token, old.lease_token);
  for (const [action, method, body] of [
    ['progress', 'POST', { progress: 1, label: 'late' }],
    ['fail', 'POST', { error: '/private/secret', code: 'LATE' }],
    ['result', 'PUT', { embeddings: [vector()], dimensions: 1024, device: 'mps' }],
  ]) assert.equal((await f.call(`/v1/worker/tasks/${old.id}/${action}`, { token: workerToken, lease: old.lease_token, method, body })).status, 409);
  assert.equal((await f.complete(current)).status, 200);
  assert.equal((await f.call(`/v1/tasks/${old.id}`)).data.task.state, 'completed');
});

test('cancel invalidates a running lease and cannot be resurrected', async t => {
  const f = await fixture(t); await f.submitEmbed(); const task = (await f.claim()).data.task;
  assert.equal((await f.call(`/v1/tasks/${task.id}`, { method: 'DELETE' })).data.task.state, 'cancelled');
  assert.equal((await f.complete(task)).status, 409);
  assert.equal((await f.call(`/v1/tasks/${task.id}/result`)).status, 409);
  assert.equal((await f.claim()).data.task, null);
});

test('disabled owner fails closed for existing tasks and worker access', async t => {
  const f = await fixture(t); await f.submitEmbed(); const task = (await f.claim()).data.task;
  f.active.delete(ownerA);
  assert.equal((await f.call(`/v1/tasks/${task.id}`)).status, 403);
  assert.equal((await f.complete(task)).status, 403);
  assert.equal((await f.claim()).data.task, null);
  f.active.add(ownerA);
  assert.equal((await f.call(`/v1/tasks/${task.id}`)).data.task.state, 'cancelled');
});

test('independent compute worker disablement cancels pending work and blocks every result', async t => {
  const f = await fixture(t); await f.submitEmbed(); const task = (await f.claim()).data.task;
  f.disableWorker();
  for (const result of [await f.call('/v1/health'), await f.call(`/v1/tasks/${task.id}`), await f.complete(task), await f.claim()]) {
    assert.equal(result.status, 403); assert.equal(result.data.code, 'WORKER_DISABLED');
  }
});

test('embedding count, model dimensions, MPS and finite nonzero vectors are validated', async t => {
  const f = await fixture(t); await f.submitEmbed(); const task = (await f.claim()).data.task;
  assert.equal((await f.complete(task, [])).status, 422);
  assert.equal((await f.complete(task, [[1,2]])).status, 422);
  assert.equal((await f.complete(task, [Array(1024).fill(0)])).status, 422);
  const invalid = vector(); invalid[0] = NaN;
  assert.equal((await f.complete(task, [invalid])).status, 422);
  assert.equal((await f.call(`/v1/worker/tasks/${task.id}/result`, { token: workerToken, lease: task.lease_token, method: 'PUT',
    body: { embeddings: [vector()], device: 'cpu', dimensions: 1024 } })).status, 422);
  assert.equal((await f.complete(task)).status, 200);
  const result = await f.call(`/v1/tasks/${task.id}/result`);
  assert.equal(result.status, 200); assert.deepEqual(result.data.embeddings, [vector()]);
  await f.stop(); await f.start();
  assert.deepEqual((await f.call(`/v1/tasks/${task.id}/result`)).data, result.data);
  assert.equal((await f.complete(task)).status, 409, 'terminal job cannot be overwritten');
});

test('streamed image source is immutable and result must be a JPEG of exact 4x dimensions', async t => {
  const f = await fixture(t); const source = png();
  const created = await f.call('/v1/tasks', { method: 'POST', body: { kind: 'enhance', request_id: 'image',
    params: { model: 'anime', width: 2, height: 3, input_sha256: sha(source), input_bytes: source.length } } });
  const id = created.data.task.id; assert.equal(created.data.task.state, 'uploading');
  assert.equal((await f.claim()).data.task, null, 'uploading task is not runnable');
  const wrong = Buffer.from(source); wrong[32] = 1;
  assert.equal((await f.call(`/v1/tasks/${id}/input`, { method: 'PUT', bytes: wrong })).status, 422);
  assert.equal((await f.call(`/v1/tasks/${id}/input`, { method: 'PUT', bytes: source })).data.task.state, 'queued');
  assert.equal((await f.call(`/v1/tasks/${id}/input`, { method: 'PUT', bytes: source })).status, 200, 'same upload is idempotent');
  const task = (await f.claim()).data.task;
  assert.equal(task.id, id); assert.equal(task.params.model, 'anime');
  assert.equal(JSON.stringify(task).includes(f.root), false);
  assert.equal((await f.call(`/v1/worker/tasks/${id}/input`, { token: workerToken, lease: 'wrong' })).status, 409);
  assert.deepEqual((await f.call(`/v1/worker/tasks/${id}/input`, { token: workerToken, lease: task.lease_token })).data, source);
  const put = bytes => f.call(`/v1/worker/tasks/${id}/result`, { token: workerToken, lease: task.lease_token, method: 'PUT', bytes });
  assert.equal((await put(png(8,12))).status, 422);
  assert.equal((await put(jpeg(7,12))).status, 422);
  const output = jpeg(8,12); assert.equal((await put(output)).status, 200);
  const status = (await f.call(`/v1/tasks/${id}`)).data.task;
  assert.equal(status.state, 'completed'); assert.equal(status.result.width, 8); assert.equal(status.result.height, 12);
  assert.deepEqual((await f.call(`/v1/tasks/${id}/result`)).data, output);
  const names = await import('node:fs/promises').then(fs => fs.readdir(path.join(f.config.dataDir, 'files')));
  assert.equal(names.some(name => name.endsWith('.tmp')), false, 'all upload temporaries cleaned');
});

test('declared image dimensions are checked against source headers before scheduling', async t => {
  const f = await fixture(t); const source = png(4,5);
  const task = (await f.call('/v1/tasks', { method: 'POST', body: { kind: 'enhance', request_id: 'dimension-mismatch',
    params: { model: 'general', width: 2, height: 3, input_sha256: sha(source), input_bytes: source.length } } })).data.task;
  assert.equal((await f.call(`/v1/tasks/${task.id}/input`, { method: 'PUT', bytes: source })).status, 422);
  assert.equal((await f.call(`/v1/tasks/${task.id}`)).data.task.state, 'uploading');
  assert.equal((await f.claim()).data.task, null);
});

test('worker failure reasons cannot persist worker paths or credentials', async t => {
  const f = await fixture(t); await f.submitEmbed(); const task = (await f.claim()).data.task;
  const response = await f.call(`/v1/worker/tasks/${task.id}/fail`, { token: workerToken, lease: task.lease_token, method: 'POST',
    body: { error: `/private/model ${workerToken}`, code: 'MPS_UNAVAILABLE' } });
  assert.equal(response.status, 200);
  const status = (await f.call(`/v1/tasks/${task.id}`)).data.task;
  assert.equal(status.state, 'failed'); assert.equal(status.error_code, 'MPS_UNAVAILABLE');
  assert.equal(JSON.stringify(status).includes('/private'), false); assert.equal(JSON.stringify(status).includes(workerToken), false);
});

test('optional execution deadline marks work failed, without expiring offline queued tasks', async t => {
  const f = await fixture(t, { taskTimeoutMs: 2000 }); await f.submitEmbed();
  f.advance(100000); assert.equal((await f.call('/v1/health')).data.queued, 1);
  const task = (await f.claim()).data.task; f.advance(2001);
  const status = (await f.call(`/v1/tasks/${task.id}`)).data.task;
  assert.equal(status.state, 'failed'); assert.equal(status.error_code, 'COMPUTE_TIMEOUT');
  assert.equal((await f.complete(task)).status, 409);
});

test('production compute auth permits enhancement without Sponge pairing and after revocation', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'shiyan-auth-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const accountsDb = path.join(root, 'accounts.sqlite3'), deviceRegistryPath = path.join(root, 'relay-state.json');
  const accounts = new DatabaseSync(accountsDb);
  accounts.exec('CREATE TABLE account_users(owner TEXT PRIMARY KEY,status TEXT);');
  accounts.prepare('INSERT INTO account_users VALUES(?,?)').run(ownerA, 'active');
  t.after(() => accounts.close());
  const cos = fakeCos();
  const f = await fixture(t, { authorizeOwner: undefined, authorizeWorker: undefined, workerId: undefined,
    accountsDb, cosStore: cos, deviceRegistryPath, deviceId: 'legacy-sponge-device', deviceAccountId: 'paired-owner' });
  assert.equal((await f.call('/v1/health')).data.workerId, 'shiyan-compute-worker');
  // The legacy pairing file does not exist when the first enhancement is submitted.
  const first = await cosTask(f, cos, 'no-pairing');
  const registries = [
    JSON.stringify({ devices: [] }),
    JSON.stringify({ devices: [{ deviceId: 'legacy-sponge-device', platform: 'darwin',
      accountId: 'different-owner', revokedAt: new Date().toISOString() }] }),
    '{broken',
  ];
  for (const [index, registry] of registries.entries()) {
    await writeFile(deviceRegistryPath, registry, { mode: 0o600 });
    const health = await f.call('/v1/health');
    assert.equal(health.status, 200);
    const task = (await cosClaim(f)).data.task;
    assert.ok(task);
    if (index === 0) assert.equal(task.id, first.id);
    await prepareCosResult(f, cos, task, 'output');
    await prepareCosResult(f, cos, task, 'thumbnail');
    const completed = await f.call(`/v1/worker/tasks/${task.id}/result`, { token: workerToken,
      lease: task.lease_token, method: 'PUT', body: { transport: 'cos' } });
    assert.equal(completed.status, 200);
    assert.equal((await f.call(`/v1/tasks/${task.id}`)).data.task.state, 'completed');
    assert.equal((await f.call(`/v1/tasks/${task.id}/result`)).status, 200);
    if (index < registries.length - 1) await cosTask(f, cos, 'after-pairing-change-' + index);
  }
  accounts.prepare('UPDATE account_users SET status=? WHERE owner=?').run('disabled', ownerA);
  assert.equal((await f.submitEmbed('disabled')).status, 403);
  assert.equal((await f.call('/v1/health')).status, 403);
});

test('every active account can enhance, including new accounts outside legacy lists', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'shiyan-all-accounts-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const accountsDb = path.join(root, 'accounts.sqlite3');
  const accounts = new DatabaseSync(accountsDb);
  accounts.exec('CREATE TABLE account_users(owner TEXT PRIMARY KEY,status TEXT);');
  for (const owner of [ownerA, ownerB]) accounts.prepare('INSERT INTO account_users VALUES(?,?)').run(owner, 'active');
  t.after(() => accounts.close());
  const cos = fakeCos();
  const f = await fixture(t, { accountsDb, cosStore: cos, authorizeOwner: undefined,
    authorizeWorker: undefined, allowedOwners: [ownerA, 'account:unknown'] });
  for (const [owner, model] of [[ownerB, 'general'], ['account:new-member', 'anime']]) {
    if (owner !== ownerB) accounts.prepare('INSERT INTO account_users VALUES(?,?)').run(owner, 'active');
    const input = cosInput(owner);
    cos.objects.set(input.key, { bytes: input.bytes, etag: input.etag, mime: input.mime });
    const created = await f.call('/v1/tasks', { method: 'POST', owner,
      body: { kind: 'enhance_cos', request_id: 'shared-request', params: { model, input } } });
    assert.equal(created.status, 200);
    const id = created.data.task.id;
    assert.equal((await f.call(`/v1/tasks/${id}`, { owner: ownerA })).status, 404);
    const task = (await cosClaim(f)).data.task;
    assert.equal(task.owner_id, owner);
    await prepareCosResult(f, cos, task, 'output');
    await prepareCosResult(f, cos, task, 'thumbnail');
    assert.equal((await f.call(`/v1/worker/tasks/${id}/result`, { token: workerToken,
      owner: null, lease: task.lease_token, method: 'PUT', body: { transport: 'cos' } })).status, 200);
    const result = await f.call(`/v1/tasks/${id}/result`, { owner });
    assert.equal(result.status, 200);
    assert.equal(result.data.device, 'mps');
    accounts.prepare('UPDATE account_users SET status=? WHERE owner=?').run('disabled', owner);
    assert.equal((await f.call(`/v1/tasks/${id}`, { owner })).status, 403);
    accounts.prepare('UPDATE account_users SET status=? WHERE owner=?').run('active', owner);
    await f.stop();
    delete f.config.allowedOwners;
    await f.start();
    assert.equal((await f.call(`/v1/tasks/${id}/result`, { owner })).status, 200);
  }
  assert.equal((await f.submitEmbed('unknown', 'account:unknown')).status, 403);
});

test('an explicitly disabled compute service refuses valid credentials without pairing checks', async t => {
  const f = await fixture(t, { workerEnabled: false });
  for (const result of [await f.call('/v1/health'), await f.submitEmbed(), await f.claim()]) {
    assert.equal(result.status, 403);
    assert.equal(result.data.code, 'WORKER_DISABLED');
  }
});


test('concurrent claims cannot allocate two Mac jobs and crash temporaries are reclaimed', async t => {
  const f = await fixture(t);
  await f.submitEmbed('one'); await f.submitEmbed('two');
  const claims = await Promise.all([f.claim(), f.claim(), f.claim()]);
  const tasks = claims.map(result => result.data.task).filter(Boolean);
  assert.equal(tasks.length, 1);
  await f.stop();
  const temporary = path.join(f.config.dataDir, 'files', `${tasks[0].id}.result-${randomUUID()}.tmp`);
  await writeFile(temporary, 'interrupted private result');
  await f.start();
  await assert.rejects(readFile(temporary), { code: 'ENOENT' });
  assert.equal((await f.claim()).data.task, null, 'unexpired lease survives restart');
  f.advance(120001);
  assert.equal((await f.claim()).data.task.id, tasks[0].id);
});

function fakeCos() {
  const objects = new Map(), signed = [];
  return {host:'test-123456.cos.ap-guangzhou.myqcloud.com',objects,signed,
    async head(key,etag) { const item=objects.get(key); if(!item || etag && etag!==item.etag)throw Error('missing object'); return item; },
    signed(method,key,headers={},ttl=300) { const value={method,url:`https://test-123456.cos.ap-guangzhou.myqcloud.com/${key}?q-signature=test`,headers,expiresAt:1000000+ttl*1000}; signed.push({key,...value});return value; }
  };
}
function cosInput(owner=ownerA) {
  const id=randomUUID();return {id,key:`shiyan-web/assets/${sha(owner)}/input-${id}`,bytes:1200,etag:'"'+'e'.repeat(32)+'"',mime:'image/png',name:'example.png'};
}
async function cosTask(f,cos,request='cos-task',input=cosInput()) {
  cos.objects.set(input.key,{bytes:input.bytes,etag:input.etag,mime:input.mime});
  const created=await f.call('/v1/tasks',{method:'POST',body:{kind:'enhance_cos',request_id:request,params:{model:'anime',input}}});
  assert.equal(created.status,200);return created.data.task;
}
const cosClaim=f=>f.call('/v1/worker/claim',{token:workerToken,owner:null,method:'POST',body:{capabilities:['enhance_cos']}});
function resultInfo(kind='output') {return {kind,bytes:kind==='output'?2000:100,sha256:'d'.repeat(64),width:kind==='output'?400:100,height:kind==='output'?600:150,inputWidth:100,inputHeight:150,inputBytes:1500,inputSha256:'a'.repeat(64)};}
async function prepareCosResult(f,cos,task,kind) {
  const info=resultInfo(kind);
  const response=await f.call(`/v1/worker/tasks/${task.id}/cos-output`,{token:workerToken,owner:null,lease:task.lease_token,method:'POST',body:info});
  assert.equal(response.status,200);
  const key=new URL(response.data.url).pathname.slice(1);
  cos.objects.set(key,{bytes:info.bytes,sha256:info.sha256,mime:'image/jpeg',etag:'"'+'f'.repeat(32)+'"'});
  return {key,plan:response.data,info};
}

test('COS tasks require configured transport and an exact account-owned immutable input',async t=>{
  const f=await fixture(t),input=cosInput();
  const submit=(params)=>f.call('/v1/tasks',{method:'POST',body:{kind:'enhance_cos',request_id:'cos',params}});
  assert.equal((await submit({model:'anime',input})).status,503);
  assert.equal((await submit({model:'anime',input:{...input,key:input.key.replace(sha(ownerA),sha(ownerB))}})).status,400);
  assert.equal((await submit({model:'anime',input:{...input,key:'https://localhost/private'}})).status,400);
  assert.equal((await submit({model:'anime',input:{...input,name:'../../private'}})).status,400);
});

test('COS input and output use scoped signatures and metadata only; legacy workers cannot claim them',async t=>{
  const cos=fakeCos(),f=await fixture(t,{cosStore:cos});const created=await cosTask(f,cos);
  assert.equal(created.state,'queued');assert.equal((await f.claim()).data.task,null);
  const task=(await cosClaim(f)).data.task;assert.equal(task.cos_host,cos.host);
  const input=await f.call(`/v1/worker/tasks/${task.id}/cos-input`,{token:workerToken,lease:task.lease_token});
  assert.equal(input.status,200);assert.equal(input.data.headers['If-Match'],task.params.input.etag);
  assert.equal(JSON.stringify(input.data).includes(workerToken),false);
  assert.equal((await f.call(`/v1/worker/tasks/${task.id}/input`,{token:workerToken,lease:task.lease_token})).status,404);
  const output=await prepareCosResult(f,cos,task,'output');await prepareCosResult(f,cos,task,'thumbnail');
  assert.equal(output.plan.headers['x-cos-acl'],'private');assert.equal(output.plan.headers['Content-Length'],'2000');assert.equal(output.plan.headers['x-cos-meta-sha256'],'d'.repeat(64));
  const confirm=()=>f.call(`/v1/worker/tasks/${task.id}/result`,{token:workerToken,lease:task.lease_token,method:'PUT',body:{transport:'cos'}});
  cos.objects.get(output.key).bytes=1999;assert.equal((await confirm()).status,422);
  cos.objects.get(output.key).bytes=2000;assert.equal((await confirm()).status,200);
  const result=(await f.call(`/v1/tasks/${task.id}/result`)).data;
  assert.equal(result.output.key,output.key);assert.equal(result.output.width,400);assert.equal(result.input.width,100);assert.equal(result.device,'mps');
  assert.equal(JSON.stringify(result).includes('q-signature'),false);
  assert.equal((await f.call(`/v1/tasks/${task.id}`,{owner:ownerB})).status,404);
  assert.equal((await f.call(`/v1/tasks/${task.id}`)).data.task.result.output.key,output.key);
  assert.deepEqual(await import('node:fs/promises').then(fs=>fs.readdir(path.join(f.config.dataDir,'files'))),[]);
});

test('COS stale lease URLs cannot overwrite a new attempt and changed output declarations fail',async t=>{
  const cos=fakeCos(),f=await fixture(t,{cosStore:cos,leaseMs:1000});await cosTask(f,cos);
  const old=(await cosClaim(f)).data.task;const prior=await prepareCosResult(f,cos,old,'output');
  assert.equal((await f.call(`/v1/worker/tasks/${old.id}/cos-output`,{token:workerToken,lease:old.lease_token,method:'POST',body:{...resultInfo(),bytes:2001}})).status,409);
  f.advance(1001);const current=(await cosClaim(f)).data.task;
  const next=await prepareCosResult(f,cos,current,'output');assert.notEqual(prior.key,next.key);
  assert.equal((await f.call(`/v1/worker/tasks/${old.id}/cos-input`,{token:workerToken,lease:old.lease_token})).status,409);
  assert.equal((await f.call(`/v1/worker/tasks/${old.id}/result`,{token:workerToken,lease:old.lease_token,method:'PUT',body:{transport:'cos'}})).status,409);
  assert.equal((await f.call(`/v1/tasks/${current.id}`,{method:'DELETE'})).status,200);
  assert.equal((await f.call(`/v1/worker/tasks/${current.id}/cos-output`,{token:workerToken,lease:current.lease_token,method:'POST',body:resultInfo('thumbnail')})).status,409);
});

test('COS refuses input replaced after upload completion and bounds all output metadata',async t=>{
  const cos=fakeCos(),f=await fixture(t,{cosStore:cos}),input=cosInput();
  cos.objects.set(input.key,{bytes:input.bytes,etag:'"'+'f'.repeat(32)+'"',mime:input.mime});
  assert.equal((await f.call('/v1/tasks',{method:'POST',body:{kind:'enhance_cos',request_id:'changed',params:{model:'general',input}}})).status,422);
  await cosTask(f,cos);const task=(await cosClaim(f)).data.task;
  for(const info of [{...resultInfo(),width:401},{...resultInfo('thumbnail'),width:769},{...resultInfo(),bytes:512*1024*1024+1},{...resultInfo(),key:'other'}])
    assert.equal((await f.call(`/v1/worker/tasks/${task.id}/cos-output`,{token:workerToken,lease:task.lease_token,method:'POST',body:info})).status,422);
});
