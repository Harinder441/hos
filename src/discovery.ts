import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface DiscoveryConfig {
  brain?: string;
  repoRoots?: string[];
  worktreeRoots?: string[];
}

export interface Candidate {
  path: string;
  key: string | null;
  pinned: boolean;
}

export async function discoverCandidates(config: DiscoveryConfig): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  if (config.brain) {
    candidates.push({ path: config.brain, key: null, pinned: true });
    for (const { key, path } of await locationKeys(join(config.brain, 'shared', 'LOCATIONS.md'))) {
      candidates.push({ path, key, pinned: false });
    }
  }
  for (const root of config.repoRoots ?? []) {
    for (const path of await gitDirsBelow(root, 1)) candidates.push({ path, key: null, pinned: false });
  }
  for (const root of config.worktreeRoots ?? []) {
    for (const path of await gitDirsBelow(root, 2)) candidates.push({ path, key: null, pinned: false });
  }
  return candidates;
}

export interface LocationRow {
  key: string;
  path: string;
  about: string;
}

export async function locationKeys(file: string): Promise<LocationRow[]> {
  const text = await readFile(file, 'utf8').catch(() => '');
  const keys: LocationRow[] = [];
  for (const line of text.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim());
    if (cells.length < 4 || cells[0] !== '') continue;
    const key = cells[1]!;
    const path = /`((?:~\/|\/)[^`*{}]*)`/.exec(cells[2]!)?.[1];
    if (!path || !/^[a-z0-9][\w.-]*$/i.test(key)) continue;
    const about = cells.slice(3).filter(Boolean).join(' · ');
    keys.push({ key, path: path.startsWith('~/') ? join(homedir(), path.slice(2)) : path, about });
  }
  return keys;
}

async function gitDirsBelow(dir: string, depth: number): Promise<string[]> {
  if (depth === 0) return existsSync(join(dir, '.git')) ? [dir] : [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || !(entry.isDirectory() || entry.isSymbolicLink())) continue;
    found.push(...(await gitDirsBelow(join(dir, entry.name), depth - 1)));
  }
  return found;
}
