import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { signIn } from './access.js';
import { newTopic, tempGitRepo, topicHash, topicSign } from './fixtures.js';
import { expect, test } from './test.js';

function main(page: Page): Locator {
  return page.getByRole('main');
}

async function send(page: Page, text: string) {
  await main(page).getByLabel('Message').fill(text);
  await main(page).getByRole('button', { name: 'Send' }).click();
}

// card keys only fire when focus is out of a text field and off a control
async function leaveTheComposer(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

test('a plan card approves with ↵ and runs implement; Edit sends the user’s text and the topic never reads as planning', async ({ page }, info) => {
  const { topicId } = await newTopic({ title: `plan-${info.project.name}`, repo: tempGitRepo() });
  await signIn(page);
  await page.goto(topicHash(topicId));
  const pane = main(page);
  const state = topicSign(page, topicId);

  await send(page, 'plan Evaluate the gift tiers server-side');
  const card = pane.getByRole('region', { name: 'Plan to approve' });
  await expect(card.getByRole('heading')).toHaveText('Evaluate the gift tiers server-side');
  await expect(state).toHaveAccessibleName('Plan ready for you');
  await page.screenshot({ path: info.outputPath(`plan-card-${info.project.name}.png`) });

  await leaveTheComposer(page);
  await page.keyboard.press('e');
  await expect(pane.getByLabel('Message')).toHaveValue('Change the plan: ');
  await expect(pane.getByLabel('Message')).toBeFocused();
  await pane.getByLabel('Message').fill('Change the plan: keep it in the theme');
  await pane.getByRole('button', { name: 'Send' }).click();
  await expect(pane.getByText('Plan sent back with changes')).toBeVisible();
  await expect(pane.getByText('Echo: Change the plan: keep it in the theme', { exact: true })).toBeVisible();
  await expect(state).toHaveAccessibleName('Idle');

  await send(page, 'plan Evaluate them in the discount function');
  await expect(card.getByRole('heading')).toHaveText('Evaluate them in the discount function');
  await leaveTheComposer(page);
  await page.keyboard.press('Enter');
  await expect(pane.getByText('Plan approved')).toBeVisible();
  await expect(pane.getByText(/^Echo: \[hos\] The user approved the plan/)).toBeVisible();
  await expect(state).not.toHaveAccessibleName('planning');
  await expect(card).toHaveCount(0);
});

test('an approval is one line with where it runs, Details unfold the reason and the raw input, ↵ approves and ⌫ denies', async ({ page }, info) => {
  const repo = tempGitRepo();
  const { topicId } = await newTopic({ title: `approve-${info.project.name}`, repo });
  await signIn(page);
  await page.goto(topicHash(topicId));
  const pane = main(page);

  await send(page, 'write yes.txt');
  const card = pane.getByRole('group', { name: 'Permission request: Write' });
  await expect(card.getByRole('heading')).toHaveText('Claude wants to write yes.txt');
  await expect(card.getByText(`in ${repo.split('/').pop()}, main`)).toBeVisible();
  const raw = `"file_path":${JSON.stringify(join(repo, 'yes.txt'))}`;
  await expect(card.getByText(raw)).toBeHidden();
  await card.getByText('Details').click();
  await expect(card.getByText(raw)).toBeVisible();
  await page.screenshot({ path: info.outputPath(`approval-${info.project.name}.png`) });

  await leaveTheComposer(page);
  await page.keyboard.press('Enter');
  await expect(pane.getByText('Approved: Claude wants to write yes.txt')).toBeVisible();
  await expect(pane.getByText('Echo: write yes.txt', { exact: true })).toBeVisible();
  expect(existsSync(join(repo, 'yes.txt'))).toBe(true);

  await send(page, 'write no.txt');
  await expect(card.getByRole('heading')).toHaveText('Claude wants to write no.txt');
  await leaveTheComposer(page);
  await page.keyboard.press('Backspace');
  await expect(pane.getByText('Denied: Claude wants to write no.txt')).toBeVisible();
  await expect(pane.getByText('Echo: write no.txt', { exact: true })).toBeVisible();
  expect(existsSync(join(repo, 'no.txt'))).toBe(false);
});

test('the composer offers model and effort in one picker, Stop pauses the chat, the next message resumes it, and the queued line shows only while a message waits', async ({
  page,
}, info) => {
  const { topicId } = await newTopic({ title: `stop-${info.project.name}`, repo: tempGitRepo() });
  await signIn(page);
  await page.goto(topicHash(topicId));
  const pane = main(page);
  const composer = pane.getByRole('form', { name: 'Composer' });

  await expect(composer.getByRole('button')).toHaveText(['default · default', '', '']);
  await expect(composer.getByRole('status', { name: 'Queued message' })).toHaveCount(0);

  const long = `slowly ${'and on '.repeat(40)}done`;
  const stop = composer.getByRole('button', { name: 'Stop' });
  await send(page, long);
  await expect(stop).toBeVisible();
  await pane.getByLabel('Message').fill('and then stop');
  await pane.getByLabel('Message').press('Enter');
  const queued = composer.getByRole('status', { name: 'Queued message' });
  await expect(queued).toContainText('and then stop, sends when this turn ends');
  await page.screenshot({ path: info.outputPath(`queued-${info.project.name}.png`) });

  await expect(pane.getByText('Echo: and then stop', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(queued).toHaveCount(0);

  await send(page, long);
  await stop.click();
  await expect(topicSign(page, topicId)).toHaveAccessibleName('Paused');
  await expect(stop).toHaveCount(0);

  await send(page, 'back again');
  await expect(pane.getByText('Echo: back again', { exact: true })).toBeVisible();
});
