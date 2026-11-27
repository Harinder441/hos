import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { HosEvent, Workspace } from '../src/api/types.js';
import type { AgentScript } from '../src/fakes/scripted-agent-runtime.js';
import { cleanupAll, collect, git, startTestDaemon, tempDir, tempGitRepo } from './harness.js';

afterEach(cleanupAll);

const busScript: AgentScript = (input) => {
  const call = /^bus (\w+) \S+ (.*)$/s.exec(input);
  return call ? [{ bus: call[1]!, args: JSON.parse(call[2]!) }, { delta: 'done' }] : [{ delta: 'ok' }];
};

type Daemon = Awaited<ReturnType<typeof startTestDaemon>>;

async function world(options: { brainDir?: string } = {}) {
  const hos = await startTestDaemon({ script: busScript, ...options });
  const parent = await tempDir('hos-repos-');
  const shopRepo = await tempGitRepo('main', parent, 'shop');
  const apiRepo = await tempGitRepo('main', parent, 'api');
  const shop = await hos.client.createProject(shopRepo);
  const api = await hos.client.createProject(apiRepo);
  const root = await hos.client.createWorkspace({ projectId: shop.id, kind: 'root' });
  const topic = await hos.client.createTopic({ title: 'Cart totals', workspaceId: root.id });
  const chat = await hos.client.createChat(topic.id);
  return { hos, parent, shopRepo, apiRepo, shop, api, root, topic, chat };
}

let calls = 0;

async function call(hos: Daemon, chatId: string, tool: string, args: Record<string, unknown> = {}, onEvents?: (events: () => HosEvent[]) => Promise<void>) {
  const text = `bus ${tool} #${++calls} ${JSON.stringify(args)}`;
  const stream = collect(hos.client);
  const after = (es: HosEvent[]) => {
    const sent = es.findIndex((e) => e.type === 'message.user' && e.chatId === chatId && e.text === text);
    return sent === -1 ? [] : es.slice(sent);
  };
  await hos.client.sendMessage(chatId, text);
  if (onEvents) await onEvents(() => after(stream.events));
  await stream.until((es) => after(es).some((e) => e.type === 'chat.state' && e.chatId === chatId && e.state === 'idle'), 15_000);
  const events = after(stream.events);
  const done = events.find((e) => e.type === 'tool.completed' && e.chatId === chatId) as { output: string; isError: boolean };
  return { output: done.output, isError: done.isError, events };
}

