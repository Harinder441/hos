import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { ScheduleView, StatusItem } from '../src/api/types.js';
import { API_VERSION } from '../src/computers.js';
import { callBus } from '../src/fakes/bus-client.js';
import type { AgentScript } from '../src/fakes/scripted-agent-runtime.js';
import { listen, pair, tailscaleServe } from './computers-net.js';
import { cleanupAll, git, startTestDaemon, tempDir, tempGitRepo } from './harness.js';

afterEach(cleanupAll);

const SERVER = 'home-server';
const LAPTOP = 'laptop';
const script: AgentScript = (input) => [{ delta: `Ran: ${input.split('\n').at(-1)}` }];

const row = (id: string, host: string) => `- id: ${id}\n  host: ${host}\n  cron: "0 9 * * *"\n  prompt: ${id} please\n`;

async function world() {
  const root = await tempDir('hos-computers-schedules-');
  const macBrain = await tempGitRepo('main', root, 'brain');
  await mkdir(join(macBrain, 'hos'), { recursive: true });
  await writeFile(join(macBrain, 'hos', 'schedules.yaml'), row('mac-sweep', 'mac-host') + row('server-digest', 'server-host') + row('laptop-notes', 'laptop-host'));
  git(macBrain, 'add', '-A');
  git(macBrain, 'commit', '-qm', 'schedules');
  const origin = join(root, 'brain.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(macBrain, 'remote', 'add', 'origin', origin);
  git(macBrain, 'push', '-q', 'origin', 'main');
  git(root, 'clone', '-q', origin, 'server-brain');
  git(root, 'clone', '-q', origin, 'laptop-brain');
  const target = (name: string, host: string) => {
    const brainDir = join(root, `${name === SERVER ? 'server' : 'laptop'}-brain`);
    return startTestDaemon({ script, brainDir, discovery: { brain: brainDir }, computerName: name, scheduleHost: host });
  };
  const server = await target(SERVER, 'server-host');
  const laptop = await target(LAPTOP, 'laptop-host');
  const mac = await startTestDaemon({ script, brainDir: macBrain, discovery: { brain: macBrain }, computerName: 'Mac', scheduleHost: 'mac-host' });
  return { mac, server, laptop };
}

async function olderHos(target: string) {
  const proxy = { older: false };
  const server = await listen(
    createServer((req, res) => {
      const upstream = request(`${target}${req.url}`, { method: req.method, headers: req.headers }, async (answer) => {
        if (!proxy.older || req.url !== '/api/computer/caps') return void (res.writeHead(answer.statusCode ?? 502, answer.headers), answer.pipe(res));
        const chunks: Buffer[] = [];
        for await (const chunk of answer) chunks.push(chunk as Buffer);
        const caps = { ...JSON.parse(Buffer.concat(chunks).toString()), apiVersion: API_VERSION - 1, hosVersion: 'old1234' };
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(caps));
      });
      req.pipe(upstream);
    }),
  );
  return Object.assign(proxy, { url: server.url });
}

const computerChecks = (checks: StatusItem[]) => checks.filter((c) => c.id.startsWith('computer:'));

const byId = (rows: ScheduleView[], id: string) => rows.find((r) => r.id === id)!;

async function ranThere(hos: Awaited<ReturnType<typeof startTestDaemon>>, id: string) {
  const run = await hos.client.runSchedule(id);
  await expect.poll(async () => byId((await hos.client.schedules()).schedules, id).result, { timeout: 10_000 }).toBe('done');
  return run;
}

test('the list merges each computer’s results into its rows by id; an offline computer keeps its cached results and last seen', async () => {
  const { mac, server, laptop } = await world();
  const serverRun = await ranThere(server, 'server-digest');
  const laptopRun = await ranThere(laptop, 'laptop-notes');
  await pair(server, mac);
  const { serve: laptopServe } = await pair(laptop, mac);

  const merged = (await mac.client.schedules()).schedules;
  expect(byId(merged, 'mac-sweep')).toMatchObject({ local: true, lastRun: null });
  expect(byId(merged, 'mac-sweep').computer).toBeUndefined();
  expect(byId(merged, 'server-digest')).toMatchObject({ local: false, computer: SERVER, applied: true, result: 'done', summary: expect.stringContaining('Ran:'), ...serverRun });
  expect(byId(merged, 'laptop-notes')).toMatchObject({ computer: LAPTOP, applied: true, result: 'done', ...laptopRun });

  laptopServe.drop();
  laptopServe.closeAllConnections();
  await new Promise((resolve) => laptopServe.close(resolve));
  const view = await mac.client.computers(true);
  const away = view.computers.find((c) => c.name === LAPTOP)!;
  expect(away).toMatchObject({ online: false, lastSeen: expect.any(Number) });
  expect(away.schedules.map((s) => s.id)).toEqual(['laptop-notes']);
  expect(view.computers.find((c) => c.name === SERVER)!.online).toBe(true);
  const cached = (await mac.client.schedules()).schedules;
  expect(byId(cached, 'laptop-notes')).toMatchObject({ computer: LAPTOP, applied: true, result: 'done', ...laptopRun });
  await expect(mac.client.runSchedule('laptop-notes')).rejects.toMatchObject({ status: 409, message: expect.stringContaining(`${LAPTOP} is offline`) });
}, 60_000);

