import type { Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expectShell, signIn, virtualAuthenticator } from './access.js';
import { api, newTopic, tempGitRepo } from './fixtures.js';
import { expect, test } from './test.js';

test.beforeEach(({}, info) => test.skip(info.project.name !== 'phone', 'phone layout only'));

async function openOnPhone(page: Page) {
  await (await virtualAuthenticator(page)).addSharedPasskey();
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in with passkey' }).tap();
  await expectShell(page);
  return page.getByRole('navigation', { name: 'Tabs' });
}

async function targetsAreLarge(page: Page, scope: string) {
  const small = await page.locator(scope).evaluate((root) =>
    [...root.querySelectorAll<HTMLElement>('a[href], button')]
      .filter((el) => el.offsetParent !== null)
      .map((el) => ({ name: el.getAttribute('aria-label') ?? el.textContent?.trim(), ...(el.closest('.sidebar-topic') ?? el).getBoundingClientRect().toJSON() }))
      .filter((r) => r.height < 44),
  );
  expect(small).toEqual([]);
}

test('the phone opens on Home with Home, Chats and More tabs; Chats opens the drawer, More lists the pages; an approval and a tapped diff line work @phone', async ({ page }) => {
  const repo = tempGitRepo();
  writeFileSync(join(repo, 'notes.txt'), 'draft\n');
  execFileSync('git', ['add', 'notes.txt'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=hos-e2e', '-c', 'user.email=hos@test.invalid', 'commit', '-q', '-m', 'notes'], { cwd: repo });
  const name = `phone-${Date.now()}`;
  const label = `${name} · Chat 1`;
  const { chatId } = await newTopic({ title: name, repo });
  const tabs = await openOnPhone(page);

  await expect(tabs.getByRole('link').or(tabs.getByRole('button')).filter({ hasNotText: 'Needs you' })).toHaveText(['Home', 'Chats', 'More']);
  await expect(tabs.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('complementary', { name: 'hos navigation' })).toBeHidden();
  await targetsAreLarge(page, 'nav.bottom-tabs');

  await tabs.getByRole('button', { name: 'Chats' }).tap();
  const drawer = page.getByRole('complementary', { name: 'hos navigation' });
  await expect(drawer.getByRole('region', { name: 'Topics' })).toBeVisible();
  await expect(drawer.getByRole('region', { name: 'Workspaces' })).toBeVisible();
  await targetsAreLarge(page, 'aside.side');
  await drawer.getByRole('button', { name: 'Close navigation' }).tap();
  await expect(drawer).toBeHidden();

  await tabs.getByRole('button', { name: 'More' }).tap();
  const palette = page.getByRole('dialog', { name: 'Search and commands' });
  await expect(palette.getByRole('option', { name: 'Ops: servers' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(palette).toHaveCount(0);

  await tabs.getByRole('button', { name: 'Chats' }).tap();
  await drawer.getByRole('link', { name }).tap();
  await expect(drawer).toBeHidden();
  await expect(tabs.getByRole('button', { name: 'Chats' })).toHaveAttribute('aria-current', 'page');
  const main = page.getByRole('main');
  await main.getByLabel('Message').fill('write notes.txt');
  await main.getByRole('button', { name: 'Send' }).tap();
  const approval = main.getByRole('group', { name: 'Permission request: Write' });
  await approval.getByRole('button', { name: 'Approve once' }).tap();
  await expect(main.getByText('Echo: write notes.txt', { exact: true })).toBeVisible();
  expect(existsSync(join(repo, 'notes.txt'))).toBe(true);

  await page.goto(`/#/diff/chat/${chatId}`);
  const diff = page.getByRole('region', { name: 'Diff' });
  const file = diff.getByRole('article', { name: 'Changes to notes.txt' });
  await expect(file.locator('pre[data-diff-type="single"]')).toHaveCount(1);
  await file.locator('[data-line="1"][data-line-type="change-addition"]').first().tap();
  await diff.getByLabel('Comment on notes.txt line 1').fill('Shorter, please');
  await diff.getByRole('button', { name: 'Add comment' }).tap();
  await diff.getByRole('button', { name: 'Send comments' }).tap();
  await diff.getByRole('link', { name: `Sent to ${label}` }).tap();
  await expect(main.getByText('- notes.txt line 1: Shorter, please')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('a crowded new-chat bar wraps on the phone, so Quick and Send stay on screen @phone', async ({ page }) => {
  const profile = join(process.env.HOS_E2E_BRAIN!, 'profiles', 'crowded-phone');
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, 'PROFILE.md'), '---\ndescription: fills the bar\nwrite_scope: work_dir\n---\nLead.\n');
  try {
    const view = await (await api()).computers();
    const caps = { name: 'stub-server', apiVersion: view.self.apiVersion, hosVersion: 'x', scheduleHost: 'stub-server', harnesses: [{ id: 'scripted', label: 'Claude', models: { default: 'claude-opus-5-5', effort: 'high', list: [] }, loggedIn: true }], browser: true, slots: { claude: { running: 0, max: 3 } }, projects: [] };
    const computer = { name: 'stub-server', direction: 'out', url: 'http://stub', addedAt: 0, lastSeen: Date.now(), online: true, error: null, hosVersion: 'x', apiVersion: view.self.apiVersion, needsUpdate: false, caps, topics: [], schedules: [] };
    await page.route('**/api/computers', (route) => route.fulfill({ json: { ...view, computers: [computer] } }));
    await signIn(page);
    await page.goto('/#/new');
    const form = page.getByRole('form', { name: 'New chat' });
    await expect(form.getByRole('button', { name: /^Computer: / })).toBeVisible();
    await expect(form.getByRole('button', { name: /^Profile: / })).toBeVisible();
    await form.getByLabel('Prompt for the new topic').fill('crowded');
    await form.getByRole('button', { name: 'Quick' }).click({ trial: true, timeout: 5000 });
    await form.getByRole('button', { name: 'Send and start the topic' }).click({ trial: true, timeout: 5000 });
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});
