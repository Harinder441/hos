import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { AgentChatSpec, AgentRuntime, AgentSink } from '../src/adapters/agent-runtime.js';
import type { HosEvent } from '../src/api/types.js';
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
