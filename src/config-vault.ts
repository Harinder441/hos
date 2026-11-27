import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { appendFile, chmod, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { parse } from 'yaml';
import type { ConfigApplied, ConfigFile, ConfigFileSummary, ConfigPreview, ConfigSave, ConfigTarget, ConfigTargetState, ConfigTree } from './api/types.js';

export interface ConfigDrift {
  files: Array<{ repo: string; path: string; targets: Array<{ name: string; state: ConfigTargetState }> }>;
  pending: string[];
}

export interface ConfigSynced {
  files: Array<{ path: string; merged: boolean; applied: string[]; backups: string[]; errors: string[] }>;
}
import { HosError } from './core.js';
import { listWorktrees } from './git.js';

const run = promisify(execFile);

const REPO = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const ENV_LINE = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_.-]*)(\s*=)(.*)$/;
const TEMPLATE = /\.(example|sample|template)$/i;
const MAP_FILE = 'map.yaml';
const APPLIED_FILE = '.applied.json';
const UPSTREAM_FILE = '.upstream.json';
const BACKUPS = '.overwritten';
const GIT_ID = ['-c', 'user.name=hos', '-c', 'user.email=hos@localhost', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null'];

export interface ConfigProject {
  key: string | null;
  path: string;
}

interface MapEntry {
  tracked: boolean;
  exclude: boolean;
}

type Applied = Record<string, Record<string, string>>;

export const repoKey = (project: ConfigProject): string => project.key ?? basename(project.path);

const isEnv = (path: string) => basename(path).startsWith('.env');
const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

function checkRepo(repo: unknown): string {
  if (typeof repo !== 'string' || !REPO.test(repo) || repo === MAP_FILE) throw new HosError(400, 'repo must be a repo name like web-app');
  return repo;
}

function checkPath(path: unknown): string {
  if (typeof path !== 'string' || !path || isAbsolute(path) || path.includes('\\')) throw new HosError(400, 'path must be relative to the repo, like .env or client/.env');
  const parts = path.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..' || p === '.git')) throw new HosError(400, `${path} is not a usable path inside a repo`);
  return path;
}

function envKeys(text: string): Map<string, string> {
  const keys = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = ENV_LINE.exec(line);
    if (m) keys.set(m[2]!, m[4]!);
  }
  return keys;
}

function editEnv(text: string, set: Record<string, string>, remove: string[]): string {
  const pending = new Map(Object.entries(set));
  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    const m = ENV_LINE.exec(line);
    if (m && remove.includes(m[2]!)) continue;
    if (m && pending.has(m[2]!)) {
      out.push(`${m[1]}${m[2]}${m[3]}${pending.get(m[2]!)}`);
      pending.delete(m[2]!);
    } else out.push(line);
  }
  for (const [name, value] of pending) out.push(`${name}=${value}`);
  return out.length ? `${out.join('\n')}\n` : '';
}

function changes(central: string | null, disk: string | null, env: boolean): ConfigPreview['changes'] {
  const out: ConfigPreview['changes'] = [];
  if (env) {
    const want = envKeys(central ?? '');
    const have = envKeys(disk ?? '');
    for (const [name, value] of want) {
      if (!have.has(name)) out.push({ name, change: 'added' });
      else if (have.get(name) !== value) out.push({ name, change: 'changed' });
    }
    for (const name of have.keys()) if (!want.has(name)) out.push({ name, change: 'removed' });
    return out;
  }
  const want = new Set((central ?? '').split('\n').filter(Boolean));
  const have = new Set((disk ?? '').split('\n').filter(Boolean));
  for (const line of want) if (!have.has(line)) out.push({ name: line, change: 'added' });
  for (const line of have) if (!want.has(line)) out.push({ name: line, change: 'removed' });
  return out;
}

async function readOrNull(path: string): Promise<Buffer | null> {
  return readFile(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'EISDIR') return null;
    throw error;
  });
}

async function writePrivate(path: string, data: Buffer | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, data, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await run('git', ['--no-optional-locks', ...args], { cwd })).stdout;
}

