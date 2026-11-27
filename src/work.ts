import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fromLocal, localDate, localTime, zoneLabel } from './owner.js';

export const SECTIONS = ['Goal', 'State', 'Where', 'Decisions', 'Open', 'Tried', 'Leave alone', 'Checks', 'Next step', 'Log'] as const;
export const REQUIRED_SECTIONS = ['Goal', 'State', 'Where', 'Open', 'Next step', 'Log'];
const FIRST_WRITE = ['Goal', 'State', 'Where', 'Next step'];
export const PROGRESS_FILE = 'PROGRESS.md';
export const PROGRESS_CAP = 20_000;
export const PROGRESS_WARN = 8_000;
export const LOG_LINES = 20;
export const DEFAULT_AREA = 'misc';
export const META_DIR = '_meta';

export const PROGRESS_TEMPLATE = `# Progress: <!-- fill: topic title -->

## Goal

<!-- fill: the outcome in 1–2 sentences, not the activity. Changes only when the user changes the goal. -->

## State

As of <!-- fill: YYYY-MM-DD HH:MM and time zone (hos stamps this line) -->
<!-- fill: what is true now, at most 10 lines, one fact per line. A line that turns false is fixed or deleted, never caveated. -->

## Where

- Path: \`<!-- fill: absolute path of the main checkout -->\`
- Branch: \`<!-- fill: branch as git branch --show-current prints it -->\`
<!-- fill: other repos and branches, PRs (number + state), PLAN.md and other key files in this folder, one line each -->

## Decisions

<!-- one line each: \`D3 — decision — reason\`, \`W1–W14 — in PLAN.md\`, or \`here — decision — reason\`. Superseded: keep the line, add \`superseded by D7\`. Delete this section when there are none. -->

## Open

- O1 <!-- fill: questions for the user only, in priority order; work goes in hos tasks (task_create), and a question that blocks a task goes on that task; write \`none\` when empty -->

## Tried

<!-- optional: \`approach — why it failed\`. Delete this section when empty. -->

## Leave alone

<!-- optional: \`path or behaviour — why\`. Delete this section when empty. -->

## Checks

<!-- optional: \`command\` → expected result. The successor runs these before new work. Delete this section when empty. -->

## Next step

<!-- fill: the single first action, concrete enough to start cold; at most 3 lines, pointing at task refs (T2) instead of listing work -->

## Log

<!-- newest first, one line per update: \`YYYY-MM-DD HH:MM zone · chat8 or session · sections touched · note\`. hos writes it inside hos and keeps the newest 20 lines; git keeps the rest. -->
`;

export interface ProgressSection {
  name: string;
  body: string;
}

export interface Progress {
  head: string;
  sections: ProgressSection[];
}

export interface ProgressUpdate {
  sections?: Record<string, string>;
  revs?: Record<string, string>;
  close?: string[];
  add_open?: string[];
  note: string;
}

export type ProgressApplied =
  | { ok: true; text: string; touched: string[] }
  | { ok: false; problems: string[]; stale: Array<ProgressSection & { rev: string }> };

export function readAreas(brainDir: string, workRoot: string): string[] {
  let text: string;
  try {
    text = readFileSync(join(brainDir, workRoot, 'README.md'), 'utf8');
  } catch {
    return [];
  }
  const areas = text.split('\n').flatMap((line) => /^\|\s*`([a-z0-9][a-z0-9._-]*)`\s*\|/.exec(line)?.[1] ?? []);
  return [...new Set(areas)];
}

export function pickArea(areas: string[], wanted: string | null | undefined): string {
  const area = wanted?.trim().toLowerCase();
  return area && areas.includes(area) ? area : DEFAULT_AREA;
}

export function workFolder(workRoot: string, area: string, at: number, name: string): string {
  return `${workRoot}/${area}/${localDate(at)}-${name}`;
}

export function sectionRev(body: string): string {
  return createHash('sha256').update(body).digest('hex').slice(0, 8);
}

export function parseProgress(text: string): Progress {
  const lines = text.split('\n');
  const head: string[] = [];
  const sections: Array<{ name: string; lines: string[] }> = [];
  for (const line of lines) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) sections.push({ name: heading[1]!, lines: [] });
    else if (sections.length) sections.at(-1)!.lines.push(line);
    else head.push(line);
  }
  return { head: head.join('\n').trim(), sections: sections.map((s) => ({ name: s.name, body: s.lines.join('\n').trim() })) };
}

