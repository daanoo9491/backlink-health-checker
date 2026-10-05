/**
 * Packs the browser helper (extension/) into public/downloads/linkledger-helper.zip,
 * so team members can download it from Settings without the source code.
 * Runs before every build; the zip itself isn't committed.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const root = fileURLToPath(new URL('..', import.meta.url));
const src = join(root, 'extension');
const files = {};
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (!name.endsWith('.md'))
      files[`linkledger-helper/${relative(src, p).split('\\').join('/')}`] = readFileSync(p);
  }
})(src);
const out = join(root, 'public', 'downloads');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'linkledger-helper.zip'), zipSync(files, { level: 9, mtime: new Date('2026-01-01') }));
console.log(`Browser helper packed: ${Object.keys(files).length} files → public/downloads/linkledger-helper.zip`);
