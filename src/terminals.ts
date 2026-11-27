import { spawn, type IPty } from 'node-pty';
import type { WebSocket } from 'ws';
import type { Tmux } from './tmux.js';

export interface TerminalSize {
  cols: number;
  rows: number;
}

type ClientFrame = { type: 'input'; data: string } | { type: 'resize'; cols: number; rows: number };

export class TerminalAttachments {
  private readonly ptys = new Set<IPty>();

  constructor(private readonly tmux: Tmux) {}

  attach(name: string, size: TerminalSize, socket: WebSocket): void {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined && key !== 'TMUX') env[key] = value;
    const pty = spawn('tmux', [...this.tmux.baseArgs, 'attach-session', '-t', `=${name}`], {
      name: 'xterm-256color',
      cols: clamp(size.cols, 80),
      rows: clamp(size.rows, 24),
      env: { ...env, TERM: 'xterm-256color' },
    });
    this.ptys.add(pty);
    pty.onData((data) => socket.send(data));
    pty.onExit(() => {
      this.ptys.delete(pty);
      socket.close(1000, 'terminal closed');
    });
    socket.on('message', (raw) => {
      let frame: ClientFrame;
      try {
        frame = JSON.parse(String(raw)) as ClientFrame;
      } catch {
        return;
      }
      if (frame.type === 'input' && typeof frame.data === 'string') pty.write(frame.data);
      if (frame.type === 'resize') pty.resize(clamp(frame.cols, pty.cols), clamp(frame.rows, pty.rows));
    });
    socket.on('close', () => {
      if (this.ptys.delete(pty)) pty.kill();
    });
  }

  stop(): void {
    for (const pty of this.ptys) pty.kill();
    this.ptys.clear();
  }
}

function clamp(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 2 && n <= 1000 ? n : fallback;
}
