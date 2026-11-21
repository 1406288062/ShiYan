import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { readRemoteFileChanges, remoteChangeManifestPath, createRemoteFileChangeProjector, mergeFileChanges } from './remote-file-changes.ts';
import { snapshotWorkspace, collectFileChanges } from './file-changes.ts';
import { SyncStore, materializeJob } from './sync-store.ts';
import { createFilePathResolver } from './sync-file-paths.ts';

const hash = text => createHash('sha256').update(text).digest('hex');
const snapshot = text => text === undefined ? { exists: false, text: null, sha256: null } : { exists: true, text, sha256: hash(text) };
const record = (jobId, filename, before, after) => ({ version: 1, jobId, path: filename, deviceId: 'mac-test', before: snapshot(before), after: snapshot(after) });

test('verified remote evidence excludes explicitly recorded staging files from cards and SDK supplements', async () => {
  const f = await fixture();
  try {
    const staging = '/tmp/shiyan-stage-test/App.swift';
    await f.write([{ ...record(f.jobId, '/Users/yu/App.swift', 'old\n', 'new\n'), stagingPaths: [staging] }]);
    const before = await snapshotWorkspace(f.workspace);
    const files = await collectFileChanges(f.workspace, before, [{ type: 'file_change', status: 'completed', changes: [{ path: staging, kind: 'update' }] }], { jobId: f.jobId });
    assert.deepEqual(files.map(file => file.path), ['/Users/yu/App.swift']);
    const cid = randomUUID(), mid = randomUUID();
    const store = { jobWorkspace: () => f.workspaceKey };
    const change = { kind: 'messages', id: mid, revision: 1, data: { role: 'assistant', state: 'completed', conversationId: cid, remoteJobId: f.jobId,
      fileChanges: [{ path: staging, available: false }, { path: '/Users/yu/Keep.swift', available: false }],
      displayItems: [{ type: 'file_change', changes: [{ path: staging }] }] } };
    const projected = await createRemoteFileChangeProjector(f.root, store)(change, 'owner-a');
    assert.deepEqual(projected.data.fileChanges.map(file => file.path), ['/Users/yu/Keep.swift', '/Users/yu/App.swift']);
    assert.equal(projected.data.fileChanges[1].available, true);
    assert.equal(projected.data.displayItems.length, 0);
    assert.equal(change.data.fileChanges[0].path, staging);
    await f.write([{ ...record(f.jobId, '/Users/yu/App.swift', 'same\n', 'same\n'), stagingPaths: [staging] }]);
    const unchanged = await collectFileChanges(f.workspace, before, [{ type: 'file_change', status: 'completed', changes: [{ path: staging, kind: 'update' }] }], { jobId: f.jobId });
    assert.deepEqual(unchanged, []);
    const netZero = await createRemoteFileChangeProjector(f.root, store)(change, 'owner-a');
    assert.deepEqual(netZero.data.fileChanges.map(file => file.path), ['/Users/yu/Keep.swift']);
    await f.write([{ ...record(f.jobId, '/Users/yu/App.swift', 'old', 'new'), stagingPaths: ['/Users/yu/Keep.swift'] }]);
    await assert.rejects(readRemoteFileChanges(f.workspace, f.jobId), /staging/);
  } finally { await f.done(); }
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shiyan-remote-changes-'));
  const workspaceKey = 'a'.repeat(64), workspace = path.join(root, 'workspaces', workspaceKey), jobId = randomUUID();
  await fs.mkdir(path.join(workspace, '.shiyan', 'changes'), { recursive: true, mode: 0o700 });
  const filename = remoteChangeManifestPath(workspace, jobId);
  return { root, workspaceKey, workspace, jobId, filename,
    async write(records) { await fs.writeFile(filename, records.map(value => JSON.stringify(value)).join('\n') + '\n', { mode: 0o600 }); },
    async done() { await fs.rm(root, { recursive: true, force: true }); } };
}

test('explicit remote snapshots yield real absolute paths and net diffs; empty files remain additions', async () => {
  const f = await fixture();
  try {
    await f.write([record(f.jobId, '/Users/yu/App.swift', '原文\n', '新文\n++literal\n'), record(f.jobId, '/Users/yu/Added.swift', undefined, ''), record(f.jobId, '/Users/yu/Gone.swift', 'gone\n', undefined)]);
    const changes = await readRemoteFileChanges(f.workspace, f.jobId);
    assert.deepEqual(changes.map(value => [value.path, value.kind, value.added, value.removed]), [
      ['/Users/yu/App.swift', 'update', 2, 1], ['/Users/yu/Added.swift', 'add', 0, 0], ['/Users/yu/Gone.swift', 'delete', 0, 1]]);
    assert.match(changes[0].diff, /-原文\n\+新文/);
  } finally { await f.done(); }
});

test('same-path chains merge and a net-zero edit produces no card', async () => {
  const f = await fixture();
  try {
    await f.write([record(f.jobId, '/Users/yu/App.swift', 'one\n', 'two\n'), record(f.jobId, '/Users/yu/App.swift', 'two\n', 'one\n')]);
    assert.deepEqual(await readRemoteFileChanges(f.workspace, f.jobId), []);
    await f.write([record(f.jobId, '/Users/yu/App.swift', 'one\n', 'two\n'), record(f.jobId, '/Users/yu/App.swift', 'wrong\n', 'three\n')]);
    await assert.rejects(readRemoteFileChanges(f.workspace, f.jobId), /discontinuous/);
  } finally { await f.done(); }
});

test('job identity, hash, canonical path, binary text, UTF-8 and bounds are validated', async () => {
  const f = await fixture();
  try {
    for (const transform of [value => ({ ...value, jobId: randomUUID() }), value => ({ ...value, path: '/Users/yu/../App.swift' }),
      value => ({ ...value, after: { ...value.after, sha256: '0'.repeat(64) } }), value => ({ ...value, after: snapshot('nul\0') }),
      value => ({ ...value, after: snapshot('x'.repeat(1024 * 1024 + 1)) }), value => ({ ...value, after: snapshot('\ud800') })]) {
      await f.write([transform(record(f.jobId, '/Users/yu/App.swift', 'before', 'after'))]);
      await assert.rejects(readRemoteFileChanges(f.workspace, f.jobId));
    }
    await assert.rejects(async () => remoteChangeManifestPath(f.workspace, '../job'));
    await f.write(Array.from({ length: 201 }, (_, index) => record(f.jobId, '/Users/yu/File-' + index, '', 'new')));
    await assert.rejects(readRemoteFileChanges(f.workspace, f.jobId), /Too many/);
    await fs.writeFile(f.filename, Buffer.alloc(16 * 1024 * 1024 + 1), { mode: 0o600 });
    await assert.rejects(readRemoteFileChanges(f.workspace, f.jobId), /oversized/);
    await fs.writeFile(f.filename, '\n'.repeat(1001), { mode: 0o600 });
    await assert.rejects(readRemoteFileChanges(f.workspace, f.jobId), /Too many/);
  } finally { await f.done(); }
});

test('manifest and control directories must be private regular paths without symlinks', async () => {
  const f = await fixture();
  try {
    await f.write([record(f.jobId, '/Users/yu/App.swift', 'before', 'after')]);
    await fs.chmod(f.filename, 0o644); await assert.rejects(readRemoteFileChanges(f.workspace, f.jobId), /Unsafe/);
    await fs.chmod(f.filename, 0o600); await fs.chmod(path.dirname(f.filename), 0o755); await assert.rejects(readRemoteFileChanges(f.workspace, f.jobId), /Unsafe/);
    await fs.chmod(path.dirname(f.filename), 0o700);
    const actual = f.filename + '.actual'; await fs.rename(f.filename, actual); await fs.symlink(actual, f.filename);
    await assert.rejects(readRemoteFileChanges(f.workspace, f.jobId));
  } finally { await f.done(); }
});

test('workspace collector excludes control evidence and retains only successful external SDK records', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.workspace, 'real.swift'), 'old\n'); const before = await snapshotWorkspace(f.workspace);
    await fs.writeFile(path.join(f.workspace, 'real.swift'), 'new\n');
    await f.write([record(f.jobId, '/Users/yu/App.swift', 'before\n', 'after\n')]);
    const items = [{ type: 'file_change', status: 'completed', changes: [{ path: '/Users/yu/SDK.swift', kind: 'update' }] }, { type: 'file_change', status: 'failed', changes: [{ path: '/Users/yu/Failed.swift', kind: 'update' }] }];
    const changes = await collectFileChanges(f.workspace, before, items, { jobId: f.jobId });
    assert.equal(changes.length, 3); assert.ok(changes.every(value => !value.path.includes('.shiyan')));
    assert.equal(changes.find(value => value.path === '/Users/yu/SDK.swift')!.available, false);
    assert.equal(changes.find(value => value.path === '/Users/yu/Failed.swift'), undefined);
    assert.equal((await collectFileChanges(f.workspace, before, items)).some(value => value.path === '/Users/yu/App.swift'), false);
  } finally { await f.done(); }
});