async function decideNext(hos: Daemon, events: () => HosEvent[], decision: 'approve' | 'deny') {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const asked = events().find((e) => e.type === 'approval.requested');
    if (asked && asked.type === 'approval.requested') {
      expect(asked).toMatchObject({ outcome: 'ask_every_time' });
      await hos.client.decideApproval(asked.approvalId, decision);
      return;
    }
    if (Date.now() > deadline) throw new Error('no approval was requested');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function approveAny(hos: Daemon, events: () => HosEvent[]) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const asked = events().find((e) => e.type === 'approval.requested');
    if (asked && asked.type === 'approval.requested') return hos.client.decideApproval(asked.approvalId, 'approve');
    if (events().some((e) => e.type === 'tool.completed')) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function workspaceById(hos: Daemon, id: string): Promise<Workspace | undefined> {
  return (await hos.client.listWorkspaces({ archived: true })).find((w) => w.id === id);
}

test('workspace_list shows the topic’s workspaces and every registered workspace of its repos, with the topics using each', async () => {
  const { hos, shop, api, root, chat } = await world();
  const other = await hos.client.createWorkspace({ projectId: shop.id, kind: 'worktree', branch: 'other-work' });
  await hos.client.createTopic({ title: 'Billing', workspaceId: other.id });
  const elsewhere = await hos.client.createWorkspace({ projectId: api.id, kind: 'root' });

  const { output, isError } = await call(hos, chat.id, 'workspace_list');

  expect(isError).toBe(false);
  expect(output).toContain('can use 2 workspaces');
  expect(output).toContain(`${root.id.slice(0, 8)} root of shop on main (attached to your topic): ${root.path}; setup ready; used by "Cart totals".`);
  expect(output).toContain(`${other.id.slice(0, 8)} worktree of shop on other-work from main: ${other.path}; setup`);
  expect(output).toContain('used by "Billing"');
  expect(output).not.toContain(elsewhere.path);
});

test('workspace_create adds a worktree of a repo the topic uses, attaches it and runs setup; another repo is refused', async () => {
  const { hos, shopRepo, topic, chat } = await world();
  await writeFile(join(shopRepo, '.env'), 'A=1\n');

  const created = await call(hos, chat.id, 'workspace_create', { repo: 'shop' });
  const path = join(dirname(shopRepo), 'shop-worktrees', 'hos-cart-totals');
  expect(created.isError).toBe(false);
  expect(created.output).toContain(`on hos/cart-totals from main at ${path} and attached it to your topic`);
  const workspace = (await hos.client.listWorkspaces()).find((w) => w.path === path)!;
  expect(workspace).toMatchObject({ kind: 'worktree', branch: 'hos/cart-totals', base: 'main', createdBy: 'agent', createdByChat: chat.id });
  expect((await hos.client.listTopics()).find((t) => t.id === topic.id)!.workspaceIds).toContain(workspace.id);

  const waited = await call(hos, chat.id, 'workspace_wait', { workspace: 'hos/cart-totals' });
  expect(waited.output).toContain('is ready');
  expect(existsSync(join(path, '.env'))).toBe(true);

  const named = await call(hos, chat.id, 'workspace_create', { repo: 'shop', branch: 'feature/x', base: 'main' });
  expect(named.output).toContain('on feature/x from main');

  const refused = await call(hos, chat.id, 'workspace_create', { repo: 'api' });
  expect(refused).toMatchObject({ isError: true, output: expect.stringContaining('call workspace_choose so the user picks') });
  const unknown = await call(hos, chat.id, 'workspace_create', { repo: 'nowhere' });
  expect(unknown.output).toContain('workspace_choose');
});

test('workspace_create with a path registers a brand-new git init repo as a root workspace and attaches it; a known repo the topic doesn’t use is refused', async () => {
  const { hos, apiRepo, topic, chat } = await world();
  const fresh = join(await tempDir('hos-new-'), 'gadget');
  await mkdir(fresh);
  git(fresh, 'init', '-q', '-b', 'main');

  const made = await call(hos, chat.id, 'workspace_create', { repo: 'gadget', path: fresh });
  expect(made).toMatchObject({ isError: false, output: expect.stringContaining(`Registered gadget at ${fresh} as a root workspace`) });
  const workspace = (await hos.client.listWorkspaces()).find((w) => w.path === fresh)!;
  expect(workspace).toMatchObject({ kind: 'root', name: 'gadget', branch: 'main' });
  expect((await hos.client.listProjects()).some((p) => p.path === fresh)).toBe(true);
  expect((await hos.client.listTopics()).find((t) => t.id === topic.id)!.workspaceIds).toContain(workspace.id);

  const known = await call(hos, chat.id, 'workspace_create', { repo: 'api', path: apiRepo });
  expect(known.output).toContain('workspace_choose');
  const notRepo = await call(hos, chat.id, 'workspace_create', { repo: 'x', path: await tempDir('hos-plain-') });
  expect(notRepo.output).toContain('git init');
});

test('root workspaces are never archived or deleted, over the bus or HTTP', async () => {
  const { hos, root, chat } = await world();

  expect((await call(hos, chat.id, 'workspace_archive', { workspace: 'shop' })).output).toContain('root workspaces are never archived');
  expect((await call(hos, chat.id, 'workspace_delete', { workspace: root.id })).output).toContain('root workspaces are never deleted');
  await expect(hos.client.archiveWorkspace(root.id)).rejects.toMatchObject({ status: 400 });
  await expect(hos.client.deleteWorkspace(root.id)).rejects.toMatchObject({ status: 400 });
  expect(await workspaceById(hos, root.id)).toMatchObject({ archivedAt: null });
  expect(existsSync(root.path)).toBe(true);
});

test('archiving a clean worktree removes its folder, keeps its branch and record, and detaches it from every topic', async () => {
  const { hos, shop, shopRepo, topic, chat } = await world();
  const worktree = await hos.client.createWorkspace({ projectId: shop.id, kind: 'worktree', branch: 'clean-one' });
  await hos.client.attachWorkspace(topic.id, worktree.id);
  const other = await hos.client.createTopic({ title: 'Other', workspaceId: worktree.id });

  const { output, events } = await call(hos, chat.id, 'workspace_archive', { workspace: 'clean-one' });

  expect(output).toContain(`Archived clean-one: removed ${worktree.path}, kept branch clean-one`);
  expect(existsSync(worktree.path)).toBe(false);
  expect(git(shopRepo, 'branch', '--list', 'clean-one')).toContain('clean-one');
  expect(await workspaceById(hos, worktree.id)).toMatchObject({ archivedAt: expect.any(Number) });
  expect((await hos.client.listWorkspaces()).some((w) => w.id === worktree.id)).toBe(false);
  const topics = await hos.client.listTopics();
  expect(topics.find((t) => t.id === topic.id)!.workspaceIds).not.toContain(worktree.id);
  expect(topics.find((t) => t.id === other.id)!.workspaceIds).toEqual([]);
  expect(events.some((e) => e.type === 'approval.requested')).toBe(false);
});

test('archiving a worktree with uncommitted or unpushed work waits for the user’s approval over the bus, and needs force over HTTP', async () => {
  const { hos, shop, topic, chat } = await world();
  const dirty = await hos.client.createWorkspace({ projectId: shop.id, kind: 'worktree', branch: 'dirty-one' });
  await hos.client.attachWorkspace(topic.id, dirty.id);
  await writeFile(join(dirty.path, 'wip.txt'), 'wip\n');

  const denied = await call(hos, chat.id, 'workspace_archive', { workspace: 'dirty-one' }, (es) => decideNext(hos, es, 'deny'));
  expect(denied.output).toContain('The user said no to archiving dirty-one, which has uncommitted changes');
  expect(existsSync(dirty.path)).toBe(true);

  const approved = await call(hos, chat.id, 'workspace_archive', { workspace: 'dirty-one' }, (es) => decideNext(hos, es, 'approve'));
  expect(approved.output).toContain('Archived dirty-one');
  expect(existsSync(dirty.path)).toBe(false);

  const unpushed = await hos.client.createWorkspace({ projectId: shop.id, kind: 'worktree', branch: 'unpushed-one' });
  await writeFile(join(unpushed.path, 'done.txt'), 'done\n');
  git(unpushed.path, 'add', '.');
  git(unpushed.path, 'commit', '-q', '-m', 'local only');
  await expect(hos.client.archiveWorkspace(unpushed.id)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('1 unpushed commit') });
  await expect(hos.client.archiveWorkspace(unpushed.id, { force: true })).resolves.toMatchObject({ archivedAt: expect.any(Number) });
  expect(existsSync(unpushed.path)).toBe(false);
});

