import { signIn } from './access.js';
import { api, newTopic, tempGitRepo, topicHash, topicSign } from './fixtures.js';
import { expect, test } from './test.js';

test('a native subagent shows as a collapsed card with its metrics that a click opens and closes, and the topic shows as working', async ({ page }, info) => {
  const { topicId } = await newTopic({ title: `subagent-${info.project.name}`, repo: tempGitRepo() });
  const worker = await (await api()).createChat(topicId, { role: 'worker' });
  await signIn(page);
  await page.goto(topicHash(topicId, worker.id));

  const pane = page.getByRole('main');
  await pane.getByLabel('Message').fill('subagent font loaders');
  await pane.getByRole('button', { name: 'Send' }).click();

  const state = topicSign(page, topicId);
  await expect(state).toHaveAccessibleName('Working');
  const card = pane.getByRole('region', { name: 'Subagent Explore: font loaders' });
  const head = card.getByRole('button', { name: /Explore/ });
  await expect(head).toHaveAttribute('aria-expanded', 'false');
  await expect(card.getByRole('img', { name: 'running' })).toBeVisible();

  await expect(pane.getByText('Subagent done.', { exact: true })).toBeVisible();
  await expect(state).toHaveAccessibleName('Idle');
  await expect(card.getByRole('img', { name: 'completed' })).toBeVisible();
  await expect(head).toContainText(/font loaders · \d+s · 2 tools · 2k tok · ▸ Grep/);
  await expect(card.getByRole('list', { name: 'Tool calls' })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath(`subagent-collapsed-${info.project.name}.png`) });

  await head.click();
  await expect(head).toHaveAttribute('aria-expanded', 'true');
  await card.getByText('Prompt', { exact: true }).click();
  await expect(card.getByText('Find font loaders and report back.')).toBeVisible();
  const calls = card.getByRole('list', { name: 'Tool calls' }).getByRole('listitem');
  await expect(calls).toHaveCount(2);
  await expect(calls.first()).toContainText('Read');
  await expect(calls.first()).toContainText('README.md');
  await expect(calls.last()).toContainText('Grep');
  await expect(card.getByText('Found font loaders in README.md.')).toBeVisible();
  await expect(pane.locator('details.turn').getByText('Read README.md')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath(`subagent-expanded-${info.project.name}.png`) });

  await head.click();
  await expect(head).toHaveAttribute('aria-expanded', 'false');
  await expect(card.getByRole('list', { name: 'Tool calls' })).toHaveCount(0);
});
