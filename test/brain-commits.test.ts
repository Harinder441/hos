import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import type { HosEvent } from '../src/api/types.js';
import { cleanupAll, collect, git, startTestDaemon, tempGitRepo } from './harness.js';

afterEach(cleanupAll);

const POLICY = fileURLToPath(new URL('./fixtures/policy.yaml', import.meta.url));

const fakeToken = () => ['gh', 'p_', 'Q'.repeat(36)].join('');
const committedBy = (chatId: string | null, file: string) => (es: HosEvent[]) => es.some((e) => e.type === 'brain.committed' && e.chatId === chatId && e.files.includes(file));

test('a file with secret-like content is left out of the brain commit, the rest commits, and it is surfaced once', async () => {
  const brainDir = await tempGitRepo('main');
  const token = fakeToken();
  const leak = join(brainDir, 'notes/leak.md');
  const fine = join(brainDir, 'notes/fine.md');
  const inHead = (path: string) => git(brainDir, 'ls-tree', '-r', '--name-only', 'HEAD', '--', path);
  const contexts: string[] = [];
  const hos = await startTestDaemon({
    brainDir,
    policyFile: POLICY,
    script: (_input, _history, turn) => {
      contexts.push(turn.context ?? '');
      return contexts.length === 1
        ? [
            { tool: 'Write', input: { file_path: leak, content: `key ${token}\n` }, output: 'ok', writes: { path: leak, content: `key ${token}\n` } },
            { tool: 'Write', input: { file_path: fine, content: 'fine\n' }, output: 'ok', writes: { path: fine, content: 'fine\n' } },
            { delta: 'wrote' },
          ]
        : [{ delta: 'ok' }];
    },
  });
  const stream = collect(hos.client);
  const topic = await hos.client.createTopic({ title: 'Notes' });
  const chat = await hos.client.addTopicChat(topic.id);

  await hos.client.sendMessage(chat.id, 'write both');
  const log = join(hos.dataDir, 'brain-commits.log');
  await expect.poll(() => existsSync(log) && readFileSync(log, 'utf8')).toMatch(/notes\/leak\.md/);
  await expect.poll(() => inHead('notes/fine.md')).toBe('notes/fine.md');
  expect(inHead('notes/leak.md')).toBe('');
  expect(existsSync(leak)).toBe(true);
  await stream.until(committedBy(chat.id, 'notes/fine.md'));
  expect(readFileSync(log, 'utf8')).toMatch(/left out notes\/leak\.md: .*github-token/);

  await writeFile(join(brainDir, 'other.md'), 'x\n');
  await hos.client.sendMessage(chat.id, 'again');
  await stream.until(committedBy(null, 'other.md'));
  await hos.client.sendMessage(chat.id, 'once more');
  await stream.until((es) => es.filter((e) => e.type === 'message.completed' && e.chatId === chat.id).length === 3);

  const alerts = (await hos.client.listInbox()).filter((item) => `${item.title} ${item.detail}`.includes('notes/leak.md'));
  expect(alerts).toHaveLength(1);
  expect(alerts[0]!.detail).toContain('github-token');
  expect(contexts.slice(1).join('\n')).toMatch(/hos brain commit: .*notes\/leak\.md/);
  expect(readFileSync(log, 'utf8') + JSON.stringify(alerts) + contexts.join('\n')).not.toContain(token);

  const row = (await hos.client.doctorChecks()).find((item) => item.id === 'brain_commits');
  expect(row).toMatchObject({ status: 'warn' });
  expect(row!.detail).toContain('notes/leak.md');

  await writeFile(leak, 'redacted\n');
  await hos.client.sendMessage(chat.id, 'redacted');
  await stream.until(committedBy(null, 'notes/leak.md'));
  expect((await hos.client.doctorChecks()).some((item) => item.id === 'brain_commits')).toBe(false);
});
