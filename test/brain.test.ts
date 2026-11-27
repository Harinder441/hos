import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { cleanupAll, collect, startTestDaemon, tempDir, tempGitRepo } from './harness.js';
import { newTopic } from './topics.js';

afterEach(cleanupAll);

async function tempBrain(): Promise<string> {
  const brain = await tempDir('hos-brain-');
  await writeFile(join(brain, 'CLAUDE.md'), '# brain rules\n');
  for (const skill of ['work-in', 'history']) {
    await mkdir(join(brain, '.claude/skills', skill), { recursive: true });
    await writeFile(join(brain, '.claude/skills', skill, 'SKILL.md'), `---\nname: ${skill}\n---\n`);
  }
  return brain;
}

test('every chat loads the daemon’s brain, and its rules and skills show in the chat’s loaded context', async () => {
  const brainDir = await tempBrain();
  const hos = await startTestDaemon({ brainDir });
  const project = await hos.client.createProject(await tempGitRepo());
  const workspace = await newTopic(hos.client, project.id, 'brain');
  const chat = await hos.client.createChat(workspace.id);

  const events = await collect(hos.client).until((es) => es.some((e) => e.type === 'context.loaded'));

  expect(events.find((e) => e.type === 'context.loaded')).toMatchObject({
    chatId: chat.id,
    memoryFiles: [join(brainDir, 'CLAUDE.md')],
    skills: ['history', 'work-in'],
  });
  expect(hos.agentRuntime.started.map((spec) => spec.brainDir)).toEqual([brainDir]);
});
