import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { isMap, isPair, isScalar, isSeq, parseDocument, type Node, type YAMLMap } from 'yaml';
import type { ActionClass, OwnerInfo, PolicyOutcome, ProfileInfo, Setting, SettingsPage, SettingsSection, SourcesInfo } from './api/types.js';
import { validateCommand } from './cli/common.js';
import type { PluginReport } from './plugins/loader.js';
import { FALLBACK_POLICY, loadPolicy, loadRetentionDays, type Policy } from './policy.js';

export const FALLBACK_MODELS = {
  default: 'claude-opus-5-5',
  effort: 'high',
  list: [
    { id: 'claude-opus-5-5', label: 'Opus 5.5' },
    { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
    { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
  ],
};

const LIMITS = ['slots', 'spawn', 'budgets', 'provider_windows'];
const CONNECTION = ['transport', 'cloudflare'];
const RESTART = ['transport', 'ports', 'cloudflare', 'budgets.cross_chat_context_share', 'mcp_servers', 'plugins', 'repo_roots', 'owner'];
const APPROVAL_KEYS = ['approvals', 'work_remotes', 'read_only_mcp', 'script_classes'];
const SHOWN = ['version', 'context', 'composer', 'models', 'owner', 'repo_roots', 'events', 'mcp_servers', 'plugins', 'ports', ...LIMITS, ...CONNECTION, ...APPROVAL_KEYS];

const CLASS_LABELS: Record<ActionClass, string> = {
  A0: 'Read files and search',
  A1: 'Start a helper chat that only reads',
  A2: 'Start a helper chat that edits',
  A3: 'Edit files in your projects',
  A4: 'Use the web, install packages',
  A5: 'Publish: push, open a pull request, deploy',
  A5w: 'Publish to a repo other people share',
  A6: 'Send messages to people',
  A6b: 'Notify your own phone',
  A7: 'Secrets and production',
  A8: 'Change hos settings, profiles and skills',
};
const OUTCOME_WORDS: Record<PolicyOutcome, string> = { auto: 'Runs', ask: 'Asks', ask_every_time: 'Asks every time', deny: 'Refused' };
const PRESET_WORDS: Record<string, string> = { ask_first: 'Ask first', balanced: 'Balanced', auto: 'Auto' };
const TRANSPORT_WORDS: Record<string, string> = { loopback: 'This computer only', tailscale: 'Tailscale', cloudflare: 'Cloudflare Tunnel' };

export interface SettingsHarness {
  label: string;
  signedIn: boolean | null;
  models: number;
}

export interface SettingsInputs {
  policyFile: string | undefined;
  brainDir: string | undefined;
  dataDir?: string;
  version?: string;
  transport: string;
  url: string | null;
  port: number;
  repoRoots?: string[];
  worktreePorts?: { from: number; to: number };
  harnesses?: SettingsHarness[];
  profiles?: ProfileInfo[];
  plugins?: PluginReport[];
  sources?: SourcesInfo;
  passkeys?: string[];
  owner?: OwnerInfo;
  hostPolicy?: string | null;
}

export function settingsPage(inputs: SettingsInputs): SettingsPage {
  const { brainDir } = inputs;
  const where = (file: string | undefined) => (file && brainDir ? relative(brainDir, file) : (file ?? null));
  const policyName = where(inputs.policyFile);
  const policy = readMap(inputs.policyFile);
  const actionsFile = brainDir ? join(brainDir, 'hos', 'actions.yaml') : undefined;
  const rulesFile = brainDir ? join(brainDir, 'hos', 'workspace-rules.yaml') : undefined;
  const other = policy ? policy.items.map((pair) => keyOf(pair)).filter((key) => key && !SHOWN.includes(key)) : [];
  const sections: SettingsSection[] = [
    {
      id: 'doctor',
      title: 'Doctor',
      what: 'Checks that hos can run on this computer. Each problem comes with its fix.',
      file: null,
      settings: [
        setting('Brain folder', brainDir ?? 'none yet', 'your rules, skills and profiles; every chat runs inside it'),
        ...(inputs.dataDir ? [setting('Data folder', inputs.dataDir, 'chats, their history and the local store; back this folder up')] : []),
        ...(inputs.version ? [setting('hos version', inputs.version, '')] : []),
      ],
    },
    {
      id: 'projects',
      title: 'Projects',
      what: 'The repos chats can work in. hos finds them in the folders below, and you can add one by path.',
      file: policyName,
      settings: [
        setting(
          'Folders to search',
          (inputs.repoRoots ?? []).join(', ') || 'none',
          policy?.has('repo_roots') ? comment(policy.get('repo_roots', true) as Node, 'repo_roots in your settings file') : 'the default; set repo_roots in your settings file to change it',
          true,
        ),
      ],
    },
    {
      id: 'agents',
      title: 'Models & agents',
      what: 'Which coding agents hos runs, whether each is signed in, which model new chats use, and how many chats run at once.',
      file: policyName,
      settings: [
        ...(inputs.harnesses ?? []).map((h) =>
          setting(h.label, h.signedIn === null ? 'installed' : h.signedIn ? 'signed in' : 'not signed in', `${h.models} ${h.models === 1 ? 'model' : 'models'} in the composer menu`),
        ),
        ...models(policy),
        ...block(policy, LIMITS),
      ],
    },
    {
      id: 'profiles',
      title: 'Profiles',
      what: 'A profile is a role a chat can take: its instructions, its rules, and the agent and model it uses. Profiles live in your brain under profiles/.',
      file: brainDir ? 'profiles/' : null,
      settings: (inputs.profiles ?? []).map((p) =>
        setting(p.id, [p.defaults.harness, p.skills === null ? 'every skill' : `${p.skills} skills`].filter(Boolean).join(' · '), p.description),
      ),
    },
    {
      id: 'approvals',
      title: 'Approvals',
      what: 'What chats may do without asking you first. When a chat asks, a card appears in the chat and in Needs you.',
      file: policyName,
      ...approvals(inputs.policyFile, policy),
    },
    {
      id: 'workspaces',
      title: 'Workspaces',
      what: 'A workspace is a checkout a chat works in: a repo’s own folder, or a worktree on its own branch so chats don’t edit the same files.',
      file: where(actionsFile),
      settings: [
        ...(inputs.worktreePorts ? [setting('Ports for dev servers', `${inputs.worktreePorts.from}–${inputs.worktreePorts.to}`, 'each worktree gets its own port from this range', true)] : []),
        ...actionSettings(readMap(actionsFile)),
        ...ruleSettings(readMap(rulesFile)),
      ],
    },
    { id: 'schedules', title: 'Schedules', what: 'Chats that start on their own at set times, such as a morning summary or a weekly dependency check.', file: null, settings: [] },
    {
      id: 'remote',
      title: 'Phone & remote access',
      what: 'Use hos from your phone or another computer over a network you control. No hos server sits in between.',
      file: policyName,
      settings: [
        setting('How you reach this computer', TRANSPORT_WORDS[inputs.transport] ?? inputs.transport, 'transport in your settings file; the running value', true),
        setting('Address', inputs.url ?? 'no address yet', 'where your browsers reach hos'),
        setting('Daemon port', String(inputs.port), 'the loopback port the daemon listens on', true),
        ...block(policy, ['cloudflare']),
        ...(inputs.passkeys ?? []).map((origin) => setting('Passkey', origin, 'a device signs in here with its own passkey')),
      ],
    },
    { id: 'computers', title: 'Computers', what: 'Drive another computer you own from here. Its chats show in this sidebar, and its repos can be picked in New chat.', file: null, settings: [] },
    {
      id: 'storage',
      title: 'Storage & integrations',
      what: 'Where Home and Snags get their data, the plug-ins in your brain, and the extra tools chats can use.',
      file: policyName,
      settings: [...sourceSettings(inputs.sources), ...pluginSettings(inputs.plugins ?? []), ...block(policy, ['mcp_servers'])],
    },
    {
      id: 'advanced',
      title: 'Advanced',
      what: 'Rarely needed. Each of these is a line in your brain’s hos/ files, and the box at the top of this page can change any of them.',
      file: policyName,
      settings: [
        ...ownerSettings(inputs.owner, policy),
        retention(inputs.policyFile),
        ...block(policy, ['context', 'composer']),
        ...(inputs.hostPolicy ? [setting('Per-computer settings', inputs.hostPolicy, 'lines in this file override the main settings file on this computer only')] : []),
        ...block(policy, other),
      ],
    },
  ];
  return { brain: brainDir ?? null, validate: validateCommand(brainDir), sections };
}

function readMap(file: string | undefined): YAMLMap | null {
  if (!file) return null;
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const doc = parseDocument(text);
  return isMap(doc.contents) ? doc.contents : null;
}

function keyOf(pair: unknown): string {
  return isPair(pair) && isScalar(pair.key) ? String(pair.key.value) : '';
}

function comment(node: Node | null | undefined, ...fallbacks: Array<string | null | undefined>): string {
  return [node?.comment, ...fallbacks, node?.commentBefore].find((text) => text?.trim())?.trim() ?? '';
}

function shown(node: unknown): string {
  return flowText(isScalar(node) ? node.value : (node as Node | null)?.toJSON());
}

function flowText(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(flowText).join(', ')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).map(([k, v]) => `${k}: ${flowText(v)}`);
    return entries.length ? `{ ${entries.join(', ')} }` : '{}';
  }
  return String(value ?? '');
}

