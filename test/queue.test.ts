import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { AgentChatSpec, AgentRuntime, AgentSink } from '../src/adapters/agent-runtime.js';
import type { Chat, HosEvent } from '../src/api/types.js';
import { callBus } from '../src/fakes/bus-client.js';
import { FakeClock } from '../src/fakes/fake-clock.js';
import { ScriptedAgentRuntime, type AgentScript } from '../src/fakes/scripted-agent-runtime.js';
import { cleanupAll, collect, startTestDaemon, tempDir, tempGitRepo } from './harness.js';
import { newTopic } from './topics.js';

afterEach(cleanupAll);

const BRIEF = 'queued brief';

const script: AgentScript = (input) => (input === 'slow' ? [{ afterMs: 60 * 60_000, delta: 'finished' }] : [{ delta: input.includes(BRIEF) ? 'brief done' : 'ok' }]);

function stallingBrief(inner: ScriptedAgentRuntime): AgentRuntime {
  return {
    agent: inner.agent,
    started: inner.started,
    transcript: (nativeId) => inner.transcript(nativeId),
    terminalCommand: (spec) => inner.terminalCommand(spec),
    async start(spec: AgentChatSpec, sink: AgentSink) {
      const session = await inner.start(spec, sink);
      return { ...session, send: (text: string) => (text.includes(BRIEF) ? undefined : session.send(text)) };
    },
  } as AgentRuntime;
}

const lastState = (events: HosEvent[], chatId: string) =>
  events.filter((e): e is Extract<HosEvent, { type: 'chat.state' }> => e.type === 'chat.state' && e.chatId === chatId).at(-1)?.state;

test('a queued chat whose slot freed just before a restart still runs its queued turn after the restart', async () => {
  const policyFile = join(await tempDir('hos-policy-'), 'policy.yaml');
  await writeFile(policyFile, 'slots:\n  claude_running: 1\n');
  const clock = new FakeClock();
  const first = await startTestDaemon({ policyFile, agentRuntime: stallingBrief(new ScriptedAgentRuntime(clock, script)) });
  const project = await first.client.createProject(await tempGitRepo());
  const topic = await newTopic(first.client, project.id, 'queue');
  const lead = await first.client.createChat(topic.id);
  const stream = collect(first.client);
  await first.client.sendMessage(lead.id, 'slow');
  await stream.until((es) => lastState(es, lead.id) === 'running');

  const endpoint = first.agentRuntime.started.filter((spec) => spec.chatId === lead.id).at(-1)?.bus;
  const spawned = await callBus(endpoint, 'spawn', { role: 'worker', intent: 'queued worker', prompt: BRIEF, client_request_id: 'q-1' });
  const worker = /chat ([0-9a-f-]{36})/.exec(spawned.output)![1]!;
  await stream.until((es) => es.some((e) => e.type === 'chat.queued' && e.chatId === worker));

  await first.client.stopChat(lead.id);
  await stream.until(() => first.agentRuntime.started.some((spec) => spec.chatId === worker));
  await first.stop();

  const second = await startTestDaemon({ policyFile, dataDir: first.dataDir, passkeyOf: first.dataDir, script, refreshMs: 50 });
  const after = collect(second.client);
  await after.until((es) => es.some((e) => e.type === 'message.completed' && e.chatId === worker && e.text === 'brief done'));
  expect(lastState(after.events, worker)).not.toBe('queued');
});

const slowScript: AgentScript = (input) => [input.includes('slow') ? { afterMs: 60 * 60_000, delta: 'finished' } : { delta: 'ok' }];

async function leadWithSlots(slots: number) {
  const policyFile = join(await tempDir('hos-policy-'), 'policy.yaml');
  await writeFile(policyFile, `slots:\n  claude_running: ${slots}\n`);
  const hos = await startTestDaemon({ policyFile, agentRuntime: new ScriptedAgentRuntime(new FakeClock(), slowScript) });
  const project = await hos.client.createProject(await tempGitRepo());
  const stream = collect(hos.client);
  const lead = await hos.client.createChat((await newTopic(hos.client, project.id, 'lead')).id);
  await hos.client.sendMessage(lead.id, 'plan');
  await stream.until((es) => es.some((e) => e.type === 'message.completed' && e.chatId === lead.id));
  const endpoint = (id: string) => hos.agentRuntime.started.filter((spec) => spec.chatId === id).at(-1)!.bus;
  const spawn = (intent: string) => callBus(endpoint(lead.id), 'spawn', { role: 'worker', intent, prompt: `slow ${intent}`, client_request_id: intent });
  return { hos, project, stream, lead, endpoint, spawn };
}

