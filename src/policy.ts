import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parse } from 'yaml';
import { hostKey } from './actions.js';
import type { CloudflareConfig } from './adapters/cloudflare-transport.js';
import { AGENT_TOOLS, EDIT_TOOL_FIELDS, READ_TOOLS, SHELL_TOOLS, WEB_TOOLS } from './harnesses/tools.js';
import { EFFORTS, type ActionClass, type ComposerConfig, type Effort, type ModelsConfig, type PolicyOutcome } from './api/types.js';
import { defaultOwnerSettings, validTimezone, type OwnerSettings } from './owner.js';

const CLASSES: ActionClass[] = ['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A5w', 'A6', 'A6b', 'A7', 'A8'];
const OUTCOMES: PolicyOutcome[] = ['auto', 'ask', 'ask_every_time', 'deny'];
const RANK: Record<PolicyOutcome, number> = { auto: 0, ask: 1, ask_every_time: 2, deny: 3 };
const NAMES: Record<ActionClass, string> = {
  A0: 'read',
  A1: 'spawn_read_only',
  A2: 'spawn_writer',
  A3: 'local_write',
  A4: 'network_install',
  A5: 'publish',
  A5w: 'publish_work',
  A6: 'outward_comms',
  A6b: 'ping_own_phone',
  A7: 'prod_secrets_aws',
  A8: 'brain_config',
};

interface ClassRule {
  name: string;
  lane_t: PolicyOutcome;
}

export const PRESETS = ['ask_first', 'balanced', 'auto'] as const;
export type Preset = (typeof PRESETS)[number];
export const DEFAULT_PRESET: Preset = 'balanced';

export const PLUGIN_EDITS = ['follow', 'ask_every_time'] as const;
export type PluginEdits = (typeof PLUGIN_EDITS)[number];

export type Policy = Record<ActionClass, ClassRule> & {
  unclassified: PolicyOutcome;
  pluginEdits?: PluginEdits;
  workRemotes?: string[];
  preset?: Preset;
  readOnlyMcp?: string[];
  scriptClasses?: Array<[string, ActionClass]>;
};

const PRESET_RULES: Record<Preset, (c: ActionClass) => PolicyOutcome> = {
  ask_first: (c) => (c === 'A0' ? 'auto' : c === 'A5' || c === 'A5w' || c === 'A7' ? 'ask_every_time' : 'ask'),
  balanced: (c) => (['A0', 'A1', 'A3'].includes(c) ? 'auto' : ['A5', 'A5w', 'A6', 'A7'].includes(c) ? 'ask_every_time' : 'ask'),
  auto: (c) => (['A5', 'A5w', 'A6', 'A7'].includes(c) ? 'ask' : 'auto'),
};

export function presetPolicy(preset: Preset): Policy {
  return {
    ...Object.fromEntries(CLASSES.map((c) => [c, { name: NAMES[c], lane_t: PRESET_RULES[preset](c) }])),
    unclassified: 'ask',
  } as Policy;
}

export const FALLBACK_POLICY = presetPolicy('ask_first');

export function loadPolicy(file: string): Policy | undefined {
  if (!existsSync(file)) return undefined;
  const doc = parse(readFileSync(file, 'utf8')) as {
    version?: unknown;
    approvals?: Record<string, Partial<ClassRule>> & { unclassified?: unknown; preset?: unknown; plugin_edits?: unknown };
    work_remotes?: unknown;
    read_only_mcp?: unknown;
    script_classes?: unknown;
  } | null;
  if (doc?.version !== undefined && doc.version !== 1) throw new Error(`${file}: version must be 1`);
  const extras = {
    workRemotes: loadWorkRemotes(file, doc?.work_remotes),
    readOnlyMcp: loadReadOnlyMcp(file, doc?.read_only_mcp),
    scriptClasses: loadScriptClasses(file, doc?.script_classes),
  };
  const approvals = doc?.approvals;
  if (approvals !== undefined && !isPlainMap(approvals)) throw new Error(`${file}: approvals must be a map`);
  const preset = approvals?.preset ?? (approvals ? undefined : DEFAULT_PRESET);
  if (preset !== undefined && !PRESETS.includes(preset as Preset)) throw new Error(`${file}: approvals.preset must be one of ${PRESETS.join(', ')}`);
  const base = preset ? presetPolicy(preset as Preset) : undefined;
  const unclassified = approvals?.unclassified ?? base?.unclassified ?? FALLBACK_POLICY.unclassified;
  if (!OUTCOMES.includes(unclassified as PolicyOutcome)) throw new Error(`${file}: approvals.unclassified must be one of ${OUTCOMES.join(', ')}`);
  const pluginEdits = approvals?.plugin_edits ?? 'follow';
  if (!PLUGIN_EDITS.includes(pluginEdits as PluginEdits)) throw new Error(`${file}: approvals.plugin_edits must be one of ${PLUGIN_EDITS.join(', ')}`);
  const policy = { unclassified, pluginEdits, ...extras, ...(preset ? { preset } : {}) } as Policy;
  for (const c of CLASSES) {
    // A file written before A5w split from A5 keeps A5's rule for it.
    const rule = approvals?.[c] ?? (c === 'A5w' && approvals?.A5 ? { ...approvals.A5, name: NAMES.A5w } : base?.[c]);
    if (!OUTCOMES.includes(rule?.lane_t as PolicyOutcome)) {
      throw new Error(`${file}: approvals.${c}.lane_t must be one of ${OUTCOMES.join(', ')}${preset ? '' : ', or set approvals.preset'}`);
    }
    policy[c] = { name: rule!.name ?? NAMES[c], lane_t: rule!.lane_t! };
  }
  return policy;
}

