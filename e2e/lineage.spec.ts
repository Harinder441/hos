import { signIn } from './access.js';
import { api, newTopic, tempGitRepo, topicHash } from './fixtures.js';
import { expect, test } from './test.js';

test('a salvage handoff the user asks for continues the chat in a successor, and the topic reads as one conversation with no generation badge', async ({ page }) => {
  // two full turns and a successor boot; under a loaded test:full that outgrows the default 30 s
  test.slow();
  const { topicId, chatId } = await newTopic({ title: 'relay', repo: tempGitRepo() });
  await signIn(page);
  await page.goto(topicHash(topicId, chatId));

  const chatPane = page.getByRole('main');
  await chatPane.getByLabel('Message').fill('context 230000');
  await chatPane.getByRole('button', { name: 'Send' }).click();
  await expect(chatPane.getByText('Echo: context 230000', { exact: true })).toBeVisible();
  await expect(chatPane.getByRole('region', { name: 'Question' })).toHaveCount(0);
  await (await api()).handOff(chatId, 'salvage');

  await expect(chatPane.getByText(/^Echo: \[hos\] You are generation 2 of lineage/)).toBeVisible({ timeout: 15_000 });
  await expect(chatPane.getByText('Echo: context 230000', { exact: true })).toBeVisible();
  await expect(chatPane.getByRole('navigation', { name: 'Lineage' })).toHaveCount(0);
  await expect(chatPane.getByLabel('Handoff metrics')).toHaveCount(0);
  await expect(chatPane.getByText(/\bgen \d\b/)).toHaveCount(0);
  await expect(chatPane.getByRole('button', { name: 'Send' })).toBeEnabled();

  await page.goto(topicHash(topicId));
  await expect(page.getByRole('tablist', { name: 'Chats in this topic' }).getByRole('tab')).toHaveText([/^context 230000$/i]);
  await expect(chatPane.getByText(/^Echo: \[hos\] You are generation 2 of lineage/)).toBeVisible();
  await chatPane.getByLabel('Message').fill('still here');
  await chatPane.getByRole('button', { name: 'Send' }).click();
  await expect(chatPane.getByText('Echo: still here', { exact: true })).toBeVisible();
});
