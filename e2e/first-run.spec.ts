import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test as base, type Page } from '@playwright/test';
import { expectShell, virtualAuthenticator } from './access.js';

const test = base.extend<{ watchPage: void }>({
  watchPage: [
    async ({ page }, use) => {
      const problems: string[] = [];
      page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
      page.on('requestfailed', (request) => {
        const failure = request.failure()?.errorText ?? '';
        if (!/ERR_ABORTED|cancelled|ERR_CONNECTION_REFUSED/i.test(failure)) problems.push(`request failed: ${request.method()} ${request.url()} ${failure}`);
      });
      page.on('response', (response) => {
        if (response.status() >= 500 && response.status() !== 503) problems.push(`server error: ${response.status()} ${response.request().method()} ${response.url()}`);
      });
      await use();
      expect(problems, 'no page errors and no failed requests, apart from the moment hos restarts on the new brain').toEqual([]);
    },
    { auto: true },
  ],
});

const daemons: ChildProcess[] = [];

test.afterEach(async ({ page }) => {
  await page.close();
  for (const daemon of daemons.splice(0)) {
    daemon.kill('SIGTERM');
    if (daemon.exitCode === null) await once(daemon, 'exit');
  }
});

function starterRepo(): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'hos-e2e-starter-')), 'hos-brain');
  mkdirSync(join(dir, 'hos'), { recursive: true });
  writeFileSync(join(dir, 'CLAUDE.md'), '# starter brain\n');
  writeFileSync(join(dir, 'hos', 'policy.yaml'), 'version: 1  # schema version\napprovals:\n  preset: balanced  # reads and edits run, the rest asks\n');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('-c', 'user.name=hos-e2e', '-c', 'user.email=hos@test.invalid', 'commit', '-q', '-m', 'starter');
  return dir;
}

async function freePort(): Promise<number> {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  server.close();
  return port;
}

