import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { hostname, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import type { Clock } from './adapters/clock.js';
import type { Computer, ComputerCaps, ComputerHello, ComputersView, ComputerTopic, HosEvent, OutboxItem, PairCode, ScheduleView, StatusItem } from './api/types.js';
import { HosError } from './core.js';
import type { ComputerRow, Store } from './store.js';

export const API_VERSION = 3;
export const LEGACY_PEER = 'legacy-peer';
const PEER_TOKEN = 'peer.token';
const MIGRATED_META = 'computers.migrated';
const SCHEDULES_META = 'computer.schedules.';
const POLL_MS = 30_000;
const TIMEOUT_MS = 10_000;
const CODE_MS = 10 * 60_000;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const NAME = /^[\w.-]+$/;

export interface PeerConfig {
  name: string;
  url: string;
}

export function parsePeers(flags: string[]): PeerConfig[] {
  return flags.map((flag) => {
    const at = flag.indexOf('=');
    const name = flag.slice(0, at);
    const url = flag.slice(at + 1).replace(/\/+$/, '');
    if (!NAME.test(name) || !/^https?:\/\/\S+$/.test(url)) {
      throw new Error(`--peer must look like my-server=https://my-server.example.ts.net, got ${flag}`);
    }
    return { name, url };
  });
}

export function computerName(configured?: string): string {
  return configured ?? (platform() === 'darwin' ? 'Mac' : hostname().split('.')[0]!);
}

let installVersion: string | undefined;

export function hosVersion(): string {
  installVersion ??= (() => {
    try {
      const cwd = dirname(fileURLToPath(import.meta.url));
      return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 }).trim() || 'unknown';
    } catch {
      return 'unknown';
    }
  })();
  return installVersion;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const codeHash = (code: string) => sha256(code.toUpperCase().replace(/[^A-Z0-9]/g, ''));
const versionGap = (name: string, theirs: number, here: string) =>
  `${name} runs hos API v${theirs} and ${here} runs v${API_VERSION}; update hos on ${theirs < API_VERSION ? name : here}`;

async function call<T>(label: string, url: string, options: { body?: unknown; token?: string; timeoutMs?: number } = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: options.body === undefined ? 'GET' : 'POST',
      headers: {
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
    });
  } catch (error) {
    const cause = (error as Error & { cause?: Error }).cause;
    throw new HosError(502, `can’t reach ${label}: ${cause?.message ?? (error as Error).message}`);
  }
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new HosError(response.status >= 500 ? 502 : response.status, `${label}: ${payload.error ?? `answered ${response.status}`}`);
  return payload;
}

interface Live {
  online: boolean;
  error: string | null;
  topics: ComputerTopic[];
}

export class Computers {
  private readonly live = new Map<string, Live>();
  private readonly sockets = new Map<string, { ws: WebSocket; ready: Promise<void> }>();
  private readonly queues = new Map<string, Promise<void>>();
  // Where each socket got to; a history load can move remote_seq past events still in flight on it.
  private readonly cursors = new Map<string, number>();
  private readonly mail = new Map<string, Set<() => void>>();
  apply: (computer: string, event: HosEvent) => void = () => {};
  receive: (computer: string, item: OutboxItem) => Promise<unknown> = async () => {};
  private readonly dir: string;
  private cancel = (): void => {};
  private stopped = false;
  private armed = false;

  constructor(
    private readonly store: Store,
    private readonly dataDir: string,
    private readonly clock: Clock,
    readonly self: ComputerHello,
    readonly caps: () => Promise<ComputerCaps>,
    private readonly pollMs = POLL_MS,
  ) {
    this.dir = join(dataDir, 'computers');
  }

  view(): ComputersView {
    const { name, short, apiVersion, hosVersion } = this.self;
    return { self: { name, short, apiVersion, hosVersion }, computers: this.store.listComputers().map((row) => this.computer(row)) };
  }

  inbound(token: string | undefined): string | null {
    const name = token ? this.store.computerByToken(sha256(token)) : undefined;
    if (!name) return null;
    this.store.computerSeen(name, 'in', this.clock.now());
    return name;
  }

