import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, test } from 'vitest';
import { AccessCertsFetch, certsUrl, CloudflareTransport } from '../src/adapters/cloudflare-transport.js';
import { systemClock } from '../src/adapters/clock.js';

const team = process.env.HOS_LIVE_CLOUDFLARE_TEAM;
const token = process.env.HOS_LIVE_CLOUDFLARE_TOKEN;
const config = {
  team: team ?? '',
  aud: process.env.HOS_LIVE_CLOUDFLARE_AUD ?? '',
  hostname: process.env.HOS_LIVE_CLOUDFLARE_HOSTNAME ?? 'hos.example.com',
  previews: 'hos-{port}.example.com',
  email: process.env.HOS_LIVE_CLOUDFLARE_EMAIL ?? '',
};

describe.skipIf(!team)('live contract: Cloudflare Access signing keys (read-only)', () => {
  test('the team publishes RS256 keys with key ids, and the doctor loads them', async () => {
    const certs = new AccessCertsFetch(certsUrl(team!));
    const keys = await certs.keys();

    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(key).toMatchObject({ kty: 'RSA', alg: 'RS256', kid: expect.any(String) });
    await expect(new CloudflareTransport(config, certs, systemClock).doctor()).resolves.toMatchObject({ ok: true });
  });

  test.skipIf(!token)('a real Access token from the browser’s CF_Authorization cookie verifies as the owner', async () => {
    const transport = new CloudflareTransport(config, new AccessCertsFetch(certsUrl(team!)), systemClock);
    const server = createServer(async (req, res) => res.end(JSON.stringify(await transport.identify(req))));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`, {
        headers: { 'Cf-Access-Jwt-Assertion': token! },
      });
      expect(await response.json()).toEqual({ user: config.email, via: 'cloudflare' });
    } finally {
      server.close();
    }
  });
});
