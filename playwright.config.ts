import { defineConfig } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathWithRealGit } from './test/real-git.js';

const port = Number(process.env.HOS_E2E_PORT ?? 47317);
process.env.PATH = pathWithRealGit();
process.env.HOS_E2E_DATA_DIR ??= mkdtempSync(join(tmpdir(), 'hos-e2e-'));
process.env.HOS_E2E_BRAIN ??= tempBrain();
const empty = join(process.env.HOS_E2E_DATA_DIR, 'empty');
mkdirSync(empty, { recursive: true });
process.env.HOS_E2E_PUSH_TLS ??= pushTls();
process.env.HOS_E2E_SKILLS_HOME ??= skillsHome();

function skillsHome(): string {
  const home = join(process.env.HOS_E2E_DATA_DIR!, 'home');
  mkdirSync(join(home, '.claude/skills/tldr'), { recursive: true });
  writeFileSync(join(home, '.claude/skills/tldr/SKILL.md'), '---\nname: tldr\ndescription: Compress anything into ten lines or fewer.\n---\n');
  return home;
}

function pushTls(): string {
  const dir = join(process.env.HOS_E2E_DATA_DIR!, 'push-tls');
  mkdirSync(dir, { recursive: true });
  const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2', '-subj', '/CN=127.0.0.1'];
  const out = ['-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-addext', 'subjectAltName=IP:127.0.0.1'];
  if (!existsSync(join(dir, 'cert.pem'))) execFileSync('openssl', ['req', '-x509', ...ec, ...out], { stdio: 'ignore' });
  return dir;
}

function tempBrain(): string {
  const brain = join(mkdtempSync(join(tmpdir(), 'hos-e2e-brain-')), 'my-brain');
  mkdirSync(brain);
  writeFileSync(join(brain, 'README.md'), '# brain\n');
  writeFileSync(join(brain, 'CLAUDE.md'), '# e2e brain\n');
  mkdirSync(join(brain, '.claude/skills/work-in'), { recursive: true });
  writeFileSync(join(brain, '.claude/skills/work-in/SKILL.md'), '---\nname: work-in\ndescription: Work on a folder that is not the brain.\n---\n');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: brain, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('-c', 'user.name=hos-e2e', '-c', 'user.email=hos@test.invalid', 'commit', '-q', '-m', 'init');
  return brain;
}

export default defineConfig({
  testDir: 'e2e',
  globalTeardown: './e2e/teardown.ts',
  fullyParallel: true,
  workers: '80%',
  globalSetup: './e2e/global-setup.ts',
  use: { baseURL: `http://localhost:${port}`, browserName: 'chromium' },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 800 } } },
    { name: 'phone', grep: /@phone/, use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: {
    command: [
      `node dist/daemon/main.js --port ${port} --data-dir ${process.env.HOS_E2E_DATA_DIR}`,
      `--brain ${process.env.HOS_E2E_BRAIN} --repo-root ${empty} --worktree-root ${empty} --refresh-ms 300 --push-mute-ms 0`,
      `--agent scripted --tmux-socket ${join(process.env.HOS_E2E_DATA_DIR, 'tmux.sock')}`,
      `--gh-bin ${join(process.cwd(), 'test/fixtures/bin/fake-gh.mjs')}`,
    ].join(' '),
    env: {
      SHELL: '/bin/sh',
      HOS_FAKE_GH_DIR: join(process.env.HOS_E2E_DATA_DIR, 'gh'),
      NODE_EXTRA_CA_CERTS: join(process.env.HOS_E2E_PUSH_TLS, 'cert.pem'),
      HOS_CODE_BIN: join(process.cwd(), 'test/fixtures/bin/fake-hos-code.mjs'),
      HOS_SKILLS_HOME: process.env.HOS_E2E_SKILLS_HOME,
    },
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: false,
  },
});
