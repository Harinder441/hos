import type { Page } from '@playwright/test';
import { signIn } from './access.js';
import { newTopic, tempGitRepo, topicHash } from './fixtures.js';
import { expect, test } from './test.js';

function unlabelled(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('button, select, [role="menuitem"], [role="menuitemradio"]')]
      .filter((el) => {
        const box = el.getBoundingClientRect();
        if (!box.width || !box.height || el.closest('[title]')) return false;
        if (el.matches('[role^="menuitem"]')) return true;
        if (el.tagName === 'SELECT') return el.hasAttribute('aria-label');
        return !/[\p{L}\p{N}]/u.test(el.textContent ?? '');
      })
      .map((el) => `${location.hash} ${el.outerHTML.slice(0, 140)}`),
  );
}

test('every icon-only button, unlabelled select and menu row on the main screens has hover text @phone', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const { topicId, chatId } = await newTopic({ title: `hover ${info.project.name}`, repo: tempGitRepo() });
  await signIn(page);
  const misses: string[] = [];
  const audit = async () => misses.push(...(await unlabelled(page)));

  await audit();
  for (const hash of ['#/new', '#/settings', '#/snags', '#/topics/history']) {
    await page.goto(`/${hash}`);
    await page.getByRole('main').getByRole('heading').first().waitFor();
    await audit();
  }

  await page.goto(`/${topicHash(topicId, chatId)}`);
  await expect(page.getByRole('form', { name: 'Composer' })).toBeVisible();
  await audit();
  if (!phone) {
    await page.getByRole('button', { name: 'Chat history' }).click();
    await expect(page.getByRole('menu', { name: 'Chat history' })).toBeVisible();
    await audit();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'More for this topic' }).click();
    await expect(page.getByRole('menu').first()).toBeVisible();
    await audit();
    await page.keyboard.press('Escape');
    const toggle = page.getByRole('button', { name: 'Toggle the workspaces panel' });
    if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
    await page.getByRole('tab', { name: /Workspaces/ }).click();
    await expect(page.getByRole('region', { name: /, main$/ })).toBeVisible();
    await audit();
  }
  expect(misses).toEqual([]);
});
