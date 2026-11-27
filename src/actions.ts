import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import type { ActionDef, ActionList } from './api/types.js';

const ActionsFile = z.strictObject({
  version: z.literal(1),
  setup: z
    .strictObject({ run: z.string().min(1), does: z.string().min(1).optional(), skip: z.array(z.string().min(1)).default([]) })
    .optional(),
  actions: z.array(
    z.strictObject({
      name: z.string().regex(/^[a-z][a-z0-9-]*$/).max(32),
      run: z.string().min(1),
      args: z
        .array(z.string().regex(/^[a-z][a-z0-9_]*$/))
        .refine((args) => new Set(args).size === args.length, 'args must be unique')
        .default([]),
      where: z.enum(['host', 'tmux']),
      cwd: z.string().regex(/^(worktree|brain|\/.*)$/),
      confirm: z.boolean(),
      passkey: z.boolean().optional(),
      label: z.string().min(1).max(60).optional(),
      applies_to: z.union([z.literal('all'), z.array(z.string().min(1)).min(1)]).default('all'),
      hosts: z.array(z.string().min(1)).min(1).optional(),
    }),
  ).default([]),
});

export type ActionsFileContent = z.infer<typeof ActionsFile>;

export interface Execution {
  done: Promise<number | null>;
  stop(): void;
}

export function actionCommand(action: ActionDef, args: Record<string, unknown>): string {
  const unknown = Object.keys(args).filter((key) => !action.args.includes(key));
  if (unknown.length) throw new Error(`${action.name} takes no ${unknown.join(', ')} argument`);
  const values = action.args.map((key) => {
    const value = args[key];
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${action.name} needs ${key}`);
    return `'${value.replaceAll("'", `'\\''`)}'`;
  });
  return [action.run, ...values].join(' ');
}

export function runOnHost(command: string, cwd: string, env: NodeJS.ProcessEnv, onOutput: (text: string) => void): Execution {
  const child = spawn('/bin/sh', ['-c', command], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  child.stdout.setEncoding('utf8').on('data', onOutput);
  child.stderr.setEncoding('utf8').on('data', onOutput);
  const done = new Promise<number | null>((resolve) => {
    child.on('error', (error) => {
      onOutput(`${error.message}\n`);
      resolve(null);
    });
    child.on('close', (code) => resolve(code));
  });
  return {
    done,
    stop: () => {
      try {
        process.kill(-child.pid!, 'SIGTERM');
      } catch {}
    },
  };
}

export function tmuxScript(command: string, log: string, exit: string): string {
  const q = (path: string) => `'${path.replaceAll("'", `'\\''`)}'`;
  return `{ (${command}) 2>&1; echo $? > ${q(`${exit}.tmp`)}; } | tee ${q(log)}; mv ${q(`${exit}.tmp`)} ${q(exit)}`;
}

export function followLog(log: string, exit: string, alive: () => Promise<boolean>, onOutput: (text: string) => void): Execution {
  let stopped = false;
  let offset = 0;
  const drain = async () => {
    const text = await readFile(log).catch(() => Buffer.alloc(0));
    if (text.length > offset) onOutput(text.subarray(offset).toString('utf8'));
    offset = Math.max(offset, text.length);
  };
  const done = (async () => {
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, FOLLOW_MS));
      if (stopped) return null;
      await drain();
      const code = await readFile(exit, 'utf8').catch(() => undefined);
      if (code !== undefined) {
        await drain();
        return Number(code.trim());
      }
      if (!(await alive())) {
        await drain();
        const late = await readFile(exit, 'utf8').catch(() => undefined);
        return late === undefined ? null : Number(late.trim());
      }
    }
  })();
  return { done, stop: () => void (stopped = true) };
}

const FOLLOW_MS = 200;

export const REPO_ACTIONS_FILE = join('.hos', 'actions.yaml');

export function brainActionsFile(brainDir: string): string {
  return join(brainDir, 'hos', 'actions.yaml');
}

export function readActionsFile(file: string): { content: ActionsFileContent | null; error: string | null } {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { content: null, error: null };
  }
  try {
    const parsed = ActionsFile.safeParse(parse(text));
    if (parsed.success) return { content: parsed.data, error: null };
    return { content: null, error: `${file}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'file'} ${i.message}`).join('; ')}` };
  } catch (error) {
    return { content: null, error: `${file}: ${(error as Error).message}` };
  }
}

export const hostKey = (name: string) => name.toLowerCase().replace(/\.local$/, '');

export function loadActions(brainDir: string | undefined, worktreePath: string, repos?: string[], host = hostname()): ActionList {
  const errors: string[] = [];
  const read = (file: string, source: ActionDef['source']): ActionDef[] => {
    const { content, error } = readActionsFile(file);
    if (error) errors.push(error);
    return (content?.actions ?? [])
      .filter(({ applies_to }) => !repos || applies_to === 'all' || applies_to.some((name) => repos.includes(name)))
      .filter(({ hosts }) => !hosts || hosts.some((name) => hostKey(name) === hostKey(host)))
      .map(({ label: _label, applies_to: _appliesTo, passkey: _passkey, hosts: _hosts, ...action }) => ({ ...action, source }));
  };
  const byName = new Map<string, ActionDef>();
  const global = brainDir ? read(join(brainDir, 'hos', 'actions.yaml'), 'brain') : [];
  for (const action of [...global, ...read(join(worktreePath, REPO_ACTIONS_FILE), 'repo')]) byName.set(action.name, action);
  return { actions: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), errors };
}
