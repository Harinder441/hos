import type { Page } from '@playwright/test';
import { signIn } from './access.js';
import { newTopic, tempGitRepo, topicHash } from './fixtures.js';
import { expect, test } from './test.js';

const phone = (info: { project: { name: string } }) => info.project.name === 'phone';

async function openNav(page: Page, info: { project: { name: string } }) {
  if (phone(info)) await page.getByRole('navigation', { name: 'Tabs' }).getByRole('button', { name: 'Chats' }).click();
  return page.getByRole('complementary', { name: 'hos navigation' });
}

async function openPalette(page: Page, info: { project: { name: string } }) {
  if (phone(info)) await page.getByRole('navigation', { name: 'Tabs' }).getByRole('button', { name: 'More' }).click();
  else await page.keyboard.press('Meta+k');
  const palette = page.getByRole('dialog', { name: 'Search and commands' });
  await expect(palette).toBeVisible();
  return palette;
}

test('the sidebar has Home, New chat, Search and commands, the Topics and Workspaces sections and a Settings gear but no Stop all chats; its links navigate @phone', async ({ page }, info) => {
  const title = `nav ${info.project.name} ${Date.now()}`;
  const { topicId } = await newTopic({ title, repo: tempGitRepo() });
  await signIn(page);

  let side = await openNav(page, info);
  const places = side.getByRole('navigation', { name: 'Places' });
  await expect(places.getByRole('link').or(places.getByRole('button'))).toHaveText([/^Home/, /^New chat/, /^Search and commands/]);
  await expect(places.getByRole('link', { name: 'Home', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(side.getByRole('region', { name: 'Topics' })).toBeVisible();
  await expect(side.getByRole('region', { name: 'Workspaces' })).toBeVisible();
  await expect(side.getByRole('region', { name: 'Workspaces' }).getByRole('button', { name: 'Workspaces', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await expect(side.getByRole('region', { name: 'Snags' })).toBeVisible();
  await expect(side.getByRole('button', { name: /Stop all chats/ })).toHaveCount(0);
  await expect(side.getByRole('link', { name: 'Settings', exact: true })).toBeVisible();

  const row = side.getByRole('list', { name: 'Topics' }).getByRole('listitem').filter({ hasText: title });
  await expect(row).toHaveCount(1);
  await expect(row.locator('.sidebar-chip, .home-chip')).toHaveCount(0);
  const markAllSeen = side.getByRole('button', { name: 'Mark all seen' });
  // Other workers' topics share this daemon and can turn the button back on at any moment, so only our own row is checked.
  if (await markAllSeen.isVisible()) await markAllSeen.click();
  await expect(row).not.toHaveClass(/\bunseen\b/);
  await row.getByRole('link', { name: title }).click();
  await expect(page).toHaveURL(new RegExp(`${topicHash(topicId)}$`));
  await expect(page.getByRole('main').getByRole('heading', { level: 1, name: title })).toBeVisible();
  side = await openNav(page, info);
  await expect(side.getByRole('link', { name: title })).toHaveAttribute('aria-current', 'page');

  await side.getByRole('link', { name: 'New chat' }).click();
  await expect(page).toHaveURL(/#\/new$/);
  await expect(page.getByRole('main').getByRole('heading', { name: 'What should the brain work on?' })).toBeVisible();
  side = await openNav(page, info);
  await side.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page).toHaveURL(/#\/$/);
});

test('the palette opens, filters, runs a command and continues a topic @phone', async ({ page }, info) => {
  const title = `palette ${info.project.name} ${Date.now()}`;
  const { topicId } = await newTopic({ title, repo: tempGitRepo() });
  await signIn(page);

  let palette = await openPalette(page, info);
  const options = palette.getByRole('option');
  await expect(options.first()).toHaveText(/^Go to next that needs you/);
  for (const name of ['New chat', 'Toggle workspaces panel','Ops: servers', 'Ops: terminals', 'Ops: limits', 'Ops: background service', 'Ops: audit log', 'Ops: actions', 'Settings', 'Doctor', 'Environment files', 'Stop all chats'])
    await expect(palette.getByRole('option', { name, exact: true })).toHaveCount(1);
  await expect(palette.getByRole('option', { name: `Continue ${title}` })).toHaveCount(1);

  await palette.getByRole('combobox').fill('ops lim');
  await expect(options).toHaveText(['Ops: limits']);
  await palette.getByRole('combobox').press('Enter');
  await expect(palette).toHaveCount(0);
  await expect(page).toHaveURL(/#\/ops\/governor$/);
  await expect(page.getByRole('region', { name: 'Limits' })).toBeVisible();

  palette = await openPalette(page, info);
  await palette.getByRole('combobox').fill(title);
  await expect(options).toHaveText([`Continue ${title}`]);
  await options.first().click();
  await expect(page).toHaveURL(new RegExp(`${topicHash(topicId)}$`));

  palette = await openPalette(page, info);
  await palette.getByRole('combobox').fill('no such command anywhere');
  await expect(palette.getByRole('option')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(palette).toHaveCount(0);
});
