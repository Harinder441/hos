import { signIn } from './access.js';
import { api, newTopic } from './fixtures.js';
import { expect, test } from './test.js';

test('Quick chats is pinned first in the Topics list, cannot be archived, and a Quick new chat lands in it @phone', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const client = await api();
  const desk = (await client.listTopics()).find((topic) => topic.desk)!;
  await newTopic({ title: `after desk ${info.project.name} ${Date.now()}` });
  await signIn(page);

  if (phone) await page.getByRole('navigation', { name: 'Tabs' }).getByRole('button', { name: 'Chats' }).click();
  const topics = page.getByRole('complementary', { name: 'hos navigation' }).getByRole('list', { name: 'Topics' });
  await expect(topics.locator('> li').first().getByRole('link')).toHaveText(/^Quick chats(, unseen)?$/);
  await topics.getByRole('button', { name: 'More for Quick chats' }).click();
  const menu = page.getByRole('menu', { name: 'More for this topic' });
  await expect(menu.getByRole('menuitem', { name: 'Rename topic' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Archive topic' })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath(`desk-sidebar-${info.project.name}.png`) });
  await page.keyboard.press('Escape');

  await page.goto('/#/new');
  const form = page.getByRole('form', { name: 'New chat' });
  const ask = `quick ask ${info.project.name}`;
  await form.getByLabel('Prompt for the new topic').fill(ask);
  await form.getByRole('button', { name: 'Quick', exact: true }).click();
  await expect(form.getByRole('button', { name: 'Quick', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: info.outputPath(`desk-quick-${info.project.name}.png`) });
  await form.getByRole('button', { name: 'Send to Quick chats' }).click();

  await expect(page).toHaveURL(new RegExp(`#/topic/${desk.id}/chat/`));
  await expect(page.getByRole('main').getByText(`Echo: ${ask}`, { exact: true })).toBeVisible();
  const chatId = decodeURIComponent(page.url().split('/chat/')[1]!);
  expect((await client.getLineage(chatId)).chats[0]!.topicId).toBe(desk.id);
});
