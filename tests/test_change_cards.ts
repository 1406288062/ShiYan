import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../shared/frontend/assets/workbench-changes.js', import.meta.url), 'utf8');
function changeCards() {
  const window: any = {};
  vm.runInNewContext(source, { window, TextEncoder });
  return window.ShiYanChanges;
}
const file = (index) => ({ path: `/project/file-${index}.swift`, kind: 'update', added: index + 1, removed: 2 });
const change = (changes, status = 'completed') => ({ type: 'file_change', status, changes });
const commands = () => Array.from({ length: 80 }, (_, index) => ({ id: `command-${index}`, type: 'command_execution', status: 'completed' }));

test('all 199 canonical files contribute to the card count and line totals', () => {
  const cards = changeCards();
  const message = { id: 'all-files', fileChanges: Array.from({ length: 199 }, (_, index) => file(index)) };
  const files = cards.filesFor(message);
  assert.equal(files.length, 199);
  assert.equal(files[198].path, '/project/file-198.swift');
  const html = cards.summary(message);
  assert.match(html, /<strong>已编辑 199 个文件<\/strong>/);
  assert.match(html, /class="v24-added">\+19900<\/span>/);
  assert.match(html, /class="v24-removed">-398<\/span>/);
  assert.equal((html.match(/data-change-index=/g) || []).length, 199);
});

test('one completed display record can carry more than 64 files', () => {
  const files = changeCards().filesFor({ displayItems: [change(Array.from({ length: 199 }, (_, index) => file(index)))] });
  assert.equal(files.length, 199);
  assert.equal(files[198].added, 199);
});

test('equivalent paths are deduplicated while missing diff and statistics are enriched', () => {
  const files = changeCards().filesFor({
    fileChanges: [{ path: '/project/shared.swift' }],
    displayItems: [change([
      { path: '\\project\\shared.swift', kind: 'update', diff: '+new\n-old', added: 7, removed: 3 },
      { path: '/project/another.swift', added: 1, removed: 0 },
    ])],
  });
  assert.equal(files.length, 2);
  assert.equal(files[0].path, '/project/shared.swift');
  assert.equal(files[0].diff, '+new\n-old');
  assert.equal(files[0].added, 7);
  assert.equal(files[0].removed, 3);
  assert.equal(files[0].kind, 'update');
  assert.equal(files[0].available, true);
});

test('canonical statistics remain authoritative when display records repeat a path', () => {
  const files = changeCards().filesFor({
    fileChanges: [{ path: '/project/shared.swift', added: 10, removed: 11, diff: '+canonical' }],
    displayItems: [change([{ path: '/project/shared.swift', added: 1, removed: 2, diff: '+display' }])],
  });
  assert.equal(files.length, 1);
  assert.equal(files[0].added, 10);
  assert.equal(files[0].removed, 11);
  assert.equal(files[0].diff, '+canonical');
});

test('file changes after display item 80 are counted while incomplete records stay excluded', () => {
  const files = changeCards().filesFor({ displayItems: [
    ...commands(),
    change([file(81)]),
    change([file(82)], undefined),
    { type: 'file_change', changes: [file(83)] },
    change([file(84)], 'running'),
    change([file(85)], 'failed'),
    { type: 'command_execution', changes: [file(86)] },
  ] });
  assert.deepEqual(Array.from(files, (value: any) => value.path), ['/project/file-81.swift', '/project/file-82.swift', '/project/file-83.swift']);
});

test('legacy raw arrays and item envelopes retain late file records and completed-status filtering', () => {
  const items = [
    ...commands(),
    change(Array.from({ length: 199 }, (_, index) => file(index))),
    change([file(200)], 'running'),
    change([file(201)], 'failed'),
    { type: 'file_change', changes: [file(202)] },
  ];
  for (const value of [items, { items }]) {
    const files = changeCards().filesFor({ rawResult: JSON.stringify(value) });
    assert.equal(files.length, 200);
    assert.equal(files[199].path, '/project/file-202.swift');
    assert.equal(files.some(value => value.path === '/project/file-200.swift'), false);
    assert.equal(files.some(value => value.path === '/project/file-201.swift'), false);
  }
});

test('legacy JSON is accepted through the byte boundary and rejected above it', () => {
  const cards = changeCards();
  const raw = JSON.stringify([change([file(1)])]);
  const boundary = raw + ' '.repeat(262144 - Buffer.byteLength(raw));
  assert.equal(Buffer.byteLength(boundary), 262144);
  assert.equal(cards.filesFor({ rawResult: boundary }).length, 1);
  assert.equal(cards.filesFor({ rawResult: boundary + ' ' }).length, 0);
});