export function renderProgress(progress: Progress): string {
  return `${[progress.head, ...progress.sections.map((s) => `## ${s.name}\n\n${s.body}`)].filter(Boolean).join('\n\n')}\n`;
}

export function sectionOf(progress: Progress, name: string): string | undefined {
  return progress.sections.find((s) => s.name === name)?.body;
}

function setSection(progress: Progress, name: string, body: string | null): void {
  const at = progress.sections.findIndex((s) => s.name === name);
  if (body === null) {
    if (at >= 0) progress.sections.splice(at, 1);
    return;
  }
  if (at >= 0) {
    progress.sections[at]!.body = body;
    return;
  }
  const order = (n: string) => {
    const i = (SECTIONS as readonly string[]).indexOf(n);
    return i < 0 ? SECTIONS.length : i;
  };
  const before = progress.sections.findIndex((s) => order(s.name) > order(name));
  progress.sections.splice(before < 0 ? progress.sections.length : before, 0, { name, body });
}

export function localStamp(at: number): string {
  return `${localDate(at)} ${localTime(at)} ${zoneLabel(at)}`;
}

function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').trim();
}

// author is the chat's first 8 characters, or "hos"; force skips the rev and first-write checks for hos's own writes.
export const NEXT_STEP_ITEMS = 3;
const TASKS_LINE = /^Tasks \d+\/\d+ done\b/;

