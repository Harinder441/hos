import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import type { HosClient } from '../src/api/client.js';
import type { HosEvent } from '../src/api/types.js';
import { collect, tempGitRepo } from './harness.js';
import { newTopic } from './topics.js';

export interface ContractDaemon {
  client: HosClient;
  dataDir: string;
  stop(): Promise<void>;
}

export const CONTRACT_PROMPTS = {
  write: 'Use the Write tool to create a file at PATH containing exactly: hi. Do not use any other tool. If the Write is denied, reply with the single word DENIED and stop.',
  retry: 'Try the same Write once more now.',
  recall: 'Which file did you create earlier in this conversation? Answer with the filename only.',
};

// Every chat now runs in the brain (ADR 0009), so the prompt names the workspace file by absolute path.
export function contractPrompts(file: string): typeof CONTRACT_PROMPTS {
  return { ...CONTRACT_PROMPTS, write: CONTRACT_PROMPTS.write.replace('PATH', file) };
}

const TOKENS: Record<string, string> = {
  'context.loaded': 'C',
  'message.user': 'u',
  'message.delta': 'd',
  'message.completed': 'm',
  'tool.started': 't',
  'tool.completed': 'k',
  'approval.requested': 'a',
  'approval.resolved': 'v',
  'chat.error': 'e',
  'context.usage': 'x',
};

export function eventGrammar(events: HosEvent[], chatId: string): string {
  return events
    .filter((e) => 'chatId' in e && e.chatId === chatId)
    .map((e) => (e.type === 'chat.state' ? ({ idle: 'i', running: 'r', starting: 's', failed: 'f', terminal: 'T' } as Record<string, string>)[e.state] : TOKENS[e.type]))
    .join('');
}

// An ACP agent may send its skill list after a turn starts, so a chat may announce context again right after it goes running.
export const NORMALIZED_CHAT = /^C?i(?:C?urC?(?:d*m|(?:tav|atv|t)k)*xi)*$/;

export async function runContractScenario(
  start: (dataDir?: string) => Promise<ContractDaemon>,
  timeoutMs: number,
  agent?: string,
): Promise<{ events: HosEvent[]; chatId: string }> {
  const first = await start();
  const repo = await tempGitRepo();
  const project = await first.client.createProject(repo);
  const workspace = await newTopic(first.client, project.id, 'contract');
  const chat = await first.client.createChat(workspace.id, agent ? { agent } : {});
  const file = join(repo, 'hello.txt');
  const prompts = contractPrompts(file);
  const stream = collect(first.client);
  const idleTurns = (n: number) => (es: HosEvent[]) =>
    es.filter((e) => e.type === 'chat.state' && e.chatId === chat.id && e.state === 'idle').length === n + 1;
  const decideNext = async (index: number, decision: 'approve' | 'deny') => {
    const events = await stream.until((es) => es.filter((e) => e.type === 'approval.requested').length > index, timeoutMs);
    const card = events.filter((e) => e.type === 'approval.requested')[index]!;
    await first.client.decideApproval(card.approvalId, decision);
  };

  await first.client.sendMessage(chat.id, prompts.write);
  await decideNext(0, 'deny');
  await stream.until(idleTurns(1), timeoutMs);
  expect(existsSync(file)).toBe(false);

  await first.client.sendMessage(chat.id, prompts.retry);
  await decideNext(1, 'approve');
  await stream.until(idleTurns(2), timeoutMs);
  expect(existsSync(file)).toBe(true);
  await first.stop();

  const second = await start(first.dataDir);
  const resumed = collect(second.client);
  await second.client.sendMessage(chat.id, prompts.recall);
  const events = await resumed.until(idleTurns(3), timeoutMs);

  const toolResults = events.filter((e) => e.type === 'tool.completed' && e.chatId === chat.id);
  expect(toolResults[0]).toMatchObject({ isError: true, output: expect.stringContaining('denied this request.') });
  expect(toolResults[1]).toMatchObject({ isError: false });
  expect(events.filter((e) => e.type === 'approval.resolved').map((e) => e.decision)).toEqual(['deny', 'approve']);
  const replies = events.filter((e) => e.type === 'message.completed' && e.chatId === chat.id);
  expect(replies.at(-1)).toMatchObject({ text: expect.stringContaining('hello.txt') });
  expect(eventGrammar(events, chat.id)).toMatch(NORMALIZED_CHAT);

  const transcript = await second.client.getTranscript(chat.id);
  expect(transcript.filter((entry) => entry.kind === 'user').map((entry) => entry.text)).toEqual(
    expect.arrayContaining(Object.values(prompts)),
  );
  await second.stop();
  return { events, chatId: chat.id };
}