export class ConfigVault {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly dir: string,
    private readonly projects: () => ConfigProject[],
    private readonly now: () => number,
  ) {}

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  private root(repo: string): string | null {
    return this.projects().find((p) => repoKey(p) === repo)?.path ?? null;
  }

  private file(repo: string, path: string): string {
    return join(this.dir, checkRepo(repo), checkPath(path));
  }

  private map(): { entries: Map<string, MapEntry>; errors: string[] } {
    const entries = new Map<string, MapEntry>();
    const file = join(this.dir, MAP_FILE);
    if (!existsSync(file)) return { entries, errors: [] };
    try {
      const parsed = parse(readFileSync(file, 'utf8')) as { files?: Array<Record<string, unknown>> } | null;
      for (const entry of parsed?.files ?? []) {
        if (typeof entry.repo !== 'string' || typeof entry.path !== 'string') continue;
        entries.set(`${entry.repo}/${entry.path}`, { tracked: entry.tracked === true, exclude: entry.exclude === true });
      }
      return { entries, errors: [] };
    } catch (error) {
      return { entries, errors: [`${MAP_FILE}: ${(error as Error).message}`] };
    }
  }

  private options(repo: string, path: string): MapEntry {
    return this.map().entries.get(`${repo}/${path}`) ?? { tracked: false, exclude: false };
  }

  private async applied(): Promise<Applied> {
    const data = await readOrNull(join(this.dir, APPLIED_FILE));
    return data ? (JSON.parse(data.toString('utf8')) as Applied) : {};
  }

  private async saveApplied(applied: Applied): Promise<void> {
    await writePrivate(join(this.dir, APPLIED_FILE), `${JSON.stringify(applied, null, 2)}\n`);
  }

  private async upstream(): Promise<Applied> {
    const data = await readOrNull(join(this.dir, UPSTREAM_FILE));
    return data ? (JSON.parse(data.toString('utf8')) as Applied) : {};
  }

  private async recordUpstream(repo: string, path: string, worktrees: string[]): Promise<void> {
    if (!worktrees.length) return;
    const upstream = await this.upstream();
    const records = (upstream[`${repo}/${path}`] ??= {});
    for (const worktree of worktrees) {
      const blob = await headBlob(worktree, path);
      if (blob) records[worktree] = blob;
      else delete records[worktree];
    }
    await writePrivate(join(this.dir, UPSTREAM_FILE), `${JSON.stringify(upstream, null, 2)}\n`);
  }

  private async ensureRepo(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
    if (existsSync(join(this.dir, '.git'))) return;
    await git(this.dir, 'init', '-q');
    await writeFile(join(this.dir, '.gitignore'), `${BACKUPS}/\n`);
  }

  private async commit(message: string): Promise<void> {
    await git(this.dir, 'add', '-A');
    if (!(await git(this.dir, 'status', '--porcelain')).trim()) return;
    await git(this.dir, ...GIT_ID, 'commit', '-q', '-m', message);
  }

  private async files(repo: string): Promise<string[]> {
    const base = join(this.dir, repo);
    if (!existsSync(base)) return [];
    const found = await readdir(base, { recursive: true, withFileTypes: true });
    return found
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name).slice(base.length + 1).split('\\').join('/'))
      .sort();
  }

  private async targets(repo: string): Promise<Array<Omit<ConfigTarget, 'state'>>> {
    const root = this.root(repo);
    if (!root) return [];
    const entries = (await listWorktrees(root)) ?? [];
    return entries.map((entry, index) => ({
      path: entry.path,
      name: index === 0 ? 'root' : basename(entry.path),
      kind: index === 0 ? 'root' : entry.path.includes('/conductor/workspaces/') ? 'conductor' : 'worktree',
      branch: entry.branch,
    }));
  }

  private async states(repo: string, path: string, applied: Applied): Promise<ConfigTarget[]> {
    const central = await readOrNull(this.file(repo, path));
    const want = central ? sha(central) : null;
    const records = applied[`${repo}/${path}`] ?? {};
    const blobs = (await this.upstream())[`${repo}/${path}`] ?? {};
    return Promise.all(
      (await this.targets(repo)).map(async (target) => {
        const disk = await readOrNull(join(target.path, path));
        const have = disk ? sha(disk) : null;
        const recorded = blobs[target.path];
        const moved = recorded !== undefined && (await headBlob(target.path, path)) !== recorded;
        const state: ConfigTargetState = !have
          ? 'missing'
          : moved
            ? 'upstream-changed'
            : have === want
              ? 'in-sync'
              : have === records[target.path]
                ? 'not-applied'
                : 'edited';
        return { ...target, state };
      }),
    );
  }

  async tree(): Promise<ConfigTree> {
    const { entries, errors } = this.map();
    const applied = await this.applied();
    const repos: ConfigTree['repos'] = [];
    const dirs = existsSync(this.dir) ? await readdir(this.dir, { withFileTypes: true }) : [];
    for (const entry of dirs.filter((d) => d.isDirectory() && REPO.test(d.name)).sort((a, b) => a.name.localeCompare(b.name))) {
      const repo = entry.name;
      const files: ConfigFileSummary[] = [];
      for (const path of await this.files(repo)) {
        const targets = await this.states(repo, path, applied);
        const options = entries.get(`${repo}/${path}`);
        files.push({
          path,
          env: isEnv(path),
          tracked: options?.tracked ?? false,
          exclude: options?.exclude ?? false,
          drift: targets.filter((t) => t.state !== 'in-sync').length,
          targets: targets.length,
        });
      }
      repos.push({ repo, root: this.root(repo), files });
    }
    const projects = this.projects()
      .map((p) => ({ repo: repoKey(p), root: p.path }))
      .filter((p) => REPO.test(p.repo))
      .sort((a, b) => a.repo.localeCompare(b.repo));
    return { dir: this.dir, repos, projects, errors };
  }

  async read(repo: string, path: string): Promise<ConfigFile> {
    const data = await readOrNull(this.file(repo, path));
    if (!data) throw new HosError(404, `${repo}/${path} is not in hos Config`);
    const text = data.toString('utf8');
    const env = isEnv(path);
    return {
      repo,
      path,
      env,
      tracked: this.options(repo, path).tracked,
      keys: env ? [...envKeys(text)].map(([name, value]) => ({ name, length: value.length })) : null,
      text: env ? null : text,
      targets: await this.states(repo, path, await this.applied()),
    };
  }

  async reveal(repo: string, path: string, key: string): Promise<{ value: string }> {
    const data = await readOrNull(this.file(repo, path));
    const value = data && isEnv(path) ? envKeys(data.toString('utf8')).get(key) : undefined;
    if (value === undefined) throw new HosError(404, `${key} is not in ${repo}/${path}`);
    return { value };
  }

  save(input: ConfigSave): Promise<ConfigFile> {
    return this.serial(async () => {
      const file = this.file(input.repo, input.path);
      const current = await readOrNull(file);
      let next: string;
      if (input.text !== undefined) {
        if (typeof input.text !== 'string') throw new HosError(400, 'text must be a string');
        if (current && isEnv(input.path)) throw new HosError(400, 'edit an existing env file key by key, so its values never go to the browser');
        next = input.text;
      } else {
        if (!isEnv(input.path)) throw new HosError(400, 'only env files are edited key by key; send text');
        const set = input.set ?? {};
        const remove = input.remove ?? [];
        for (const [name, value] of Object.entries(set)) {
          if (!KEY.test(name)) throw new HosError(400, `${name} is not a valid env key`);
          if (typeof value !== 'string' || /[\r\n]/.test(value)) throw new HosError(400, `the value of ${name} must be one line`);
        }
        next = editEnv(current?.toString('utf8') ?? '', set, remove);
      }
      await this.ensureRepo();
      await writePrivate(file, next);
      await this.commit(`save ${input.repo}/${input.path}`);
      return this.read(input.repo, input.path);
    });
  }

  remove(repo: string, path: string): Promise<{ ok: true }> {
    return this.serial(async () => {
      const file = this.file(repo, path);
      if (!existsSync(file)) throw new HosError(404, `${repo}/${path} is not in hos Config`);
      await rm(file);
      const applied = await this.applied();
      delete applied[`${repo}/${path}`];
      await this.saveApplied(applied);
      await this.commit(`remove ${repo}/${path}`);
      return { ok: true as const };
    });
  }

  private async picked(repo: string, path: string, wanted: unknown): Promise<ConfigTarget[]> {
    if (!Array.isArray(wanted) || !wanted.length || wanted.some((t) => typeof t !== 'string')) throw new HosError(400, 'targets must list worktree paths');
    const all = await this.states(repo, path, await this.applied());
    return (wanted as string[]).map((path) => {
      const target = all.find((t) => t.path === path);
      if (!target) throw new HosError(400, `${path} is not a worktree of ${repo}`);
      return target;
    });
  }

  async preview(repo: string, path: string, wanted: unknown): Promise<ConfigPreview[]> {
    const central = await readOrNull(this.file(repo, path));
    if (!central) throw new HosError(404, `${repo}/${path} is not in hos Config`);
    const targets = await this.picked(repo, path, wanted);
    return Promise.all(
      targets.map(async (target) => {
        const disk = await readOrNull(join(target.path, path));
        return {
          target: target.path,
          state: target.state,
          changes: changes(central.toString('utf8'), disk?.toString('utf8') ?? null, isEnv(path)),
          backup: target.state === 'edited',
        };
      }),
    );
  }

  apply(repo: string, path: string, wanted: unknown): Promise<ConfigApplied> {
    return this.serial(async () => this.write(repo, path, await this.picked(repo, path, wanted), false));
  }

  private async write(repo: string, path: string, targets: ConfigTarget[], merge: boolean): Promise<ConfigApplied> {
    const central = await readOrNull(this.file(repo, path));
    if (!central) throw new HosError(404, `${repo}/${path} is not in hos Config`);
    const want = envKeys(central.toString('utf8'));
    const options = this.options(repo, path);
    const applied = await this.applied();
    const records = (applied[`${repo}/${path}`] ??= {});
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const result: ConfigApplied = { applied: [], backups: [], errors: [] };
    for (const target of targets) {
      const dest = join(target.path, path);
      try {
        const disk = merge ? ((await readOrNull(dest))?.toString('utf8') ?? '') : '';
        const have = envKeys(disk);
        const next = merge ? editEnv(disk, Object.fromEntries([...want].filter(([name, value]) => have.get(name) !== value)), []) : central;
        if (merge && next === disk) continue;
        if (target.state === 'edited') {
          const backup = join(this.dir, BACKUPS, day, repo, target.name, path);
          await writePrivate(backup, (await readFile(dest)) as Buffer);
          result.backups.push(backup);
        }
        await writePrivate(dest, next);
        records[target.path] = sha(next);
        result.applied.push(target.path);
        if (options.tracked) await this.skipWorktree(target.path, path, result.errors);
        if (options.exclude) await this.exclude(target.path, path);
      } catch (error) {
        result.errors.push(`${target.name}: ${(error as Error).message}`);
      }
    }
    await this.saveApplied(applied);
    if (options.tracked) await this.recordUpstream(repo, path, result.applied);
    await this.commit(`apply ${repo}/${path} to ${result.applied.length}`);
    return result;
  }

  async drift(repo: string, path?: string): Promise<ConfigDrift> {
    checkRepo(repo);
    const applied = await this.applied();
    const files: ConfigDrift['files'] = [];
    for (const file of path ? [checkPath(path)] : await this.files(repo)) {
      const central = await readOrNull(this.file(repo, file));
      if (!central) continue;
      const targets = [];
      for (const target of await this.states(repo, file, applied)) {
        if (target.state === 'in-sync') continue;
        if (isEnv(file) && target.state !== 'missing' && (await this.envMerged(central, join(target.path, file)))) continue;
        targets.push({ name: target.name, state: target.state });
      }
      if (targets.length) files.push({ repo, path: file, targets });
    }
    const pending = existsSync(join(this.dir, '.git')) ? (await git(this.dir, 'status', '--porcelain')).split('\n').map((l) => l.slice(3)).filter((p) => p.startsWith(`${repo}/`)) : [];
    return { files, pending };
  }

  private async envMerged(central: Buffer, dest: string): Promise<boolean> {
    const have = envKeys((await readOrNull(dest))?.toString('utf8') ?? '');
    return [...envKeys(central.toString('utf8'))].every(([name, value]) => have.get(name) === value);
  }

  sync(repo: string, path: string | undefined, to: 'root' | 'all' | string[]): Promise<ConfigSynced> {
    return this.serial(async () => {
      checkRepo(repo);
      const paths = path ? [checkPath(path)] : await this.files(repo);
      if (!paths.length) throw new HosError(404, `${repo}${path ? `/${path}` : ''} is not in hos Config`);
      await this.ensureRepo();
      await this.commit(`save pending edits before sync ${repo}`);
      const all = await this.targets(repo);
      if (!all.length) throw new HosError(404, `hos has no repo ${repo}, so there is nowhere to sync to`);
      const names = to === 'all' ? all.map((t) => t.name) : to === 'root' ? ['root'] : to;
      const unknown = names.filter((n) => !all.some((t) => t.name === n || t.branch === n));
      if (unknown.length) throw new HosError(400, `${unknown.join(', ')}: not a worktree of ${repo}; pick from ${all.map((t) => t.name).join(', ')}`);
      const files: ConfigSynced['files'] = [];
      for (const file of paths) {
        const states = await this.states(repo, file, await this.applied());
        const targets = states.filter((t) => names.some((n) => t.name === n || t.branch === n));
        const result = await this.write(repo, file, targets, isEnv(file));
        const named = (p: string) => states.find((t) => t.path === p)?.name ?? p;
        files.push({ path: file, merged: isEnv(file), applied: result.applied.map(named), backups: result.backups, errors: result.errors });
      }
      return { files };
    });
  }

  restore(repo: string, path: string, target: unknown): Promise<{ restored: string; backup: string | null }> {
    return this.serial(async () => {
      const [picked] = await this.picked(repo, path, [target]);
      const worktree = picked!.path;
      if (!(await headBlob(worktree, path))) throw new HosError(400, `${path} is not tracked in ${picked!.name}, so there is no upstream copy to restore`);
      const dest = join(worktree, path);
      const old = await readOrNull(dest);
      const backup = old ? join(this.dir, BACKUPS, new Date(this.now()).toISOString().slice(0, 10), repo, picked!.name, path) : null;
      if (backup) await writePrivate(backup, old!);
      await git(worktree, 'update-index', '--no-skip-worktree', '--', path);
      await git(worktree, 'checkout', 'HEAD', '--', path);
      const applied = await this.applied();
      (applied[`${repo}/${path}`] ??= {})[worktree] = sha(await readFile(dest));
      await this.saveApplied(applied);
      const upstream = await this.upstream();
      delete upstream[`${repo}/${path}`]?.[worktree];
      await writePrivate(join(this.dir, UPSTREAM_FILE), `${JSON.stringify(upstream, null, 2)}\n`);
      await this.commit(`restore upstream ${repo}/${path} in ${picked!.name}`);
      return { restored: worktree, backup };
    });
  }

  private async skipWorktree(worktree: string, path: string, errors: string[]): Promise<void> {
    await git(worktree, 'update-index', '--skip-worktree', '--', path).catch(() => errors.push(`${basename(worktree)}: ${path} is not tracked there, so skip-worktree was not set`));
  }

  private async exclude(worktree: string, path: string): Promise<void> {
    const common = resolve(worktree, (await git(worktree, 'rev-parse', '--git-common-dir')).trim());
    const file = join(common, 'info', 'exclude');
    const current = (await readOrNull(file))?.toString('utf8') ?? '';
    if (current.split('\n').includes(`/${path}`)) return;
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${current && !current.endsWith('\n') ? '\n' : ''}/${path}\n`);
  }

  seed(project: ConfigProject, worktree: string): Promise<string[]> {
    return this.serial(async () => {
      const repo = repoKey(project);
      if (!REPO.test(repo)) return [];
      const files = await this.files(repo);
      if (!files.length) return [];
      const applied = await this.applied();
      const seeded: string[] = [];
      for (const path of files) {
        const options = this.options(repo, path);
        const dest = join(worktree, path);
        if (existsSync(dest) && !options.tracked) continue;
        const central = await readFile(this.file(repo, path));
        await writePrivate(dest, central);
        (applied[`${repo}/${path}`] ??= {})[worktree] = sha(central);
        seeded.push(path);
        if (options.tracked) await this.skipWorktree(worktree, path, []);
        if (options.exclude) await this.exclude(worktree, path).catch(() => {});
      }
      if (seeded.length) await this.saveApplied(applied);
      for (const path of seeded) if (this.options(repo, path).tracked) await this.recordUpstream(repo, path, [worktree]);
      return seeded;
    });
  }

  importRoot(repo: string): Promise<{ imported: string[] }> {
    return this.serial(async () => {
      const root = this.root(checkRepo(repo));
      if (!root) throw new HosError(404, `hos has no repo ${repo}`);
      const tracked = new Set((await git(root, 'ls-files', '-z')).split('\0'));
      const paths = (await envFiles(root)).filter((p) => !tracked.has(p) && !TEMPLATE.test(p)).sort();
      await this.ensureRepo();
      const applied = await this.applied();
      const imported: string[] = [];
      for (const path of paths) {
        const file = this.file(repo, path);
        if (existsSync(file)) continue;
        const data = await readFile(join(root, path));
        await writePrivate(file, data);
        const records = (applied[`${repo}/${path}`] ??= {});
        for (const target of await this.targets(repo)) {
          const disk = await readOrNull(join(target.path, path));
          if (disk && sha(disk) === sha(data)) records[target.path] = sha(data);
        }
        imported.push(path);
      }
      await this.saveApplied(applied);
      await this.commit(`import ${repo} from its root checkout`);
      return { imported };
    });
  }
}

async function headBlob(worktree: string, path: string): Promise<string | null> {
  return git(worktree, 'rev-parse', '-q', '--verify', `HEAD:${path}`).then((out) => out.trim() || null, () => null);
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'vendor', 'coverage']);
const SCAN_DEPTH = 4;

async function envFiles(root: string, sub = '', depth = 0): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(join(root, sub), { withFileTypes: true }).catch(() => [])) {
    const path = sub ? `${sub}/${entry.name}` : entry.name;
    if (entry.isFile() && isEnv(entry.name)) found.push(path);
    else if (entry.isDirectory() && depth < SCAN_DEPTH && !SKIP_DIRS.has(entry.name)) found.push(...(await envFiles(root, path, depth + 1)));
  }
  return found;
}
