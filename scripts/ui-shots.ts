import { chromium, type Browser, type Locator, type Page } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { HosClient } from '../src/api/client.js';
import type { Chat, Topic, Workspace } from '../src/api/types.js';
import { FakeAuthenticator } from '../src/fakes/fake-authenticator.js';

// Usage: npx tsx scripts/ui-shots.ts [outDir] (UI states) | npx tsx scripts/ui-shots.ts --docs [outDir] (docs shots s1…s11)
const docs = process.argv[2] === '--docs';
const out = resolve(docs ? (process.argv[3] ?? 'docs/site/src/assets/shots') : (process.argv[2] ?? '.scratch/hos-one-brain/shots'));
const port = Number(process.env.HOS_SHOTS_PORT ?? 47398);
const base = `http://localhost:${port}`;
const root = realpathSync(mkdtempSync('/tmp/hos-ui-'));
const dataDir = join(root, 'data');
const empty = join(root, 'empty');
const bin = join(root, 'bin');
for (const dir of [dataDir, empty, bin]) mkdirSync(dir, { recursive: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=hos-demo', '-c', 'user.email=hos@test.invalid', ...args], { cwd, stdio: 'ignore' });

function write(dir: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

function repo(name: string, files: Record<string, string>): string {
  const dir = join(root, 'repos', name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  write(dir, { 'README.md': `# ${name}\n`, ...files });
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  const remote = join(root, 'remotes', `${name}.git`);
  mkdirSync(remote, { recursive: true });
  git(remote, 'init', '-q', '--bare');
  git(dir, 'remote', 'add', 'origin', remote);
  git(dir, 'push', '-q', '-u', 'origin', 'main');
  return dir;
}

const lines = (n: number, word: string) => Array.from({ length: n }, (_, i) => `${word} ${i + 1}\n`).join('');

const SETUP = `#!/bin/bash
case "$HOS_BRANCH" in
  notes-api-v2) while true; do sleep 1; done ;;
  font-fallback) echo "copy .env* from $HOS_ROOT_PATH"; echo "cp: .env.development: No such file or directory"; exit 1 ;;
esac
for f in "$HOS_ROOT_PATH"/.env*; do [ -f "$f" ] && cp -n "$f" "$HOS_WORKSPACE_PATH"/ && echo "copied $(basename "$f")"; done
exit 0
`;

// The starter's profiles, so the Profile chip in docs mode has something to offer (generic is built in).
const profile = (description: string, color: string, extra: string[] = []) => ['---', `description: ${description}`, `color: "${color}"`, ...extra, '---', ''].join('\n');
const PROFILES: Record<string, string> = {
  'profiles/engineer/PROFILE.md': profile('Writes code in a worktree; claims a task, locks its files, hands in a diff', '#4f9fd9'),
  'profiles/lead/PROFILE.md': profile('Splits a goal into tasks and starts helper chats to do them', '#d9a54f', ['turn_context: [roster, tasks, waiting]', 'context_refresh: true']),
  'profiles/product/PROFILE.md': profile('Shapes specs and tickets with you; writes no code', '#b07cd8', ['context_refresh: true']),
  'profiles/ritual/PROFILE.md': profile('Runs the scheduled briefs and reviews', '#5fb37a'),
};

const brain = repo('my-brain', {
  'CLAUDE.md': '# brain\n',
  '.claude/skills/work-in/SKILL.md': '# work-in\n',
  '.gitignore': '.context/\n',
  'hos/actions.yaml': [
    'version: 1',
    'setup:',
    '  run: scripts/workspace-setup.sh',
    "  does: Copies .env* from the repo's root checkout into the new worktree",
    '  skip: [robot-arm]',
    'actions:',
    '  - { name: run-tests, label: Run tests, run: bash scripts/buttons/run-tests.sh, where: host, cwd: worktree, confirm: false, passkey: false }',
    '  - { name: seed-db, label: Seed a dev database, run: bash scripts/buttons/seed-dev-db.sh, where: host, cwd: worktree, confirm: false, passkey: false, applies_to: [notes-api] }',
    '  - { name: deploy-staging, label: Deploy to staging, run: bash scripts/buttons/deploy-staging.sh, where: host, cwd: worktree, confirm: true, passkey: false, applies_to: [notes-api, sync-service] }',
    '  - { name: flash-esp32, label: Flash the ESP32, run: bash scripts/buttons/flash-esp32.sh, where: host, cwd: worktree, confirm: false, passkey: false, applies_to: [robot-arm] }',
    '',
  ].join('\n'),
  'hos/workspace-rules.yaml': ['version: 1', 'rules:', '  - repo: robot-arm', '    use: root', '    reason: The robot arm always uses main', ''].join('\n'),
  'scripts/workspace-setup.sh': SETUP,
  'scripts/buttons/run-tests.sh': '#!/bin/sh\necho 42 tests passed\n',
  'scripts/buttons/seed-dev-db.sh': '#!/bin/sh\necho seeded\n',
  'scripts/buttons/deploy-staging.sh': '#!/bin/sh\necho deployed\n',
  'scripts/buttons/flash-esp32.sh': '#!/bin/sh\necho flashed\n',
  ...(docs ? PROFILES : {}),
});
chmodSync(join(brain, 'scripts/workspace-setup.sh'), 0o755);
git(brain, 'commit', '-qam', 'setup script is executable');
git(brain, 'push', '-q');

const LIMITER_BEFORE = `import type { Request, Response, NextFunction } from 'express';

export function rateLimit(_req: Request, _res: Response, next: NextFunction) {
  next();
}
`;

const LIMITER_AFTER = `import type { Request, Response, NextFunction } from 'express';
import { buckets } from './buckets.js';

const PER_MINUTE = 120;

export function rateLimit(req: Request, res: Response, next: NextFunction) {
  const key = req.header('x-api-key') ?? req.ip;
  const bucket = buckets.take(key, PER_MINUTE);
  res.setHeader('RateLimit-Limit', PER_MINUTE);
  res.setHeader('RateLimit-Remaining', bucket.left);
  if (bucket.left < 0) {
    res.setHeader('Retry-After', Math.ceil(bucket.resetMs / 1000));
    return res.status(429).json({ error: 'rate_limited' });
  }
  next();
}
`;

const BUCKETS = `interface Bucket {
  left: number;
  resetMs: number;
}

const WINDOW_MS = 60_000;
const store = new Map<string, { count: number; start: number }>();

export const buckets = {
  take(key: string, limit: number): Bucket {
    const now = Date.now();
    const seen = store.get(key);
    const entry = seen && now - seen.start < WINDOW_MS ? seen : { count: 0, start: now };
    entry.count += 1;
    store.set(key, entry);
    return { left: limit - entry.count, resetMs: WINDOW_MS - (now - entry.start) };
  },
};
`;

const notesApi = repo('notes-api', {
  'src/limits/limiter.ts': 'export {};\n',
  'src/limits/config.ts': lines(20, 'limit'),
  'src/middleware/rate-limit.ts': LIMITER_BEFORE,
  'src/http/errors.ts': "export const notFound = { error: 'not_found' };\n",
  '.env': 'API_SECRET=x\n',
});
const syncService = repo('sync-service', { 'src/models/share.ts': lines(10, 'share') });
const notesWeb = repo('notes-web', { 'src/components/SharePreview.tsx': lines(12, 'preview'), 'src/settings/theme.css': ':root {\n  --bg: #fff;\n}\n' });
const mobileApp = repo('mobile-app', { 'src/sync/OfflineQueue.ts': lines(14, 'queue') });
const robotArm = repo('robot-arm', { 'firmware/main.cpp': 'int main() {}\n' });

const todayTasks = [
  'Review the rate-limit PR before the release',
  'Add a quota preview to the admin',
  'Fix the search ranking off-by-one',
  'Write the 2.14 release notes',
  'Renew the staging TLS certificate',
];

async function main() {
  const daemon = spawn(
    process.execPath,
    [
      'dist/daemon/main.js',
      ...['--port', String(port), '--data-dir', dataDir, '--brain', brain, '--repo-root', empty, '--worktree-root', empty],
      ...['--refresh-ms', '300', '--agent', 'scripted', '--tmux-socket', join(dataDir, 'tmux.sock')],
      ...['--gh-bin', resolve('test/fixtures/bin/fake-gh.mjs')],
    ],
    {
      env: {
        ...process.env,
        SHELL: '/bin/sh',
        HOS_CODE_BIN: resolve('test/fixtures/bin/fake-hos-code.mjs'),
        HOS_FAKE_GH_DIR: join(dataDir, 'gh'),
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );
  let browser: Browser | undefined;
  try {
    let output = '';
    for await (const chunk of daemon.stdout!) {
      output += String(chunk);
      if (output.includes('listening on')) break;
    }
    browser = await chromium.launch();
    mkdirSync(out, { recursive: true });
    // S6 needs the enrolment screen, so it is shot before the passkey exists.
    if (docs) await shootEnrolment(browser);
    const passkey = new FakeAuthenticator(base);
    const code = readFileSync(join(dataDir, 'enrolment-code'), 'utf8').trim();
    const api = new HosClient(`http://127.0.0.1:${port}`, { authenticator: passkey });
    await api.registerPasskey(code);
    for (const title of todayTasks) await api.capture(title);
    const open = async (size: 'desktop' | 'phone') => {
      const context = await browser!.newContext(
        size === 'desktop'
          ? { viewport: { width: 1280, height: 800 }, colorScheme: 'dark' }
          : { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme: 'dark' },
      );
      await context.addInitScript((t) => localStorage.setItem('hos.session', t), api.sessionToken!);
      const page = await context.newPage();
      page.on('pageerror', (error) => console.error(`page error (${size}): ${error.message}`));
      return page;
    };
    if (docs) {
      const ids = await seedDocs(api);
      await shootDocs(api, ids, { desktop: await open('desktop'), phone: await open('phone') });
    } else {
      const ids = await seed(api);
      await shoot(api, ids, { desktop: await open('desktop'), phone: await open('phone') });
    }
  } finally {
    await browser?.close();
    daemon.kill('SIGTERM');
    try {
      execFileSync('tmux', ['-S', join(dataDir, 'tmux.sock'), 'kill-server'], { stdio: 'ignore' });
    } catch {}
  }
}

type Ids = Awaited<ReturnType<typeof seed>>;
type Size = 'desktop' | 'phone';
type Pages = Record<Size, Page>;

async function shot(page: Page, size: Size, name: string) {
  if (!name.includes('hover')) await page.mouse.move(1, 1).catch(() => {});
  await sleep(250);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: join(out, `${name}-${size}.png`) });
  await page.emulateMedia({ colorScheme: 'light' });
  await sleep(150);
  await page.screenshot({ path: join(out, `${name}-${size}-light.png`) });
  await page.emulateMedia({ colorScheme: 'dark' });
  console.log(`${name}-${size}`);
}

async function go(page: Page, hash: string) {
  await page.goto(`${base}/${hash}`);
  await page.reload();
  await page.getByRole('main').getByRole('heading', { level: 1 }).first().waitFor();
  await sleep(700);
}

async function panelFor(page: Page, size: Size) {
  const toggle = page.getByRole('button', { name: 'Toggle the workspaces panel' });
  await toggle.waitFor({ timeout: 30_000 });
  const panel = page.getByRole('complementary', { name: 'Workspaces panel' });
  if (size === 'phone' && !(await panel.isVisible())) await toggle.click();
  await panel.getByRole('region').first().waitFor({ timeout: 30_000 });
  await sleep(400);
  return panel;
}

async function sideWorkspaces(page: Page) {
  const section = page.getByRole('region', { name: 'Workspaces' });
  const head = section.getByRole('button', { name: 'Workspaces', exact: true });
  if ((await head.getAttribute('aria-expanded')) === 'false') await head.click();
  await sleep(300);
  return section;
}

async function drawer(page: Page) {
  await page.getByRole('navigation', { name: 'Tabs' }).getByRole('button', { name: 'Chats' }).click();
  await sleep(300);
}

async function shoot(api: HosClient, ids: Ids, pages: Pages) {
  const both = async (name: string, act: (page: Page, size: Size) => Promise<void>, sizes: Size[] = ['desktop', 'phone']) => {
    for (const size of sizes) {
      await act(pages[size], size);
      await shot(pages[size], size, name);
    }
  };
  const topic = (key: keyof Ids['topics']) => (page: Page) => go(page, `#/topic/${ids.topics[key]}`);

  await both('state-sidebar-unseen', (p) => go(p, '#/'), ['desktop']);
  await both('state-sidebar-drawer', async (p) => {
    await go(p, '#/');
    await drawer(p);
  }, ['phone']);
  await both('state-sidebar-drawer-workspaces', async (p) => {
    await p.evaluate(() => {
      const scroll = document.querySelector('.side-scroll');
      if (scroll) scroll.scrollTop = scroll.scrollHeight;
    });
  }, ['phone']);
  await both('state-sidebar-more-tab', async (p) => {
    await go(p, '#/');
    await p.getByRole('navigation', { name: 'Tabs' }).getByRole('button', { name: 'More' }).click();
  }, ['phone']);
  await both('state-sidebar-palette', async (p) => {
    await go(p, '#/');
    await p.keyboard.press('Meta+k');
  }, ['desktop']);
  await both('state-sidebar-root-menu', async (p) => {
    await go(p, '#/');
    const row = (await sideWorkspaces(p)).getByRole('group', { name: 'notes-api' }).getByRole('listitem', { name: 'Root main' });
    await row.hover();
    await row.getByRole('button', { name: /^Actions for / }).click();
  }, ['desktop']);
  await both('state-sidebar-worktree-menu', async (p) => {
    await go(p, '#/');
    const row = (await sideWorkspaces(p)).getByRole('group', { name: 'notes-api' }).getByRole('listitem', { name: 'Worktree notes-api-v2' });
    await row.hover();
    await row.getByRole('button', { name: /^Actions for / }).click();
  }, ['desktop']);

  await both('state-sidebar-seen', topic('offlineSync'), ['desktop']);
  await both('state-sidebar-seen-home', async (p) => {
    await go(p, `#/topic/${ids.topics.offlineSync}`);
    await go(p, '#/');
  });

  await both('chat', topic('rateLimit'));
  await both('state-chat-thread-plan-card', topic('rateLimit'));
  await both('state-chat-thread-approval-folded', topic('searchBug'));
  await both('state-chat-thread-approval-unfolded', async (p) => {
    await topic('searchBug')(p);
    await p.getByRole('main').getByText('Details').last().click();
  });
  await both('state-chat-thread-question', topic('offlineSync'));
  await both('state-chat-thread-menu', async (p) => {
    await topic('rateLimit')(p);
    await p.getByRole('button', { name: 'More for this topic' }).click();
  });
  await both('state-chat-thread-attachment-pending', async (p) => {
    await topic('darkMode')(p);
    await dropFile(p);
  }, ['desktop']);
  await both('state-chat-thread-attachment-chip', async (p, size) => {
    await topic('darkMode')(p);
    await dropFile(p);
    const main = p.getByRole('main');
    await main.getByLabel('Message').fill(`Use the notes from last week as the outline (${size})`);
    await main.getByRole('button', { name: 'Send' }).click();
    await main.getByText(`Echo: Use the notes from last week as the outline (${size})`).waitFor();
  });
  await both('state-chat-thread-stop', async (p) => {
    await topic('releaseNotes')(p);
    const main = p.getByRole('main');
    await main.getByLabel('Message').fill(`slowly ${'and on '.repeat(80)}done`);
    await main.getByRole('button', { name: 'Send' }).click();
    await main.getByRole('button', { name: 'Stop' }).waitFor();
  });
  await both('state-chat-thread-queued', async (p) => {
    const main = p.getByRole('main');
    await main.getByLabel('Message').fill('Also cover the 429 response body');
    await main.getByLabel('Message').press('Enter');
    await main.getByRole('status', { name: 'Queued message' }).waitFor();
  }, ['desktop']);
  await sleep(6000);

  const panelState = async (name: string, key: keyof Ids['topics'], act?: (panel: Locator) => Promise<void>) =>
    both(name, async (p, size) => {
      await topic(key)(p);
      const panel = await panelFor(p, size);
      if (act) await act(panel);
    });
  await panelState('state-chat-panel-dirty', 'rateLimit');
  await panelState('state-chat-panel-dirty-touched-open', 'rateLimit', async (panel) => {
    await panel.getByText('Touched by this topic').click();
  });
  await panelState('state-chat-panel-ahead-and-behind', 'sharePreview');
  await panelState('state-chat-panel-no-pr', 'offlineSync');
  await panelState('state-chat-panel-clean', 'releaseNotes');
  await panelState('state-chat-panel-setting-up', 'apiV2');
  await panelState('state-chat-panel-failed', 'fontBug', async (panel) => {
    await panel.getByText('Setup log').click();
    await panel.locator('.panel-log pre').getByText('exited').waitFor();
  });
  await both('state-chat-panel-brain-only', topic('darkMode'));
  await api.attachWorkspace(ids.topics.darkMode, ids.workspaces.notesApiRoot);
  await both('state-chat-panel-workspace-added', async (p, size) => {
    await panelFor(p, size);
  });
  await api.detachWorkspace(ids.topics.darkMode, ids.workspaces.notesApiRoot);

  for (const size of ['desktop', 'phone'] as const) {
    const page = pages[size];
    const pickTopic = ids.picks[size].pick;
    await go(page, `#/topic/${pickTopic}`);
    await api.sendMessage(ids.picks[size].pickChat, 'choose notes-api The limiter lives in notes-api; the web app only calls it.');
    const picker = page.getByRole('region', { name: 'Pick a notes-api workspace' });
    await picker.getByRole('radio').first().waitFor();
    await sleep(500);
    await shot(page, size, 'state-chat-picker-open');
    const branch = picker.getByRole('textbox', { name: 'Branch' });
    await branch.fill('quota-headers');
    await branch.focus();
    await shot(page, size, 'state-chat-picker-new-name');
    await branch.press('ArrowUp');
    await shot(page, size, 'state-chat-picker-existing');
    await page.keyboard.press('ArrowDown');
    await branch.fill(size === 'desktop' ? 'quota-headers' : 'quota-emails');
    await branch.press('Enter');
    await page.getByRole('main').getByText(/^Working in notes-api · quota-/).waitFor();
    await sleep(500);
    await shot(page, size, 'state-chat-picker-receipt');

    await go(page, `#/topic/${ids.picks[size].rule}`);
    await api.sendMessage(ids.picks[size].ruleChat, 'choose robot-arm Flash the motor driver');
    await page.getByRole('main').getByText(/Brain rule: The robot arm always uses main/).waitFor();
    await sleep(500);
    await shot(page, size, 'state-chat-picker-rule');
  }

  await both('new-chat', (p) => go(p, '#/new'));
  await both('state-new-chat-empty', (p) => go(p, '#/new'));
  await both('state-new-chat-prefilled', (p) => go(p, `#/new?prompt=${encodeURIComponent('Add a quota preview to the admin')}`));
  await both('state-new-chat-topic-created', async (p, size) => {
    await go(p, `#/new?prompt=${encodeURIComponent(size === 'desktop' ? 'Add a quota preview to the admin' : 'Add a quota preview to the weekly email')}`);
    await p.getByLabel('Prompt for the new topic').press('Enter');
    await p.waitForURL(/#\/topic\//);
    await p.getByRole('main').getByText(/^Echo: Add a quota preview/).waitFor();
  });

  await api.sendMessage(ids.chats.usage, 'limit five_hour 86');
  await sleep(800);
  await api.sendMessage(ids.chats.usage, 'limit seven_day 41');
  await sleep(1500);
  await both('home', (p) => go(p, '#/'));
  await both('state-home-needs-present', (p) => go(p, '#/'));
  await both('state-home-alert-banner', (p) => go(p, '#/'));
  await both('state-home-hand-hover', async (p, size) => {
    await go(p, '#/');
    const row = p.getByRole('list', { name: 'Today' }).getByRole('listitem').nth(1);
    await row.scrollIntoViewIfNeeded();
    if (size === 'desktop') await row.hover();
  });

  await go(pages.desktop, `#/topic/${ids.topics.rateLimit}`);
  await pages.desktop.keyboard.press('Enter');
  await pages.desktop.getByRole('main').getByText('Plan approved').waitFor();
  await shot(pages.desktop, 'desktop', 'state-chat-thread-plan-approved-key');
  await go(pages.desktop, `#/topic/${ids.topics.searchBug}`);
  await pages.desktop.keyboard.press('Backspace');
  await pages.desktop.getByRole('main').getByText(/^Denied: /).waitFor();
  await shot(pages.desktop, 'desktop', 'state-chat-thread-approval-denied-key');
  await go(pages.desktop, `#/topic/${ids.topics.offlineSync}`);
  await pages.desktop.keyboard.press('1');
  await pages.desktop.getByRole('main').getByText(/^Answered: /).waitFor();
  await shot(pages.desktop, 'desktop', 'state-chat-thread-question-answered-key');
  await sleep(1500);
  await both('state-home-needs-empty', (p) => go(p, '#/'));

  await both('state-sidebar-all-seen', async (p) => {
    await go(p, '#/');
    const all = p.getByRole('button', { name: 'Mark all seen' });
    if (await all.isVisible()) await all.click();
    await sleep(500);
  }, ['desktop']);
}

async function dropFile(page: Page) {
  await page.getByRole('main').getByRole('form', { name: 'Composer' }).evaluate((form) => {
    const data = new DataTransfer();
    data.items.add(new File(['token,dark\nsurface,#16181d\ntext,#e6e6e6\n'], 'dark-mode-notes.md', { type: 'text/markdown' }));
    form.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
  });
  await page.getByText('copies to topic attachments').first().waitFor();
  await page.locator('.thread-pending .thread-att[title^=".context/"]').first().waitFor();
}

function helpers(api: HosClient) {
  const say = async (chat: Chat | string, text: string, wait = 700) => {
    await api.sendMessage(typeof chat === 'string' ? chat : chat.id, text);
    await sleep(wait);
  };
  const approveAll = async (chat: Chat) => {
    for (let i = 0; i < 20; i++) {
      const pending = (await api.listApprovals()).filter((a) => a.chatId === chat.id && !a.decision);
      if (pending.length) {
        for (const approval of pending) await api.decideApproval(approval.id, 'approve', { via: 'mac' });
        await sleep(600);
        return;
      }
      await sleep(150);
    }
  };
  const until = async (check: () => Promise<boolean>) => {
    for (let i = 0; i < 100 && !(await check()); i++) await sleep(150);
  };
  const ready = (id: string) => until(async () => (await api.listWorkspaces()).find((w) => w.id === id)?.setup !== 'pending');
  const projectsOf = async (repos: Record<string, string>) =>
    Object.fromEntries(await Promise.all(Object.entries(repos).map(async ([key, path]) => [key, await api.createProject(path)] as const)));
  return { say, approveAll, until, ready, projectsOf };
}

async function seed(api: HosClient) {
  const { say, approveAll, until, ready, projectsOf } = helpers(api);
  const projects = await projectsOf({ notesApi, syncService, notesWeb, mobileApp, robotArm });
  const worktree = async (project: string, branch: string): Promise<Workspace> => {
    const workspace = await api.createWorkspace({ projectId: projects[project]!.id, kind: 'worktree', branch });
    await ready(workspace.id);
    return workspace;
  };
  const rootOf = (project: string) => api.createWorkspace({ projectId: projects[project]!.id, kind: 'root' });
  const topicWith = async (title: string, workspaces: Workspace[] = []): Promise<{ topic: Topic; chat: Chat }> => {
    const topic = await api.createTopic({ title, ...(workspaces[0] ? { workspaceId: workspaces[0].id } : {}) });
    for (const workspace of workspaces.slice(1)) await api.attachWorkspace(topic.id, workspace.id);
    return { topic, chat: await api.createChat(topic.id) };
  };

  const notesApiRoot = await rootOf('notesApi');
  const rateLimitWs = await worktree('notesApi', 'rate-limit');
  const apiV2Ws = await api.createWorkspace({ projectId: projects.notesApi!.id, kind: 'worktree', branch: 'notes-api-v2' });
  const shareBackend = await worktree('syncService', 'share-preview');
  const shareFrontend = await worktree('notesWeb', 'share-preview');
  const fontWs = await api.createWorkspace({ projectId: projects.notesWeb!.id, kind: 'worktree', branch: 'font-fallback' });
  const mobileRoot = await rootOf('mobileApp');
  const offlineWs = await worktree('mobileApp', 'offline-sync');

  write(shareBackend.path, { 'src/routes/share-preview.ts': lines(64, 'route'), 'src/models/share.ts': lines(12, 'model') });
  git(shareBackend.path, 'add', '.');
  git(shareBackend.path, 'commit', '-q', '-m', 'preview endpoint');
  git(shareBackend.path, 'push', '-q', '-u', 'origin', 'share-preview');
  write(shareBackend.path, { 'src/routes/share-preview.ts': lines(70, 'route') });
  git(shareBackend.path, 'commit', '-qam', 'cache the preview');
  write(shareBackend.path, { 'src/routes/share-preview.ts': lines(76, 'route') });
  git(shareBackend.path, 'commit', '-qam', 'preview errors');

  write(shareFrontend.path, { 'src/share/PreviewCard.tsx': lines(88, 'card'), 'src/share/preview.css': lines(141, 'css'), 'src/components/SharePreview.tsx': lines(40, 'preview') });
  git(shareFrontend.path, 'add', '.');
  git(shareFrontend.path, 'commit', '-q', '-m', 'share preview card');
  git(shareFrontend.path, 'push', '-q', '-u', 'origin', 'share-preview');
  const clone = join(root, 'clone-notes-web');
  execFileSync('git', ['clone', '-q', '-b', 'share-preview', join(root, 'remotes', 'notes-web.git'), clone], { stdio: 'ignore' });
  for (const n of [1, 2, 3]) {
    write(clone, { [`src/components/review-${n}.ts`]: 'export {};\n' });
    git(clone, 'add', '.');
    git(clone, 'commit', '-q', '-m', `review ${n}`);
  }
  git(clone, 'push', '-q', 'origin', 'share-preview');
  git(shareFrontend.path, 'fetch', '-q', 'origin');
  mkdirSync(join(dataDir, 'gh'), { recursive: true });
  writeFileSync(join(dataDir, 'gh', 'gh-prs.json'), JSON.stringify({ [`${shareFrontend.path}#share-preview`]: 412 }));

  write(offlineWs.path, { 'src/sync/OfflineQueue.ts': lines(98, 'queue'), 'src/sync/useReconnect.ts': lines(58, 'reconnect') });
  git(offlineWs.path, 'add', '.');
  git(offlineWs.path, 'commit', '-q', '-m', 'offline queue');
  git(offlineWs.path, 'push', '-q', '-u', 'origin', 'offline-sync');

  const rateLimit = await topicWith('Rate-limit the public API', [rateLimitWs]);
  await say(rateLimit.chat, 'spawn worker Limiter middleware', 1200);
  await say(rateLimit.chat, 'spawn scout Redis token bucket', 1200);
  await say(rateLimit.chat, 'write scratch.ts');
  await approveAll(rateLimit.chat);
  write(rateLimitWs.path, {
    'src/limits/limiter.ts': lines(48, 'limiter'),
    'src/routes/limits.ts': lines(31, 'route'),
    'src/limits/limiter.test.ts': lines(52, 'test'),
    'src/http/headers.ts': lines(7, 'header'),
    'src/limits/config.ts': lines(4, 'limit'),
  });
  await say(rateLimit.chat, 'plan Enforce limits in the API gateway, not per route', 1200);

  const offlineSync = await topicWith('Offline sync for notes', [offlineWs]);
  await say(offlineSync.chat, 'park', 1200);

  const searchBug = await topicWith('Search results ranking bug', [mobileRoot]);
  await say(searchBug.chat, 'write ranking.ts', 1200);

  const sharePreview = await topicWith('Shared note preview', [shareBackend, shareFrontend]);
  await say(sharePreview.chat, 'Wire the preview card to the new endpoint');
  await say(sharePreview.chat, 'spawn worker Preview card', 1200);

  const apiV2 = await topicWith('Notes API v2 refactor', [apiV2Ws]);
  await say(apiV2.chat, 'Split the notes API by workspace');

  const fontBug = await topicWith('Editor font fallback bug', [fontWs]);
  await say(fontBug.chat, 'fail');

  const releaseNotes = await topicWith('2.14 release notes', [notesApiRoot]);
  await say(releaseNotes.chat, 'Write the 2.14 release notes into the brain');
  await api.setTopicState(releaseNotes.topic.id, 'done');

  const darkMode = await topicWith('Dark mode for settings');
  await say(darkMode.chat, 'Sketch the dark palette for the settings screens');

  const picks = {} as Record<Size, { pick: string; pickChat: string; rule: string; ruleChat: string }>;
  for (const [size, title, rule] of [
    ['desktop', 'API quota headers', 'Rover motor driver'],
    ['phone', 'API quota emails', 'Rover battery monitor'],
  ] as const) {
    const pick = await topicWith(title);
    const ruled = await topicWith(rule);
    picks[size] = { pick: pick.topic.id, pickChat: pick.chat.id, rule: ruled.topic.id, ruleChat: ruled.chat.id };
  }
  await until(async () => (await api.listWorkspaces()).find((w) => w.id === fontWs.id)?.setup === 'failed');
  await sleep(1500);
  return {
    topics: {
      rateLimit: rateLimit.topic.id,
      offlineSync: offlineSync.topic.id,
      searchBug: searchBug.topic.id,
      sharePreview: sharePreview.topic.id,
      apiV2: apiV2.topic.id,
      fontBug: fontBug.topic.id,
      releaseNotes: releaseNotes.topic.id,
      darkMode: darkMode.topic.id,
    },
    chats: { usage: darkMode.chat.id },
    workspaces: { notesApiRoot: notesApiRoot.id },
    picks,
  };
}

// ---------------------------------------------------------------- docs mode

const SYNC_FLOW = {
  title: 'How an offline edit reaches the server',
  submit: 'Send my pick',
  blocks: [
    {
      id: 'f1',
      kind: 'flow',
      title: 'Offline edit → synced note',
      dir: 'LR',
      nodes: [
        { id: 'edit', label: 'Edit offline', sub: 'phone, no signal' },
        { id: 'queue', label: 'Queue the change', sub: 'local outbox' },
        { id: 'back', label: 'Back online', sub: 'reconnect' },
        { id: 'clash', label: 'Changed on server?', shape: 'diamond' },
        { id: 'apply', label: 'Apply', sub: 'fast path' },
        { id: 'merge', label: 'Merge by field', sub: 'newest wins per field' },
      ],
      edges: ['edit>queue', 'queue>back', 'back>clash', 'clash>apply:no', 'clash>merge:yes'],
    },
    {
      id: 'q1',
      kind: 'choice',
      prompt: 'Two phones edit the same note offline. What should win?',
      options: ['The newest edit, field by field', 'Whichever phone syncs first', 'Ask me each time'],
      node: 'merge',
    },
  ],
};

async function docShot(page: Page, name: string, target?: Locator) {
  await page.mouse.move(1, 1).catch(() => {});
  await sleep(300);
  await page.emulateMedia({ colorScheme: 'dark' });
  const path = join(out, `${name}.png`);
  if (target) await target.screenshot({ path });
  else await page.screenshot({ path });
  console.log(`${name}.png ${Math.round(statSync(path).size / 1024)} KB`);
}

async function shootEnrolment(browser: Browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
  const page = await context.newPage();
  await page.goto(`${base}/`);
  const box = page.getByLabel('Setup code');
  await box.waitFor({ timeout: 30_000 });
  await box.fill('a7k2pm9qxr');
  await docShot(page, 's6-enrolment');
  await context.close();
}

async function seedDocs(api: HosClient) {
  const { say, until, ready, projectsOf } = helpers(api);
  const projects = await projectsOf({ notesApi, notesWeb, mobileApp, robotArm });
  const worktree = async (project: string, branch: string): Promise<Workspace> => {
    const workspace = await api.createWorkspace({ projectId: projects[project]!.id, kind: 'worktree', branch });
    await ready(workspace.id);
    return workspace;
  };
  const rootOf = (project: string) => api.createWorkspace({ projectId: projects[project]!.id, kind: 'root' });
  const topicWith = async (title: string, workspaces: Workspace[], profile?: string): Promise<{ topic: Topic; chat: Chat }> => {
    const topic = await api.createTopic({ title, ...(workspaces[0] ? { workspaceId: workspaces[0].id } : {}) });
    for (const workspace of workspaces.slice(1)) await api.attachWorkspace(topic.id, workspace.id);
    const chat = await api.addTopicChat(topic.id, profile ? { profile } : {});
    return { topic, chat };
  };
  const pending = (chatId: string) => until(async () => (await api.listApprovals()).some((a) => a.chatId === chatId && !a.decision));
  const children = async (parentId: string) =>
    Object.values((await api.snapshot()).state.chats)
      .filter((c) => c.parentId === parentId)
      .sort((a, b) => a.createdAt - b.createdAt);

  await rootOf('notesApi');
  const rateLimitWs = await worktree('notesApi', 'rate-limit');
  await worktree('notesApi', 'search-ranking');
  const darkModeWs = await worktree('notesWeb', 'dark-mode');
  await rootOf('mobileApp');

  // S1/S2: a lead with three tasks, three helpers, two of them holding locks, and its own approval card.
  const lead = await topicWith('Rate-limit the public API', [rateLimitWs], 'lead');
  await say(lead.chat, 'Split the rate limiting into tasks and start helpers');
  const tasks = [
    { title: 'Token-bucket limiter middleware for the public API', priority: 1 as const, criteria: ['120 requests a minute per key', 'unit tests pass'] },
    { title: 'Return 429 with a Retry-After header', priority: 1 as const, criteria: ['body says rate_limited'] },
    { title: 'Document the limits in the API reference', priority: 2 as const, criteria: [] },
  ];
  for (const task of tasks) await api.addTask(lead.topic.id, task);
  await say(lead.chat, 'spawn writer src/middleware/rate-limit.ts Limiter middleware', 1500);
  await say(lead.chat, 'spawn writer src/http/errors.ts 429 responses', 1500);
  await say(lead.chat, 'spawn reviewer Review the limiter diff', 1500);
  await until(async () => (await children(lead.chat.id)).length >= 3);
  const [limiter, errors, reviewer] = await children(lead.chat.id);
  await sleep(1500);
  await say(limiter!, 'claim T1', 900);
  await say(limiter!, 'lock src/limits/buckets.ts', 900);
  await say(errors!, 'claim T2', 900);
  await say(errors!, 'lock src/http/headers.ts', 900);
  await say(lead.chat, 'write RATE_LIMITS.md', 1200);
  await pending(lead.chat.id);

  // S8: real code in the rate-limit worktree for the diff page.
  write(rateLimitWs.path, { 'src/middleware/rate-limit.ts': LIMITER_AFTER, 'src/limits/buckets.ts': BUCKETS });

  // S3: a chat that refreshed its context through PROGRESS.md.
  const brainProject = (await api.listProjects()).find((p) => p.brain);
  const brainRoot = brainProject ? [await api.createWorkspace({ projectId: brainProject.id, kind: 'root' })] : [];
  const notes = await topicWith('2.14 release notes', brainRoot, 'product');
  await say(notes.chat, 'Collect what shipped since 2.13 and draft the release notes', 1200);
  await api.refreshContext(notes.chat.id);
  await until(async () => (await api.chatTimeline(notes.chat.id)).some((i) => i.kind === 'message' && /context is fresh/.test(i.text)));

  // S5: a chat asking which notes-api checkout to work in.
  const search = await topicWith('Search results ranking bug', []);
  await say(search.chat, 'Exact title matches rank below older notes; find out why', 1000);

  // S7/S9: an approval waiting in a small topic.
  const darkMode = await topicWith('Dark mode for settings', [darkModeWs], 'engineer');
  await say(darkMode.chat, 'Add the dark palette to the settings screens', 1200);
  await say(darkMode.chat, 'Keep text contrast at AA or better', 1000);
  await say(darkMode.chat, 'Use the surface tokens from the design file', 1000);
  await say(darkMode.chat, 'write theme.css', 1200);
  await pending(darkMode.chat.id);

  // S11: a canvas with a small flow.
  const sync = await topicWith('Offline sync for notes', []);
  await say(sync.chat, 'Show me how an offline edit gets merged', 900);
  await say(sync.chat, `canvas create ${JSON.stringify(SYNC_FLOW)}`, 2000);
  await sleep(1500);
  return { lead, helpers: { limiter: limiter!, errors: errors!, reviewer: reviewer! }, notes, search, darkMode, sync, rateLimitWs };
}

type DocIds = Awaited<ReturnType<typeof seedDocs>>;

async function shootDocs(api: HosClient, ids: DocIds, pages: Pages) {
  const desk = pages.desktop;
  const topic = (t: Topic, chat?: Chat) => go(desk, `#/topic/${t.id}${chat ? `/chat/${chat.id}` : ''}`);
  const showPanel = async (page: Page, view: 'Tasks' | 'Workspaces') => {
    const panel = page.getByRole('complementary', { name: 'Workspaces panel' });
    if (!(await panel.isVisible())) await page.getByRole('button', { name: 'Toggle the workspaces panel' }).click();
    await panel.getByRole('tab', { name: new RegExp(`^${view}`) }).click();
    await sleep(500);
    return panel;
  };

  // S1: the lead's thread with its approval card, tasks beside it.
  await topic(ids.lead.topic, ids.lead.chat);
  await desk.getByRole('main').getByRole('group', { name: /^Permission request/ }).waitFor();
  await showPanel(desk, 'Tasks');
  await docShot(desk, 's1-lead');

  // S2: a helper's tab with its claim and lock calls opened, a task opened to show who claimed it, sidebar hidden so every tab shows.
  await topic(ids.lead.topic, ids.helpers.limiter);
  await desk.getByRole('button', { name: 'Hide sidebar' }).click();
  const panel = await showPanel(desk, 'Tasks');
  await panel.getByRole('button', { name: /Token-bucket limiter/ }).click();
  const turns = desk.getByRole('main').locator('details.turn');
  const count = await turns.count();
  for (let i = 0; i < count; i++) {
    const text = (await turns.nth(i).locator('summary').textContent()) ?? '';
    if (/lock|claim/i.test(text)) await turns.nth(i).locator('summary').click();
  }
  await docShot(desk, 's2-team');
  await desk.getByRole('button', { name: 'Show sidebar' }).click();

  // S3: the chat after a context refresh through PROGRESS.md.
  await topic(ids.notes.topic, ids.notes.chat);
  const refreshed = desk.getByRole('main').locator('details.turn').filter({ hasText: /progress/i });
  if (await refreshed.count()) await refreshed.last().locator('summary').click();
  const brainPanel = await showPanel(desk, 'Workspaces');
  const touched = brainPanel.getByText('Touched by this topic');
  if (await touched.count()) await touched.first().click();
  await docShot(desk, 's3-progress');

  // S4: New chat with the Profile chip open.
  await go(desk, '#/new');
  await desk.getByRole('button', { name: /^Profile: / }).click();
  await sleep(400);
  await docShot(desk, 's4-profiles');

  // S5: the workspace picker.
  await topic(ids.search.topic, ids.search.chat);
  await api.sendMessage(ids.search.chat.id, 'choose notes-api The ranking code lives in notes-api; the apps only show the results.');
  const picker = desk.getByRole('region', { name: 'Pick a notes-api workspace' });
  await picker.getByRole('radio').first().waitFor();
  await sleep(600);
  await docShot(desk, 's5-workspaces');

  // S7: phone, an approval answered in one tap.
  await go(pages.phone, `#/topic/${ids.darkMode.topic.id}`);
  await pages.phone.getByRole('main').getByRole('group', { name: /^Permission request/ }).waitFor();
  await docShot(pages.phone, 's7-phone-approval');

  // S8: the diff page with a line comment.
  await go(desk, `#/diff/workspace/${ids.rateLimitWs.id}`);
  const diff = desk.getByRole('region', { name: 'Diff' });
  const file = diff.getByRole('article', { name: 'Changes to src/middleware/rate-limit.ts' });
  await file.locator('[data-line="7"][data-line-type="change-addition"]').first().click();
  await diff.getByLabel('Comment on src/middleware/rate-limit.ts line 7').fill('Read the limit from config, not a constant');
  await diff.getByRole('button', { name: 'Add comment' }).click();
  await sleep(400);
  await file.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await docShot(desk, 's8-diff');

  // S9: an approval card and the stop-all confirm.
  await topic(ids.darkMode.topic, ids.darkMode.chat);
  await desk.getByRole('main').getByRole('group', { name: /^Permission request/ }).waitFor();
  await desk.keyboard.press('Meta+k');
  await desk.keyboard.type('Stop all');
  await sleep(300);
  await desk.keyboard.press('Enter');
  await desk.getByRole('alertdialog', { name: 'Stop all chats?' }).waitFor();
  await docShot(desk, 's9-guardrails');
  await desk.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();

  // S10: Settings, phone & remote access.
  await go(desk, '#/settings/remote');
  await desk.getByRole('heading', { name: 'How you reach this computer' }).evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await docShot(desk, 's10-remote-access');

  // S11: the canvas card in the thread.
  await topic(ids.sync.topic, ids.sync.chat);
  const canvas = desk.locator('section.cv').first();
  await canvas.waitFor();
  const side = desk.getByRole('complementary', { name: 'Workspaces panel' });
  if (await side.isVisible()) await desk.getByRole('button', { name: 'Toggle the workspaces panel' }).click();
  await canvas.locator('[data-block="q1"]').getByRole('button', { name: /newest edit/ }).click();
  await sleep(500);
  await canvas.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await docShot(desk, 's11-canvas');
}

await main();
