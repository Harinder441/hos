import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unwatchFile, watchFile, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { AgentRuntime, ExternalMcpServer } from './adapters/agent-runtime.js';
import type { SecretReader } from './adapters/script-secrets.js';
import type { Clock } from './adapters/clock.js';
import type { Notifier } from './adapters/notifier.js';
import type { Transport } from './adapters/transport.js';
import { Hos, type PortRange } from './core.js';
import { DESK_TOKEN_FILE, deskScreen } from './desk-screen.js';
import { HomeAlerts } from './home.js';
import { STATUS_TOPIC_WAIT_MS } from './naming.js';
import { loadSources, snagSpace, type PluginReport } from './plugins/loader.js';
import { snagFiles } from './snags/files.js';
import { localPlugin } from './plugins/local.js';
import { NotifierLoop } from './plugins/notify.js';
import { PresenceSampler } from './plugins/presence.js';
import type { SourcesInfo, StatusItem } from './api/types.js';
import { CodeView, defaultCodeViewBin } from './code-view.js';
import { codeViewLoginToken, codeViewToken, tokenFile } from './code-view-bridge.js';
import { HtmlFiles } from './files.js';
import { settingsPage } from './settings.js';
import type { SetupOptions } from './setup.js';
import type { DiscoveryConfig } from './discovery.js';
import { ALL_FEATURES, type Harness } from './harnesses/harness.js';
import { loadAcpHarnesses } from './harnesses/acp/index.js';
import { setupHarnesses, signInRows } from './harnesses/setup.js';
import type { ComputerCaps, HarnessChoice } from './api/types.js';
import { BUS_PATH, createHttpServer } from './http.js';
import { loadGovernorLimits, loadSpawnLimits } from './governor.js';
import { steadyMachine, type Machine, type MachineSetup } from './adapters/machine.js';
import { Passkeys } from './passkeys.js';
import { API_VERSION, computerName, Computers, hosVersion, type PeerConfig } from './computers.js';
import { FALLBACK_POLICY, loadComposer, loadCrossChatShare, loadDeskOrigins, loadDeskPresence, loadMcpServers, loadModels, loadOwnerSettings, loadPluginEntries, loadPolicy, type McpServerConfig } from './policy.js';
import { ownerInfo, setOwnerSettings } from './owner.js';
import { Push } from './push.js';
import { listSkills } from './skills.js';
import { Snags } from './snags/snags.js';
import { Store } from './store.js';
import { TerminalAttachments } from './terminals.js';
import { Tmux } from './tmux.js';

export interface DaemonConfig {
  dataDir: string;
  port: number;
  webRoot?: string;
  webHost?: string;
  brainDir?: string;
  policyFile?: string;
  discovery?: DiscoveryConfig;
  ports?: PortRange;
  refreshMs?: number;
  pushMuteMs?: number;
  ghBin?: string;
  contextBudget?: number;
  crossChatShare?: number;
  tmuxSocket?: string;
  terminalShell?: string;
  tempRoots?: string[];
  healthchecksUrl?: string;
  codeViewBin?: string;
  codeViewFirstPort?: number;
  statusTopicWaitMs?: number;
  skillsHome?: string;
  workSuffix?: string;
  peers?: PeerConfig[];
  computerName?: string;
  computerPollMs?: number;
  scheduleHost?: string;
  setup?: SetupOptions;
  startupLog?: (line: string) => void;
}

export interface Adapters {
  agentRuntime: AgentRuntime;
  transport: Transport;
  clock: Clock;
  notifier: Notifier;
  secretReader?: SecretReader;
  machine?: Machine;
  extraHarnesses?: Harness[];
}

export interface Daemon {
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly enrolmentCode: string | null;
  stop(): Promise<void>;
}

const HOST = '127.0.0.1';
const LOCAL_OPS_TOKEN = 'local-ops.token';
const EFFECTIVE_POLICY = 'policy.effective.yaml';
const POLICY_POLL_MS = 1_000;
const SETUP_TTL_MS = 5 * 60_000;
const run = promisify(execFile);