test('the raw-result guard measures UTF-8 bytes rather than character count', () => {
  const raw = JSON.stringify({ padding: '燕'.repeat(90000), items: [change([file(1)])] });
  assert.ok(raw.length < 262144);
  assert.ok(Buffer.byteLength(raw) > 262144);
  assert.equal(changeCards().filesFor({ rawResult: raw }).length, 0);
});


const image = (filename = 'portrait_photo.jpg') => ({
  id: 'generated-photo', remoteId: 'cloud-photo', filename, mimeType: 'image/jpeg',
});
const outputFile = (path = '/workspace/portrait_photo.jpg', extra = {}) => ({
  path, kind: 'add', available: false, diff: '', added: null, removed: null,
  source: '二进制文件不生成文本差异', ...extra,
});

test('a delivered image has no code-change card and its attachment remains intact', () => {
  const cards = changeCards();
  const message = { id: 'portrait', role: 'assistant', assets: [image()], fileChanges: [outputFile()] };
  const before = JSON.stringify(message);
  assert.equal(cards.filesFor(message).length, 0);
  assert.equal(cards.summary(message), '');
  assert.equal(JSON.stringify(message), before);
});

test('mixed image output and source edits count only the source edit and its real diff', () => {
  const cards = changeCards();
  const message = { id: 'mixed', assets: [image()], fileChanges: [outputFile(), { ...file(0), diff: '+code\n-old' }] };
  const files = cards.filesFor(message);
  assert.deepEqual(Array.from(files, (f: any) => f.path), ['/project/file-0.swift']);
  const html = cards.summary(message);
  assert.match(html, /已编辑 1 个文件/);
  assert.match(html, /class="v24-added">\+1<\/span>/);
  assert.match(html, /class="v24-removed">-2<\/span>/);
  assert.doesNotMatch(html, /portrait_photo|历史记录缺少 diff/);
});

test('completed SDK records and historical raw records use the same image-output classification', () => {
  const cards = changeCards();
  const items = [change([outputFile('C:\\workspace\\portrait_photo.jpg', { kind: 'create' }), file(1)])];
  for (const history of [{ displayItems: items }, { rawResult: JSON.stringify(items) }, { rawResult: JSON.stringify({ items }) }]) {
    const files = cards.filesFor({ assets: [image()], ...history });
    assert.deepEqual(Array.from(files, (f: any) => f.path), ['/project/file-1.swift']);
  }
});

test('JPEG display copies still identify the original image output', () => {
  const cards = changeCards();
  for (const suffix of ['png', 'webp', 'jpeg']) {
    const message = { assets: [image('landscape.jpg')], fileChanges: [outputFile('/workspace/landscape.' + suffix)] };
    assert.equal(cards.filesFor(message).length, 0);
  }
});

test('existing project images and unrelated image files retain their change records', () => {
  const cards = changeCards();
  const changes = [
    outputFile('/project/portrait_photo.jpg', { kind: 'update' }),
    outputFile('/project/removed/portrait_photo.jpg', { kind: 'delete' }),
    outputFile('/project/unrelated.png'),
    outputFile('/project/old/portrait_photo.jpg', { beforeSha256: 'previous-file' }),
  ];
  const files = cards.filesFor({ assets: [image()], fileChanges: changes });
  assert.equal(files.length, changes.length);
});

test('missing attachments and ambiguous legacy text edits are not silently discarded', () => {
  const cards = changeCards();
  assert.equal(cards.filesFor({ fileChanges: [outputFile()] }).length, 1);
  assert.equal(cards.filesFor({ assets: [{ ...image(), mimeType: 'text/plain' }], fileChanges: [outputFile()] }).length, 1);
  const sourceEdit = outputFile('/project/icon.svg', { kind: '', diff: '+<svg/>', added: 1, removed: 0 });
  assert.equal(cards.filesFor({ assets: [{ ...image('icon.svg'), mimeType: 'image/svg+xml' }], fileChanges: [sourceEdit] }).length, 1);
});

test('a completed reply is reclassified when its image attachment arrives', () => {
  const cards = changeCards();
  const message = { id: 'late-image', fileChanges: [outputFile()], assets: [] as any[] };
  assert.match(cards.summary(message), /已编辑 1 个文件/);
  message.assets.push(image());
  assert.equal(cards.summary(message), '');
});
