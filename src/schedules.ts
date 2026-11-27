import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Document, isMap, isScalar, parse, parseDocument, Scalar, type YAMLMap } from 'yaml';
import type { ScheduleInput, ScheduleList } from './api/types.js';
import { HosError } from './core.js';
import { fromLocal, localDate, localTime, owner, zoneLabel, zoneOffsetMs } from './owner.js';

export type ScheduleRow = ScheduleInput;

export interface Cron {
  minutes: number[];
  hours: number[];
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  anyDay: boolean;
  anyWeekday: boolean;
}

interface LastRun {
  at: number;
  chatId: string | null;
  topicId: string | null;
  result?: 'done' | 'failed';
  summary?: string;
  skippedTo?: number;
}

export interface SchedulesDeps {
  brainDir: string;
  host: string;
  now: () => number;
  meta: (key: string) => string | undefined;
  setMeta: (key: string, value: string) => void;
  fire: (row: ScheduleRow, text: string) => Promise<{ topicId: string; chatId: string }>;
  profileKnown: (id: string) => boolean;
  alert: (title: string, detail: string) => void;
  commit: (paths: string[], subject: string) => void;
  deskTitle?: () => string;
}

export const SCHEDULES_FILE = 'hos/schedules.yaml';
export const SCHEDULED_RUN_FINISHED = 'Scheduled run finished';
const LAST_META = 'schedule.last.';
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const GRACE_MS = 2 * MINUTE;
const SCAN_DAYS = 8 * 366;
const FIELDS: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron "${expr}" needs 5 fields (minute hour day-of-month month day-of-week)`);
  const [minutes, hours, days, months, weekdays] = parts.map((part, i) => field(part, ...FIELDS[i]!));
  return {
    minutes: [...minutes!].sort((a, b) => a - b),
    hours: [...hours!].sort((a, b) => a - b),
    days: days!,
    months: months!,
    weekdays: new Set([...weekdays!].map((d) => d % 7)),
    anyDay: parts[2]!.startsWith('*'),
    anyWeekday: parts[4]!.startsWith('*'),
  };
}

function field(text: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  for (const item of text.split(',')) {
    const match = /^(?:(\*)|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(item);
    if (!match) throw new Error(`bad cron field "${text}"`);
    const step = match[4] ? Number(match[4]) : 1;
    const from = match[1] ? min : Number(match[2]);
    const to = match[1] ? max : match[3] ? Number(match[3]) : match[4] ? max : from;
    if (from < min || to > max || from > to || step < 1) throw new Error(`cron field "${text}" is outside ${min}-${max}`);
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return values;
}

function dayMatches(cron: Cron, day: Date): boolean {
  if (!cron.months.has(day.getUTCMonth() + 1)) return false;
  const dom = cron.days.has(day.getUTCDate());
  const dow = cron.weekdays.has(day.getUTCDay());
  if (cron.anyDay || cron.anyWeekday) return (cron.anyDay || dom) && (cron.anyWeekday || dow);
  return dom || dow;
}

export function previousRun(cron: Cron, at: number): number | null {
  const shifted = Math.floor((at + zoneOffsetMs(at)) / MINUTE) * MINUTE;
  const today = shifted - (shifted % DAY);
  for (let d = 0; d <= SCAN_DAYS; d++) {
    const day = today - d * DAY;
    if (!dayMatches(cron, new Date(day))) continue;
    for (const hour of [...cron.hours].reverse()) {
      for (const minute of [...cron.minutes].reverse()) {
        const time = day + hour * 60 * MINUTE + minute * MINUTE;
        if (time <= shifted) return fromLocal(time);
      }
    }
  }
  return null;
}

export function nextRun(cron: Cron, at: number): number | null {
  const shifted = Math.floor((at + zoneOffsetMs(at)) / MINUTE) * MINUTE;
  const today = shifted - (shifted % DAY);
  for (let d = 0; d <= SCAN_DAYS; d++) {
    const day = today + d * DAY;
    if (!dayMatches(cron, new Date(day))) continue;
    for (const hour of cron.hours) {
      for (const minute of cron.minutes) {
        const time = day + hour * 60 * MINUTE + minute * MINUTE;
        if (time > shifted) return fromLocal(time);
      }
    }
  }
  return null;
}

export function sameHost(a: string, b: string): boolean {
  const norm = (host: string) => host.trim().toLowerCase().replace(/\.local$/, '');
  return norm(a) === norm(b);
}

export function unattendedHeader(id: string, at: number): string {
  return `Unattended scheduled run (schedule ${id}, ${localDate(at)} ${localTime(at)} ${zoneLabel(at)}) — nobody is watching. Your profile's rules for unattended runs say what you may change; where they say nothing, do research, reports and brain notes only (no merges, deploys, PRs or other-repo edits). Don't wait for plan approval or ask questions — write anything bigger as a plan in your work folder for ${owner()} to approve later. End with a push notification summary.`;
}

function rowProblem(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'a row must be a mapping';
  const row = raw as Record<string, unknown>;
  for (const key of ['id', 'host', 'cron', 'prompt'] as const) {
    if (typeof row[key] !== 'string' || !(row[key] as string).trim()) return `${key} must be a non-empty string`;
  }
  if (row.desk !== undefined && typeof row.desk !== 'boolean') return 'desk must be true or false';
  if (row.topic !== undefined && (typeof row.topic !== 'string' || !row.topic.trim())) return 'topic must be a topic title';
  if (row.desk === true && row.topic !== undefined) return 'give desk or topic, not both';
  if (row.model !== undefined && typeof row.model !== 'string') return 'model must be a string';
  if (row.profile !== undefined && (typeof row.profile !== 'string' || !row.profile.trim())) return 'profile must be a profile id';
  if (row.paused !== undefined && typeof row.paused !== 'boolean') return 'paused must be true or false';
  try {
    parseCron(row.cron as string);
  } catch (error) {
    return (error as Error).message;
  }
  return null;
}

export class Schedules {
  private alertedText: string | null = null;
  private firing = false;

  constructor(private readonly deps: SchedulesDeps) {}

  private read(): { rows: ScheduleRow[]; problems: string[] } {
    const file = join(this.deps.brainDir, SCHEDULES_FILE);
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`reading ${file} failed`, error);
      return { rows: [], problems: [] };
    }
    const problems: string[] = [];
    const rows: ScheduleRow[] = [];
    let raw: unknown;
    try {
      raw = parse(text) ?? [];
    } catch (error) {
      raw = [];
      problems.push(`the file is not valid YAML: ${(error as Error).message}`);
    }
    if (!Array.isArray(raw)) problems.push('the file must be a YAML list of schedules');
    const seen = new Set<string>();
    for (const [i, item] of (Array.isArray(raw) ? raw : []).entries()) {
      const id = (item as { id?: unknown })?.id;
      const problem = rowProblem(item) ?? (seen.has(id as string) ? `id ${String(id)} is used twice` : null);
      if (problem) {
        problems.push(`row ${i + 1}${typeof id === 'string' ? ` (${id})` : ''}: ${problem}`);
        continue;
      }
      seen.add(id as string);
      rows.push(item as ScheduleRow);
      const profile = (item as ScheduleRow).profile;
      if (profile !== undefined && !this.deps.profileKnown(profile)) problems.push(`row ${i + 1} (${String(id)}): profile "${profile}" is unknown, so it runs as generic`);
    }
    if (problems.length) {
      for (const problem of problems) console.error(`${SCHEDULES_FILE}: ${problem}`);
      if (this.alertedText !== text) this.deps.alert(`${SCHEDULES_FILE} has rows hos skipped or runs as generic`, problems.join('\n'));
    }
    this.alertedText = problems.length ? text : null;
    return { rows, problems };
  }

  private local(row: ScheduleRow): boolean {
    return sameHost(row.host, this.deps.host);
  }

  private last(id: string): LastRun | null {
    const value = this.deps.meta(LAST_META + id);
    return value ? (JSON.parse(value) as LastRun) : null;
  }

  private saveLast(id: string, run: LastRun): void {
    this.deps.setMeta(LAST_META + id, JSON.stringify(run));
  }

  async tick(): Promise<void> {
    if (this.firing) return;
    this.firing = true;
    try {
      for (const row of this.read().rows) {
        if (!this.local(row)) continue;
        if (row.paused) this.skip(row);
        else await this.check(row);
      }
    } finally {
      this.firing = false;
    }
  }

  private skip(row: ScheduleRow): void {
    const due = previousRun(parseCron(row.cron), this.deps.now());
    const last = this.last(row.id);
    if (last && due !== null && due > (last.skippedTo ?? last.at)) this.saveLast(row.id, { ...last, skippedTo: due });
  }

  private async check(row: ScheduleRow): Promise<void> {
    const now = this.deps.now();
    const due = previousRun(parseCron(row.cron), now);
    const last = this.last(row.id);
    const fresh = due !== null && (last ? due > Math.max(last.at, last.skippedTo ?? 0) : now - due < GRACE_MS);
    if (!fresh) {
      if (!last) this.saveLast(row.id, { at: now, chatId: null, topicId: null });
      return;
    }
    this.saveLast(row.id, { at: now, chatId: null, topicId: null });
    try {
      const started = await this.deps.fire(row, `${unattendedHeader(row.id, due)}\n\n${row.prompt}`);
      this.started(row.id, now, started);
    } catch (error) {
      console.error(`schedule ${row.id} failed to start`, error);
      this.saveLast(row.id, { at: now, chatId: null, topicId: null, result: 'failed', summary: (error as Error).message });
      this.deps.alert(`Schedule ${row.id} didn’t start`, (error as Error).message);
    }
  }

  private started(id: string, at: number, started: { topicId: string; chatId: string }): void {
    const last = this.last(id);
    const done = last?.chatId === started.chatId && last.result ? { result: last.result, summary: last.summary } : {};
    this.saveLast(id, { at, ...started, ...done });
  }

  finished(id: string, chatId: string, result: 'done' | 'failed', summary: string): void {
    const last = this.last(id);
    if (last && (last.chatId === chatId || last.chatId === null)) this.saveLast(id, { ...last, chatId, result, summary });
  }

  list(): ScheduleList {
    const now = this.deps.now();
    const { rows, problems } = this.read();
    const deskTitle = this.deps.deskTitle?.() ?? 'Quick chats';
    return {
      file: join(this.deps.brainDir, SCHEDULES_FILE),
      host: this.deps.host,
      deskTitle,
      problems,
      schedules: rows.map((row) => {
        const local = this.local(row);
        const last = local ? this.last(row.id) : null;
        const ran = last?.chatId || last?.result ? last : null;
        return {
          ...fields(row),
          local,
          target: row.topic ? `topic "${row.topic}"` : row.desk ? deskTitle : 'new topic',
          nextRun: row.paused ? null : nextRun(parseCron(row.cron), now),
          lastRun: ran?.at ?? null,
          result: ran?.result ?? null,
          summary: ran?.summary ?? null,
          chatId: ran?.chatId ?? null,
          topicId: ran?.topicId ?? null,
        };
      }),
    };
  }

  save(row: ScheduleInput, id?: string): ScheduleList {
    const clean = fields(row);
    const problem = rowProblem(clean);
    if (problem) throw new HosError(400, problem);
    const { doc, items } = this.document();
    const at = id === undefined ? -1 : this.indexOf(items, id);
    if (items.some((item, i) => i !== at && item.get('id') === clean.id)) throw new HosError(409, `a schedule with id ${clean.id} already exists`);
    if (at === -1) {
      const node = doc.createNode(clean) as YAMLMap;
      (node.get('prompt', true) as Scalar).type = Scalar.BLOCK_FOLDED;
      items.push(node);
    } else {
      const item = items[at]!;
      for (const key of KEYS) {
        const value = clean[key];
        const node = item.get(key, true);
        if (value === undefined) item.delete(key);
        else if (isScalar(node)) node.value = value;
        else item.set(key, value);
      }
    }
    return this.write(doc, `${id === undefined ? 'add' : 'edit'} ${clean.id}`);
  }

  pause(id: string, paused: boolean): ScheduleList {
    const { doc, items } = this.document();
    const item = items[this.indexOf(items, id)]!;
    if (paused) item.set('paused', true);
    else item.delete('paused');
    return this.write(doc, `${paused ? 'pause' : 'resume'} ${id}`);
  }

  remove(id: string): ScheduleList {
    const { doc, items } = this.document();
    items.splice(this.indexOf(items, id), 1);
    return this.write(doc, `delete ${id}`);
  }

  async runNow(id: string): Promise<{ topicId: string; chatId: string }> {
    const row = this.read().rows.find((r) => r.id === id);
    if (!row) throw new HosError(404, `no schedule ${id}`);
    if (!this.local(row)) throw new HosError(409, `schedule ${id} runs on ${row.host}; run it from that host`);
    const now = this.deps.now();
    this.saveLast(row.id, { at: now, chatId: null, topicId: null });
    const started = await this.deps.fire(row, `${unattendedHeader(row.id, now)}\n\n${row.prompt}`);
    this.started(row.id, now, started);
    return started;
  }

  private document(): { doc: Document; items: YAMLMap[] } {
    let text = '';
    try {
      text = readFileSync(join(this.deps.brainDir, SCHEDULES_FILE), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const doc: Document = parseDocument(text);
    if (doc.errors.length) throw new HosError(409, `${SCHEDULES_FILE} is not valid YAML; fix it first: ${doc.errors[0]!.message}`);
    doc.contents ??= doc.createNode([]);
    const items = (doc.contents as { items?: unknown[] }).items;
    if (!Array.isArray(items) || !items.every((item) => isMap(item))) throw new HosError(409, `${SCHEDULES_FILE} must be a YAML list of schedules; fix it first`);
    return { doc, items: items as YAMLMap[] };
  }

  private indexOf(items: YAMLMap[], id: string): number {
    const at = items.findIndex((item) => item.get('id') === id);
    if (at === -1) throw new HosError(404, `no schedule ${id}`);
    return at;
  }

  private write(doc: Document, change: string): ScheduleList {
    writeFileSync(join(this.deps.brainDir, SCHEDULES_FILE), doc.toString({ lineWidth: 120 }));
    this.deps.commit([SCHEDULES_FILE], `hos: schedules · ${change}`);
    return this.list();
  }
}

const KEYS = ['id', 'host', 'cron', 'desk', 'topic', 'prompt', 'model', 'profile', 'paused'] as const;

export function sameSchedule(a: ScheduleInput, b: ScheduleInput): boolean {
  return JSON.stringify(fields(a)) === JSON.stringify(fields(b));
}

function fields(row: ScheduleInput): ScheduleInput {
  const out: Record<string, unknown> = {};
  for (const key of KEYS) if (row[key] !== undefined && row[key] !== '' && row[key] !== false) out[key] = row[key];
  return out as unknown as ScheduleInput;
}
