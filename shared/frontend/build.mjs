import * as esbuild from 'esbuild';
import { readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

function collectTs(dir, out) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (entry === 'node_modules') continue;
      collectTs(p, out);
    } else if (entry.endsWith('.ts')) {
      out.push(p);
    }
  }
  return out;
}

const files = collectTs(root, []);
console.log(`found ${files.length} .ts files`);
let ok = 0;
for (const f of files) {
  const out = f.replace(/\.ts$/, '.js');
  await esbuild.build({
    entryPoints: [f],
    outfile: out,
    bundle: false,
    target: 'es2022',
    format: 'esm',
  });
  ok += 1;
}
console.log(`frontend build done: ${ok} files`);