test('removing from a topic: a root only detaches, a worktree only this topic uses is archived (force when dirty), a shared one is refused', async () => {
  const { hos, shop, shopRepo, root, topic } = await world();
  const other = await hos.client.createTopic({ title: 'Billing', workspaceId: root.id });
  const shared = await hos.client.createWorkspace({ projectId: shop.id, kind: 'worktree', branch: 'shared-one' });
  const mine = await hos.client.createWorkspace({ projectId: shop.id, kind: 'worktree', branch: 'mine-one' });
  await hos.client.attachWorkspace(topic.id, shared.id);
  await hos.client.attachWorkspace(other.id, shared.id);
  await hos.client.attachWorkspace(topic.id, mine.id);
  await writeFile(join(mine.path, 'wip.txt'), 'wip\n');

  await expect(hos.client.removeTopicWorkspace(topic.id, shared.id)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('also used by Billing') });
  expect(existsSync(shared.path)).toBe(true);

  await expect(hos.client.removeTopicWorkspace(topic.id, mine.id)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('uncommitted changes') });
  expect(existsSync(mine.path)).toBe(true);
  await hos.client.removeTopicWorkspace(topic.id, mine.id, { force: true });
  expect(existsSync(mine.path)).toBe(false);
  expect(git(shopRepo, 'branch', '--list', 'mine-one')).toContain('mine-one');

  const updated = await hos.client.removeTopicWorkspace(topic.id, root.id);
  expect(updated.workspaceIds).toEqual([shared.id]);
  expect(existsSync(root.path)).toBe(true);
  expect((await hos.client.listTopics()).find((t) => t.id === other.id)!.workspaceIds).toEqual([root.id, shared.id]);
  await expect(hos.client.removeTopicWorkspace(topic.id, root.id)).rejects.toMatchObject({ status: 400 });
});