export function policyFile(config: Pick<DaemonConfig, 'brainDir' | 'policyFile'>): string | undefined {
  return config.policyFile ?? (config.brainDir ? join(config.brainDir, 'hos', 'policy.yaml') : undefined);
}

export function hostPolicyFile(base: string, host = hostname().split('.')[0]!): string {
  return join(dirname(base), `policy.${host}.yaml`);
}

function isMap(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergePolicy(base: unknown, overlay: unknown): unknown {
  if (!isMap(base) || !isMap(overlay)) return overlay;
  const merged = { ...base };
  for (const [key, value] of Object.entries(overlay)) merged[key] = key in base ? mergePolicy(base[key], value) : value;
  return merged;
}

export function effectivePolicyFile(base: string, dataDir: string): string {
  const overlay = hostPolicyFile(base);
  if (!existsSync(overlay)) return base;
  const read = (file: string) => (existsSync(file) ? (parseYaml(readFileSync(file, 'utf8')) ?? {}) : {});
  const target = join(dataDir, EFFECTIVE_POLICY);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(target, stringifyYaml(mergePolicy(read(base), read(overlay))));
  return target;
}

function watchHostPolicy(base: string, dataDir: string): () => void {
  const overlay = hostPolicyFile(base);
  const rewrite = () => {
    try {
      effectivePolicyFile(base, dataDir);
    } catch (error) {
      console.error(`ignoring ${base} + ${overlay}, keeping the last good policy: ${(error as Error).message}`);
    }
  };
  for (const file of [base, overlay]) watchFile(file, { interval: POLICY_POLL_MS }, rewrite);
  return () => {
    for (const file of [base, overlay]) unwatchFile(file, rewrite);
  };
}

async function withKeys(servers: McpServerConfig[], reader: SecretReader | undefined): Promise<ExternalMcpServer[]> {
  const resolved: ExternalMcpServer[] = [];
  for (const server of servers) {
    const key = server.keySecret && reader ? await reader.read(server.keySecret) : null;
    if (key) resolved.push({ name: server.name, url: server.url, headers: { Authorization: `Bearer ${key}` } });
    else console.warn(`mcp_servers: no key for ${server.name} on this host, not injected`);
  }
  return resolved;
}

export async function startDaemon(config: DaemonConfig, adapters: Adapters): Promise<Daemon> {
  const mark = (phase: string) => config.startupLog?.(`${new Date().toISOString()} startup: ${phase} (node up ${process.uptime().toFixed(2)} s)`);
  mark('daemon start');
  const base = policyFile(config);
  const file = base && effectivePolicyFile(base, config.dataDir);
  const policy = (file && loadPolicy(file)) || FALLBACK_POLICY;
  setOwnerSettings(loadOwnerSettings(file));
  const mcpServers = await withKeys(loadMcpServers(file), adapters.secretReader);
  const stopPolicyOverlay = base && file !== base ? watchHostPolicy(base, config.dataDir) : () => {};
  const spawnLimits = loadSpawnLimits(file);
  const governorLimits = loadGovernorLimits(file);
  const store = new Store(config.dataDir, adapters.clock.now(), config.brainDir ?? null);
  mark('store open');
  const tmux = new Tmux(config.tmuxSocket);
  const sensors = { machine: adapters.machine ?? steadyMachine };
  const primary: Harness = {
    id: adapters.agentRuntime.agent,
    label: adapters.agentRuntime.agent.charAt(0).toUpperCase() + adapters.agentRuntime.agent.slice(1),
    pool: 'claude',
    runtime: adapters.agentRuntime,
    models: () => loadModels(file),
    slots: governorLimits.running.claude ?? 0,
    features: ALL_FEATURES,
  };
  const pluginList = loadPluginEntries(file);
  let snagsReady: Snags | null = null;
  const loaded = await loadSources(
    pluginList.entries,
    { dataDir: config.dataDir, brainDir: config.brainDir ?? null, clock: adapters.clock, snagReached: (n, row) => snagsReady?.reached(n, row) },
    [localPlugin],
  );
  const pluginRows = pluginChecks(loaded.reports, pluginList.problem);
  for (const row of pluginRows) if (row.status !== 'ok') console.warn(`plug-ins: ${row.detail}`);
  mark(`plug-ins loaded (${loaded.reports.filter((r) => !r.builtIn && !r.problem).length} of ${pluginList.entries.length})`);
  const sources = loaded.sources;
  const { harnesses, rows: harnessRows } = setupHarnesses(primary, adapters.extraHarnesses ?? [], loadAcpHarnesses(file), sources.harnesses);
  for (const row of harnessRows) console.warn(`harnesses: ${row.detail}`);
  const signIns = new Map<string, { at: number; state: Promise<boolean | null> }>();
  const harnessSignedIn = (harness: Harness): Promise<boolean | null> => {
    const probe = harness.runtime.signedIn;
    if (!probe) return Promise.resolve(null);
    const cached = signIns.get(harness.id);
    if (cached && adapters.clock.now() - cached.at <= SETUP_TTL_MS) return cached.state;
    const state = probe.call(harness.runtime).catch(() => false);
    signIns.set(harness.id, { at: adapters.clock.now(), state });
    return state;
  };
  const harnessChoice = (h: Harness): HarnessChoice => ({
    id: h.id,
    label: h.label,
    models: h.models(),
    features: h.features,
    ...(h.aliases?.length ? { aliases: h.aliases } : {}),
    ...(h.badge ? { badge: h.badge } : {}),
  });
  const hos = new Hos(store, harnesses, adapters.clock, tmux, {
    ...(sources.tasks ? { userTasks: sources.tasks } : {}),
    discovery: config.discovery ?? {},
    dataDir: config.dataDir,
    ports: config.ports ?? { from: 4100, to: 4999 },
    refreshMs: config.refreshMs ?? 10_000,
    statusTopicWaitMs: config.statusTopicWaitMs ?? STATUS_TOPIC_WAIT_MS,
    policy,
    spawnLimits,
    governorLimits,
    ghBin: config.ghBin ?? 'gh',
    actionsDir: join(config.dataDir, 'actions'),
    ...(config.scheduleHost ? { scheduleHost: config.scheduleHost } : {}),
    mcpServers,
    busLimits: { contextBudget: config.contextBudget ?? 250_000, crossChatShare: config.crossChatShare ?? loadCrossChatShare(file) ?? 0.1 },
    ...(config.brainDir ? { brainDir: config.brainDir } : {}),
    ...(file ? { policyFile: file } : {}),
    ...(config.terminalShell ? { terminalShell: config.terminalShell } : {}),
    ...(config.tempRoots ? { tempRoots: config.tempRoots } : {}),
    ...(config.healthchecksUrl ? { healthchecksUrl: config.healthchecksUrl } : {}),
    ...(config.workSuffix ? { workSuffix: config.workSuffix } : {}),
    previewUrl: (port) => adapters.transport.previewUrl(port),
    webOrigin: () => adapters.transport.webOrigin((http.server.address() as AddressInfo).port),
  }, sensors);
  mark('fold start');
  const ui = hos.foldUi();
  mark(`fold end, ${ui.folded} events ${ui.restoredAt === null ? 'in a full fold' : `after the saved fold at seq ${ui.restoredAt}`}`);
  hos.recover();
  mark('recover end');
  const push = new Push(store, adapters.notifier, adapters.clock, config.pushMuteMs);
  const stopPush = hos.subscribe(store.lastEventSeq(), (event) => push.onEvent(event));
  const terminals = new TerminalAttachments(tmux);
  const passkeys = new Passkeys(store, adapters.clock, config.dataDir);
  const homeAlerts = new HomeAlerts(store, adapters.clock);
  const snagProvider = loaded.sources.all().find((provided) => provided.source === sources.snags)!;
  const snags = new Snags(sources.snags!, snagFiles(config.brainDir ?? null, console.error, snagSpace(snagProvider.plugin, snagProvider.builtIn)), config.brainDir, hos);
  snagsReady = snags;
  const { token: bridgeToken, file: bridgeTokenFile } = codeViewToken(config.dataDir);
  const desk = () => deskScreen(hos, store, snags, adapters.clock.now());
  let presenceOn = false;
  try {
    presenceOn = loadDeskPresence(file);
  } catch (error) {
    console.error(`${(error as Error).message}; the desk push carries no presence`);
  }
  const readPresence = sensors.machine.presence?.bind(sensors.machine);
  if (presenceOn && !readPresence) console.error('desk.presence is on, but this computer has no presence sampler (macOS only); the desk push carries no presence');
  const presence = presenceOn && readPresence ? new PresenceSampler(hostname().split('.')[0]!.toLowerCase(), readPresence, adapters.clock) : undefined;
  const notifiers = new NotifierLoop(sources.notifiers, adapters.clock, desk, undefined, presence);
  let deskOrigins: string[] = [];
  try {
    deskOrigins = loadDeskOrigins(file);
  } catch (error) {
    console.error(`${(error as Error).message}; the desk screen allows no other origins`);
  }
  const sourcesInfo = (): SourcesInfo => {
    const calendar = sources.calendar;
    return {
      tasks: sources.tasks && { label: sources.tasks.label },
      capture: sources.capture && { label: sources.capture.label },
      calendar: calendar && { label: calendar.label, now: typeof calendar.now === 'function', link: calendar.link ?? null },
      snags: { label: snags.label },
      notifiers: sources.notifiers.map((n) => n.label),
    };
  };
  let setup: { at: number; facts: Promise<MachineSetup> } | null = null;
  const machineSetup = () => {
    if (!setup || adapters.clock.now() - setup.at > SETUP_TTL_MS) setup = { at: adapters.clock.now(), facts: sensors.machine.setup() };
    return setup.facts;
  };
  const self = { name: computerName(config.computerName), short: process.platform === 'darwin' ? 'Mac' : 'PC', apiVersion: API_VERSION, hosVersion: hosVersion(), scheduleHost: config.scheduleHost ?? hostname() };
  const caps = async (): Promise<ComputerCaps> => {
    const facts = await machineSetup();
    const loggedIn = async (h: Harness) => (h === harnesses.primary ? !!facts.claude?.loggedIn : ((await harnessSignedIn(h)) ?? true));
    const brainHead = config.brainDir ? await run('git', ['rev-parse', 'HEAD'], { cwd: config.brainDir }).then(({ stdout }) => stdout.trim(), () => null) : null;
    return {
      ...self,
      harnesses: await Promise.all(harnesses.all().map(async (h) => ({ ...harnessChoice(h), loggedIn: await loggedIn(h) }))),
      browser: facts.browser,
      slots: hos.governorStatus().slots,
      projects: hos.listProjects().flatMap((project) => (project.key ? [{ key: project.key, name: project.name }] : [])),
      brainHead,
    };
  };
  const computers = new Computers(store, config.dataDir, adapters.clock, self, caps, config.computerPollMs);
  computers.migrate(config.peers ?? []);
  hos.computers = computers;
  computers.apply = (name, event) => hos.applyRemoteEvent(name, event);
  computers.receive = (name, item) => hos.deliverFromComputer(name, item.chatId, item.text, item.fromChatId ?? undefined);
  hos.bus.computerName = self.name;
  let hosUrl: string | null = null;
  const services = {
    codeView: new CodeView({
      bridge: () => (hosUrl ? { url: hosUrl, token: bridgeToken, tokenFile: bridgeTokenFile } : null),
      login: codeViewLoginToken(config.dataDir),
      tmux,
      transport: adapters.transport,
      bin: defaultCodeViewBin(config.codeViewBin),
      firstPort: config.codeViewFirstPort,
      checkouts: () => [
        ...(config.brainDir ? [config.brainDir] : []),
        ...hos.listProjects().flatMap((project) => [project.path, ...project.worktrees.map((worktree) => worktree.path)]),
      ],
    }),
    sources,
    sourcesInfo,
    pluginChecks: () => pluginRows,
    harnessChecks: async () => [...harnessRows, ...(await signInRows(harnesses, harnessSignedIn))],
    home: () => homeAlerts.summary(hos.governorStatus(), hos.listInbox()),
    settings: async () => {
      const port = (http.server.address() as AddressInfo).port;
      const facts = await machineSetup();
      return settingsPage({
        policyFile: file,
        brainDir: config.brainDir,
        dataDir: config.dataDir,
        version: self.hosVersion,
        transport: adapters.transport.name,
        url: await adapters.transport.webOrigin(port),
        port,
        repoRoots: config.discovery?.repoRoots ?? [],
        worktreePorts: config.ports ?? { from: 4100, to: 4999 },
        harnesses: harnesses.all().map((h) => ({ label: h.label, signedIn: h.pool === 'claude' ? !!facts.claude?.loggedIn : null, models: h.models().list.length })),
        profiles: hos.listProfiles(),
        plugins: loaded.reports,
        sources: sourcesInfo(),
        passkeys: passkeys.registeredOrigins(),
        owner: ownerInfo(adapters.clock.now()),
        hostPolicy: base && file !== base ? hostPolicyFile(base).replace(`${config.brainDir}/`, '') : null,
      });
    },
    dismissAlert: (id: string) => (hos.listInbox().some((item) => item.id === id && item.kind === 'keeper') ? hos.dismissInboxItem(id) : homeAlerts.dismiss(id)),
    models: () => loadModels(file),
    composer: () => loadComposer(file),
    owner: () => ownerInfo(adapters.clock.now()),
    harnesses: (): HarnessChoice[] => harnesses.all().map(harnessChoice),
    skills: (profile?: string) => {
      const all = listSkills(config.brainDir, config.skillsHome ?? homedir());
      const allow = profile ? hos.profileSkills(profile) : undefined;
      return allow ? all.filter((skill) => allow.includes(skill.name)) : all;
    },
    files: new HtmlFiles(adapters.clock),
    snags,
    codeViewToken: bridgeToken,
    desk,
    deskOrigins,
    deskToken: tokenFile(config.dataDir, DESK_TOKEN_FILE),
    localOpsToken: tokenFile(config.dataDir, LOCAL_OPS_TOKEN),
    ...(config.webHost ? { webHost: config.webHost } : {}),
    ...(config.setup ? { setup: config.setup } : {}),
    computers,
  };
  const http = createHttpServer(hos, terminals, adapters.transport, passkeys, push, config.webRoot, services);
  const { server } = http;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, HOST, resolve);
    });
  } catch (error) {
    stopPolicyOverlay();
    await loaded.close();
    store.close();
    throw error;
  }
  const { port } = server.address() as AddressInfo;
  mark('listening');
  hos.busUrl = `http://${HOST}:${port}${BUS_PATH}`;
  hosUrl = `http://${HOST}:${port}`;
  hos.start();
  computers.start();
  notifiers.start();
  return {
    url: `http://${HOST}:${port}`,
    host: HOST,
    port,
    get enrolmentCode() {
      return passkeys.enrolmentCode;
    },
    async stop() {
      computers.stop();
      notifiers.stop();
      stopPolicyOverlay();
      stopPush();
      terminals.stop();
      await hos.stop();
      await http.close();
      await loaded.close();
      store.close();
    },
  };
}

function pluginChecks(reports: PluginReport[], listProblem: string | null): StatusItem[] {
  const rows = reports
    .filter((report) => !report.builtIn || report.problem)
    .map(
      (report): StatusItem => ({
        id: `plugin:${report.file}`,
        label: `Plug-in ${report.name ?? report.file}`,
        status: report.problem ? 'warn' : 'ok',
        detail: report.problem ? `${report.file}: ${report.problem}` : `${report.file} provides ${report.provides.join(', ') || 'nothing'}`,
        ...(report.problem ? { fix: `fix ${report.file} in the brain's hos/plugins/ (check it with hos plugin-check <file>), then restart hos` } : {}),
      }),
    );
  if (listProblem) rows.unshift({ id: 'plugins', label: 'Plug-ins', status: 'warn', detail: listProblem, fix: "fix the plugins list in the brain's hos/policy.yaml, then restart hos" });
  return rows;
}