test('canonical full paths win while identical basenames on separate paths are retained', () => {
  assert.deepEqual(mergeFileChanges([{ path: '/local/App.swift', diff: 'canonical' }], [{ path: '/local/App.swift', diff: 'supplemental' }, { path: '/remote/App.swift', diff: 'remote' }]),
    [{ path: '/local/App.swift', diff: 'canonical' }, { path: '/remote/App.swift', diff: 'remote' }]);
});

test('authoritative workspace mapping handles forks, isolates owners/jobs and never rewrites its origin', async () => {
  const f = await fixture(), store = new SyncStore(path.join(f.root, 'data'));
  try {
    const cid = randomUUID(), mid = randomUUID(), job = { id: f.jobId, owner: 'owner-a', requestId: randomUUID(), conversationKey: 'b'.repeat(64), syncConversationId: cid, assistantMessageId: mid, status: 'completed', text: 'result', createdAt: 1, updatedAt: 2, assets: [] };
    store.putAuthoritative('owner-a', 'conversations', cid, { id: cid }); materializeJob(store, job, { id: randomUUID(), workspaceKey: f.workspaceKey });
    assert.equal(store.jobWorkspace('owner-a', f.jobId, cid), f.workspaceKey);
    assert.equal(store.jobWorkspace('owner-b', f.jobId, cid), null); assert.equal(store.jobWorkspace('owner-a', randomUUID(), cid), null);
    assert.equal(store.recordJobWorkspace('owner-a', f.jobId, cid, 'c'.repeat(64)), false);
    const change = { kind: 'messages', id: mid, data: { conversationId: cid, remoteJobId: f.jobId, fileChanges: [{ path: 'App.swift' }] } };
    const resolved = createFilePathResolver(f.root, store, { stateFallback: false })(change, 'owner-a');
    assert.equal(resolved.data.fileChanges[0].path, path.join(f.workspace, 'App.swift'));
    assert.equal(createFilePathResolver(f.root, store, { stateFallback: false })(change, 'owner-b'), change);
  } finally { store.close(); await f.done(); }
});