  pairCode(): PairCode {
    const raw = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
    const now = this.clock.now();
    const expiresAt = now + CODE_MS;
    this.store.addPairCode(sha256(raw), expiresAt, now);
    return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expiresAt };
  }

  async pair(code: string, name: string, apiVersion: number): Promise<{ token: string; name: string; caps: ComputerCaps }> {
    const hash = codeHash(code);
    const now = this.clock.now();
    if (!this.store.pairCodeValid(hash, now)) throw new HosError(401, 'wrong or expired pairing code; make a new one under Settings → Computers → Allow a computer');
    if (apiVersion !== API_VERSION) throw new HosError(409, versionGap(name, apiVersion, this.self.name));
    if (!NAME.test(name)) throw new HosError(400, 'a computer name is letters, digits, dots, dashes and underscores');
    const token = randomBytes(32).toString('base64url');
    this.store.transaction(() => {
      this.store.usePairCode(hash, now);
      this.store.upsertComputer({ name, direction: 'in', token_hash: sha256(token), added_at: now, api_version: apiVersion });
    });
    return { token, name: this.self.name, caps: await this.caps() };
  }

  async add(address: string, code: string): Promise<Computer> {
    const url = address.trim().replace(/\/+$/, '');
    if (!/^https?:\/\/\S+$/.test(url)) throw new HosError(400, 'the address must look like https://my-server.example.ts.net');
    const hello = await call<ComputerHello>(url, `${url}/api/computer/hello`);
    if (typeof hello.name !== 'string' || !NAME.test(hello.name)) throw new HosError(502, `${url} doesn’t answer like hos`);
    if (hello.apiVersion !== API_VERSION) throw new HosError(409, versionGap(hello.name, hello.apiVersion, this.self.name));
    const paired = await call<{ token: string; caps: ComputerCaps }>(hello.name, `${url}/api/computer/pair`, {
      body: { code, name: this.self.name, apiVersion: API_VERSION },
    });
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.tokenFile(hello.name), `${paired.token}\n`, { mode: 0o600 });
    const now = this.clock.now();
    this.store.upsertComputer({
      name: hello.name,
      direction: 'out',
      url,
      added_at: now,
      last_seen: now,
      hos_version: hello.hosVersion,
      api_version: hello.apiVersion,
      caps: JSON.stringify(paired.caps),
    });
    await this.pollOne({ name: hello.name, url });
    if (!this.armed && !this.stopped) this.arm();
    return this.computer(this.store.listComputers().find((row) => row.name === hello.name && row.direction === 'out')!);
  }

  target(name: string): Computer {
    const row = this.store.listComputers().find((r) => r.name === name && r.direction === 'out');
    if (!row) throw new HosError(409, `${name} isn’t added on ${this.self.name}; add it under Settings → Computers`);
    const computer = this.computer(row);
    if (!computer.online) throw new HosError(409, `${name} is offline (${this.seen(computer)}); start the chat on ${this.self.name} or try again once it’s back`);
    if (computer.needsUpdate) throw new HosError(409, versionGap(name, computer.apiVersion!, this.self.name));
    return computer;
  }

  doctorItems(): StatusItem[] {
    return this.view()
      .computers.filter((c) => c.direction === 'out')
      .map((c) => {
        const item = { id: `computer:${c.name}`, label: `Computer ${c.name}` };
        if (!c.online) return { ...item, status: 'warn', detail: `offline (${this.seen(c)})`, fix: `check that hos runs on ${c.name} and that both computers are on the tailnet` };
        if (c.needsUpdate) {
          return { ...item, status: 'warn', detail: `update needed: hos ${c.hosVersion ?? 'unknown'} (API v${c.apiVersion}) there, ${this.self.hosVersion} (API v${API_VERSION}) here`, fix: versionGap(c.name, c.apiVersion!, this.self.name) };
        }
        return { ...item, status: 'ok', detail: `online · hos ${c.hosVersion ?? 'unknown'}` };
      });
  }

  private seen(computer: Computer): string {
    const seen = computer.lastSeen === null ? 'never seen' : `last seen ${Math.round((this.clock.now() - computer.lastSeen) / 60_000)} min ago`;
    return computer.error ? `${seen}: ${computer.error}` : seen;
  }

  async post<T>(name: string, path: string, body: unknown): Promise<T> {
    const { url } = this.target(name);
    return call<T>(name, `${url}${path}`, { body, token: await this.token(name) });
  }

  async get<T>(name: string, path: string, timeoutMs?: number): Promise<T> {
    const { url } = this.target(name);
    return call<T>(name, `${url}${path}`, { token: await this.token(name), timeoutMs });
  }

  async deliver(name: string, item: { chatId: string; text: string; fromChatId?: string }): Promise<void> {
    if (this.store.listComputers().some((row) => row.name === name && row.direction === 'out')) return void (await this.post(name, '/api/computer/deliver', item));
    this.store.addOutbox(name, item.chatId, item.fromChatId ?? null, item.text, this.clock.now());
    this.mail.get(name)?.forEach((flush) => flush());
  }

  watchOutbox(name: string, send: (item: OutboxItem) => void): () => void {
    let sent = 0;
    const flush = () =>
      this.store.outbox(name, sent).forEach((item) => {
        sent = item.seq;
        send(item);
      });
    const watchers = this.mail.get(name) ?? new Set();
    this.mail.set(name, watchers.add(flush));
    flush();
    return () => watchers.delete(flush);
  }

  ack(name: string, seq: number): void {
    this.store.ackOutbox(name, seq);
  }

  async listen(name: string): Promise<void> {
    const { url } = this.target(name);
    return this.connect(name, url!, await this.token(name));
  }

  enqueue(name: string, job: () => void | Promise<void>): Promise<void> {
    return this.run(name, job).catch((error: Error) => console.error(`relay from ${name} failed: ${error.message}`));
  }

  run<T>(name: string, job: () => T | Promise<T>): Promise<T> {
    const result = (this.queues.get(name) ?? Promise.resolve()).then(job);
    this.queues.set(
      name,
      result.then(
        () => {},
        () => {},
      ),
    );
    return result;
  }

  private connect(name: string, url: string, token: string): Promise<void> {
    const known = this.sockets.get(name);
    if (known) return known.ready;
    const since = this.cursors.get(name) ?? this.store.maxRemoteSeq(name);
    const ws = new WebSocket(`${url.replace(/^http/, 'ws')}/api/events?since=${since}`, { headers: { authorization: `Bearer ${token}` } });
    const ready = new Promise<void>((resolve) => ws.once('open', resolve).once('close', resolve));
    this.sockets.set(name, { ws, ready });
    ws.on('message', (data) => {
      const frame = JSON.parse(String(data)) as HosEvent | HosEvent[] | { outbox: OutboxItem };
      if ('outbox' in frame) {
        const { outbox } = frame;
        return void this.enqueue(name, async () => {
          await this.receive(name, outbox).finally(() => this.post(name, '/api/computer/outbox/ack', { seq: outbox.seq }));
        });
      }
      const events = [frame].flat();
      this.cursors.set(name, Math.max(this.cursors.get(name) ?? since, ...events.map((event) => event.seq)));
      void this.enqueue(name, () => events.forEach((event) => this.apply(name, event)));
    });
    ws.on('error', () => {});
    ws.on('close', () => this.sockets.get(name)?.ws === ws && this.sockets.delete(name));
    return ready;
  }

  private hangUp(name: string): void {
    this.sockets.get(name)?.ws.terminate();
    this.sockets.delete(name);
  }

  remove(name: string): void {
    if (!this.store.deleteComputer(name)) throw new HosError(404, `no computer named ${name}`);
    rmSync(this.tokenFile(name), { force: true });
    this.live.delete(name);
    this.cursors.delete(name);
    this.store.deleteMeta(SCHEDULES_META + name);
    this.hangUp(name);
  }

  cacheSchedules(name: string, schedules: ScheduleView[]): void {
    this.store.setMeta(SCHEDULES_META + name, JSON.stringify(schedules));
  }

  migrate(peers: PeerConfig[]): void {
    if (peers.length) console.warn('--peer is deprecated; use Settings → Computers');
    const shared = join(this.dataDir, PEER_TOKEN);
    if (existsSync(shared)) {
      rmSync(shared, { force: true });
      this.store.deleteComputer(LEGACY_PEER);
      console.warn(`removed the old shared ${shared}; pair computers under Settings → Computers`);
    }
    if (this.store.meta(MIGRATED_META)) return;
    const now = this.clock.now();
    for (const { name, url } of peers) {
      const legacy = join(this.dataDir, `peer-${name}.token`);
      if (existsSync(legacy)) {
        mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        writeFileSync(this.tokenFile(name), readFileSync(legacy), { mode: 0o600 });
      }
      this.store.upsertComputer({ name, direction: 'out', url, added_at: now });
    }
    this.store.setMeta(MIGRATED_META, String(now));
  }

  start(): void {
    this.tick();
  }

  private tick(): void {
    if (this.stopped) return;
    this.armed = this.store.listComputers().some((row) => row.direction === 'out');
    if (this.armed) void this.poll().finally(() => !this.stopped && this.arm());
  }

  private arm(): void {
    this.armed = true;
    this.cancel = this.clock.setTimeout(() => this.tick(), this.pollMs);
  }

  stop(): void {
    this.stopped = true;
    this.cancel();
    for (const name of [...this.sockets.keys()]) this.hangUp(name);
  }

  poll(): Promise<void> {
    const out = this.store.listComputers().filter((row) => row.direction === 'out');
    return Promise.all(out.map((row) => this.pollOne({ name: row.name, url: row.url! }))).then(() => {});
  }

  private async pollOne({ name, url }: { name: string; url: string }): Promise<void> {
    const live = this.live.get(name) ?? { online: false, error: null, topics: [] };
    this.live.set(name, live);
    try {
      const token = await this.token(name);
      const [caps, topics, schedules] = await Promise.all([
        call<ComputerCaps>(name, `${url}/api/computer/caps`, { token }),
        call<ComputerTopic[]>(name, `${url}/api/computer/topics`, { token }),
        call<ScheduleView[]>(name, `${url}/api/computer/schedules`, { token }),
      ]);
      this.cacheSchedules(name, schedules);
      this.store.computerSeen(name, 'out', this.clock.now(), { hos_version: caps.hosVersion, api_version: caps.apiVersion, caps: JSON.stringify(caps) });
      Object.assign(live, { online: true, error: null, topics });
      if (!this.stopped) void this.connect(name, url, token);
    } catch (error) {
      Object.assign(live, { online: false, error: (error as Error).message });
    }
  }

  private computer(row: ComputerRow): Computer {
    const live = row.direction === 'out' ? this.live.get(row.name) : undefined;
    return {
      name: row.name,
      direction: row.direction,
      url: row.url,
      addedAt: row.added_at,
      lastSeen: row.last_seen,
      online: live?.online ?? false,
      connected: row.direction === 'out' && this.sockets.get(row.name)?.ws.readyState === WebSocket.OPEN,
      error: live?.error ?? null,
      hosVersion: row.hos_version,
      apiVersion: row.api_version,
      needsUpdate: row.api_version !== null && row.api_version !== API_VERSION,
      caps: row.caps ? (JSON.parse(row.caps) as ComputerCaps) : null,
      topics: live?.topics ?? [],
      schedules: row.direction === 'out' ? (JSON.parse(this.store.meta(SCHEDULES_META + row.name) ?? '[]') as ScheduleView[]) : [],
    };
  }

  private async token(name: string): Promise<string> {
    return (await readFile(this.tokenFile(name), 'utf8')).trim();
  }

  private tokenFile(name: string): string {
    return join(this.dir, `${name}.token`);
  }
}
