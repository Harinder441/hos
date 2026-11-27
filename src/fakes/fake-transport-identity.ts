import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import type { Clock } from '../adapters/clock.js';
import { certsUrl, type AccessCerts, type AccessKey, type CloudflareConfig } from '../adapters/cloudflare-transport.js';
import type { TailscaleCli, TailscaleStatus } from '../adapters/tailscale-transport.js';

export class FakeTransportIdentity implements TailscaleCli {
  state: TailscaleStatus = { backendState: 'Running', dnsName: 'hos-mac.tail0000.ts.net', login: 'owner@test.invalid', ipv4: '127.0.0.1' };
  statusCalls = 0;

  async status(): Promise<TailscaleStatus> {
    this.statusCalls++;
    return { ...this.state };
  }

  headers(login = this.state.login ?? 'nobody@test.invalid'): Record<string, string> {
    return { 'Tailscale-User-Login': login, 'Tailscale-User-Name': login.split('@')[0]! };
  }

  get origin(): string {
    return `https://${this.state.dnsName}`;
  }
}

interface SigningKey {
  kid: string;
  privateKey: KeyObject;
  jwk: AccessKey;
}

export class FakeAccessIdentity implements AccessCerts {
  readonly config: CloudflareConfig = {
    team: 'hos-test',
    aud: 'hos-test-aud',
    hostname: 'hos.test.invalid',
    previews: 'hos-{port}.test.invalid',
    email: 'owner@test.invalid',
  };
  readonly url = certsUrl(this.config.team);
  reachable = true;
  fetches = 0;
  private signingKey?: SigningKey;
  private previousKey?: SigningKey;
  private publishedKeys?: SigningKey[];

  constructor(private readonly clock: Clock) {}

  // Every test daemon builds this fake and an RSA key takes ~120 ms, so the first key is made only when used.
  private get signing(): SigningKey {
    return (this.signingKey ??= newKey());
  }

  private get previous(): SigningKey {
    return this.previousKey ?? this.signing;
  }

  private get published(): SigningKey[] {
    return this.publishedKeys ?? [this.signing];
  }

  async keys(): Promise<AccessKey[]> {
    this.fetches++;
    if (!this.reachable) throw new Error('getaddrinfo ENOTFOUND hos-test.cloudflareaccess.com');
    return this.published.map((key) => key.jwk);
  }

  rotate(): void {
    this.previousKey = this.signing;
    this.signingKey = newKey();
    this.publishedKeys = [this.signingKey, this.previousKey];
  }

  retirePrevious(): void {
    this.publishedKeys = [this.signing];
  }

  signedWithPrevious(): string {
    return this.token({}, this.previous);
  }

  token(claims: Record<string, unknown> = {}, key = this.signing): string {
    const now = Math.floor(this.clock.now() / 1000);
    const payload = {
      aud: [this.config.aud],
      email: this.config.email,
      exp: now + 3600,
      iat: now,
      nbf: now,
      iss: `https://${this.config.team}.cloudflareaccess.com`,
      type: 'app',
      sub: 'b7d0f1a2-0000-4000-8000-000000000001',
      ...claims,
    };
    const input = `${encode({ alg: 'RS256', kid: key.kid, typ: 'JWT' })}.${encode(payload)}`;
    return `${input}.${sign('sha256', Buffer.from(input), key.privateKey).toString('base64url')}`;
  }

  forged(): string {
    return this.token({}, { ...newKey(), kid: this.signing.kid });
  }

  unsigned(): string {
    const [, payload] = this.token().split('.');
    return `${encode({ alg: 'none', kid: this.signing.kid })}.${payload}.`;
  }

  headers(claims?: Record<string, unknown>): Record<string, string> {
    return { 'Cf-Access-Jwt-Assertion': this.token(claims) };
  }

  get origin(): string {
    return `https://${this.config.hostname}`;
  }
}

function newKey(): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = randomBytes(32).toString('hex');
  const { n, e } = publicKey.export({ format: 'jwk' });
  return { kid, privateKey, jwk: { kid, kty: 'RSA', alg: 'RS256', use: 'sig', n: n!, e: e! } };
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