function restart(key: string): boolean | undefined {
  return RESTART.some((prefix) => key === prefix || key.startsWith(`${prefix}.`)) || undefined;
}

function setting(key: string, value: string, description: string, needsRestart = restart(key)): Setting {
  return { key, value, description, ...(needsRestart ? { restart: true } : {}) };
}

function block(map: YAMLMap | null, keys: string[]): Setting[] {
  if (!map) return [];
  return keys.flatMap((key) => {
    const pair = map.items.find((p) => keyOf(p) === key);
    return pair && isPair(pair) ? flatten(key, pair.value as Node | null, (pair.key as Node | null)?.commentBefore) : [];
  });
}

function flatten(key: string, node: Node | null, keyComment?: string | null): Setting[] {
  if (isMap(node) && !node.flow) {
    return node.items.flatMap((pair) => (isPair(pair) ? flatten(`${key}.${keyOf(pair)}`, pair.value as Node | null) : []));
  }
  if (isSeq(node) && !node.flow) {
    return node.items.map((item, i) => setting(`${key}[${i}]`, shown(item), comment(item as Node, i === 0 ? node.commentBefore : undefined)));
  }
  return [setting(key, node === null ? '' : shown(node), comment(node, keyComment))];
}

function models(policy: YAMLMap | null): Setting[] {
  const block = policy?.get('models', true);
  if (!isMap(block)) {
    return [
      setting('default', FALLBACK_MODELS.default, 'built-in default; add a models block to hos/policy.yaml to change it'),
      setting('effort', FALLBACK_MODELS.effort, 'built-in default effort for new chats'),
      ...FALLBACK_MODELS.list.map((model) => setting(model.label, model.id, 'built-in model')),
    ];
  }
  const list = block.get('list', true);
  return [
    ...['default', 'effort'].map((key) => {
      const node = block.get(key, true) as Node | undefined;
      return setting(key, node ? shown(node) : '', comment(node, key === 'default' ? 'used for new chats' : 'effort for new chats'));
    }),
    ...(isSeq(list)
      ? list.items.map((item) => {
          const model = isMap(item) ? (item.toJSON() as { id?: string; label?: string }) : {};
          return setting(model.label ?? model.id ?? '', model.id ?? '', comment(item as Node, 'in the composer’s model menu'));
        })
      : []),
  ];
}

