import { accessSync, constants, existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { connect, createServer, isIP } from 'node:net';
import { homedir } from 'node:os';
import { basename, delimiter, isAbsolute, join, normalize, sep } from 'node:path';
import type { Transport } from './adapters/transport.js';
import type { CodeViewOpened, StatusItem } from './api/types.js';
import { HosError } from './core.js';
import { sessionName, type Tmux } from './tmux.js';

export const CODE_VIEW_FIRST_PORT = 7777;
const CODE_VIEW_PORT_SPAN = 200;
const START_WAIT_MS = 10_000;
// hos-code fetches and checks out the PR (its own 60 s limit) before it listens.
const PR_START_WAIT_MS = 75_000;
// hoscode, not hos-code: hos names other sessions hos-<slug>. px0 sessions from before the rename are still found and reused.
const PREFIX = 'hoscode';
const SESSION = /^(?:hoscode|px0)-.+-\d+$/;
const PR_SESSION = /^(?:hoscode|px0)-pr-/;
const LEGACY_BIN = 'px0';
// The pane turns the token files into plain values for the viewer, so every hos-code and px0 build works; px0 reads the old name.
const READ_TOKEN_FILES = [
  '[ -z "${HOS_CODE_TOKEN_FILE:-}" ] || export HOS_CODE_TOKEN="$(cat "$HOS_CODE_TOKEN_FILE")";',
  '[ -z "${HOS_CODE_LOGIN_TOKEN_FILE:-}" ] || export HOS_CODE_LOGIN_TOKEN="$(cat "$HOS_CODE_LOGIN_TOKEN_FILE")";',
  `[ "\${0##*/}" != ${LEGACY_BIN} ] || [ -z "\${HOS_CODE_TOKEN:-}" ] || export HOS_PX0_TOKEN="$HOS_CODE_TOKEN";`,
  '[ -z "${HOS_CODE_GH_USER:-}" ] || { t="$(gh auth token --user "$HOS_CODE_GH_USER" 2>/dev/null)" && [ -n "$t" ] && export GITHUB_TOKEN="$t"; unset t; };',
  'exec "$0" "$@"',
].join(' ');

export function findBin(name: string, configured: string | undefined, fallback: string): string | null {
  const runnable = (path: string) => {
    try {
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (configured) return runnable(configured) ? configured : null;
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    if (runnable(join(dir, name))) return join(dir, name);
  }
  return runnable(fallback) ? fallback : null;
}

export function defaultCodeViewBin(configured?: string): string | null {
  const bin = findBin('hos-code', configured, join(homedir(), '.local', 'bin', 'hos-code'));
  if (bin || configured) return bin;
  return findBin(LEGACY_BIN, undefined, join(homedir(), '.local', 'bin', LEGACY_BIN));
}

export function codeViewBindAllowed(bind: string): boolean {
  if (bind === '127.0.0.1' || bind === '::1') return true;
  const parts = bind.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127;
}

export interface CodeViewDeps {
  tmux: Tmux;
  transport: Transport;
  bin: string | null;
  checkouts: () => string[];
  firstPort?: number;
  // HOS_URL and the bridge token, so hos-code's Mark Snag and reviews reach hos.
  bridge?: () => { url: string; token: string; tokenFile: string } | null;
  // Required by hos-code off loopback; hos adds it to every link it builds.
  login?: { token: string; file: string };
}

export class CodeView {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: CodeViewDeps) {}

  doctorItem(): StatusItem | null {
    if (this.deps.bin) return null;
    return {
      id: 'hos-code',
      label: 'hos-code',
      status: 'warn',
      detail: 'hos-code was not found, so Open in Code view can’t start',
      fix: 'install hos-code into ~/.local/bin (or put it on PATH), or point HOS_CODE_BIN / --hos-code-bin at it',
    };
  }

  open(path: string, file?: string): Promise<CodeViewOpened> {
    const run = this.queue.then(() => this.openNow(path, file));
    this.queue = run.catch(() => {});
    return run;
  }

  openPr(pr: { url: string; owner: string; repo: string; number: number }, cwd: string, knownPort: number | null): Promise<CodeViewOpened & { port: number }> {
    const run = this.queue.then(() => this.openPrNow(pr, cwd, knownPort));
    this.queue = run.catch(() => {});
    return run;
  }

  private async openNow(path: string, file?: string): Promise<CodeViewOpened> {
    const rel = file === undefined ? undefined : relativeFile(file);
    let root = await this.checkoutOf(path);
    // Chat replies name brain files relative to the brain, but the web resolves relative paths against the topic's repo.
    if (rel !== undefined && !existsSync(join(root, rel))) root = (await this.checkoutWith(rel)) ?? root;
    const { bin, bind, link } = await this.target(rel === undefined ? {} : { path: rel });
    const sessions = await this.viewerSessions();
    for (const session of sessions.filter((s) => s.cwd === root)) {
      const port = portOf(session.name);
      if (await answers(bind, port)) return { url: link(port), session: session.name, reused: true };
      await this.deps.tmux.kill(session.name);
    }
    const taken = new Set(sessions.map((session) => portOf(session.name)));
    const port = await freePort(bind, taken, this.deps.firstPort ?? CODE_VIEW_FIRST_PORT);
    const name = `${PREFIX}-${sessionName(basename(root))}-${port}`;
    await this.launch(name, root, [bin, '-no-open', '-no-telemetry', '-host', bind, '-port', String(port), '.'], bind, port, START_WAIT_MS);
    return { url: link(port), session: name, reused: false };
  }

  private async openPrNow(pr: { url: string; owner: string; repo: string; number: number }, cwd: string, knownPort: number | null): Promise<CodeViewOpened & { port: number }> {
    const { bin, bind, link } = await this.target({});
    const name = `${PREFIX}-pr-${sessionName(pr.repo)}-${pr.number}`;
    for (const existing of [name, `${LEGACY_BIN}-pr-${sessionName(pr.repo)}-${pr.number}`]) {
      if (!(await this.deps.tmux.has(existing))) continue;
      if (knownPort && (await answers(bind, knownPort))) return { url: link(knownPort), session: existing, reused: true, port: knownPort };
      await this.deps.tmux.kill(existing);
    }
    const sessions = await this.viewerSessions();
    const port = await freePort(bind, new Set(sessions.map((session) => portOf(session.name))), this.deps.firstPort ?? CODE_VIEW_FIRST_PORT);
    const exited = (output: string) =>
      /fetch PR #\d+: 404\b/.test(output)
        ? new HosError(404, `GitHub answered 404 for this PR: no signed-in gh account hos tried can see ${pr.owner}/${pr.repo} (sign one in with gh auth login)`)
        : exitedError(output);
    await this.launch(name, cwd, [bin, '-no-open', '-no-telemetry', '-host', bind, '-port', String(port), pr.url], bind, port, PR_START_WAIT_MS, { HOS_CODE_GH_USER: pr.owner }, exited);
    return { url: link(port), session: name, reused: false, port };
  }

  private async viewerSessions() {
    return (await this.deps.tmux.list()).filter((session) => SESSION.test(session.name) && !PR_SESSION.test(session.name));
  }

  private async target(params: Record<string, string>): Promise<{ bin: string; bind: string; link: (port: number) => string }> {
    const bin = this.deps.bin;
    if (!bin) throw new HosError(503, 'hos-code is not installed (GET /api/doctor/checks says how to fix it)');
    const { bind, host } = await this.deps.transport.codeViewHost();
    if (!codeViewBindAllowed(bind)) throw new HosError(500, `refusing to bind hos-code to ${bind}: only loopback or the tailnet address`);
    // By address, not a MagicDNS name: hos-code refuses POSTs whose Host is a DNS name (DNS-rebinding guard).
    const linkHost = host === 'localhost' || isIP(host) ? host : bind;
    const query = Object.entries(params);
    if (this.deps.login) query.push(['token', this.deps.login.token]);
    const search = query.length ? `?${query.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')}` : '';
    return { bin, bind, link: (port) => `http://${urlHost(linkHost)}:${port}/${search}` };
  }

  // tmux keeps its command line, -e values included, where any local account reads it with ps: only file paths go there.
  private env(): Record<string, string> {
    const env: Record<string, string> = {};
    const bridge = this.deps.bridge?.();
    if (bridge) Object.assign(env, { HOS_URL: bridge.url, HOS_CODE_TOKEN_FILE: bridge.tokenFile });
    if (this.deps.login) env.HOS_CODE_LOGIN_TOKEN_FILE = this.deps.login.file;
    return env;
  }

  private async launch(
    name: string,
    cwd: string,
    [bin, ...args]: string[],
    bind: string,
    port: number,
    waitMs: number,
    extraEnv: Record<string, string> = {},
    exited = exitedError,
  ): Promise<void> {
    await this.deps.tmux.create({ name, cwd, command: ['sh', '-c', READ_TOKEN_FILES, bin!, ...args], env: { ...this.env(), ...extraEnv }, keepOnExit: true });
    const deadline = Date.now() + waitMs;
    while (!(await answers(bind, port))) {
      const pane = (await this.deps.tmux.panes()).find((p) => p.session === name);
      if (!pane || pane.dead) {
        const output = await this.deps.tmux.capture(name, 50).catch(() => '');
        await this.deps.tmux.kill(name);
        throw exited(output);
      }
      if (Date.now() > deadline) {
        await this.deps.tmux.kill(name);
        throw new HosError(504, `hos-code did not answer on ${bind}:${port} within ${waitMs / 1000} s`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await this.deps.tmux.keepOnExit(name, false).catch(() => {});
  }

  private async checkoutOf(path: string): Promise<string> {
    if (!isAbsolute(path)) throw new HosError(400, 'path must be absolute');
    const real = await realpath(path).catch(() => {
      throw new HosError(400, `no such path: ${path}`);
    });
    const roots = await Promise.all(this.deps.checkouts().map((root) => realpath(root).catch(() => null)));
    const root = roots
      .filter((r): r is string => !!r && (real === r || real.startsWith(r.endsWith(sep) ? r : r + sep)))
      .sort((a, b) => b.length - a.length)[0];
    if (!root) throw new HosError(400, `${path} is not inside the brain or a known project`);
    return root;
  }

  private async checkoutWith(file: string): Promise<string | null> {
    for (const root of this.deps.checkouts()) {
      if (existsSync(join(root, file))) return realpath(root);
    }
    return null;
  }
}

function relativeFile(file: string): string {
  const clean = normalize(file).replace(/^\.\/+/, '');
  if (!file.trim() || isAbsolute(file) || clean === '..' || clean.startsWith(`..${sep}`)) {
    throw new HosError(400, 'file must be a path inside the checkout');
  }
  return clean.split(sep).join('/');
}

function exitedError(output: string): HosError {
  const last = output.split('\n').map((line) => line.trim()).filter(Boolean).at(-1);
  return new HosError(502, `hos-code exited before it answered${last ? `: ${last}` : ''}`);
}

function urlHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

function portOf(name: string): number {
  return Number(/-(\d+)$/.exec(name)![1]);
}

async function answers(bind: string, port: number): Promise<boolean> {
  try {
    await fetch(`http://${urlHost(bind)}:${port}/`, { signal: AbortSignal.timeout(1000) }).then((res) => res.body?.cancel());
    return true;
  } catch {
    return false;
  }
}

function accepts(bind: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: bind, port });
    socket.setTimeout(500);
    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

function bindable(bind: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen({ host: bind, port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

async function freePort(bind: string, taken: Set<number>, first: number): Promise<number> {
  for (let port = first; port <= first + CODE_VIEW_PORT_SPAN; port++) {
    if (taken.has(port)) continue;
    if (!(await accepts(bind, port)) && (await bindable(bind, port))) return port;
  }
  throw new HosError(503, `no free port for hos-code between ${first} and ${first + CODE_VIEW_PORT_SPAN}`);
}
