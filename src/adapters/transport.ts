import type { IncomingMessage } from 'node:http';
import type { DoctorReport } from '../api/types.js';

export type { DoctorReport };

export interface Identity {
  user: string;
  via: string;
  computer?: string;
}

export interface Transport {
  readonly name: string;
  identify(req: IncomingMessage): Promise<Identity | null>;
  webOrigin(daemonPort: number): Promise<string | null>;
  previewUrl(port: number): Promise<string | null>;
  previewPort?(host: string | undefined): number | null;
  doctor(daemonPort: number): Promise<DoctorReport>;
  codeViewHost(): Promise<{ bind: string; host: string }>;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function fromLoopback(req: IncomingMessage): boolean {
  return LOOPBACK.has(req.socket.remoteAddress ?? '');
}

export const loopbackTransport: Transport = {
  name: 'loopback',
  identify: async (req) => (fromLoopback(req) ? { user: 'local', via: 'loopback' } : null),
  webOrigin: async (daemonPort) => `http://localhost:${daemonPort}`,
  previewUrl: async (port) => `http://localhost:${port}`,
  codeViewHost: async () => ({ bind: '127.0.0.1', host: 'localhost' }),
  doctor: async (daemonPort) => ({
    transport: 'loopback',
    ok: true,
    message: `Loopback only: hos is reachable from this Mac at http://localhost:${daemonPort} and from nowhere else.`,
    fix: [],
  }),
};
