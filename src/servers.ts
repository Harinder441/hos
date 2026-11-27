import { realpath } from 'node:fs/promises';
import type { Clock } from './adapters/clock.js';
import { HosError } from './core.js';
import type { DevServer, EventBody, ServerState, ServersView, UnmanagedListener, Worktree } from './api/types.js';
import { descendants, processChildren, tcpListeners } from './listeners.js';
import type { BusReply } from './bus.js';
import { ownerStart } from './owner.js';
import type { Store } from './store.js';
import { sessionName, type Tmux, type TmuxPane } from './tmux.js';

export const SCAN_MS = 5000;
export const AIRPLAY_PORTS = new Set([5000, 7000]);
const TAIL_LINES = 50;
const TAIL_MAX = 500;
const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'tcsh', 'csh']);

const SYSTEM_LISTENERS = new Set([
  'ControlCenter',
  'rapportd',
  'launchd',
  'mDNSResponder',
  'sharingd',
  'AirPlayXPCHelper',
  'identityservicesd',
  'remoted',
  'cupsd',
  'sshd',
  'screensharingd',
  'tailscaled',
  'IPNExtension',
  'Tailscale',
  'systemd-resolved',
  'avahi-daemon',
  'x11vnc',
  'cups-browsed',
  'mysqld',
  'apache2',
]);

export interface StartRequest {
  worktreePath: string;
  app: string;
  command: string;
  port?: number;
}

export interface ServerDeps {
  store: Store;
  tmux: Tmux;
  clock: Clock;
  record: (body: EventBody) => void;
  previewUrl: (port: number) => Promise<string | null>;
  approve: (chatId: string, command: string, title: string) => Promise<boolean>;
}

export class Servers {
  private last = '';
  private cancelScan?: () => void;
  private stopped = false;

  constructor(private readonly deps: ServerDeps) {}

  watch(): void {
    const schedule = () => {
      this.cancelScan = this.deps.clock.setTimeout(() => {
        void this.tick()
          .catch((error) => console.error('server scan failed', error))
          .finally(() => this.stopped || schedule());
      }, SCAN_MS);
    };
    schedule();
  }

  unwatch(): void {
    this.stopped = true;
    this.cancelScan?.();
  }

  private async tick(): Promise<void> {
    // With no tmux panes there are no servers, so the lsof and ps scan can be skipped.
    if (!(await this.deps.tmux.panes()).length) return this.publish([]);
    await this.list();
  }

  private publish(servers: DevServer[]): void {
    const json = JSON.stringify(servers);
    if (json !== this.last && !this.stopped) {
      this.last = json;
      this.deps.record({ type: 'servers.updated', servers });
    }
  }

  async list(): Promise<ServersView> {
    const view = await this.scan();
    this.publish(view.servers);
    return view;
  }

