import { signIn } from './access.js';
import { newTopic, tempGitRepo, topicHash } from './fixtures.js';
import { expect, test } from './test.js';

test('a turn’s tool calls collapse to one plain-words line and expand to the calls themselves', async ({ page }, info) => {
  const repo = tempGitRepo();
  const { topicId } = await newTopic({ title: `turns-${info.project.name}`, repo });
  await signIn(page);
  await page.goto(topicHash(topicId));

  const pane = page.getByRole('main');
  await pane.getByLabel('Message').fill('write turn.txt');
  await pane.getByRole('button', { name: 'Send' }).click();
  await pane.getByRole('group', { name: 'Permission request: Write' }).getByRole('button', { name: 'Approve once' }).click();
  await expect(pane.getByText('Echo: write turn.txt', { exact: true })).toBeVisible();

  const turn = pane.locator('details.turn').last();
  await expect(turn).toContainText('Wrote turn.txt');
  await expect(turn.getByRole('list', { name: 'Tool calls' })).toBeHidden();
  await turn.getByText('Wrote turn.txt').click();
  const calls = turn.getByRole('list', { name: 'Tool calls' });
  await expect(calls.getByRole('listitem')).toHaveCount(1);
  await expect(calls.getByRole('listitem')).toContainText('Write');
  await expect(calls.getByRole('listitem')).toContainText('turn.txt');
  await expect(calls.getByRole('listitem')).toContainText('ok');
  await page.screenshot({ path: info.outputPath(`turn-${info.project.name}.png`) });
});

test('Chat history lists every chat in the topic with its last message time, marks agent-started and closed ones, and reopens a closed tab', async ({ page }, info) => {
  const title = `history-${info.project.name}`;
  const { topicId } = await newTopic({ title, repo: tempGitRepo() });
  await page.clock.install();
  await signIn(page);
  await page.goto(topicHash(topicId));
  const pane = page.getByRole('main');
  const tabs = page.getByRole('tablist', { name: 'Chats in this topic' });
  const agentMark = { name: 'started by an agent' };

  await pane.getByLabel('Message').fill('spawn worker Build the orders API');
  await pane.getByRole('button', { name: 'Send' }).click();
  const worker = tabs.getByRole('tab', { name: /Worker, Build the orders API/ });
  await expect(worker.getByRole('img', agentMark)).toBeVisible();
  await expect(tabs.getByRole('tab').first().getByRole('img', agentMark)).toHaveCount(0);
  await expect(pane.locator('.msg-user time').first()).toHaveText(/^\d\d:\d\d · just now$/);
  await expect(pane.locator('.prose time').first()).toHaveText(/^\d\d:\d\d · just now$/);

  await page.getByRole('button', { name: 'New chat in this topic' }).click();
  await expect(tabs.getByRole('tab', { name: /New chat/ })).toHaveAttribute('aria-selected', 'true');
  await pane.getByLabel('Message').fill('in the second chat, name it Second Chat Tab');
  await pane.getByRole('button', { name: 'Send' }).click();
  await expect(tabs.getByRole('tab', { name: 'Second Chat Tab' })).toBeVisible({ timeout: 15_000 });
  await expect(tabs.getByRole('tab', { name: 'Second Chat Tab' }).getByRole('img', agentMark)).toHaveCount(0);
  await page.getByRole('button', { name: 'Close Second Chat Tab' }).click();
  await expect(tabs.getByRole('tab')).toHaveCount(2);

  await page.getByRole('button', { name: 'Chat history' }).click();
  const history = page.getByRole('menu', { name: 'Chat history' });
  await expect(history.getByRole('menuitem')).toHaveCount(3);
  await expect(history.getByRole('menuitem', { name: 'Second Chat Tab, closed' })).toContainText(/closed\d\d:\d\d · just now$/);
  await expect(history.getByRole('menuitem', { name: /^Worker, Build the orders API.*, started by an agent$/ })).toContainText('agent');
  await expect(history.getByRole('menuitem', { name: /^spawn worker Build the orders API$/i })).toBeVisible();
  await history.screenshot({ path: info.outputPath(`history-${info.project.name}.png`) });

  await history.getByRole('menuitem', { name: 'Second Chat Tab, closed' }).click();
  await expect(tabs.getByRole('tab', { name: 'Second Chat Tab' })).toHaveAttribute('aria-selected', 'true');
  await tabs.getByRole('tab').first().click();
  await expect(tabs.getByRole('tab')).toHaveCount(3);
  await page.screenshot({ path: info.outputPath(`history-tabs-${info.project.name}.png`) });

  await page.clock.fastForward('50:00:00');
  await expect(pane.locator('.msg-user time').first()).toHaveText(/^[23] days ago$/);
  await page.getByRole('button', { name: 'Chat history' }).click();
  await expect(history.getByRole('menuitem', { name: 'Second Chat Tab' })).toContainText(/[23] days ago$/);
});

test('on a phone a long path, a 200-character code line and a 6-column table stay inside the chat column; only the code box and table scroll sideways @phone', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', 'phone layout only');
  const { topicId } = await newTopic({ title: `overflow-${info.project.name}`, repo: tempGitRepo() });
  await signIn(page);
  await page.goto(topicHash(topicId));
  const pane = page.getByRole('main');

  const file = `long-${'x'.repeat(180)}.txt`;
  await pane.getByLabel('Message').fill(`write ${file}`);
  await pane.getByRole('button', { name: 'Send' }).click();
  await pane.getByRole('group', { name: 'Permission request: Write' }).getByRole('button', { name: 'Approve once' }).click();
  await expect(pane.locator('details.turn').last()).toContainText(`Wrote ${file}`);

  const path = `/Users/someone/${'deeply-nested-folder/'.repeat(10)}report.md`;
  const line = `const line = "${'y'.repeat(200)}";`;
  const heads = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'];
  const table = [`| ${heads.join(' | ')} |`, `|${'---|'.repeat(6)}`, `| ${heads.map((h) => `${h}-cell-value-that-is-wide`).join(' | ')} |`].join('\n');
  await pane.getByLabel('Message').fill(`see ${path}\n\`\`\`\n${line}\n\`\`\`\n${table}`);
  await pane.getByRole('button', { name: 'Send' }).click();
  const reply = pane.locator('.prose').last();
  await expect(reply.getByRole('table').getByRole('columnheader')).toHaveText(heads);
  await expect(reply.locator('pre')).toContainText(line);

  const timeline = pane.locator('.timeline');
  await expect.poll(() => timeline.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await expect.poll(() => reply.locator('pre').evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  await expect.poll(() => reply.locator('.md-table').evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`overflow-${info.project.name}.png`) });
});
