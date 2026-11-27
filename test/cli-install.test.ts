import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { claudeEnv } from '../src/adapters/claude-bin.js';
import { hosRoot } from '../src/cli/common.js';
import { runCli } from '../src/cli/index.js';
import { linkHos, unlinkHos } from '../src/cli/link.js';
import { cleanupAll, git, tempDir } from './harness.js';
import * as pre from '../install/preflight.mjs';
import { DOCS_PROMPT_FILES, promptText, release, sha256, writePrompt } from '../scripts/release.mjs';

afterEach(cleanupAll);

type Run = { ok: boolean; found: boolean; stdout: string; stderr: string };
const ok = (stdout = ''): Run => ({ ok: true, found: true, stdout, stderr: '' });
const failed = (stdout = ''): Run => ({ ok: false, found: true, stdout, stderr: '' });
const absent: Run = { ok: false, found: false, stdout: '', stderr: '' };

function fakeMachine(overrides: Record<string, Run> = {}, extra: Partial<{ platform: string; nodeVersion: string; free: number | null; portFree: boolean; home: string; env: Record<string, string>; files: Record<string, string> }> = {}) {
  const calls: string[] = [];
  const answers: Record<string, Run> = {
    'npm --version': ok('11.0.0'),
    'git --version': ok('git version 2.50.0'),
    'xcode-select -p': ok('/Library/Developer/CommandLineTools'),
    'gh --version': ok('gh version 2.78.0\nhttps://github.com/cli/cli'),
    'gh auth status': ok(),
    'claude auth status': ok(JSON.stringify({ loggedIn: true, subscriptionType: 'pro' })),
    'tmux -V': ok('tmux 3.5'),
    ...overrides,
  };
  return {
    calls,
    machine: {
      platform: extra.platform ?? 'darwin',
      arch: 'arm64',
      nodeVersion: extra.nodeVersion ?? 'v22.15.0',
      home: extra.home ?? '/nonexistent-home',
      env: { CLAUDE_CODE_ENTRYPOINT: 'x', ANTHROPIC_API_KEY: '<token>', CLAUDE_CONFIG_DIR: '/c', PATH: '/bin', ...extra.env },
      run(bin: string, args: string[], options?: { env?: Record<string, string> }) {
        const key = `${bin.split('/').pop()} ${args.join(' ')}`;
        calls.push(key);
        if (key === 'claude auth status') expect(options?.env).toEqual({ CLAUDE_CONFIG_DIR: '/c', PATH: '/bin', ...extra.env });
        return answers[key] ?? (bin === 'sh' ? ok() : absent);
      },
      portFree: async () => extra.portFree ?? true,
      freeBytes: () => (extra.free === undefined ? 50 * 1024 ** 3 : extra.free),
      readText: (path: string) => extra.files?.[path] ?? null,
    },
  };
}

const status = (result: { rows: { id: string; status: string }[] }) => Object.fromEntries(result.rows.map((r) => [r.id, r.status]));

test('preflight passes on a ready Mac and checks the claude binary hos will start, with hos-stripped env', async () => {
  const { machine, calls } = fakeMachine();
  const result = await pre.preflight({ hosRoot: '/nonexistent', claudeBin: '/x/claude', dataDir: '/nonexistent-data' }, machine);
  expect(result.ok).toBe(true);
  expect(status(result)).toEqual({ os: 'ok', node: 'ok', npm: 'ok', git: 'ok', toolchain: 'ok', gh: 'ok', claude: 'ok', tmux: 'ok', port: 'ok', disk: 'ok', existing: 'ok' });
  expect(result.rows.find((r: { id: string }) => r.id === 'claude')!.detail).toContain('/x/claude');
  expect(calls).toContain('claude auth status');
});

