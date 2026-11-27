import { afterEach, expect, test } from 'vitest';
import type { HosEvent } from '../src/api/types.js';
import { callBus } from '../src/fakes/bus-client.js';
import type { AgentScript } from '../src/fakes/scripted-agent-runtime.js';
import { cleanupAll, collect, startTestDaemon, tempGitRepo } from './harness.js';
import { newTopic } from './topics.js';

afterEach(cleanupAll);

type TestHos = Awaited<ReturnType<typeof startTestDaemon>>;

async function setup() {
  const hos = await startTestDaemon({ script: () => [{ delta: 'ok' }] });
  const project = await hos.client.createProject(await tempGitRepo());
  const workspace = await newTopic(hos.client, project.id, 'tasks');
  const lead = await hos.client.createChat(workspace.id);
  const a = await hos.client.createChat(workspace.id, { role: 'worker' });
  const b = await hos.client.createChat(workspace.id, { role: 'worker' });
  return { hos, workspace, lead, a, b };
}

function bus(hos: TestHos, chatId: string, tool: string, args: Record<string, unknown> = {}) {
  const endpoint = hos.agentRuntime.started.filter((spec) => spec.chatId === chatId).at(-1)?.bus;
  return callBus(endpoint, tool, args);
}

test('a main chat keeps a task list with dependencies; workers claim ready tasks in order and complete them', async () => {
  const { hos, workspace, lead, a, b } = await setup();

  const schema = await bus(hos, lead.id, 'task_create', { title: 'Add tenant_id to the Order schema' });
  const api = await bus(hos, lead.id, 'task_create', { title: 'Serve orders by tenant', depends_on: ['T1'] });
  const unknownDep = await bus(hos, lead.id, 'task_create', { title: 'Docs', depends_on: ['T9'] });
  const blocked = await bus(hos, a.id, 'task_claim', { task: 'T2' });
  const next = await bus(hos, a.id, 'task_claim');
  const taken = await bus(hos, b.id, 'task_claim', { task: 'T1' });
  const nothingReady = await bus(hos, b.id, 'task_claim');
  const notYours = await bus(hos, b.id, 'task_complete', { task: 'T1' });
  const noEvidence = await bus(hos, a.id, 'task_complete', { task: 'T1' });
  const done = await bus(hos, a.id, 'task_complete', { task: 'T1', evidence: 'migration 0042 added' });
  const unblocked = await bus(hos, b.id, 'task_claim');
  const list = await bus(hos, lead.id, 'tasks');

  expect(schema.output).toContain('Created T1');
  expect(api.output).toContain('Created T2 (P2) (after T1)');
  expect(unknownDep).toMatchObject({ isError: true, output: expect.stringContaining('T9') });
  expect(blocked).toMatchObject({ isError: true, output: expect.stringContaining('T1 (open)') });
  expect(next).toMatchObject({ isError: false, output: expect.stringContaining('Claimed T1') });
  expect(taken).toMatchObject({ isError: true, output: expect.stringContaining(`claimed by chat ${a.id.slice(0, 8)}`) });
  expect(nothingReady).toMatchObject({ isError: false, output: expect.stringContaining('No task is ready') });
  expect(notYours).toMatchObject({ isError: true, output: expect.stringContaining(`chat ${a.id.slice(0, 8)}`) });
  expect(noEvidence).toMatchObject({ isError: true, output: expect.stringContaining('Missing evidence') });
  expect(done.output).toContain('T1 is done');
  expect(unblocked.output).toContain('Claimed T2');
  expect(list.output).toMatch(/T1 \[P2 done\].*Add tenant_id/);
  expect(list.output).toMatch(new RegExp(`T2 \\[P2 claimed by chat ${b.id.slice(0, 8)}\\].*after T1`));
  expect(await hos.client.listTasks(workspace.id)).toEqual([
    expect.objectContaining({ ref: 'T1', state: 'done', claimedBy: a.id, closedByChat: a.id, evidence: 'migration 0042 added', dependsOn: [] }),
    expect.objectContaining({ ref: 'T2', state: 'claimed', claimedBy: b.id, dependsOn: ['T1'] }),
  ]);
});

