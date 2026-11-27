import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import type { Chat, MachineReading, Role, SpawnRole, WindowEffect, WindowReadings } from './api/types.js';
import { owner } from './owner.js';

export interface SpawnLimits {
  maxDepth: number;
  maxSpawnsPer10Minutes: number;
  dedupWindowHours: number;
  similarityNeedsApproval: number;
}

export const DEFAULT_SPAWN_LIMITS: SpawnLimits = {
  maxDepth: 2,
  maxSpawnsPer10Minutes: 6,
  dedupWindowHours: 24,
  similarityNeedsApproval: 0.85,
};

const SPAWN_KEYS: Record<string, keyof SpawnLimits> = {
  max_depth: 'maxDepth',
  max_spawns_per_10_minutes: 'maxSpawnsPer10Minutes',
  dedup_window_hours: 'dedupWindowHours',
  similarity_needs_approval: 'similarityNeedsApproval',
};

export function loadSpawnLimits(file: string | undefined): SpawnLimits {
  if (!file || !existsSync(file)) return DEFAULT_SPAWN_LIMITS;
  const doc = parse(readFileSync(file, 'utf8')) as { spawn?: Record<string, unknown> } | null;
  const limits = { ...DEFAULT_SPAWN_LIMITS };
  for (const [key, field] of Object.entries(SPAWN_KEYS)) {
    const value = doc?.spawn?.[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || value < 0) throw new Error(`${file}: spawn.${key} must be a non-negative number`);
    limits[field] = value;
  }
  return limits;
}

export const LIVE_STATES = ['queued', 'starting', 'running', 'idle', 'waiting_input', 'paused', 'handing_off'] as const;
export const BUSY_STATES = ['queued', 'starting', 'running', 'handing_off'] as const;

const WRITERS_MAY_SPAWN: readonly SpawnRole[] = ['main', 'worker', 'reviewer', 'scout'];

const MAY_SPAWN: Record<Role, readonly SpawnRole[]> = {
  main: WRITERS_MAY_SPAWN,
  worker: WRITERS_MAY_SPAWN,
  reviewer: [],
  scout: [],
};

export interface SpawnFacts {
  parent: Chat;
  role: SpawnRole;
  killSwitch: string | null;
  duplicate: Chat | undefined;
  similar: { chat: Chat; score: number } | undefined;
  confirmSimilar: boolean;
  spawnsLast10Minutes: number;
}

export type Admission =
  | { decision: 'spawn'; reason: string }
  | { decision: 'join'; chat: Chat; reason: string }
  | { decision: 'deny'; reason: string };

export function admit(facts: SpawnFacts, limits: SpawnLimits): Admission {
  const { parent, role } = facts;
  if (facts.killSwitch) return deny(`the ${facts.killSwitch} kill switch is on; ${owner()} has stopped new chats`);
  if (!MAY_SPAWN[parent.role].includes(role)) {
    const allowed = MAY_SPAWN[parent.role];
    return deny(
      allowed.length
        ? `a ${parent.role} may only spawn ${allowed.join(' or ')} chats; ask your parent chat or ${owner()} (bus ask) for a ${role}`
        : `a ${parent.role} cannot spawn chats; report back to your parent chat instead`,
    );
  }
  if (parent.depth + 1 > limits.maxDepth) return deny(`max depth is ${limits.maxDepth} and you are at depth ${parent.depth}`);
  if (facts.duplicate) {
    return { decision: 'join', chat: facts.duplicate, reason: `the same intent is already chat ${facts.duplicate.id} (${facts.duplicate.state})` };
  }
  const leads = parent.role === 'main' || parent.role === 'worker';
  if (facts.similar && !(facts.confirmSimilar && leads)) {
    const { chat, score } = facts.similar;
    return deny(
      `the intent is ${Math.round(score * 100)}% similar to chat ${chat.id} ("${chat.intent}"); ${
        leads
          ? 'join that chat, or spawn again with confirm_similar: true if the work really differs'
          : 'ask your parent chat'
      }`,
    );
  }
  if (facts.spawnsLast10Minutes >= limits.maxSpawnsPer10Minutes) {
    return deny(`this topic spawned ${facts.spawnsLast10Minutes} chats in the last 10 minutes (max ${limits.maxSpawnsPer10Minutes}); try again later`);
  }
  return { decision: 'spawn', reason: `admitted at depth ${parent.depth + 1}` };
}

