import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isMap, isSeq, parseDocument, stringify, type YAMLMap } from 'yaml';
import { validTimezone } from '../owner.js';
import { git, hosRoot, isGitRepo } from './common.js';
import { readManifest, starterProfileSkills, syncLines, syncSkills, writeManifest } from './skills.js';
import { validateBrain } from './validate.js';

export const STARTER_URL = 'https://github.com/Harinder441/hos-brain';
export const DISABLED_PUSH = 'DISABLED';

export interface AdoptOptions {
  dir: string;
  starter?: string;
  origin?: string;
  name?: string;
  timezone?: string;
  root?: string;
  home?: string;
}

export interface CliResult {
  ok: boolean;
  lines: string[];
}

export function adoptBrain(options: AdoptOptions): CliResult {
  const dir = resolve(options.dir);
  const root = options.root ?? hosRoot();
  const lines: string[] = [];
  const fail = (line: string): CliResult => ({ ok: false, lines: [...lines, line] });
  if (options.timezone && !validTimezone(options.timezone)) return fail(`--timezone ${options.timezone} is not an IANA zone like Europe/Berlin`);
  if (options.name !== undefined && (!options.name.trim() || options.name.trim().length > 60)) return fail('--name must be 1 to 60 characters');

  if (!existsSync(dir)) {
    const from = options.starter ?? STARTER_URL;
    mkdirSync(dirname(dir), { recursive: true });
    const clone = git(dirname(dir), 'clone', '--origin', 'starter', from, dir);
    if (!clone.ok) return fail(`git clone ${from} failed: ${clone.err}`);
    lines.push(`cloned  ${from} into ${dir} (remote starter)`);
    const branch = git(dir, 'branch', '--show-current').out;
    if (branch && branch !== 'main') {
      git(dir, 'branch', '-m', branch, 'main');
      lines.push(`branch  ${branch} renamed to main (it still tracks starter/${branch})`);
    }
  } else {
    const top = isGitRepo(dir) ? git(dir, 'rev-parse', '--show-toplevel').out : '';
    if (!top || realpathSync(top) !== realpathSync(dir)) {
      return fail(`${dir} is not the top folder of its own git repository${top ? ` (it sits inside ${top})` : ''}; clone the starter there or pick a path that does not exist yet`);
    }
    const remotes = git(dir, 'remote').out.split('\n').filter(Boolean);
    if (!remotes.includes('starter')) {
      const starterUrl = options.starter ?? STARTER_URL;
      const originUrl = remotes.includes('origin') ? git(dir, 'remote', 'get-url', 'origin').out : null;
      if (originUrl && sameUrl(originUrl, starterUrl)) {
        git(dir, 'remote', 'rename', 'origin', 'starter');
        lines.push(`remote  origin renamed to starter (${originUrl})`);
      } else {
        git(dir, 'remote', 'add', 'starter', starterUrl);
        lines.push(`remote  starter added (${starterUrl})${originUrl ? `; origin left as it is (${originUrl})` : ''}`);
      }
    }
  }

  if (git(dir, 'remote').out.split('\n').includes('starter')) {
    git(dir, 'remote', 'set-url', '--push', 'starter', DISABLED_PUSH);
    const tracked = git(dir, 'for-each-ref', '--count=1', 'refs/remotes/starter/').out;
    if (tracked && !git(dir, 'rev-parse', '--verify', '--quiet', 'refs/remotes/starter/HEAD').ok) git(dir, 'remote', 'set-head', 'starter', '--auto');
    lines.push('remote  starter: fetch only (push URL DISABLED)');
  }

  if (options.origin) {
    const current = git(dir, 'remote', 'get-url', 'origin');
    if (current.ok && !sameUrl(current.out, options.origin)) return fail(`origin already points at ${current.out}; remove it first (git remote remove origin) if ${options.origin} should replace it`);
    if (!current.ok) git(dir, 'remote', 'add', 'origin', options.origin);
    lines.push(`remote  origin = ${options.origin} (nothing pushed yet)`);
  }

  if (options.name || options.timezone) {
    lines.push(...setOwner(dir, options.name?.trim(), options.timezone));
  }

  lines.push(...syncLines(syncSkills(dir, { root })));
  lines.push(...appendProfileSkills(dir, root));

  const validation = validateBrain(dir, { root, ...(options.home ? { home: options.home } : {}) });
  lines.push(...validation.lines);
  if (validation.ok) {
    lines.push(
      '',
      'Next:',
      `  git -C ${dir} config user.email      # check this is the address you want on your brain's commits`,
      `  git -C ${dir} add -A && git -C ${dir} commit -m "Make this brain mine"`,
      ...(options.origin ? [`  git -C ${dir} push -u origin main`] : ['  add your own private repo later: git remote add origin <url>, then push']),
      `  HOS_BRAIN=${dir} hos      # or pass --brain ${dir}`,
    );
  }
  return { ok: validation.ok, lines };
}

