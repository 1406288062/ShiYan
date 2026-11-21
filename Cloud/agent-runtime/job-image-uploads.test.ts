import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, stat, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {JobImageUploads} from './job-image-uploads.ts';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shiyan-job-images-'));
  try { await run(new JobImageUploads(root), root); }
  finally { await rm(root, {recursive: true, force: true}); }
}
const part = (bytes, offset = 0, end = bytes.length, overrides = {}) => ({
  offset, total: bytes.length, suffix: '.png', sha256: sha(bytes),
  data: bytes.subarray(offset, end).toString('base64'), ...overrides,
});
const reference = bytes => ({uploadId: sha(bytes), suffix: '.png', sha256: sha(bytes)});
const rejects = (action, status) => assert.rejects(action, error => error.status === status);

test('resumes after recreation, accepts identical duplicate chunks and preserves ordered inline inputs', async () => fixture(async (uploads, root) => {
  const bytes = Buffer.alloc(100000, 42), id = sha(bytes);
  await rejects(() => uploads.inspect('owner', id), 404);
  const first = part(bytes, 0, 49152);
  assert.equal((await uploads.append('owner', id, first)).upload.offset, 49152);
  assert.equal((await uploads.append('owner', id, first)).upload.offset, 49152);
  uploads = new JobImageUploads(root);
  assert.equal((await uploads.inspect('owner', id)).upload.complete, false);
  await uploads.append('owner', id, part(bytes, 49152, 98304));
  assert.equal((await uploads.append('owner', id, part(bytes, 98304))).upload.complete, true);
  assert.equal((await uploads.append('owner', id, first)).upload.offset, bytes.length);
  const inline = {suffix: '.jpg', data: 'unchanged-inline'};
  const resolved = await uploads.resolve('owner', [inline, reference(bytes)]);
  assert.equal(resolved[0], inline);
  assert.deepEqual(resolved[1], {suffix: '.png', data: bytes.toString('base64')});
  const directory = path.join(root, 'job-image-uploads', sha('owner'), id);
  for (const dir of [path.join(root, 'job-image-uploads'), path.dirname(directory), directory]) {
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
  }
  for (const file of ['data', 'metadata.json']) assert.equal((await stat(path.join(directory, file))).mode & 0o777, 0o600);
}));

test('isolates owners and rejects missing, unfinished or corrupted references', async () => fixture(async (uploads, root) => {
  const bytes = Buffer.from('the complete original image bytes'), id = sha(bytes);
  await uploads.append('alice', id, part(bytes, 0, 8));
  await rejects(() => uploads.resolve('alice', [reference(bytes)]), 409);
  await rejects(() => uploads.inspect('bob', id), 404);
  await rejects(() => uploads.resolve('bob', [reference(bytes)]), 404);
  await uploads.append('alice', id, part(bytes, 8));
  await rejects(() => uploads.resolve('alice', [{...reference(bytes), suffix: '.jpg'}]), 409);
  await rejects(() => uploads.resolve('alice', [{...reference(bytes), sha256: '0'.repeat(64)}]), 400);
  const file = path.join(root, 'job-image-uploads', sha('alice'), id, 'data');
  await writeFile(file, Buffer.alloc(bytes.length, 1));
  await rejects(() => uploads.resolve('alice', [reference(bytes)]), 409);
}));

test('rejects altered offsets, metadata, content, invalid base64 and oversized chunks', async () => fixture(async uploads => {
  const bytes = Buffer.alloc(50000, 7), id = sha(bytes);
  await rejects(() => uploads.append('owner', '../escape', part(bytes, 0, 1)), 400);
  await rejects(() => uploads.append('owner', id, part(bytes, 0, 49153)), 400);
  await rejects(() => uploads.append('owner', id, part(bytes, 0, 10, {total: 13.5 * 1024 * 1024 + 1})), 400);
  await rejects(() => uploads.append('owner', id, part(bytes, 0, 10, {suffix: '.svg'})), 400);
  await rejects(() => uploads.append('owner', id, part(bytes, 0, 10, {data: '!!!!'})), 400);
  await rejects(() => uploads.append('owner', id, part(bytes, 0, 10, {sha256: '0'.repeat(64)})), 400);
  await rejects(() => uploads.append('owner', id, part(bytes, 2, 10)), 409);
  await uploads.append('owner', id, part(bytes, 0, 1000));
  await rejects(() => uploads.append('owner', id, part(bytes, 1000, 1010, {total: bytes.length + 1})), 409);
  await rejects(() => uploads.append('owner', id, part(bytes, 1000, 1010, {suffix: '.jpeg'})), 409);
  await rejects(() => uploads.append('owner', id, part(bytes, 1001, 1010)), 409);
  await rejects(() => uploads.append('owner', id, part(bytes, 0, 1000, {data: Buffer.alloc(1000, 9).toString('base64')})), 409);
  await rejects(() => uploads.append('owner', id, part(bytes, 1000, bytes.length, {data: Buffer.alloc(49000, 9).toString('base64')})), 409);
  assert.equal((await uploads.inspect('owner', id)).upload.offset, 1000);
  await uploads.append('owner', id, part(bytes, 1000));
  assert.equal((await uploads.inspect('owner', id)).upload.complete, true);
}));

test('serializes competing appends across instances without duplicating committed bytes', async () => fixture(async (uploads, root) => {
  const bytes = Buffer.alloc(3000, 3), id = sha(bytes), other = new JobImageUploads(root);
  const results = await Promise.all([
    uploads.append('owner', id, part(bytes, 0, 1000)),
    other.append('owner', id, part(bytes, 0, 1000)),
    uploads.append('owner', id, part(bytes, 1000, 2000)),
    other.append('owner', id, part(bytes, 2000)),
  ]);
  assert.deepEqual(results.map(value => value.upload.offset), [1000, 1000, 2000, 3000]);
  assert.equal((await uploads.resolve('owner', [reference(bytes)]))[0].data, bytes.toString('base64'));
}));
