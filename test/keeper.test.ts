import { once } from 'node:events';
import { copyFile, readdir } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { HosEvent, InboxItem } from '../src/api/types.js';
import { FakeClock } from '../src/fakes/fake-clock.js';
import { FakeMachine } from '../src/fakes/fake-machine.js';
import { ScriptedAgentRuntime, type AgentScript } from '../src/fakes/scripted-agent-runtime.js';
import { cleanupAll, cleanupLater, collect, startTestDaemon, tempDir, tempGitRepo } from './harness.js';
import { until } from './helpers.js';
import { newTopic } from './topics.js';

afterEach(cleanupAll);

const MINUTE = 60_000;

const slow: AgentScript = (input) => {
  const minutes = /work (\d+)/.exec(input)?.[1];
  return minutes ? [{ afterMs: Number(minutes) * MINUTE, delta: 'worked' }] : [{ delta: `ok: ${input}` }];
};

const keeperItems = (inbox: InboxItem[]) => inbox.filter((item) => item.kind === 'keeper');

test('after the Mac reboots hos resumes the chats that were mid-turn and announces it in the Inbox', async () => {
  const machine = new FakeMachine();
  const agentRuntime = new ScriptedAgentRuntime(new FakeClock(), slow);
  const first = await startTestDaemon({ agentRuntime, machine });
  const repo = await tempGitRepo();
  const project = await first.client.createProject(repo);
  const workspace = await newTopic(first.client, project.id, 'keeper');
  const busy = await first.client.createChat(workspace.id);
  const quiet = await first.client.createChat(workspace.id);
  await first.client.sendMessage(quiet.id, 'hello');
  await collect(first.client).until((es) => es.some((e) => e.type === 'message.completed' && e.chatId === quiet.id));
  await first.client.sendMessage(busy.id, 'work 30');
  await collect(first.client).until((es) => es.some((e) => e.type === 'chat.state' && e.chatId === busy.id && e.state === 'running'));
  await first.stop();

  machine.booted += 3 * 60 * MINUTE;
  const second = await startTestDaemon({ agentRuntime, machine, dataDir: first.dataDir });

  const [announcement] = await until(
    async () => keeperItems(await second.client.listInbox()),
    (items) => items.length > 0,
  );
  expect(announcement).toMatchObject({ title: 'Mac restarted', chatId: null, state: 'open' });
  expect(announcement!.detail).toContain('resumed 1 chat');
  const resumed = agentRuntime.started.filter((spec) => spec.chatId === busy.id);
  expect(resumed.map((spec) => spec.resume)).toEqual([undefined, resumed[0]!.nativeId]);
  expect(agentRuntime.started.filter((spec) => spec.chatId === quiet.id)).toHaveLength(1);
  const events: HosEvent[] = await collect(second.client).until((es) =>
    es.some((e) => e.type === 'message.user' && e.chatId === busy.id && e.text.includes('Mac restarted')),
  );
  expect(events.filter((e) => e.type === 'message.user' && e.chatId === busy.id).at(-1)).toMatchObject({ from: 'hos' });
});

const PHONE = { endpoint: 'https://push.test.invalid/phone', keys: { p256dh: 'p256dh-phone', auth: 'auth-phone' } };

const health = async (hos: Awaited<ReturnType<typeof startTestDaemon>>, id: string) => (await hos.client.health()).find((item) => item.id === id)!;

test('on battery hos checkpoints at 25%, pauses running chats cleanly at 10% and lets the Mac sleep, then resumes them on the charger, where the battery alerts end', async () => {
  const hos = await startTestDaemon({ script: slow });
  await hos.client.subscribePush(PHONE, 'phone');
  const project = await hos.client.createProject(await tempGitRepo());
  const workspace = await newTopic(hos.client, project.id, 'battery');
  const chat = await hos.client.createChat(workspace.id);
  const stream = collect(hos.client);
  await hos.client.sendMessage(chat.id, 'work 600');
  await stream.until((es) => es.some((e) => e.type === 'chat.state' && e.chatId === chat.id && e.state === 'running'));
  expect(hos.machine.awake).toBe(true);

  hos.machine.current = { memory: 'normal', thermalWarning: false, battery: { percent: 24, onBattery: true } };
  await hos.clock.advance(MINUTE);
  const [low] = await until(async () => keeperItems(await hos.client.listInbox()), (items) => items.length === 1);
  expect(low).toMatchObject({ title: 'Battery low', chatId: null });
  expect(low!.detail).toContain('24%');
  expect((await health(hos, 'backups')).detail).toContain('(battery)');
  expect((await health(hos, 'battery')).status).toBe('warn');
  expect(hos.machine.awake).toBe(true);

  hos.machine.current = { memory: 'normal', thermalWarning: false, battery: { percent: 9, onBattery: true } };
  await hos.clock.advance(MINUTE);
  const critical = await until(async () => keeperItems(await hos.client.listInbox()), (items) => items.length === 2);
  expect(critical[0]).toMatchObject({ title: 'Battery critical' });
  expect(critical[0]!.detail).toContain('paused 1 running chat');
  await stream.until((es) => es.some((e) => e.type === 'chat.state' && e.chatId === chat.id && e.state === 'paused'));
  expect(hos.machine.awake).toBe(false);
  expect(await health(hos, 'awake')).toMatchObject({ status: 'warn' });
  expect(hos.notifier.sent.map((s) => s.notification)).toEqual([expect.objectContaining({ title: 'hos keeper', body: 'Battery critical' })]);

  hos.machine.current = { memory: 'normal', thermalWarning: false, battery: { percent: 11, onBattery: false } };
  await hos.clock.advance(MINUTE);
  const back = await until(async () => keeperItems(await hos.client.listInbox()), (items) => items.some((item) => item.title === 'Power back'));
  expect(back.map((item) => item.title)).toEqual(['Power back']);
  expect(back[0]!.detail).toContain('resumed 1 chat');
  expect(hos.machine.awake).toBe(true);
  await stream.until((es) => es.some((e) => e.type === 'message.user' && e.chatId === chat.id && e.text.includes('back on the charger')));
  const sessions = hos.agentRuntime.started.filter((spec) => spec.chatId === chat.id);
  expect(sessions.map((spec) => spec.resume)).toEqual([undefined, sessions[0]!.nativeId]);
});