test('a parent whose children hold every Claude slot still runs a turn a child sends it, and its next child queues instead', async () => {
  const { hos, project, stream, lead, endpoint, spawn } = await leadWithSlots(6);
  const children: string[] = [];
  const replies: string[] = [];
  for (const intent of ['frontend form', 'database migration', 'payment webhook', 'docs website', 'email templates']) {
    const { output } = await spawn(intent);
    replies.push(output);
    children.push(/chat ([0-9a-f-]{36})/.exec(output)![1]!);
  }
  expect(replies[0]).toContain('Claude slots free: 4 of 6.');
  expect(replies[4]).toContain('Claude slots free: 0 of 6.');
  const other = await hos.client.createChat((await newTopic(hos.client, project.id, 'other')).id);
  await hos.client.sendMessage(other.id, 'slow');
  await stream.until((es) => [...children, other.id].every((id) => lastState(es, id) === 'running'));

  const asked = await callBus(endpoint(children[0]!), 'send', { to: lead.id, text: 'which table?' });
  expect(asked.output).not.toContain('queued');
  await stream.until((es) => es.filter((e) => e.type === 'message.completed' && e.chatId === lead.id).length === 2);

  const sixth = await spawn('search index');
  expect(sixth.output).toContain('It is queued (P2): all 6 Claude slots are running.');
  expect(lastState(stream.events, lead.id)).not.toBe('queued');
});

test('an idle parent keeps a Claude slot, so its children queue once only that slot is left', async () => {
  const { stream, lead, endpoint, spawn } = await leadWithSlots(2);
  const first = /chat ([0-9a-f-]{36})/.exec((await spawn('frontend form')).output)![1]!;
  expect((await spawn('database migration')).output).toContain('It is queued (P2): all 2 Claude slots are running or kept for a parent chat.');

  await stream.until((es) => lastState(es, first) === 'running');
  expect((await callBus(endpoint(first), 'send', { to: lead.id, text: 'which table?' })).output).not.toContain('queued');
  await stream.until((es) => es.filter((e) => e.type === 'message.completed' && e.chatId === lead.id).length === 2);
});

test('idle leads with no busy children keep no Claude slot, so a new worker still starts', async () => {
  const brainDir = await tempDir('hos-brain-');
  for (const id of ['generic', 'lead']) {
    await mkdir(join(brainDir, 'profiles', id), { recursive: true });
    await writeFile(join(brainDir, 'profiles', id, 'PROFILE.md'), `---\ndescription: ${id}\n---\n`);
  }
  const policyFile = join(await tempDir('hos-policy-'), 'policy.yaml');
  await writeFile(policyFile, 'slots:\n  claude_running: 6\n');
  const hos = await startTestDaemon({ brainDir, policyFile, agentRuntime: new ScriptedAgentRuntime(new FakeClock(), slowScript) });
  const project = await hos.client.createProject(await tempGitRepo());
  const stream = collect(hos.client);
  const leads: Chat[] = [];
  for (let i = 0; i < 8; i++) leads.push(await hos.client.addTopicChat((await newTopic(hos.client, project.id, `lead ${i}`)).id, { profile: 'lead' }));
  for (const lead of leads) await hos.client.sendMessage(lead.id, 'plan');
  await stream.until((es) => leads.every((lead) => es.some((e) => e.type === 'message.completed' && e.chatId === lead.id)));
  expect(leads.every((lead) => lead.profile === 'lead')).toBe(true);
  const others: Chat[] = [];
  for (let i = 0; i < 5; i++) others.push(await hos.client.createChat((await newTopic(hos.client, project.id, `other ${i}`)).id));
  for (const other of others) await hos.client.sendMessage(other.id, 'slow');
  await stream.until((es) => others.every((other) => lastState(es, other.id) === 'running'));

  const bus = hos.agentRuntime.started.filter((spec) => spec.chatId === others[0]!.id).at(-1)!.bus;
  const { output } = await callBus(bus, 'spawn', { role: 'worker', intent: 'search index', prompt: 'slow search index', client_request_id: 'w-1' });
  expect(output).not.toContain('queued');
  expect(output).toContain('Claude slots free: 0 of 6.');
});
