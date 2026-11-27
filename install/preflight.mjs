#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, statfsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { arch as osArch, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const GB = 1024 ** 3;
export const MIN_NODE_MAJOR = 22;
export const MIN_FREE_BYTES = 2 * GB;
export const LOW_FREE_BYTES = 5 * GB;
export const DEFAULT_PORT = 4517;

export function claudeEnv(env = process.env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (key.startsWith('CLAUDE') && key !== 'CLAUDE_CONFIG_DIR') continue;
    if (key === 'ANTHROPIC_API_KEY' || key === 'ANTHROPIC_AUTH_TOKEN') continue;
    out[key] = value;
  }
  return out;
}

export function bundledClaudeIn(hosRoot, platform = process.platform, arch = osArch()) {
  try {
    return createRequire(join(hosRoot, 'package.json')).resolve(`@anthropic-ai/claude-agent-sdk-${platform}-${arch}/claude`);
  } catch {
    return null;
  }
}

function exec(bin, args, options = {}) {
  const result = spawnSync(bin, args, { encoding: 'utf8', timeout: 15_000, ...options });
  return { ok: result.status === 0, found: !result.error, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() };
}

function portFree(port) {
  return new Promise((done) => {
    const server = createServer();
    server.once('error', () => done(false));
    server.listen(port, '127.0.0.1', () => server.close(() => done(true)));
  });
}

