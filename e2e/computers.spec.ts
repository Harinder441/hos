import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page } from '@playwright/test';
import { WebSocketServer } from 'ws';
import type { Chat, ComputerCaps, ComputerTopic, HosEvent, ScheduleView } from '../src/api/types.js';
import { signIn } from './access.js';
import { api, topicHash } from './fixtures.js';
import { expect, test } from './test.js';

const SHOTS = process.env.HOS_SHOTS_DIR;
const NAME = 'stub-server';
const CODE = 'K7QM-4ZTX';
const CAPS: ComputerCaps = {
  name: NAME,
  apiVersion: 3,
  hosVersion: 'abc1234',
  scheduleHost: NAME,
  harnesses: [
    { id: 'scripted', label: 'Claude', models: { default: 'claude-opus-5-5', effort: 'high', list: [] }, loggedIn: true },
    { id: 'acp-agent', label: 'ACP agent', models: { default: 'auto', effort: 'high', list: [] }, loggedIn: false },
  ],
  browser: false,
  slots: { claude: { running: 1, max: 3 } },
  projects: [
    { key: 'hos', name: 'hos' },
    { key: 'web-backend', name: 'Web backend' },
  ],
  brainHead: null,
};

type Stub = Server & { name: string; url: string; posts: Array<{ url: string; body: Record<string, unknown> }>; loads: string[]; delay: number; hangUp(): void };

function remoteChat(topicId: string, id: string = randomUUID()): Chat {
  return {
    id,
    topicId,
    agent: 'scripted',
    state: 'idle',
    createdBy: 'human',
    createdAt: Date.now(),
    parentId: null,
    role: 'main',
    depth: 0,
    intent: null,
    ownedFiles: [],
    worktreePath: null,
    predecessorId: null,
    lineageId: id,
    generation: 1,
    priority: 2,
    model: 'claude-opus-5-5',
    effort: 'high',
    suspended: false,
    title: null,
    naming: false,
    tabClosed: false,
    chrome: false,
    notify: true,
    profile: 'generic',
  };
}

function stubComputer(name = NAME, topics: ComputerTopic[] = [], schedules: ScheduleView[] = []): Promise<Stub> {
  const posts: Stub['posts'] = [];
  const loads: string[] = [];
  const events = new WebSocketServer({ noServer: true });
  const log: HosEvent[] = [];
  let seq = 100;
  const stamp = (bodies: Array<Record<string, unknown>>) => bodies.map((body) => ({ ...body, seq: ++seq, ts: Date.now() }) as HosEvent);
  const push = (...bodies: Array<Record<string, unknown>>) => {
    const frame = stamp(bodies);
    log.push(...frame);
    for (const ws of events.clients) ws.send(JSON.stringify(frame.length === 1 ? frame[0] : frame));
  };
  for (const topic of topics) {
    const chatId = topic.chats[0]?.id;
    if (!chatId) continue;
    log.push(
      ...stamp([
        { type: 'chat.created', chat: remoteChat(topic.id, chatId) },
        { type: 'message.user', chatId, messageId: `u-${chatId}`, text: 'what ran last night?' },
        { type: 'chat.state', chatId, state: 'running' },
        { type: 'message.completed', chatId, messageId: `m-${chatId}`, text: 'Backfilled from the stub' },
      ]),
    );
  }
  const server = createServer((req, res) => {
    const json = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    const authed = req.headers.authorization === 'Bearer stub-token';
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (req.url === '/api/computer/hello') return json(200, { name, apiVersion: 3, hosVersion: 'abc1234', scheduleHost: name });
      if (req.url === '/api/computer/pair') {
        return JSON.parse(body).code === CODE ? json(201, { token: 'stub-token', name, caps: { ...CAPS, name } }) : json(401, { error: 'wrong or expired pairing code' });
      }
      if (!authed) return json(401, { error: 'unknown token' });
      if (req.url === '/api/computer/caps') return json(200, { ...CAPS, name });
      if (req.url === '/api/computer/topics') return json(200, topics);
      if (req.url === '/api/computer/schedules') return json(200, schedules);
      if (req.method === 'POST') posts.push({ url: req.url!, body: JSON.parse(body) });
      if (req.url === '/api/computer/sync') return json(201, schedules);
      const ran = schedules.find((r) => req.url === `/api/schedules/${r.id}/run`);
      if (ran) return json(201, { topicId: ran.topicId, chatId: ran.chatId });
      const opened = topics.find((t) => req.url === `/api/computer/topics/${t.id}/open`);
      if (opened) {
        const chats = opened.chats.map((c) => ({ ...remoteChat(opened.id, c.id), title: c.title, state: c.state, role: c.role }));
        return json(201, { topic: { id: opened.id, title: opened.title, statusTopic: 'stub-rituals', workDir: null }, chats });
      }
      const history = /^\/api\/computer\/chats\/([^/]+)\/events\?after=(\d+)/.exec(req.url!);
      if (history) {
        loads.push(history[1]!);
        const after = Number(history[2]);
        const ofChat = (e: HosEvent) => (e.type === 'chat.created' ? e.chat.id : 'chatId' in e ? e.chatId : null) === history[1];
        return void setTimeout(() => json(200, { events: log.filter((e) => ofChat(e) && e.seq > after), next: null }), me.delay);
      }
      if (req.url === '/api/computer/chats') return json(201, { chat: remoteChat(JSON.parse(body).topic.id), seq });
      const acted = /^\/api\/chats\/([^/]+)\/(messages|stop)$/.exec(req.url!);
      if (acted?.[2] === 'messages') {
        const chatId = acted[1]!;
        push({ type: 'message.user', chatId, messageId: `u-${chatId}`, text: JSON.parse(body).text });
        push({ type: 'chat.state', chatId, state: 'running' }, { type: 'message.completed', chatId, messageId: `m-${chatId}`, text: 'Relayed from the stub' });
        return json(201, { ok: true });
      }
      if (acted?.[2] === 'stop') {
        push({ type: 'chat.state', chatId: acted[1], state: 'paused' });
        return json(201, { ...remoteChat(''), id: acted[1], state: 'paused' });
      }
      json(404, { error: 'no route' });
    });
  });
  server.on('upgrade', (req, socket, head) => {
    if (req.headers.authorization !== 'Bearer stub-token' || !req.url?.startsWith('/api/events')) return void socket.destroy();
    events.handleUpgrade(req, socket, head, (ws) => events.emit('connection', ws, req));
  });
  const hangUp = () => events.clients.forEach((ws) => ws.terminate());
  const me = Object.assign(server, { name, url: '', posts, loads, delay: 0, hangUp });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(Object.assign(me, { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }))));
}

