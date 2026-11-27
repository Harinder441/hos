import { execFileSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { constants, existsSync, readFileSync, rmSync } from 'node:fs';
import { copyFile, cp, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CloudflareTransport } from '../src/adapters/cloudflare-transport.js';
import { TailscaleTransport } from '../src/adapters/tailscale-transport.js';
import { loopbackTransport } from '../src/adapters/transport.js';
import { HosClient, SESSION_PROTOCOL } from '../src/api/client.js';
import type { HosEvent } from '../src/api/types.js';
import type { AgentRuntime } from '../src/adapters/agent-runtime.js';
import type { Harness } from '../src/harnesses/harness.js';
import { startDaemon, type Daemon, type DaemonConfig } from '../src/daemon.js';
import { Store } from '../src/store.js';
import type { Notifier } from '../src/adapters/notifier.js';
import { CapturedNotifier } from '../src/fakes/captured-notifier.js';
import { deadlineMs } from './helpers.js';
import { FakeSecretReader } from '../src/fakes/fake-secrets.js';
import { FakeAuthenticator } from '../src/fakes/fake-authenticator.js';
import { FakeClock } from '../src/fakes/fake-clock.js';
import { FakeMachine } from '../src/fakes/fake-machine.js';
import { FakeAccessIdentity, FakeTransportIdentity } from '../src/fakes/fake-transport-identity.js';
import { ScriptedAgentRuntime, type AgentScript } from '../src/fakes/scripted-agent-runtime.js';

const cleanups: Array<() => Promise<void>> = [];

export async function cleanupAll(): Promise<void> {
  while (cleanups.length) await cleanups.pop()!();
}

export function cleanupLater(cleanup: () => Promise<void>): void {
  cleanups.push(cleanup);
}

export async function tempDir(prefix = 'hos-test-'): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=hos-test', '-c', 'user.email=hos@test.invalid', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

const templateRepos = new Map<string, Promise<string>>();

function templateRepo(branch: string): Promise<string> {
  let template = templateRepos.get(branch);
  if (!template) {
    template = (async () => {
      const dir = await realpath(await mkdtemp(join(tmpdir(), 'hos-template-')));
      process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
      git(dir, 'init', '-q', '-b', branch);
      await writeFile(join(dir, 'README.md'), '# temp repo\n');
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', 'init');
      return dir;
    })();
    templateRepos.set(branch, template);
  }
  return template;
}

export async function tempGitRepo(branch = 'main', parent?: string, name?: string): Promise<string> {
  const dir = parent ? join(parent, name ?? 'repo') : await tempDir('hos-repo-');
  await cp(await templateRepo(branch), dir, { recursive: true });
  return dir;
}

export interface TestDaemonOptions {
  script?: AgentScript;
  agentRuntime?: AgentRuntime;
  extraHarnesses?: Harness[];
  dataDir?: string;
  port?: number;
  brainDir?: string;
  policyFile?: string;
  discovery?: DaemonConfig['discovery'];
  ports?: DaemonConfig['ports'];
  refreshMs?: number;
  signedIn?: boolean;
  ghBin?: string;
  contextBudget?: number;
  transport?: 'tailscale' | 'cloudflare' | 'loopback';
  brainSecrets?: FakeSecretReader['values'];
  notifier?: Notifier;
  machine?: FakeMachine;
  healthchecksUrl?: string;
  passkeyOf?: string;
  codeViewBin?: string;
  statusTopicWaitMs?: number;
  skillsHome?: string;
  tempRoots?: string[];
  webRoot?: string;
  webHost?: string;
  clockStart?: number;
  workSuffix?: string;
  peers?: DaemonConfig['peers'];
  computerName?: string;
  scheduleHost?: string;
  setup?: Omit<NonNullable<DaemonConfig['setup']>, 'dataDir'>;
}

const passkeysByDataDir = new Map<string, FakeAuthenticator>();

export interface Visitor {
  headers(): Record<string, string>;
  readonly origin: string;
}

export async function signedInClient(url: string, identity: Visitor, dataDir: string, signIn = true) {
  const passkey = passkeysByDataDir.get(dataDir) ?? new FakeAuthenticator(identity.origin);
  passkeysByDataDir.set(dataDir, passkey);
  const client = new HosClient(url, { headers: identity.headers(), authenticator: passkey });
  if (signIn) {
    if ((await client.session()).registered) await client.signIn();
    else await client.registerPasskey(enrolmentCode(dataDir));
  }
  return { client, passkey };
}

export function enrolmentCode(dataDir: string): string {
  return readFileSync(join(dataDir, 'enrolment-code'), 'utf8').trim();
}

let templateDb: Promise<string> | undefined;

// Creating the schema costs ~15 ms per daemon, so each worker builds one empty store and copies it.
function emptyStore(): Promise<string> {
  templateDb ??= (async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'hos-template-db-')));
    process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
    new Store(dir).close();
    return join(dir, 'hos.db');
  })();
  return templateDb;
}

