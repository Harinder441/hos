import { describe, expect, test } from 'vitest';
import { TailscaleCliProcess, TailscaleTransport } from '../src/adapters/tailscale-transport.js';

describe.skipIf(!process.env.HOS_LIVE_TAILSCALE)('live contract: the real Tailscale CLI (read-only status)', () => {
  test('status reports the Mac’s tailnet name and owner, and the doctor reads it', async () => {
    const cli = new TailscaleCliProcess();
    const status = await cli.status();

    expect(status.dnsName).toMatch(/\.ts\.net$/);
    expect(status.login).toMatch(/@/);
    const report = await new TailscaleTransport(cli).doctor(4517);
    expect(report.ok).toBe(status.backendState === 'Running');
    await expect(new TailscaleTransport(cli).previewUrl(4123)).resolves.toBe(`https://${status.dnsName}:4123`);
  });
});