function sameUrl(a: string, b: string): boolean {
  const norm = (u: string) => u.trim().replace(/\.git$/, '').replace(/\/+$/, '');
  return norm(a) === norm(b);
}

export function setOwner(dir: string, name: string | undefined, timezone: string | undefined): string[] {
  const lines: string[] = [];
  const policyFile = join(dir, 'hos', 'policy.yaml');
  const text = existsSync(policyFile) ? readFileSync(policyFile, 'utf8') : 'version: 1\n';
  const values = { ...(name ? { name } : {}), ...(timezone ? { timezone } : {}) };
  mkdirSync(dirname(policyFile), { recursive: true });
  writeFileSync(policyFile, setBlockKeys(text, 'owner', values, 'who these agents work for (hos init wrote it)'));
  lines.push(`owner   hos/policy.yaml owner:${name ? ` name ${name}` : ''}${timezone ? ` timezone ${timezone}` : ''}`);

  const userFile = join(dir, 'shared', 'USER.md');
  if (existsSync(userFile)) {
    let text = readFileSync(userFile, 'utf8');
    const before = text;
    if (name) text = text.replace(/^- Name:.*$/m, `- Name: ${name}`);
    if (timezone) text = text.replace(/^- Timezone:.*$/m, `- Timezone: ${timezone}`);
    if (text !== before) {
      writeFileSync(userFile, text);
      lines.push('owner   shared/USER.md Name and Timezone lines filled in');
    } else lines.push('warn    shared/USER.md has no "- Name:" or "- Timezone:" line, so it was left alone');
  }
  return lines;
}

function appendProfileSkills(dir: string, root: string): string[] {
  const wanted = starterProfileSkills(root);
  const profilesDir = join(dir, 'profiles');
  if (!existsSync(profilesDir)) return [];
  const manifest = readManifest(dir);
  const lines: string[] = [];
  for (const id of readdirSync(profilesDir).sort()) {
    const names = wanted[id];
    const file = join(profilesDir, id, 'PROFILE.md');
    if (!names?.length || !existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    const match = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text);
    if (!match) continue;
    const front = parseDocument(match[1]!);
    const skills = isMap(front.contents) ? (front.contents as YAMLMap).get('skills', true) : undefined;
    if (!isSeq(skills)) continue;
    const present = new Set(skills.items.map((item) => String((item as { value?: unknown }).value ?? item)));
    const offered = new Set(manifest.profiles[id] ?? []);
    const added = names.filter((name) => !present.has(name) && !offered.has(name));
    manifest.profiles[id] = [...new Set([...offered, ...names])];
    if (!added.length) continue;
    writeFileSync(file, `---\n${appendToList(match[1]!, 'skills', added)}\n---${match[2]}${text.slice(match[0].length)}`);
    lines.push(`profile profiles/${id}/PROFILE.md skills: + ${added.join(', ')}`);
  }
  writeManifest(dir, manifest);
  return lines;
}

function setBlockKeys(text: string, key: string, values: Record<string, string>, comment: string): string {
  const scalar = (value: string) => stringify(value).trimEnd();
  const lines = text.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^${key}:\\s*(#.*)?$`).test(line));
  if (start === -1) {
    const doc = parseDocument(text);
    if (doc.has(key)) {
      for (const [k, v] of Object.entries(values)) doc.setIn([key, k], v);
      return doc.toString();
    }
    const body = text.endsWith('\n') ? text : `${text}\n`;
    return `${body}\n${key}:  # ${comment}\n${Object.entries(values).map(([k, v]) => `  ${k}: ${scalar(v)}`).join('\n')}\n`;
  }
  let end = start + 1;
  while (end < lines.length && (/^\s+\S/.test(lines[end]!) || lines[end] === '')) end++;
  while (end > start + 1 && lines[end - 1] === '') end--;
  const indent = /^(\s+)\S/.exec(lines[start + 1] ?? '')?.[1] && end > start + 1 ? /^(\s+)/.exec(lines[start + 1]!)![1]! : '  ';
  for (const [k, v] of Object.entries(values)) {
    const at = lines.slice(start + 1, end).findIndex((line) => line.startsWith(`${indent}${k}:`));
    if (at >= 0) lines[start + 1 + at] = `${indent}${k}: ${scalar(v)}`;
    else lines.splice(end++, 0, `${indent}${k}: ${scalar(v)}`);
  }
  return lines.join('\n');
}

function appendToList(front: string, key: string, names: string[]): string {
  const lines = front.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^${key}:\\s*(#.*)?$`).test(line));
  if (start === -1) {
    const doc = parseDocument(front);
    const seq = doc.get(key, true);
    if (isSeq(seq)) for (const name of names) seq.add(doc.createNode(name));
    return doc.toString().trimEnd();
  }
  let end = start + 1;
  while (end < lines.length && /^\s*- /.test(lines[end]!)) end++;
  const indent = /^(\s*)- /.exec(lines[start + 1] ?? '')?.[1] ?? '  ';
  lines.splice(end, 0, ...names.map((name) => `${indent}- ${name}`));
  return lines.join('\n');
}
