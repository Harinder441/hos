import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { hosRoot, sha256 } from './common.js';
import { hosVersion } from './version.js';

export const MANIFEST = '.hos-managed.json';
const MAP_FILE = 'hos-skills.json';

export interface Manifest {
  hos: string;
  files: Record<string, string>;
  profiles: Record<string, string[]>;
}

export interface SyncReport {
  added: string[];
  updated: string[];
  edited: string[];
  unmanaged: string[];
  removed: string[];
  unchanged: number;
}

export function hosSkillNames(root = hosRoot()): string[] {
  const dir = join(root, 'skills');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, 'SKILL.md')))
    .map((e) => e.name)
    .sort();
}

export function starterProfileSkills(root = hosRoot()): Record<string, string[]> {
  const file = join(root, 'skills', MAP_FILE);
  if (!existsSync(file)) return {};
  const map = (JSON.parse(readFileSync(file, 'utf8')) as { skills: Record<string, { profiles: string[] }> }).skills;
  const byProfile: Record<string, string[]> = {};
  for (const [skill, { profiles }] of Object.entries(map)) for (const id of profiles) (byProfile[id] ??= []).push(skill);
  return byProfile;
}

export function readManifest(brain: string): Manifest {
  const file = join(brain, '.claude', 'skills', MANIFEST);
  if (!existsSync(file)) return { hos: '', files: {}, profiles: {} };
  const data = JSON.parse(readFileSync(file, 'utf8')) as Partial<Manifest>;
  return { hos: data.hos ?? '', files: data.files ?? {}, profiles: data.profiles ?? {} };
}

export function writeManifest(brain: string, manifest: Manifest): void {
  const file = join(brain, '.claude', 'skills', MANIFEST);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

function sourceFiles(root: string): string[] {
  const dir = join(root, 'skills');
  return hosSkillNames(root).flatMap((name) =>
    (readdirSync(join(dir, name), { recursive: true, withFileTypes: true }) as Array<{ name: string; parentPath: string; isFile(): boolean }>)
      .filter((e) => e.isFile() && !e.name.startsWith('.'))
      .map((e) => relative(dir, join(e.parentPath, e.name)).split(sep).join('/'))
      .sort(),
  );
}

export function syncSkills(brain: string, options: { dryRun?: boolean; root?: string } = {}): SyncReport {
  const root = options.root ?? hosRoot();
  const target = join(brain, '.claude', 'skills');
  const manifest = readManifest(brain);
  const files: Record<string, string> = {};
  const report: SyncReport = { added: [], updated: [], edited: [], unmanaged: [], removed: [], unchanged: 0 };
  const write = (rel: string, data: Buffer) => {
    if (options.dryRun) return;
    mkdirSync(dirname(join(target, rel)), { recursive: true });
    writeFileSync(join(target, rel), data);
  };
  const source = sourceFiles(root);
  for (const rel of source) {
    const data = readFileSync(join(root, 'skills', rel));
    const hash = sha256(data);
    const path = join(target, rel);
    if (!existsSync(path)) {
      write(rel, data);
      files[rel] = hash;
      report.added.push(rel);
      continue;
    }
    const current = sha256(readFileSync(path));
    if (current === hash) {
      files[rel] = hash;
      report.unchanged++;
    } else if (manifest.files[rel] === current) {
      write(rel, data);
      files[rel] = hash;
      report.updated.push(rel);
    } else if (manifest.files[rel]) {
      files[rel] = manifest.files[rel]!;
      report.edited.push(rel);
    } else report.unmanaged.push(rel);
  }
  for (const [rel, hash] of Object.entries(manifest.files)) {
    if (source.includes(rel)) continue;
    const path = join(target, rel);
    if (!existsSync(path)) continue;
    if (sha256(readFileSync(path)) === hash) {
      if (!options.dryRun) rmSync(path);
      report.removed.push(rel);
    } else report.edited.push(rel);
  }
  if (!options.dryRun) writeManifest(brain, { ...manifest, hos: hosVersion(root).version, files });
  return report;
}

export function syncLines(report: SyncReport, dryRun = false): string[] {
  const verb = (done: string, would: string) => (dryRun ? would : done);
  return [
    ...report.added.map((f) => `${verb('added', 'would add')}    .claude/skills/${f}`),
    ...report.updated.map((f) => `${verb('updated', 'would update')}  .claude/skills/${f}`),
    ...report.removed.map((f) => `${verb('removed', 'would remove')}  .claude/skills/${f} (no longer in hos)`),
    ...report.edited.map((f) => `kept     .claude/skills/${f}: edited, not updated (delete it and sync again to take the hos version)`),
    ...report.unmanaged.map((f) => `kept     .claude/skills/${f}: not written by hos, left alone (move it away and sync again to take the hos version)`),
    `${report.unchanged} file(s) already current`,
  ];
}
