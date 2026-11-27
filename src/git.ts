import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export class GitError extends Error {}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await runGit(cwd, args)).trim();
}

async function runGit(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
  try {
    const { stdout } = await run('git', ['--no-optional-locks', ...args], {
      cwd,
      maxBuffer: 256 * 1024 * 1024,
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    return stdout;
  } catch (error) {
    const stderr = String((error as { stderr?: string }).stderr ?? '').trim();
    throw new GitError(stderr.split('\n').find((line) => line.startsWith('fatal:') || line.startsWith('error:')) ?? stderr);
  }
}

async function maybe(cwd: string, ...args: string[]): Promise<string | null> {
  return git(cwd, ...args).catch(() => null);
}

export async function repoRoot(path: string): Promise<string | null> {
  return existsSync(path) ? maybe(path, 'rev-parse', '--show-toplevel') : null;
}

export function currentBranch(repo: string): Promise<string> {
  return git(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
}

export interface WorktreeEntry {
  path: string;
  head: string | null;
  branch: string | null;
}

export async function listWorktrees(path: string): Promise<WorktreeEntry[] | null> {
  if (!existsSync(path)) return null;
  const output = await maybe(path, 'worktree', 'list', '--porcelain');
  if (output === null) return null;
  const entries: Array<WorktreeEntry & { skip: boolean }> = [];
  for (const block of output.split(/\n\n+/)) {
    const entry = { path: '', head: null as string | null, branch: null as string | null, skip: false };
    for (const line of block.split('\n')) {
      const [field, ...rest] = line.split(' ');
      const value = rest.join(' ');
      if (field === 'worktree') entry.path = value;
      else if (field === 'HEAD') entry.head = /^0+$/.test(value) ? null : value;
      else if (field === 'branch') entry.branch = value.replace(/^refs\/heads\//, '');
      else if (field === 'bare' || field === 'prunable') entry.skip = true;
    }
    if (entry.path) entries.push(entry);
  }
  if (!entries.length || entries[0]!.skip) return null;
  return entries.filter((e) => !e.skip && existsSync(e.path)).map(({ path, head, branch }) => ({ path, head, branch }));
}

export interface WorktreeStatus {
  dirty: boolean;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  unpushed: number;
}

export interface WorktreeState extends WorktreeStatus {
  head: string | null;
  branch: string | null;
}

export async function worktreeStatus(path: string, branch: string | null): Promise<WorktreeState> {
  const porcelain = (await maybe(path, 'status', '--porcelain=v2', '--branch')) ?? '';
  let head: string | null = null;
  let current: string | null = null;
  let tracked: string | null = null;
  let ahead: number | null = null;
  let behind: number | null = null;
  let dirty = false;
  for (const line of porcelain.split('\n')) {
    const value = line.split(' ').slice(2).join(' ');
    if (line.startsWith('# branch.oid ')) head = value === '(initial)' ? null : value;
    else if (line.startsWith('# branch.head ')) current = value === '(detached)' ? null : value;
    else if (line.startsWith('# branch.upstream ')) tracked = value;
    else if (line.startsWith('# branch.ab ')) [ahead, behind] = value.split(' ').map((n) => Math.abs(Number(n))) as [number, number];
    else if (line && !line.startsWith('#')) dirty = true;
  }
  const upstream = ahead === null ? null : tracked;
  const own = current ?? branch;
  const onlyHere = upstream
    ? null
    : await maybe(path, 'rev-list', '--count', 'HEAD', '--not', ...(own ? [`--exclude=${own}`] : []), '--branches', '--remotes');
  return { head, branch: current, dirty, upstream, ahead, behind, unpushed: upstream ? ahead! : Number(onlyHere ?? 0) };
}

export async function addWorktree(repo: string, path: string, branch: string, baseRef: string): Promise<void> {
  await git(repo, 'worktree', 'add', '-q', '--no-track', '-b', branch, path, baseRef);
}

export async function fetchOrigin(repo: string, timeoutMs: number, branch?: string): Promise<boolean> {
  if (!(await maybe(repo, 'remote', 'get-url', 'origin'))) return false;
  try {
    await run('git', ['fetch', '--quiet', '--no-tags', 'origin', ...(branch ? [branch] : [])], {
      cwd: repo,
      timeout: timeoutMs,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  } catch (error) {
    const stderr = String((error as { stderr?: string }).stderr ?? '').trim();
    throw new GitError(stderr || `git fetch origin timed out after ${timeoutMs / 1000}s`);
  }
  return true;
}

export async function originDefaultBranch(repo: string): Promise<string | null> {
  return (await maybe(repo, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'))?.replace(/^origin\//, '') ?? null;
}

export async function compareRef(repo: string, base: string): Promise<string> {
  if (base === 'HEAD' || base.startsWith('origin/')) return base;
  return (await maybe(repo, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`)) ? `origin/${base}` : base;
}

export async function localAhead(repo: string, branch: string, remote: string): Promise<boolean> {
  if (remote === branch || !(await maybe(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`))) return false;
  return (await maybe(repo, 'merge-base', '--is-ancestor', remote, `refs/heads/${branch}`)) !== null;
}

export async function removeWorktree(repo: string, path: string, force: boolean): Promise<void> {
  await git(repo, 'worktree', 'remove', ...(force ? ['--force'] : []), path);
}

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export async function snapshotTree(worktree: string): Promise<string> {
  const index = resolve(worktree, await git(worktree, 'rev-parse', '--git-path', 'index'));
  const temp = join(tmpdir(), `hos-index-${randomUUID()}`);
  await copyFile(index, temp).catch(() => {});
  try {
    const env = { GIT_INDEX_FILE: temp };
    await runGit(worktree, ['add', '-A'], env);
    return (await runGit(worktree, ['write-tree'], env)).trim();
  } finally {
    await rm(temp, { force: true });
  }
}

export async function resolveCommit(worktree: string, ref: string): Promise<string | null> {
  if (ref.startsWith('-')) return null;
  return maybe(worktree, 'rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`);
}

export async function mergeBase(worktree: string, a: string, b: string): Promise<string | null> {
  return maybe(worktree, 'merge-base', a, b);
}

export interface ChangedFile {
  path: string;
  oldPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
}

const STATUSES: Record<string, ChangedFile['status']> = { A: 'added', D: 'deleted', R: 'renamed', C: 'added' };

export async function changedFiles(worktree: string, from: string, to: string): Promise<ChangedFile[]> {
  const [names, counts] = await Promise.all([
    runGit(worktree, ['diff', '--no-ext-diff', '--name-status', '-z', '-M', from, to]),
    runGit(worktree, ['diff', '--no-ext-diff', '--numstat', '-z', '-M', from, to]),
  ]);
  const nameTokens = names.split('\0');
  const countTokens = counts.split('\0');
  const files: ChangedFile[] = [];
  while (nameTokens.length > 1 && nameTokens[0]) {
    const code = nameTokens.shift()!;
    const twoPaths = code.startsWith('R') || code.startsWith('C');
    const oldPath = twoPaths ? nameTokens.shift()! : undefined;
    const path = nameTokens.shift()!;
    const [additions, deletions] = countTokens.shift()!.split('\t');
    if (twoPaths) countTokens.splice(0, 2);
    files.push({
      path,
      ...(code.startsWith('R') ? { oldPath } : {}),
      status: STATUSES[code[0]!] ?? 'modified',
      additions: Number(additions) || 0,
      deletions: Number(deletions) || 0,
    });
  }
  return files;
}

export async function patchBetween(worktree: string, from: string, to: string): Promise<string> {
  return runGit(worktree, [
    'diff',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '-M',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    from,
    to,
  ]);
}

export async function discardChanges(worktree: string, paths: string[]): Promise<void> {
  for (const path of paths) {
    if ((await maybe(worktree, 'cat-file', '-e', `HEAD:${path}`)) !== null) {
      await git(worktree, '--literal-pathspecs', 'restore', '--source=HEAD', '--staged', '--worktree', '--', path);
    } else {
      await git(worktree, '--literal-pathspecs', 'rm', '-q', '--cached', '--ignore-unmatch', '--', path);
      await rm(join(worktree, path), { force: true });
    }
  }
}

export async function commitAll(worktree: string, message: string): Promise<string> {
  await git(worktree, 'add', '-A');
  await git(worktree, 'commit', '-q', '-m', message);
  return git(worktree, 'log', '-1', '--format=%h %s');
}

export async function mergeBranch(worktree: string, branch: string): Promise<string> {
  try {
    await git(worktree, 'merge', '-q', '--no-ff', '--no-edit', branch);
  } catch (error) {
    const conflicts = await maybe(worktree, 'diff', '--name-only', '--diff-filter=U');
    await maybe(worktree, 'merge', '--abort');
    throw new GitError(conflicts ? `merge conflicts in ${conflicts.split('\n').join(', ')}; the merge was aborted` : (error as Error).message);
  }
  return git(worktree, 'log', '-1', '--format=%h %s');
}

export async function pushAndOpenPullRequest(worktree: string, branch: string, ghBin: string): Promise<string> {
  await git(worktree, 'push', '-q', '-u', 'origin', branch);
  try {
    const { stdout } = await run(ghBin, ['pr', 'create', '--fill', '--head', branch], { cwd: worktree });
    return stdout.trim();
  } catch (error) {
    throw new GitError(String((error as { stderr?: string }).stderr ?? (error as Error).message).trim());
  }
}

export async function bundleBranch(worktree: string, branch: string, file: string): Promise<string> {
  await git(worktree, 'bundle', 'create', '-q', file, `refs/heads/${branch}`);
  return git(worktree, 'rev-parse', `refs/heads/${branch}`);
}

export async function fetchBundle(worktree: string, file: string, ref: string): Promise<string> {
  await git(worktree, 'fetch', '-q', '--no-tags', '--no-write-fetch-head', file, `+HEAD:${ref}`);
  return git(worktree, 'rev-parse', ref);
}

export async function addTrailer(worktree: string, base: string, head: string, ref: string, trailer: string): Promise<string> {
  const commits = (await git(worktree, 'rev-list', '--reverse', '--topo-order', `${base}..${head}`)).split('\n').filter(Boolean);
  const rewritten = new Map<string, string>();
  for (const commit of commits) {
    const [tree, parents, ...who] = (await git(worktree, 'show', '-s', '--format=%T%n%P%n%an%n%ae%n%aI%n%cn%n%ce%n%cI', commit)).split('\n');
    const [authorName, authorEmail, authorDate, committerName, committerEmail, committerDate] = who as [string, string, string, string, string, string];
    const message = (await runGit(worktree, ['show', '-s', '--format=%B', commit])).trimEnd();
    const body = message.split('\n').includes(trailer) ? message : `${message}\n\n${trailer}`;
    const parentArgs = parents!.split(' ').filter(Boolean).flatMap((parent) => ['-p', rewritten.get(parent) ?? parent]);
    const env = {
      GIT_AUTHOR_NAME: authorName,
      GIT_AUTHOR_EMAIL: authorEmail,
      GIT_AUTHOR_DATE: authorDate,
      GIT_COMMITTER_NAME: committerName,
      GIT_COMMITTER_EMAIL: committerEmail,
      GIT_COMMITTER_DATE: committerDate,
    };
    rewritten.set(commit, (await runGit(worktree, ['commit-tree', tree!, ...parentArgs, '-m', body], env)).trim());
  }
  const tip = rewritten.get(head) ?? head;
  await git(worktree, 'update-ref', ref, tip);
  return tip;
}

export async function countCommits(worktree: string, from: string, to: string): Promise<number> {
  return Number(await git(worktree, 'rev-list', '--count', `${from}..${to}`));
}
export async function renameBranch(worktree: string, from: string, to: string): Promise<void> {
  await git(worktree, 'check-ref-format', '--branch', to);
  await git(worktree, 'branch', '-m', from, to);
}

export async function moveWorktree(repo: string, from: string, to: string): Promise<void> {
  await git(repo, 'worktree', 'move', from, to);
}

export async function deleteBranch(repo: string, branch: string): Promise<void> {
  await git(repo, 'branch', '-D', branch);
}
export async function pushBranch(worktree: string, branch: string): Promise<string> {
  await git(worktree, 'push', '-q', '-u', 'origin', branch);
  return `Pushed ${branch} to origin`;
}

export async function pullFastForward(worktree: string): Promise<string> {
  const before = await git(worktree, 'rev-parse', 'HEAD');
  await git(worktree, 'pull', '-q', '--ff-only');
  const after = await git(worktree, 'rev-parse', 'HEAD');
  return before === after ? 'Already up to date' : `Pulled ${await countCommits(worktree, before, after)} commit(s)`;
}

// A missing gh, no remote or any gh failure means "no PR known", never an error.
export async function openPullRequestNumber(worktree: string, branch: string, ghBin: string): Promise<number | null> {
  try {
    const { stdout } = await run(ghBin, ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number'], {
      cwd: worktree,
      timeout: 10_000,
      env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
    });
    const rows = JSON.parse(stdout) as unknown;
    if (!Array.isArray(rows)) return null;
    const numbers = rows.map((row) => (row as { number?: unknown }).number).filter((n): n is number => typeof n === 'number');
    return numbers.sort((a, b) => a - b)[0] ?? null;
  } catch {
    return null;
  }
}
