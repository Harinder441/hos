import type { Locator, Page } from '@playwright/test';
import { signIn } from './access.js';
import { expect, test } from './test.js';

const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function snagsBlock(page: Page, phone: boolean): Promise<Locator> {
  if (phone) await page.getByRole('navigation', { name: 'Tabs' }).getByRole('button', { name: 'Chats' }).click();
  return page.getByRole('complementary', { name: 'hos navigation' }).getByRole('region', { name: 'Snags' });
}

async function pasteImage(box: Locator): Promise<void> {
  await box.evaluate((el, b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], 'screen.png', { type: 'image/png' }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, PIXEL);
}

test('a snag pasted in the sidebar shows on the Snags page with its screenshot, resolves, reopens, starts a topic and deletes @phone', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const text = `Board flickers on ${info.project.name} ${Date.now()}-${info.repeatEachIndex}`;
  await signIn(page);

  const block = await snagsBlock(page, phone);
  await block.getByRole('button', { name: 'Add a snag' }).click();
  const form = block.getByRole('form', { name: 'Add a snag' });
  const box = form.getByLabel('Snag text');
  await expect(box).toBeFocused();
  await box.fill(text);
  await pasteImage(box);
  await expect(form.getByRole('list', { name: 'Files to add' }).getByRole('img', { name: 'screen.png' })).toBeVisible();
  await form.getByRole('button', { name: 'Question' }).click();
  await page.screenshot({ path: info.outputPath(`snags-form-${info.project.name}.png`) });
  await box.press('ControlOrMeta+Enter');
  await expect(block.getByRole('status')).toHaveText(/^Added S\d+$/);
  await expect(form).toHaveCount(0);
  await expect(block.getByLabel(/^\d+ open$/)).toBeVisible();

  await block.getByRole('link', { name: 'All' }).click();
  await expect(page).toHaveURL(/#\/snags$/);
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { level: 1, name: 'Snags' })).toBeVisible();
  const card = main.getByRole('list', { name: 'Snags' }).getByRole('listitem').filter({ hasText: text });
  await expect(card).toHaveCount(1);
  await expect(card.getByText('Question', { exact: true })).toBeVisible();
  await card.scrollIntoViewIfNeeded();
  await expect(card.getByRole('img', { name: 'screen.png' })).toBeVisible();
  await page.screenshot({ path: info.outputPath(`snags-page-${info.project.name}.png`), fullPage: true });

  await card.getByRole('button', { name: 'Resolve' }).click();
  await card.getByRole('textbox').fill('fixed in the board rewrite');
  await card.getByRole('button', { name: 'Resolve' }).click();
  await expect(card).toHaveCount(0);
  await main.getByRole('group', { name: 'State' }).getByRole('button', { name: 'Resolved' }).click();
  await expect(card.getByText('fixed in the board rewrite')).toBeVisible();
  await card.getByRole('button', { name: 'Reopen' }).click();
  await expect(card).toHaveCount(0);
  await main.getByRole('group', { name: 'State' }).getByRole('button', { name: 'Open' }).click();
  await expect(card).toHaveCount(1);

  await card.getByRole('button', { name: 'Start topic' }).click();
  await expect(page).toHaveURL(/#\/topic\/[^/]+\/chat\/[^/]+$/);
  await expect(page.getByRole('main').getByText(text).first()).toBeVisible();

  await page.goto('/#/snags');
  await expect(card.getByRole('link', { name: /^(?!Open )/ })).toHaveCount(1);
  await card.getByRole('button', { name: 'Delete' }).click();
  await card.getByRole('group').getByRole('button', { name: 'Delete' }).click();
  await expect(card).toHaveCount(0);
});

test('a Context snag shows on the Snags page with its tag and filter, and the sidebar count leaves open context snags out', async ({ page }, info) => {
  const text = `Profile needs a line ${Date.now()}-${info.repeatEachIndex}`;
  await signIn(page);
  const block = await snagsBlock(page, false);
  await block.getByRole('button', { name: 'Add a snag' }).click();
  const form = block.getByRole('form', { name: 'Add a snag' });
  await form.getByLabel('Snag text').fill(text);
  await form.getByRole('button', { name: 'Context' }).click();
  await form.getByLabel('Snag text').press('ControlOrMeta+Enter');
  await expect(form).toHaveCount(0);

  await block.getByRole('link', { name: 'All' }).click();
  const main = page.getByRole('main');
  await main.locator('.snags-filters').getByRole('group', { name: 'Kind' }).getByRole('button', { name: 'Context' }).click();
  const card = main.getByRole('list', { name: 'Snags' }).getByRole('listitem').filter({ hasText: text });
  await expect(card.getByText('Context', { exact: true })).toBeVisible();
  await expect(main.locator('.snag-tag:not(.context)')).toHaveCount(0);
  await card.getByRole('button', { name: 'Delete' }).click();
  await card.getByRole('group').getByRole('button', { name: 'Delete' }).click();
  await expect(card).toHaveCount(0);

  await page.route('**/api/snags/summary', (route) => route.fulfill({ json: { open: 3, openContext: 2, total: 5, offline: false, queued: 0 } }));
  await page.reload();
  await expect(block.getByLabel('1 open')).toHaveText('1');
});
