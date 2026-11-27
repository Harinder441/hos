import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';
import { parse } from 'yaml';
import { readActionsFile } from '../actions.js';
import { DEFAULT_CONTEXT_POLICY } from '../context.js';
import { loadGovernorLimits, loadSpawnLimits } from '../governor.js';
import { loadAcpHarnesses } from '../harnesses/acp/index.js';
import {
  loadCloudflareConfig,
  loadComposer,
  loadCrossChatShare,
  loadDeskOrigins,
  loadHiddenSkills,
  loadMcpServers,
  loadModels,
  loadOwnerSettings,
  loadPluginEntries,
  loadPolicy,
  loadRepoRoots,
  loadRetentionDays,
  loadTransportName,
} from '../policy.js';
import { IDENTITY_FILES, PROFILE_ID } from '../profiles.js';
import { hosRoot } from './common.js';
import { hosSkillNames } from './skills.js';

const BUNDLED = ['dataviz', 'claude-api', 'code-review'];

const RETIRED: Array<{ path: string[]; why: string }> = [
  { path: ['cell_egress'], why: 'cells are gone' },
  { path: ['isolation'], why: 'cells and taint are gone' },
  { path: ['trusted_web_domains'], why: 'taint is gone' },
  { path: ['trusted_mcp_servers'], why: 'taint is gone' },
  { path: ['context', 'codex_offset'], why: 'the Codex harness is gone' },
  { path: ['slots', 'live_cells'], why: 'cells are gone' },
  { path: ['slots', 'heavy_jobs'], why: 'nothing reads it' },
  { path: ['provider_windows', 'overflow_agent'], why: 'the Codex harness is gone' },
  { path: ['approvals', '*', 'lane_u'], why: 'sandboxed chats are gone' },
  { path: ['approvals', '*', 'tainted'], why: 'taint is gone' },
  { path: ['approvals', '*', 'ask_from_roles'], why: 'those roles are gone' },
];

export interface ValidateOptions {
  home?: string;
  root?: string;
}

export interface ValidateResult {
  ok: boolean;
  lines: string[];
}