function freeBytes(dir) {
  try {
    const s = statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

const row = (id, label, status, detail, fix) => ({ id, label, status, detail, ...(fix ? { fix } : {}) });
const firstLine = (text) => text.split('\n')[0] ?? '';

function claudeRow(machine, options) {
  const label = 'Claude sign-in';
  const bundled = options.claudeBin ?? bundledClaudeIn(options.hosRoot, machine.platform, machine.arch);
  const bin = bundled ?? 'claude';
  const status = machine.run(bin, ['auth', 'status'], { env: claudeEnv(machine.env) });
  if (!status.found) {
    return bundled
      ? row('claude', label, 'fail', `${bin} did not run`, 'run npm ci in the hos folder again')
      : row('claude', label, 'warn', 'no claude found: the one hos starts is installed by npm ci in the hos folder', 'run node <hos folder>/dist/daemon/main.js doctor --preflight again after npm ci');
  }
  let loggedIn = false;
  let plan = null;
  try {
    const parsed = JSON.parse(status.stdout);
    loggedIn = parsed.loggedIn === true;
    plan = parsed.subscriptionType ?? null;
  } catch {}
  const which = bundled ? `the claude hos starts (${bin})` : 'the claude on PATH (the one hos starts comes with npm ci)';
  if (!loggedIn) return row('claude', label, 'fail', `${which}: not signed in`, `run this in your own terminal and sign in with your Claude account: ${bundled ? `"${bin}"` : 'claude'} auth login`);
  if (!bundled) return row('claude', label, 'warn', `${which}: signed in${plan ? ` (${plan} plan)` : ''}`, 'run node <hos folder>/dist/daemon/main.js doctor --preflight again after npm ci to check the binary hos starts');
  return row('claude', label, 'ok', `${which}: signed in${plan ? ` (${plan} plan)` : ''}`);
}

function toolchainRow(machine) {
  if (machine.platform === 'darwin') {
    const x = machine.run('xcode-select', ['-p']);
    return x.ok
      ? row('toolchain', 'C/C++ toolchain', 'ok', `Xcode command line tools at ${x.stdout}`)
      : row('toolchain', 'C/C++ toolchain', 'fail', 'no Xcode command line tools; npm ci builds native modules with them', 'xcode-select --install (it opens a dialog; you click Install)');
  }
  const missing = ['cc', 'c++', 'make', 'python3'].filter((tool) => !machine.run('sh', ['-c', `command -v ${tool}`]).ok);
  return missing.length
    ? row('toolchain', 'C/C++ toolchain', 'fail', `missing ${missing.join(', ')}; npm ci builds native modules with them`, 'run it yourself: sudo apt install build-essential python3 (or your distribution\'s equivalent)')
    : row('toolchain', 'C/C++ toolchain', 'ok', 'cc, c++, make and python3 found');
}

export async function preflight(options = {}, machine = thisMachine()) {
  const port = options.port ?? DEFAULT_PORT;
  const dataDir = options.dataDir ?? join(machine.home, '.hos');
  const hosRoot = options.hosRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const rows = [];

  rows.push(
    machine.platform === 'darwin' || machine.platform === 'linux'
      ? row('os', 'Operating system', 'ok', `${machine.platform} ${machine.arch}`)
      : row('os', 'Operating system', 'fail', `${machine.platform} is not supported`, 'hos runs on macOS or Linux'),
  );

  const major = Number.parseInt(machine.nodeVersion.replace(/^v/, ''), 10);
  rows.push(
    major >= MIN_NODE_MAJOR
      ? row('node', 'Node', 'ok', machine.nodeVersion)
      : row('node', 'Node', 'fail', `${machine.nodeVersion} is older than ${MIN_NODE_MAJOR}`, `install Node ${MIN_NODE_MAJOR} or newer (nvm install ${MIN_NODE_MAJOR}, or your OS package); ask before adding a version manager`),
  );

  for (const [id, label, args, fix] of [
    ['npm', 'npm', ['--version'], 'npm comes with Node; reinstall Node'],
    ['git', 'git', ['--version'], machine.platform === 'darwin' ? 'xcode-select --install installs git too' : 'run it yourself: sudo apt install git'],
  ]) {
    const result = machine.run(id, args);
    rows.push(result.ok ? row(id, label, 'ok', firstLine(result.stdout)) : row(id, label, 'fail', `${id} was not found`, fix));
  }

  rows.push(toolchainRow(machine));

  const gh = machine.run('gh', ['--version']);
  if (!gh.found) rows.push(row('gh', 'GitHub CLI', 'warn', 'gh was not found; it is needed only to create your private brain repo', 'install gh (https://cli.github.com), or keep the brain local and add a remote later'));
  else {
    const auth = machine.run('gh', ['auth', 'status']);
    rows.push(auth.ok ? row('gh', 'GitHub CLI', 'ok', `${firstLine(gh.stdout)}, signed in`) : row('gh', 'GitHub CLI', 'warn', `${firstLine(gh.stdout)}, not signed in`, 'run this in your own terminal: gh auth login'));
  }

  rows.push(claudeRow(machine, { ...options, hosRoot }));

  const tmux = machine.run('tmux', ['-V']);
  rows.push(tmux.ok ? row('tmux', 'tmux', 'ok', tmux.stdout) : row('tmux', 'tmux', 'warn', 'tmux was not found; terminals, dev servers and Code view need it', machine.platform === 'darwin' ? 'brew install tmux' : 'run it yourself: sudo apt install tmux'));

  rows.push(
    (await machine.portFree(port))
      ? row('port', 'Port', 'ok', `${port} is free`)
      : row('port', 'Port', 'fail', `something already listens on 127.0.0.1:${port}; hos may already be running`, `upgrade instead (INSTALL.md, Updating), or pick another port with --port`),
  );

  const free = machine.freeBytes(existsSync(dataDir) ? dataDir : machine.home);
  rows.push(
    free === null
      ? row('disk', 'Disk', 'warn', 'could not read free space')
      : free < MIN_FREE_BYTES
        ? row('disk', 'Disk', 'fail', `${(free / GB).toFixed(1)} GB free; the install needs about ${MIN_FREE_BYTES / GB} GB`, 'free some space first')
        : row('disk', 'Disk', free < LOW_FREE_BYTES ? 'warn' : 'ok', `${(free / GB).toFixed(1)} GB free`),
  );

  rows.push(
    existsSync(dataDir)
      ? row('existing', 'Existing hos', 'warn', `${dataDir} already exists: hos has run on this computer before`, 'upgrade instead (INSTALL.md, Updating), or ask the user before going on')
      : row('existing', 'Existing hos', 'ok', `no ${dataDir} yet`),
  );

  return { ok: rows.every((r) => r.status !== 'fail'), rows };
}

export function thisMachine() {
  return { platform: process.platform, arch: osArch(), nodeVersion: process.version, home: homedir(), env: process.env, run: exec, portFree, freeBytes };
}

export function preflightText(result) {
  const lines = result.rows.flatMap((r) => [`${r.status.padEnd(4)}  ${r.label}: ${r.detail}`, ...(r.fix && r.status !== 'ok' ? [`      fix: ${r.fix}`] : [])]);
  lines.push(result.ok ? 'preflight ok: nothing blocks the install' : 'preflight failed: fix the fail rows, then run it again');
  return lines.join('\n');
}

export const PREFLIGHT_OPTIONS = {
  json: { type: 'boolean', default: false },
  port: { type: 'string' },
  'data-dir': { type: 'string' },
  'claude-bin': { type: 'string' },
};

export async function preflightMain(args) {
  const { values } = parseArgs({ args, options: PREFLIGHT_OPTIONS });
  const port = values.port ? Number(values.port) : undefined;
  if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) {
    console.error(`--port must be a port number, got ${values.port}`);
    return 2;
  }
  const result = await preflight({
    ...(port ? { port } : {}),
    ...(values['data-dir'] ? { dataDir: resolve(values['data-dir']) } : {}),
    ...(values['claude-bin'] ? { claudeBin: values['claude-bin'] } : {}),
  });
  console.log(values.json ? JSON.stringify(result, null, 2) : preflightText(result));
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(await preflightMain(process.argv.slice(2)));
}
