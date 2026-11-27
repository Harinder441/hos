import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import { EFFORTS, type HarnessMark, type ModelsConfig } from '../../api/types.js';
import { NO_FEATURES, type Harness } from '../harness.js';
import { AGENT_DEFAULT_MODEL, type AcpConfig } from './config.js';
import { AcpAgentRuntime } from './runtime.js';

export { AcpAgentRuntime } from './runtime.js';
export type { AcpConfig, AcpHooks } from './config.js';

export const HARNESS_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const DEFAULT_ACP_SLOTS = 2;

export const AGENT_DEFAULT_MODELS: ModelsConfig = { default: AGENT_DEFAULT_MODEL, effort: 'high', list: [{ id: AGENT_DEFAULT_MODEL, label: 'Agent default' }] };

const command = z.array(z.string().min(1)).min(1);
const modelsShape = z
  .object({
    default: z.string().min(1).optional(),
    effort: z.enum(EFFORTS).optional(),
    list: z.array(z.object({ id: z.string().regex(/^[\w.:/-]{1,80}$/), label: z.string().trim().min(1) })).min(1),
  })
  .refine((m) => m.default === undefined || m.list.some((c) => c.id === m.default), 'models.default must be one of the ids in models.list');

const settingsShape = z
  .object({
    id: z.string().regex(HARNESS_ID, 'id is lowercase letters, digits and dashes'),
    label: z.string().trim().min(1),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    pool: z.string().regex(HARNESS_ID).optional(),
    slots: z.number().int().min(0).optional(),
    models: modelsShape.optional(),
    modes: z.object({ build: z.string().min(1).optional(), plan: z.string().min(1).optional() }).strict().optional(),
    model_option: z.string().min(1).optional(),
    effort_option: z.string().min(1).optional(),
    memory_files: z.array(z.string().min(1)).optional(),
    terminal: command.optional(),
    login: command.optional(),
    signed_in: command.optional(),
    first_turn_note: z.string().optional(),
    aliases: z.array(z.string().regex(HARNESS_ID)).optional(),
    badge: z
      .object({
        text: z.string().regex(/^\S{1,3}$/).optional(),
        color: z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/).optional(),
        aliases: z.record(z.string().regex(HARNESS_ID), z.string().regex(/^\S{1,3}$/)).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type AcpHarnessSettings = z.infer<typeof settingsShape>;

export interface AcpHarnessSpec {
  id: string;
  label: string;
  pool?: string;
  slots?: number;
  models?: ModelsConfig;
  aliases?: string[];
  badge?: HarnessMark;
  config: AcpConfig;
}

export function acpHarness(spec: AcpHarnessSpec): Harness {
  const runtime = new AcpAgentRuntime(spec.id, spec.config);
  const models = spec.models ?? AGENT_DEFAULT_MODELS;
  return {
    id: spec.id,
    label: spec.label,
    pool: spec.pool ?? spec.id,
    runtime,
    models: () => models,
    slots: spec.slots ?? DEFAULT_ACP_SLOTS,
    features: { ...NO_FEATURES, takeover: runtime.takeover },
    ...(spec.aliases?.length ? { aliases: spec.aliases } : {}),
    ...(spec.badge ? { badge: spec.badge } : {}),
  };
}

export function fromSettings(s: AcpHarnessSettings): AcpHarnessSpec {
  const models = s.models && { default: s.models.default ?? s.models.list[0]!.id, effort: s.models.effort ?? 'high', list: s.models.list };
  return {
    id: s.id,
    label: s.label,
    ...(s.pool ? { pool: s.pool } : {}),
    ...(s.slots !== undefined ? { slots: s.slots } : {}),
    ...(models ? { models } : {}),
    ...(s.aliases ? { aliases: s.aliases } : {}),
    ...(s.badge ? { badge: s.badge } : {}),
    config: {
      name: s.label,
      command: s.command,
      ...(s.args ? { args: s.args } : {}),
      ...(s.env ? { env: s.env } : {}),
      ...(s.memory_files ? { memoryFiles: s.memory_files } : {}),
      ...(s.modes ? { modes: s.modes } : {}),
      ...(s.model_option ? { modelOption: s.model_option } : {}),
      ...(s.effort_option ? { effortOption: s.effort_option } : {}),
      ...(s.terminal ? { terminal: s.terminal } : {}),
      ...(s.login ? { login: s.login } : {}),
      ...(s.signed_in ? { signedIn: s.signed_in } : {}),
      ...(s.first_turn_note ? { firstTurnNote: s.first_turn_note } : {}),
    },
  };
}

export function loadAcpHarnesses(file: string | undefined): { specs: AcpHarnessSpec[]; problems: string[] } {
  if (!file || !existsSync(file)) return { specs: [], problems: [] };
  let list: unknown;
  try {
    list = (parse(readFileSync(file, 'utf8')) as { harnesses?: unknown } | null)?.harnesses;
  } catch (error) {
    return { specs: [], problems: [`${file} does not parse: ${(error as Error).message}`] };
  }
  if (list === undefined || list === null) return { specs: [], problems: [] };
  if (!Array.isArray(list)) return { specs: [], problems: [`${file}: harnesses must be a list of ACP agents ({id, label, command, args, env, …})`] };
  const specs: AcpHarnessSpec[] = [];
  const problems: string[] = [];
  list.forEach((item, i) => {
    const parsed = settingsShape.safeParse(item);
    if (parsed.success) specs.push(fromSettings(parsed.data));
    else problems.push(`${file}: harnesses[${i}] ${parsed.error.issues.map((issue) => `${issue.path.join('.') || 'entry'}: ${issue.message}`).join('; ')}`);
  });
  return { specs, problems };
}
