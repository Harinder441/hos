import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { cleanupAll, collect, git, startTestDaemon, tempDir, tempGitRepo } from './harness.js';

afterEach(cleanupAll);
afterEach(() => vi.unstubAllEnvs());

const GUARD = '[hook "identity-guard"]\n\tevent = pre-commit\n\tcommand = /usr/bin/true\n';

async function globalConfig(text: string) {
  const file = join(await tempDir(), 'gitconfig');
  await writeFile(file, text);
  vi.stubEnv('GIT_CONFIG_GLOBAL', file);
}

async function brainAs(repoClass: string | null, email: string) {
  const brainDir = await tempGitRepo();
  if (repoClass) git(brainDir, 'config', 'hosGit.repoClass', repoClass);
  git(brainDir, 'config', 'user.email', email);
  git(brainDir, 'config', 'user.name', 'Someone');
  return brainDir;
}

async function row(brainDir: string) {
  const hos = await startTestDaemon({ brainDir });
  return { hos, row: (await hos.client.doctorChecks()).find((item) => item.id === 'commit_identity') };
}

test('with no work domain in the global git config the commit identity row is ok and never nags', async () => {
  await globalConfig('');
  const { row: found } = await row(await brainAs('personal', 'me@work.example'));
  expect(found).toMatchObject({ label: 'Commit identity', status: 'ok', detail: 'no work domain configured (optional)' });
  expect(found!.fix).toBeUndefined();
});

test('a personal repo that resolves to the work domain is down, and the row never prints the address', async () => {
  await globalConfig('[hosGit]\n\tworkDomain = work.example\n' + GUARD);
  const brainDir = await brainAs('personal', 'me@work.example');
  const { row: found } = await row(brainDir);
  expect(found).toMatchObject({ status: 'down', fix: `git -C ${brainDir} config --unset user.email, or remove the override` });
  expect(JSON.stringify(found)).not.toContain('me@work.example');
});

test('a personal repo on the noreply address warns when the guard hook is missing and is ok once it is installed', async () => {
  const brainDir = await brainAs('personal', '1+me@users.noreply.github.com');
  await globalConfig('[hosGit]\n\tworkDomain = work.example\n');
  const { hos, row: missing } = await row(brainDir);
  expect(missing).toMatchObject({ status: 'warn', detail: 'the commit identity guard is not installed, or git is too old for config hooks' });
  expect(missing!.fix).toMatch(/^git config --global hook\.identity-guard\.event pre-commit/);
  await globalConfig('[hosGit]\n\tworkDomain = work.example\n' + GUARD);
  expect((await hos.client.doctorChecks()).find((item) => item.id === 'commit_identity')).toMatchObject({ status: 'ok', detail: '1 personal repo commit as noreply, guard installed' });
});

test('a brain that carries its own installer is pointed at it in the guard fix', async () => {
  const brainDir = await brainAs('personal', '1+me@users.noreply.github.com');
  await mkdir(join(brainDir, 'global', 'install'), { recursive: true });
  await writeFile(join(brainDir, 'global', 'install', 'install.mjs'), '');
  await globalConfig('[hosGit]\n\tworkDomain = work.example\n');
  expect((await row(brainDir)).row).toMatchObject({ status: 'warn', fix: `node ${brainDir}/global/install/install.mjs --apply, or upgrade git` });
});

test('the work domain is read through an include in the global git config', async () => {
  const included = join(await tempDir(), 'identity.gitconfig');
  await writeFile(included, '[hosGit]\n\tworkDomain = work.example\n');
  await globalConfig(`[include]\n\tpath = ${included}\n` + GUARD);
  expect((await row(await brainAs('personal', 'me@work.example'))).row).toMatchObject({ status: 'down' });
});

test('a work repo on the work domain is fine', async () => {
  await globalConfig('[hosGit]\n\tworkDomain = work.example\n' + GUARD);
  expect((await row(await brainAs('work', 'me@work.example'))).row).toMatchObject({ status: 'ok' });
});

test('hos commits nothing in a personal brain that would commit with the work domain and logs why', async () => {
  await globalConfig('[hosGit]\n\tworkDomain = work.example\n');
  const brainDir = await brainAs('personal', 'me@work.example');
  const hos = await startTestDaemon({ brainDir, script: () => [{ delta: 'ok' }] });
  const stream = collect(hos.client);
  const head = git(brainDir, 'rev-parse', 'HEAD');
  await writeFile(join(brainDir, 'other.md'), 'x\n');
  const topic = await hos.client.createTopic({ title: 'Notes' });
  const chat = await hos.client.addTopicChat(topic.id);
  await hos.client.sendMessage(chat.id, 'hello');
  await stream.until((es) => es.some((e) => e.type === 'message.completed' && e.chatId === chat.id));
  const log = join(hos.dataDir, 'brain-commits.log');
  await expect.poll(() => existsSync(log) && readFileSync(log, 'utf8')).toContain('ABORT: commit identity: this personal repo would commit with the work domain');
  expect(git(brainDir, 'rev-parse', 'HEAD')).toBe(head);
  expect(stream.events.some((e) => e.type === 'brain.committed')).toBe(false);
});
