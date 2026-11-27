import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { HosEvent } from '../src/api/types.js';
import { callBus } from '../src/fakes/bus-client.js';
import type { AgentScript } from '../src/fakes/scripted-agent-runtime.js';
import { cleanupAll, collect, startTestDaemon, tempGitRepo } from './harness.js';

afterEach(cleanupAll);

const echoContext: AgentScript = (_input, _history, turn) => [{ delta: turn.context ?? '(no context)' }];

async function world() {
  const brain = await tempGitRepo('main');
  const hos = await startTestDaemon({ brainDir: brain, script: echoContext });
  const stream = collect(hos.client);
  const topic = async (title: string) => {
    const made = await hos.client.createTopic({ title });
    const chat = await hos.client.addTopicChat(made.id);
    return { topic: made, chat };
  };
  const bus = (chatId: string, tool: string, args: Record<string, unknown> = {}) =>
    callBus(hos.agentRuntime.started.filter((spec) => spec.chatId === chatId).at(-1)?.bus, tool, args);
  return { hos, brain, stream, topic, bus };
}

const completed = (chatId: string, text: string) => (es: HosEvent[]) =>
  es.some((e) => e.type === 'message.completed' && e.chatId === chatId && e.text.includes(text));

test('a link lets send cross topics, both chats hear of it, the roster lists it, and unlink stops it', async () => {
  const { hos, stream, topic, bus } = await world();
  const { chat: a } = await topic('Alpha');
  const { chat: b } = await topic('Beta');

  expect(await bus(a.id, 'send', { to: b.id, text: 'hi' })).toMatchObject({ isError: true, output: expect.stringContaining('No single chat in your topic') });

  expect(await hos.client.linkChat(a.id, { chatId: b.id })).toMatchObject([{ target: b.lineageId, kind: 'chat' }]);
  const sent = await bus(a.id, 'send', { to: b.id.slice(0, 8), text: 'Across topics.' });
  expect(sent.isError).toBe(false);
  await stream.until(completed(b.id, `The user linked you with chat ${a.id.slice(0, 8)} (topic "Alpha")`));
  const roster = await bus(a.id, 'roster');
  expect(roster.output).toContain('Linked (The user linked these chats with you');
  expect(roster.output).toMatch(new RegExp(`- ${b.id.slice(0, 8)} .* · topic "Beta"`));
  const linked = stream.events.filter((e): e is Extract<HosEvent, { type: 'chat.links' }> => e.type === 'chat.links');
  expect(linked.map((e) => e.lineageId).sort()).toEqual([a.lineageId, b.lineageId].sort());
  expect(linked.find((e) => e.lineageId === b.lineageId)?.note).toBe(`The user linked this chat with chat ${a.id.slice(0, 8)} (topic "Alpha")`);
  expect((await hos.client.snapshot()).state.links[a.lineageId]).toMatchObject([{ target: b.lineageId, kind: 'chat' }]);
  await expect(hos.client.linkChat(a.id, { chatId: a.id })).rejects.toMatchObject({ status: 400 });

  expect(await hos.client.unlinkChat(b.id, a.id)).toEqual([]);

  expect(await bus(a.id, 'send', { to: b.id, text: 'still there?' })).toMatchObject({ isError: true, output: expect.stringContaining('No single chat') });
  expect((await hos.client.snapshot()).state.links[a.lineageId]).toEqual([]);
  await expect(hos.client.unlinkChat(b.id, a.id)).rejects.toMatchObject({ status: 404 });
});

test('a diagram from another topic linked to a chat is in its briefing as linked', async () => {
  const { hos, stream, topic } = await world();
  const { chat } = await topic('Alpha');
  const { topic: other } = await topic('Beta');
  const diagram = await hos.client.createDiagram(other.id, 'Far board');

  expect(await hos.client.linkChat(chat.id, { diagramId: diagram.id })).toMatchObject([{ target: diagram.id, kind: 'diagram' }]);
  await hos.client.sendMessage(chat.id, 'hello');

  await stream.until(completed(chat.id, `- far-board · Far board · ${diagram.path} · in another topic · linked to this chat`));
  expect((await hos.client.diagram(diagram.id)).chats).toEqual([chat.lineageId]);
  await expect(hos.client.linkChat(chat.id, { diagramId: 'no-such-board' })).rejects.toMatchObject({ status: 404 });
});

test('an old chat: field in diagram.md becomes a link on first read and leaves the file', async () => {
  const { hos, brain, topic } = await world();
  const { topic: t, chat } = await topic('Legacy');
  const file = join(brain, 'diagrams/old/diagram.md');
  await mkdir(join(brain, 'diagrams/old'), { recursive: true });
  await writeFile(file, `---\ntitle: Old\ntopic: ${t.id}\nchat: ${chat.lineageId}\ncreated: 2026-10-12T00:00:00.000Z\n---\n\n# Old\n`);

  expect(await hos.client.diagram('old')).toMatchObject({ topic: t.id, chats: [chat.lineageId] });
  expect(await readFile(file, 'utf8')).toBe(`---\ntitle: Old\ntopic: ${t.id}\ncreated: 2026-10-12T00:00:00.000Z\n---\n\n# Old\n`);
  expect((await hos.client.snapshot()).state.links[chat.lineageId]).toMatchObject([{ target: 'old', kind: 'diagram' }]);

  await hos.client.unlinkChat(chat.id, 'old');

  expect((await hos.client.diagram('old')).chats).toEqual([]);
});