test('preflight fails on old Node, no toolchain, signed-out claude, a busy port and a full disk; gh and tmux are only warnings', async () => {
  const { machine } = fakeMachine(
    { 'claude auth status': failed(JSON.stringify({ loggedIn: false })), 'gh --version': absent, 'tmux -V': absent },
    { platform: 'linux', nodeVersion: 'v20.11.0', portFree: false, free: 1024 ** 3 },
  );
  machine.run = ((orig) => (bin: string, args: string[], options?: { env?: Record<string, string> }) =>
    bin === 'sh' && /command -v (make|python3)/.test(args[1]!) ? absent : orig(bin, args, options))(machine.run);
  const result = await pre.preflight({ hosRoot: '/nonexistent', claudeBin: '/x/claude', dataDir: '/nonexistent-data' }, machine);
  expect(result.ok).toBe(false);
  expect(status(result)).toMatchObject({ node: 'fail', toolchain: 'fail', claude: 'fail', port: 'fail', disk: 'fail', gh: 'warn', tmux: 'warn' });
  const fix = (id: string) => result.rows.find((r: { id: string }) => r.id === id)!.fix;
  expect(fix('toolchain')).toContain('sudo apt install build-essential');
  expect(fix('claude')).toContain('auth login');
  expect(result.rows.find((r: { id: string }) => r.id === 'toolchain')!.detail).toContain('make, python3');
  expect(pre.preflightText(result)).toContain('preflight failed');
});

test('before npm ci, preflight checks the PATH claude and asks for a second run; an existing data dir is a warning', async () => {
  const data = await tempDir('hos-pre-data-');
  const { machine } = fakeMachine();
  const result = await pre.preflight({ hosRoot: await tempDir('hos-pre-root-'), dataDir: data }, machine);
  const claude = result.rows.find((r: { id: string }) => r.id === 'claude')!;
  expect([claude.status, claude.detail]).toEqual(['warn', 'the claude on PATH (the one hos starts comes with npm ci): signed in (pro plan)']);
  expect(claude.fix).toContain('again after npm ci');
  expect(status(result).existing).toBe('warn');
  expect(result.ok).toBe(true);
});

const WSL2_KERNEL = 'Linux version 6.6.87-microsoft-standard-WSL2 (root@439a258ad544) (gcc (GCC) 11.2.0) #1 SMP PREEMPT_DYNAMIC';
const WSL1_KERNEL = 'Linux version 4.4.0-26100-Microsoft (Microsoft@Microsoft.com) (gcc version 5.4.0 (GCC) ) #5074-Microsoft';

async function wslRow(files: Record<string, string>, hosRoot = '/opt/code/hos', env: Record<string, string> = { WSL_DISTRO_NAME: 'Ubuntu' }) {
  const { machine } = fakeMachine({}, { platform: 'linux', env, files });
  const result = await pre.preflight({ hosRoot, claudeBin: '/x/claude', dataDir: '/nonexistent-data' }, machine);
  return { result, wsl: result.rows.find((r: { id: string }) => r.id === 'wsl') };
}

test('preflight adds a WSL row after the OS row: ok on WSL 2 with systemd, and no row on plain Linux or a Mac', async () => {
  const { result, wsl } = await wslRow({ '/proc/version': WSL2_KERNEL, '/proc/1/comm': 'systemd\n' });
  expect(result.rows.map((r: { id: string }) => r.id).slice(0, 3)).toEqual(['os', 'wsl', 'node']);
  expect([wsl!.status, wsl!.detail]).toEqual(['ok', 'WSL 2 (Ubuntu): open hos at http://localhost:4517 in your Windows browser']);
  expect(result.ok).toBe(true);
  expect((await wslRow({ '/proc/version': 'Linux version 6.8.0-49-generic', '/proc/1/comm': 'systemd\n' }, undefined, {})).wsl).toBeUndefined();
  expect((await wslRow({ '/proc/version': WSL2_KERNEL }, undefined, {})).wsl!.detail).toContain('WSL 2:');
  const mac = await pre.preflight({ hosRoot: '/nonexistent', claudeBin: '/x/claude', dataDir: '/nonexistent-data' }, fakeMachine({}, { env: { WSL_DISTRO_NAME: 'Ubuntu' } }).machine);
  expect(mac.rows.some((r: { id: string }) => r.id === 'wsl')).toBe(false);
});

