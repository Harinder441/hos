import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { waitForFullSuite } from './full-suite-lock.mjs';

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const names = args.filter((a) => !a.startsWith('--'));
const LAYOUT = ['shell', 'sidebar', 'phone'];
const AREAS = [
  ['web/src/topic/', ['chat', 'composer', 'cards', 'panel']],
  ['web/src/home/', ['home']],
  ['web/src/settings/', ['settings']],
  ['web/src/snags/', ['snags']],
  ['web/src/config/', ['config']],
  ['web/src/diagrams/', ['diagrams']],
  ['web/src/canvas/', ['canvas']],
  ['web/src/shell/', LAYOUT],
  ['web/src/Sidebar.tsx', LAYOUT],
  ['web/src/styles/', LAYOUT],
  ['src/http.ts', ['smoke']],
  ['src/api/', ['smoke']],
];
const SHARED = /^(package(-lock)?\.json|[^/]*\.config\.ts|tsconfig[^/]*\.json)$/;
const LAYERS = {
  unit: {
    dir: 'test/', own: /^test\/.*\.test\.ts$/, relevant: /^(src|test)\//, harness: /^test\/([^/]+(?<!\.test)\.ts$|fixtures\/)/,
    files: readdirSync('test', { recursive: true }).filter((f) => f.endsWith('.test.ts') && !f.endsWith('.live.test.ts')).map((f) => `test/${f}`),
  },
  e2e: {
    dir: 'e2e/', own: /^e2e\/.*\.spec\.ts$/, relevant: /^(src|web|e2e)\//, harness: /^(e2e\/[^/]+(?<!\.spec)\.ts$|test\/fixtures\/bin\/)/,
    files: readdirSync('e2e').filter((f) => f.endsWith('.spec.ts')).map((f) => `e2e/${f}`),
  },
};

const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).split('\n').filter(Boolean);
const base = git('merge-base', 'origin/main', 'HEAD')[0];
const changed = [...new Set([...git('diff', '--name-only', base), ...git('ls-files', '--others', '--exclude-standard')])];

function namesFor(file) {
  const area = AREAS.filter(([prefix]) => file.startsWith(prefix)).flatMap(([, n]) => n);
  if (area.length || !file.startsWith('src/')) return area;
  return [file.split('/')[1].replace(/\.tsx?$/, ''), basename(file).replace(/\.tsx?$/, '')];
}

function select(L) {
  const hit = changed.find((f) => SHARED.test(f) || L.harness.test(f));
  if (hit) return { reason: `${hit} changed` };
  const match = (n) => L.files.filter((f) => f.slice(L.dir.length).startsWith(n) || basename(f).startsWith(n));
  const relevant = changed.filter((f) => L.relevant.test(f));
  const picked = new Set(relevant.filter((f) => L.own.test(f) && existsSync(f)));
  const unmatched = [];
  for (const f of relevant.filter((f) => !L.own.test(f))) {
    const hits = namesFor(f).flatMap(match);
    hits.forEach((m) => picked.add(m));
    if (!hits.length) unmatched.push(f);
  }
  names.flatMap(match).forEach((m) => picked.add(m));
  if (!picked.size && relevant.length) return { reason: `no test matched ${unmatched.join(', ')}` };
  return { files: [...picked].sort(), unmatched };
}

function run(cmd, a, env) {
  console.log(`$ ${cmd} ${a.join(' ')}`);
  const status = spawnSync(cmd, a, { stdio: 'inherit', env: { ...process.env, ...env } }).status;
  if (status !== 0 && !env) process.exit(status ?? 1);
  return status;
}

if (flag('--full')) {
  run('npx', ['tsc', '--noEmit']);
  run('node', ['scripts/check-hover-text.mjs']);
  run('npx', ['vitest', 'run']);
  run('npm', ['run', 'build']);
  const json = 'test-results/full-suite.json';
  const status = run('npx', ['playwright', 'test', '--retries=1', '--reporter=list,json'], { PLAYWRIGHT_JSON_OUTPUT_FILE: json });
  const flaky = [];
  const walk = (s) => {
    for (const spec of s.specs ?? []) for (const t of spec.tests) if (t.status === 'flaky') flaky.push(`${spec.file}:${spec.line} [${t.projectName}] ${spec.title}`);
    (s.suites ?? []).forEach(walk);
  };
  if (existsSync(json)) JSON.parse(readFileSync(json, 'utf8')).suites.forEach(walk);
  console.log(flaky.length ? `\nPassed only on retry (file each as a snag):\n${flaky.join('\n')}` : '\nNo test needed a retry.');
  process.exit(status ?? 1);
}

const e2e = flag('--e2e');
const sel = select(LAYERS[e2e ? 'e2e' : 'unit']);
const phone = e2e && (flag('--phone') || (sel.files ?? []).includes('e2e/phone.spec.ts'));
const projects = ['--project=desktop', ...(phone ? ['--project=phone'] : [])];
console.log(`${changed.length} changed file(s) since ${base.slice(0, 7)}; names: ${names.join(' ') || '-'}`);
console.log(sel.files ? `${e2e ? 'e2e' : 'unit'}: ${sel.files.join(' ') || 'nothing selected'}` : `${e2e ? 'e2e' : 'unit'}: full layer (${sel.reason})`);
if (sel.unmatched?.length) console.log(`no test for ${sel.unmatched.join(', ')}; pass area names to cover them`);
if (e2e) console.log(`projects: ${projects.join(' ')}`);
if (flag('--list')) process.exit(0);
await waitForFullSuite();

if (!e2e) {
  run('npx', ['tsc', '--noEmit']);
  if (changed.some((f) => f.startsWith('web/src/'))) run('node', ['scripts/check-hover-text.mjs']);
  if (!sel.files || sel.files.length) run('npx', ['vitest', 'run', ...(sel.files ?? [])]);
} else {
  run('npm', ['run', 'build']);
  if (!sel.files || sel.files.length) run('npx', ['playwright', 'test', ...projects, ...(sel.files ?? [])]);
}