async function setupDaemon(): Promise<{ port: number; dataDir: string; brain: string }> {
  const port = await freePort();
  const empty = mkdtempSync(join(tmpdir(), 'hos-e2e-empty-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'hos-e2e-data-'));
  const brain = join(mkdtempSync(join(tmpdir(), 'hos-e2e-home-')), 'hos-brain');
  const daemon = spawn(
    process.execPath,
    [
      'dist/daemon/main.js',
      ...['--port', String(port), '--data-dir', dataDir, '--brain', brain, '--starter', starterRepo()],
      ...['--repo-root', empty, '--worktree-root', empty, '--agent', 'scripted', '--tmux-socket', join(dataDir, 'tmux.sock')],
    ],
    { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, HOS_BRAIN: '' } },
  );
  daemons.push(daemon);
  let output = '';
  await new Promise<void>((resolve, reject) => {
    daemon.stdout!.on('data', (chunk) => {
      output += String(chunk);
      if (output.includes('listening on')) resolve();
    });
    daemon.once('exit', () => reject(new Error(`daemon exited: ${output}`)));
  });
  return { port, dataDir, brain };
}

const shot = (page: Page, name: string, path: (name: string) => string) => page.screenshot({ path: path(`first-run-${name}.png`), fullPage: true });

test('with no brain hos starts in setup mode and walks the five screens: passkey, name and time zone, a brain from the starter, the coding agent, projects and phone, then a first chat', async ({ page }, info) => {
  const { port, dataDir, brain } = await setupDaemon();
  const out = (name: string) => info.outputPath(name);
  await virtualAuthenticator(page);
  await page.goto(`http://localhost:${port}/`);

  const gate = page.getByRole('main', { name: 'Sign in' });
  await expect(gate.getByRole('heading', { name: 'Set up hos' })).toBeVisible();
  await expect(gate.getByRole('list', { name: 'Setup steps' }).getByRole('listitem')).toHaveText(['1 You', '2 Brain', '3 Claude', '4 Projects', '5 Phone']);
  await gate.getByLabel('Setup code').fill(readFileSync(join(dataDir, 'enrolment-code'), 'utf8').trim());
  await shot(page, '1a-passkey', out);
  await gate.getByRole('button', { name: 'Create your hos passkey' }).click();

  const setup = page.getByRole('main', { name: 'Set up hos' });
  await expect(setup.getByRole('heading', { name: 'About you' })).toBeVisible();
  await setup.getByLabel('What should chats call you?').fill('Sam');
  await setup.getByLabel('Time zone').fill('Europe/Berlin');
  await shot(page, '1b-you', out);
  await setup.getByRole('button', { name: 'Continue' }).click();

  await expect(setup.getByRole('heading', { name: 'Your brain' })).toBeVisible();
  await expect(setup.getByLabel('Put it in')).toHaveValue(brain);
  await expect(setup.getByRole('radio', { name: /Create your brain from the starter/ })).toBeChecked();
  await setup.getByText('Prefer the command line?').click();
  await expect(setup.locator('pre')).toContainText(`hos init --adopt ${brain}`);
  await shot(page, '2-brain', out);
  await setup.getByRole('button', { name: 'Create my brain' }).click();

  await expect(setup.getByRole('heading', { name: 'Your coding agent' })).toBeVisible({ timeout: 30_000 });
  const policy = readFileSync(join(brain, 'hos', 'policy.yaml'), 'utf8');
  expect(policy.startsWith('version: 1  # schema version\napprovals:\n  preset: balanced  # reads and edits run, the rest asks\n')).toBe(true);
  expect(policy).toMatch(/owner: +# .*\n {2}name: Sam\n {2}timezone: Europe\/Berlin/);
  expect(existsSync(join(brain, '.claude', 'skills', 'hos', 'SKILL.md'))).toBe(true);
  expect(execFileSync('git', ['-C', brain, 'remote'], { encoding: 'utf8' }).trim()).toBe('starter');
  await expect(setup.getByRole('list', { name: 'Sign-in checks' }).getByRole('listitem').first()).toContainText('Claude login');
  await shot(page, '3-claude', out);
  await setup.getByRole('button', { name: /^Continue/ }).click();

  await expect(setup.getByRole('heading', { name: 'Your projects' })).toBeVisible();
  await expect(setup.getByRole('button', { name: 'Add a project' })).toBeVisible();
  await shot(page, '4-projects', out);
  await setup.getByRole('button', { name: 'Continue' }).click();

  await expect(setup.getByRole('heading', { name: 'Keep it running, reach it from your phone' })).toBeVisible();
  await setup.getByRole('radio', { name: /Tailscale/ }).check();
  await expect(setup.getByText(/transport: tailscale/)).toBeVisible();
  await shot(page, '5-phone', out);
  await setup.getByRole('button', { name: 'Continue' }).click();

  await expect(setup.getByRole('heading', { name: 'You’re set up' })).toBeVisible();
  await expect(setup.getByRole('list', { name: 'Starter prompts' }).getByRole('button')).toHaveCount(3);
  await shot(page, '6-done', out);
  await setup.getByRole('button', { name: 'Open hos' }).click();
  await expectShell(page);

  await page.goto(`http://localhost:${port}/#/settings/advanced`);
  const advanced = page.getByRole('list', { name: 'Advanced settings' });
  await expect(advanced.getByRole('listitem', { name: 'Your name' })).toContainText('Sam');
  await expect(advanced.getByRole('listitem', { name: 'Time zone' })).toContainText('Europe/Berlin');
  await page.getByRole('tab', { name: 'Approvals' }).click();
  await expect(page.getByRole('list', { name: 'Approvals settings' }).getByRole('listitem', { name: 'Preset' })).toContainText('Balanced');
  expect(readFileSync(join(dataDir, 'brain-path'), 'utf8').trim()).toBe(brain);

  await page.reload();
  await expectShell(page);
  expect(existsSync(join(brain, '.git'))).toBe(true);
});