async function healthchecks() {
  const pings: string[] = [];
  const server = createHttpServer((req, res) => {
    pings.push(req.url ?? '');
    res.end('OK');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanupLater(async () => void server.close());
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/ping/hos-check`, pings };
}

test('the daemon pings the outside watchdog every minute while it runs, and the pings stop when it stops', async () => {
  const watchdog = await healthchecks();
  const hos = await startTestDaemon({ healthchecksUrl: watchdog.url });
  await until(async () => watchdog.pings.length, (n) => n === 1);
  for (let minute = 0; minute < 5; minute++) await hos.clock.advance(MINUTE);
  await until(async () => watchdog.pings.length, (n) => n === 6);
  expect(new Set(watchdog.pings)).toEqual(new Set(['/ping/hos-check']));
  expect(await health(hos, 'watchdog')).toMatchObject({ status: 'ok', detail: expect.stringContaining('answered') });

  await hos.stop();
  await hos.clock.advance(5 * MINUTE);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(watchdog.pings).toHaveLength(6);
});

test('the health page covers the daemon, tmux, transport, disk, battery, thermal, memory, provider windows, sleep, watchdog and backups', async () => {
  const hos = await startTestDaemon();
  hos.machine.current = { memory: 'warn', thermalWarning: true, battery: { percent: 64, onBattery: true } };
  hos.agentRuntime.windows = { fiveHour: { pct: 72, resetsAt: null }, weekly: { pct: 30, resetsAt: null } };
  await hos.clock.advance(5 * MINUTE);

  const items = await hos.client.health();

  expect(items.map((item) => item.id)).toEqual([
    'daemon', 'tmux', 'transport', 'disk', 'battery', 'thermal', 'memory', 'windows', 'awake', 'watchdog', 'backups',
  ]);
  const byId = Object.fromEntries(items.map((item) => [item.id, item]));
  expect(byId.daemon).toMatchObject({ status: 'ok', detail: expect.stringContaining('first start') });
  expect(byId.tmux).toMatchObject({ status: 'ok' });
  expect(byId.transport).toMatchObject({ label: 'Remote access (tailscale)', status: 'ok' });
  expect(byId.disk!.detail).toMatch(/GB free of/);
  expect(byId.battery).toMatchObject({ status: 'ok', detail: '64% on battery' });
  expect(byId.thermal).toMatchObject({ status: 'warn', detail: 'thermal warning' });
  expect(byId.memory).toMatchObject({ status: 'warn', detail: 'pressure warn' });
  expect(byId.windows).toMatchObject({ status: 'warn', detail: 'Claude 5-hour 72% · weekly 30%' });
  expect(byId.awake).toMatchObject({ status: 'ok' });
  expect(byId.watchdog).toMatchObject({ status: 'off' });
  expect(byId.backups).toMatchObject({ status: 'warn', detail: 'no backup yet' });
});

test('the doctor checks the machine setup and says how to fix each problem', async () => {
  const hos = await startTestDaemon();
  const ok = await hos.client.doctorChecks();
  expect(ok.map((check) => [check.id, check.status])).toEqual([
    ['transport', 'ok'],
    ['keeper', 'ok'],
    ['watchdog', 'down'],
    ['charge_limit', 'ok'],
    ['claude', 'ok'],
    ['commit_identity', expect.any(String)],
  ]);
  expect(ok.find((check) => check.id === 'claude')!.detail).toBe('logged in (team plan)');

  hos.machine.facts = {
    chargeLimit: 'unset',
    claude: { loggedIn: false, plan: null },
    launchAgent: false,
    browser: false,
  };
  hos.transportIdentity.state = { ...hos.transportIdentity.state, backendState: 'Stopped' };
  const broken = Object.fromEntries((await hos.client.doctorChecks()).map((check) => [check.id, check]));

  expect(broken.transport).toMatchObject({ status: 'down', fix: expect.stringContaining('tailscale') });
  expect(broken.keeper).toMatchObject({ status: 'down', fix: 'hos keeper install' });
  expect(broken.watchdog!.fix).toContain('healthchecks.io');
  expect(broken.charge_limit).toMatchObject({ status: 'down', fix: expect.stringContaining('Charge Limit 80%') });
  expect(broken.claude).toMatchObject({ status: 'down', fix: 'claude auth login' });
});

class SystemdMachine extends FakeMachine {
  readonly keeper = 'systemd' as const;
}

test('on Linux the doctor checks the systemd keeper and leaves out the Mac-only charge limit row', async () => {
  const hos = await startTestDaemon({ machine: new SystemdMachine() });
  const ok = await hos.client.doctorChecks();
  expect(ok.map((check) => [check.id, check.status])).toEqual([
    ['transport', 'ok'],
    ['keeper', 'ok'],
    ['watchdog', 'down'],
    ['claude', 'ok'],
    ['commit_identity', expect.any(String)],
  ]);
  expect(ok.find((check) => check.id === 'keeper')!.label).toBe('Background service (systemd)');

  hos.machine.facts = { ...hos.machine.facts, launchAgent: false };
  const keeper = (await hos.client.doctorChecks()).find((check) => check.id === 'keeper');
  expect(keeper).toMatchObject({ status: 'down', detail: expect.stringContaining('hos.service is not active'), fix: 'hos keeper install' });
  expect((await hos.client.health()).find((check) => check.id === 'awake')!.detail).toContain('systemd-inhibit');
});

test('the store is backed up every day, and a backup opens as a working hos with every chat', async () => {
  const hos = await startTestDaemon({ refreshMs: 60 * MINUTE, script: slow });
  const project = await hos.client.createProject(await tempGitRepo());
  const workspace = await newTopic(hos.client, project.id, 'backed-up');
  const chat = await hos.client.createChat(workspace.id);
  await hos.client.sendMessage(chat.id, 'hello');
  await collect(hos.client).until((es) => es.some((e) => e.type === 'message.completed' && e.chatId === chat.id));
  expect(await health(hos, 'backups')).toMatchObject({ status: 'warn' });

  await hos.clock.jump(24 * 60 * MINUTE);
  await until(() => health(hos, 'backups'), (item) => item.status === 'ok');
  expect((await health(hos, 'backups')).detail).toContain('(daily), 1 kept');
  const [backup] = await readdir(join(hos.dataDir, 'backups'));

  const restored = await tempDir('hos-restored-');
  await copyFile(join(hos.dataDir, 'backups', backup!), join(restored, 'hos.db'));
  const second = await startTestDaemon({ dataDir: restored, passkeyOf: hos.dataDir });
  const events = await collect(second.client).until((es) => es.some((e) => e.type === 'chat.created'));
  expect(events.filter((e) => e.type === 'chat.created').map((e) => e.type === 'chat.created' && e.chat.id)).toEqual([chat.id]);
  expect(events.some((e) => e.type === 'message.completed' && e.chatId === chat.id && e.text.includes('hello'))).toBe(true);
});

const OLD_CHAT = '24aa4e2a-8b8e-4faa-8192-ccd53aa30750';
const OLD_SESSION = 'scripted-1cf12ea5-c5e1-4e18-bcdb-cc6abeff0cc4';

test('upgrading over a store written by the previous release keeps every chat, takes a backup first and resumes the old session', async () => {
  const dataDir = await tempDir('hos-upgrade-');
  await copyFile(new URL('./fixtures/store-before-keeper.db', import.meta.url), join(dataDir, 'hos.db'));
  const hos = await startTestDaemon({ dataDir, script: slow });

  const before = await collect(hos.client).until((es) => es.some((e) => e.type === 'chat.created'));
  expect(before.filter((e) => e.type === 'chat.created').map((e) => e.type === 'chat.created' && e.chat.id)).toEqual([OLD_CHAT]);
  expect(before.some((e) => e.type === 'message.user' && e.text === 'remember the blue door')).toBe(true);
  expect((await hos.client.listInbox()).map((item) => [item.kind, item.chatId])).toEqual([['completion', OLD_CHAT]]);
  expect((await health(hos, 'backups')).detail).toContain('(upgrade), 1 kept');

  const stream = collect(hos.client);
  await hos.client.sendMessage(OLD_CHAT, 'still there?');
  await stream.until((es) => es.some((e) => e.type === 'message.completed' && e.chatId === OLD_CHAT && e.text.includes('still there?')));
  expect(hos.agentRuntime.started.map((spec) => spec.resume)).toEqual([OLD_SESSION]);

  await hos.stop();
  const again = await startTestDaemon({ dataDir });
  expect((await health(again, 'backups')).detail).toContain('1 kept');
});