test('a main chat takes over or closes tasks held by a paused chat, but not while the holder is alive, and a worker never can', async () => {
  const { hos, workspace, lead, a, b } = await setup();
  for (const title of ['Ship the API', 'Write the docs', 'Run the migration']) await bus(hos, lead.id, 'task_create', { title });
  await bus(hos, a.id, 'task_claim', { task: 'T1' });
  await bus(hos, a.id, 'task_update', { task: 'T1', state: 'review' });
  await bus(hos, a.id, 'task_claim', { task: 'T2' });
  await bus(hos, a.id, 'task_claim', { task: 'T3' });
  await bus(hos, a.id, 'task_update', { task: 'T3', state: 'review' });

  const whileAlive = await bus(hos, lead.id, 'task_complete', { task: 'T1', evidence: 'commit 1a2b3c4' });
  await hos.client.stopChat(a.id);
  const worker = await bus(hos, b.id, 'task_complete', { task: 'T1', evidence: 'commit 1a2b3c4' });
  const closed = await bus(hos, lead.id, 'task_complete', { task: 'T1', evidence: 'commit 1a2b3c4' });
  const claimed = await bus(hos, lead.id, 'task_claim', { task: 'T2' });
  const resumed = await bus(hos, lead.id, 'task_update', { task: 'T3', state: 'claimed' });

  const holder = `chat ${a.id.slice(0, 8)}`;
  expect(whileAlive).toMatchObject({ isError: true, output: expect.stringContaining(`claimed by ${holder}`) });
  expect(worker).toMatchObject({ isError: true, output: expect.stringContaining(`claimed by ${holder}`) });
  expect(closed).toMatchObject({ isError: false, output: expect.stringContaining('T1 is done') });
  expect(claimed).toMatchObject({ isError: false, output: expect.stringContaining(`Took over T2 from ${holder}`) });
  expect(resumed.isError).toBe(false);
  const tasks = await hos.client.listTasks(workspace.id);
  expect(tasks.find((t) => t.ref === 'T1')).toMatchObject({
    state: 'done',
    claimedBy: a.id,
    closedByChat: lead.id,
    evidence: expect.stringMatching(new RegExp(`^commit 1a2b3c4 · closed for ${holder} \\(worker, paused\\)`)),
  });
  expect(tasks.find((t) => t.ref === 'T2')).toMatchObject({ state: 'claimed', claimedBy: lead.id });
  expect(tasks.find((t) => t.ref === 'T3')).toMatchObject({ state: 'claimed', claimedBy: lead.id });
});

async function finishedHolderSetup() {
  const script: AgentScript = (input) => {
    const finish = /^finish (T\d+)$/.exec(input)?.[1];
    if (!finish) return [{ delta: 'ok' }];
    return [
      { bus: 'task_claim', args: { task: finish } },
      { bus: 'task_update', args: { task: finish, state: 'review' } },
      { bus: 'complete', args: { summary: 'Handed T1 to review.' } },
      { delta: 'done' },
    ];
  };
  const hos = await startTestDaemon({ script });
  const project = await hos.client.createProject(await tempGitRepo());
  const workspace = await newTopic(hos.client, project.id, 'tasks');
  const main = await hos.client.createChat(workspace.id);
  const holder = await hos.client.createChat(workspace.id, { role: 'worker' });
  const other = await hos.client.createChat(workspace.id, { role: 'worker' });
  return { hos, workspace, main, holder, other };
}

async function finish(hos: TestHos, chatId: string, ref: string) {
  const stream = collect(hos.client);
  await hos.client.sendMessage(chatId, `finish ${ref}`);
  await stream.until((es) => es.some((e) => e.type === 'chat.state' && e.chatId === chatId && e.state === 'done'));
}

test('another chat in the topic updates and completes a task whose holder is done, keeping the evidence check (S253)', async () => {
  const { hos, workspace, main, holder, other } = await finishedHolderSetup();
  await bus(hos, main.id, 'task_create', { title: 'Ship the API', criteria: ['tests pass'] });
  await bus(hos, main.id, 'task_create', { title: 'Write the docs' });
  await finish(hos, holder.id, 'T1');
  await bus(hos, holder.id, 'task_claim', { task: 'T2' });

  const resumed = await bus(hos, other.id, 'task_update', { task: 'T1', state: 'claimed' });
  const noEvidence = await bus(hos, other.id, 'task_complete', { task: 'T1', met: [1] });
  const closed = await bus(hos, other.id, 'task_complete', { task: 'T1', met: [1], evidence: 'commit 1a2b3c4' });
  const claimed = await bus(hos, other.id, 'task_claim', { task: 'T2' });

  expect(resumed.isError).toBe(false);
  expect(noEvidence).toMatchObject({ isError: true, output: expect.stringContaining('Missing evidence') });
  expect(closed).toMatchObject({ isError: false, output: expect.stringContaining('T1 is done') });
  expect(claimed).toMatchObject({ isError: false, output: expect.stringContaining(`Took over T2 from chat ${holder.id.slice(0, 8)}`) });
  const tasks = await hos.client.listTasks(workspace.id);
  expect(tasks.find((t) => t.ref === 'T1')).toMatchObject({ state: 'done', closedByChat: other.id });
  expect(tasks.find((t) => t.ref === 'T2')).toMatchObject({ state: 'claimed', claimedBy: other.id });
});