async function showStub(page: Page): Promise<string> {
  const view = await (await api()).computers();
  const models = { default: 'claude-opus-5-5', effort: 'high', list: [{ id: 'claude-opus-5-5', label: 'Opus 5.5' }] };
  await page.route('**/api/harnesses', (route) => route.fulfill({ json: [{ id: 'scripted', label: 'Claude', models }, { id: 'acp-agent', label: 'ACP agent', models }] }));
  const computer = { name: NAME, direction: 'out', url: 'http://stub', addedAt: 0, lastSeen: Date.now(), online: true, connected: true, error: null, hosVersion: 'abc1234', apiVersion: 3, needsUpdate: false, caps: CAPS, topics: [] };
  await page.route('**/api/computers', (route) => route.fulfill({ json: { ...view, computers: [computer] } }));
  return view.self.name;
}

test.describe.configure({ mode: 'serial' });

let stub: Stub | undefined;

test.afterEach(async () => {
  for (const s of [stub]) {
    await (await api()).removeComputer(s?.name ?? NAME).catch(() => {});
    s?.hangUp();
    s?.closeAllConnections();
    await new Promise((resolve) => (s ? s.close(resolve) : resolve(undefined)));
  }
  stub = undefined;
});

test('the composer’s computer chip lists the paired computer, greys the ACP agent and the browser toggle it lacks, and starts the chat there', async ({ page }) => {
  stub = await stubComputer();
  const self = await showStub(page);
  const topic = await (await api()).createTopic({ title: 'computer-composer' });
  await signIn(page);
  await page.goto(topicHash(topic.id));
  const pane = page.getByRole('main');
  const composer = pane.getByRole('form', { name: 'Composer' });
  const chip = composer.getByRole('button', { name: /^Computer: / });

  await expect(chip).toHaveAccessibleName(`Computer: ${self}`);
  await chip.click();
  const menu = composer.getByRole('menu', { name: 'Computer' });
  await expect(menu.getByRole('menuitemradio')).toHaveCount(2);
  await expect(menu.getByRole('menuitemradio', { name: new RegExp(NAME) })).toContainText('online · room for 2 of 3 chats · no Chrome');
  if (SHOTS) {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: `${SHOTS}/computers-composer-picker.jpg`, type: 'jpeg', quality: 85 });
  }
  await menu.getByRole('menuitemradio', { name: new RegExp(NAME) }).click();
  await expect(chip).toHaveAccessibleName(`Computer: ${NAME}`);
  await expect(composer.getByRole('button', { name: 'Browser' })).toBeDisabled();
  await expect(composer.getByRole('button', { name: 'Browser' })).toHaveAttribute('title', `${NAME} has no Chrome`);
  await composer.getByRole('button', { name: 'Agent: Claude' }).click();
  await expect(composer.getByRole('menuitemradio', { name: 'ACP agent' })).toBeDisabled();
  await page.keyboard.press('Escape');

  await (await api()).addComputer({ url: stub.url, code: CODE });
  await pane.getByLabel('Message').fill('run this on the stub');
  await pane.getByRole('button', { name: 'Send' }).click();
  await expect.poll(() => stub!.posts.map((p) => p.url.replace(/chats\/[^/]+\/messages/, 'chats/:id/messages'))).toEqual(['/api/computer/chats', '/api/chats/:id/messages']);
  expect(stub.posts[0]!.body).toMatchObject({ topic: { id: topic.id, title: 'computer-composer' }, brainSha: expect.stringMatching(/^[0-9a-f]{40}$/), workspaces: [] });
  expect(stub.posts[1]!.body).toEqual({ text: 'run this on the stub', attachments: [] });
  await expect(page.getByRole('tablist', { name: 'Chats in this topic' }).getByRole('tab', { selected: true })).toContainText(NAME);
});