test('preflight fails WSL 1 with the convert command, and warns for a checkout under /mnt/ or systemd off', async () => {
  const one = await wslRow({ '/proc/version': WSL1_KERNEL, '/proc/1/comm': 'init\n' });
  expect([one.wsl!.status, one.result.ok]).toEqual(['fail', false]);
  expect(one.wsl!.fix).toContain('wsl --set-version <distro> 2');
  const warned = await wslRow({ '/proc/version': WSL2_KERNEL, '/proc/1/comm': 'init\n' }, '/mnt/c/code/hos');
  expect([warned.wsl!.status, warned.result.ok]).toEqual(['warn', true]);
  expect(warned.wsl!.detail).toContain('/mnt/c/code/hos is on the Windows drive');
  expect(warned.wsl!.detail).toContain('systemd is off');
  expect(warned.wsl!.fix).toContain('/etc/wsl.conf');
  expect(warned.wsl!.fix).toContain('wsl --shutdown');
  const mntOnly = await wslRow({ '/proc/version': WSL2_KERNEL, '/proc/1/comm': 'systemd\n' }, '/mnt/d/hos');
  expect([mntOnly.wsl!.status, mntOnly.wsl!.fix]).toEqual(['warn', 'clone hos into your Linux home (for example ~/code/hos), not under /mnt/']);
});

test('preflight on native Windows fails the OS row and points at WSL2', async () => {
  const { machine } = fakeMachine({}, { platform: 'win32' });
  const result = await pre.preflight({ hosRoot: '/nonexistent', claudeBin: '/x/claude', dataDir: '/nonexistent-data' }, machine);
  const os = result.rows.find((r: { id: string }) => r.id === 'os')!;
  expect([os.status, os.fix]).toEqual(['fail', 'use WSL2: see INSTALL.md, Windows (WSL2)']);
  expect(result.ok).toBe(false);
});

test('preflight strips the same Claude and Anthropic variables as the daemon does', () => {
  const env = { CLAUDECODE: '1', CLAUDE_CONFIG_DIR: '/c', ANTHROPIC_API_KEY: '<token>', ANTHROPIC_AUTH_TOKEN: '<token>', ANTHROPIC_BASE_URL: 'u', HOME: '/h' };
  const saved = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env);
    expect(pre.claudeEnv(env)).toEqual(claudeEnv());
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test('node install/preflight.mjs runs with no dependencies and prints JSON rows; a busy port fails it', async () => {
  const dir = await tempDir('hos-pre-cli-');
  const claude = join(dir, 'claude');
  writeFileSync(claude, `#!/bin/sh\necho '{"loggedIn":true,"subscriptionType":"pro"}'\n`);
  chmodSync(claude, 0o755);
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const run = () => {
      try {
        return { code: 0, out: execFileSync(process.execPath, [join(hosRoot(), 'install', 'preflight.mjs'), '--json', '--port', String(port), '--data-dir', join(dir, 'data'), '--claude-bin', claude], { encoding: 'utf8' }) };
      } catch (error) {
        return { code: (error as { status: number }).status, out: (error as { stdout: string }).stdout };
      }
    };
    const busy = run();
    expect(busy.code).toBe(1);
    const parsed = JSON.parse(busy.out) as { ok: boolean; rows: { id: string; status: string }[] };
    expect(parsed.rows.map((r) => r.id)).toEqual(['os', 'node', 'npm', 'git', 'toolchain', 'gh', 'claude', 'tmux', 'port', 'disk', 'existing']);
    expect(status(parsed)).toMatchObject({ port: 'fail', claude: 'ok', existing: 'ok' });
  } finally {
    server.close();
  }
  expect(await runCli(['doctor'])).toBe(2);
});

async function fakeCheckout(): Promise<string> {
  const root = await tempDir('hos-link-root-');
  mkdirSync(join(root, 'dist', 'daemon'), { recursive: true });
  writeFileSync(join(root, 'dist', 'daemon', 'main.js'), 'console.log(JSON.stringify(process.argv.slice(2)));\n');
  return root;
}

test('hos link puts an executable hos on a bin folder that runs this checkout with this Node, and hos unlink removes only its own file', async () => {
  const root = await fakeCheckout();
  const binDir = join(await tempDir('hos-bin-'), "my 'bin'");
  const first = linkHos({ binDir, root, path: '/usr/bin' });
  expect(first.ok).toBe(true);
  expect(first.lines[1]).toContain(`export PATH="${binDir}:$PATH"`);
  const file = join(binDir, 'hos');
  expect(statSync(file).mode & 0o111).toBeTruthy();
  expect(JSON.parse(execFileSync(file, ['validate', 'a b'], { encoding: 'utf8' }))).toEqual(['validate', 'a b']);
  expect(linkHos({ binDir, root, path: `/usr/bin:${binDir}` }).lines).toEqual([`updated ${file} → ${join(root, 'dist', 'daemon', 'main.js')}`, `on PATH: ${binDir}`]);
  expect(unlinkHos({ binDir }).lines).toEqual([`removed ${file}`]);
  expect(existsSync(file)).toBe(false);
  expect(unlinkHos({ binDir }).ok).toBe(true);

  writeFileSync(file, '#!/bin/sh\necho someone else\n');
  expect(linkHos({ binDir, root }).ok).toBe(false);
  expect(unlinkHos({ binDir }).ok).toBe(false);
  expect(readFileSync(file, 'utf8')).toBe('#!/bin/sh\necho someone else\n');
  expect(linkHos({ binDir: join(binDir, 'x'), root: await tempDir('hos-unbuilt-') }).lines[0]).toContain('npm run build');
});

