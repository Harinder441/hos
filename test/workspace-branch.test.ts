import { afterEach, expect, test } from 'vitest';
import type { HosEvent } from '../src/api/types.js';
import { callBus } from '../src/fakes/bus-client.js';
import type { AgentScript } from '../src/fakes/scripted-agent-runtime.js';
import { cleanupAll, collect, git, startTestDaemon, tempDir, tempGitRepo } from './harness.js';

afterEach(cleanupAll);

const briefings: string[] = [];
const script: AgentScript = (_input, _history, turn) => {
  briefings.push(turn.context ?? '');
  return [{ delta: 'ok' }];
};

async function world() {
  const hos = await startTestDaemon({ script });
  const repo = await tempGitRepo('main', await tempDir('hos-repos-'), 'shop');
  const project = await hos.client.createProject(repo);
  return { hos, repo, project };
}

const branchUpdates = (events: HosEvent[], workspaceId: string) =>
  events.flatMap((e) => (e.type === 'workspace.updated' && e.workspace.id === workspaceId ? [e.workspace] : []));

test('a root switched to another branch outside hos shows the live branch in the panel, workspace_list and the briefing', async () => {
  const { hos, repo, project } = await world();
  const root = await hos.client.createWorkspace({ projectId: project.id, kind: 'root' });
  const topic = await hos.client.createTopic({ title: 'Cart totals', workspaceId: root.id });
  const chat = await hos.client.createChat(topic.id);
  const stream = collect(hos.client);

  git(repo, 'switch', '-q', '-c', 'other');
  briefings.length = 0;
  await hos.client.sendMessage(chat.id, 'hello');
  await stream.until((es) => es.some((e) => e.type === 'message.completed' && e.chatId === chat.id), 15_000);

  expect(briefings[0]).toContain(`- shop · root · ${repo} · branch other · ready`);
  expect(branchUpdates(stream.events, root.id).at(-1)).toMatchObject({ branch: 'other', base: 'other', name: 'shop' });
  const [panel] = await hos.client.topicPanel(topic.id);
  expect(panel).toMatchObject({ branch: 'other', base: 'other', against: null });

  git(repo, 'switch', '-q', '-c', 'third');
  const listed = await callBus(hos.agentRuntime.started.filter((s) => s.chatId === chat.id).at(-1)?.bus, 'workspace_list', {});
  expect(listed.output).toContain(`${root.id.slice(0, 8)} root of shop on third (attached to your topic)`);
});

test('a worktree switched to another branch outside hos takes the new branch and name but keeps its base', async () => {
  const { hos, project } = await world();
  const worktree = await hos.client.createWorkspace({ projectId: project.id, kind: 'worktree', branch: 'feature/a', baseRef: 'main' });
  const topic = await hos.client.createTopic({ title: 'Cart totals', workspaceId: worktree.id });
  const stream = collect(hos.client);

  git(worktree.path, 'switch', '-q', '-c', 'feature/b');
  const [panel] = await hos.client.topicPanel(topic.id);

  expect(panel).toMatchObject({ branch: 'feature/b', base: 'main', path: worktree.path });
  await stream.until((es) => branchUpdates(es, worktree.id).some((w) => w.branch === 'feature/b'));
  expect(branchUpdates(stream.events, worktree.id).at(-1)).toMatchObject({ branch: 'feature/b', name: 'feature-b', base: 'main' });
});

test('a root on a detached HEAD keeps its stored branch', async () => {
  const { hos, repo, project } = await world();
  const root = await hos.client.createWorkspace({ projectId: project.id, kind: 'root' });
  const topic = await hos.client.createTopic({ title: 'Cart totals', workspaceId: root.id });
  const stream = collect(hos.client);

  git(repo, 'switch', '-q', '--detach');
  const [panel] = await hos.client.topicPanel(topic.id);

  expect(panel).toMatchObject({ branch: 'main', base: 'main' });
  expect(branchUpdates(stream.events, root.id)).toEqual([]);
});