test('a worker completes a review task whose done holder it never claimed (S253)', async () => {
  const { hos, workspace, main, holder, other } = await finishedHolderSetup();
  await bus(hos, main.id, 'task_create', { title: 'Ship the API' });
  await finish(hos, holder.id, 'T1');

  const closed = await bus(hos, other.id, 'task_complete', { task: 'T1', evidence: 'test run 12 passed' });

  expect(closed).toMatchObject({ isError: false, output: expect.stringContaining('T1 is done') });
  expect((await hos.client.listTasks(workspace.id)).find((t) => t.ref === 'T1')).toMatchObject({
    state: 'done',
    claimedBy: holder.id,
    closedByChat: other.id,
    evidence: expect.stringContaining(`closed for chat ${holder.id.slice(0, 8)} (worker, done)`),
  });
});

test('a worker still cannot touch a task while its holder is live, idle or paused (S253)', async () => {
  const { hos, main, holder, other } = await finishedHolderSetup();
  await bus(hos, main.id, 'task_create', { title: 'Ship the API' });
  await bus(hos, holder.id, 'task_claim', { task: 'T1' });

  const whileIdle = await bus(hos, other.id, 'task_complete', { task: 'T1', evidence: 'commit 1a2b3c4' });
  await hos.client.stopChat(holder.id);
  const whilePaused = await bus(hos, other.id, 'task_update', { task: 'T1', state: 'review' });
  const claimPaused = await bus(hos, other.id, 'task_claim', { task: 'T1' });

  const name = `chat ${holder.id.slice(0, 8)}`;
  expect(whileIdle).toMatchObject({ isError: true, output: expect.stringContaining(`claimed by ${name}`) });
  expect(whilePaused).toMatchObject({ isError: true, output: expect.stringContaining(`claimed by ${name}`) });
  expect(claimPaused).toMatchObject({ isError: true, output: expect.stringContaining(`claimed by ${name}`) });
});

test('done needs every criterion met and evidence; found work is proposed until a main chat accepts it; claims go by priority', async () => {
  const { hos, workspace, lead, a, b } = await setup();
  await bus(hos, lead.id, 'task_create', { title: 'Low priority docs', priority: 3 });
  await bus(hos, lead.id, 'task_create', { title: 'Session store refactor', priority: 1, criteria: ['All callers use SessionStore', 'Reconnect keeps history'] });

  const first = await bus(hos, a.id, 'task_claim');
  const half = await bus(hos, a.id, 'task_complete', { task: 'T2', evidence: 'commit abc1234', met: [1] });
  const found = await bus(hos, a.id, 'task_create', { title: 'Fix the session leak on reconnect', found_while: 'T2' });
  const early = await bus(hos, b.id, 'task_claim', { task: 'T3' });
  const notLead = await bus(hos, b.id, 'task_update', { task: 'T3', state: 'open' });
  const accepted = await bus(hos, lead.id, 'task_update', { task: 'T3', state: 'open' });
  const done = await bus(hos, a.id, 'task_complete', { task: 'T2', evidence: 'commit abc1234', met: [2] });

  expect(first.output).toContain('Claimed T2');
  expect(first.output).toContain('1. All callers use SessionStore');
  expect(half).toMatchObject({ isError: true, output: expect.stringContaining('criteria not met: 2. Reconnect keeps history') });
  expect(found.output).toContain('Proposed T3');
  expect(early).toMatchObject({ isError: true, output: expect.stringContaining('only proposed') });
  expect(notLead).toMatchObject({ isError: true, output: expect.stringContaining('Only the user or a main chat') });
  expect(accepted.isError).toBe(false);
  expect(done.output).toContain('T2 is done');
  const tasks = await hos.client.listTasks(workspace.id);
  expect(tasks.find((t) => t.ref === 'T2')).toMatchObject({ state: 'done', evidence: 'commit abc1234', criteria: [{ met: true }, { met: true }] });
  expect(tasks.find((t) => t.ref === 'T3')).toMatchObject({ state: 'open', discoveredFrom: 'T2', createdByChat: a.id });
});