test('completed sync records merge evidence and invalidate cache; in-flight and unbound messages remain untouched', async () => {
  const f = await fixture(), store = new SyncStore(path.join(f.root, 'data'));
  try {
    const cid = randomUUID(), mid = randomUUID(), change = { kind: 'messages', id: mid, revision: 1, data: { id: mid, role: 'assistant', state: 'completed', conversationId: cid, remoteJobId: f.jobId, fileChanges: [{ path: '/canonical/App.swift', diff: 'full' }] } };
    await f.write([record(f.jobId, '/Users/yu/App.swift', 'before\n', 'after\n')]); const project = createRemoteFileChangeProjector(f.root, store);
    assert.equal(await project(change, 'owner-a'), change); store.recordJobWorkspace('owner-a', f.jobId, cid, f.workspaceKey);
    const projected = await project(change, 'owner-a'); assert.equal(projected.data.fileChanges.length, 2); assert.equal(projected.revision, 1);
    const withControl = { ...change, data: { ...change.data, fileChanges: [...change.data.fileChanges, { path: f.filename, diff: 'control' }, { path: '/Users/yu/Legitimate.jsonl', diff: 'user file' }],
      displayItems: [{ id: 'control', type: 'file_change', changes: [{ path: f.filename, kind: 'add' }] }, { id: 'mixed', type: 'file_change', changes: [{ path: f.filename, kind: 'add' }, { path: '/Users/yu/Legitimate.jsonl', kind: 'update' }] }] } };
    const clean = await project(withControl, 'owner-a'); assert.equal(clean.data.fileChanges.some(value => value.path === f.filename), false);
    assert.ok(clean.data.fileChanges.some(value => value.path === '/Users/yu/Legitimate.jsonl')); assert.deepEqual(clean.data.displayItems.map(value => value.id), ['mixed']);
    assert.deepEqual(clean.data.displayItems[0].changes.map(value => value.path), ['/Users/yu/Legitimate.jsonl']);
    assert.equal(await project(change, 'owner-b'), change); assert.equal(await project({ ...change, data: { ...change.data, state: 'running' } }, 'owner-a').then(value => value.data.fileChanges.length), 1);
    await f.write([record(f.jobId, '/Users/yu/App.swift', 'before\n', 'latest\n')]); assert.match((await project(change, 'owner-a')).data.fileChanges[1].diff, /latest/);
    await fs.chmod(path.dirname(f.filename), 0o755); assert.equal(await project(change, 'owner-a'), change);
  } finally { store.close(); await f.done(); }
});

