// Build output for the web adapters: transpile each .ts to its .js sibling.
// The Python backend serves the .js files (see shared/backend/api.py), and the
// adapter tests read them too, so run this after editing any adapter .ts:
//   cd apps/web/adapters && node build.mjs
// Generated .js files are gitignored build output, like shared/frontend/*.js.
import { readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const esbuild = require('../../../shared/frontend/node_modules/esbuild');

const files = readdirSync(root)
  .filter((entry) => entry.endsWith('.ts'))
  .map((entry) => join(root, entry))
  .filter((p) => statSync(p).isFile());
console.log(`found ${files.length} .ts files`);
let ok = 0;
for (const f of files) {
  const out = f.replace(/\.ts$/, '.js');
  await esbuild.build({
    entryPoints: [f],
    outfile: out,
    bundle: false,
    target: 'es2022',
    format: 'esm', charset: 'utf8',
  });
  ok += 1;
}
console.log(`adapters build done: ${ok} files`);
