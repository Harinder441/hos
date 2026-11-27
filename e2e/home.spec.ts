import { signIn } from './access.js';
import { expect, test } from './test.js';

test('with no plug-in, Today and the capture box run on this computer; ticking a task closes it and Hand to an agent opens New chat @phone', async ({ page }, info) => {
  const p = `${info.project.name}-${Date.now()}`;
  await signIn(page);
  const today = page.getByRole('list', { name: 'Today' });
  const capture = page.getByPlaceholder('Add a task for today, or a link to read later');
  await expect(page.getByRole('heading', { name: /^Today/ })).toContainText('This computer');
  await expect(page.getByRole('heading', { name: /^Calendar/ })).toHaveCount(0);

  for (const title of [`Review gift tiers PR ${p}`, `Book the dentist ${p}`]) {
    await capture.fill(title);
    await capture.press('Enter');
    await expect(page.getByRole('status').filter({ hasText: 'Saved to This computer.' })).toBeVisible();
  }
  const mine = today.getByRole('listitem').filter({ hasText: p });
  await expect(mine).toHaveCount(2);

  const hand = today.getByRole('link', { name: `Hand to an agent: Book the dentist ${p}` });
  if (info.project.name === 'phone') await expect(hand).toHaveCSS('opacity', '1');
  else {
    await expect(hand).toHaveCSS('opacity', '0');
    await mine.filter({ hasText: `Book the dentist ${p}` }).hover();
    await expect(hand).toHaveCSS('opacity', '1');
  }
  await page.screenshot({ path: info.outputPath(`home-tasks-${info.project.name}.png`), fullPage: true });

  await today.getByRole('checkbox', { name: `Done: Review gift tiers PR ${p}` }).click();
  await expect(mine).toHaveCount(1);

  await hand.click();
  await expect(page).toHaveURL(/#\/new\?prompt=/);
  await expect(page.getByRole('main').getByRole('heading', { name: 'New chat' })).toBeVisible();
  await expect(page.getByRole('main').getByRole('textbox').first()).toHaveValue(`Book the dentist ${p}`);
});