function approvals(file: string | undefined, map: YAMLMap | null): { note: string; settings: Setting[] } {
  let policy: Policy;
  try {
    policy = (file && existsSync(file) ? loadPolicy(file) : undefined) ?? FALLBACK_POLICY;
  } catch (error) {
    return { note: `The settings file has a problem, so chats keep the last good rules: ${(error as Error).message}`, settings: block(map, APPROVAL_KEYS) };
  }
  const classes = Object.keys(CLASS_LABELS) as ActionClass[];
  const pluginAsks = policy.pluginEdits === 'ask_every_time';
  const quiet = policy.unclassified === 'auto' && classes.every((c) => ['auto', 'deny'].includes(policy[c].lane_t)) && (!pluginAsks || policy.A8.lane_t === 'deny');
  const preset = !file || !existsSync(file) ? 'ask_first' : policy.preset;
  const rows = [
    setting(
      'Preset',
      preset ? PRESET_WORDS[preset]! : 'Your own rules',
      preset
        ? 'the starting rules; a row set in approvals: changes just that row'
        : 'every row is set in approvals:; set approvals.preset to ask_first, balanced or auto to start from a preset',
    ),
    ...classes.map((c) => setting(CLASS_LABELS[c], OUTCOME_WORDS[policy[c].lane_t], `approvals.${c}`)),
    setting('Anything hos can’t classify', OUTCOME_WORDS[policy.unclassified], 'approvals.unclassified'),
    setting(
      'Change plug-in code, the plugins list or harnesses',
      OUTCOME_WORDS[pluginAsks && policy.A8.lane_t !== 'deny' ? 'ask_every_time' : policy.A8.lane_t],
      `approvals.plugin_edits: ${pluginAsks ? 'ask_every_time' : 'follow, the default'} (follow uses the ${CLASS_LABELS.A8} row)`,
    ),
    ...(policy.workRemotes?.length ? [setting('Repos other people share', policy.workRemotes.join(', '), 'work_remotes: a push here is “Publish to a repo other people share”')] : []),
    ...(policy.readOnlyMcp?.length ? [setting('Tool servers that only read', policy.readOnlyMcp.join(', '), 'read_only_mcp: their search, read, list and get tools run as reads')] : []),
    ...(policy.scriptClasses ?? []).map(([match, c]) => setting(`Scripts matching ${match}`, CLASS_LABELS[c], `script_classes: judged as ${c}`)),
  ];
  return {
    note: quiet
      ? 'Chats never ask: every row runs on its own or is refused outright. Only the agents’ own questions reach you.'
      : !file || !existsSync(file)
        ? 'No settings file: hos asks before anything but reading, and asks every time before publishing or touching secrets.'
        : 'Some rows ask before they run.',
    settings: rows,
  };
}

