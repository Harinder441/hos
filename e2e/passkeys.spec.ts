import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectShell, virtualAuthenticator } from './access.js';
import { expect, test } from './test.js';

const daemons: ChildProcess[] = [];

test.afterEach(async ({ page }) => {
  await page.close();
  for (const daemon of daemons.splice(0)) {
    daemon.kill('SIGTERM');
    if (daemon.exitCode === null) await once(daemon, 'exit');
  }
});

function tempBrain(policy?: string): string {
  const brain = join(mkdtempSync(join(tmpdir(), 'hos-e2e-brain-')), 'my-brain');
  mkdirSync(join(brain, 'hos'), { recursive: true });
  writeFileSync(join(brain, 'CLAUDE.md'), '# e2e brain\n');
  if (policy) writeFileSync(join(brain, 'hos', 'policy.yaml'), policy);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: brain, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('-c', 'user.name=hos-e2e', '-c', 'user.email=hos@test.invalid', 'commit', '-q', '-m', 'init');
  return brain;
}

async function freePort(): Promise<number> {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  server.close();
  return port;
}

async function startDaemon(brain: string, extra: string[] = []): Promise<{ port: number; code: string }> {
  const port = await freePort();
  const empty = mkdtempSync(join(tmpdir(), 'hos-e2e-empty-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'hos-e2e-data-'));
  const daemon = spawn(
    process.execPath,
    [
      'dist/daemon/main.js',
      ...['--port', String(port), '--data-dir', dataDir, '--brain', brain],
      ...['--repo-root', empty, '--worktree-root', empty, '--agent', 'scripted', ...extra],
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  daemons.push(daemon);
  let output = '';
  for await (const chunk of daemon.stdout!) {
    output += String(chunk);
    if (output.includes('listening on')) return { port, code: readFileSync(join(dataDir, 'enrolment-code'), 'utf8').trim() };
  }
  throw new Error(`daemon exited: ${output}`);
}

test('on the first visit hos asks the user to create its passkey, which signs them in and survives a reload', async ({ page }) => {
  const { port, code } = await startDaemon(tempBrain());
  await virtualAuthenticator(page);
  await page.goto(`http://localhost:${port}/#/chats`);

  await expect(page.getByRole('button', { name: 'Sign in with passkey' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Create your hos passkey' }).click();
  await expect(page.getByRole('main', { name: 'Sign in' }).locator('.error')).toContainText('setup code');
  await page.getByLabel('Setup code').fill(code);
  await page.getByRole('button', { name: 'Create your hos passkey' }).click();
  await expectShell(page);

  await page.reload();
  await expectShell(page);
});
