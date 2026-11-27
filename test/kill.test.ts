import { afterEach, expect, test } from 'vitest';
import type { HosEvent } from '../src/api/types.js';
import { callBus } from '../src/fakes/bus-client.js';
import type { AgentScript } from '../src/fakes/scripted-agent-runtime.js';
import { cleanupAll, collect, startTestDaemon, tempGitRepo } from './harness.js';
import { newTopic } from './topics.js';

afterEach(cleanupAll);

type TestHos = Awaited<ReturnType<typeof startTestDaemon>>;

const slow: AgentScript = (input) => (input.includes('Return contract') ? [{ afterMs: 60 * 60_000, delta: 'finished' }] : [{ delta: 'ok' }]);

async function setup() {
  const hos = await startTestDaemon({ script: slow });
  const project = await hos.client.createProject(await tempGitRepo());
  const workspace = await newTopic(hos.client, project.id, 'kill');
  const other = await newTopic(hos.client, project.id, 'other');
  const main = await hos.client.createChat(workspace.id);
  const otherMain = await hos.client.createChat(other.id);
  return { hos, project, workspace, other, main, otherMain };
}

function bus(hos: TestHos, chatId: string, tool: string, args: Record<string, unknown> = {}) {
  const endpoint = hos.agentRuntime.started.filter((spec) => spec.chatId === chatId).at(-1)?.bus;
  return callBus(endpoint, tool, args);
}

let requests = 0;
async function spawn(hos: TestHos, parentId: string, role = 'worker'): Promise<string> {
  requests += 1;
  const result = await bus(hos, parentId, 'spawn', { role, intent: `kill slice ${requests}`, prompt: 'Work.', client_request_id: `k-${requests}` });
  const id = /chat ([0-9a-f-]{36})/.exec(result.output)?.[1];
  if (!id || result.isError) throw new Error(result.output);
  return id;
}

const lastState = (events: HosEvent[], chatId: string) =>
  events.filter((e): e is Extract<HosEvent, { type: 'chat.state' }> & { seq: number; ts: number } => e.type === 'chat.state' && e.chatId === chatId).at(-1)?.state;

test('the subtree kill switch interrupts a chat and every chat below it, and nothing else', async () => {
  const { hos, main } = await setup();
  const worker = await spawn(hos, main.id);
  const scout = await spawn(hos, worker, 'scout');
  const sibling = await spawn(hos, main.id, 'reviewer');
  const stream = collect(hos.client);
  await stream.until((es) => lastState(es, scout) === 'running');

  const { killed } = await hos.client.kill({ scope: 'subtree', chatId: worker });
  await hos.clock.advance(60 * 60_000);
  const events = await stream.until((es) => lastState(es, sibling) === 'idle');

  expect(killed.sort()).toEqual([worker, scout].sort());
  expect(lastState(events, worker)).toBe('killed');
  expect(lastState(events, scout)).toBe('killed');
  expect(events.some((e) => e.type === 'message.completed' && (e.chatId === worker || e.chatId === scout))).toBe(false);
  expect(lastState(events, main.id)).toBe('idle');
  expect(await bus(hos, worker, 'whoami')).toMatchObject({ isError: true, output: expect.stringContaining('killed') });
});

test('the workspace kill switch stops admission and interrupts that workspace only, until the user lifts it', async () => {
  const { hos, workspace, main, otherMain } = await setup();
  const worker = await spawn(hos, main.id);
  const stream = collect(hos.client);

  await hos.client.kill({ scope: 'topic', topicId: workspace.id });
  const events = await stream.until((es) => lastState(es, worker) === 'killed');
  const spawnElsewhere = await bus(hos, otherMain.id, 'spawn', { role: 'scout', intent: 'elsewhere', prompt: 'p', client_request_id: 'e1' });

  expect(lastState(events, main.id)).toBe('killed');
  expect(await hos.client.listKillSwitches()).toMatchObject([{ scope: 'topic', topicId: workspace.id }]);
  await expect(hos.client.sendMessage(main.id, 'hello')).rejects.toMatchObject({ status: 409 });
  expect(spawnElsewhere.isError).toBe(false);

  await hos.client.liftKillSwitch({ scope: 'topic', topicId: workspace.id });
  await hos.client.sendMessage(main.id, 'back to work');
  await stream.until((es) => lastState(es, main.id) === 'idle');
  const spawnAgain = await bus(hos, main.id, 'spawn', { role: 'scout', intent: 'after lifting', prompt: 'p', client_request_id: 'a1' });

  expect(spawnAgain.isError).toBe(false);
  expect(await hos.client.listKillSwitches()).toEqual([]);
});

test('the global kill switch interrupts every live chat and refuses every spawn', async () => {
  const { hos, main, otherMain } = await setup();
  const worker = await spawn(hos, main.id);
  const stream = collect(hos.client);

  const { killed } = await hos.client.kill({ scope: 'global' });
  await stream.until((es) => [main.id, otherMain.id, worker].every((id) => lastState(es, id) === 'killed'));
  const spawnAfter = await bus(hos, main.id, 'spawn', { role: 'scout', intent: 'after', prompt: 'p', client_request_id: 'g1' });

  expect(killed).toHaveLength(3);
  expect(spawnAfter.isError).toBe(true);
  expect(await hos.client.listKillSwitches()).toMatchObject([{ scope: 'global' }]);
  await expect(hos.client.sendMessage(otherMain.id, 'go')).rejects.toMatchObject({ status: 409 });
});

test('a killed chat cannot spawn, and messages to it are refused', async () => {
  const { hos, main } = await setup();
  const worker = await spawn(hos, main.id);
  await hos.client.kill({ scope: 'subtree', chatId: worker });

  const fromKilled = await bus(hos, worker, 'spawn', { role: 'scout', intent: 'from the dead', prompt: 'p', client_request_id: 'd1' });
  const toKilled = await bus(hos, main.id, 'send', { to: worker, text: 'are you there?' });

  expect(fromKilled).toMatchObject({ isError: true, output: expect.stringContaining('killed') });
  expect(toKilled).toMatchObject({ isError: true, output: expect.stringContaining('killed') });
});

test('a bad kill request is refused', async () => {
  const { hos } = await setup();

  await expect(hos.client.kill({ scope: 'subtree', chatId: 'nope' })).rejects.toMatchObject({ status: 404 });
  await expect(hos.client.kill({ scope: 'everything' as 'global' })).rejects.toMatchObject({ status: 400 });
});
