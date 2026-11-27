import { expect, test } from './test.js';
import { signIn } from './access.js';

test('New chat starts a topic from the prompt, shows the scripted reply on the topic page, also after a reload', async ({ page }, info) => {
  const prompt = `fix the font bug ${info.project.name} ${Date.now()}`;
  await signIn(page);

  await page.goto('/#/new');
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { name: 'What should the brain work on?' })).toBeVisible();
  const box = main.getByLabel('Prompt for the new topic');
  await expect(box).toBeFocused();
  await box.fill(prompt);
  await box.press('Enter');

  await expect(page).toHaveURL(/#\/topic\/[^/]+$/);
  await expect(main.getByText(prompt, { exact: true })).toBeVisible();
  await expect(main.getByText(`Echo: ${prompt}`, { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('main').getByText(`Echo: ${prompt}`, { exact: true })).toBeVisible();
});
