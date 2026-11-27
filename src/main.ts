#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BrainSecretReader } from './adapters/script-secrets.js';
import { ClaudeAgentRuntime } from './adapters/claude-agent-runtime.js';
import { systemClock } from './adapters/clock.js';
import { LinuxMachine, MacMachine, steadyMachine } from './adapters/machine.js';
import { AccessCertsFetch, certsUrl, CloudflareTransport, type CloudflareConfig } from './adapters/cloudflare-transport.js';
import { defaultTailscaleBin, TailscaleCliProcess, TailscaleTransport } from './adapters/tailscale-transport.js';
import { loopbackTransport, type Transport } from './adapters/transport.js';
import { WebPushNotifier } from './adapters/web-push-notifier.js';
import { effectivePolicyFile, hostPolicyFile, policyFile, startDaemon, type Daemon } from './daemon.js';
import { DEFAULT_STARTER, rememberedBrain, type SetupOptions } from './setup.js';
import { loadCloudflareConfig, loadRepoRoots, loadTransportName } from './policy.js';
import { ScriptedAgentRuntime } from './fakes/scripted-agent-runtime.js';
import { keeperCommand, launchAgentPlist } from './launchd.js';
import { kitReport, runKit } from './plugins/kit.js';
import { parsePeers, type PeerConfig } from './computers.js';
import { runCli } from './cli/index.js';

const cliExit = await runCli(process.argv.slice(2));
if (cliExit !== null) process.exit(cliExit);

if (process.argv[2] === 'plugin-check') {
  const { values: kit, positionals } = parseArgs({
    args: process.argv.slice(3),
    allowPositionals: true,
    options: { write: { type: 'boolean', default: false }, options: { type: 'string' } },
  });
  const file = positionals[0];
  if (!file) {
    console.error('usage: hos plugin-check <plugin file> [--write] [--options <json>]\n  --write also adds, changes and closes test items, so point the plug-in at a test backend; for a harness it starts the agent for one short turn');
    process.exit(2);
  }
  const path = resolve(file);
  const result = await runKit(path, { write: kit.write, options: kit.options ? (JSON.parse(kit.options) as Record<string, unknown>) : {} });
  console.log(kitReport(path, result));
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[2] === 'keeper') {
  try {
    console.log(await keeperCommand(process.argv[3], process.argv.slice(4)));
    process.exit(0);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}

const home = homedir();
const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '4517' },
    'data-dir': { type: 'string', default: join(home, '.hos') },
    'web-root': { type: 'string', default: fileURLToPath(new URL('../web', import.meta.url)) },
    brain: { type: 'string' },
    starter: { type: 'string', default: process.env.HOS_STARTER || DEFAULT_STARTER },
    'repo-root': { type: 'string', multiple: true },
    'worktree-root': {
      type: 'string',
      multiple: true,
      default: [join(home, 'conductor', 'workspaces'), join(home, '.t3', 'worktrees')],
    },
    'worktree-ports': { type: 'string', default: '4100-4999' },
    'refresh-ms': { type: 'string', default: '10000' },
    'push-mute-ms': { type: 'string' },
    agent: { type: 'string', default: 'claude' },
    'claude-bin': { type: 'string' },
    'launchd-label': { type: 'string' },
    'tailscale-bin': { type: 'string', default: defaultTailscaleBin() },
    'cloudflare-certs-url': { type: 'string' },
    'gh-bin': { type: 'string', default: 'gh' },
    'tmux-socket': { type: 'string' },
    cells: { type: 'string' },
    'push-subject': { type: 'string' },
    'healthchecks-url': { type: 'string' },
    'hos-code-bin': { type: 'string' },
    'px0-bin': { type: 'string' },
    'policy-file': { type: 'string' },
    'work-suffix': { type: 'string' },
    peer: { type: 'string', multiple: true, default: [] },
  },
});

const brainPath = values.brain || process.env.HOS_BRAIN || rememberedBrain(values['data-dir']) || join(home, 'hos-brain');
if (values.agent !== 'claude' && values.agent !== 'scripted') {
  console.error(`unknown --agent ${values.agent}; use claude or scripted`);
  process.exit(1);
}

