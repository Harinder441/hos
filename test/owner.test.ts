import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { callBus } from '../src/fakes/bus-client.js';
import { cleanupAll, collect, startTestDaemon, tempDir, tempGitRepo } from './harness.js';

afterEach(cleanupAll);

async function policy(text: string) {
  const file = join(await tempDir(), 'policy.yaml');
  await writeFile(file, `version: 1\n${text}`);
  return file;
}

async function askReply(hos: Awaited<ReturnType<typeof startTestDaemon>>) {
  const topic = await hos.client.createTopic({ title: 'Owner' });
  const chat = await hos.client.addTopicChat(topic.id);
  await hos.client.sendMessage(chat.id, 'hello');
  await collect(hos.client).until((es) => es.some((e) => e.type === 'message.completed' && e.chatId === chat.id));
  const bus = hos.agentRuntime.started.filter((spec) => spec.chatId === chat.id).at(-1)?.bus;
  return (await callBus(bus, 'ask', { question: 'Which one?', options: ['a', 'b'], recommendation: 'a, it is simpler' })).output;
}

test('with no owner settings hos has no name, uses the system time zone and calls the owner "the user" in agent texts', async () => {
  const hos = await startTestDaemon({ brainDir: await tempGitRepo(), script: () => [{ delta: 'ok' }] });
  const owner = await hos.client.owner();
  expect(owner).toMatchObject({ name: null, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  expect(owner.timezoneLabel).toMatch(/^\S+$/);
  expect(await askReply(hos)).toContain("your question is in the user's Inbox");
});

test('owner.name, owner.timezone and owner.timezone_label from policy.yaml reach the API and the agent texts', async () => {
  const policyFile = await policy('owner:\n  name: Ada\n  timezone: America/New_York\n  timezone_label: ET\n');
  const hos = await startTestDaemon({ brainDir: await tempGitRepo(), policyFile, script: () => [{ delta: 'ok' }] });
  expect(await hos.client.owner()).toEqual({ name: 'Ada', timezone: 'America/New_York', timezoneLabel: 'ET' });
  expect(await askReply(hos)).toContain("your question is in Ada's Inbox");
});

test('without a label the time zone shows its short name', async () => {
  const policyFile = await policy('owner:\n  timezone: Asia/Tokyo\n');
  const hos = await startTestDaemon({ policyFile });
  expect(await hos.client.owner()).toEqual({ name: null, timezone: 'Asia/Tokyo', timezoneLabel: 'GMT+9' });
});

test('an unknown time zone stops the daemon with a message that names the key', async () => {
  const policyFile = await policy('owner:\n  timezone: Mars/Olympus\n');
  await expect(startTestDaemon({ policyFile })).rejects.toThrow('owner.timezone must be an IANA zone');
});
