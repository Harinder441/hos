import { signIn } from './access.js';
import { api, newTopic, tempGitRepo, topicHash } from './fixtures.js';
import { expect, test } from './test.js';

test('take over a chat in a terminal, type into it, hand it back and keep chatting', async ({ page }) => {
  const { topicId, chatId } = await newTopic({ title: 'takeover', repo: tempGitRepo() });
  await signIn(page);
  await page.goto(topicHash(topicId));

  const main = page.getByRole('main');
  await main.getByLabel('Message').fill('before');
  await main.getByRole('button', { name: 'Send' }).click();
  await expect(main.getByText('Echo: before', { exact: true })).toBeVisible();

  await (await api()).takeOver(chatId);
  await expect(main.getByRole('status')).toContainText('Taken over in terminal');
  await expect(main.getByLabel('Message')).toBeDisabled();
  await main.getByRole('link', { name: 'Open terminal' }).click();

  const terminal = main.getByRole('region', { name: /^Terminal / });
  await expect(terminal).toContainText('>');
  await terminal.click();
  await page.keyboard.type('from the terminal');
  await page.keyboard.press('Enter');
  await expect(terminal).toContainText('Echo: from the terminal');

  await page.goBack();
  await main.getByRole('button', { name: 'Hand back' }).click();
  await expect(main.getByRole('status')).toHaveCount(0);
  await main.getByLabel('Message').fill('after');
  await main.getByRole('button', { name: 'Send' }).click();
  await expect(main.getByText('Echo: after', { exact: true })).toBeVisible();

});