export async function startTestDaemon(options: TestDaemonOptions = {}) {
  const dataDir = options.dataDir ?? (await tempDir('hos-data-'));
  if (!options.dataDir) await copyFile(await emptyStore(), join(dataDir, 'hos.db'), constants.COPYFILE_FICLONE);
  const tmuxSocket = join(dataDir, 'tmux.sock');
  const tempRoots = options.tempRoots ?? [join(dataDir, 'tmp')];
  await Promise.all(tempRoots.map((dir) => mkdir(dir, { recursive: true })));
  const codeViewFirstPort = 20000 + 200 * randomInt(140);
  const clock = new FakeClock(options.clockStart);
  const agentRuntime = (options.agentRuntime ?? new ScriptedAgentRuntime(clock, options.script)) as ScriptedAgentRuntime;
  const transportIdentity = new FakeTransportIdentity();
  const accessIdentity = new FakeAccessIdentity(clock);
  const cloudflare = options.transport === 'cloudflare';
  const notifier = new CapturedNotifier();
  const machine = options.machine ?? new FakeMachine();
  const secretReader = new FakeSecretReader(options.brainSecrets ?? {});
  const daemon: Daemon = await startDaemon(
    {
      dataDir,
      port: options.port ?? 0,
      brainDir: options.brainDir,
      policyFile: options.policyFile,
      discovery: options.discovery,
      ports: options.ports,
      refreshMs: options.refreshMs,
      ghBin: options.ghBin,
      contextBudget: options.contextBudget,
      tmuxSocket,
      terminalShell: '/bin/sh',
      healthchecksUrl: options.healthchecksUrl,
      codeViewBin: options.codeViewBin ?? fileURLToPath(new URL('./fixtures/bin/fake-hos-code.mjs', import.meta.url)),
      codeViewFirstPort,
      statusTopicWaitMs: options.statusTopicWaitMs,
      skillsHome: options.skillsHome ?? join(dataDir, 'home'),
      tempRoots,
      webRoot: options.webRoot,
      webHost: options.webHost,
      ...(options.workSuffix ? { workSuffix: options.workSuffix } : {}),
      ...(options.peers ? { peers: options.peers } : {}),
      ...(options.computerName ? { computerName: options.computerName } : {}),
      ...(options.scheduleHost ? { scheduleHost: options.scheduleHost } : {}),
      ...(options.setup ? { setup: { ...options.setup, dataDir } } : {}),
    },
    {
      agentRuntime,
      secretReader,
      transport: cloudflare
        ? new CloudflareTransport(accessIdentity.config, accessIdentity, clock)
        : options.transport === 'loopback'
          ? loopbackTransport
          : new TailscaleTransport(transportIdentity),
      clock,
      notifier: options.notifier ?? notifier,
      machine,
      ...(options.extraHarnesses ? { extraHarnesses: options.extraHarnesses } : {}),
    },
  );
  const loopbackVisitor: Visitor = { headers: () => ({}), origin: `http://localhost:${daemon.port}` };
  const visitor = cloudflare ? accessIdentity : options.transport === 'loopback' ? loopbackVisitor : transportIdentity;
  if (options.passkeyOf) passkeysByDataDir.set(dataDir, passkeysByDataDir.get(options.passkeyOf)!);
  const { client, passkey } = await signedInClient(daemon.url, visitor, dataDir, options.signedIn !== false);
  let stopped = false;
  const stop = async (stopOptions: { keepTmux?: boolean } = {}) => {
    if (stopped) return;
    stopped = true;
    await daemon.stop();
    // Lets fetch's keep-alive pool see the closed sockets before a restarted daemon is called.
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (stopOptions.keepTmux) return;
    killTmux(tmuxSocket);
  };
  cleanups.push(() => stop());
  cleanups.unshift(async () => killTmux(tmuxSocket));
  return {
    daemon,
    client,
    passkey,
    dataDir,
    tmuxSocket,
    tempRoots,
    codeViewFirstPort,
    clock,
    agentRuntime,
    transportIdentity,
    accessIdentity,
    notifier,
    machine,
    secretReader,
    stop,
  };
}

export function collect(client: HosClient, since = 0) {
  const events: HosEvent[] = [];
  const subscription = client.subscribe((event) => events.push(event), { since });
  cleanups.push(async () => subscription.close());
  const until = async (predicate: (events: HosEvent[]) => boolean, timeoutMs = 5000) => {
    const deadline = Date.now() + deadlineMs(timeoutMs);
    while (!predicate(events)) {
      if (Date.now() > deadline) {
        throw new Error(`timed out; saw ${JSON.stringify(events.map((e) => e.type))}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return events;
  };
  return { events, subscription, until };
}

export function opensEventStream(client: HosClient, url: string, headers: Record<string, string>): Promise<boolean> {
  const protocols = client.sessionToken ? ['hos', SESSION_PROTOCOL + client.sessionToken] : [];
  return new Promise((resolve) => {
    const ws = new WebSocket(`${url.replace('http', 'ws')}/api/events`, { protocols, headers } as never);
    ws.onopen = () => {
      ws.close();
      resolve(true);
    };
    ws.onerror = () => resolve(false);
  });
}

function killTmux(socket: string): void {
  if (!existsSync(socket)) return;
  try {
    execFileSync('tmux', ['-S', socket, 'kill-server'], { stdio: 'ignore' });
  } catch {}
}

export function screen(client: HosClient, name: string, size = { cols: 200, rows: 50 }) {
  let output = '';
  let exited = false;
  const attachment = client.attachTerminal(name, {
    ...size,
    onData: (data) => (output += data),
    onExit: () => (exited = true),
  });
  cleanups.push(async () => attachment.close());
  const text = () =>
    output
      .replace(/\x1b\[(\d*)C/g, (_, n: string) => ' '.repeat(Number(n || 1)))
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][0-9A-Za-z]|\x1b[=>78DEHMc]/g, '');
  const wait = async (done: () => boolean, what: string, timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    while (!done()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; screen: ${JSON.stringify(text().slice(-500))}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  return {
    write: (data: string) => attachment.write(data),
    text,
    until: (pattern: RegExp, timeoutMs = 10_000) => wait(() => pattern.test(text()), String(pattern), timeoutMs),
    exited: (timeoutMs = 10_000) => wait(() => exited, 'exit', timeoutMs),
    close: () => attachment.close(),
  };
}
