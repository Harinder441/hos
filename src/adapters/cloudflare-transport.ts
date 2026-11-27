import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Clock } from './clock.js';
import { fromLoopback, type DoctorReport, type Identity, type Transport } from './transport.js';

export interface CloudflareConfig {
  team: string;
  aud: string;
  hostname: string;
  previews: string;
  email: string;
}

export interface AccessKey {
  kid: string;
  kty: string;
  alg?: string;
  use?: string;
  n: string;
  e: string;
}

export interface AccessCerts {
  readonly url: string;
  keys(): Promise<AccessKey[]>;
}

const TOKEN_HEADER = 'cf-access-jwt-assertion';
const REFETCH_MS = 30_000;
const KEYS_TTL_MS = 60 * 60_000;

interface Claims {
  aud?: string | string[];
  iss?: string;
  exp?: number;
  email?: string;
}

export class CloudflareTransport implements Transport {
  readonly name = 'cloudflare';
  private keys = new Map<string, KeyObject>();
  private fetchedAt = -Infinity;
  private fetching: Promise<void> | undefined;
  private failure: string | undefined;
  private readonly previewHost: RegExp;

  constructor(
    private readonly config: CloudflareConfig,
    private readonly certs: AccessCerts,
    private readonly clock: Clock,
  ) {
    const pattern = config.previews.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\{port\\}', '(\\d{1,5})');
    this.previewHost = new RegExp(`^${pattern}$`, 'i');
  }

  async identify(req: IncomingMessage): Promise<Identity | null> {
    const token = req.headers[TOKEN_HEADER];
    if (!fromLoopback(req) || typeof token !== 'string') return null;
    const claims = await this.verify(token).catch(() => null);
    return claims ? { user: claims.email!, via: 'cloudflare' } : null;
  }

  private async verify(token: string): Promise<Claims | null> {
    const [header, payload, signature] = token.split('.');
    if (!header || !payload || signature === undefined) return null;
    const { alg, kid } = decode(header) as { alg?: string; kid?: string };
    if (alg !== 'RS256' || typeof kid !== 'string') return null;
    const key = await this.key(kid);
    if (!key || !verify('sha256', Buffer.from(`${header}.${payload}`), key, Buffer.from(signature, 'base64url'))) return null;
    const claims = decode(payload) as Claims;
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    const fresh = typeof claims.exp === 'number' && claims.exp * 1000 > this.clock.now();
    const issuer = claims.iss === `https://${this.config.team}.cloudflareaccess.com`;
    const owner = typeof claims.email === 'string' && claims.email.toLowerCase() === this.config.email.toLowerCase();
    return audiences.includes(this.config.aud) && fresh && issuer && owner ? claims : null;
  }

  private async key(kid: string): Promise<KeyObject | undefined> {
    if (!this.keys.has(kid) || this.clock.now() - this.fetchedAt >= KEYS_TTL_MS) await this.refreshIfStale();
    return this.keys.get(kid);
  }

  private async refreshIfStale(): Promise<void> {
    if (this.clock.now() - this.fetchedAt < REFETCH_MS) return;
    this.fetching ??= this.certs
      .keys()
      .then((keys) => {
        this.keys = new Map(keys.map((key) => [key.kid, createPublicKey({ key: { kty: key.kty, n: key.n, e: key.e }, format: 'jwk' })]));
        this.fetchedAt = this.clock.now();
        this.failure = undefined;
      })
      .catch((error: Error) => void (this.failure = error.message))
      .finally(() => (this.fetching = undefined));
    await this.fetching;
  }

  async webOrigin(): Promise<string | null> {
    return `https://${this.config.hostname}`;
  }

  async previewUrl(port: number): Promise<string | null> {
    return `https://${this.config.previews.replace('{port}', String(port))}`;
  }

  previewPort(host: string | undefined): number | null {
    const port = this.previewHost.exec(host ?? '')?.[1];
    return port ? Number(port) : null;
  }

  async codeViewHost(): Promise<{ bind: string; host: string }> {
    return { bind: '127.0.0.1', host: 'localhost' };
  }

  async doctor(): Promise<DoctorReport> {
    await this.refreshIfStale();
    const tunnel = `cloudflared tunnel run ${TUNNEL}`;
    if (this.failure !== undefined) {
      return {
        transport: this.name,
        ok: false,
        message: `hos can’t fetch Cloudflare Access’s signing keys from ${this.certs.url} (${this.failure}), so every request through the tunnel is refused.`,
        fix: [`Check this Mac is online and that cloudflare.team in policy.yaml is your Zero Trust team name`, `curl ${this.certs.url}`],
      };
    }
    return {
      transport: this.name,
      ok: true,
      message: `Cloudflare Access keys are loaded. Open hos at https://${this.config.hostname} from any browser; Access asks you to log in first.`,
      fix: [`If that URL doesn’t load, start the tunnel on this Mac: ${tunnel}`],
    };
  }
}

const TUNNEL = 'hos';

export class AccessCertsFetch implements AccessCerts {
  constructor(readonly url: string) {}

  async keys(): Promise<AccessKey[]> {
    const response = await fetch(this.url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return ((await response.json()) as { keys: AccessKey[] }).keys;
  }
}

export function certsUrl(team: string): string {
  return `https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`;
}

function decode(part: string): unknown {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}
