import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Builds the site with base = its own output folder, so each page opens from file:// with its CSS for learn/check.mjs.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist-check');
execFileSync('npx', ['astro', 'build'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1', DOCS_BASE: `${out}/`, DOCS_OUT: out },
});

const pages = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith('.html')) pages.push(p);
  }
};
walk(out);
console.log(pages.sort().join('\n'));