export function validateBrain(brain: string, options: ValidateOptions = {}): ValidateResult {
  const root = options.root ?? hosRoot();
  const home = options.home ?? homedir();
  const lines: string[] = [];
  let ok = true;
  const report = (file: string, errors: string[], warnings: string[] = []) => {
    for (const w of warnings) lines.push(`warn  ${file}: ${w}`);
    if (errors.length === 0) lines.push(`ok    ${file}`);
    else {
      ok = false;
      for (const e of errors) lines.push(`FAIL  ${file}: ${e}`);
    }
  };
  if (!existsSync(brain)) return { ok: false, lines: [`FAIL  ${brain}: no such folder`] };

  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const schema = (name: string) => ajv.compile(JSON.parse(readFileSync(join(root, 'schemas', name), 'utf8')) as object);

  const policyFile = join(brain, 'hos', 'policy.yaml');
  if (!existsSync(policyFile)) lines.push('skip  hos/policy.yaml: none, so hos uses its defaults');
  else {
    const read = readYaml(policyFile);
    if ('error' in read) report('hos/policy.yaml', [read.error]);
    else {
      const warnings = stripRetired(read.data);
      const validate = schema('policy.schema.json');
      const errors = validate(read.data) ? [...policyChecks(read.data as PolicyDoc), ...loaderErrors(policyFile)] : schemaErrors(validate.errors);
      for (const entry of loadPluginEntries(policyFile).entries) {
        if (!existsSync(join(brain, 'hos', 'plugins', entry.file))) warnings.push(`plugins: ${entry.file} is not in hos/plugins/, so hos skips it`);
      }
      report('hos/policy.yaml', [...new Set(errors)], warnings);
    }
  }

  const actionsFile = join(brain, 'hos', 'actions.yaml');
  if (!existsSync(actionsFile)) lines.push('skip  hos/actions.yaml: none');
  else {
    const read = readYaml(actionsFile);
    if ('error' in read) report('hos/actions.yaml', [read.error]);
    else {
      const validate = schema('actions.schema.json');
      const errors = validate(read.data) ? duplicateActions(read.data as { actions: Array<{ name: string }> }) : schemaErrors(validate.errors);
      const loaded = errors.length ? null : readActionsFile(actionsFile).error;
      report('hos/actions.yaml', loaded ? [loaded] : errors);
    }
  }

  for (const name of ['schedules.yaml', 'workspace-rules.yaml']) {
    const file = join(brain, 'hos', name);
    if (!existsSync(file)) continue;
    const read = readYaml(file);
    report(`hos/${name}`, 'error' in read ? [read.error] : []);
  }

  const installed = new Set([...skillNames(join(brain, '.claude', 'skills')), ...skillNames(join(home, '.claude', 'skills')), ...BUNDLED]);
  const hosOwned = new Set(hosSkillNames(root));
  const profilesDir = join(brain, 'profiles');
  const entries = existsSync(profilesDir) ? readdirSync(profilesDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)) : [];
  if (!entries.length) lines.push('skip  profiles/: none, so every chat runs the built-in generic profile');
  const profileSchema = schema('profile.schema.json');
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'README.md') {
      report(`profiles/${entry.name}`, [`old layout: move it to profiles/${entry.name.replace(/\.md$/, '')}/PROFILE.md beside ${IDENTITY_FILES.join(', ')}`]);
      continue;
    }
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dir = join(profilesDir, entry.name);
    const rel = `profiles/${entry.name}/PROFILE.md`;
    let data: Record<string, unknown>;
    try {
      data = frontmatter(readFileSync(join(dir, 'PROFILE.md'), 'utf8'));
    } catch (error) {
      report(rel, [(error as Error).message]);
      continue;
    }
    if (!profileSchema(data)) {
      report(rel, schemaErrors(profileSchema.errors));
      continue;
    }
    const errors = PROFILE_ID.test(basename(dir)) ? [] : ['the folder name must be a lowercase id like lead (letters, digits, -)'];
    for (const name of IDENTITY_FILES) if (!existsSync(join(dir, name))) errors.push(`${name}: missing beside PROFILE.md`);
    const names = [...(Array.isArray(data.skills) ? (data.skills as string[]) : []), ...(typeof data.handoff_skill === 'string' ? [data.handoff_skill] : [])];
    for (const name of names) {
      if (installed.has(name)) continue;
      errors.push(hosOwned.has(name) ? `skills: "${name}" is a hos skill that is not in .claude/skills yet; run hos skills sync` : `skills: "${name}" is not installed in .claude/skills`);
    }
    report(rel, errors);
  }

  const claudeMd = join(brain, 'CLAUDE.md');
  if (existsSync(claudeMd)) {
    const missing = readFileSync(claudeMd, 'utf8')
      .split('\n')
      .map((line) => /^@(\S+)\s*$/.exec(line)?.[1])
      .filter((path): path is string => !!path && !existsSync(join(brain, path)));
    report('CLAUDE.md', [], missing.map((path) => `@${path} does not exist, so chats load nothing for that line`));
  }
  return { ok, lines };
}

type PolicyDoc = {
  context?: Record<string, unknown> & { agents?: Record<string, Record<string, unknown>>; workspaces?: Record<string, Record<string, unknown>> };
  ports?: { from: number; to: number };
};

function readYaml(file: string): { data: unknown } | { error: string } {
  try {
    return { data: parse(readFileSync(file, 'utf8')) ?? {} };
  } catch (error) {
    return { error: `YAML: ${(error as Error).message.split('\n')[0]!.replace(/:$/, '')}` };
  }
}

function stripRetired(doc: unknown): string[] {
  const walk = (node: unknown, path: string[]): number => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return 0;
    const map = node as Record<string, unknown>;
    const [head, ...rest] = path;
    let found = 0;
    for (const key of head === '*' ? Object.keys(map) : [head!]) {
      if (!(key in map)) continue;
      if (rest.length) found += walk(map[key], rest);
      else {
        delete map[key];
        found++;
      }
    }
    return found;
  };
  return RETIRED.flatMap(({ path, why }) => {
    const found = walk(doc, path);
    return found ? [`${path.join('.')}${found > 1 ? ` (${found} places)` : ''}: hos no longer reads this key (${why}); delete it`] : [];
  });
}

