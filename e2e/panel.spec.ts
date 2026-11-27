import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { signIn } from './access.js';
import { api, topicHash } from './fixtures.js';
import { expect, test } from './test.js';

function repoWithScripts(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hos-e2e-repo-')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), '# e2e\n');
  mkdirSync(join(dir, '.hos'));
  writeFileSync(
    join(dir, '.hos', 'actions.yaml'),
    [
      'version: 1',
      'actions:',
      '  - { name: run-tests, run: echo tests pass, where: host, cwd: worktree, confirm: false, passkey: false, label: Run tests }',
      '  - { name: elsewhere, run: echo nope, where: host, cwd: worktree, confirm: false, passkey: false, applies_to: [another-repo] }',
      '',
    ].join('\n'),
  );
  git('add', '.');
  git('-c', 'user.name=hos-e2e', '-c', 'user.email=hos@test.invalid', 'commit', '-q', '-m', 'init');
  return dir;
}

async function worktreeTopic(title: string, branch: string) {
  const repo = repoWithScripts();
  const client = await api();
  const project = await client.createProject(repo);
  const worktree = await client.createWorktree(project.id, { branch, baseRef: 'main' });
  const workspace = await client.createWorkspace({ projectId: project.id, kind: 'worktree', path: worktree.path });
  const topic = await client.createTopic({ title, workspaceId: workspace.id });
  await client.createChat(topic.id);
  return { client, repo: basename(repo), path: worktree.path, topicId: topic.id, workspaceId: workspace.id };
}

async function openApproval(client: Awaited<ReturnType<typeof api>>, workspaceId: string): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const item = (await client.listInbox()).find((candidate) => candidate.kind === 'approval' && candidate.workspaceId === workspaceId);
    if (item) return item.id;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`no approval waiting for workspace ${workspaceId}`);
}

