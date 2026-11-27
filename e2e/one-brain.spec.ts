import { createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { basename, dirname, join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { signIn } from './access.js';
import { api, newTopic, tempGitRepo, topicHash } from './fixtures.js';
import { expectNoInternalNumbers, withBrainActions } from './home-fixtures.js';
import { expect, test } from './test.js';

type Info = { project: { name: string } };
const phone = (info: Info) => info.project.name === 'phone';
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function setupYaml(repo: string, script: string): string {
  const run = `case "$HOS_ROOT_PATH" in '${repo}') ${script};; esac`;
  return ['version: 1', 'setup:', `  run: ${JSON.stringify(run)}`, 'actions: []', ''].join('\n');
}

function repoWithRemote(): { repo: string; name: string; remote: string } {
  const repo = tempGitRepo();
  const remote = join(dirname(repo), `${basename(repo)}-origin.git`);
  git(repo, 'init', '-q', '--bare', remote);
  git(repo, 'remote', 'add', 'origin', remote);
  return { repo, name: basename(repo), remote };
}

async function sidebar(page: Page, info: Info): Promise<Locator> {
  if (phone(info)) await page.getByRole('navigation', { name: 'Tabs' }).getByRole('button', { name: 'Chats' }).click();
  const side = page.getByRole('complementary', { name: 'hos navigation' });
  const head = side.getByRole('region', { name: 'Workspaces' }).getByRole('button', { name: 'Workspaces', exact: true });
  if ((await head.getAttribute('aria-expanded')) === 'false') await head.click();
  return side;
}

async function closeSidebar(page: Page, info: Info): Promise<void> {
  if (phone(info)) await page.getByRole('complementary', { name: 'hos navigation' }).getByRole('button', { name: 'Close navigation' }).click();
}

function workspaceRow(side: Locator, repo: string, kind: 'Root' | 'Worktree', branch: string): Locator {
  return side.getByRole('region', { name: 'Workspaces' }).getByRole('group', { name: repo }).getByRole('listitem', { name: `${kind} ${branch}`, exact: true });
}

function panelOf(page: Page, info: Info) {
  const panel = page.getByRole('complementary', { name: 'Workspaces panel' });
  const toggle = page.getByRole('button', { name: 'Toggle the workspaces panel' });
  return {
    panel,
    toggle,
    async open() {
      await expect(toggle).toBeVisible({ timeout: 30_000 });
      if (phone(info) && !(await panel.isVisible())) await toggle.click();
    },
    async close() {
      if (phone(info) && (await panel.isVisible())) await panel.getByRole('button', { name: 'Close workspaces' }).click();
    },
  };
}

async function send(page: Page, text: string) {
  const main = page.getByRole('main');
  await main.getByLabel('Message').fill(text);
  await main.getByRole('button', { name: 'Send' }).click();
}

async function approve(page: Page, name: RegExp | string) {
  const card = page.getByRole('main').getByRole('group', { name });
  await card.getByRole('button', { name: 'Approve once' }).click();
  await expect(card).toHaveCount(0);
}

test('New chat → a topic named from the prompt picks a new worktree, waits for its setup, edits there, and ships through Commit, Push and Open PR; the brain write is committed', async ({ page }, info) => {
  test.setTimeout(180_000);
  const { repo, name, remote } = repoWithRemote();
  const client = await api();
  await client.createProject(repo);
  const branch = 'gift-tiers';
  const worktree = join(dirname(repo), `${name}-worktrees`, branch);
  const gate = join(process.env.HOS_E2E_DATA_DIR!, `setup-gate-${name}`);
  const main = page.getByRole('main');
  const { panel, toggle, open, close } = panelOf(page, info);
  const block = panel.getByRole('region', { name: `${name}, ${branch}` });
  let topicId = '';

  await withBrainActions(setupYaml(repo, `while [ ! -f '${gate}' ]; do sleep 0.1; done; echo set up ${name}`), async () => {
    await signIn(page);
    await page.goto('/#/new');
    const prompt = page.getByLabel('Prompt for the new topic');
    await prompt.fill(`choose ${name} The gift tiers endpoint lives there`);
    await prompt.press('Enter');
    await expect(page).toHaveURL(/#\/topic\/[^/]+$/);
    topicId = new URL(page.url()).hash.split('/')[2]!;
    await expect(main.getByRole('heading', { level: 1 })).toHaveText(`Choose ${name} The gift tiers endpoint lives…`);
    await expect(toggle).toBeVisible();
    await expect(panel.getByRole('tab', { name: 'Tasks 0' })).toHaveAttribute('aria-selected', 'true');

    const picker = page.getByRole('region', { name: `Pick a ${name} workspace` });
    await expect(picker.getByText(`Which ${name} checkout should I work in?`)).toBeVisible();
    await expect(picker.getByRole('radio').last()).toBeChecked();
    await expect(picker.locator('.picker-opt').last()).toContainText('Create a new worktree');
    await picker.getByRole('textbox', { name: 'Branch' }).fill(branch);
    await picker.getByRole('button', { name: /Work here/ }).click();

    await expect(main.getByText(`Working in ${name} · ${branch} · setting up…`, { exact: true })).toBeVisible();
    const side = await sidebar(page, info);
    const row = workspaceRow(side, name, 'Worktree', branch);
    await expect(row.getByText('setting up')).toBeVisible();
    await closeSidebar(page, info);
    await open();
    await expect(block.getByRole('status')).toContainText('Setting up…');
    await expect(block.getByRole('button', { name: 'Open in Code view' })).toBeDisabled();
    await close();

    writeFileSync(gate, '');
    await open();
    await expect(block.getByText('No changes against main')).toBeVisible({ timeout: 30_000 });
    await close();
    await expect(row.getByText('setting up')).toHaveCount(0);
  });
  rmSync(gate, { force: true });

  await send(page, 'briefing');
  await expect(main.getByText(`[hos briefing] Topic "Choose ${name} The gift tiers endpoint lives…"`, { exact: false })).toBeVisible();
  await expect(main.getByText(`You run in the brain at`, { exact: false }).last()).toBeVisible();
  await expect(main.getByText(new RegExp(`${escape(name)} · worktree · ${escape(worktree)} · branch ${branch} from main · ready`)).last()).toBeVisible();

  await send(page, 'write gift-tiers.txt');
  const write = main.getByRole('group', { name: 'Permission request: Write' });
  await expect(write.getByRole('heading')).toHaveText('Claude wants to write gift-tiers.txt');
  await expect(write.getByText(`in ${name}, ${branch}`)).toBeVisible();
  await approve(page, 'Permission request: Write');
  await expect(main.getByText('Echo: write gift-tiers.txt', { exact: true })).toBeVisible();
  expect(readFileSync(join(worktree, 'gift-tiers.txt'), 'utf8')).toBe('hello from hos\n');

  await open();
  const actions = block.getByRole('group', { name: 'Actions' });
  await expect(block.getByRole('button', { name: 'Open gift-tiers.txt in Code view' })).toBeVisible({ timeout: 30_000 });
  await expect(block.getByLabel('Total lines changed')).toHaveText('+1 −0');
  await block.locator('.panel-touched').getByText('Touched by this topic').click();
  await expect(block.locator('.panel-touched')).toContainText('gift-tiers.txt');
  await expect(actions.getByRole('button')).toHaveText(['Commit', 'Review', 'Open terminal', 'Remove']);
  await expectNoInternalNumbers(panel);

  await actions.getByRole('button', { name: 'Commit' }).click();
  await expect(block.getByLabel('Commit message')).toHaveValue(new RegExp(`^hos: Choose ${escape(name)} `));
  await block.getByRole('form', { name: 'Commit this workspace' }).getByRole('button', { name: 'Commit' }).click();
  await close();
  await approve(page, /^Permission request: Commit in /);

  await open();
  await expect(actions.getByRole('button')).toHaveText(['Push', 'Review', 'Open terminal', 'Remove'], { timeout: 30_000 });
  await actions.getByRole('button', { name: 'Push' }).click();
  await close();
  await approve(page, /^Permission request: Push in /);

  await open();
  await expect(actions.getByRole('button')).toHaveText(['Open PR', 'Review', 'Open terminal', 'Remove'], { timeout: 30_000 });
  expect(git(remote, 'rev-parse', branch)).toBe(git(worktree, 'rev-parse', 'HEAD'));
  await actions.getByRole('button', { name: 'Open PR' }).click();
  await close();
  await approve(page, /^Permission request: Open pull request in /);
  await open();
  await expect(block.getByText(/^Opened https:\/\/github\.com\/hos-e2e\/fake\/pull\/\d+$/)).toBeVisible({ timeout: 30_000 });
  const gh = readFileSync(join(process.env.HOS_E2E_DATA_DIR!, 'gh', 'gh-argv.log'), 'utf8');
  expect(gh).toContain(JSON.stringify({ args: ['pr', 'create', '--fill', '--head', branch], cwd: worktree }));
  await close();

  const note = `notes-${info.project.name}-${Date.now()}.md`;
  await send(page, `note ${note}`);
  await expect(main.getByRole('group', { name: 'Permission request: Write' }).getByText('in the brain')).toBeVisible();
  await approve(page, 'Permission request: Write');
  const chatId = (await page.getByRole('tablist', { name: 'Chats in this topic' }).getByRole('tab', { selected: true }).getAttribute('href'))!.split('/').pop()!;
  await expect
    .poll(() => git(process.env.HOS_E2E_BRAIN!, 'log', '-1', '--format=%s', '--', note), { timeout: 20_000 })
    .toMatch(new RegExp(`^hos: Choose ${escape(name)} .* · chat ${chatId.slice(0, 8)} · 1 file\\(s\\)$`));
  await open();
  await expect(block.locator('.panel-touched li')).toHaveText(['gift-tiers.txt']);
});

function pushService() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  const received: Array<{ url: string; tag: string }> = [];
  const decrypt = (body: Buffer) => {
    const salt = body.subarray(0, 16);
    const idLength = body[20]!;
    const serverKey = body.subarray(21, 21 + idLength);
    const content = body.subarray(21 + idLength);
    const info = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), serverKey]);
    const ikm = Buffer.from(hkdfSync('sha256', ecdh.computeSecret(serverKey), auth, info, 32));
    const cek = Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: aes128gcm\0', 16));
    const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: nonce\0', 12));
    const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
    decipher.setAuthTag(content.subarray(-16));
    const plain = Buffer.concat([decipher.update(content.subarray(0, -16)), decipher.final()]);
    return JSON.parse(plain.subarray(0, plain.lastIndexOf(2)).toString('utf8')) as { url: string; tag: string };
  };
  const tls = process.env.HOS_E2E_PUSH_TLS!;
  const server = createServer({ key: readFileSync(join(tls, 'key.pem')), cert: readFileSync(join(tls, 'cert.pem')) }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push(decrypt(Buffer.concat(chunks)));
      res.writeHead(201).end();
    });
  });
  return {
    received,
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') },
    async listen(): Promise<string> {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      return `https://127.0.0.1:${(server.address() as AddressInfo).port}/push`;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('a push for a helper’s approval links to /#/chat/<id>, which opens that helper’s tab and its one-line approval card', async ({ page }, info) => {
  test.slow();
  const service = pushService();
  const endpoint = await service.listen();
  const client = await api();
  await client.subscribePush({ endpoint, keys: service.keys }, `e2e ${info.project.name}`);
  try {
    const repo = tempGitRepo();
    const { topicId } = await newTopic({ title: `Push ${info.project.name} ${Date.now()}`, repo });
    await signIn(page);
    await page.goto(topicHash(topicId));
    await send(page, 'spawn writer tier.txt Build the tiers');
    const line = page.getByRole('main').getByRole('link', { name: /Worker, Build the tiers/ });
    const helperId = (await line.getAttribute('href'))!.split('/').pop()!;
    await page.goto('/#/');

    await client.sendMessage(helperId, 'write tier.txt');
    await expect.poll(() => service.received.find((n) => n.url === `/#/chat/${helperId}`), { timeout: 20_000 }).toBeTruthy();

    await page.goto(`/#/chat/${helperId}`);
    await expect(page).toHaveURL(new RegExp(`${escape(topicHash(topicId, helperId))}$`));
    const tabs = page.getByRole('tablist', { name: 'Chats in this topic' });
    await expect(tabs.getByRole('tab', { name: /Worker, Build the tiers/ })).toHaveAttribute('aria-selected', 'true');
    const card = page.getByRole('main').getByRole('group', { name: 'Permission request: Write' });
    await expect(card.getByRole('heading')).toHaveText('Worker wants to write tier.txt');
    await expect(card.getByRole('button', { name: 'Approve once' })).toBeVisible();
    await expect(card.locator('pre')).toBeHidden();
    if (!phone(info)) {
      await page.setViewportSize({ width: 1600, height: 900 });
      const heading = (await card.getByRole('heading').boundingBox())!;
      const button = (await card.getByRole('button', { name: 'Approve once' }).boundingBox())!;
      expect(Math.abs(heading.y + heading.height / 2 - (button.y + button.height / 2))).toBeLessThan(12);
    }
    await card.getByRole('button', { name: 'Approve once' }).click();
    await expect(card).toHaveCount(0);
  } finally {
    await client.unsubscribePush(endpoint);
    await service.close();
  }
});
