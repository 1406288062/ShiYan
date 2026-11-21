import path from 'node:path';
import { constants, promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { textFileChange } from './text-file-diff.ts';

export const REMOTE_CHANGE_LIMITS = Object.freeze({ manifestBytes: 16 * 1024 * 1024, fileBytes: 1024 * 1024, files: 200, records: 1000 });
const validId = (value: any) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value);
const sha = (value: any) => createHash('sha256').update(value).digest('hex');
const safePath = (value: any) => typeof value === 'string' && value.length <= 1024 && !/[\x00-\x1f\x7f]/.test(value)
  && path.posix.isAbsolute(value) && path.posix.normalize(value) === value && value !== '/';

export function remoteChangeManifestPath(workspace: any, jobId: any) {
  if (!validId(jobId)) throw new Error('Invalid remote change job ID');
  return path.join(workspace, '.shiyan', 'changes', jobId + '.jsonl');
}

function snapshot(value: any) {
  if (!value || typeof value !== 'object' || typeof value.exists !== 'boolean') throw new Error('Invalid remote file snapshot');
  if (!value.exists) {
    if (value.text !== null || value.sha256 !== null) throw new Error('Absent file carries content');
    return undefined;
  }
  if (typeof value.text !== 'string' || value.text.includes('\0') || !/^[a-f0-9]{64}$/.test(value.sha256 || '')) throw new Error('Invalid remote text snapshot');
  const bytes = Buffer.from(value.text, 'utf8');
  if (bytes.length > REMOTE_CHANGE_LIMITS.fileBytes || bytes.toString('utf8') !== value.text || sha(bytes) !== value.sha256) throw new Error('Remote snapshot hash or size mismatch');
  return value.text;
}

function recordsFor(text: any, jobId: any) {
  const records = new Map();
  let offset = 0, lineCount = 0;
  while (offset < text.length) {
    if (++lineCount > REMOTE_CHANGE_LIMITS.records) throw new Error('Too many remote change records');
    const newline = text.indexOf('\n', offset), end = newline < 0 ? text.length : newline;
    const line = text.slice(offset, end); offset = end + 1;
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    if (record?.version !== 1 || record.jobId !== jobId || !safePath(record.path) || !validId(record.deviceId)) throw new Error('Invalid remote change record identity');
    const before = snapshot(record.before), after = snapshot(record.after);
    const stagingPaths = record.stagingPaths ?? [];
    if (!Array.isArray(stagingPaths) || stagingPaths.length > 20 || stagingPaths.some(value => !safePath(value) || !/^\/(?:tmp|var\/tmp)\//.test(value) || value === record.path)) throw new Error('Invalid staging paths');
    const prior = records.get(record.path);
    if (prior) {
      if (prior.deviceId !== record.deviceId || prior.after !== before) throw new Error('Remote change chain is discontinuous');
      prior.after = after;
      prior.stagingPaths = [...new Set([...prior.stagingPaths, ...stagingPaths])];
    } else {
      if (records.size >= REMOTE_CHANGE_LIMITS.files) throw new Error('Too many remote changed files');
      records.set(record.path, { before, after, deviceId: record.deviceId, stagingPaths });
    }
  }
  return records;
}

async function privateDirectory(directory: any) {
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) throw new Error('Unsafe remote change directory');
}

// Read only explicit records. Never inspect shell commands or traverse remote roots.
export async function readRemoteFileChanges(workspace: any, jobId: any) {
  const filename = remoteChangeManifestPath(workspace, jobId);
  let handle;
  try {
    await privateDirectory(path.join(workspace, '.shiyan'));
    await privateDirectory(path.join(workspace, '.shiyan', 'changes'));
    handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid()) || info.size > REMOTE_CHANGE_LIMITS.manifestBytes) throw new Error('Unsafe or oversized remote change manifest');
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const afterRead = await handle.stat();
    if (offset !== info.size || afterRead.size !== info.size || afterRead.mtimeMs !== info.mtimeMs) throw new Error('Remote change manifest changed during read');
    const text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes)) throw new Error('Remote change manifest is not UTF-8');
    const result: any[] = [];
    const stagingPaths = new Set();
    for (const [filename, record] of recordsFor(text, jobId)) {
      for (const filename of record.stagingPaths) stagingPaths.add(filename);
      const change = await textFileChange(filename, record.before, record.after);
      if (change) result.push({ ...change, source: 'remote', deviceId: record.deviceId, ...(record.stagingPaths.length ? { stagingPaths: record.stagingPaths } : {}) });
    }
    Object.defineProperty(result, 'stagingPaths', { value: [...stagingPaths] });
    return result;
  } catch (error) {
    if ((error as any).code === 'ENOENT') return [];
    throw error;
  } finally {
    await handle?.close();
  }
}