  async start(request: StartRequest): Promise<DevServer> {
    const worktree = this.deps.store.getWorktree(request.worktreePath)?.snapshot;
    if (!worktree) throw new HosError(404, `no worktree ${request.worktreePath}`);
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(request.app)) throw new HosError(400, 'app must be 1-40 letters, digits, - or _');
    if (!request.command.trim()) throw new HosError(400, 'command is required');
    const port = request.port ?? worktree.port;
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new HosError(400, 'port must be between 1024 and 65535');
    if (AIRPLAY_PORTS.has(port)) throw new HosError(400, `port ${port} is held by the macOS AirPlay receiver; pick another`);
    const name = sessionName(`${worktree.name}-${request.app}-${port}`);
    if (await this.deps.tmux.has(name)) throw new HosError(409, `tmux session ${name} already exists`);
    const view = await this.scan();
    const holder =
      view.servers.find((s) => s.ports.includes(port))?.name ??
      view.unmanaged.filter((l) => l.ports.includes(port)).map((l) => `${l.command} (pid ${l.pid})`)[0];
    if (holder) throw new HosError(409, `port ${port} is already in use by ${holder}`);
    await this.deps.tmux.createServer({
      name,
      cwd: worktree.path,
      env: { PORT: String(port), HOS_PORT: String(port) },
      command: request.command,
    });
    const server = (await this.list()).servers.find((s) => s.name === name);
    if (!server) throw new HosError(500, `tmux did not report the session ${name}`);
    return server;
  }

  async stop(name: string): Promise<void> {
    await this.require(name);
    await this.deps.tmux.kill(name);
    await this.list();
  }

  async restart(name: string): Promise<DevServer> {
    const server = await this.require(name);
    if (isShell(server.command)) {
      throw new HosError(409, `${name} runs an interactive shell, so hos can't tell what to re-run; stop it and start it from hos`);
    }
    await this.deps.tmux.respawn(name);
    return (await this.list()).servers.find((s) => s.name === name) ?? server;
  }

  async tail(name: string, lines = TAIL_LINES): Promise<string> {
    await this.require(name);
    const count = Math.min(Math.max(1, Math.floor(lines) || TAIL_LINES), TAIL_MAX);
    const output = (await this.deps.tmux.capture(name, count)).replace(/\s+$/, '');
    return output.split('\n').slice(-count).join('\n');
  }

  async listForChat(): Promise<BusReply> {
    const { servers, unmanaged } = await this.list();
    const rows = servers.map((s) => `- ${s.name} · ${s.state}${s.ports.length ? ` · ports ${s.ports.join(', ')}` : ''} · ${s.worktreePath ?? s.cwd}`);
    const stray = unmanaged.map((l) => `- ${l.command} (pid ${l.pid}) · ports ${l.ports.join(', ')}`);
    return {
      outcome: 'ok',
      text: [
        `${servers.length} server${servers.length === 1 ? '' : 's'}:`,
        ...rows,
        ...(stray.length ? [`Unmanaged listeners (not started through tmux):`, ...stray] : []),
      ].join('\n'),
    };
  }

  async startForChat(chatId: string, request: { app: string; command: string; port?: number }): Promise<BusReply> {
    const worktree = this.ownWorktree(chatId);
    const port = request.port ?? this.deps.store.getWorktree(worktree)?.snapshot?.port;
    const name = sessionName(`${this.deps.store.getWorktree(worktree)?.snapshot?.name}-${request.app}-${port}`);
    if (!(await this.deps.approve(chatId, request.command, `Start server ${name}`))) {
      return { outcome: 'refused', text: `${ownerStart()} denied starting ${name}.` };
    }
    const server = await this.start({ worktreePath: worktree, ...request });
    return { outcome: 'ok', text: `Started ${server.name} (${server.state}) with PORT=${port}. Use server_tail to watch it.` };
  }

  async stopForChat(chatId: string, name: string): Promise<BusReply> {
    await this.requireOwn(chatId, name);
    await this.stop(name);
    return { outcome: 'ok', text: `Stopped ${name}.` };
  }

  async restartForChat(chatId: string, name: string): Promise<BusReply> {
    await this.requireOwn(chatId, name);
    const server = await this.restart(name);
    return { outcome: 'ok', text: `Restarted ${name} (${server.state}).` };
  }

  async tailForChat(name: string, lines: number): Promise<BusReply> {
    const output = await this.tail(name, lines);
    return { outcome: 'ok', text: `[output of server ${name} via the hos bus; not the user]\n${output || '(no output yet)'}` };
  }

  private ownWorktree(chatId: string): string {
    const folder = this.deps.store.topicFolder(this.deps.store.getChat(chatId)!.topicId);
    if (!folder) throw new Error('Refused: your topic has no workspace and hos has no brain, so you have no worktree to run servers in.');
    return folder;
  }

  private async requireOwn(chatId: string, name: string): Promise<void> {
    const { store } = this.deps;
    const chat = store.getChat(chatId)!;
    const attached = store.topicWorkspaceIds(chat.topicId).flatMap((id) => {
      const workspace = store.getWorkspace(id);
      return workspace && workspace.archivedAt === null ? [workspace.path] : [];
    });
    const mine = [...new Set([this.ownWorktree(chatId), ...(chat.worktreePath ? [chat.worktreePath] : []), ...attached])];
    const server = await this.require(name);
    const inside = (path: string) => mine.some((root) => path === root || path.startsWith(`${root}/`));
    if (!(server.worktreePath && mine.includes(server.worktreePath)) && !inside(server.cwd)) {
      throw new Error(`Refused: ${name} is not in your worktree or your topic's workspaces (${mine.join(', ')}).`);
    }
  }

  private async require(name: string): Promise<DevServer> {
    const server = (await this.scan()).servers.find((s) => s.name === name);
    if (!server) throw new HosError(404, `no server ${name}`);
    return server;
  }

  private async scan(): Promise<ServersView> {
    const { store, tmux } = this.deps;
    const [panes, listeners, children] = await Promise.all([tmux.panes(), tcpListeners(), processChildren()]);
    const worktrees = store.listProjects().flatMap((project) => store.listWorktrees(project.id));
    const owner = new Map<number, string>();
    for (const pane of panes) for (const pid of descendants(pane.pid, children)) owner.set(pid, pane.session);
    const portsBySession = new Map<string, number[]>();
    const unmanaged: Array<Omit<UnmanagedListener, 'previewUrl'>> = [];
    for (const listener of listeners) {
      if (listener.pid === process.pid || SYSTEM_LISTENERS.has(listener.command)) continue;
      const ports = listener.ports.filter((port) => !AIRPLAY_PORTS.has(port));
      if (!ports.length) continue;
      const session = owner.get(listener.pid);
      if (session) portsBySession.set(session, [...(portsBySession.get(session) ?? []), ...ports]);
      else unmanaged.push({ ...listener, ports });
    }
    const entry = async (name: string, cwd: string, command: string | null, ports: number[], state: ServerState): Promise<DevServer> => {
      const worktree = await worktreeFor(cwd, worktrees);
      return {
        name,
        app: appName(name, worktree),
        state,
        ports,
        cwd,
        worktreePath: worktree?.path ?? null,
        projectId: worktree?.projectId ?? null,
        command,
        previewUrl: await this.preview(ports[0] ?? namePort(name)),
      };
    };
    const servers: DevServer[] = [];
    const live = uniqueSessions(panes);
    for (const pane of live) {
      if (store.chatForTerminal(pane.session)) continue;
      const ports = [...new Set(portsBySession.get(pane.session) ?? [])].sort((a, b) => a - b);
      if (!ports.length && !pane.dead && !pane.hosServer) continue;
      const state = pane.dead ? 'exited' : ports.length ? 'listening' : 'starting';
      servers.push(await entry(pane.session, pane.sessionPath, pane.startCommand, ports, state));
    }
    return {
      servers: servers.sort((a, b) => a.name.localeCompare(b.name)),
      unmanaged: await Promise.all(
        unmanaged.sort((a, b) => a.ports[0]! - b.ports[0]!).map(async (l) => ({ ...l, previewUrl: await this.preview(l.ports[0]!) })),
      ),
    };
  }

  private async preview(port: number | null): Promise<string | null> {
    return port === null ? null : this.deps.previewUrl(port);
  }
}