export function applyProgress(
  current: string | null,
  update: ProgressUpdate,
  author: { who: string; at: number; title: string; force?: boolean; tasksLine?: string | null },
): ProgressApplied {
  const order = (name: string) => (SECTIONS as readonly string[]).indexOf(name);
  const given = Object.entries(update.sections ?? {})
    .map(([name, body]) => ({ name, body: body.trim() }))
    .sort((a, b) => order(a.name) - order(b.name));
  const problems: string[] = [];
  for (const { name } of given) {
    if (name === 'Log') problems.push('Log is written by hos; put your one-line summary in note');
    else if (!(SECTIONS as readonly string[]).includes(name)) problems.push(`unknown section "${name}"; use one of ${SECTIONS.filter((s) => s !== 'Log').join(', ')}`);
  }
  const creating = current === null;
  const progress = parseProgress(creating ? PROGRESS_TEMPLATE : current);
  if (creating) {
    progress.head = `# Progress: ${oneLine(author.title)}`;
    const missing = FIRST_WRITE.filter((name) => !given.some((s) => s.name === name && s.body));
    if (missing.length && !author.force) problems.push(`PROGRESS.md does not exist yet, so this first write must fill Goal, State, Where and Next step (missing: ${missing.join(', ')})`);
  }
  const stale: Array<ProgressSection & { rev: string }> = [];
  if (!creating && !author.force) {
    for (const { name } of given) {
      const body = sectionOf(progress, name);
      if (body && update.revs?.[name] !== sectionRev(body)) stale.push({ name, body, rev: sectionRev(body) });
    }
  }
  for (const { name, body } of given) {
    if (!body && REQUIRED_SECTIONS.includes(name)) problems.push(`${name} is required, so it cannot be emptied`);
    const items = body.split('\n').filter((line) => /^\s*(?:[-*]|\d+[.)])\s+/.test(line)).length;
    if (name === 'Next step' && items > NEXT_STEP_ITEMS && !author.force) {
      problems.push(`Next step lists ${items} items; keep it to at most ${NEXT_STEP_ITEMS} lines that point at task refs, and put the work in tasks with task_create`);
    }
  }
  if (problems.length || stale.length) return { ok: false, problems, stale };

  const touched: string[] = [];
  for (const { name, body } of given) {
    setSection(progress, name, body || null);
    touched.push(name);
  }
  if (given.some((s) => s.name === 'State')) {
    const lines = sectionOf(progress, 'State')!.split('\n').filter((line) => !TASKS_LINE.test(line.trim()));
    const stamp = [`As of ${localStamp(author.at)}`, ...(author.tasksLine ? [author.tasksLine] : [])];
    setSection(progress, 'State', (/^As of\b/.test(lines[0] ?? '') ? [...stamp, ...lines.slice(1)] : [...stamp, ...lines]).join('\n'));
  }

  const opening = (update.close ?? []).length > 0 || (update.add_open ?? []).length > 0;
  if (opening) {
    const existing = sectionOf(progress, 'Open') ?? '';
    let lines = /^none$/i.test(existing.trim()) || existing.includes('<!--') ? [] : existing.split('\n').filter((l) => l.trim());
    for (const id of update.close ?? []) {
      const match = new RegExp(`^(?:[-*]\\s+)?${id.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
      const kept = lines.filter((line) => !match.test(line.trim()));
      if (kept.length === lines.length) problems.push(`Open has no item ${id}`);
      lines = kept;
    }
    let next = Math.max(0, ...lines.map((line) => Number(/^(?:[-*]\s+)?O(\d+)\b/.exec(line.trim())?.[1] ?? 0))) + 1;
    for (const item of update.add_open ?? []) lines.push(`- O${next++} ${oneLine(item)}`);
    if (problems.length) return { ok: false, problems, stale: [] };
    setSection(progress, 'Open', lines.length ? lines.join('\n') : 'none');
    if (!touched.includes('Open')) touched.push('Open');
  }

  if (creating) {
    for (const section of [...progress.sections]) {
      if (section.name === 'Log' || touched.includes(section.name)) continue;
      if (section.name === 'Open') setSection(progress, 'Open', 'none');
      else if (REQUIRED_SECTIONS.includes(section.name)) setSection(progress, section.name, '(not written yet)');
      else setSection(progress, section.name, null);
    }
  }

  const log = (sectionOf(progress, 'Log') ?? '').split('\n').filter((line) => line.trim() && !line.trim().startsWith('<!--'));
  const line = `${localStamp(author.at)} · ${author.who} · ${touched.join(', ') || 'none'} · ${oneLine(update.note) || 'no note'}`;
  setSection(progress, 'Log', [line, ...log].slice(0, LOG_LINES).join('\n'));

  const text = renderProgress(progress);
  if (text.length > PROGRESS_CAP) {
    return {
      ok: false,
      problems: [`PROGRESS.md would be ${text.length} characters; the cap is ${PROGRESS_CAP}, so move detail to a file in WORK_DIR and link it under Where`],
      stale: [],
    };
  }
  return { ok: true, text, touched };
}

export interface LogLine {
  at: number;
  who: string;
  sections: string[];
}

export function parseLogLine(line: string): LogLine | null {
  const match = /^(?:[-*]\s+)?(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) \S+ · ([^·]+?) · ([^·]*?)(?: · |$)/.exec(line.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi, who, sections] = match;
  const at = fromLocal(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi)));
  return { at, who: who!.trim(), sections: sections!.split(',').map((s) => s.trim()).filter(Boolean) };
}

// since is the handoff request time; a Log line has minute precision, so it counts from the start of that minute.
export function progressProblems(text: string, handoff: { chat: string; since: number | null }): string[] {
  const progress = parseProgress(text);
  const problems: string[] = [];
  const missing = REQUIRED_SECTIONS.filter((name) => !sectionOf(progress, name)?.trim());
  if (missing.length) problems.push(`PROGRESS.md is missing or has empty required sections: ${missing.join(', ')}`);
  if (text.includes('<!-- fill')) problems.push('template hints (<!-- fill …) are left in PROGRESS.md');
  if (text.length > PROGRESS_CAP) problems.push(`PROGRESS.md is ${text.length} characters; the cap is ${PROGRESS_CAP}, so move detail to a file in WORK_DIR and link it`);
  const from = handoff.since === null ? -Infinity : handoff.since - (handoff.since % 60_000);
  const fresh = (sectionOf(progress, 'Log') ?? '')
    .split('\n')
    .map(parseLogLine)
    .some((line) => line !== null && line.who === handoff.chat && line.at >= from && line.sections.includes('Next step'));
  if (!fresh) problems.push(`Log has no line from this chat (${handoff.chat}) that updated Next step after the handoff was asked for; update Next step with progress_update`);
  return problems;
}