test('sidecar projects the same remote paths on both platforms and serves full diffs without loading state', async () => {
  const f = await fixture(), store = new SyncStore(path.join(f.root, 'data'));
  process.env.SHIYAN_SYNC_NO_LISTEN = '1'; const { createSyncSidecar } = await import('./sync-sidecar.ts');
  const server = createSyncSidecar({ root: f.root, store, runtimeWrites: true, authenticate: req => ({ owner: req.headers['x-test-owner'] || 'owner-a', platform: req.headers['x-test-platform'] || 'mac' }) });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  try {
    const cid = randomUUID(), mid = randomUUID(); store.putAuthoritative('owner-a', 'conversations', cid, { id: cid });
    store.putAuthoritative('owner-a', 'messages', mid, { id: mid, role: 'assistant', state: 'completed', conversationId: cid, remoteJobId: f.jobId, text: 'result', fileChanges: [{ path: 'Canonical.swift', added: 1, removed: 0, diff: 'canonical' }], assets: [] });
    store.recordJobWorkspace('owner-a', f.jobId, cid, f.workspaceKey);
    await fs.writeFile(path.join(f.root, 'data', 'state.json'), 'invalid state must not be read');
    await f.write([record(f.jobId, '/Users/yu/App.swift', 'before\n', 'long-after\n'.repeat(3000))]);
    const base = 'http://127.0.0.1:' + (server.address() as any).port;
    const desktop: any = await (await fetch(base + '/v1/sync')).json(), phone: any = await (await fetch(base + '/v1/sync', { headers: { 'x-test-platform': 'ios' } })).json();
    const macFiles = desktop.changes.find(value => value.id === mid).data.fileChanges, iosFiles = phone.changes.find(value => value.id === mid).data.fileChanges;
    assert.deepEqual(macFiles.map(value => value.path), [path.join(f.workspace, 'Canonical.swift'), '/Users/yu/App.swift']); assert.deepEqual(iosFiles.map(value => value.path), macFiles.map(value => value.path));
    assert.equal(iosFiles[1].diffTruncated, true); assert.equal(iosFiles[1].added, 3000);
    const details: any = await (await fetch(base + '/v1/sync/messages/' + mid + '/details')).json(); assert.equal(details.fileChanges[1].diff, macFiles[1].diff);
    assert.equal(((await (await fetch(base + '/v1/sync', { headers: { 'x-test-owner': 'owner-b' } })).json()) as any).changes.length, 0);
  } finally { await new Promise(resolve => server.close(resolve)); await f.done(); }
});

