import { basename } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { signIn } from './access.js';
import { newTopic, tempGitRepo } from './fixtures.js';
import { expect, test } from './test.js';

async function openSidebar(page: Page, phone: boolean, repo: string): Promise<Locator> {
  await signIn(page);
  if (phone) await page.getByRole('navigation', { name: 'Tabs' }).getByRole('button', { name: 'Chats' }).click();
  const section = page.getByRole('region', { name: 'Workspaces' });
  const head = section.getByRole('button', { name: 'Workspaces', exact: true });
  if ((await head.getAttribute('aria-expanded')) === 'false') await head.click();
  return section.getByRole('group', { name: basename(repo) });
}

function row(group: Locator, kind: 'Root' | 'Worktree', branch: string): Locator {
  return group.getByRole('listitem', { name: `${kind} ${branch}`, exact: true });
}

test('the sidebar lists a topic’s workspace under its repo on one line, names the topic in its tooltip, and copies its path @phone', async ({ page, context }, info) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const repo = tempGitRepo();
  const title = `wt ${basename(repo)}`;
  await newTopic({ title, repo });
  const group = await openSidebar(page, info.project.name === 'phone', repo);

  const line = row(group, 'Root', 'main');
  await expect(line).toHaveAttribute('title', `Root checkout · main\nUsed by: ${title}`);
  await expect(line).toContainText('main');
  await expect(line).not.toContainText(title);
  const box = await line.boundingBox();
  expect(box!.height).toBeLessThan(50);

  const label = `Actions for ${basename(repo)} root`;
  await line.hover();
  await line.getByRole('button', { name: label }).click();
  const menu = page.getByRole('menu', { name: label });
  await expect(menu.getByRole('menuitem')).toHaveText(['Copy path', 'Open in Code view', 'Open terminal', 'Rename']);
  await menu.getByRole('menuitem', { name: 'Copy path' }).click();
  await expect(menu).toHaveCount(0);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(repo);

  await line.click({ button: 'right' });
  await expect(page.getByRole('menu', { name: label })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
});
