import { execFileSync } from 'node:child_process';
import { virtualAuthenticator } from './access.js';
import { api, tempGitRepo } from './fixtures.js';
import { expect, test } from './test.js';

test('a PR link opened in a browser with no hos session asks for the passkey, then lands on the PR in Code view', async ({ page }) => {
  const repo = tempGitRepo();
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/e2e-shop.git'], { cwd: repo });
  const client = await api();
  const workspace = await client.createWorkspace({ projectId: (await client.createProject(repo)).id, kind: 'root' });
  const topic = await client.createTopic({ title: 'PR link from a ship report', workspaceId: workspace.id });
  await (await virtualAuthenticator(page)).addSharedPasskey();

  await page.goto(`/hos-code/pr?url=${encodeURIComponent('https://github.com/acme/e2e-shop/pull/7')}&topic=${topic.id}`);
  await expect(page).toHaveURL(/\/#\/code-pr\?url=/);
  await page.getByRole('button', { name: 'Sign in with passkey' }).click();

  await page.waitForURL(/^http:\/\/(localhost|127\.0\.0\.1):\d+\/\?token=[0-9a-f]{48}$/);
  await expect(page.locator('body')).toContainText('fake hos-code');
  await client.setTopicState(topic.id, 'done');
});

test('a PR GitHub answers 404 for shows that answer on the error card, and Go to hos leaves the card for hos', async ({ page }) => {
  const client = await api();
  const topic = await client.createTopic({ title: 'PR link to a repo nobody signed in can see' });
  await (await virtualAuthenticator(page)).addSharedPasskey();

  await page.goto(`/hos-code/pr?url=${encodeURIComponent('https://github.com/acme/private-shop/pull/404')}&topic=${topic.id}`);
  await page.getByRole('button', { name: 'Sign in with passkey' }).click();

  const alert = page.getByRole('alert');
  await expect(alert).toContainText('Could not open the pull request in Code view: GitHub answered 404 for this PR', { timeout: 15_000 });
  await page.getByRole('link', { name: 'Go to hos' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(alert).toHaveCount(0);
  await client.setTopicState(topic.id, 'done');
});
