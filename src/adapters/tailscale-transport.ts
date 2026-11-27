import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { promisify } from 'node:util';
import { fromLoopback, type DoctorReport, type Identity, type Transport } from './transport.js';

export interface TailscaleStatus {
  backendState: string;
  dnsName: string | null;
  login: string | null;
  ipv4?: string | null;
}

export interface TailscaleCli {
  status(): Promise<TailscaleStatus>;
}

const LOGIN_HEADER = 'tailscale-user-login';

export class TailscaleTransport implements Transport {
  readonly name = 'tailscale';
  private known: { dnsName: string | null; login: string | null } = { dnsName: null, login: null };

  constructor(private readonly cli: TailscaleCli) {}

  async identify(req: IncomingMessage): Promise<Identity | null> {
    const login = req.headers[LOGIN_HEADER];
    if (!fromLoopback(req) || typeof login !== 'string') return null;
    const owner = (await this.self()).login;
    return owner && login === owner ? { user: login, via: 'tailscale' } : null;
  }

  async webOrigin(): Promise<string | null> {
    const { dnsName } = await this.self();
    return dnsName ? `https://${dnsName}` : null;
  }

  async previewUrl(port: number): Promise<string | null> {
    const { dnsName } = await this.self();
    return dnsName ? `https://${dnsName}:${port}` : null;
  }

  async doctor(daemonPort: number): Promise<DoctorReport> {
    const status = await this.cli.status();
    this.remember(status);
    const publish = `tailscale serve --bg --https=443 http://127.0.0.1:${daemonPort}`;
    if (status.backendState === 'NotInstalled') {
      return {
        transport: this.name,
        ok: false,
        message: 'Tailscale isn’t installed on this Mac, so hos can’t be reached from the phone.',
        fix: ['Install Tailscale from https://tailscale.com/download/mac and sign in', publish],
      };
    }
    if (status.backendState !== 'Running') {
      return {
        transport: this.name,
        ok: false,
        message: `Tailscale isn’t running on this Mac (${status.backendState}), so the phone can’t reach hos.`,
        fix: ['Open Tailscale from the menu bar and connect (set it to launch at login)', publish],
      };
    }
    return {
      transport: this.name,
      ok: true,
      message: `Tailscale is running. Open hos at https://${status.dnsName} from any of your tailnet devices.`,
      fix: [`If that URL doesn’t load, publish hos inside the tailnet (never Funnel): ${publish}`],
    };
  }

  async codeViewHost(): Promise<{ bind: string; host: string }> {
    const status = await this.cli.status();
    this.remember(status);
    if (status.backendState !== 'Running' || !status.ipv4 || !status.dnsName) return { bind: '127.0.0.1', host: 'localhost' };
    return { bind: status.ipv4, host: status.dnsName };
  }

  private async self(): Promise<{ dnsName: string | null; login: string | null }> {
    if (!this.known.login || !this.known.dnsName) this.remember(await this.cli.status());
    return this.known;
  }

  private remember(status: TailscaleStatus): void {
    this.known = { dnsName: status.dnsName ?? this.known.dnsName, login: status.login ?? this.known.login };
  }
}

const APP_CLI = '/Applications/Tailscale.app/Contents/MacOS/tailscale';

export function defaultTailscaleBin(): string {
  return existsSync(APP_CLI) ? APP_CLI : 'tailscale';
}

export class TailscaleCliProcess implements TailscaleCli {
  constructor(private readonly bin = defaultTailscaleBin()) {}

  async status(): Promise<TailscaleStatus> {
    let stdout: string;
    try {
      ({ stdout } = await promisify(execFile)(this.bin, ['status', '--json'], { timeout: 5000, maxBuffer: 16 * 1024 * 1024 }));
    } catch (error) {
      const failed = error as NodeJS.ErrnoException & { stdout?: string };
      if (failed.code === 'ENOENT') return { backendState: 'NotInstalled', dnsName: null, login: null };
      if (!failed.stdout) return { backendState: 'Unreachable', dnsName: null, login: null };
      stdout = failed.stdout;
    }
    return parseStatus(stdout);
  }
}

export function parseStatus(json: string): TailscaleStatus {
  const doc = JSON.parse(json) as {
    BackendState?: string;
    Self?: { DNSName?: string; UserID?: number; TailscaleIPs?: string[] };
    User?: Record<string, { LoginName?: string }>;
  };
  const dnsName = doc.Self?.DNSName?.replace(/\.$/, '') || null;
  const login = doc.Self?.UserID !== undefined ? (doc.User?.[String(doc.Self.UserID)]?.LoginName ?? null) : null;
  const ipv4 = doc.Self?.TailscaleIPs?.find((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip)) ?? null;
  return { backendState: doc.BackendState ?? 'Unknown', dnsName, login, ipv4 };
}