let peers: PeerConfig[];
try {
  peers = parsePeers(values.peer);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

const [from, to] = values['worktree-ports'].split('-').map(Number);
if (!Number.isInteger(from) || !Number.isInteger(to) || from! > to!) {
  throw new Error(`--worktree-ports must look like 4100-4999, got ${values['worktree-ports']}`);
}

if (values.cells !== undefined) console.warn(`--cells ${values.cells} is ignored: cells are gone, so drop the flag from the launcher`);

const codeViewBin = process.env.HOS_CODE_BIN || values['hos-code-bin'] || process.env.HOS_PX0_BIN || values['px0-bin'];
const skillsHome = process.env.HOS_SKILLS_HOME;

function transportFor(policy: string | undefined): Transport {
  const transportName = policy ? loadTransportName(policy) : 'loopback';
  if (transportName === 'loopback') console.warn(`no transport in ${policy ?? 'a brain yet'}; hos is reachable from this computer only`);
  if (transportName === 'tailscale') return new TailscaleTransport(new TailscaleCliProcess(values['tailscale-bin']));
  if (transportName === 'cloudflare' && policy) {
    let cloudflare: CloudflareConfig;
    try {
      cloudflare = loadCloudflareConfig(policy);
    } catch (error) {
      console.error((error as Error).message);
      process.exit(1);
    }
    const certs = new AccessCertsFetch(values['cloudflare-certs-url'] ?? certsUrl(cloudflare.team));
    return new CloudflareTransport(cloudflare, certs, systemClock);
  }
  return loopbackTransport;
}

async function boot(brain: string | null, setup?: SetupOptions): Promise<Daemon> {
  let policy: string | undefined;
  if (brain) {
    const basePolicy = policyFile({ brainDir: brain, ...(values['policy-file'] ? { policyFile: values['policy-file'] } : {}) })!;
    if (!existsSync(basePolicy)) console.warn(`no ${basePolicy}; reads run, every other request asks and publishing asks every time`);
    policy = effectivePolicyFile(basePolicy, values['data-dir']);
    if (policy !== basePolicy) console.log(`policy: ${basePolicy} with ${hostPolicyFile(basePolicy)} merged over it`);
  }
  const repoRoots = values['repo-root'] ?? loadRepoRoots(policy) ?? [join(home, 'Repos')];
  const transport = transportFor(policy);
  const pushSubject = async () => {
    if (values['push-subject']) return values['push-subject'];
    const origin = await transport.webOrigin(Number(values.port));
    return origin?.startsWith('https://') ? origin : 'mailto:hos@example.com';
  };
  const daemon = await startDaemon(
    {
      port: Number(values.port),
      dataDir: values['data-dir'],
      webRoot: values['web-root'],
      ...(brain ? { brainDir: brain } : {}),
      ...(setup ? { setup } : {}),
      discovery: { ...(brain ? { brain } : {}), repoRoots, worktreeRoots: values['worktree-root'] },
      ports: { from: from!, to: to! },
      refreshMs: Number(values['refresh-ms']),
      ...(values['push-mute-ms'] ? { pushMuteMs: Number(values['push-mute-ms']) } : {}),
      ghBin: values['gh-bin'],
      ...(values['tmux-socket'] ? { tmuxSocket: values['tmux-socket'] } : {}),
      ...(values['healthchecks-url'] ? { healthchecksUrl: values['healthchecks-url'] } : {}),
      ...(codeViewBin ? { codeViewBin } : {}),
      ...(skillsHome ? { skillsHome } : {}),
      ...(values['policy-file'] ? { policyFile: values['policy-file'] } : {}),
      ...(values['work-suffix'] ? { workSuffix: values['work-suffix'] } : {}),
      peers,
      startupLog: (line) => console.log(line),
    },
    {
      agentRuntime:
        values.agent === 'claude'
          ? new ClaudeAgentRuntime(values['claude-bin'] ? { executable: values['claude-bin'] } : {})
          : new ScriptedAgentRuntime(systemClock),
      ...(brain ? { secretReader: new BrainSecretReader(brain) } : {}),
      transport,
      clock: systemClock,
      notifier: new WebPushNotifier(join(values['data-dir'], 'vapid.json'), pushSubject),
      machine:
        values.agent !== 'claude'
          ? steadyMachine
          : process.platform === 'linux'
            ? new LinuxMachine(values['claude-bin'] ? { claudeBin: values['claude-bin'] } : {})
            : new MacMachine({ launchAgentPlist: launchAgentPlist(undefined, values['launchd-label']), ...(values['claude-bin'] ? { claudeBin: values['claude-bin'] } : {}) }),
    },
  );
  const doctor = await transport.doctor(daemon.port);
  console.log([`${doctor.ok ? 'ok' : 'doctor'}: ${doctor.message}`, ...doctor.fix.map((fix) => `  ${fix}`)].join('\n'));
  console.log(`hos daemon listening on ${daemon.url}`);
  if (daemon.enrolmentCode) console.log(`setup code for a new passkey on an address without one: ${daemon.enrolmentCode} (used once; also in ${join(values['data-dir'], 'enrolment-code')})`);
  return daemon;
}

let daemon: Daemon;
if (existsSync(brainPath)) {
  daemon = await boot(brainPath);
} else {
  console.log(`no brain at ${brainPath}: hos starts in setup mode. Open it in a browser to create one, or pass --brain <your brain> (or set HOS_BRAIN)`);
  let chosen!: (path: string) => void;
  const brain = new Promise<string>((resolve) => (chosen = resolve));
  daemon = await boot(null, { defaultBrain: brainPath, starter: values.starter, dataDir: values['data-dir'], onBrain: (path) => chosen(path) });
  const path = await brain;
  console.log(`brain ready at ${path}; restarting hos on it`);
  await daemon.stop();
  daemon = await boot(path);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await daemon.stop();
    process.exit(0);
  });
}
