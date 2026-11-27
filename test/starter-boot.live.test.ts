import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { adoptBrain } from '../src/cli/init.js';
import { frontmatter, validateBrain } from '../src/cli/validate.js';
import { cleanupAll, collect, git, startTestDaemon, tempDir } from './harness.js';

afterEach(cleanupAll);

const starter = process.env.HOS_STARTER;
const PROFILES = ['engineer', 'generic', 'lead', 'product', 'ritual'];

test.skipIf(!starter)('the starter brain adopts, validates and boots, and a chat on each of its 5 profiles starts with that profile and answers', async () => {
  const root = await tempDir('hos-starter-boot-');
  const branch = process.env.HOS_STARTER_BRANCH;
  git(root, 'clone', '-q', '--bare', '--single-branch', '--no-tags', ...(branch ? ['--branch', branch] : []), starter!, 'starter.git');
  const brain = join(root, 'hos-brain');
  const adopted = adoptBrain({ dir: brain, starter: join(root, 'starter.git'), name: 'Test User', timezone: 'Europe/Berlin', home: brain });
  expect(adopted.ok, adopted.lines.join('\n')).toBe(true);
  git(brain, 'config', 'user.name', 'hos-test');
  git(brain, 'config', 'user.email', 'hos@test.invalid');
  git(brain, 'add', '-A');
  git(brain, 'commit', '-q', '-m', 'Make this brain mine');
  const validated = validateBrain(brain, { home: brain });
  expect(validated.ok, validated.lines.join('\n')).toBe(true);

  const hos = await startTestDaemon({ brainDir: brain, skillsHome: brain, script: (input) => [{ delta: `ok: ${input}` }] });
  expect((await hos.client.profiles()).map((p) => p.id).sort()).toEqual(PROFILES);
  expect((await hos.client.doctorChecks()).filter((c) => (c.id.startsWith('profile') || c.id.startsWith('plugin')) && c.status !== 'ok')).toEqual([]);

  const topic = await hos.client.createTopic({ title: 'starter boot' });
  const stream = collect(hos.client);
  for (const id of PROFILES) {
    const chat = await hos.client.addTopicChat(topic.id, { profile: id });
    const spec = hos.agentRuntime.started.filter((s) => s.chatId === chat.id).at(-1)!;
    const front = frontmatter(readFileSync(join(brain, 'profiles', id, 'PROFILE.md'), 'utf8')) as { skills?: string[] };
    const body = readFileSync(join(brain, 'profiles', id, 'PROFILE.md'), 'utf8').split(/^---$/m)[2]!.trim().split('\n')[0]!;
    expect(spec.profileAppend, id).toContain(body);
    expect(spec.profileAppend, id).toContain(`(profile ${id})`);
    if (front.skills) expect(spec.allowSkills, id).toEqual(expect.arrayContaining(front.skills));
    else expect(spec.allowSkills, id).toBeUndefined();
    await hos.client.sendMessage(chat.id, `hello from ${id}`);
    await stream.until((events) => events.some((e) => e.type === 'message.completed' && e.chatId === chat.id), 15_000);
  }
});
