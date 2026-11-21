import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

// Undefined denotes an absent file; an existing empty file remains distinct.
export async function textFileChange(filename, before, after) {
  if (before === after) return null;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shiyan-diff-'));
  try {
    const oldFile = path.join(directory, 'before'), newFile = path.join(directory, 'after');
    await fs.writeFile(oldFile, before ?? '', { mode: 0o600 });
    await fs.writeFile(newFile, after ?? '', { mode: 0o600 });
    let diff;
    try {
      diff = (await exec('/usr/bin/diff', ['-u', '--label', 'a/' + filename, '--label', 'b/' + filename, oldFile, newFile], { maxBuffer: 4 * 1024 * 1024 })).stdout;
    } catch (error) {
      if ((error as any).code !== 1) throw error;
      diff = (error as any).stdout || '';
    }
    let inHunk = false, added = 0, removed = 0;
    for (const line of diff.split('\n')) {
      if (line.startsWith('@@')) { inHunk = true; continue; }
      if (inHunk && line.startsWith('+')) added++;
      if (inHunk && line.startsWith('-')) removed++;
    }
    return { path: filename, kind: before === undefined ? 'add' : after === undefined ? 'delete' : 'update', available: true, diff,
      added, removed };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