test('Run now on a remote row runs it there and answers with that computer’s chat; a host no computer owns still refuses', async () => {
  const { mac, server } = await world();
  await pair(server, mac);
  await mac.client.saveSchedule({ id: 'nowhere', host: 'unknown-host', cron: '0 9 * * *', prompt: 'nope' });

  const run = await mac.client.runSchedule('server-digest');
  expect(run).toMatchObject({ computer: SERVER, topicId: expect.any(String), chatId: expect.any(String) });
  const { state } = await server.client.snapshot();
  expect(state.chats[run.chatId]).toMatchObject({ topicId: run.topicId });
  expect(state.chats[run.chatId]!.computer).toBeUndefined();
  await expect.poll(async () => byId((await server.client.schedules()).schedules, 'server-digest').result, { timeout: 10_000 }).toBe('done');
  await mac.client.computers(true);
  expect(byId((await mac.client.schedules()).schedules, 'server-digest')).toMatchObject({ result: 'done', chatId: run.chatId, topicId: run.topicId });
  await mac.client.openComputerTopic(SERVER, run.topicId);
  expect((await mac.client.snapshot()).state.chats[run.chatId]).toMatchObject({ computer: SERVER });

  await expect(mac.client.runSchedule('nowhere')).rejects.toMatchObject({ status: 409, message: expect.stringContaining('runs on unknown-host') });
}, 60_000);

test('add, edit, pause and delete write the brain here, then the row’s computer pulls it and the row reads applied', async () => {
  const { mac, server } = await world();
  await pair(server, mac);

  const added = await mac.client.saveSchedule({ id: 'server-new', host: 'server-host', cron: '30 7 * * *', prompt: 'new there' });
  expect(added.applyError).toBeUndefined();
  expect(byId(added.schedules, 'server-new')).toMatchObject({ computer: SERVER, applied: true });
  expect(byId((await server.client.schedules()).schedules, 'server-new')).toMatchObject({ local: true, cron: '30 7 * * *' });

  const edited = await mac.client.saveSchedule({ id: 'server-digest', host: 'server-host', cron: '15 6 * * *', prompt: 'server-digest please' }, 'server-digest');
  expect(byId(edited.schedules, 'server-digest')).toMatchObject({ cron: '15 6 * * *', applied: true });
  expect(byId((await server.client.schedules()).schedules, 'server-digest')).toMatchObject({ cron: '15 6 * * *' });

  const paused = await mac.client.pauseSchedule('server-digest', true);
  expect(byId(paused.schedules, 'server-digest')).toMatchObject({ paused: true, applied: true });
  expect(byId((await server.client.schedules()).schedules, 'server-digest')).toMatchObject({ paused: true });

  const moved = await mac.client.saveSchedule({ id: 'server-new', host: 'mac-host', cron: '30 7 * * *', prompt: 'new there' }, 'server-new');
  expect(byId(moved.schedules, 'server-new')).toMatchObject({ local: true });
  expect((await server.client.schedules()).schedules.find((s) => s.id === 'server-new')).toMatchObject({ local: false });
  expect((await mac.client.computers()).computers.find((c) => c.name === SERVER)!.schedules.map((s) => s.id)).toEqual(['server-digest']);

  const removed = await mac.client.deleteSchedule('server-digest');
  expect(removed.schedules.map((s) => s.id)).not.toContain('server-digest');
  expect((await server.client.schedules()).schedules.map((s) => s.id)).not.toContain('server-digest');
}, 60_000);

test('an edit whose computer can’t be reached is kept here and says so', async () => {
  const { mac, server } = await world();
  const { serve } = await pair(server, mac);
  serve.drop();
  serve.closeAllConnections();
  await new Promise((resolve) => serve.close(resolve));
  await mac.client.computers(true);

  const saved = await mac.client.saveSchedule({ id: 'server-digest', host: 'server-host', cron: '45 9 * * *', prompt: 'server-digest please' }, 'server-digest');
  expect(saved.applyError).toMatch(new RegExp(`^not applied on ${SERVER}: ${SERVER} is offline`));
  expect(byId(saved.schedules, 'server-digest')).toMatchObject({ cron: '45 9 * * *', applied: false });
  expect(byId((await server.client.schedules()).schedules, 'server-digest').cron).toBe('0 9 * * *');
}, 60_000);

