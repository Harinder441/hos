import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import type { ContextLimits } from './api/types.js';

const LINES = ['handoff', 'backstop', 'single_line'] as const;

interface Lines {
  mode: ContextLimits['mode'];
  handoff: number;
  backstop: number;
  single_line: number;
}

export interface ContextPolicy extends Lines {
  workRoot: string;
  agents: Record<string, Partial<Lines>>;
  workspaces: Record<string, Partial<Lines>>;
}

export const DEFAULT_CONTEXT_POLICY: ContextPolicy = {
  mode: 'ladder',
  handoff: 180_000,
  backstop: 250_000,
  single_line: 200_000,
  workRoot: 'work',
  agents: {},
  workspaces: {},
};

export function resolveLimits(policy: ContextPolicy, agent: string, workspaceKeys: string[]): ContextLimits {
  const { agents, workspaces, workRoot: _workRoot, ...global } = policy;
  const workspace = workspaceKeys.map((key) => workspaces[key]).find(Boolean);
  const lines: Lines = { ...global, ...workspace, ...agents[agent] };
  return lines.mode === 'single'
    ? { mode: 'single', handoff: lines.single_line, backstop: lines.backstop }
    : { mode: 'ladder', handoff: lines.handoff, backstop: lines.backstop };
}

export class ContextPolicySource {
  private lastGood = DEFAULT_CONTEXT_POLICY;

  constructor(private readonly file: string | undefined) {}

  current(): ContextPolicy {
    if (!this.file) return this.lastGood;
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return (this.lastGood = DEFAULT_CONTEXT_POLICY);
      throw error;
    }
    try {
      this.lastGood = parseContextPolicy((parse(text) as { context?: unknown } | null)?.context);
    } catch (error) {
      console.error(`ignoring ${this.file}, keeping the last good context policy: ${(error as Error).message}`);
    }
    return this.lastGood;
  }
}

function parseContextPolicy(raw: unknown): ContextPolicy {
  const section = record(raw ?? {}, 'context');
  const workRoot = section.work_root ?? DEFAULT_CONTEXT_POLICY.workRoot;
  if (typeof workRoot !== 'string' || !workRoot || /^[/~]/.test(workRoot) || workRoot.split('/').includes('..')) {
    throw new Error('context.work_root must be a path inside the brain');
  }
  return {
    ...DEFAULT_CONTEXT_POLICY,
    ...parseLines(section, 'context'),
    workRoot: workRoot.replace(/\/+$/, ''),
    agents: parseOverrides(section.agents, 'context.agents'),
    workspaces: parseOverrides(section.workspaces, 'context.workspaces'),
  };
}

function parseOverrides(raw: unknown, at: string): Record<string, Partial<Lines>> {
  return Object.fromEntries(
    Object.entries(record(raw ?? {}, at)).map(([key, value]) => [key, parseLines(record(value, `${at}.${key}`), `${at}.${key}`)]),
  );
}

function parseLines(raw: Record<string, unknown>, at: string): Partial<Lines> {
  const lines: Partial<Lines> = {};
  if (raw.mode !== undefined) {
    if (raw.mode !== 'ladder' && raw.mode !== 'single') throw new Error(`${at}.mode must be ladder or single`);
    lines.mode = raw.mode;
  }
  for (const line of LINES) {
    const value = raw[line];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || (value as number) <= 0) throw new Error(`${at}.${line} must be a positive whole number of tokens`);
    lines[line] = value as number;
  }
  return lines;
}

function record(value: unknown, at: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${at} must be a mapping`);
  return value as Record<string, unknown>;
}
