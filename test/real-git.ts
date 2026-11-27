import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

// macOS /usr/bin/git is an xcrun shim that starts the real git, so each call costs two process starts (8 ms vs 2.7 ms).
export function pathWithRealGit(path = process.env.PATH ?? ''): string {
  if (process.platform !== 'darwin') return path;
  let git: string;
  try {
    git = execFileSync('xcrun', ['--find', 'git'], { encoding: 'utf8' }).trim();
  } catch {
    return path;
  }
  const dir = mkdtempSync(join(tmpdir(), 'hos-git-'));
  process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
  symlinkSync(git, join(dir, 'git'));
  return `${dir}${delimiter}${path}`;
}
