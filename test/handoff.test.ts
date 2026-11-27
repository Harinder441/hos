import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { HosEvent } from '../src/api/types.js';
import type { AgentScript } from '../src/fakes/scripted-agent-runtime.js';
import { cleanupAll, collect, git, startTestDaemon, tempDir, tempGitRepo } from './harness.js';
import { newTopic } from './topics.js';

afterEach(cleanupAll);

test('a handoff passes with a PROGRESS.md that cites no decision or question refs, and the ask names none', async () => {
  const brainDir = await tempGitRepo();
  const repo = await tempGitRepo('main', await tempDir('hos-parent-'));
  const sections = { Goal: 'Serve orders.', State: 'Route added.', Where: `- Path: \`${repo}\`\n- Branch: \`main\``, 'Next step': 'Wire the UI.' };
  const script: AgentScript = (input) =>
    input.includes('asked for a handoff')
      ? [{ bus: 'progress_update', args: { sections, note: 'route added' } }, { bus: 'handoff_ready', args: {} }, { delta: 'Handed off.' }]
      : [{ delta: 'ok' }];
  const hos = await startTestDaemon({ brainDir, script });
  const project = await hos.client.createProject(repo);
  const topic = await newTopic(hos.client, project.id, 'orders');
  const chat = await hos.client.createChat(topic.id);
  const stream = collect(hos.client);
  await hos.client.sendMessage(chat.id, 'start');
  await stream.until((es) => es.some((e) => e.type === 'message.completed' && e.chatId === chat.id));

  await hos.client.handOff(chat.id);
  const events = await stream.until((es) => es.some((e) => e.type === 'chat.created' && e.chat.predecessorId === chat.id));

  const ask = events.find((e) => e.type === 'message.user' && e.chatId === chat.id && e.from === 'hos' && e.text.includes('asked for a handoff'));
  expect(ask && 'text' in ask && ask.text).not.toMatch(/\bref\b|decision|question/);
  const file = join(brainDir, topic.workDir!, 'PROGRESS.md');
  expect(await readFile(file, 'utf8')).not.toMatch(/\b[DQ]\d+\b/);
  const calls = events.flatMap((e) => (e.type === 'bus.call' && e.chatId === chat.id ? [[e.tool, e.outcome]] : []));
  expect(calls).toEqual([
    ['progress_update', 'ok'],
    ['handoff_ready', 'ok'],
  ]);
  expect(events.find((e) => e.type === 'handoff.completed' && e.chatId === chat.id)).toMatchObject({ handoff: { path: file } });
  expect(events.some((e) => e.type === 'handoff.rejected')).toBe(false);
});

async function refreshWithBranch(branch: string): Promise<{ output: string; repo: string; brainDir: string }> {
  const brainDir = await tempGitRepo();
  const repo = await tempGitRepo('main', await tempDir('hos-parent-'));
  git(repo, 'branch', 'rate-limit');
  await mkdir(join(brainDir, 'profiles', 'lead'), { recursive: true });
  await writeFile(join(brainDir, 'profiles', 'lead', 'PROFILE.md'), '---\ndescription: leads\ncontext_refresh: true\n---\nLead.\n');
  let where = '';
  const script: AgentScript = (input) =>
    input.includes('Context refresh')
      ? [
          { bus: 'progress_update', args: { sections: { Goal: 'Rate-limit the API.', State: 'Limiter added.', Where: where, 'Next step': 'Tune the limits.' }, note: 'limiter added' } },
          { bus: 'refresh_ready', args: {} },
          { delta: 'Refreshing.' },
        ]
      : [{ delta: 'ok' }];
  const hos = await startTestDaemon({ brainDir, script });
  const project = await hos.client.createProject(repo);
  const topic = await newTopic(hos.client, project.id, 'limits');
  where = `- Path: \`${topic.workDir}\`\n- Branch: \`${branch}\``;
  const chat = await hos.client.addTopicChat(topic.id, { profile: 'lead' });
  const stream = collect(hos.client);
  await hos.client.sendMessage(chat.id, 'start');
  await stream.until((es) => es.some((e) => e.type === 'message.completed' && e.chatId === chat.id));
  await hos.clock.advance(1000);
  await hos.client.refreshContext(chat.id);
  const reply = (es: HosEvent[]) => es.find((e) => e.type === 'tool.completed' && e.chatId === chat.id && /^Refresh (accepted|rejected)/.test(e.output));
  const events = await stream.until((es) => !!reply(es));
  return { output: (reply(events) as { output: string }).output, repo, brainDir };
}

test('a refresh accepts a Where branch that lives in a workspace of the topic, though PROGRESS.md sits in the brain', async () => {
  expect((await refreshWithBranch('rate-limit')).output).toContain('Refresh accepted');
});

test('a refused Where branch names the git repo and the workspaces hos looked in', async () => {
  const { output, repo, brainDir } = await refreshWithBranch('nowhere');
  expect(output).toContain(`the branch nowhere does not exist in the git repo at ${await realpath(brainDir)} or in the topic's workspaces (`);
  expect(output).toContain(basename(repo));
});
