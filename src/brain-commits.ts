import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readdir, rename, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Chat, EventBody, StatusItem } from './api/types.js';
import { commitIdentityRefusal } from './commit-identity.js';
import { EDIT_TOOL_FIELDS } from './harnesses/tools.js';
import { localStamp, META_DIR, parseProgress, PROGRESS_FILE, REQUIRED_SECTIONS, sectionOf } from './work.js';

const run = promisify(execFile);
const oneLine = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim();

const EDIT_FIELDS = EDIT_TOOL_FIELDS;
const MAX_BYTES = 5 * 1024 * 1024;
// Copied from the brain's .claude/hooks/auto-commit.sh secret guard.
const SECRET_RULES: Array<[string, RegExp]> = [
  ['aws-access-key', /AKIA[0-9A-Z]{16}/],
  ['github-token', /gh[pousr]_[A-Za-z0-9]{36}/],
  ['github-pat', /github_pat_[A-Za-z0-9_]{22,}/],
  ['sk-api-key', /(^|[^A-Za-z0-9-])sk-(ant-|proj-)?[A-Za-z0-9_-]{20,}/],
  ['slack-token', /xox[baprs]-[A-Za-z0-9-]{10,}/],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY/],
  ['age-secret-key', /AGE-SECRET-KEY-1[0-9A-Z]{58}/],
  ['db-url-password', /(mongodb(\+srv)?|postgres(ql)?|mysql|redis|amqp):\/\/[^/\s:<]+:[^@\s<]+@/],
];
const OLD_PATHS = [/^artifacts\/\d{4}-\d{2}\//, /^artifacts\/handoff\//, /^plans\//, /^status\//];
const PUSH_EVERY_MS = 60_000;
const IDLE_SYNC_MS = 5 * 60_000;
const SYNC_RETRY_MS = 2_000;
export const MOVED_TSV = 'work/_meta/MOVED.tsv';

export interface BrainCommitDeps {
  brainDir: string;
  logFile: string;
  host: string;
  record(body: EventBody): void;
  busy(): boolean;
  topicTitle(chat: Chat): string;
  cwd(chat: Chat): string;
  now(): number;
  setTimeout(fn: () => void, ms: number): () => void;
  workRoot(): string;
  ownsWorkDir(folder: string, chatId: string | null): boolean;
  awaitsCheckpoint(path: string): boolean;
  warn(chatId: string | null, text: string): void;
  alert(title: string, detail: string): void;
}

export class BrainCommits {
  private readonly touched = new Map<string, Set<string>>();
  private readonly claimed = new Set<string>();
  private readonly skills = new Map<string, string>();
  private readonly leftOut = new Map<string, { rule: string; since: number }>();
  private queue: Promise<void> = Promise.resolve();
  private pushArmed = false;
  private paused = false;
  private cancelIdle: (() => void) | null = null;

  constructor(private readonly deps: BrainCommitDeps) {}

  start(): void {
    const idle = () => {
      this.cancelIdle = this.deps.setTimeout(() => {
        void this.enqueue(() => this.sync()).finally(() => this.cancelIdle && idle());
      }, IDLE_SYNC_MS);
    };
    idle();
  }

  stop(): void {
    const cancel = this.cancelIdle;
    this.cancelIdle = null;
    cancel?.();
  }

  toolStarted(chat: Chat, tool: string, input: unknown): void {
    if (tool === 'Skill') {
      const skill = ((input ?? {}) as Record<string, unknown>).skill;
      if (typeof skill === 'string' && skill) this.skills.set(chat.id, skill);
      return;
    }
    const field = EDIT_FIELDS[tool];
    const path = field ? ((input ?? {}) as Record<string, unknown>)[field] : undefined;
    if (typeof path !== 'string' || !path) return;
    const rel = relative(this.deps.brainDir, resolve(this.deps.cwd(chat), path));
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.split(/[\\/]/)[0] === '.git') return;
    const files = this.touched.get(chat.id) ?? new Set<string>();
    files.add(rel.split('\\').join('/'));
    this.touched.set(chat.id, files);
  }

  turnEnded(chat: Chat): void {
    const files = [...(this.touched.get(chat.id) ?? [])];
    this.touched.delete(chat.id);
    const title = this.deps.topicTitle(chat);
    if (files.length) {
      for (const file of files) this.claimed.add(file);
      this.enqueue(async () => {
        try {
          await this.commit(files, `hos: ${title} · chat ${chat.id.slice(0, 8)}`, chat.id);
        } finally {
          for (const file of files) this.claimed.delete(file);
        }
      });
    }
    this.enqueue(async () => {
      if (!this.deps.busy()) await this.sweep();
    });
  }

  commitPaths(paths: string[], subject: string): Promise<void> {
    for (const path of paths) this.claimed.add(path);
    return this.enqueue(async () => {
      try {
        await this.commit(paths, subject, null);
      } finally {
        for (const path of paths) this.claimed.delete(path);
      }
    });
  }

  moveFolder(from: string, to: string, subject: string): Promise<void> {
    return this.enqueue(async () => {
      const source = join(this.deps.brainDir, from);
      const target = join(this.deps.brainDir, to);
      if (!existsSync(source) || existsSync(target)) return;
      const files = (await readdir(source, { withFileTypes: true, recursive: true })).filter((entry) => entry.isFile()).length;
      const tracked = (await this.git('ls-files', '--', from).catch(() => '')).trim() !== '';
      await mkdir(dirname(target), { recursive: true });
      await rename(source, target);
      if (!files) return;
      await mkdir(dirname(join(this.deps.brainDir, MOVED_TSV)), { recursive: true });
      await appendFile(join(this.deps.brainDir, MOVED_TSV), `hos-rename\t${from}/\t${to}/\n`);
      await this.commit([...(tracked ? [from] : []), to, MOVED_TSV], subject, null, false);
    });
  }

  async settled(): Promise<void> {
    for (let queue = this.queue; ; queue = this.queue) {
      await queue;
      if (this.queue === queue) return;
    }
  }

  flush(): Promise<string> {
    return this.run(async () => {
      await this.sweep();
      await this.sync();
      if (!(await this.hasOrigin())) return this.head();
      if (this.paused) throw new Error(`the brain on ${this.deps.host} stopped pushing after a merge conflict; fix it by hand (see the Brain sync conflict alert)`);
      const ahead = Number((await this.git('rev-list', '--count', 'origin/main..HEAD')).trim());
      if (ahead) throw new Error(`the brain on ${this.deps.host} has ${ahead} commit(s) it could not push; see brain-commits.log`);
      return this.head();
    });
  }

  pull(): Promise<void> {
    return this.run(() => this.sync());
  }

  // Polls on real timers: a fake clock in tests would never fire while the caller waits on the answer.
  async syncTo(sha: string, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { has, paused, origin } = await this.run(async () => {
        if (!(await this.contains(sha))) {
          if (!this.deps.busy()) await this.sweep();
          await this.sync();
        }
        return { has: await this.contains(sha), paused: this.paused, origin: await this.hasOrigin() };
      });
      if (has) return;
      if (paused) throw new Error(`the brain on ${this.deps.host} can't merge origin/main (a conflict paused it; see the Brain sync conflict alert), so it can't reach ${sha.slice(0, 12)}`);
      if (!origin) throw new Error(`the brain on ${this.deps.host} has no origin to pull ${sha.slice(0, 12)} from`);
      if (Date.now() >= deadline) throw new Error(`the brain on ${this.deps.host} still lacks ${sha.slice(0, 12)} after ${Math.round(timeoutMs / 1000)} s; see brain-commits.log there`);
      await new Promise((resolve) => setTimeout(resolve, SYNC_RETRY_MS));
    }
  }

  private run<T>(job: () => Promise<T>): Promise<T> {
    const done = this.queue.then(job);
    this.queue = done.then(
      () => undefined,
      () => undefined,
    );
    return done;
  }

  private async hasOrigin(): Promise<boolean> {
    return (await this.git('remote').catch(() => '')).split('\n').includes('origin');
  }

  private async head(): Promise<string> {
    return (await this.git('rev-parse', 'HEAD')).trim();
  }

  private contains(sha: string): Promise<boolean> {
    return this.git('merge-base', '--is-ancestor', sha, 'HEAD').then(
      () => true,
      () => false,
    );
  }

  private enqueue(job: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(job).catch((error: Error) => this.log(`error: ${error.message}`));
    return this.queue;
  }

  private async sweep(): Promise<void> {
    if (!(await this.ready())) return;
    const entries = (await this.git('status', '--porcelain', '-z', '--untracked-files=all')).split('\0');
    const paths: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      if (entry.length < 4) continue;
      paths.push(entry.slice(3));
      if (/^[RC]/.test(entry)) paths.push(entries[++i] ?? '');
    }
    const listed = new Set(paths);
    for (const path of this.leftOut.keys()) if (!listed.has(path)) this.leftOut.delete(path);
    const unowned = (path: string) => !this.owned(path);
    if (paths.length) await this.commit(paths.filter(unowned), 'hos: sweep', null, true, unowned);
  }

  private owned(path: string): boolean {
    return this.claimed.has(path) || [...this.touched.values()].some((files) => files.has(path)) || this.deps.awaitsCheckpoint(path);
  }

  private async commit(paths: string[], subject: string, chatId: string | null, guard = true, keep: (path: string) => boolean = () => true): Promise<void> {
    if (!(await this.ready())) return;
    const refused = await commitIdentityRefusal(this.deps.brainDir);
    if (refused) {
      await this.log(`ABORT: commit identity: ${refused} (${chatId ? `chat ${chatId.slice(0, 8)}` : 'sweep'}); nothing committed`);
      return;
    }
    const files: string[] = [];
    for (const path of paths) {
      if (!path) continue;
      const ignored = await this.git('check-ignore', '-q', '--', path).then(
        () => true,
        () => false,
      );
      if (ignored) continue;
      const size = await stat(join(this.deps.brainDir, path)).then(
        (s) => (s.isFile() ? s.size : 0),
        () => 0,
      );
      if (size > MAX_BYTES) {
        await this.log(`skipped >5MB: ${path}`);
        continue;
      }
      files.push(path);
    }
    if (!files.length) return;
    const indexed = new Set((await this.git('ls-files', '-z', '--', ...files)).split('\0'));
    const addable = files.filter((path) => indexed.has(path) || existsSync(join(this.deps.brainDir, path)));
    if (addable.length) await this.git('add', '-A', '--', ...addable);
    const staged = (await this.git('diff', '--cached', '--name-only', '-z', '--', ...files)).split('\0').map((p) => p.trim()).filter(Boolean);
    if (!staged.length) return;
    const flagged = await this.secrets(staged);
    if (flagged.size) await this.leaveOut(flagged, chatId);
    const clean = staged.filter((path) => !flagged.has(path));
    if (!clean.length) return;
    if (guard) clean.push(...(await this.guard(clean, chatId)));
    // Re-checked after the awaits: a diagram written since the sweep listed its paths belongs to that diagram's own commit.
    const kept = clean.filter(keep);
    if (!kept.length) return;
    const message = `${subject} · ${kept.length} file(s)`;
    await this.git('commit', '-q', '-m', message, '-m', kept.slice(0, 10).join(' '), '--', ...kept);
    const sha = (await this.git('rev-parse', 'HEAD')).trim();
    await this.log(`committed ${sha.slice(0, 12)} ${message}: ${kept.join(', ')}`);
    this.deps.record({ type: 'brain.committed', sha, chatId, files: kept });
    for (const path of kept) this.leftOut.delete(path);
    this.schedulePush();
  }

  blockedRow(): StatusItem | null {
    if (!this.leftOut.size) return null;
    const since = Math.min(...[...this.leftOut.values()].map((entry) => entry.since));
    const files = [...this.leftOut].map(([path, { rule }]) => `${path} (${rule})`).join(', ');
    return { id: 'brain_commits', label: 'Brain commits', status: 'warn', detail: `blocked since ${localStamp(since)}: ${files}`, fix: 'redact or delete the file; it commits on the next sweep' };
  }

  private async secrets(staged: string[]): Promise<Map<string, string>> {
    const flagged = new Map<string, string>();
    const ruleFor = (diff: string) => {
      const added = diff
        .split('\n')
        .filter((line) => line.startsWith('+') && !line.startsWith('+++ '))
        .join('\n');
      return SECRET_RULES.find(([, pattern]) => pattern.test(added))?.[0];
    };
    if (!ruleFor(await this.git('diff', '--cached', '-U0', '--', ...staged))) return flagged;
    for (const path of staged) {
      const rule = ruleFor(await this.git('diff', '--cached', '-U0', '--', path));
      if (rule) flagged.set(path, rule);
    }
    return flagged;
  }

  private async leaveOut(flagged: Map<string, string>, chatId: string | null): Promise<void> {
    await this.git('reset', '-q', '--', ...flagged.keys());
    for (const [path, rule] of flagged) {
      await this.log(`left out ${path}: secret-like content (${rule}) (${chatId ? `chat ${chatId.slice(0, 8)}` : 'sweep'}); the other files commit`);
      if (chatId) this.deps.warn(chatId, `left out ${path}: it holds secret-like content (${rule}). Redact it and it commits on the next sweep; your other files committed.`);
      if (this.leftOut.has(path)) continue;
      this.leftOut.set(path, { rule, since: this.deps.now() });
      this.deps.alert(
        'Brain file left out of commits',
        `${path} in ${this.deps.brainDir} on ${this.deps.host} holds secret-like content (${rule}), so hos leaves it out of every brain commit; the rest of the brain still commits and pushes. Redact or delete it and it commits on the next sweep.`,
      );
    }
  }

  private schedulePush(): void {
    if (this.pushArmed) return;
    this.pushArmed = true;
    this.deps.setTimeout(() => {
      this.pushArmed = false;
      void this.enqueue(() => this.sync());
    }, PUSH_EVERY_MS);
  }

  // Fetch, merge origin/main, push; never rebases or forces, and a conflict pauses pushing until HEAD contains origin/main again.
  private async sync(retry = true): Promise<void> {
    if (!(await this.ready())) return;
    if (!(await this.hasOrigin())) return;
    if ((await this.git('symbolic-ref', '--short', 'HEAD').catch(() => '')).trim() !== 'main') return;
    try {
      await this.git('fetch', '-q', 'origin', 'main');
    } catch (error) {
      await this.log(`sync failed: fetch: ${oneLine(error)}`);
      return;
    }
    const behind = Number((await this.git('rev-list', '--count', 'HEAD..origin/main')).trim());
    if (this.paused) {
      if (behind) return;
      this.paused = false;
      await this.log('sync resumed: HEAD contains origin/main again');
    }
    if (behind) {
      try {
        await this.git('merge', '-q', '--no-edit', 'origin/main');
      } catch (error) {
        const gitDir = (await this.git('rev-parse', '--absolute-git-dir')).trim();
        if (!existsSync(join(gitDir, 'MERGE_HEAD'))) {
          await this.log(`sync failed: merge refused, retrying next sync: ${oneLine(error)}`);
          return;
        }
        const files = (await this.git('diff', '--name-only', '--diff-filter=U').catch(() => '')).split('\n').filter(Boolean);
        await this.git('merge', '--abort');
        this.paused = true;
        await this.log(`sync CONFLICT: merge aborted, pushing paused: ${files.join(', ')}`);
        this.deps.alert(
          'Brain sync conflict',
          `Merging origin/main into ${this.deps.brainDir} on ${this.deps.host} conflicted in ${files.join(', ') || 'unknown files'}. The merge was aborted and this machine stopped pushing the brain; local commits are kept. Fix by hand: git merge origin/main, resolve, commit. Pushing resumes once HEAD contains origin/main.`,
        );
        return;
      }
    }
    const ahead = Number((await this.git('rev-list', '--count', 'origin/main..HEAD')).trim());
    if (!ahead) {
      if (behind) await this.log(`sync ok: merged ${behind} commit(s) from origin, nothing to push`);
      return;
    }
    try {
      await this.git('push', '-q', 'origin', 'main');
      await this.log(`sync ok: merged ${behind} commit(s) from origin, pushed ${ahead}`);
    } catch (error) {
      await this.log(`push failed: ${oneLine(error)}`);
      if (retry) await this.sync(false);
    }
  }

  // Never blocks a commit: old-path writes go to the path-miss log, the rest are warnings to the writing chat.
  private async guard(staged: string[], chatId: string | null): Promise<string[]> {
    const root = this.deps.workRoot();
    const written = (await this.git('diff', '--cached', '--name-only', '--diff-filter=AMR', '-z', '--', ...staged)).split('\0').filter(Boolean);
    const warnings: string[] = [];
    const extra: string[] = [];
    const misses = written.filter((path) => OLD_PATHS.some((old) => old.test(path)));
    if (misses.length) {
      const tsv = `${root}/${META_DIR}/path-misses.tsv`;
      const who = chatId ? chatId.slice(0, 8) : 'sweep';
      const skill = (chatId && this.skills.get(chatId)) || '-';
      const at = localStamp(this.deps.now());
      await mkdir(dirname(join(this.deps.brainDir, tsv)), { recursive: true });
      await appendFile(join(this.deps.brainDir, tsv), misses.map((path) => `${[at, this.deps.host, who, path, skill].join('\t')}\n`).join(''));
      await this.git('add', '--', tsv);
      extra.push(tsv);
      warnings.push(`${misses.join(', ')} ${misses.length === 1 ? 'is' : 'are'} at an old path (artifacts/<YYYY-MM>/, artifacts/handoff/, plans/, status/); new work goes in the topic's work folder (WORK_DIR). Logged in ${tsv}.`);
    }
    for (const path of written.filter((p) => p.startsWith(`${root}/`) && basename(p) === PROGRESS_FILE)) {
      const before = await this.git('show', `HEAD:${path}`).catch(() => null);
      const after = await this.git('show', `:${path}`).catch(() => null);
      if (before === null || after === null) continue;
      const [was, now] = [parseProgress(before), parseProgress(after)];
      const lost = REQUIRED_SECTIONS.filter((name) => sectionOf(was, name) !== undefined && sectionOf(now, name) === undefined);
      const newestLog = (progress: typeof was) => (sectionOf(progress, 'Log') ?? '').split('\n')[0];
      if (lost.length) warnings.push(`${path} lost its ${lost.join(', ')} heading${lost.length === 1 ? '' : 's'}`);
      if (after.length < before.length / 2 && newestLog(now) === newestLog(was)) warnings.push(`${path} shrank from ${before.length} to ${after.length} characters with no new Log line`);
    }
    const depth = root.split('/').length + 2;
    const folders = new Set(
      written.filter((p) => p.startsWith(`${root}/`) && !p.startsWith(`${root}/${META_DIR}/`) && p.split('/').length > depth).map((p) => p.split('/').slice(0, depth).join('/')),
    );
    for (const folder of folders) {
      if (this.deps.ownsWorkDir(folder, chatId)) continue;
      const existed = (await this.git('ls-tree', '-d', '--name-only', 'HEAD', '--', folder).catch(() => '')).trim() !== '';
      if (!existed) warnings.push(`${folder} is a new work folder that no topic owns; if your topic was renamed, use the WORK_DIR in your latest briefing`);
    }
    for (const warning of warnings) {
      await this.log(`warning (${chatId ? `chat ${chatId.slice(0, 8)}` : 'sweep'}): ${warning}`);
      this.deps.warn(chatId, warning);
    }
    return extra;
  }

  private async ready(): Promise<boolean> {
    const gitDir = (await this.git('rev-parse', '--absolute-git-dir').catch(() => ''))?.trim();
    if (!gitDir) return false;
    return !['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'].some((name) => existsSync(join(gitDir, name)));
  }

  private async git(...args: string[]): Promise<string> {
    const { stdout } = await run('git', args, { cwd: this.deps.brainDir, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  }

  private log(line: string): Promise<void> {
    return appendFile(this.deps.logFile, `${new Date(this.deps.now()).toISOString()} ${line}\n`).catch(() => {});
  }
}
