import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { git as gitSync, isGitRepo } from './cli/common.js';
import { adoptBrain, setOwner, STARTER_URL } from './cli/init.js';
import { HosError } from './core.js';
import { validTimezone } from './owner.js';
import type { BrainRequest, FirstRunState } from './api/types.js';

const run = promisify(execFile);

export const DEFAULT_STARTER = STARTER_URL;
export const BRAIN_PATH_FILE = 'brain-path';

export type BrainSource = BrainRequest['from'];

export interface SetupOptions {
  defaultBrain: string;
  starter: string;
  dataDir: string;
  onBrain(path: string): void;
}

export function expandHome(path: string, home = homedir()): string {
  const trimmed = path.trim();
  if (trimmed === '~') return home;
  if (trimmed.startsWith('~/')) return join(home, trimmed.slice(2));
  return isAbsolute(trimmed) ? trimmed : resolve(trimmed);
}

export function setupInfo(options: Pick<SetupOptions, 'defaultBrain' | 'starter'> | undefined): FirstRunState {
  if (!options) return { needed: false };
  return {
    needed: true,
    defaultBrain: options.defaultBrain,
    starter: options.starter,
    commands: [`hos init --adopt ${options.defaultBrain}${options.starter === STARTER_URL ? '' : ` --starter ${options.starter}`}`, `hos --brain ${options.defaultBrain}`],
  };
}

export function rememberedBrain(dataDir: string): string | undefined {
  try {
    const path = readFileSync(join(dataDir, BRAIN_PATH_FILE), 'utf8').trim();
    return path || undefined;
  } catch {
    return undefined;
  }
}

async function git(args: string[], cwd?: string): Promise<void> {
  try {
    await run('git', args, { ...(cwd ? { cwd } : {}), timeout: 120_000 });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new HosError(400, `git ${args[0]} failed: ${stderr || (error as Error).message}`);
  }
}

function emptyOrMissing(path: string): boolean {
  return !existsSync(path) || readdirSync(path).length === 0;
}

function gitUrl(value: string | undefined, what: string): string {
  const url = value?.trim() ?? '';
  if (!url || /\s/.test(url) || url.startsWith('-')) throw new HosError(400, `${what} must be a git URL or a folder path`);
  return url;
}

export interface CreatedBrain {
  path: string;
  lines: string[];
}

export async function createBrain(request: BrainRequest, options: Pick<SetupOptions, 'starter' | 'dataDir'>): Promise<CreatedBrain> {
  if (!request.path?.trim()) throw new HosError(400, 'say where the brain goes');
  const path = expandHome(request.path);
  const name = request.name?.trim() || undefined;
  const timezone = request.timezone?.trim() || undefined;
  if (name && (name.length > 60 || /[\n\r]/.test(name))) throw new HosError(400, 'a name is at most 60 characters on one line');
  if (timezone && !validTimezone(timezone)) throw new HosError(400, `${timezone} is not a time zone; use one like Europe/Berlin`);
  const lines: string[] = [];
  if (request.from === 'existing') {
    if (!existsSync(join(path, 'hos'))) throw new HosError(400, `${path} has no hos/ folder, so it is not a hos brain`);
    if (name || timezone) {
      lines.push(...setOwner(path, name, timezone));
      lines.push(...commit(path, 'hos: owner name and time zone from first run', ['hos/policy.yaml', 'shared/USER.md']));
    }
  } else if (request.from === 'starter' || request.from === 'clone') {
    if (!emptyOrMissing(path)) throw new HosError(409, `${path} already has files; pick an empty folder, or choose “Use a brain I already have”`);
    if (existsSync(path)) rmdirSync(path);
    const remote = request.from === 'starter' && request.remote?.trim() ? gitUrl(request.remote, 'your private repo') : undefined;
    if (request.from === 'clone') {
      mkdirSync(dirname(path), { recursive: true });
      await git(['clone', '--quiet', '--', gitUrl(request.url, 'your brain’s repo'), path]);
    }
    const adopted = adoptBrain({ dir: path, starter: options.starter, ...(remote ? { origin: remote } : {}), ...(name ? { name } : {}), ...(timezone ? { timezone } : {}) });
    if (!adopted.ok) throw new HosError(400, `the new brain at ${path} did not pass: ${adopted.lines.filter((line) => /^(FAIL|git|--)/.test(line)).join('; ') || adopted.lines.at(-1)}`);
    lines.push(...adopted.lines.filter((line) => !/^(Next:|\s)/.test(line) && line));
    lines.push(...commit(path, 'Make this brain mine'));
  } else {
    throw new HosError(400, 'from must be starter, existing or clone');
  }
  mkdirSync(options.dataDir, { recursive: true });
  writeFileSync(join(options.dataDir, BRAIN_PATH_FILE), `${path}\n`);
  return { path, lines };
}

function commit(dir: string, message: string, files?: string[]): string[] {
  if (!isGitRepo(dir)) return [`warn    ${dir} is not a git repo, so nothing was committed`];
  const paths = files ? files.filter((file) => existsSync(join(dir, file))) : [];
  const added = gitSync(dir, 'add', ...(files ? ['--', ...paths] : ['-A']));
  if (!added.ok) return [`warn    git add failed: ${added.err}`];
  if (gitSync(dir, 'diff', '--cached', '--quiet').ok) return [];
  const done = gitSync(dir, 'commit', '-q', '-m', message, ...(files ? ['--', ...paths] : []));
  return done.ok ? [`commit  ${message}`] : [`warn    git commit failed (${done.err}); commit the brain yourself before hos brain update`];
}
