import { readFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { join } from 'node:path';
import { cleanupLater, type startTestDaemon } from './harness.js';

type TestHos = Awaited<ReturnType<typeof startTestDaemon>>;
export type Served = Server & { url: string };

export function listen(server: Server): Promise<Served> {
  cleanupLater(() => new Promise((resolve) => (server.closeAllConnections(), server.close(() => resolve()))));
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(Object.assign(server, { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }))));
}

export async function tailscaleServe(target: string, identity: Record<string, string>): Promise<Served & { drop(): void }> {
  const injected = { ...Object.fromEntries(Object.entries(identity).map(([k, v]) => [k.toLowerCase(), v])), 'x-forwarded-for': '100.64.0.2' };
  const server = createServer((req, res) => {
    const upstream = request(`${target}${req.url}`, { method: req.method, headers: { ...req.headers, ...injected } }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    });
    req.pipe(upstream);
  });
  const upgraded = new Set<Duplex>();
  server.on('upgrade', (req, socket, head) => {
    upgraded.add(socket);
    socket.on('close', () => upgraded.delete(socket));
    const upstream = connect(Number(new URL(target).port), '127.0.0.1', () => {
      const lines = Object.entries({ ...req.headers, ...injected }).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((x) => `${k}: ${x}`));
      upstream.write([`${req.method} ${req.url} HTTP/1.1`, ...lines, '', ''].join('\r\n'));
      if (head.length) upstream.write(head);
      upstream.pipe(socket).pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
  });
  const drop = () => upgraded.forEach((socket) => socket.destroy());
  const served = await listen(server);
  cleanupLater(async () => drop());
  return Object.assign(served, { drop });
}

export async function pair(target: TestHos, caller: TestHos): Promise<{ serve: Served & { drop(): void }; token: string; name: string }> {
  const serve = await tailscaleServe(target.daemon.url, target.transportIdentity.headers());
  const { code } = await target.client.pairCode();
  const { name } = await caller.client.addComputer({ url: `${serve.url}/`, code });
  return { serve, name, token: readFileSync(join(caller.dataDir, 'computers', `${name}.token`), 'utf8').trim() };
}
