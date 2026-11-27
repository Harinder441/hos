import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function hosRoot(from = dirname(fileURLToPath(import.meta.url))): string {
  for (let dir = from; ; dir = dirname(dir)) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg) && (JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string }).name === 'hos') return dir;
    if (dirname(dir) === dir) throw new Error(`no hos package.json above ${from}`);
  }
}

export function defaultBrain(env = process.env, home = homedir()): string {
  return env.HOS_BRAIN || join(home, 'hos-brain');
}

export interface GitResult {
  ok: boolean;
  out: string;
  err: string;
}

export function git(cwd: string, ...args: string[]): GitResult {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { ok: result.status === 0, out: (result.stdout ?? '').trim(), err: (result.stderr ?? '').trim() || (result.error?.message ?? '') };
}

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function validateCommand(brainDir: string | undefined): string {
  if (brainDir && existsSync(join(brainDir, 'hos', 'validate.mjs'))) return 'node hos/validate.mjs';
  return `node ${join(hosRoot(), 'dist', 'daemon', 'main.js')} validate${brainDir ? ` --brain ${brainDir}` : ''}`;
}

export function isGitRepo(dir: string): boolean {
  return git(dir, 'rev-parse', '--is-inside-work-tree').out === 'true';
}
