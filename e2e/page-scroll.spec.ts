import type { Locator, Page } from '@playwright/test';
import { signIn } from './access.js';
import { api, newTopic, tempGitRepo, topicHash } from './fixtures.js';
import { expect, test } from './test.js';

async function seed(project: string) {
  const client = await api();
  const big = await newTopic({ title: `Scroll guard ${project} with twenty workspaces and a long name`, repo: tempGitRepo() });
  const seven = await newTopic({ title: `Scroll guard ${project} seven`, repo: tempGitRepo() });
  await newTopic({ title: `Scroll guard ${project} one`, repo: tempGitRepo() });
  for (let i = 1; i < 20; i++) {
    const workspace = await client.createWorkspace({ projectId: (await client.createProject(tempGitRepo())).id, kind: 'root' });
    await client.attachWorkspace(big.topicId, workspace.id);
    if (i < 7) await client.attachWorkspace(seven.topicId, workspace.id);
  }
  for (let i = 0; i < 30; i++) {
    const task = await client.addTask(big.topicId, { title: `Seeded task ${i} with a title long enough to need trimming` });
    if (i >= 20) continue;
    await client.sendMessage(big.chatId, `claim ${task.ref}`);
    await expect.poll(async () => (await client.listTasks(big.topicId)).find((t) => t.ref === task.ref)?.state).toBe('claimed');
    await client.updateTask(big.topicId, task.ref, { state: 'done', evidence: 'commit abc1234def, e2e/page-scroll.spec.ts seed' });
  }
  return big.topicId;
}

function pageScroll(page: Page) {
  return page.evaluate(() => ({ scrollHeight: document.scrollingElement!.scrollHeight, innerHeight }));
}

function scrolls(container: Locator) {
  return container.evaluate((el) => el.scrollHeight > el.clientHeight && ['auto', 'scroll'].includes(getComputedStyle(el).overflowY));
}

test('opening Workspaces in the sidebar or the Done tasks scrolls only that section, never the page, and Home keeps a busy topic’s name @phone', async ({ page }, info) => {
  test.slow();
  const phone = info.project.name === 'phone';
  const topicId = await seed(info.project.name);
  await signIn(page);
  await page.goto(topicHash(topicId));

  if (phone) await page.getByRole('navigation', { name: 'Tabs' }).getByRole('button', { name: 'Chats' }).click();
  const section = page.getByRole('region', { name: 'Workspaces' });
  const head = section.getByRole('button', { name: 'Workspaces', exact: true });
  if ((await head.getAttribute('aria-expanded')) === 'false') await head.click();
  await expect.poll(() => section.getByRole('group').count()).toBeGreaterThanOrEqual(22);
  await page.evaluate(() => window.scrollTo(0, document.scrollingElement!.scrollHeight));
  await page.screenshot({ path: info.outputPath(`sidebar-workspaces-${info.project.name}.png`) });
  const sidebar = await pageScroll(page);
  expect.soft(sidebar.scrollHeight, 'the page does not scroll with Workspaces open').toBeLessThanOrEqual(sidebar.innerHeight);
  expect.soft(await scrolls(section.locator('.sec-body')), 'the Workspaces section scrolls').toBe(true);

  await page.reload();
  const panel = page.getByRole('complementary', { name: 'Workspaces panel' });
  if (phone) await page.getByRole('button', { name: 'Toggle the workspaces panel' }).click();
  await panel.getByText(/^Done 20$/).click();
  await expect(panel.getByRole('list', { name: 'Done tasks' }).getByRole('listitem')).toHaveCount(20);
  await page.evaluate(() => window.scrollTo(0, document.scrollingElement!.scrollHeight));
  await page.screenshot({ path: info.outputPath(`tasks-done-${info.project.name}.png`) });
  const tasks = await pageScroll(page);
  expect.soft(tasks.scrollHeight, 'the page does not scroll with Done open').toBeLessThanOrEqual(tasks.innerHeight);
  expect.soft(await scrolls(panel.locator('.panel-body')), 'the Tasks panel scrolls').toBe(true);

  await page.goto('/#/');
  const row = page.getByRole('main').getByRole('list', { name: 'Topics' }).getByRole('link', { name: `Scroll guard ${info.project.name} with twenty` });
  await row.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath(`home-${info.project.name}.png`), fullPage: true });
  const name = await row.locator('.home-t').boundingBox();
  expect.soft(name!.width, 'the topic name keeps a readable width').toBeGreaterThan(100);
});
