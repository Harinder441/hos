import type { Page } from '@playwright/test';
import { signIn } from './access.js';
import { newTopic, tempGitRepo, topicHash } from './fixtures.js';
import { expect, test } from './test.js';

async function openTopic(page: Page, name: string) {
  const topic = await newTopic({ title: name, repo: tempGitRepo() });
  await signIn(page);
  await page.goto(topicHash(topic.topicId));
  return topic;
}

async function send(page: Page, text: string) {
  const pane = page.getByRole('main');
  await pane.getByLabel('Message').fill(text);
  await pane.getByRole('button', { name: 'Send' }).click();
}

test('a spawned helper gets its own tab after its parent’s and a line in its parent’s thread', async ({ page }, testInfo) => {
  const name = `tree-${testInfo.project.name}`;
  await openTopic(page, name);
  await send(page, 'spawn worker Build the orders API');
  const pane = page.getByRole('main');
  await expect(pane.getByText('Spawned a worker.')).toBeVisible();

  const line = pane.getByRole('link', { name: /Worker, Build the orders API/ });
  await expect(line).toBeVisible();

  const tabs = page.getByRole('tablist', { name: 'Chats in this topic' });
  await expect(tabs.getByRole('tab')).toHaveCount(2);
  await expect(tabs.getByRole('tab').first()).toHaveText(/^spawn worker Build the orders API$/i);
  await expect(tabs.getByRole('tab').first()).toHaveAttribute('aria-selected', 'true');
  const child = tabs.getByRole('tab', { name: /Worker, Build the orders API/ });
  await page.screenshot({ path: testInfo.outputPath('spawn-tabs.png') });

  await line.click();
  await expect(child).toHaveAttribute('aria-selected', 'true');
  await expect(pane.getByText(/from chat \w{8} · role=main · not the user/).first()).toBeVisible();
});