test('a computer token reads that computer’s own schedules and may run one, but can’t add, edit, pause or delete', async () => {
  const { mac, server } = await world();
  const { serve, token } = await pair(server, mac);
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const post = (path: string, body: unknown) => fetch(`${serve.url}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });

  const own = (await (await fetch(`${serve.url}/api/computer/schedules`, { headers })).json()) as ScheduleView[];
  expect(own.map((s) => s.id)).toEqual(['server-digest']);
  expect((await post('/api/schedules', { id: 'sneaky', host: 'server-host', cron: '0 9 * * *', prompt: 'x' })).status).toBe(403);
  expect((await post('/api/schedules/server-digest', { id: 'server-digest', host: 'server-host', cron: '1 9 * * *', prompt: 'x' })).status).toBe(403);
  expect((await post('/api/schedules/server-digest/pause', { paused: true })).status).toBe(403);
  expect((await post('/api/schedules/server-digest/delete', {})).status).toBe(403);
  expect((await fetch(`${serve.url}/api/schedules`, { headers })).status).toBe(403);
  expect((await post('/api/schedules/mac-sweep/run', {})).status).toBe(409);
  expect((await post('/api/schedules/server-digest/run', {})).status).toBe(201);
  await expect(server.client.request('GET', '/api/computer/schedules')).rejects.toMatchObject({ status: 403 });
  expect((await server.client.schedules()).schedules.map((s) => s.id)).toEqual(['mac-sweep', 'server-digest', 'laptop-notes']);
}, 60_000);

test('a computer on an older hos API reads update needed, refuses starts, spawns and runs with "update hos on <name>", and the doctor lists each computer', async () => {
  const { mac, server, laptop } = await world();
  const proxy = await olderHos((await tailscaleServe(server.daemon.url, server.transportIdentity.headers())).url);
  await mac.client.addComputer({ url: proxy.url, code: (await server.client.pairCode()).code });
  const { serve: laptopServe } = await pair(laptop, mac);
  expect(computerChecks(await mac.client.doctorChecks())).toEqual([
    { id: `computer:${SERVER}`, label: `Computer ${SERVER}`, status: 'ok', detail: expect.stringMatching(/^online · hos /) },
    { id: `computer:${LAPTOP}`, label: `Computer ${LAPTOP}`, status: 'ok', detail: expect.stringMatching(/^online · hos /) },
  ]);

  proxy.older = true;
  const view = await mac.client.computers(true);
  expect(view.computers.find((c) => c.name === SERVER)).toMatchObject({ online: true, apiVersion: API_VERSION - 1, hosVersion: 'old1234', needsUpdate: true });
  expect(view.computers.find((c) => c.name === LAPTOP)!.needsUpdate).toBe(false);
  const gap = `${SERVER} runs hos API v${API_VERSION - 1} and Mac runs v${API_VERSION}; update hos on ${SERVER}`;
  const topic = await mac.client.createTopic({ title: 'Skew' });
  await expect(mac.client.addTopicChat(topic.id, { computer: SERVER })).rejects.toMatchObject({ status: 409, message: gap });
  await expect(mac.client.startTopic({ text: 'hi there', computer: SERVER })).rejects.toMatchObject({ status: 409, message: gap });
  await expect(mac.client.runSchedule('server-digest')).rejects.toMatchObject({ status: 409, message: gap });
  const parent = await mac.client.addTopicChat(topic.id);
  const bus = mac.agentRuntime.started.filter((s) => s.chatId === parent.id).at(-1)!.bus;
  const spawned = await callBus(bus, 'spawn', { role: 'scout', intent: 'scout skew', prompt: 'look', client_request_id: 'skew', computer: SERVER });
  expect(spawned).toMatchObject({ isError: true, output: expect.stringContaining(gap) });
  expect(Object.values((await server.client.snapshot()).state.chats)).toEqual([]);

  laptopServe.drop();
  laptopServe.closeAllConnections();
  await new Promise((resolve) => laptopServe.close(resolve));
  await mac.client.computers(true);
  expect(computerChecks(await mac.client.doctorChecks())).toEqual([
    {
      id: `computer:${SERVER}`,
      label: `Computer ${SERVER}`,
      status: 'warn',
      detail: `update needed: hos old1234 (API v${API_VERSION - 1}) there, ${view.self.hosVersion} (API v${API_VERSION}) here`,
      fix: gap,
    },
    { id: `computer:${LAPTOP}`, label: `Computer ${LAPTOP}`, status: 'warn', detail: expect.stringMatching(new RegExp(`^offline \\(last seen 0 min ago: can’t reach ${LAPTOP}`)), fix: expect.any(String) },
  ]);
}, 60_000);