test('deleting a worktree always asks the user, then removes its folder, branch and record', async () => {
  const { hos, shop, shopRepo, topic, chat } = await world();
  const worktree = await hos.client.createWorkspace({ projectId: shop.id, kind: 'worktree', branch: 'doomed' });
  await hos.client.attachWorkspace(topic.id, worktree.id);

  const denied = await call(hos, chat.id, 'workspace_delete', { workspace: 'doomed' }, (es) => decideNext(hos, es, 'deny'));
  expect(denied.output).toContain('The user said no to deleting doomed');
  expect(existsSync(worktree.path)).toBe(true);

  const { output, events } = await call(hos, chat.id, 'workspace_delete', { workspace: 'doomed' }, (es) => decideNext(hos, es, 'approve'));
  expect(output).toContain('Deleted doomed');
  expect(existsSync(worktree.path)).toBe(false);
  expect(git(shopRepo, 'branch', '--list', 'doomed')).toBe('');
  expect(await workspaceById(hos, worktree.id)).toBeUndefined();
  expect(events.some((e) => e.type === 'workspace.deleted' && e.workspaceId === worktree.id)).toBe(true);
  expect((await hos.client.listTopics()).find((t) => t.id === topic.id)!.workspaceIds).not.toContain(worktree.id);

  const overHttp = await hos.client.createWorkspace({ projectId: shop.id, kind: 'worktree', branch: 'by-menu' });
  await writeFile(join(overHttp.path, 'wip.txt'), 'wip\n');
  await expect(hos.client.deleteWorkspace(overHttp.id)).resolves.toEqual({ deleted: overHttp.id });
  expect(existsSync(overHttp.path)).toBe(false);
  expect(git(shopRepo, 'branch', '--list', 'by-menu')).toBe('');
});

test('rename renames the branch and moves a worktree’s folder to match; a dirty worktree is refused', async () => {
  const { hos, shop, shopRepo, root, topic, chat } = await world();
  const worktree = await hos.client.createWorkspace({ projectId: shop.id, kind: 'worktree', branch: 'old-name' });
  await hos.client.attachWorkspace(topic.id, worktree.id);
  const moved = join(dirname(shopRepo), 'shop-worktrees', 'new-name');

  const { output } = await call(hos, chat.id, 'workspace_rename', { workspace: 'old-name', branch: 'new-name' });

  expect(output).toBe(`Renamed the branch to new-name and moved the folder to ${moved}.`);
  expect(existsSync(worktree.path)).toBe(false);
  expect(git(moved, 'branch', '--show-current')).toBe('new-name');
  expect(await workspaceById(hos, worktree.id)).toMatchObject({ branch: 'new-name', name: 'new-name', path: moved });
  expect((await hos.client.listProjects()).find((p) => p.id === shop.id)!.worktrees.map((w) => w.path)).toContain(moved);

  await writeFile(join(moved, 'wip.txt'), 'wip\n');
  expect((await call(hos, chat.id, 'workspace_rename', { workspace: 'new-name', branch: 'third' })).output).toContain('uncommitted changes');
  await expect(hos.client.renameWorkspace(worktree.id, 'third')).rejects.toMatchObject({ status: 409 });

  await expect(hos.client.renameWorkspace(root.id, 'trunk')).resolves.toMatchObject({ branch: 'trunk', base: 'trunk', path: shopRepo });
  expect(git(shopRepo, 'branch', '--show-current')).toBe('trunk');
});

