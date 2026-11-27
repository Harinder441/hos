import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, hosRoot } from './common.js';

export function hosVersion(root = hosRoot()): { version: string; commit: string | null } {
  const version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;
  const head = existsSync(join(root, '.git')) ? git(root, 'rev-parse', '--short', 'HEAD') : null;
  return { version, commit: head?.ok ? head.out : null };
}

export function versionLine(root = hosRoot()): string {
  const { version, commit } = hosVersion(root);
  return `hos ${version}${commit ? ` (${commit})` : ''}`;
}

export function versionInRange(version: string, range: string): boolean {
  const parts = (v: string) => v.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const compare = (a: string, b: string) => {
    const [x, y] = [parts(a), parts(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
    return 0;
  };
  return range
    .trim()
    .split(/\s+/)
    .every((clause) => {
      const match = /^(>=|<=|>|<|=)?(\d+(?:\.\d+)*)$/.exec(clause);
      if (!match) return false;
      const c = compare(version, match[2]!);
      return match[1] === '>=' ? c >= 0 : match[1] === '>' ? c > 0 : match[1] === '<=' ? c <= 0 : match[1] === '<' ? c < 0 : c === 0;
    });
}