// Keep canonical records first, comparing full paths rather than basenames.
export function mergeFileChanges(canonical: any[] = [], supplemental: any[] = []) {
  const result: any[] = [], paths = new Set();
  for (const change of [...(Array.isArray(canonical) ? canonical : []), ...(Array.isArray(supplemental) ? supplemental : [])]) {
    if (!change || typeof change.path !== 'string' || paths.has(change.path)) continue;
    paths.add(change.path); result.push(change);
  }
  return result;
}

export function removeControlRecords(change: any, workspace: any, stagingPaths = new Set()) {
  const control = path.join(workspace, '.shiyan');
  const visible = (file: any) => typeof file?.path !== 'string' || (!stagingPaths.has(file.path) && file.path !== control && !file.path.startsWith(control + path.sep));
  const data = change.data;
  const filteredFiles = Array.isArray(data.fileChanges) ? data.fileChanges.filter(visible) : data.fileChanges;
  const files = filteredFiles?.length === data.fileChanges?.length ? data.fileChanges : filteredFiles;
  const filteredItems = Array.isArray(data.displayItems) ? data.displayItems.flatMap((item: any) => {
    if (item?.type !== 'file_change' || !Array.isArray(item.changes)) return [item];
    const filtered = item.changes.filter(visible);
    return filtered.length === item.changes.length ? [item] : filtered.length ? [{ ...item, changes: filtered }] : [];
  }) : data.displayItems;
  const items = filteredItems?.length === data.displayItems?.length && filteredItems?.every((item: any, index: any) => item === data.displayItems[index]) ? data.displayItems : filteredItems;
  if (files === data.fileChanges && items === data.displayItems) return change;
  return { ...change, data: { ...data, ...(files !== undefined ? { fileChanges: files } : {}), ...(items !== undefined ? { displayItems: items } : {}) } };
}

export function createRemoteFileChangeProjector(root: any, store: any) {
  const cache = new Map();
  let cachedBytes = 0;
  const maximumBytes = 16 * 1024 * 1024, maximumEntries = 64;
  return async function project(change: any, owner: any) {
    let data = change?.data;
    if (change?.kind !== 'messages' || change.deleted || data?.role !== 'assistant' || data.state !== 'completed' || !validId(data.remoteJobId)) return change;
    const workspaceKey = store.jobWorkspace(owner, data.remoteJobId, data.conversationId);
    if (!workspaceKey) return change;
    const workspace = path.join(root, 'workspaces', workspaceKey), filename = remoteChangeManifestPath(workspace, data.remoteJobId);
    change = removeControlRecords(change, workspace); data = change.data;
    let info;
    try {
      await privateDirectory(path.join(workspace, '.shiyan'));
      await privateDirectory(path.join(workspace, '.shiyan', 'changes'));
      info = await fs.lstat(filename);
    } catch { return change; }
    const key = owner + ':' + data.remoteJobId + ':' + data.conversationId;
    const signature = [info.dev, info.ino, info.mode, info.uid, info.size, info.mtimeMs, info.ctimeMs].join(':');
    let entry = cache.get(key);
    if (entry?.signature !== signature) {
      let files;
      try { files = await readRemoteFileChanges(workspace, data.remoteJobId); } catch { files = []; }
      const size = Buffer.byteLength(JSON.stringify({ files, stagingPaths: (files as any).stagingPaths || [] }));
      if (entry) { cachedBytes -= entry.size; cache.delete(key); }
      entry = { signature, files, size };
      // Oversized results remain usable for this request without filling the cache.
      if (size <= maximumBytes) {
        while (cache.size && (cache.size >= maximumEntries || cachedBytes + size > maximumBytes)) {
          const oldest = cache.keys().next().value; cachedBytes -= cache.get(oldest).size; cache.delete(oldest);
        }
        cache.set(key, entry); cachedBytes += size;
      }
    } else { cache.delete(key); cache.set(key, entry); }
    change = removeControlRecords(change, workspace, new Set(entry.files.stagingPaths || entry.files.flatMap((file: any) => file.stagingPaths || []))); data = change.data;
    if (!entry.files.length) return change;
    return { ...change, data: { ...data, fileChanges: mergeFileChanges(data.fileChanges, entry.files) } };
  };
}