test('the panel shows the changed files, the files this topic touched and the Actions the git state calls for @phone', async ({ page }, info) => {
  // Three chat turns, git in a real worktree and a commit approval: longer than a default test on a loaded Mac.
  test.slow();
  const name = `panel-${info.project.name}`;
  const { client, repo, path, topicId, workspaceId } = await worktreeTopic(name, name);
  writeFileSync(join(path, 'extra.css'), 'body { color: red; }\n');
  await signIn(page);
  await page.goto(topicHash(topicId));

  const phone = info.project.name === 'phone';
  const panel = page.getByRole('complementary', { name: 'Workspaces panel' });
  // The first panel fetch runs git in the worktree, which is slow while the rest of the suite runs.
  const toggle = page.getByRole('button', { name: 'Toggle the workspaces panel' });
  await expect(toggle).toBeVisible({ timeout: 30_000 });
  // On a phone the panel is a bottom sheet over the chat, so it is opened and closed around each message.
  const openSheet = async () => {
    if (phone) await toggle.click();
  };
  const closeSheet = async () => {
    if (phone) await panel.getByRole('button', { name: 'Close workspaces' }).click();
  };
  if (phone) await expect(panel).toBeHidden();
  await openSheet();
  const block = panel.getByRole('region', { name: `${repo}, ${name}` });
  await expect(block.getByText('worktree')).toBeVisible();
  await expect(block.getByText(`${name} from main`)).toBeVisible();

  const actions = block.getByRole('group', { name: 'Actions' });
  await expect(actions.getByRole('button', { name: 'Commit' })).toBeVisible();
  await expect(actions.getByRole('button', { name: 'Review' })).toBeVisible();
  await expect(actions.getByRole('button', { name: 'Open terminal' })).toBeVisible();
  await expect(actions.getByRole('button', { name: 'Run tests' })).toHaveCount(0);
  await expect(actions.getByRole('button', { name: 'Push' })).toHaveCount(0);
  await expect(actions.getByRole('button', { name: 'Open PR' })).toHaveCount(0);
  await expect(actions.getByRole('button', { name: 'elsewhere' })).toHaveCount(0);
  await expect(block.getByText('Changed vs main')).toBeVisible();
  const sync = block.getByRole('button', { name: `Fetch origin for ${repo}` });
  const [fetched] = await Promise.all([page.waitForRequest((r) => r.url().endsWith(`/api/workspaces/${workspaceId}/fetch`) && r.method() === 'POST'), sync.click()]);
  expect(fetched).toBeTruthy();
  await expect(sync).toBeEnabled();
  await expect(block.getByLabel('Total lines changed')).toHaveText('+1 −0');
  await expect(block.getByLabel('Git state')).toHaveText('1 change');
  await expect(block.getByRole('button', { name: 'Open extra.css in Code view' })).toBeVisible();
  await expect(block.locator('.panel-touched')).toHaveCount(0);

  const main = page.getByRole('main');
  const write = async (file: string) => {
    await main.getByLabel('Message').fill(`write ${file}`);
    await main.getByRole('button', { name: 'Send' }).click();
    await main.getByRole('group', { name: 'Permission request: Write' }).last().getByRole('button', { name: 'Approve once' }).click();
    await expect(main.getByText(`Echo: write ${file}`, { exact: true })).toBeVisible();
  };
  await closeSheet();
  await write('touched.txt');
  await openSheet();

  // No reload: the turn's workspace.git event is what refetches the panel.
  const touched = block.locator('.panel-touched');
  await expect(block.getByRole('button', { name: 'Open touched.txt in Code view' })).toBeVisible({ timeout: 20_000 });
  await touched.getByText('Touched by this topic').click();
  await expect(touched.getByText('touched.txt')).toBeVisible();
  await expect(touched.getByText('not in diff')).toHaveCount(0);

  await closeSheet();
  rmSync(join(path, 'touched.txt'));
  await write('second.txt');
  await openSheet();
  await expect(touched.getByRole('listitem').filter({ hasText: 'touched.txt' })).toContainText('not in diff', { timeout: 20_000 });
  await expect(touched.getByRole('listitem').filter({ hasText: 'second.txt' })).not.toContainText('not in diff', { timeout: 20_000 });
  await expect(block.getByRole('button', { name: 'Open touched.txt in Code view' })).toHaveCount(0);

  const codeView = (open: Promise<unknown>) => Promise.all([page.waitForRequest((r) => r.url().endsWith('/api/code') && r.method() === 'POST'), open]);
  const [forWorkspace] = await codeView(block.getByRole('button', { name: 'Open in Code view' }).click());
  expect(forWorkspace.postDataJSON()).toEqual({ path });
  const [forFile] = await codeView(block.getByRole('button', { name: 'Open extra.css in Code view' }).click());
  expect(forFile.postDataJSON()).toEqual({ path, file: 'extra.css' });

  await actions.getByRole('button', { name: 'Commit' }).click();
  const message = block.getByLabel('Commit message');
  await expect(message).toHaveValue(`hos: ${name}`);
  await message.fill('hos: the panel committed this');
  await block.getByRole('form', { name: 'Commit this workspace' }).getByRole('button', { name: 'Commit' }).click();
  await client.decideApproval(await openApproval(client, workspaceId), 'approve');

  await expect(actions.getByRole('button', { name: 'Push' })).toBeVisible({ timeout: 20_000 });
  await expect(actions.getByRole('button', { name: 'Commit' })).toHaveCount(0);
  await expect(block.getByLabel('Git state')).toContainText('↑1');
  await expect(block.getByText('Changed vs main')).toBeVisible();
  if (phone) {
    const box = (await panel.boundingBox())!;
    expect(Math.round(box.y + box.height)).toBe(page.viewportSize()!.height);
    expect(box.x).toBe(0);
    await panel.getByRole('button', { name: 'Close workspaces' }).click();
    await expect(panel).toBeHidden();
  }
});