function isShell(command: string | null): boolean {
  if (!command) return true;
  const words = command.trim().split(/\s+/);
  return words.length === 1 && SHELLS.has(words[0]!.replace(/^-/, '').split('/').pop()!);
}

function uniqueSessions(panes: TmuxPane[]): TmuxPane[] {
  const seen = new Map<string, TmuxPane>();
  for (const pane of panes) if (!seen.has(pane.session)) seen.set(pane.session, pane);
  return [...seen.values()];
}

async function worktreeFor(path: string, worktrees: Worktree[]): Promise<Worktree | undefined> {
  const real = await realpath(path).catch(() => path);
  return worktrees
    .filter((w) => real === w.path || real.startsWith(`${w.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

function namePort(name: string): number | null {
  const match = /-(\d+)$/.exec(name);
  return match ? Number(match[1]) : null;
}

function appName(name: string, worktree: Worktree | undefined): string | null {
  if (namePort(name) === null) return null;
  const rest = name.slice(0, name.lastIndexOf('-'));
  const prefix = worktree ? `${sessionName(worktree.name)}-` : null;
  if (prefix && rest.startsWith(prefix) && rest.length > prefix.length) return rest.slice(prefix.length);
  const dash = rest.lastIndexOf('-');
  return dash === -1 ? null : rest.slice(dash + 1);
}
