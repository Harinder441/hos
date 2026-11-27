import { signIn } from './access.js';
import { newTopic, topicHash } from './fixtures.js';
import { expect, test } from './test.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function tempGitRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hos-e2e-repo-')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), '# e2e\n');
  writeFileSync(join(dir, 'review.txt'), 'draft\n');
  git('add', '.');
  git('-c', 'user.name=hos-e2e', '-c', 'user.email=hos@test.invalid', 'commit', '-q', '-m', 'init');
  return dir;
}

test('a comment on a diff line arrives in the authoring chat as a message @phone', async ({ page }, info) => {
  const repo = tempGitRepo();
  const name = `diff-${info.project.name}`;
  const { topicId, chatId } = await newTopic({ title: name, repo });
  await signIn(page);
  await page.goto(topicHash(topicId));
  const main = page.getByRole('main');
  await main.getByLabel('Message').fill('write review.txt');
  await main.getByRole('button', { name: 'Send' }).click();
  await main.getByRole('group', { name: 'Permission request: Write' }).getByRole('button', { name: 'Approve once' }).click();
  await expect(main.getByText('Echo: write review.txt', { exact: true })).toBeVisible();

  // the chat has no diff peek any more (ticket 08); the diff route is unchanged
  await page.goto(`/#/diff/chat/${chatId}`);
  const diff = page.getByRole('region', { name: 'Diff' });
  await expect(diff.getByLabel('Diff summary')).toHaveText('1 file changed · +1 −1');
  const file = diff.getByRole('article', { name: 'Changes to review.txt' });
  await file.locator('[data-line="1"][data-line-type="change-addition"]').first().click();
  await diff.getByLabel('Comment on review.txt line 1').fill('Say hello properly');
  await diff.getByRole('button', { name: 'Add comment' }).click();
  await expect(file.getByText('Say hello properly')).toBeVisible();

  if (info.project.name === 'phone') {
    await expect(diff.getByRole('button', { name: /^(Split|Stacked)$/ })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(file.locator('pre[data-diff-type="single"]')).toHaveCount(1);
  } else {
    await expect(file.locator('pre[data-diff-type="split"]')).toHaveCount(1);
    await diff.getByRole('button', { name: 'Stacked' }).click();
    await expect(file.locator('pre[data-diff-type="single"]')).toHaveCount(1);
  }

  await diff.getByRole('button', { name: 'Send comments' }).click();
  await diff.getByRole('link', { name: `Sent to ${name} · Chat 1` }).click();
  await expect(page).toHaveURL(new RegExp(`#/topic/${topicId}/chat/`));
  await expect(main.getByText('- review.txt line 1: Say hello properly')).toBeVisible();
  await expect(main.getByText('Echo: Review comments from the user')).toBeVisible();
});