function loadReadOnlyMcp(file: string, list: unknown): string[] {
  if (list === undefined) return [];
  if (!Array.isArray(list) || !list.every((item) => typeof item === 'string' && /^[\w-]+$/.test(item.trim()))) {
    throw new Error(`${file}: read_only_mcp must be a list of MCP server names, like my-docs`);
  }
  return list.map((item: string) => item.trim());
}

function loadScriptClasses(file: string, map: unknown): Array<[string, ActionClass]> {
  if (map === undefined) return [];
  if (!isPlainMap(map) || !Object.entries(map).every(([match, c]) => match.trim() && CLASSES.includes(c as ActionClass))) {
    throw new Error(`${file}: script_classes must map part of a script path to an action class (${CLASSES.join(', ')}), like "deploy/": A5`);
  }
  return Object.entries(map).map(([match, c]) => [match.trim(), c as ActionClass]);
}

function loadWorkRemotes(file: string, list: unknown): string[] {
  if (list === undefined) return [];
  if (!Array.isArray(list) || !list.every((item) => typeof item === 'string' && /^[\w.-]+\/[\w.-]+$/.test(item.trim()))) {
    throw new Error(`${file}: work_remotes must be a list of host/owner, like github.com/my-company`);
  }
  return list.map((item: string) => item.trim().toLowerCase());
}

function readDoc(file: string | undefined): Record<string, unknown> | null {
  if (!file || !existsSync(file)) return null;
  const doc = parse(readFileSync(file, 'utf8')) as unknown;
  return isPlainMap(doc) ? doc : null;
}