test('supplemented pages retain parents and exact cursors without skipping messages; a large first message is delivered', async () => {
  const f = await fixture(), store = new SyncStore(path.join(f.root, 'data'));
  process.env.SHIYAN_SYNC_NO_LISTEN = '1'; const { createSyncSidecar } = await import('./sync-sidecar.ts');
  const server = createSyncSidecar({ root: f.root, store, runtimeWrites: true, authenticate: () => ({ owner: 'owner-a' }) });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  try {
    const cid = randomUUID(), ids: any[] = [];
    store.putAuthoritative('owner-a', 'conversations', cid, { id: cid, title: 'parent' });
    async function addMessage(length) {
      const mid = randomUUID(), jobId = randomUUID(); ids.push(mid);
      store.putAuthoritative('owner-a', 'messages', mid, { id: mid, role: 'assistant', state: 'completed', conversationId: cid, remoteJobId: jobId, text: 'reply', assets: [] });
      store.recordJobWorkspace('owner-a', jobId, cid, f.workspaceKey);
      await fs.writeFile(remoteChangeManifestPath(f.workspace, jobId), JSON.stringify(record(jobId, '/Users/yu/' + mid + '.swift', 'before\n', 'x'.repeat(length) + '\n')) + '\n', { mode: 0o600 });
    }
    for (let index = 0; index < 3; index++) await addMessage(65000);
    const base = 'http://127.0.0.1:' + (server.address() as any).port;
    let after = 0, delivered: any[] = [], pages = 0;
    while (true) {
      const page: any = await (await fetch(base + '/v1/sync?after=' + after)).json(); pages++;
      assert.equal(page.ok, true); assert.equal(Object.hasOwn(page, 'order'), false);
      assert.ok(Buffer.byteLength(JSON.stringify(page)) < 96 * 1024);
      assert.equal(page.changes[0].kind, 'conversations'); assert.equal(page.changes[0].id, cid);
      const messages = page.changes.filter(value => value.kind === 'messages'); assert.equal(messages.length, 1);
      delivered.push(messages[0].id); assert.ok(page.cursor > after); after = page.cursor;
      if (!page.hasMore) break;
      assert.ok(pages < 10);
    }
    assert.deepEqual(delivered, ids); assert.equal(pages, 3);
    await addMessage(150000);
    const large: any = await (await fetch(base + '/v1/sync?after=' + after)).json();
    assert.equal(large.changes[0].kind, 'conversations'); assert.equal(large.changes.find(value => value.kind === 'messages').id, ids.at(-1));
    assert.ok(Buffer.byteLength(JSON.stringify(large)) > 96 * 1024); assert.ok(large.cursor > after); assert.equal(large.hasMore, false);
    assert.equal(Object.hasOwn(large, 'order'), false);
  } finally { await new Promise(resolve => server.close(resolve)); await f.done(); }
});

test('a parent snapshot from a later sequence does not advance past undelivered messages', async () => {
  const f = await fixture(), store = new SyncStore(path.join(f.root, 'data'));
  process.env.SHIYAN_SYNC_NO_LISTEN = '1'; const { createSyncSidecar } = await import('./sync-sidecar.ts');
  const server = createSyncSidecar({ root: f.root, store, runtimeWrites: true, authenticate: () => ({ owner: 'owner-a' }) });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  try {
    const cid = randomUUID(), mids = [randomUUID(), randomUUID()];
    store.putAuthoritative('owner-a', 'conversations', cid, { id: cid, title: 'initial parent' });
    for (let index = 0; index < mids.length; index++) {
      const jobId = randomUUID(), mid = mids[index];
      store.putAuthoritative('owner-a', 'messages', mid, { id: mid, role: 'assistant', state: 'completed', conversationId: cid, remoteJobId: jobId, text: 'reply', assets: [] });
      store.recordJobWorkspace('owner-a', jobId, cid, f.workspaceKey);
      await fs.writeFile(remoteChangeManifestPath(f.workspace, jobId), JSON.stringify(record(jobId, '/Users/yu/' + mid + '.swift', 'before\n', 'x'.repeat(index ? 65000 : 110000) + '\n')) + '\n', { mode: 0o600 });
    }
    store.putAuthoritative('owner-a', 'conversations', cid, { id: cid, title: 'latest parent' });
    const sequence = id => Number(store.db.prepare("SELECT MAX(seq) AS seq FROM sync_changes WHERE owner='owner-a' AND id=?").get(id)!.seq);
    const firstSequence = sequence(mids[0]), futureParentSequence = sequence(cid);
    const base = 'http://127.0.0.1:' + (server.address() as any).port;
    const first: any = await (await fetch(base + '/v1/sync')).json();
    assert.equal(first.changes[0].data.title, 'latest parent'); assert.equal(first.changes.find(value => value.kind === 'messages').id, mids[0]);
    assert.equal(first.cursor, firstSequence); assert.ok(first.cursor < futureParentSequence); assert.equal(first.hasMore, true);
    const second: any = await (await fetch(base + '/v1/sync?after=' + first.cursor)).json();
    assert.equal(second.changes[0].kind, 'conversations'); assert.equal(second.changes.find(value => value.kind === 'messages').id, mids[1]);
    assert.equal(second.cursor, futureParentSequence); assert.equal(second.hasMore, false); assert.equal(Object.hasOwn(second, 'order'), false);
  } finally { await new Promise(resolve => server.close(resolve)); await f.done(); }
});
