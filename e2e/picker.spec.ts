import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import { signIn } from './access.js';
import { api, newTopic, tempGitRepo, topicHash } from './fixtures.js';
import { expect, test } from './test.js';

async function repoWithWorktree() {
  const repo = tempGitRepo();
  const worktree = `${repo}-orders`;
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'orders-api-v2', worktree], { cwd: repo, stdio: 'ignore' });
  await (await api()).createProject(repo);
  return { repo, name: basename(repo) };
}

test('the picker lists every checkout, keys move and accept, Not now collapses and reopens, and the receipt lands in the thread', async ({ page }, testInfo) => {
  const { name } = await repoWithWorktree();
  const { topicId, chatId } = await newTopic({ title: `Gift tiers ${name.slice(-6)}` });
  await signIn(page);
  await page.goto(topicHash(topicId, chatId));
  await (await api()).sendMessage(chatId, `choose ${name} The tier endpoint lives there`);

  const picker = page.getByRole('region', { name: `Pick a ${name} workspace` });
  await expect(picker.getByText(`Which ${name} checkout should I work in?`)).toBeVisible();
  await expect(picker.getByText('The tier endpoint lives there')).toBeVisible();
  await expect(page.getByRole('main').getByRole('region', { name: 'Question' })).toHaveCount(0);
  const pickerBox = (await picker.boundingBox())!;
  const composerBox = (await page.getByRole('main').getByRole('form', { name: 'Composer' }).boundingBox())!;
  expect(pickerBox.y + pickerBox.height).toBeLessThanOrEqual(composerBox.y);
  const radios = picker.getByRole('radio');
  await expect(radios).toHaveCount(3);
  await expect(picker.locator('.picker-opt').nth(0).locator('.picker-title')).toHaveText(`${name} · mainroot`);
  await expect(picker.locator('.picker-opt').nth(0)).toContainText('clean · not used by a topic');
  await expect(picker.locator('.picker-opt').nth(1).locator('.picker-title')).toHaveText(`${name}-orders · orders-api-v2`);
  await expect(picker).not.toContainText(/Conductor|Root checkout/);
  await expect(picker.locator('.picker-opt').nth(2)).toContainText('Create a new worktree');
  await expect(picker.locator('.picker-opt').nth(2)).toContainText('suggested');
  await expect(radios.nth(2)).toBeChecked();
  const branch = picker.getByRole('textbox', { name: 'Branch' });
  await expect(branch).toHaveValue('hos/the-tier-endpoint-lives-there');
  await expect(picker.getByText('from main, set up in the background')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('picker-open.png') });

  const workHere = picker.getByRole('button', { name: /Work here/ });
  await branch.fill('');
  await expect(picker.getByText('Name the branch')).toBeVisible();
  await expect(workHere).toBeDisabled();
  await branch.fill('orders-api-v2');
  await expect(picker.getByText('A worktree on orders-api-v2 already exists')).toBeVisible();
  await expect(workHere).toBeDisabled();
  await branch.fill('gift-tiers');
  await expect(workHere).toBeEnabled();

  await branch.press('Escape');
  await expect(page.getByText(`The chat is waiting for a ${name} workspace.`)).toBeVisible();
  await expect(radios).toHaveCount(0);
  await page.getByRole('button', { name: 'Pick one' }).click();
  await expect(radios.nth(2)).toBeChecked();

  await picker.getByRole('textbox', { name: 'Branch' }).press('ArrowUp');
  await expect(radios.nth(1)).toBeChecked();
  await expect(radios.nth(1)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(radios.nth(0)).toBeChecked();
  await page.screenshot({ path: testInfo.outputPath('picker-existing.png') });
  await page.keyboard.press('Enter');

  await expect(picker).toHaveCount(0);
  const thread = page.getByRole('main');
  // A parallel test's brain setup script makes the root start "setting up…".
  await expect(thread.getByText(new RegExp(`^Working in ${name} · main( · setting up…)?$`))).toBeVisible();
  await expect(thread.getByText(new RegExp(`^\\[hos\\] The user picked ${name} · main at `))).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('picker-receipt.png') });
});