export function loadOwnerSettings(file: string | undefined): OwnerSettings {
  const settings = defaultOwnerSettings();
  const block = readDoc(file)?.owner;
  if (block === undefined) return settings;
  if (!isPlainMap(block)) throw new Error(`${file}: owner must be a map with name, timezone, timezone_label, words and mishears`);
  const { name, timezone, timezone_label: label, words, mishears } = block;
  const text = (value: unknown, key: string, max: number) => {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new Error(`${file}: owner.${key} must be text of at most ${max} characters`);
    return value.trim();
  };
  settings.name = text(name, 'name', 60);
  const zone = text(timezone, 'timezone', 60);
  if (zone && !validTimezone(zone)) throw new Error(`${file}: owner.timezone must be an IANA zone like Europe/Berlin`);
  if (zone) settings.timezone = zone;
  settings.timezoneLabel = text(label, 'timezone_label', 12);
  if (settings.timezoneLabel && /\s|·/.test(settings.timezoneLabel)) throw new Error(`${file}: owner.timezone_label must be one word, like CET`);
  if (words !== undefined) {
    if (!Array.isArray(words) || !words.every((word) => typeof word === 'string' && word.trim())) throw new Error(`${file}: owner.words must be a list of names`);
    settings.words = words.map((word: string) => word.trim());
  }
  if (mishears !== undefined) {
    if (!isPlainMap(mishears) || !Object.entries(mishears).every(([heard, meant]) => /^[\w'-]+$/.test(heard) && typeof meant === 'string' && meant.trim())) {
      throw new Error(`${file}: owner.mishears must map a misheard word to the word meant`);
    }
    settings.mishears = Object.fromEntries(Object.entries(mishears).map(([heard, meant]) => [heard, (meant as string).trim()]));
  }
  return settings;
}

export function loadRepoRoots(file: string | undefined, home = homedir()): string[] | undefined {
  const list = readDoc(file)?.repo_roots;
  if (list === undefined) return undefined;
  if (!Array.isArray(list) || !list.length || !list.every((item) => typeof item === 'string' && item.trim())) throw new Error(`${file}: repo_roots must be a list of folders`);
  return list.map((item: string) => {
    const path = item.trim();
    return path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : resolve(path);
  });
}

export const DEFAULT_RETENTION_DAYS = 0;

export function loadRetentionDays(file: string | undefined): number {
  const block = readDoc(file)?.events;
  if (block === undefined) return DEFAULT_RETENTION_DAYS;
  const days = isPlainMap(block) ? block.retention_days : undefined;
  if (days === undefined) return DEFAULT_RETENTION_DAYS;
  if (!Number.isInteger(days) || (days as number) < 0) throw new Error(`${file}: events.retention_days must be a whole number of days, 0 to keep everything`);
  return days as number;
}

export const FALLBACK_MODELS: ModelsConfig = {
  default: 'claude-opus-5-5',
  effort: 'high',
  list: [
    { id: 'claude-opus-5-5', label: 'Opus 5.5' },
    { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
    { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
  ],
};

export function loadModels(file: string | undefined): ModelsConfig {
  if (!file || !existsSync(file)) return FALLBACK_MODELS;
  const block = (parse(readFileSync(file, 'utf8')) as { models?: { default?: unknown; effort?: unknown; list?: unknown } } | null)?.models;
  if (block === undefined) return FALLBACK_MODELS;
  const list = block?.list;
  if (!Array.isArray(list) || !list.length) throw new Error(`${file}: models.list must be a list of {id, label}`);
  const choices = list.map((item: { id?: unknown; label?: unknown }, i) => {
    if (typeof item?.id !== 'string' || !/^[\w.:-]{1,80}$/.test(item.id)) throw new Error(`${file}: models.list[${i}].id must be a model id`);
    if (typeof item.label !== 'string' || !item.label.trim()) throw new Error(`${file}: models.list[${i}].label must be a name to show`);
    return { id: item.id, label: item.label.trim() };
  });
  const fallback = choices[0]!.id;
  const chosen = block.default ?? fallback;
  if (!choices.some((choice) => choice.id === chosen)) throw new Error(`${file}: models.default must be one of the ids in models.list`);
  const effort = block.effort ?? FALLBACK_MODELS.effort;
  if (!EFFORTS.includes(effort as Effort)) throw new Error(`${file}: models.effort must be one of ${EFFORTS.join(', ')}`);
  return { default: chosen as string, effort: effort as Effort, list: choices };
}

export const FALLBACK_COMPOSER: ComposerConfig = { pasteAsFileChars: 200 };

export function loadComposer(file: string | undefined): ComposerConfig {
  if (!file || !existsSync(file)) return FALLBACK_COMPOSER;
  const chars = (parse(readFileSync(file, 'utf8')) as { composer?: { paste_as_file_chars?: unknown } } | null)?.composer?.paste_as_file_chars;
  if (chars === undefined) return FALLBACK_COMPOSER;
  if (!Number.isInteger(chars) || (chars as number) < 1) throw new Error(`${file}: composer.paste_as_file_chars must be a whole number above 0`);
  return { pasteAsFileChars: chars as number };
}

export function loadHiddenSkills(file: string | undefined): string[] {
  if (!file || !existsSync(file)) return [];
  const list = (parse(readFileSync(file, 'utf8')) as { skills?: { hide?: unknown } } | null)?.skills?.hide;
  if (list === undefined) return [];
  if (!Array.isArray(list) || !list.every((name) => typeof name === 'string' && name.trim())) throw new Error(`${file}: skills.hide must be a list of skill names`);
  return list as string[];
}

export function skillHidden(hide: string[], name: string): boolean {
  return hide.some((pattern) => (pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern));
}

export interface McpServerConfig {
  name: string;
  url: string;
  keySecret: string | null;
}

export function loadMcpServers(file: string | undefined, host = hostname()): McpServerConfig[] {
  if (!file || !existsSync(file)) return [];
  const block = (parse(readFileSync(file, 'utf8')) as { mcp_servers?: unknown } | null)?.mcp_servers;
  if (block === undefined) return [];
  if (!isPlainMap(block)) throw new Error(`${file}: mcp_servers must be a map of server name to {url, key_secret}`);
  return Object.entries(block).map(([name, server]) => {
    // "hos" is the bus every chat already gets; a second server by that name would replace it.
    if (!/^[a-z0-9-]+$/.test(name) || name === 'hos') throw new Error(`${file}: mcp_servers.${name} must be named with lowercase letters, digits and dashes, and not hos`);
    const { url, key_secret: secrets } = (isPlainMap(server) ? server : {}) as { url?: unknown; key_secret?: unknown };
    if (typeof url !== 'string' || URL.parse(url)?.protocol !== 'https:') throw new Error(`${file}: mcp_servers.${name}.url must be an https URL`);
    if (!isPlainMap(secrets) || !Object.values(secrets).every((secret) => typeof secret === 'string' && /^[A-Z0-9_]+$/.test(secret))) {
      throw new Error(`${file}: mcp_servers.${name}.key_secret must map each hostname to a secret name like MCP_KEY_MAC`);
    }
    const mine = Object.entries(secrets).find(([machine]) => hostKey(machine) === hostKey(host));
    return { name, url, keySecret: (mine?.[1] as string | undefined) ?? null };
  });
}

function isPlainMap(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function loadCrossChatShare(file: string | undefined): number | undefined {
  if (!file || !existsSync(file)) return undefined;
  const share = (parse(readFileSync(file, 'utf8')) as { budgets?: { cross_chat_context_share?: unknown } } | null)?.budgets?.cross_chat_context_share;
  if (share === undefined) return undefined;
  if (typeof share !== 'number' || share <= 0 || share > 1) throw new Error(`${file}: budgets.cross_chat_context_share must be a number above 0 and at most 1`);
  return share;
}

export function loadPluginEntries(file: string | undefined): { entries: Array<{ file: string; options: Record<string, unknown> }>; problem: string | null } {
  if (!file || !existsSync(file)) return { entries: [], problem: null };
  let list: unknown;
  try {
    list = (parse(readFileSync(file, 'utf8')) as { plugins?: unknown } | null)?.plugins;
  } catch (error) {
    return { entries: [], problem: `${file} does not parse: ${(error as Error).message}` };
  }
  if (list === undefined || list === null) return { entries: [], problem: null };
  const shape = `${file}: plugins must be a list of file names in the brain's hos/plugins/, or of {file, options}`;
  if (!Array.isArray(list)) return { entries: [], problem: shape };
  const entries: Array<{ file: string; options: Record<string, unknown> }> = [];
  for (const item of list) {
    if (typeof item === 'string' && item) entries.push({ file: item, options: {} });
    else if (isPlainMap(item) && typeof item.file === 'string' && item.file && (item.options === undefined || isPlainMap(item.options))) {
      entries.push({ file: item.file, options: (item.options as Record<string, unknown> | undefined) ?? {} });
    } else return { entries, problem: shape };
  }
  return { entries, problem: null };
}

export function loadDeskOrigins(file: string | undefined): string[] {
  if (!file || !existsSync(file)) return [];
  const origins = (parse(readFileSync(file, 'utf8')) as { desk?: { origins?: unknown } } | null)?.desk?.origins;
  if (origins === undefined) return [];
  if (!Array.isArray(origins) || !origins.every((o) => typeof o === 'string' && /^https?:\/\/[^/\s]+$/.test(o))) {
    throw new Error(`${file}: desk.origins must be a list of origins like https://example.com`);
  }
  return origins as string[];
}

const TRANSPORTS = ['tailscale', 'cloudflare'] as const;

export function loadTransportName(file: string): (typeof TRANSPORTS)[number] | 'loopback' {
  if (!existsSync(file)) return 'loopback';
  const transport = (parse(readFileSync(file, 'utf8')) as { transport?: unknown } | null)?.transport;
  if (transport === undefined) return 'loopback';
  if (!TRANSPORTS.includes(transport as never)) throw new Error(`${file}: transport must be one of ${TRANSPORTS.join(', ')}`);
  return transport as (typeof TRANSPORTS)[number];
}

const CLOUDFLARE_KEYS = ['team', 'aud', 'hostname', 'previews', 'email'] as const;

export function loadCloudflareConfig(file: string): CloudflareConfig {
  const block = ((parse(readFileSync(file, 'utf8')) as { cloudflare?: Record<string, unknown> } | null)?.cloudflare ?? {}) as Record<string, unknown>;
  const missing = CLOUDFLARE_KEYS.filter((key) => typeof block[key] !== 'string' || !block[key]);
  if (missing.length) throw new Error(`${file}: transport cloudflare needs ${missing.map((key) => `cloudflare.${key}`).join(', ')}`);
  if (!String(block.previews).includes('{port}')) throw new Error(`${file}: cloudflare.previews must contain {port}, like hos-{port}.example.com`);
  return Object.fromEntries(CLOUDFLARE_KEYS.map((key) => [key, block[key]])) as unknown as CloudflareConfig;
}

export interface PolicyContext {
  cwd: string;
  roots: string[];
  brainDir?: string;
  configDir?: string;
}

export interface Verdict {
  actionClass: ActionClass | null;
  outcome: PolicyOutcome;
  reason: string;
  outside?: string[];
}

interface Judging extends PolicyContext {
  outside: string[];
  pluginCode: boolean;
  workRemotes: string[];
  readOnlyMcp: string[];
  scriptClasses: Array<[string, ActionClass]>;
}

interface Part {
  actionClass: ActionClass | null;
  key: string;
}

export function evaluate(policy: Policy, tool: string, input: unknown, context: PolicyContext): Verdict {
  const ctx: Judging = {
    ...context,
    outside: [],
    pluginCode: false,
    workRemotes: policy.workRemotes ?? [],
    readOnlyMcp: policy.readOnlyMcp ?? [],
    scriptClasses: policy.scriptClasses ?? [],
  };
  const classified = classify(tool, input, ctx);
  const parts = classified.map((part) => ({
    ...part,
    outcome: part.actionClass ? policy[part.actionClass].lane_t : policy.unclassified,
  }));
  const raise = ctx.pluginCode && policy.pluginEdits === 'ask_every_time';
  if (raise) parts.push({ actionClass: 'A8', key: 'A8', outcome: RANK[policy.A8.lane_t] > RANK.ask_every_time ? policy.A8.lane_t : 'ask_every_time' });
  const worst = parts.reduce((a, b) => (RANK[b.outcome] > RANK[a.outcome] ? b : a));
  const plugin = raise && worst.actionClass === 'A8' ? ' (plug-in code, the plugins list or harnesses)' : '';
  const label = worst.actionClass ? `${worst.actionClass} ${policy[worst.actionClass].name}${plugin}` : `unclassified ${worst.key}`;
  return {
    actionClass: worst.actionClass,
    outcome: worst.outcome,
    reason: `${label}: ${worst.outcome}`,
    ...(ctx.outside.length ? { outside: [...new Set(ctx.outside)] } : {}),
  };
}

export function insideAny(roots: string[], path: string): boolean {
  const target = canonical(path);
  return roots.some((root) => inside(canonical(root), target));
}

export function canonical(path: string, hops = 0): string {
  const missing: string[] = [];
  for (let probe = resolve(path); ; probe = dirname(probe)) {
    try {
      return join(realpathSync.native(probe), ...missing.reverse());
    } catch {
      const link = hops < 40 && lstatSync(probe, { throwIfNoEntry: false })?.isSymbolicLink();
      if (link) return canonical(join(resolve(dirname(probe), readlinkSync(probe)), ...missing.reverse()), hops + 1);
      if (dirname(probe) === probe) return resolve(path);
      missing.push(basename(probe));
    }
  }
}

function classify(tool: string, input: unknown, ctx: Judging): Part[] {
  const one = (actionClass: ActionClass | null): Part[] => [{ actionClass, key: actionClass ?? tool }];
  const fields = (input ?? {}) as Record<string, unknown>;
  if (READ_TOOLS.includes(tool)) return one('A0');
  if (WEB_TOOLS.includes(tool)) return one('A4');
  if (AGENT_TOOLS.includes(tool)) return one('A1');
  const field = EDIT_TOOL_FIELDS[tool];
  if (field) {
    const path = String(fields[field] ?? '');
    const actionClass = pathClass(path, ctx.cwd, ctx, false);
    const abs = resolvePath(ctx.cwd, path);
    if (abs && isPolicyFile(abs, ctx.brainDir) && changesPlugins(tool, fields, abs)) ctx.pluginCode = true;
    return one(actionClass);
  }
  if (SHELL_TOOLS.includes(tool)) return classifyBash(String(fields.command ?? ''), typeof fields.cwd === 'string' && isAbsolute(fields.cwd) ? fields.cwd : ctx.cwd, ctx);
  if (/^mcp__.*(send|schedule|post)_(message|email|mail)$/.test(tool)) return one('A6');
  const server = /^mcp__([\w-]+?)__.+__(search|read|list[a-z_]*|get[a-z_]*)$/.exec(tool)?.[1];
  if (server && ctx.readOnlyMcp.includes(server)) return one('A0');
  return one(null);
}

function resolvePath(base: string | undefined, path: string): string | undefined {
  const expanded = expandPath(path);
  if (!expanded || /[$`]/.test(expanded) || (base === undefined && !isAbsolute(expanded))) return undefined;
  return resolve(base ?? '/', expanded);
}

function expandPath(path: string): string {
  return expandVars(path.replace(/^~(?=\/|$)/, homedir()));
}

function expandVars(text: string): string {
  const env: Record<string, string> = { HOME: homedir(), TMPDIR: process.env.TMPDIR || tmpdir() };
  return text.replace(/\$(?:\{(HOME|TMPDIR)\}|(HOME|TMPDIR)(?!\w))/g, (_, braced, bare) => env[braced ?? bare]!);
}

export function inside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function pathClass(path: string, base: string | undefined, ctx: Judging, blind = true): ActionClass | null {
  const abs = resolvePath(base, path);
  if (!abs) {
    ctx.outside.push(path || '(command substitution)');
    return null;
  }
  if (isPluginCode(abs, ctx.brainDir) || (blind && isPolicyFile(abs, ctx.brainDir))) ctx.pluginCode = true;
  if (isBrainConfig(abs, ctx.brainDir)) return 'A8';
  if (insideAny(ctx.configDir ? [...ctx.roots, ctx.configDir] : ctx.roots, abs)) return 'A3';
  ctx.outside.push(abs);
  return null;
}

function isBrainConfig(abs: string, brainDir: string | undefined): boolean {
  if (inside(join(homedir(), '.claude'), abs)) return true;
  if (!brainDir) return false;
  return (
    ['shared', 'profiles', '.claude', 'hos'].some((dir) => inside(join(brainDir, dir), abs)) ||
    ['CLAUDE.md', 'AGENTS.md'].some((file) => abs === join(brainDir, file))
  );
}

// The daemon runs plug-in code with its own rights; approvals.plugin_edits can make changing it or its list ask every time.
function isPluginCode(abs: string, brainDir: string | undefined): boolean {
  return !!brainDir && inside(join(brainDir, 'hos', 'plugins'), abs);
}

function isPolicyFile(abs: string, brainDir: string | undefined): boolean {
  return !!brainDir && dirname(abs) === join(brainDir, 'hos') && /^policy(\.[\w.-]+)?\.yaml$/.test(basename(abs));
}

function changesPlugins(tool: string, fields: Record<string, unknown>, abs: string): boolean {
  let before = '';
  try {
    before = readFileSync(abs, 'utf8');
  } catch {}
  const edit = (text: string, change: Record<string, unknown>) => {
    const from = String(change.old_string ?? '');
    const to = String(change.new_string ?? '');
    if (!from) return text;
    return change.replace_all === true ? text.split(from).join(to) : text.replace(from, () => to);
  };
  let after: string;
  if (tool === 'Write') after = String(fields.content ?? '');
  else if (tool === 'Edit') after = edit(before, fields);
  else if (tool === 'MultiEdit' && Array.isArray(fields.edits)) after = (fields.edits as Array<Record<string, unknown>>).reduce(edit, before);
  else return true;
  return pluginsList(before) !== pluginsList(after);
}

function pluginsList(text: string): string {
  try {
    const doc = parse(text) as { plugins?: unknown; harnesses?: unknown; approvals?: unknown } | null;
    return JSON.stringify([doc?.plugins ?? null, doc?.harnesses ?? null, doc?.approvals ?? null]);
  } catch {
    return 'unreadable';
  }
}

function worstClass(classes: Array<ActionClass | null>): ActionClass | null {
  if (classes.includes(null)) return null;
  return (classes as ActionClass[]).reduce((a, b) => (CLASSES.indexOf(b) > CLASSES.indexOf(a) ? b : a));
}

const WRAPPERS = new Set(['env', 'nohup', 'time', 'nice', 'command', 'exec', 'xargs']);
const SHELLS = new Set(['bash', 'sh', 'zsh']);

function classifyBash(command: string, cwd: string, ctx: Judging): Part[] {
  let base: string | undefined = cwd;
  const parts: Part[] = [];
  const vars = new Map<string, string>();
  const pieces = splitOutsideQuotes(
    expandVars(command)
      .replace(/\d*>&\d+/g, ' ')
      .replace(/&>>?/g, ' > '),
  );
  for (let p = 0; p < pieces.length; p += 2) {
    const segment = pieces[p]!;
    const substituted = pieces[p + 1] === '$(' || pieces[p + 1] === '`';
    const raw = segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
    const tokens = raw.map((t) => unquote(t.startsWith("'") ? t : substitute(t, vars)));
    const args: string[] = [];
    const targets: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const redirect = /^["']/.test(raw[i]!) ? null : /^\d*>>?(.*)$/.exec(tokens[i]!);
      if (redirect) targets.push(redirect[1] || tokens[++i] || '');
      else if (tokens[i] === '<') i++;
      else args.push(tokens[i]!);
    }
    const assigned: string[] = [];
    while (args.length && (/^[A-Za-z_]\w*=/.test(args[0]!) || WRAPPERS.has(args[0]!))) assigned.push(args.shift()!);
    const cmd = args.shift();
    if (!cmd) {
      for (const a of assigned) {
        const [, name, value] = /^([A-Za-z_]\w*)=(.*)$/.exec(a) ?? [];
        if (!name) continue;
        if (substituted || /[$`]/.test(value!)) vars.delete(name);
        else vars.set(name, unquote(value!));
      }
      continue;
    }
    if (cmd === 'for') vars.delete(args[0] ?? '');
    if (SHELLS.has(cmd) && args[0] === '-c') {
      parts.push(...classifyBash(args[1] ?? '', base ?? cwd, ctx));
      continue;
    }
    if (cmd === 'cd') {
      base = resolvePath(base, args[0] ?? '~');
      continue;
    }
    if (substituted && FILE_COMMANDS.has(basename(cmd))) ctx.outside.push('(command substitution)');
    const commandClass = classifyCommand(cmd, args, base, ctx);
    const redirects = targets.filter((t) => t !== '/dev/null').map((t) => pathClass(t, base, ctx));
    const actionClass = worstClass([commandClass, ...redirects]);
    parts.push({ actionClass, key: actionClass ?? `Bash:${basename(cmd)}` });
  }
  return parts.length ? parts : [{ actionClass: 'A0', key: 'A0' }];
}

const SHELL_OP = /\|\||&&|\$\(|[;|&\n(){}`]/y;

function splitOutsideQuotes(text: string): string[] {
  const pieces: string[] = [];
  const open: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const state = open.at(-1);
    if (state === "'") {
      if (c === "'") open.pop();
      continue;
    }
    if (state === '"' && c === '"') {
      open.pop();
      continue;
    }
    SHELL_OP.lastIndex = i;
    const op = SHELL_OP.exec(text)?.[0];
    if (state === '"' && op !== '$(' && op !== '`') continue;
    if (state !== '"' && (c === '"' || c === "'")) {
      open.push(c);
      continue;
    }
    if (!op) continue;
    if (op === '$(' || op === '(') open.push('(');
    else if (op === ')' && state === '(') open.pop();
    pieces.push(text.slice(start, i), op);
    i += op.length - 1;
    start = i + 1;
  }
  pieces.push(text.slice(start));
  return pieces;
}

function unquote(token: string): string {
  return token.replace(/^(["'])(.*)\1$/, '$2');
}

function substitute(token: string, vars: ReadonlyMap<string, string>): string {
  return token.replace(/\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/g, (whole, braced, bare) => vars.get(braced ?? bare) ?? whole);
}

const READ_COMMANDS = new Set(
  'ls cat head tail wc pwd echo printf grep egrep rg which type file stat du df tree date true false basename dirname realpath readlink sort uniq cut tr jq diff cmp sleep test [ ps uname whoami hostname id printenv'.split(
    ' ',
  ),
);
const FILE_COMMANDS = new Set(['mkdir', 'touch', 'cp', 'mv', 'rm', 'rmdir', 'ln', 'chmod']);
const COPY_COMMANDS = new Set(['cp', 'ln']);
const INSTALLERS = new Set(['npx', 'bunx', 'pip', 'pip3', 'uv', 'brew', 'cargo', 'gem', 'wget', 'curl']);
const DEPLOYERS = new Set(['vercel', 'netlify', 'firebase']);
const PROD_TOOLS = new Set(['security', 'op', 'terraform', 'kubectl', 'eb']);
const GIT_READ = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'blame', 'describe', 'shortlog', 'grep', 'reflog', 'remote', 'branch', 'worktree']);
const GIT_NETWORK = new Set(['fetch', 'pull', 'clone', 'submodule', 'ls-remote']);
const GIT_LOCAL = new Set([
  'add', 'commit', 'checkout', 'switch', 'restore', 'reset', 'stash', 'merge', 'rebase', 'cherry-pick', 'revert', 'tag', 'mv', 'rm', 'init', 'apply', 'am', 'clean', 'branch', 'worktree',
]);
const PUBLISH_SCRIPT = /deploy|publish|release|push/;

function classifyCommand(cmd: string, args: string[], base: string | undefined, ctx: Judging): ActionClass | null {
  const name = basename(cmd);
  const paths = (list: string[]) => (list.length ? worstClass(list.map((p) => pathClass(p, base, ctx))) : null);
  const operands = args.filter((a) => !a.startsWith('-'));
  if (READ_COMMANDS.has(name)) return 'A0';
  if (name === 'find') return args.some((a) => /^-(exec|execdir|delete|ok|okdir|fprint)/.test(a)) ? null : 'A0';
  const writes = (list: string[]) => {
    for (const operand of list) {
      const abs = resolvePath(base, operand);
      if (abs && (isPluginCode(abs, ctx.brainDir) || isPolicyFile(abs, ctx.brainDir))) ctx.pluginCode = true;
    }
  };
  if (name === 'sed') {
    if (!args.some((a) => a.startsWith('-i'))) return 'A0';
    writes(operands);
    return null;
  }
  if (name === 'tee') writes(operands);
  if (FILE_COMMANDS.has(name)) return paths(COPY_COMMANDS.has(name) ? operands.slice(-1) : operands);
  if (name === 'git') return gitClass(args, base, ctx);
  if (name === 'gh') return ghClass(operands, args, base, ctx.workRemotes);
  if (name === 'aws') return awsClass(operands);
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(name)) return packageClass(operands, base, ctx);
  if (INSTALLERS.has(name)) return args.some((a) => /hooks\.slack\.com|slack\.com\/api/.test(a)) ? 'A6' : 'A4';
  if (name === 'wrangler') return operands[0] === 'secret' ? 'A7' : 'A5';
  if (DEPLOYERS.has(name)) return 'A5';
  if (name === 'docker') return operands[0] === 'push' ? 'A5' : null;
  if (PROD_TOOLS.has(name)) return 'A7';
  if (name === 'mail' || name === 'sendmail') return 'A6';
  return scriptClass(SHELLS.has(name) ? (operands[0] ?? '') : cmd, ctx.scriptClasses);
}

function scriptClass(script: string, classes: Array<[string, ActionClass]>): ActionClass | null {
  const listed = classes.find(([match]) => script.includes(match));
  if (listed) return listed[1];
  if (basename(script) === 'secret.sh') return 'A7';
  return null;
}

function gitClass(args: string[], base: string | undefined, ctx: Judging): ActionClass | null {
  let dir = base;
  while (args[0] === '-C') {
    dir = resolvePath(dir, args[1] ?? '');
    args = args.slice(2);
  }
  const [sub, ...rest] = args;
  if (!sub || sub.startsWith('-')) return null;
  if (sub === 'push') return publishClass(dir, rest.find((a) => !a.startsWith('-')) ?? 'origin', ctx.workRemotes);
  if (GIT_NETWORK.has(sub)) return 'A4';
  const listing = rest.length === 0 || rest.every((a) => /^(-v|-vv|-a|-r|--list|--all|list)$/.test(a));
  if (GIT_READ.has(sub) && (listing || !GIT_LOCAL.has(sub))) return sub === 'remote' && !listing ? null : 'A0';
  if (!GIT_LOCAL.has(sub) || dir === undefined) return null;
  if (insideAny(ctx.roots, dir)) return 'A3';
  ctx.outside.push(dir);
  return null;
}

function ghClass(operands: string[], args: string[], base: string | undefined, workRemotes: string[]): ActionClass | null {
  const [group, verb] = operands;
  if (group === 'api') return null;
  if (group === 'auth') return verb === 'status' ? 'A0' : 'A7';
  if (['view', 'list', 'status', 'diff', 'checks', 'search'].includes(verb ?? '') || group === 'status' || group === 'search') return 'A0';
  const flag = args.findIndex((a) => a === '-R' || a === '--repo');
  const repo = flag >= 0 ? args[flag + 1] : args.find((a) => a.startsWith('--repo='))?.slice('--repo='.length);
  return publishClass(base, repo === undefined ? 'origin' : repo.includes('github.com') ? repo : `github.com/${repo}`, workRemotes);
}

const remoteUrls = new Map<string, string>();

function isWorkRemote(url: string, workRemotes: string[]): boolean {
  const lower = url.toLowerCase();
  return workRemotes.some((prefix) => {
    const [host, owner] = prefix.split('/');
    return lower.includes(`${host}:${owner}/`) || lower.includes(`${host}/${owner}/`);
  });
}

function publishClass(dir: string | undefined, remote: string, workRemotes: string[]): ActionClass {
  if (!workRemotes.length) return 'A5';
  if (/[:/]/.test(remote)) return isWorkRemote(remote, workRemotes) ? 'A5w' : 'A5';
  if (dir === undefined) return 'A5w';
  const key = `${dir}\0${remote}`;
  if (!remoteUrls.has(key)) {
    let url = '';
    try {
      url = execFileSync('git', ['-C', dir, 'config', '--get', `remote.${remote}.url`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {}
    remoteUrls.set(key, url);
  }
  return isWorkRemote(remoteUrls.get(key)!, workRemotes) ? 'A5w' : 'A5';
}

function awsClass(operands: string[]): ActionClass | null {
  const [service, op = ''] = operands;
  if (!service || ['secretsmanager', 'ssm', 'kms', 'iam', 'sts', 'configure'].includes(service)) return 'A7';
  if (service === 's3' && op === 'ls') return 'A0';
  return /^(describe-|list-|get-|lookup-|filter-|tail$)/.test(op) ? 'A0' : 'A7';
}

function packageClass(operands: string[], base: string | undefined, ctx: Judging): ActionClass | null {
  const [sub = 'install', script = ''] = operands;
  if (sub === 'publish') return 'A5';
  if (['i', 'install', 'ci', 'add', 'update', 'upgrade', 'remove', 'uninstall', 'dlx', 'x'].includes(sub)) return 'A4';
  if (sub === 'test' || sub === 't') return base !== undefined && insideAny(ctx.roots, base) ? 'A3' : null;
  if (sub === 'run' || sub === 'run-script') {
    if (PUBLISH_SCRIPT.test(script)) return 'A5';
    return base !== undefined && insideAny(ctx.roots, base) ? 'A3' : null;
  }
  return PUBLISH_SCRIPT.test(sub) ? 'A5' : null;
}