test('workspace_path answers the absolute path, by id, branch or repo name, and an ambiguous name is refused', async () => {
  const { hos, shop, root, topic, chat } = await world();
  const one = await hos.client.createWorkspace({ projectId: shop.id, kind: 'worktree', branch: 'one' });
  const two = await hos.client.createWorkspace({ projectId: shop.id, kind: 'worktree', branch: 'two' });
  await hos.client.attachWorkspace(topic.id, one.id);
  await hos.client.attachWorkspace(topic.id, two.id);

  expect((await call(hos, chat.id, 'workspace_path', { workspace: one.id.slice(0, 8) })).output).toBe(one.path);
  expect((await call(hos, chat.id, 'workspace_path', { workspace: 'two' })).output).toBe(two.path);
  const ambiguous = await call(hos, chat.id, 'workspace_path', { workspace: 'shop' });
  expect(ambiguous).toMatchObject({ isError: true, output: expect.stringContaining('matches 3 workspaces') });
  expect((await call(hos, chat.id, 'workspace_path', { workspace: 'nope' })).output).toContain('workspace_list');
  expect(root.path).toBe(shop.path);
});

test('workspace_wait returns once setup ends', async () => {
  const brain = await tempGitRepo('main', await tempDir('hos-brain-'), 'my-brain');
  await mkdir(join(brain, 'hos'));
  await writeFile(join(brain, 'hos', 'actions.yaml'), 'version: 1\nsetup:\n  run: while [ ! -f go ]; do sleep 0.05; done; echo finished\n  skip: [shop]\n');
  const { hos, api, topic, chat } = await world({ brainDir: brain });
  const apiRoot = await hos.client.createWorkspace({ projectId: api.id, kind: 'root' });
  await hos.client.attachWorkspace(topic.id, apiRoot.id);
  await writeFile(join(apiRoot.path, 'go'), '');
  await call(hos, chat.id, 'workspace_wait', { workspace: apiRoot.id });
  const worktree = await hos.client.createWorkspace({ projectId: api.id, kind: 'worktree', branch: 'slow-setup' });
  expect(worktree.setup).toBe('pending');

  let finished = false;
  const waiting = call(hos, chat.id, 'workspace_wait', { workspace: 'slow-setup' }).then((result) => {
    finished = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(finished).toBe(false);
  await writeFile(join(worktree.path, 'go'), '');

  expect((await waiting).output).toBe(`Setup of slow-setup is ready; work in ${worktree.path}.`);
});

test('workspace_terminal and workspace_server start a terminal and a dev server in the workspace folder', async () => {
  const { hos, shop, topic, chat } = await world();
  const worktree = await hos.client.createWorkspace({ projectId: shop.id, kind: 'worktree', branch: 'serve-me' });
  await hos.client.attachWorkspace(topic.id, worktree.id);

  const terminal = await call(hos, chat.id, 'workspace_terminal', { workspace: 'serve-me' });
  const name = /Started terminal (\S+) in/.exec(terminal.output)![1]!;
  expect(name).toMatch(/-t1$/);
  expect((await hos.client.listTerminals(chat.topicId)).map((t) => t.name)).toEqual([name]);
  expect((await hos.client.listTerminals()).find((t) => t.name === name)).toMatchObject({ cwd: worktree.path });

  const { name: fromMenu } = await hos.client.openWorkspaceTerminal(worktree.id);
  expect(fromMenu).toBe('serve-me-shell');

  const port = (await hos.client.listProjects()).find((p) => p.id === shop.id)!.worktrees.find((w) => w.path === worktree.path)!.port;
  const server = await call(hos, chat.id, 'workspace_server', { workspace: 'serve-me', app: 'web', command: 'sleep 60' }, (es) => approveAny(hos, es));
  expect(server.output).toContain(`Started serve-me-web-${port}`);
  expect(server.output).toContain(`in ${worktree.path} with PORT=${port}. Preview:`);
  const listed = (await hos.client.listServers()).servers.find((s) => s.name === `serve-me-web-${port}`);
  expect(listed).toMatchObject({ cwd: worktree.path });
  expect(basename(worktree.path)).toBe('serve-me');
});
