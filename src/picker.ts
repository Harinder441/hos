import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { PickerOption, Project, Workspace } from './api/types.js';
import { compareRef, countCommits, worktreeStatus } from './git.js';

export interface WorkspaceRule {
  repo: string;
  use: { kind: 'root' } | { kind: 'branch'; branch: string } | null;
  base: string | null;
  reason: string;
}

export async function loadWorkspaceRules(brainDir: string | undefined): Promise<WorkspaceRule[]> {
  if (!brainDir) return [];
  const text = await readFile(join(brainDir, 'hos', 'workspace-rules.yaml'), 'utf8').catch(() => null);
  if (text === null) return [];
  let doc: unknown;
  try {
    doc = parse(text);
  } catch {
    return [];
  }
  const rules = (doc as { rules?: unknown } | null)?.rules;
  if (!Array.isArray(rules)) return [];
  return rules.flatMap((raw): WorkspaceRule[] => {
    const rule = raw as { repo?: unknown; use?: unknown; base?: unknown; reason?: unknown };
    if (typeof rule.repo !== 'string') return [];
    const said = typeof rule.use === 'string' ? rule.use.trim() : '';
    const branch = /^branch:(.+)$/.exec(said)?.[1]?.trim();
    const use = said === 'root' ? ({ kind: 'root' } as const) : branch ? ({ kind: 'branch', branch } as const) : null;
    const base = typeof rule.base === 'string' && rule.base.trim() ? rule.base.trim() : null;
    if (!use && !base) return [];
    const reason = typeof rule.reason === 'string' && rule.reason.trim() ? rule.reason.trim() : use ? `use ${said}` : `base ${base}`;
    return [{ repo: rule.repo.trim(), use, base, reason }];
  });
}

export function ruleFor(rules: WorkspaceRule[], project: Project): WorkspaceRule | undefined {
  const names = [project.key, project.name].flatMap((n) => (n ? [n.toLowerCase()] : []));
  return rules.find((rule) => names.includes(rule.repo.toLowerCase()));
}

export async function optionState(path: string, branch: string | null, base: string | null, root: boolean, workspace: Workspace | undefined): Promise<{ state: string; warn: boolean }> {
  if (workspace?.setup === 'pending' || workspace?.setup === 'running') return { state: 'setting up…', warn: false };
  if (workspace?.setup === 'failed') return { state: 'setup failed', warn: true };
  const status = await worktreeStatus(path, branch);
  if (status.dirty) return { state: 'uncommitted changes', warn: true };
  if (status.unpushed > 0) return { state: 'unpushed commits', warn: true };
  if (root) {
    if (status.upstream && status.behind) return { state: `behind ${status.upstream}`, warn: true };
    return { state: 'clean', warn: false };
  }
  if (base && branch !== base) {
    base = await compareRef(path, base);
    const behind = await countCommits(path, 'HEAD', base).catch(() => 0);
    if (behind > 0) return { state: `behind ${base}`, warn: true };
    const ahead = await countCommits(path, base, 'HEAD').catch(() => 0);
    if (ahead > 0 && status.upstream) return { state: 'pushed, no PR', warn: true };
  }
  return { state: 'clean', warn: false };
}

export function namedOption(options: PickerOption[], suggest: string | undefined): PickerOption | undefined {
  const wanted = suggest?.trim();
  if (!wanted) return undefined;
  if (wanted === 'root') return options.find((o) => o.kind === 'root');
  return options.find((o) => o.value === wanted || o.value === `path:${wanted}` || o.branch === wanted || o.path === wanted);
}

export function suggestedValue(options: PickerOption[], suggest: string | undefined, topicId: string): string {
  const named = namedOption(options, suggest);
  if (named) return named.value;
  if (suggest?.trim() === 'root') return 'new';
  return options.find((o) => o.usedBy.some((u) => u.topicId === topicId))?.value ?? 'new';
}

export function branchSlug(why: string): string {
  const words = why.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  let out = '';
  for (const word of words) {
    const next = out ? `${out}-${word}` : word;
    if (next.length > 32) break;
    out = next;
  }
  return out || 'work';
}

export function branchProblem(branch: string): string | null {
  if (!branch) return 'Name the branch';
  if (!/^[\w./-]+$/.test(branch) || branch.startsWith('-') || branch.includes('..') || branch.endsWith('/') || branch.endsWith('.lock')) {
    return `${branch} is not a valid branch name`;
  }
  return null;
}
