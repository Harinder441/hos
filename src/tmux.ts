import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface TmuxSession {
  name: string;
  cwd: string;
  createdAt: number;
  attachedClients: number;
  topicId: string | null;
  busy: boolean;
}

export interface NewSession {
  name: string;
  cwd: string;
  command?: string[];
  env?: Record<string, string>;
  topicId?: string;
  keepOnExit?: boolean;
}

export interface TmuxPane {
  session: string;
  pid: number;
  sessionPath: string;
  dead: boolean;
  hosServer: boolean;
  startCommand: string | null;
}

const SERVER_MARKER = '@hos-server';
const TOPIC_MARKER = '@hos-topic';
const FIELDS = ['#{session_name}', '#{session_path}', '#{session_created}', '#{session_attached}', `#{${TOPIC_MARKER}}`, '#{pane_current_command}'].join('\t');
// env is the `env -u PORT` wrapper for the instant before it execs the shell; tmux is a new pane before its command execs.
const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'tcsh', 'csh', 'login', 'env', 'tmux']);
const PANE_FIELDS = ['#{session_name}', '#{pane_pid}', '#{session_path}', '#{pane_dead}', `#{${SERVER_MARKER}}`, '#{pane_start_command}'].join('\t');

function unquote(command: string): string | null {
  if (!command) return null;
  const single = /^"((?:[^"\\]|\\.)*)"$/.exec(command);
  return single ? single[1]!.replace(/\\(.)/g, '$1') : command;
}

export class Tmux {
  constructor(private readonly socket?: string) {}

  get socketPath(): string | undefined {
    return this.socket;
  }

  get baseArgs(): string[] {
    // Without a UTF-8 locale (launchd sets none) tmux prints tabs in -F output as '_'.
    return ['-u', ...(this.socket ? ['-S', this.socket] : [])];
  }

  async list(): Promise<TmuxSession[]> {
    const output = await this.tmux('list-sessions', '-F', FIELDS).catch((error: Error) => {
      if (/no server running|error connecting|No such file/i.test(error.message)) return '';
      throw error;
    });
    return output
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, cwd, created, attached, topic, command] = line.split('\t');
        return {
          name: name!,
          cwd: cwd!,
          createdAt: Number(created) * 1000,
          attachedClients: Number(attached),
          topicId: topic || null,
          busy: !SHELLS.has((command ?? '').replace(/^-/, '')),
        };
      });
  }

  async has(name: string): Promise<boolean> {
    return this.tmux('has-session', '-t', `=${name}`).then(
      () => true,
      () => false,
    );
  }

  async create(session: NewSession): Promise<void> {
    const env = Object.entries(session.env ?? {}).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
    await this.tmux(
      'new-session', '-d', '-s', session.name, '-c', session.cwd, '-x', '200', '-y', '50', ...env, ...(session.command ?? []),
      ';', 'set-option', '-t', `=${session.name}:`, 'status', 'off',
      ...(session.topicId ? [';', 'set-option', '-t', `=${session.name}:`, TOPIC_MARKER, session.topicId] : []),
      ...(session.keepOnExit ? [';', 'set-option', '-t', `=${session.name}:`, 'remain-on-exit', 'on'] : []),
    );
  }

  async keepOnExit(name: string, on: boolean): Promise<void> {
    await this.tmux('set-option', '-t', `=${name}:`, 'remain-on-exit', on ? 'on' : 'off');
  }

  async kill(name: string): Promise<void> {
    await this.tmux('kill-session', '-t', `=${name}`).catch(() => {});
  }

  async panes(): Promise<TmuxPane[]> {
    const output = await this.tmux('list-panes', '-a', '-F', PANE_FIELDS).catch((error: Error) => {
      if (/no server running|error connecting|No such file/i.test(error.message)) return '';
      throw error;
    });
    return output
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [session, pid, path, dead, marker, ...command] = line.split('\t');
        return {
          session: session!,
          pid: Number(pid),
          sessionPath: path!,
          dead: dead === '1',
          hosServer: marker === '1',
          startCommand: unquote(command.join('\t')),
        };
      });
  }

  async createServer(session: Omit<NewSession, 'command'> & { command: string }): Promise<void> {
    const env = Object.entries(session.env ?? {}).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
    await this.tmux(
      'new-session', '-d', '-s', session.name, '-c', session.cwd, '-x', '200', '-y', '50', ...env, session.command,
      ';', 'set-option', '-t', `=${session.name}:`, 'remain-on-exit', 'on',
      ';', 'set-option', '-t', `=${session.name}:`, SERVER_MARKER, '1',
      ';', 'set-option', '-t', `=${session.name}:`, 'status', 'off',
    );
  }

  async respawn(name: string): Promise<void> {
    await this.tmux('respawn-pane', '-k', '-t', `=${name}:`);
  }

  async capture(name: string, lines: number): Promise<string> {
    return this.tmux('capture-pane', '-p', '-J', '-t', `=${name}:`, '-S', `-${lines}`);
  }

  private async tmux(...args: string[]): Promise<string> {
    const env = { ...process.env };
    delete env.TMUX;
    const { stdout } = await run('tmux', [...this.baseArgs, ...args], { env });
    return stdout;
  }
}

export function sessionName(text: string): string {
  return text.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'hos';
}
