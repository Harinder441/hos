import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { HosEvent } from '../src/api/types.js';
import type { AgentScript } from '../src/fakes/scripted-agent-runtime.js';
import { cleanupAll, collect, startTestDaemon, tempGitRepo } from './harness.js';
import { newTopic } from './topics.js';

afterEach(cleanupAll);

const writeHello: AgentScript = () => [
  {
    tool: 'Write',
    input: { file_path: 'hello.txt', content: 'hi' },
    output: 'File created successfully',
    ask: true,
    writes: { path: 'hello.txt', content: 'hi' },
  },
  { delta: 'Done.' },
];

async function chatAskingToWrite() {
  const hos = await startTestDaemon({ script: writeHello });
  const repo = await tempGitRepo();
  const project = await hos.client.createProject(repo);
  const workspace = await newTopic(hos.client, project.id, 'approvals');
  const chat = await hos.client.createChat(workspace.id);
  const stream = collect(hos.client);
  await hos.client.sendMessage(chat.id, 'write hello.txt');
  const events = await stream.until((es) => es.some((e) => e.type === 'approval.requested'));
  const card = events.find((e) => e.type === 'approval.requested') as Extract<HosEvent, { type: 'approval.requested' }>;
  return { hos, repo, chat, stream, card };
}

const turnDone = (es: HosEvent[]) => es.some((e) => e.type === 'message.completed') && es.findLast((e) => e.type !== 'workspace.git' && e.type !== 'worktree.updated')?.type === 'chat.state';

test('a permission request shows up as a card naming the tool and its input, and the tool waits for the user', async () => {
  const { repo, chat, stream, card } = await chatAskingToWrite();

  expect(card).toMatchObject({ chatId: chat.id, tool: 'Write', input: '{"file_path":"hello.txt","content":"hi"}' });
  expect(stream.events.filter((e) => e.type === 'tool.completed')).toEqual([]);
  expect(existsSync(join(repo, 'hello.txt'))).toBe(false);
});

test('approving the card lets the tool run in the chat’s working tree and the turn finishes', async () => {
  const { hos, repo, chat, stream, card } = await chatAskingToWrite();

  await hos.client.decideApproval(card.approvalId, 'approve');
  const events = await stream.until(turnDone);

  expect(events.find((e) => e.type === 'approval.resolved')).toMatchObject({ approvalId: card.approvalId, decision: 'approve' });
  expect(events.find((e) => e.type === 'tool.completed')).toMatchObject({ chatId: chat.id, isError: false });
  expect(await readFile(join(repo, 'hello.txt'), 'utf8')).toBe('hi');
});

test('denying the card stops the tool, tells the agent it was denied, and the turn still finishes', async () => {
  const { hos, repo, stream, card } = await chatAskingToWrite();

  await hos.client.decideApproval(card.approvalId, 'deny');
  const events = await stream.until(turnDone);

  expect(events.find((e) => e.type === 'approval.resolved')).toMatchObject({ approvalId: card.approvalId, decision: 'deny' });
  expect(events.find((e) => e.type === 'tool.completed')).toMatchObject({ isError: true, output: 'The user denied this request.' });
  expect(existsSync(join(repo, 'hello.txt'))).toBe(false);
});

test('every permission request asks, even for a tool approved earlier in the chat', async () => {
  const { hos, chat, stream, card } = await chatAskingToWrite();
  await hos.client.decideApproval(card.approvalId, 'approve');
  await stream.until(turnDone);

  await hos.client.sendMessage(chat.id, 'write it again');
  const events = await stream.until((es) => es.filter((e) => e.type === 'approval.requested').length === 2);

  expect(new Set(events.filter((e) => e.type === 'approval.requested').map((e) => e.approvalId)).size).toBe(2);
});

test('deciding an unknown card is refused, and a card can only be decided once', async () => {
  const { hos, stream, card } = await chatAskingToWrite();

  await expect(hos.client.decideApproval('no-such-card', 'approve')).rejects.toMatchObject({ status: 404 });
  await expect(hos.client.decideApproval(card.approvalId, 'maybe' as 'approve')).rejects.toMatchObject({ status: 400 });
  await hos.client.decideApproval(card.approvalId, 'deny');
  await stream.until(turnDone);
  await expect(hos.client.decideApproval(card.approvalId, 'approve')).rejects.toMatchObject({ status: 409 });
});