function actionSettings(actions: YAMLMap | null): Setting[] {
  if (!actions) return [];
  const setup = actions.get('setup', true);
  const list = actions.get('actions', true);
  return [
    ...(isMap(setup) ? flatten('setup', setup) : []),
    ...(isSeq(list)
      ? list.items.flatMap((item) => {
          if (!isMap(item)) return [];
          const name = item.get('name', true) as Node | undefined;
          const action = item.toJSON() as { name?: string; run?: string; where?: string; confirm?: boolean; label?: string };
          const flags = [action.where, action.confirm ? 'asks for a click' : null].filter(Boolean).join(', ');
          return [setting(action.label ?? action.name ?? '', action.run ?? '', [comment(name), flags].filter(Boolean).join(' · '))];
        })
      : []),
  ];
}

function ruleSettings(rules: YAMLMap | null): Setting[] {
  const list = rules?.get('rules', true);
  if (!isSeq(list)) return [];
  return list.items.flatMap((item) => {
    if (!isMap(item)) return [];
    const rule = item.toJSON() as { repo?: string; use?: string; base?: string; reason?: string };
    const value = [rule.use, rule.base && `base ${rule.base}`].filter(Boolean).join(' · ');
    return [setting(rule.repo ?? '', value, rule.reason ?? comment(item.get('repo', true) as Node | undefined))];
  });
}

function sourceSettings(sources: SourcesInfo | undefined): Setting[] {
  if (!sources) return [];
  const row = (key: string, source: { label: string } | null, what: string) => setting(key, source?.label ?? 'none', source ? what : `${what}; hidden until a plug-in provides it`);
  return [
    row('Tasks', sources.tasks, 'Home’s Today list'),
    row('Capture', sources.capture, 'where the Home capture box saves'),
    row('Calendar', sources.calendar, 'Home’s calendar'),
    row('Snags', sources.snags, 'where snags are kept'),
    setting('Notifiers', sources.notifiers.join(', ') || 'none', 'extra places hos sends a notice to'),
  ];
}

function pluginSettings(reports: PluginReport[]): Setting[] {
  return reports
    .filter((report) => !report.builtIn || report.problem)
    .map((report) =>
      setting(
        `Plug-in ${report.name ?? report.file}`,
        report.problem ? 'not loaded' : 'loaded',
        report.problem ? `${report.file}: ${report.problem}` : `${report.file} provides ${report.provides.join(', ') || 'nothing'}`,
        true,
      ),
    );
}

function ownerSettings(owner: OwnerInfo | undefined, policy: YAMLMap | null): Setting[] {
  if (!owner) return [];
  const set = isMap(policy?.get('owner', true));
  return [
    setting('Your name', owner.name ?? 'not set', owner.name ? 'what chats call you; owner.name' : 'chats say “you”; set owner.name to use your name', true),
    setting('Time zone', `${owner.timezone} (${owner.timezoneLabel})`, set ? 'schedules, dates and history lines; owner.timezone' : 'follows this computer; set owner.timezone to fix one', true),
  ];
}

function retention(file: string | undefined): Setting {
  let days = 0;
  try {
    days = loadRetentionDays(file);
  } catch {}
  return setting(
    'Keep reasoning traces for',
    days > 0 ? `${days} days` : 'forever',
    days > 0 ? 'thinking and helper progress of topics archived longer ago are deleted; messages stay; events.retention_days' : 'nothing is deleted; set events.retention_days to drop old traces of archived topics',
  );
}
