import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { HosEvent } from '../src/api/types.js';
import { callBus } from '../src/fakes/bus-client.js';
import type { AgentScript } from '../src/fakes/scripted-agent-runtime.js';
import { pair } from './computers-net.js';
import { cleanupAll, collect, git, startTestDaemon, tempDir, tempGitRepo } from './harness.js';

afterEach(cleanupAll);

const SERVER = 'home-server';
type Turn = { input: string; context: string };
const macTurns: Turn[] = [];
const serverTurns: Turn[] = [];

const recorder =
  (turns: Turn[]): AgentScript =>
  (input, _history, turn) => {
    turns.push({ input, context: turn.context ?? '' });
    if (input.includes('finish later')) return [{ afterMs: 1_000, bus: 'complete', args: { summary: 'late result' } }, { delta: 'done' }];
    return [{ delta: 'ok' }];
  };

async function until<T>(find: () => T | undefined | false, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = find();
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`timed out; mac saw ${JSON.stringify(macTurns.map((t) => t.input))}, server saw ${JSON.stringify(serverTurns.map((t) => t.input))}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));

async function world() {
  macTurns.length = 0;
  serverTurns.length = 0;
  const root = await tempDir('hos-computers-bus-');
  const macBrain = await tempGitRepo('main', root, 'brain');
  const origin = join(root, 'brain.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(macBrain, 'remote', 'add', 'origin', origin);
  git(macBrain, 'push', '-q', 'origin', 'main');
  git(root, 'clone', '-q', origin, 'server-brain');
  const serverBrain = join(root, 'server-brain');
  const server = await startTestDaemon({ script: recorder(serverTurns), brainDir: serverBrain, discovery: { brain: serverBrain }, computerName: SERVER });
  const mac = await startTestDaemon({ script: recorder(macTurns), brainDir: macBrain, discovery: { brain: macBrain }, computerName: 'Mac' });
  const { serve } = await pair(server, mac);
  const topic = await mac.client.createTopic({ title: 'Across' });
  const parent = await mac.client.addTopicChat(topic.id);
  const sibling = await mac.client.addTopicChat(topic.id);
  const busOf = (hos: typeof mac, chatId: string) => hos.agentRuntime.started.filter((s) => s.chatId === chatId).at(-1)!.bus;
  const onMac = (tool: string, args: Record<string, unknown> = {}) => callBus(busOf(mac, parent.id), tool, args);
  const onServer = (chatId: string, tool: string, args: Record<string, unknown> = {}) => callBus(busOf(server, chatId), tool, args);
  let requests = 0;
  const spawn = async (prompt: string, extra: Record<string, unknown> = {}) => {
    const reply = await onMac('spawn', { role: 'scout', intent: `scout ${++requests}`, prompt, client_request_id: `r${requests}`, computer: SERVER, ...extra });
    return { reply, childId: /^Spawned chat ([0-9a-f-]{36})/.exec(reply.output)?.[1] };
  };
  const reconnect = async () => {
    await settle(100);
    await mac.clock.advance(30_000);
  };
  return { mac, server, serve, topic, parent, sibling, onMac, onServer, spawn, reconnect, here: collect(mac.client), there: collect(server.client) };
}

test('a parent here spawns a chat on the server: it runs there, its briefing lists the roster, and both sides show where each chat runs', async () => {
  const { mac, server, parent, sibling, onMac, onServer, spawn } = await world();

  const { reply, childId } = await spawn('scout the gift tiers');

  expect(reply).toMatchObject({ isError: false, output: expect.stringMatching(/^Spawned chat [0-9a-f-]{36} \(scout, depth 1\): .*Use wait/) });
  const { input, context } = await until(() => serverTurns.find((t) => t.input.includes('scout the gift tiers')));
  expect(input).toContain(`[from chat ${parent.id.slice(0, 8)} · role=main · not the user]`);
  expect(context).toContain(`Computer: ${SERVER} (started from Mac)`);
  expect(context).toMatch(new RegExp(`^- ${parent.id.slice(0, 8)} \\S+ main idle · on Mac · no card$`, 'm'));
  expect(context).toMatch(new RegExp(`^- ${sibling.id.slice(0, 8)} \\S+ main idle · on Mac · no card$`, 'm'));
  expect((await server.client.snapshot()).state.chats[childId!]).toMatchObject({ parentId: parent.id, role: 'scout' });
  expect((await mac.client.snapshot()).state.chats[childId!]).toMatchObject({ computer: SERVER, parentId: parent.id });

  expect((await onMac('roster')).output).toMatch(new RegExp(`${childId!.slice(0, 8)} .* · on ${SERVER} ·`));
  expect((await onMac('whoami')).output).toContain('you run on Mac in');
  expect((await onServer(childId!, 'whoami')).output).toContain(`you run on ${SERVER} in`);
  expect((await onMac('computers')).output).toMatch(new RegExp(`^- ${SERVER} · online · free slots: claude \\d+.* · Chrome$`, 'm'));
  for (const tool of ['tail', 'card', 'chat_history', 'wait']) {
    expect(await onServer(childId!, tool, { chat: parent.id })).toMatchObject({ isError: true, output: expect.stringContaining(`runs on Mac, and ${SERVER} can’t read its`) });
  }
}, 30_000);

test('the server chat’s result reaches the parent here as a notice after a dropped socket reconnects, and wait sees it', async () => {
  const { mac, server, serve, onMac, spawn, here, there } = await world();

  const { childId } = await spawn('finish later');
  serve.drop();
  await until(() => serverTurns.some((t) => t.input.includes('finish later')));
  await server.clock.advance(1_000);
  await there.until((es: HosEvent[]) => es.some((e) => e.type === 'chat.state' && e.chatId === childId && e.state === 'done'));
  expect((await mac.client.snapshot()).state.chats[childId!]!.state).not.toBe('done');

  await mac.clock.advance(30_000);
  await here.until((es: HosEvent[]) => es.some((e) => e.type === 'chat.state' && e.chatId === childId && e.state === 'done'));
  await mac.clock.advance(60_000);
  const notice = await until(() => macTurns.find((t) => t.input.includes(`chat ${childId!.slice(0, 8)} (scout) is done: late result`)));
  expect(notice.input).not.toContain('[from computer');

  expect((await onMac('wait', { chat: childId })).output).toMatch(/is done\.\nResult: late result/);
  expect(macTurns.filter((t) => t.input.includes('late result'))).toHaveLength(1);
}, 30_000);

test('a send from here reaches the server chat labelled as from this computer, and its send back goes through the outbox and lands once', async () => {
  const { serve, parent, onMac, onServer, spawn, reconnect } = await world();
  const { childId } = await spawn('wait for orders');
  await until(() => serverTurns.some((t) => t.input.includes('wait for orders')));

  await onMac('send', { to: childId, text: 'orders: look at tiers' });
  const order = await until(() => serverTurns.find((t) => t.input.includes('orders: look at tiers')));
  expect(order.input).toMatch(new RegExp(`^\\[from computer Mac · chat ${parent.id.slice(0, 8)} · not the user\\]\\n\\[from chat ${parent.id.slice(0, 8)} · role=main`));

  serve.drop();
  await settle(100);
  expect(await onServer(childId!, 'send', { to: parent.id, text: 'question while you were away' })).toMatchObject({ isError: false, output: expect.stringMatching(/^Sent to chat/) });
  await settle();
  expect(macTurns.some((t) => t.input.includes('question while you were away'))).toBe(false);

  await reconnect();
  const asked = await until(() => macTurns.find((t) => t.input.includes('question while you were away')));
  expect(asked.input).toMatch(new RegExp(`^\\[from computer ${SERVER} · chat ${childId!.slice(0, 8)} · not the user\\]\\n\\[from chat ${childId!.slice(0, 8)} · role=scout`));

  serve.drop();
  await reconnect();
  await onServer(childId!, 'send', { to: parent.id, text: 'second question' });
  await until(() => macTurns.some((t) => t.input.includes('second question')));
  expect(macTurns.filter((t) => t.input.includes('question while you were away'))).toHaveLength(1);
}, 30_000);

test('a server chat can’t send to a chat outside its topic roster, and a browser spawn on a server without Chrome is refused', async () => {
  const { mac, server, onServer, onMac, spawn } = await world();
  const own = await server.client.createTopic({ title: 'Server only' });
  const local = await server.client.addTopicChat(own.id);
  const { childId } = await spawn('look around');

  expect(await onServer(childId!, 'send', { to: local.id, text: 'hello' })).toMatchObject({ isError: true, output: expect.stringContaining('No single chat in your topic or linked to you matches') });

  server.machine.facts.browser = false;
  await server.clock.jump(5 * 60_000 + 1);
  await mac.client.computers(true);
  expect((await onMac('computers')).output).toMatch(/ · no Chrome$/m);
  expect((await spawn('browse the shop', { browser: true })).reply).toMatchObject({ isError: true, output: `Spawn denied: ${SERVER} has no Chrome, so browser: true can’t run there.` });
}, 30_000);
