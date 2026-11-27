import { afterEach, expect, test } from 'vitest';
import { HosClient } from '../src/api/client.js';
import { cleanupAll, opensEventStream, startTestDaemon, tempGitRepo } from './harness.js';

afterEach(cleanupAll);

test('requests carrying Tailscale serve’s identity headers for the Mac’s owner are served', async () => {
  const hos = await startTestDaemon();

  await expect(hos.client.createProject(await tempGitRepo())).resolves.toMatchObject({ id: expect.any(String) });
  expect(await opensEventStream(hos.client, hos.daemon.url, hos.transportIdentity.headers())).toBe(true);
});

test('requests without Tailscale identity headers, or with another tailnet user’s login, are refused', async () => {
  const hos = await startTestDaemon();
  const repo = await tempGitRepo();
  const sessionToken = hos.client.sessionToken!;
  const strangerHeaders = hos.transportIdentity.headers('mallory@example.com');
  const bare = new HosClient(hos.daemon.url, { sessionToken });
  const stranger = new HosClient(hos.daemon.url, { headers: strangerHeaders, sessionToken });

  await expect(bare.createProject(repo)).rejects.toMatchObject({ status: 401 });
  await expect(stranger.createProject(repo)).rejects.toMatchObject({ status: 401 });
  expect(await opensEventStream(bare, hos.daemon.url, {})).toBe(false);
  expect(await opensEventStream(stranger, hos.daemon.url, strangerHeaders)).toBe(false);
});

test('the doctor says Tailscale isn’t running and how to fix it, without needing an identity', async () => {
  const hos = await startTestDaemon();
  hos.transportIdentity.state = { ...hos.transportIdentity.state, backendState: 'Stopped' };

  const report = await new HosClient(hos.daemon.url).doctor();

  expect(report).toMatchObject({ transport: 'tailscale', ok: false });
  expect(report.message).toMatch(/Tailscale isn’t running on this Mac \(Stopped\)/);
  expect(report.fix).toContain(`tailscale serve --bg --https=443 http://127.0.0.1:${hos.daemon.port}`);
  expect(report.fix.join('\n')).not.toMatch(/funnel/i);

  hos.transportIdentity.state = { ...hos.transportIdentity.state, backendState: 'Running' };
  await expect(hos.client.doctor()).resolves.toMatchObject({
    ok: true,
    message: expect.stringContaining('https://hos-mac.tail0000.ts.net'),
  });
});

test('a dev server’s preview opens on its own HTTPS port on the Mac’s tailnet name', async () => {
  const hos = await startTestDaemon();

  await expect(hos.client.previewUrl(4123)).resolves.toBe('https://hos-mac.tail0000.ts.net:4123');
  await expect(hos.client.previewUrl(70000)).rejects.toMatchObject({ status: 400 });
});

test('the agents’ bus is not published through the transport: requests that came through serve are refused', async () => {
  const hos = await startTestDaemon();

  const response = await fetch(`${hos.daemon.url}/bus`, {
    method: 'POST',
    headers: { ...hos.transportIdentity.headers(), 'x-forwarded-for': '100.64.0.2', 'content-type': 'application/json' },
    body: '{}',
  });

  expect(response.status).toBe(403);
});
