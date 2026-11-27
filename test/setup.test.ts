import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { cleanupAll, git, startTestDaemon, tempDir, tempGitRepo } from './harness.js';

afterEach(cleanupAll);
afterEach(() => vi.unstubAllEnvs());

const STARTER_POLICY = 'version: 1  # schema version\ncomposer:  # the composer\n  paste_as_file_chars: 1000  # a long paste becomes a file\n';

function gitIdentity() {
  for (const who of ['AUTHOR', 'COMMITTER']) {
    vi.stubEnv(`GIT_${who}_NAME`, 'hos-test');
    vi.stubEnv(`GIT_${who}_EMAIL`, 'hos@test.invalid');
  }
}

async function starter(): Promise<string> {
  const repo = await tempGitRepo();
  await mkdir(join(repo, 'hos'));
  await writeFile(join(repo, 'hos', 'policy.yaml'), STARTER_POLICY);
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'starter');
  return repo;
}

async function setupDaemon() {
  const chosen: string[] = [];
  const home = await tempDir('hos-home-');
  const from = await starter();
  const hos = await startTestDaemon({ setup: { defaultBrain: join(home, 'hos-brain'), starter: from, onBrain: (path) => chosen.push(path) } });
  return { hos, home, chosen, from };
}

test('with no brain, GET /api/setup says setup is needed and gives the default path and the hos init --adopt fallback', async () => {
  const { hos, home, from } = await setupDaemon();

  const state = await hos.client.setup();

  expect(state).toMatchObject({ needed: true, defaultBrain: join(home, 'hos-brain') });
  expect(state.needed && state.commands).toEqual([`hos init --adopt ${join(home, 'hos-brain')} --starter ${from}`, `hos --brain ${join(home, 'hos-brain')}`]);
});

test('creating a brain from the starter runs the hos init --adopt steps: starter remote it cannot push to, your own repo, your name and time zone as line edits, the hos-owned skills, then one commit, and remembers the path', async () => {
  gitIdentity();
  const { hos, home, chosen } = await setupDaemon();
  const path = join(home, 'hos-brain');

  const { brain, lines } = await hos.client.createBrain({ from: 'starter', path, remote: 'git@example.com:me/brain.git', name: 'Sam', timezone: 'Europe/Berlin' });

  expect(brain).toBe(path);
  expect(git(path, 'remote', 'get-url', '--push', 'starter')).toBe('DISABLED');
  expect(git(path, 'remote', 'get-url', 'origin')).toBe('git@example.com:me/brain.git');
  const policy = await readFile(join(path, 'hos', 'policy.yaml'), 'utf8');
  expect(policy.startsWith(STARTER_POLICY)).toBe(true);
  expect(policy).toMatch(/owner: +# .*\n {2}name: Sam\n {2}timezone: Europe\/Berlin\n$/);
  expect(existsSync(join(path, '.claude', 'skills', 'hos', 'SKILL.md'))).toBe(true);
  expect(git(path, 'status', '--porcelain')).toBe('');
  expect(git(path, 'log', '-1', '--format=%s')).toBe('Make this brain mine');
  expect(lines).toContain('commit  Make this brain mine');
  expect((await readFile(join(hos.dataDir, 'brain-path'), 'utf8')).trim()).toBe(path);
  await expect.poll(() => chosen).toEqual([path]);
  await expect(hos.client.createBrain({ from: 'starter', path: join(home, 'other') })).rejects.toThrow(/already has a brain/);
});

test('setup refuses a folder that already has files, an existing folder that is not a brain, and a bad time zone, and leaves nothing behind', async () => {
  const { hos, home, chosen } = await setupDaemon();
  const full = join(home, 'full');
  await mkdir(full);
  await writeFile(join(full, 'notes.md'), 'mine\n');

  await expect(hos.client.createBrain({ from: 'starter', path: full })).rejects.toThrow(/already has files/);
  await expect(hos.client.createBrain({ from: 'existing', path: full })).rejects.toThrow(/no hos\/ folder/);
  await expect(hos.client.createBrain({ from: 'starter', path: join(home, 'b'), timezone: 'Mars/Olympus' })).rejects.toThrow(/not a time zone/);

  expect(existsSync(join(home, 'b'))).toBe(false);
  expect(existsSync(join(hos.dataDir, 'brain-path'))).toBe(false);
  expect(chosen).toEqual([]);
});

test('an existing brain is used as it is, apart from the name it is given, written as a line edit and committed', async () => {
  gitIdentity();
  const { hos, home, chosen } = await setupDaemon();
  const mine = await starter();

  await hos.client.createBrain({ from: 'existing', path: mine, name: 'Sam' });

  const policy = await readFile(join(mine, 'hos', 'policy.yaml'), 'utf8');
  expect(policy.startsWith(STARTER_POLICY)).toBe(true);
  expect(policy).toMatch(/owner: +# .*\n {2}name: Sam\n$/);
  expect(git(mine, 'status', '--porcelain')).toBe('');
  expect(git(mine, 'remote')).toBe('');
  await expect.poll(() => chosen).toEqual([mine]);
  expect(existsSync(join(home, 'hos-brain'))).toBe(false);
});

test('a fresh install names its quick-chats topic "Quick chats"; an existing "Desk" topic keeps its title through a restart, and schedules name it as it is', async () => {
  const brainDir = await tempGitRepo();
  const fresh = await startTestDaemon({ brainDir });
  const desk = (await fresh.client.listTopics()).find((topic) => topic.desk)!;
  expect(desk.title).toBe('Quick chats');
  expect((await fresh.client.schedules()).deskTitle).toBe('Quick chats');

  await fresh.client.renameTopic(desk.id, 'Desk');
  await fresh.stop();
  const again = await startTestDaemon({ brainDir, dataDir: fresh.dataDir });

  const topics = (await again.client.listTopics()).filter((topic) => topic.desk);
  expect(topics.map((topic) => [topic.id, topic.title, topic.statusTopic])).toEqual([[desk.id, 'Desk', desk.statusTopic]]);
  expect((await again.client.schedules()).deskTitle).toBe('Desk');
  await expect(again.client.setTopicState(desk.id, 'archived')).rejects.toThrow(/^Desk is permanent/);
});

test('a daemon that already has a brain says no setup is needed and refuses to create another', async () => {
  const hos = await startTestDaemon({ brainDir: await tempGitRepo() });

  expect(await hos.client.setup()).toEqual({ needed: false });
  await expect(hos.client.createBrain({ from: 'starter', path: join(await tempDir(), 'b') })).rejects.toThrow(/already has a brain/);
});
