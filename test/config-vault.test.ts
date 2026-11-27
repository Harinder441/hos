import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { callBus } from '../src/fakes/bus-client.js';
import { cleanupAll, collect, git, startTestDaemon, tempDir, tempGitRepo } from './harness.js';
import { newTopic } from './topics.js';

afterEach(cleanupAll);

const FAKE = 'fake-value-123';

async function repoWithEnvs(): Promise<string> {
  const repo = await tempGitRepo('main', await tempDir('hos-repos-'), 'shop');
  await writeFile(join(repo, '.gitignore'), '.env*\n!.env.example\nnode_modules/\n');
  await writeFile(join(repo, '.env.example'), 'TRACKED=1\n');
  await writeFile(join(repo, 'CLAUDE.md'), '# upstream rules\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'tracked files');
  await writeFile(join(repo, '.env'), `API_KEY=${FAKE}\nexport PORT=3000\n# a comment\n`);
  await mkdir(join(repo, 'client'));
  await writeFile(join(repo, 'client', '.env'), 'CLIENT_URL=http://fake.invalid\n');
  await mkdir(join(repo, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(join(repo, 'node_modules', 'pkg', '.env'), 'IGNORED=1\n');
  return repo;
}

const ended = (workspaceId: string) => (events: Awaited<ReturnType<ReturnType<typeof collect>['until']>>) =>
  events.some((e) => e.type === 'workspace.updated' && e.workspace.id === workspaceId && (e.workspace.setup === 'ready' || e.workspace.setup === 'failed'));

test('Import from root copies top-level and nested .env files into a private local git store; the tree and file APIs never send values', async () => {
  const hos = await startTestDaemon();
  const repo = await repoWithEnvs();
  await hos.client.createProject(repo);

  expect(await hos.client.configImport('shop')).toEqual({ imported: ['.env', 'client/.env'] });
  const dir = join(hos.dataDir, 'config');
  expect(readFileSync(join(dir, 'shop', '.env'), 'utf8')).toContain(FAKE);
  expect(statSync(join(dir, 'shop', '.env')).mode & 0o777).toBe(0o600);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(git(dir, 'log', '--format=%s')).toBe('import shop from its root checkout');
  expect(git(dir, 'remote')).toBe('');

  const tree = await hos.client.configTree();
  expect(tree.repos).toEqual([
    {
      repo: 'shop',
      root: repo,
      files: [
        { path: '.env', env: true, tracked: false, exclude: false, drift: 0, targets: 1 },
        { path: 'client/.env', env: true, tracked: false, exclude: false, drift: 0, targets: 1 },
      ],
    },
  ]);
  const file = await hos.client.configFile('shop', '.env');
  expect(file).toMatchObject({ env: true, text: null, keys: [{ name: 'API_KEY', length: FAKE.length }, { name: 'PORT', length: 4 }] });
  expect(file.targets).toEqual([{ path: repo, name: 'root', kind: 'root', branch: 'main', state: 'in-sync' }]);
  expect(JSON.stringify([tree, file])).not.toContain(FAKE);
  expect(await hos.client.configReveal('shop', '.env', 'API_KEY')).toEqual({ value: FAKE });
});

test('Save edits keys in the central copy only and commits; Apply writes the ticked worktrees, records hashes and backs up a drifted copy', async () => {
  const hos = await startTestDaemon();
  const repo = await repoWithEnvs();
  const project = await hos.client.createProject(repo);
  await hos.client.configImport('shop');
  const stream = collect(hos.client);
  const a = await hos.client.createWorkspace({ projectId: project.id, kind: 'worktree', branch: 'feature/a' });
  await stream.until(ended(a.id));
  const b = await hos.client.createWorkspace({ projectId: project.id, kind: 'worktree', branch: 'feature/b' });
  await stream.until(ended(b.id));
  expect(readFileSync(join(a.path, 'client', '.env'), 'utf8')).toBe('CLIENT_URL=http://fake.invalid\n');

  const saved = await hos.client.configSave({ repo: 'shop', path: '.env', set: { PORT: '4000', NEW_FLAG: 'on' }, remove: ['API_KEY'] });
  expect(readFileSync(join(hos.dataDir, 'config', 'shop', '.env'), 'utf8')).toBe('export PORT=4000\n# a comment\nNEW_FLAG=on\n');
  expect(readFileSync(join(repo, '.env'), 'utf8')).toContain(FAKE);
  expect(git(join(hos.dataDir, 'config'), 'log', '-1', '--format=%s')).toBe('save shop/.env');
  const byName = Object.fromEntries(saved.targets.map((t) => [t.path, t.state]));
  expect(byName).toEqual({ [repo]: 'not-applied', [a.path]: 'not-applied', [b.path]: 'not-applied' });

  await writeFile(join(b.path, '.env'), 'LOCAL_DEBUG=1\n');
  const preview = await hos.client.configPreview('shop', '.env', [a.path, b.path]);
  expect(preview).toEqual([
    { target: a.path, state: 'not-applied', backup: false, changes: [{ name: 'PORT', change: 'changed' }, { name: 'NEW_FLAG', change: 'added' }, { name: 'API_KEY', change: 'removed' }] },
    { target: b.path, state: 'edited', backup: true, changes: [{ name: 'PORT', change: 'added' }, { name: 'NEW_FLAG', change: 'added' }, { name: 'LOCAL_DEBUG', change: 'removed' }] },
  ]);
  expect(JSON.stringify(preview)).not.toContain('4000');

  const result = await hos.client.configApply('shop', '.env', [a.path, b.path]);
  expect(result.applied).toEqual([a.path, b.path]);
  expect(result.errors).toEqual([]);
  expect(result.backups).toHaveLength(1);
  expect(readFileSync(result.backups[0]!, 'utf8')).toBe('LOCAL_DEBUG=1\n');
  for (const path of [a.path, b.path]) {
    expect(readFileSync(join(path, '.env'), 'utf8')).toBe('export PORT=4000\n# a comment\nNEW_FLAG=on\n');
    expect(statSync(join(path, '.env')).mode & 0o777).toBe(0o600);
  }
  expect(readFileSync(join(repo, '.env'), 'utf8')).toContain(FAKE);
  const after = Object.fromEntries((await hos.client.configFile('shop', '.env')).targets.map((t) => [t.path, t.state]));
  expect(after).toEqual({ [repo]: 'not-applied', [a.path]: 'in-sync', [b.path]: 'in-sync' });

  await writeFile(join(a.path, '.env'), 'HAND_EDIT=1\n');
  const drift = (await hos.client.configTree()).repos[0]!.files.find((f) => f.path === '.env')!;
  expect(drift).toMatchObject({ drift: 2, targets: 3 });
  expect((await hos.client.configFile('shop', '.env')).targets.find((t) => t.path === a.path)!.state).toBe('edited');
});

test('a tracked override in map.yaml is applied with skip-worktree so git status stays clean, and new worktrees get it seeded', async () => {
  const hos = await startTestDaemon();
  const repo = await repoWithEnvs();
  const project = await hos.client.createProject(repo);
  const dir = join(hos.dataDir, 'config');
  await hos.client.configSave({ repo: 'shop', path: 'CLAUDE.md', text: '# trimmed rules\n' });
  await writeFile(join(dir, 'map.yaml'), 'version: 1\nfiles:\n  - { repo: shop, path: CLAUDE.md, tracked: true }\n');
  expect((await hos.client.configFile('shop', 'CLAUDE.md')).text).toBe('# trimmed rules\n');

  expect(await hos.client.configApply('shop', 'CLAUDE.md', [repo])).toMatchObject({ applied: [repo], errors: [] });
  expect(readFileSync(join(repo, 'CLAUDE.md'), 'utf8')).toBe('# trimmed rules\n');
  expect(git(repo, 'status', '--porcelain')).toBe('');

  const stream = collect(hos.client);
  const ws = await hos.client.createWorkspace({ projectId: project.id, kind: 'worktree', branch: 'feature/trim' });
  await stream.until(ended(ws.id));
  expect(readFileSync(join(ws.path, 'CLAUDE.md'), 'utf8')).toBe('# trimmed rules\n');
  expect(git(ws.path, 'status', '--porcelain')).toBe('');
  expect((await hos.client.configTree()).repos[0]!.files).toEqual([{ path: 'CLAUDE.md', env: false, tracked: true, exclude: false, drift: 0, targets: 2 }]);
});

test('seeding never overwrites a file the new worktree already has, Remove drops the central copy, and bad paths are refused', async () => {
  const hos = await startTestDaemon();
  const repo = await repoWithEnvs();
  const project = await hos.client.createProject(repo);
  await hos.client.configSave({ repo: 'shop', path: '.env.example', text: 'CENTRAL=1\n' });
  await hos.client.configSave({ repo: 'shop', path: 'deep/dir/.env', text: 'DEEP=1\n' });
  const stream = collect(hos.client);
  const ws = await hos.client.createWorkspace({ projectId: project.id, kind: 'worktree', branch: 'feature/keep' });
  await stream.until(ended(ws.id));
  expect(readFileSync(join(ws.path, '.env.example'), 'utf8')).toBe('TRACKED=1\n');
  expect(readFileSync(join(ws.path, 'deep', 'dir', '.env'), 'utf8')).toBe('DEEP=1\n');

  await expect(hos.client.configSave({ repo: 'shop', path: 'deep/dir/.env', text: 'X=1\n' })).rejects.toThrow(/key by key/);
  await expect(hos.client.configSave({ repo: 'shop', path: '../escape', text: 'x' })).rejects.toThrow(/not a usable path/);
  await expect(hos.client.configSave({ repo: '../x', path: '.env', text: 'x' })).rejects.toThrow(/repo must be/);
  await expect(hos.client.configSave({ repo: 'shop', path: '.env', set: { 'bad key': 'x' } })).rejects.toThrow(/not a valid env key/);
  await expect(hos.client.configApply('shop', 'deep/dir/.env', ['/tmp'])).rejects.toThrow(/not a worktree of shop/);

  expect(await hos.client.configRemove('shop', 'deep/dir/.env')).toEqual({ ok: true });
  expect(existsSync(join(hos.dataDir, 'config', 'shop', 'deep', 'dir', '.env'))).toBe(false);
  expect(existsSync(join(ws.path, 'deep', 'dir', '.env'))).toBe(true);
});

test('a tracked override shows upstream changed once the file moves at the worktree’s HEAD, and Restore upstream puts the new upstream copy back', async () => {
  const hos = await startTestDaemon();
  const repo = await repoWithEnvs();
  const project = await hos.client.createProject(repo);
  await hos.client.configSave({ repo: 'shop', path: 'CLAUDE.md', text: '# trimmed rules\n' });
  await writeFile(join(hos.dataDir, 'config', 'map.yaml'), 'version: 1\nfiles:\n  - { repo: shop, path: CLAUDE.md, tracked: true }\n');
  const stream = collect(hos.client);
  const ws = await hos.client.createWorkspace({ projectId: project.id, kind: 'worktree', branch: 'feature/upstream' });
  await stream.until(ended(ws.id));
  const state = async () => (await hos.client.configFile('shop', 'CLAUDE.md')).targets.find((t) => t.path === ws.path)!.state;
  expect(await state()).toBe('in-sync');

  git(repo, 'checkout', '-q', '-b', 'upstream-edit');
  await expect(hos.client.configApply('shop', 'CLAUDE.md', [repo])).resolves.toMatchObject({ errors: [] });
  git(repo, 'update-index', '--no-skip-worktree', '--', 'CLAUDE.md');
  await writeFile(join(repo, 'CLAUDE.md'), '# upstream rules v2\n');
  git(repo, 'commit', '-qam', 'upstream edit');
  git(ws.path, 'reset', '-q', '--soft', 'upstream-edit');
  expect(readFileSync(join(ws.path, 'CLAUDE.md'), 'utf8')).toBe('# trimmed rules\n');
  expect(await state()).toBe('upstream-changed');
  expect((await hos.client.configTree()).repos[0]!.files[0]!.drift).toBeGreaterThan(0);

  const restored = await hos.client.configRestore('shop', 'CLAUDE.md', ws.path);
  expect(readFileSync(restored.backup!, 'utf8')).toBe('# trimmed rules\n');
  expect(readFileSync(join(ws.path, 'CLAUDE.md'), 'utf8')).toBe('# upstream rules v2\n');
  expect(git(ws.path, 'ls-files', '-v', 'CLAUDE.md')).toBe('H CLAUDE.md');
  expect(await state()).toBe('not-applied');
  await expect(hos.client.configRestore('shop', 'client/.env', ws.path)).rejects.toThrow();
});

test('config_sync on the bus lists drift, commits vault edits, merges .env keys keeping worktree-only ones, copies other files whole, and never logs values', async () => {
  let vaultFile = '';
  const hos = await startTestDaemon({
    policyFile: fileURLToPath(new URL('./fixtures/policy.yaml', import.meta.url)),
    script: () => [{ tool: 'Write', input: { file_path: vaultFile, content: 'x' }, output: 'ok', ask: true }, { delta: 'Done.' }],
  });
  const repo = await repoWithEnvs();
  const project = await hos.client.createProject(repo);
  await hos.client.configImport('shop');
  const stream = collect(hos.client);
  const a = await hos.client.createWorkspace({ projectId: project.id, kind: 'worktree', branch: 'feature/a' });
  await stream.until(ended(a.id));
  const chat = await hos.client.createChat((await newTopic(hos.client, project.id, 'config')).id);
  const sync = (args: Record<string, unknown>) => callBus(hos.agentRuntime.started.filter((s) => s.chatId === chat.id).at(-1)?.bus, 'config_sync', args);
  const dir = join(hos.dataDir, 'config');
  const SECRET = 'new-secret-456';
  vaultFile = join(dir, 'shop', '.env');

  await hos.client.sendMessage(chat.id, 'edit the vault');
  await stream.until((es) => es.some((e) => e.type === 'message.completed' && e.chatId === chat.id));
  expect((await hos.client.listApprovals()).map((a) => [a.tool, a.actionClass, a.outcome])).toEqual([['Write', 'A3', 'auto']]);

  await writeFile(join(a.path, '.env'), `API_KEY=${FAKE}\nexport PORT=3000\n# a comment\nLOCAL_ONLY=1\n`);
  await writeFile(vaultFile, `API_KEY=${SECRET}\nexport PORT=3000\n# a comment\n`);
  await mkdir(join(dir, 'shop', 'config'));
  await writeFile(join(dir, 'shop', 'config', 'local.json'), '{"debug":true}\n');
  const name = basename(a.path);

  const drift = await sync({ repo: 'shop' });
  expect(drift.isError).toBe(false);
  expect(drift.output).toContain(`shop/.env: root not-applied, ${name} edited`);
  expect(drift.output).toContain('shop/config/local.json: root missing');
  expect(drift.output).toMatch(/not synced yet \(vault edits\): .*shop\/\.env/);
  expect(drift.output).not.toContain('client/.env');

  const merged = await sync({ repo: 'shop', path: '.env', to: 'all' });
  expect(merged).toMatchObject({ isError: false, output: expect.stringMatching(new RegExp(`shop/\\.env: merged into root, ${name}; backups: `)) });
  expect(readFileSync(join(repo, '.env'), 'utf8')).toBe(`API_KEY=${SECRET}\nexport PORT=3000\n# a comment\n`);
  expect(readFileSync(join(a.path, '.env'), 'utf8')).toBe(`API_KEY=${SECRET}\nexport PORT=3000\n# a comment\nLOCAL_ONLY=1\n`);
  expect(git(dir, 'log', '--format=%s')).toContain('save pending edits before sync shop');

  const copied = await sync({ repo: 'shop', path: 'config/local.json', to: ['root'] });
  expect(copied.output).toBe('shop/config/local.json: copied to root');
  expect(readFileSync(join(repo, 'config', 'local.json'), 'utf8')).toBe('{"debug":true}\n');
  expect(existsSync(join(a.path, 'config', 'local.json'))).toBe(false);
  expect(await sync({ repo: 'shop', path: '.env', to: [name] })).toMatchObject({ output: 'shop/.env: already in sync' });
  expect(await sync({ repo: 'shop', to: ['nope'] })).toMatchObject({ isError: true, output: expect.stringContaining('nope: not a worktree of shop') });
  expect((await sync({ repo: 'shop', path: '.env' })).output).toBe('No drift: every target matches hos Config.');

  const calls = stream.events.filter((e) => e.type === 'bus.call' && e.tool === 'config_sync');
  expect(calls).toHaveLength(6);
  expect(JSON.stringify(calls)).not.toMatch(new RegExp(`${SECRET}|${FAKE}|debug`));
  for (const reply of [drift, merged, copied]) expect(reply.output).not.toMatch(new RegExp(`${SECRET}|${FAKE}`));
});
