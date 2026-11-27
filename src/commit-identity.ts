import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { StatusItem } from './api/types.js';

const run = promisify(execFile);

type EmailKind = 'noreply' | 'work domain' | 'other';

async function git(args: string[], cwd?: string): Promise<string | null> {
  return run('git', args, { timeout: 10_000, ...(cwd ? { cwd } : {}) }).then(
    ({ stdout }) => stdout.trim(),
    () => null,
  );
}

export async function workDomain(): Promise<string | null> {
  const domain = await git(['config', '--global', '--includes', '--get', 'hosGit.workDomain']);
  return domain ? domain.replace(/^@/, '').toLowerCase() : null;
}

async function identity(dir: string, domain: string): Promise<{ dir: string; personal: boolean; kind: EmailKind }> {
  const [repoClass, ident] = await Promise.all([git(['config', '--get', 'hosGit.repoClass'], dir), git(['var', 'GIT_AUTHOR_IDENT'], dir)]);
  const email = (/<([^>]*)>/.exec(ident ?? '')?.[1] ?? '').toLowerCase();
  const kind: EmailKind = email.endsWith(`@${domain}`) ? 'work domain' : email.endsWith('@users.noreply.github.com') ? 'noreply' : 'other';
  return { dir, personal: repoClass === 'personal', kind };
}

export async function commitIdentityRow(brainDir: string | undefined, dirs: string[]): Promise<StatusItem> {
  const row = (status: StatusItem['status'], detail: string, fix?: string): StatusItem => ({ id: 'commit_identity', label: 'Commit identity', status, detail, ...(fix ? { fix } : {}) });
  const domain = await workDomain();
  if (!domain) return row('ok', 'no work domain configured (optional)');
  const checked = await Promise.all([...new Set([...(brainDir ? [brainDir] : []), ...dirs])].filter((dir) => existsSync(dir)).map((dir) => identity(dir, domain)));
  const wrong = checked.filter((repo) => repo.personal && repo.kind === 'work domain');
  if (wrong.length) {
    return row('down', `${wrong.length} personal repo${wrong.length === 1 ? '' : 's'} commit with the work domain: ${wrong.map((repo) => repo.dir).join(', ')}`, `git -C ${wrong[0]!.dir} config --unset user.email, or remove the override`);
  }
  const hooks = brainDir ? await git(['hook', 'list', 'pre-commit'], brainDir) : null;
  if (!hooks?.includes('identity-guard')) {
    const installer = brainDir && existsSync(join(brainDir, 'global', 'install', 'install.mjs')) ? `node ${brainDir}/global/install/install.mjs --apply` : 'git config --global hook.identity-guard.event pre-commit, and set hook.identity-guard.command to a check that refuses the work domain';
    return row('warn', 'the commit identity guard is not installed, or git is too old for config hooks', `${installer}, or upgrade git`);
  }
  const noreply = checked.filter((repo) => repo.personal && repo.kind === 'noreply').length;
  return row('ok', `${noreply} personal repo${noreply === 1 ? '' : 's'} commit as noreply, guard installed`);
}

export async function commitIdentityRefusal(dir: string): Promise<string | null> {
  const domain = await workDomain();
  if (!domain) return null;
  const repo = await identity(dir, domain);
  return repo.personal && repo.kind === 'work domain' ? 'this personal repo would commit with the work domain' : null;
}