function policyChecks(p: PolicyDoc): string[] {
  const { agents = {}, workspaces = {}, ...global } = p.context ?? {};
  const base = { ...DEFAULT_CONTEXT_POLICY, ...global };
  const errors = lineOrder('context', base);
  for (const [a, o] of Object.entries(agents)) errors.push(...lineOrder(`context.agents.${a}`, { ...base, ...o }));
  for (const [w, o] of Object.entries(workspaces)) errors.push(...lineOrder(`context.workspaces.${w}`, { ...base, ...o }));
  if (p.ports && p.ports.to <= p.ports.from) errors.push(`ports.to: ${p.ports.to} must be above ports.from (${p.ports.from})`);
  return errors;
}

function lineOrder(scope: string, c: Record<string, unknown>): string[] {
  const [lo, hi] = c.mode === 'single' ? ['single_line', 'backstop'] : ['handoff', 'backstop'];
  return Number(c[hi!]) <= Number(c[lo!]) ? [`${scope}.${hi}: ${c[hi!]} must be above ${lo} (${c[lo!]})`] : [];
}

function loaderErrors(file: string): string[] {
  const errors: string[] = [];
  const attempt = (load: () => unknown) => {
    try {
      load();
    } catch (error) {
      errors.push((error as Error).message.replace(`${file}: `, ''));
    }
  };
  attempt(() => loadPolicy(file));
  attempt(() => loadOwnerSettings(file));
  attempt(() => loadRepoRoots(file));
  attempt(() => loadRetentionDays(file));
  attempt(() => loadModels(file));
  attempt(() => loadComposer(file));
  attempt(() => loadHiddenSkills(file));
  attempt(() => loadMcpServers(file));
  attempt(() => loadCrossChatShare(file));
  attempt(() => loadDeskOrigins(file));
  attempt(() => loadGovernorLimits(file));
  attempt(() => loadSpawnLimits(file));
  attempt(() => loadTransportName(file) === 'cloudflare' && loadCloudflareConfig(file));
  const plugins = loadPluginEntries(file).problem;
  if (plugins) errors.push(plugins.replace(`${file}: `, ''));
  errors.push(...loadAcpHarnesses(file).problems.map((p) => p.replace(`${file}: `, '')));
  return errors;
}

function duplicateActions(a: { actions: Array<{ name: string }> }): string[] {
  const seen = new Set<string>();
  return a.actions.flatMap((x, i) => (seen.has(x.name) ? [`actions.${i}.name: duplicate name "${x.name}"`] : (seen.add(x.name), [])));
}

function schemaErrors(errors: ErrorObject[] | null | undefined): string[] {
  const keyOf = (path: string) => path.slice(1).replaceAll('/', '.') || '(root)';
  return (errors ?? [])
    .filter((e) => !e.schemaPath.includes('/propertyNames/'))
    .map((e) => {
      const at = keyOf(e.instancePath);
      const p = e.params as Record<string, unknown>;
      if (e.keyword === 'additionalProperties') return `${keyOf(`${e.instancePath}/${String(p.additionalProperty)}`)}: unknown key`;
      if (e.keyword === 'required') return `${keyOf(`${e.instancePath}/${String(p.missingProperty)}`)}: missing`;
      if (e.keyword === 'propertyNames') return `${keyOf(`${e.instancePath}/${String(p.propertyName)}`)}: key not allowed here`;
      if (e.keyword === 'enum') return `${at}: must be one of ${(p.allowedValues as unknown[]).join(', ')}`;
      return `${at}: ${e.message}`;
    });
}

export function frontmatter(text: string): Record<string, unknown> {
  const block = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text)?.[1];
  if (block === undefined) throw new Error('no frontmatter: the file must start with a --- block that has at least description');
  return (parse(block) as Record<string, unknown> | null) ?? {};
}

function skillNames(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = join(root, entry.name, 'SKILL.md');
    if (!entry.isDirectory() || !existsSync(file)) return [];
    try {
      const name = frontmatter(readFileSync(file, 'utf8')).name;
      return [typeof name === 'string' && name.trim() ? name.trim() : entry.name];
    } catch {
      return [entry.name];
    }
  });
}
