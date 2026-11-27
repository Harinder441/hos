import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { git, hosRoot, isGitRepo } from './common.js';
import type { CliResult } from './init.js';
import { syncLines, syncSkills } from './skills.js';
import { validateBrain } from './validate.js';

export function brainUpdate(brainDir: string, options: { root?: string; home?: string } = {}): CliResult {
  const brain = resolve(brainDir);
  const root = options.root ?? hosRoot();
  const fail = (...lines: string[]): CliResult => ({ ok: false, lines });
  if (!isGitRepo(brain)) return fail(`${brain} is not a git repository`);
  if (!git(brain, 'remote').out.split('\n').includes('starter')) {
    return fail('this brain has no starter remote; add it with: git remote add starter <starter url> && git remote set-url --push starter DISABLED');
  }
  const gitDir = git(brain, 'rev-parse', '--absolute-git-dir').out;
  if (existsSync(join(gitDir, 'MERGE_HEAD'))) return fail('a merge is already in progress: finish it (resolve, git add, git commit) or run git merge --abort, then run this again');
  if (git(brain, 'status', '--porcelain').out) return fail('the brain has uncommitted changes; commit them first so the merge stays easy to undo');

  const fetch = git(brain, 'fetch', 'starter');
  if (!fetch.ok) return fail(`git fetch starter failed: ${fetch.err}`);
  if (!git(brain, 'rev-parse', '--verify', '--quiet', 'refs/remotes/starter/HEAD').ok) git(brain, 'remote', 'set-head', 'starter', '--auto');
  const head = git(brain, 'symbolic-ref', '--short', 'refs/remotes/starter/HEAD');
  const ref = head.ok ? head.out : 'starter/main';
  const incoming = git(brain, 'log', '--oneline', '--no-merges', `HEAD..${ref}`).out;
  const lines: string[] = [];
  if (!incoming) lines.push(`up to date: the brain already has every commit of ${ref}`);
  else {
    lines.push(`new in ${ref}:`, ...incoming.split('\n').map((l) => `  ${l}`));
    const merge = git(brain, 'merge', '--no-edit', ref);
    if (!merge.ok) {
      const conflicts = git(brain, 'diff', '--name-only', '--diff-filter=U').out.split('\n').filter(Boolean);
      if (!conflicts.length) return fail(...lines, `git merge ${ref} failed: ${merge.err}`);
      return fail(
        ...lines,
        `merge stopped with conflicts in ${conflicts.length} file(s):`,
        ...conflicts.map((f) => `  ${f}`),
        'Open each file and keep your lines while adding the starter\'s; never take the starter\'s version of a whole file.',
        'Then: git add <files> && git merge --continue (hos does not commit the brain while a merge is open), and run hos validate and hos skills sync. To give up: git merge --abort.',
      );
    }
    lines.push(`merged  ${ref}`);
  }
  lines.push(...syncLines(syncSkills(brain, { root })));
  const validation = validateBrain(brain, { root, ...(options.home ? { home: options.home } : {}) });
  lines.push(...validation.lines);
  if (git(brain, 'status', '--porcelain').out) lines.push('', 'hos skills sync changed files under .claude/skills; review and commit them.');
  return { ok: validation.ok, lines };
}