test('the user adds, reorders and finishes tasks over HTTP; blocked and review tasks get a copy in the local Today list that closes when they move on', async () => {
  const hos = await startTestDaemon({ script: () => [{ delta: 'ok' }] });
  const project = await hos.client.createProject(await tempGitRepo());
  const topic = await newTopic(hos.client, project.id, 'tasks');
  const worker = await hos.client.createChat(topic.id, { role: 'worker' });
  const today = async () => (await hos.client.myToday()).tasks.map((t) => t.title);

  const t1 = await hos.client.addTask(topic.id, { title: 'Merchant settings page', priority: 2, criteria: ['Saved per shop'] });
  const t2 = await hos.client.addTask(topic.id, { title: 'Usage metering per shop', priority: 2 });
  await hos.client.updateTask(topic.id, 'T2', { move: 'up' });
  const order = (await hos.client.listTasks(topic.id)).sort((x, y) => x.rank - y.rank).map((t) => t.ref);
  await bus(hos, worker.id, 'task_claim', { task: 'T1' });
  await bus(hos, worker.id, 'task_update', { task: 'T1', state: 'blocked', question: 'Which shops first?' });
  const linked = await until(async () => (await hos.client.listTasks(topic.id)).find((t) => t.ref === 'T1' && t.mirrorId));
  const whileBlocked = await today();
  await hos.client.updateTask(topic.id, 'T1', { state: 'claimed' });
  await until(async () => ((await today()).length === 0 ? true : undefined));
  const early = await hos.client.updateTask(topic.id, 'T1', { state: 'done', evidence: 'commit 9d02a1e' }).catch((e: Error) => e.message);
  await hos.client.updateTask(topic.id, 'T1', { check: { index: 0, met: true } });
  const done = await hos.client.updateTask(topic.id, 'T1', { state: 'done', evidence: 'commit 9d02a1e' });
  await hos.client.capture('Call the bank');
  const manual = await hos.client.linkTask(topic.id, 'T2', true);
  const beforePriority = await today();
  await hos.client.updateTask(topic.id, 'T2', { priority: 1 });
  const afterPriority = await until(async () => {
    const titles = await today();
    return titles[0]?.startsWith('T2') ? titles : undefined;
  });
  const unlinked = await hos.client.linkTask(topic.id, 'T2', false);

  expect([t1.ref, t2.ref]).toEqual(['T1', 'T2']);
  expect(order).toEqual(['T2', 'T1']);
  expect(linked).toMatchObject({ state: 'blocked', question: 'Which shops first?', mirrorAuto: true });
  expect(whileBlocked).toEqual(['T1 · Merchant settings page (tasks)']);
  expect(early).toContain('criteria not met');
  expect(done).toMatchObject({ state: 'done', closedByChat: null, mirrorId: null });
  expect(manual).toMatchObject({ mirrorAuto: false, mirrorId: expect.any(String) });
  expect(beforePriority).toEqual(['Call the bank', 'T2 · Usage metering per shop (tasks)']);
  expect(afterPriority).toEqual(['T2 · Usage metering per shop (tasks)', 'Call the bank']);
  expect(unlinked.mirrorId).toBeNull();
  expect(await today()).toEqual(['Call the bank']);
  expect(await hos.client.sources()).toMatchObject({ tasks: { label: 'This computer' }, capture: { label: 'This computer' }, calendar: null, snags: { label: 'This computer' } });
});

async function until<T>(read: () => Promise<T | undefined>, ms = 5_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

test('a claimed task past its time limit is flagged once, and its claimer and its creator are told', async () => {
  const { hos, workspace, lead, a } = await setup();
  const stream = collect(hos.client);
  await bus(hos, lead.id, 'task_create', { title: 'Write the migration', limit_minutes: 30 });
  await bus(hos, a.id, 'task_claim', { task: 'T1' });

  await hos.clock.advance(29 * 60_000);
  const early = await hos.client.listTasks(workspace.id);
  await hos.clock.advance(3 * 60_000);
  const notice = (es: HosEvent[], chatId: string) =>
    es.some((e) => e.type === 'message.user' && e.chatId === chatId && e.from === 'hos' && e.text.includes('T1') && e.text.includes('time limit'));
  const events = await stream.until((es) => notice(es, a.id) && notice(es, lead.id));
  await hos.clock.advance(5 * 60_000);

  expect(early[0]!.flagged).toBe(false);
  expect((await hos.client.listTasks(workspace.id))[0]).toMatchObject({ ref: 'T1', state: 'claimed', flagged: true });
  expect(events.filter((e) => e.type === 'task.updated' && e.task.flagged)).toHaveLength(1);
  expect(stream.events.filter((e) => e.type === 'task.updated' && e.task.flagged)).toHaveLength(1);
});

test('a task created without limit_minutes is never flagged, however long its claim runs', async () => {
  const { hos, workspace, lead, a } = await setup();
  await bus(hos, lead.id, 'task_create', { title: 'Write the migration' });
  const claimed = await bus(hos, a.id, 'task_claim', { task: 'T1' });

  await hos.clock.jump(50 * 60 * 60_000);
  await hos.clock.jump(60_000);

  expect(claimed.output).not.toContain('Time limit');
  expect((await hos.client.listTasks(workspace.id))[0]).toMatchObject({ ref: 'T1', state: 'claimed', flagged: false, limitMinutes: null });
});