function deny(reason: string): Admission {
  return { decision: 'deny', reason };
}

export function normalizeIntent(intent: string): string {
  return intent.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function intentKey(intent: string): string {
  return createHash('sha256').update(normalizeIntent(intent)).digest('hex');
}

export function similarity(a: string, b: string): number {
  const grams = (text: string) => {
    const padded = `  ${normalizeIntent(text)} `;
    const set = new Set<string>();
    for (let i = 0; i + 3 <= padded.length; i++) set.add(padded.slice(i, i + 3));
    return set;
  };
  const x = grams(a);
  const y = grams(b);
  let shared = 0;
  for (const gram of x) if (y.has(gram)) shared++;
  return shared / (x.size + y.size - shared || 1);
}

export interface GovernorLimits {
  running: Record<string, number>;
  idleSuspendMinutes: number;
  fiveHourSteps: Array<{ atPct: number; effect: WindowEffect }>;
  weeklyBatchOffPct: number;
  peak: { days: string[]; start: string; end: string; timezone: string } | null;
}

export const DEFAULT_GOVERNOR_LIMITS: GovernorLimits = {
  running: { claude: 6 },
  idleSuspendMinutes: 30,
  fiveHourSteps: [
    { atPct: 70, effect: 'cheaper_models' },
    { atPct: 85, effect: 'top_priorities_only' },
    { atPct: 95, effect: 'pause_batch' },
  ],
  weeklyBatchOffPct: 80,
  peak: { days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '05:00', end: '11:00', timezone: 'America/Los_Angeles' },
};

const EFFECTS: WindowEffect[] = ['cheaper_models', 'top_priorities_only', 'pause_batch'];

export function loadGovernorLimits(file: string | undefined): GovernorLimits {
  if (!file || !existsSync(file)) return DEFAULT_GOVERNOR_LIMITS;
  const doc = parse(readFileSync(file, 'utf8')) as { slots?: Record<string, unknown>; provider_windows?: Record<string, unknown> } | null;
  const limits = { ...DEFAULT_GOVERNOR_LIMITS, running: { ...DEFAULT_GOVERNOR_LIMITS.running } };
  const count = (section: string, key: string, value: unknown): number => {
    if (typeof value !== 'number' || value < 0) throw new Error(`${file}: ${section}.${key} must be a non-negative number`);
    return value;
  };
  const slots = doc?.slots ?? {};
  for (const [key, value] of Object.entries(slots)) {
    const pool = /^(\w+)_running$/.exec(key)?.[1];
    if (pool) limits.running[pool] = count('slots', key, value);
  }
  if (slots.idle_suspend_minutes !== undefined) limits.idleSuspendMinutes = count('slots', 'idle_suspend_minutes', slots.idle_suspend_minutes);
  const windows = doc?.provider_windows ?? {};
  if (windows.five_hour_steps !== undefined) {
    if (!Array.isArray(windows.five_hour_steps)) throw new Error(`${file}: provider_windows.five_hour_steps must be a list`);
    limits.fiveHourSteps = windows.five_hour_steps.map((step: { at_pct?: unknown; effect?: unknown }) => {
      if (!EFFECTS.includes(step.effect as WindowEffect)) throw new Error(`${file}: five_hour_steps effect must be one of ${EFFECTS.join(', ')}`);
      return { atPct: count('provider_windows', 'five_hour_steps.at_pct', step.at_pct), effect: step.effect as WindowEffect };
    });
  }
  if (windows.weekly_batch_off_pct !== undefined) {
    limits.weeklyBatchOffPct = count('provider_windows', 'weekly_batch_off_pct', windows.weekly_batch_off_pct);
  }
  if (windows.peak_defer !== undefined) {
    const peak = windows.peak_defer as { days?: string[]; start?: string; end?: string; timezone?: string } | null;
    limits.peak = peak && peak.days && peak.start && peak.end ? { days: peak.days, start: peak.start, end: peak.end, timezone: peak.timezone ?? 'UTC' } : null;
  }
  return limits;
}

export const PRIORITY_BY_ROLE: Record<Role, number> = { main: 1, worker: 2, reviewer: 2, scout: 3 };
export const BATCH_PRIORITY = 4;
export const AGING_MS = 10 * 60_000;

export interface TurnFacts {
  priority: number;
  pool: string;
  running: number;
  parent: boolean;
  reserved: number;
  windows: WindowReadings;
  peak: boolean;
  machine: MachineReading | null;
}

export const LOW_BATTERY_PCT = 25;
export const CRITICAL_BATTERY_PCT = 10;

export function windowStep(windows: WindowReadings, limits: GovernorLimits): WindowEffect | null {
  const pct = windows.fiveHour?.pct ?? 0;
  const reached = limits.fiveHourSteps.filter((step) => pct >= step.atPct).sort((a, b) => b.atPct - a.atPct)[0];
  return reached?.effect ?? null;
}

export function holdReason(facts: TurnFacts, limits: GovernorLimits): string | null {
  const { priority } = facts;
  if (priority === 0) return null;
  if (facts.pool === 'claude') {
    const step = windowStep(facts.windows, limits);
    const fiveHour = Math.round(facts.windows.fiveHour?.pct ?? 0);
    if (step === 'pause_batch' && priority >= BATCH_PRIORITY) return `Claude's 5-hour window is at ${fiveHour}%, so batch work is paused until it resets`;
    if ((step === 'top_priorities_only' || step === 'pause_batch') && priority >= 2) {
      return `Claude's 5-hour window is at ${fiveHour}%, so only P0-P1 run`;
    }
    const weekly = facts.windows.weekly?.pct ?? 0;
    if (priority >= BATCH_PRIORITY && weekly >= limits.weeklyBatchOffPct) {
      return `Claude's weekly window is at ${Math.round(weekly)}%, so batch work is off until it resets`;
    }
    if (priority >= BATCH_PRIORITY && facts.peak) return 'batch work is deferred during the weekday peak hours';
  }
  const max = limits.running[facts.pool] ?? 0;
  const reserved = parentReserve(facts.reserved, max);
  if (!(facts.parent && max > 0) && facts.running + reserved >= max) {
    return `all ${max} ${poolLabel(facts.pool)} slots are running${facts.running < max ? ' or kept for parent chats' : ''}`;
  }
  const machine = facts.machine;
  if (machine) {
    if (machine.memory === 'critical') return 'memory pressure is critical, so only P0 runs';
    if (machine.thermalWarning && priority >= 2) return 'the Mac has a thermal warning, so only P0-P1 run';
    const battery = machine.battery;
    if (battery?.onBattery && battery.percent <= CRITICAL_BATTERY_PCT) return `the battery is at ${battery.percent}%, so only P0 runs`;
    if (battery?.onBattery && battery.percent <= LOW_BATTERY_PCT && priority >= 2) return `the battery is at ${battery.percent}%, so only P0-P1 run`;
  }
  return null;
}

export function poolLabel(pool: string): string {
  return `${pool.charAt(0).toUpperCase()}${pool.slice(1)}`;
}

// At least one slot stays open to children, or a parent could wait forever on children that never start.
export function parentReserve(parents: number, max: number): number {
  return Math.min(parents, Math.max(0, max - 1));
}

export function effectivePriority(priority: number, waitedMs: number): number {
  if (priority === 0) return 0;
  return Math.max(1, priority - Math.floor(waitedMs / AGING_MS));
}

export interface QueuedChat {
  chatId: string;
  topicId: string;
  priority: number;
  since: number;
}

export function dispatchOrder(queue: QueuedChat[], now: number, served: (topicId: string) => number): QueuedChat[] {
  const share = (chat: QueuedChat) => served(chat.topicId);
  return [...queue].sort(
    (a, b) =>
      effectivePriority(a.priority, now - a.since) - effectivePriority(b.priority, now - b.since) ||
      share(a) - share(b) ||
      a.since - b.since,
  );
}

export function inPeak(now: number, peak: GovernorLimits['peak']): boolean {
  if (!peak) return false;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: peak.timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(now))
    .reduce<Record<string, string>>((acc, part) => ({ ...acc, [part.type]: part.value }), {});
  if (!peak.days.includes((parts.weekday ?? '').toLowerCase())) return false;
  const time = `${parts.hour}:${parts.minute}`;
  return time >= peak.start && time < peak.end;
}
