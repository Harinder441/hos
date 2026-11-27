import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import type { HosEvent } from '../src/api/types.js';
import { callBus } from '../src/fakes/bus-client.js';
import type { AgentScript, ScriptStep } from '../src/fakes/scripted-agent-runtime.js';
import { cleanupAll, collect, startTestDaemon, tempDir, tempGitRepo } from './harness.js';
import { newTopic } from './topics.js';

afterEach(cleanupAll);

const peer = (context: string | undefined, role: string) => new RegExp(`^- (\\w{8}) \\S+ ${role} (?!\\S+ \\(you\\))`, 'm').exec(context ?? '')?.[1];
const sender = (input: string) => /\[from chat (\w{8}) /.exec(input)?.[1];

const spawn = (role: string, intent: string, n: number): ScriptStep => ({
  bus: 'spawn',
  args: { role, intent, prompt: `${intent}.`, client_request_id: `demo-${n}`, files_owned: role === 'worker' ? [`src/${intent.split(' ').at(-1)}/**`] : [] },
});

const team: AgentScript = (input, _history, { context }) => {
  if (input === 'plan the orders feature') {
    return [
      spawn('worker', 'Build the orders api', 1),
      spawn('worker', 'Build the orders ui', 2),
      spawn('reviewer', 'Review the orders feature', 3),
      { delta: 'Spawned two workers and a reviewer.' },
    ];
  }
  if (input.includes('Intent: Build the orders api')) return [{ delta: 'Building the API.' }];
  if (input.includes('Message me when GET /orders is live.')) {
    return [
      { bus: 'send', args: { to: sender(input), text: 'GET /orders is live and returns id, total.' } },
      { bus: 'complete', args: { summary: 'API done: GET /orders returns id, total.' } },
      { delta: 'API ready.' },
    ];
  }
  if (input.includes('Intent: Build the orders ui')) {
    return [{ bus: 'send', args: { to: peer(context, 'worker'), text: 'Message me when GET /orders is live.' } }, { delta: 'Waiting for the API.' }];
  }
  if (input.includes('GET /orders is live and returns id, total.')) {
    return [
      { bus: 'send', args: { to: peer(context, 'reviewer'), text: 'The UI lists orders from GET /orders (id, total). Please review.' } },
      { bus: 'complete', args: { summary: 'UI done: the orders list reads GET /orders.' } },
      { delta: 'UI ready.' },
    ];
  }
  if (input.includes('Intent: Review the orders feature')) return [{ delta: 'Waiting for the workers.' }];
  if (input.includes('Please review.')) {
    return [
      { bus: 'complete', args: { summary: 'Review passed: API and UI agree.' } },
      { delta: 'Reviewed.' },
    ];
  }
  return [{ delta: 'Noted.' }];
};

test('demo: a scripted main chat spawns two workers and a reviewer that coordinate through messages', async () => {
  const hos = await startTestDaemon({ script: team });
  const project = await hos.client.createProject(await tempGitRepo('main', await tempDir('hos-parent-')));
  const workspace = await newTopic(hos.client, project.id, 'orders');
  const main = await hos.client.createChat(workspace.id);
  const stream = collect(hos.client);

  await hos.client.sendMessage(main.id, 'plan the orders feature');
  const children = () => stream.events.flatMap((e) => (e.type === 'chat.created' && e.chat.parentId === main.id ? [e.chat] : []));
  await stream.until(() => children().length === 3);
  const done = (es: HosEvent[], id: string) => es.some((e) => e.type === 'chat.state' && e.chatId === id && e.state === 'done');
  const mainNotices = (es: HosEvent[]) =>
    es.flatMap((e) => (e.type === 'message.user' && e.chatId === main.id && e.from === 'hos' ? [e.text] : [])).join('\n');
  const allNoticed = (es: HosEvent[]) => children().every((c) => mainNotices(es).includes(`chat ${c.id.slice(0, 8)}`));
  for (let minute = 0; minute < 30 && !allNoticed(stream.events); minute++) {
    await hos.clock.advance(60_000);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const events = await stream.until(allNoticed);

  const [api, ui, reviewer] = children();
  expect(children().map((c) => [c.role, c.depth, c.intent])).toEqual([
    ['worker', 1, 'Build the orders api'],
    ['worker', 1, 'Build the orders ui'],
    ['reviewer', 1, 'Review the orders feature'],
  ]);
  expect(children().every((c) => done(events, c.id))).toBe(true);

  const live = events.find((e) => e.type === 'message.user' && e.chatId === ui!.id && e.from === 'chat' && e.text.includes('GET /orders is live'));
  expect(live).toMatchObject({ fromChatId: api!.id });

  const handoff = events.find((e) => e.type === 'message.user' && e.chatId === reviewer!.id && e.from === 'chat' && e.text.includes('Please review.'));
  expect(handoff).toMatchObject({ fromChatId: ui!.id });
  expect(handoff && 'text' in handoff && handoff.text).toContain(`[from chat ${ui!.id.slice(0, 8)} · role=worker · not the user]`);

  for (const child of children()) expect(mainNotices(events)).toContain(`chat ${child.id.slice(0, 8)} (${child.role}) is done`);

  const endpoint = hos.agentRuntime.started.find((s) => s.chatId === main.id)!.bus;
  const waited = await callBus(endpoint, 'wait', { chat: reviewer!.id });
  expect(waited.output).toContain('is done');
  expect(waited.output).toContain('Review passed: API and UI agree.');
});

const pair: AgentScript = (input) => {
  if (input === 'split the orders feature') {
    return [
      { bus: 'task_create', args: { title: 'Orders API at src/api/orders.ts' } },
      { bus: 'task_create', args: { title: 'Orders list at src/ui/list.ts' } },
      { bus: 'spawn', args: { role: 'worker', intent: 'Build the orders api', prompt: 'Claim T1.', files_owned: ['src/api/**'], client_request_id: 'pair-1' } },
      { bus: 'spawn', args: { role: 'worker', intent: 'Build the orders ui', prompt: 'Claim T2.', files_owned: ['src/ui/**'], client_request_id: 'pair-2' } },
      { delta: 'Two workers on disjoint files.' },
    ];
  }
  const side = /Intent: Build the orders (api|ui)/.exec(input)?.[1];
  if (!side) return [{ delta: 'Noted.' }];
  const [task, file] = side === 'api' ? ['T1', 'src/api/orders.ts'] : ['T2', 'src/ui/list.ts'];
  const write = (path: string, afterMs: number): ScriptStep => ({ afterMs, tool: 'Write', input: { file_path: path, content: `${path}\n` }, output: 'ok', writes: { path, content: `${path}\n` } });
  return [
    { bus: 'task_claim', args: { task } },
    write(file, side === 'api' ? 2_000 : 1_000),
    ...(side === 'ui' ? [write('src/api/orders.ts', 500)] : []),
    write(file.replace('.ts', '.test.ts'), 1_000),
    { bus: 'task_complete', args: { task, evidence: `${file} written` } },
    { bus: 'complete', args: { summary: `${side} done` } },
    { delta: 'Done.' },
  ];
};

test('demo: two workers edit disjoint files in parallel in the same worktree without conflict', async () => {
  const hos = await startTestDaemon({ script: pair, policyFile: fileURLToPath(new URL('./fixtures/policy.yaml', import.meta.url)) });
  const repo = await tempGitRepo('main', await tempDir('hos-parent-'));
  const project = await hos.client.createProject(repo);
  const workspace = await newTopic(hos.client, project.id, 'orders');
  const main = await hos.client.createChat(workspace.id);
  const stream = collect(hos.client);

  await hos.client.sendMessage(main.id, 'split the orders feature');
  const workers = () => stream.events.flatMap((e) => (e.type === 'chat.created' && e.chat.parentId === main.id ? [e.chat] : []));
  await stream.until((es) => es.filter((e) => e.type === 'bus.call' && e.tool === 'task_claim').length === 2);
  const done = (id: string) => stream.events.some((e) => e.type === 'chat.state' && e.chatId === id && e.state === 'done');
  for (let i = 0; i < 60 && !workers().every((w) => done(w.id)); i++) {
    await hos.clock.advance(500);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const [api, ui] = workers();

  expect(workers().every((w) => done(w.id))).toBe(true);
  expect(api!.worktreePath).toBeNull();
  expect(ui!.worktreePath).toBeNull();
  const writes = stream.events.flatMap((e) => (e.type === 'tool.started' && e.name === 'Write' ? [e.chatId === api!.id ? 'api' : 'ui'] : []));
  expect(writes.slice(0, 3)).toEqual(['ui', 'ui', 'api']);
  const denied = stream.events.find((e) => e.type === 'tool.completed' && e.isError);
  expect(denied).toMatchObject({ chatId: ui!.id, output: expect.stringContaining('src/api/orders.ts is inside src/api/**') });
  expect(denied && 'output' in denied && denied.output).toContain(`src/api/** locked by chat ${api!.id.slice(0, 8)} (worker`);
  for (const file of ['src/api/orders.ts', 'src/api/orders.test.ts', 'src/ui/list.ts', 'src/ui/list.test.ts']) {
    expect(await readFile(join(repo, file), 'utf8')).toBe(`${file}\n`);
  }
  expect((await hos.client.listTasks(workspace.id)).map((t) => `${t.ref} ${t.state} ${t.claimedBy === api!.id ? 'api' : 'ui'}`)).toEqual([
    'T1 done api',
    'T2 done ui',
  ]);
  expect(await hos.client.listLocks(workspace.id)).toEqual([]);
});