const HEX = 'a'.repeat(64);

test('the release script pins the tag and the SHA-256 into both docs prompts, drops their TODO-T19 lines and can run again', () => {
  for (const file of DOCS_PROMPT_FILES) {
    const text = readFileSync(join(hosRoot(), file), 'utf8');
    const pinned = writePrompt(text, 'me/hos', 'v9.9.9', HEX);
    expect(pinned, file).toContain(`https://raw.githubusercontent.com/me/hos/v9.9.9/install/INSTALL.md with curl, check that its SHA-256 is ${file.endsWith('.astro') ? '<span class="p">' : ''}${HEX}`);
    expect(pinned, file).not.toContain('TODO-T19');
    expect(pinned.length, file).toBeGreaterThan(text.length - 200);
    expect(writePrompt(pinned, 'me/hos', 'v9.9.10', 'b'.repeat(64)), file).toContain(`/v9.9.10/install/INSTALL.md with curl, check that its SHA-256 is ${file.endsWith('.astro') ? '<span class="p">' : ''}${'b'.repeat(64)}`);
  }
  expect(() => writePrompt('no prompt here', 'me/hos', 'v1.0.0', HEX)).toThrow('found 0 URL(s)');
});

async function releaseRepo(): Promise<string> {
  const root = await tempDir('hos-release-');
  const write = (path: string, text: string) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  write('package.json', JSON.stringify({ name: 'hos', version: '1.2.3' }));
  write('install/INSTALL.md', '# Install hos\n');
  for (const file of DOCS_PROMPT_FILES) write(file, readFileSync(join(hosRoot(), file), 'utf8'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'v1.2.3');
  return root;
}

test('release builds INSTALL.md, its hash, the prompt, a source tarball and SHA256SUMS, and refuses a wrong or moved tag', async () => {
  const root = await releaseRepo();
  const out = join(root, 'out');
  expect(() => release({ root, tag: 'v1.2.4', out })).toThrow('does not match package.json version 1.2.3');

  const result = release({ root, tag: 'v1.2.3', out, repo: 'me/hos' });
  const hash = sha256('# Install hos\n');
  expect([result.hash, result.tagged]).toEqual([hash, false]);
  expect(result.lines[0]).toContain('build-only');
  expect(readFileSync(join(out, 'prompt.txt'), 'utf8')).toBe(`${promptText('me/hos', 'v1.2.3', hash)}\n`);
  expect(readFileSync(join(out, 'INSTALL.md.sha256'), 'utf8')).toBe(`${hash}  INSTALL.md\n`);
  expect(readFileSync(join(root, DOCS_PROMPT_FILES[0]!), 'utf8')).toContain(`check that its SHA-256 is ${hash}`);
  const sums = readFileSync(join(out, 'SHA256SUMS'), 'utf8').trim().split('\n').map((l) => l.split('  ')[1]);
  expect(sums).toEqual(['INSTALL.md', 'INSTALL.md.sha256', 'hos-1.2.3.tar.gz', 'prompt.txt']);
  expect(execFileSync('tar', ['-tzf', join(out, 'hos-1.2.3.tar.gz')], { encoding: 'utf8' })).toContain('hos-1.2.3/install/INSTALL.md');

  git(root, 'checkout', '-q', '--', '.');
  git(root, 'tag', 'v1.2.3');
  expect(release({ root, tag: 'v1.2.3', out }).tagged).toBe(true);
  git(root, 'checkout', '-q', '--', '.');
  git(root, 'commit', '-q', '--allow-empty', '-m', 'later');
  expect(() => release({ root, tag: 'v1.2.3', out })).toThrow('is not HEAD');
});
