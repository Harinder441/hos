import { execFile } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { Handoff, HandoffStats } from './api/types.js';
import { tokens } from './bus.js';
import { owner } from './owner.js';
import { progressProblems } from './work.js';

const run = promisify(execFile);

export const HANDOFF_TOKEN_CAP = 15_000;
const PLACEHOLDER = /<[A-Z_]+>|\bTODO\b|\bTBD\b/g;

export async function checkHandoff(
  file: string,
  handoff: { chat: string; since: number | null },
  targetOf = (path: string) => path,
  workspaces: string[] = [],
): Promise<string[]> {
  const text = await readFile(file, 'utf8').catch(() => undefined);
  if (text === undefined) return [`there is no PROGRESS.md at ${file}; write it with progress_update`];
  return [...progressProblems(text, handoff), ...(await checkHandoffText(text, targetOf, workspaces))];
}

export async function checkHandoffText(text: string, targetOf = (path: string) => path, workspaces: string[] = []): Promise<string[]> {
  const problems: string[] = [];
  const placeholders = [...new Set(text.match(PLACEHOLDER) ?? [])];
  if (placeholders.length) problems.push(`leftover placeholders: ${placeholders.join(', ')}`);
  if (tokens(text) > HANDOFF_TOKEN_CAP) {
    problems.push(`it is about ${tokens(text)} tokens; the cap is ${HANDOFF_TOKEN_CAP}, so link the detail instead of copying it`);
  }
  problems.push(...(await checkTarget(text, targetOf, workspaces)));
  return problems;
}

function whereValue(text: string, key: string): string | undefined {
  const m = new RegExp(`^-\\s*${key}:\\s*(?:\`([^\`]+)\`|(\\S+))`, 'm').exec(text);
  return m?.[1] ?? m?.[2];
}

async function checkTarget(text: string, targetOf: (path: string) => string, workspaces: string[]): Promise<string[]> {
  const written = whereValue(text, 'Path');
  const path = written && targetOf(written);
  const branch = whereValue(text, 'Branch');
  if (!path || !branch) return ['the Where section must have a "- Path:" line and a "- Branch:" line'];
  if (!(await stat(path).then((s) => s.isDirectory(), () => false))) return [`the target ${path} does not exist`];
  const has = (dir: string) => run('git', ['-C', dir, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).then(() => true, () => false);
  if (await has(path)) return [];
  for (const workspace of workspaces) if (await has(workspace)) return [];
  const repo = await run('git', ['-C', path, 'rev-parse', '--show-toplevel']).then(({ stdout }) => stdout.trim(), () => path);
  const also = workspaces.length ? ` or in the topic's workspaces (${workspaces.join(', ')})` : '';
  return [`the branch ${branch} does not exist in the git repo at ${repo}${also}`];
}

export interface SalvageInput {
  topic: string;
  chatId: string;
  generation: number;
  reason: string;
  target: string;
  branch: string;
  card: string | null;
  recent: string[];
  date: string;
}

export function salvageHandoff(input: SalvageInput): string {
  return [
    `# Handoff: ${input.topic} (salvage of generation ${input.generation})`,
    '',
    `Mode: continue · Written ${input.date} by hos, because ${input.reason}.`,
    '',
    '## Goal',
    '',
    `Continue the work of chat ${input.chatId} in topic "${input.topic}". It did not write its own handoff, so this one is rebuilt from its card and its last events; check the worktree before trusting it.`,
    '',
    '## Target',
    '',
    `- Path: \`${input.target}\``,
    `- Branch: \`${input.branch}\``,
    `- Before editing, run \`git -C ${input.target} branch --show-current\`; if it differs from the branch above, stop and report.`,
    '',
    '## Card',
    '',
    input.card ?? 'The chat never wrote a card.',
    '',
    '## Git policy',
    '',
    `No commit, no push, no branch switch unless ${owner()} says so.`,
    '',
    '## State so far',
    '',
    ...(input.recent.length ? input.recent.map((summary) => `- ${summary.replace(PLACEHOLDER, '(placeholder)')}`) : ['- No events recorded.']),
    '',
    '## Next step',
    '',
    `Run \`git -C ${input.target} status\` and \`git -C ${input.target} diff\` to see where the work stopped, then continue from the card above.`,
    '',
  ].join('\n');
}

export async function writeNew(dir: string, slug: string, text: string): Promise<string> {
  for (let i = 1; ; i++) {
    const file = join(dir, `${i === 1 ? slug : `${slug}-${i}`}.md`);
    if (await stat(file).then(() => true, () => false)) continue;
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text);
    return file;
  }
}

export function handoffStats(handoffs: Handoff[]): HandoffStats {
  const written = handoffs.filter((h) => h.kind === 'agent').length;
  const bootTokens = handoffs.flatMap((h) => (h.bootTokens === null ? [] : [h.bootTokens]));
  return {
    handoffs: handoffs.length,
    written,
    salvaged: handoffs.length - written,
    successRate: handoffs.length ? written / handoffs.length : null,
    bootTokens,
    averageBootTokens: bootTokens.length ? Math.round(bootTokens.reduce((a, b) => a + b, 0) / bootTokens.length) : null,
  };
}
