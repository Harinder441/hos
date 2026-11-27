import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import type { HosEvent } from '../src/api/types.js';
import type { AgentScript } from '../src/fakes/scripted-agent-runtime.js';
import { cleanupAll, collect, git, startTestDaemon, tempDir, tempGitRepo } from './harness.js';

afterEach(cleanupAll);

const FAKE_VIEWER = fileURLToPath(new URL('./fixtures/bin/fake-hos-code.mjs', import.meta.url));
const PR = 'https://github.com/acme/shop/pull/42';

const script: AgentScript = () => [{ afterMs: 1000, delta: 'done' }];

interface ViewerEnv {
  url: string;
  token: string | null;
  oldToken: string | null;
  login: string | null;
  plain: string[];
  fromFiles: Array<string | null>;
  github: string | null;
}

async function world(binName = 'hos-code', dataDir?: string) {
  const bin = join(await tempDir('hos-code-bin-'), binName);
  copyFileSync(FAKE_VIEWER, bin);
  const calls = () => {
    try {
      return readFileSync(join(bin, '..', 'hos-code-argv.log'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { args: string[]; cwd: string });
    } catch {
      return [];
    }
  };
  const env = () => JSON.parse(readFileSync(join(bin, '..', 'hos-code-env.log'), 'utf8').trim().split('\n').at(-1)!) as ViewerEnv;
  const brainDir = await tempGitRepo('main');
  const hos = await startTestDaemon({ brainDir, codeViewBin: bin, script, ...(dataDir ? { dataDir } : {}) });
  const repo = await tempGitRepo('main');
  git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/shop.git');
  const project = await hos.client.createProject(repo);
  const root = await hos.client.createWorkspace({ projectId: project.id, kind: 'root' });
  const topic = await hos.client.createTopic({ title: 'Shop checkout fix', workspaceId: root.id });
  return { hos, bin, brainDir, repo, project, topic, calls, env };
}

type World = Awaited<ReturnType<typeof world>>;

const signedIn = (w: World) => ({ ...w.hos.transportIdentity.headers(), authorization: `Bearer ${w.hos.client.sessionToken}` });

function click(w: World, query: string, headers: Record<string, string> = signedIn(w), route = '/hos-code/pr') {
  return fetch(`${w.hos.daemon.url}${route}?${query}`, { headers, redirect: 'manual' });
}

const linkQuery = (w: World, url = PR) => `url=${encodeURIComponent(url)}&topic=${w.topic.id}`;

async function opened(w: World, route = '/hos-code/review'): Promise<(body: Record<string, unknown>, headers?: Record<string, string>) => Promise<Response>> {
  expect((await click(w, linkQuery(w))).status).toBe(302);
  const { url, token } = w.env();
  return (body, headers = { authorization: `Bearer ${token}` }) =>
    fetch(`${url}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

function tmuxSessions(socket: string): Array<{ name: string; path: string }> {
  return execFileSync('tmux', ['-u', '-S', socket, 'list-sessions', '-F', '#{session_name}\t#{session_path}'], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((line) => {
      const [name, path] = line.split('\t');
      return { name: name!, path: path! };
    });
}

type UserMessage = Extract<HosEvent, { type: 'message.user' }>;
const messagesTo = (events: HosEvent[], chatId: string) => events.filter((e): e is UserMessage => e.type === 'message.user' && e.chatId === chatId).map((e) => e.text);
const turnsOf = (chatId: string, n: number) => (es: HosEvent[]) => es.filter((e) => e.type === 'message.completed' && e.chatId === chatId).length >= n;
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
const comment = (n: number) => ({ action: 'comment', pr: PR, path: 'src/cart.ts', line: 10 + n, side: 'RIGHT', body: `comment ${n}` });

test('the Code view PR link records the PR with its topic, starts hos-code on that PR in tmux once, and redirects to it by tailnet address so hos-code takes its review posts', async () => {
  const w = await world();

  const first = await click(w, linkQuery(w));

  expect(first.status).toBe(302);
  const location = first.headers.get('location')!;
  const port = Number(/^http:\/\/127\.0\.0\.1:(\d+)\/\?token=[0-9a-f]{48}$/.exec(location)?.[1]);
  expect(port).toBeGreaterThanOrEqual(w.hos.codeViewFirstPort);
  expect(w.calls()).toEqual([{ args: ['-no-open', '-no-telemetry', '-host', '127.0.0.1', '-port', String(port), PR], cwd: w.repo }]);
  expect(tmuxSessions(w.hos.tmuxSocket)).toContainEqual({ name: 'hoscode-pr-shop-42', path: w.repo });
  expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toContain('fake hos-code');

  const other = await w.hos.client.createTopic({ title: 'Another topic' });
  const again = await click(w, `url=${encodeURIComponent(`${PR}/files`)}&topic=${other.id}`);
  expect(again.status).toBe(302);
  expect(again.headers.get('location')).toBe(location);
  expect(w.calls()).toHaveLength(1);

  await w.hos.client.openCodeView(w.repo);
  expect(tmuxSessions(w.hos.tmuxSocket)).toContainEqual({ name: 'hoscode-pr-shop-42', path: w.repo });
  expect((await click(w, linkQuery(w))).headers.get('location')).toBe(location);
  expect((await click(w, linkQuery(w), undefined, '/px0/pr')).headers.get('location')).toBe(location);
});

test('hos-code gets the bridge and login tokens under the new names, read from their files in the pane so tmux never holds them; both are kept in the data dir across restarts and the old token file and PR folder move once', async () => {
  const dataDir = await tempDir('hos-code-data-');
  writeFileSync(join(dataDir, 'px0-snags.token'), 'kept-bridge-token\n');
  mkdirSync(join(dataDir, 'px0-pr'));
  const w = await world('hos-code', dataDir);

  await w.hos.client.openCodeView(w.repo);

  const env = w.env();
  expect(env).toMatchObject({ url: w.hos.daemon.url, token: 'kept-bridge-token', oldToken: null, plain: ['HOS_CODE_LOGIN_TOKEN', 'HOS_CODE_TOKEN'] });
  expect(env.login).toMatch(/^[0-9a-f]{48}$/);
  expect(env.fromFiles).toEqual([env.token, env.login]);
  expect(readFileSync(join(dataDir, 'hos-code-login.token'), 'utf8').trim()).toBe(env.login);
  const session = tmuxSessions(w.hos.tmuxSocket).find((s) => s.name.startsWith('hoscode-'))!.name;
  const tmuxEnv = execFileSync('tmux', ['-S', w.hos.tmuxSocket, 'show-environment', '-t', session], { encoding: 'utf8' });
  expect(tmuxEnv).toContain(`HOS_CODE_LOGIN_TOKEN_FILE=${join(dataDir, 'hos-code-login.token')}`);
  for (const secret of [env.token!, env.login!]) expect(tmuxEnv).not.toContain(secret);
  expect(existsSync(join(dataDir, 'hos-code.token'))).toBe(true);
  expect(existsSync(join(dataDir, 'px0-snags.token'))).toBe(false);
  expect(existsSync(join(dataDir, 'hos-code-pr'))).toBe(true);
  expect(existsSync(join(dataDir, 'px0-pr'))).toBe(false);
  expect(tmuxSessions(w.hos.tmuxSocket).map((s) => s.name)).toContainEqual(expect.stringMatching(/^hoscode-.+-\d+$/));
  expect((await w.hos.client.doctorChecks()).map((item) => item.id)).not.toContain('hos-code');
});

test('a PR viewer gets GITHUB_TOKEN from gh for the PR owner’s account, read in the pane so tmux never holds it; an owner gh has not signed in leaves the token to hos-code', async () => {
  const ghDir = await tempDir('fake-gh-');
  writeFileSync(join(ghDir, 'gh'), '#!/bin/sh\n[ "$1 $2 $3 $4" = "auth token --user acme" ] && echo token-of-acme && exit 0\nexit 1\n', { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${ghDir}:${path}`;
  try {
    const w = await world();

    expect((await click(w, linkQuery(w))).status).toBe(302);
    expect(w.env().github).toBe('token-of-acme');
    const tmuxEnv = execFileSync('tmux', ['-S', w.hos.tmuxSocket, 'show-environment', '-t', 'hoscode-pr-shop-42'], { encoding: 'utf8' });
    expect(tmuxEnv).toContain('HOS_CODE_GH_USER=acme');
    expect(tmuxEnv).not.toContain('token-of-acme');

    expect((await click(w, linkQuery(w, 'https://github.com/stranger/shop/pull/7'))).status).toBe(302);
    expect(w.env().github).toBeNull();
  } finally {
    process.env.PATH = path;
  }
});

test('a PR GitHub answers 404 for fails at once with that answer instead of a 75 s timeout, and leaves no viewer session', async () => {
  const w = await world();
  const started = Date.now();

  await expect(w.hos.client.openPrLink('https://github.com/acme/shop/pull/404', w.topic.id)).rejects.toThrow(
    'GitHub answered 404 for this PR: no signed-in gh account hos tried can see acme/shop',
  );

  expect(Date.now() - started).toBeLessThan(10_000);
  expect(() => execFileSync('tmux', ['-S', w.hos.tmuxSocket, 'has-session', '-t', '=hoscode-pr-shop-404'], { stdio: 'ignore' })).toThrow();
});

test('a viewer binary still named px0 gets the old token name too, posts reviews to /px0/review, and a session started under the old name is reused', async () => {
  const w = await world('px0');
  const post = await opened(w, '/px0/review');

  expect(w.env()).toMatchObject({ token: expect.any(String), oldToken: w.env().token, plain: ['HOS_CODE_LOGIN_TOKEN', 'HOS_CODE_TOKEN', 'HOS_PX0_TOKEN'] });
  expect((await post({ action: 'start', pr: PR, head: 'main', chat: false })).status).toBe(201);

  const location = (await click(w, linkQuery(w))).headers.get('location')!;
  const port = Number(/:(\d+)\/\?token=/.exec(location)![1]);
  execFileSync('tmux', ['-S', w.hos.tmuxSocket, 'rename-session', '-t', 'hoscode-pr-shop-42', 'px0-pr-shop-42']);
  expect((await click(w, linkQuery(w), undefined, '/px0/pr')).headers.get('location')).toBe(location);
  expect(w.calls()).toHaveLength(1);
});

test('Open in Code view neither kills nor reuses hos’s own sessions whose names start with hos-code-', async () => {
  const w = await world();
  const own = ['hos-code-view-fix-web-5173', 'hos-code-view-fix-claude-1a2b3c4d-7001'];
  for (const name of own) execFileSync('tmux', ['-S', w.hos.tmuxSocket, 'new-session', '-d', '-s', name, '-c', w.repo, 'sleep 600']);

  const opened = await w.hos.client.openCodeView(w.repo);

  expect(opened).toMatchObject({ reused: false, session: expect.stringMatching(/^hoscode-.+-\d+$/) });
  expect(tmuxSessions(w.hos.tmuxSocket).map((s) => s.name)).toEqual(expect.arrayContaining(own));
  expect(w.calls()).toHaveLength(1);
});

test('the Code view PR link refuses strangers, links that are not GitHub PRs and unknown topics', async () => {
  const w = await world();

  expect((await click(w, linkQuery(w), {})).status).toBe(401);
  expect((await click(w, linkQuery(w), w.hos.transportIdentity.headers('someone@else.invalid'))).status).toBe(401);
  expect((await click(w, linkQuery(w, 'https://evil.example/acme/shop/pull/42'))).status).toBe(400);
  expect((await click(w, linkQuery(w, 'https://github.com/acme/shop/issues/42'))).status).toBe(400);
  expect((await click(w, `url=${encodeURIComponent(PR)}&topic=nope`)).status).toBe(404);
  expect(w.calls()).toEqual([]);
});

test('without a passkey session the PR link sends the browser to the web app, which signs in and then opens the PR; the viewer token never leaves in that redirect', async () => {
  const w = await world();
  const query = linkQuery(w);
  const expected = `/#/code-pr?url=${encodeURIComponent(PR)}&topic=${encodeURIComponent(w.topic.id)}`;

  for (const headers of [w.hos.transportIdentity.headers(), { ...w.hos.transportIdentity.headers(), authorization: 'Bearer not-a-session' }]) {
    for (const route of ['/hos-code/pr', '/px0/pr']) {
      const res = await click(w, query, headers, route);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(expected);
    }
  }
  expect(w.calls()).toEqual([]);

  const opened = await w.hos.client.openPrLink(PR, w.topic.id);
  expect(opened.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]{48}$/);
  expect(w.calls()).toHaveLength(1);
  expect((await click(w, query)).headers.get('location')).toBe(opened.url);
});

test('a review session with a chat: the chat starts in the PR’s topic, comments go to the reviews file and reach it three at a time, never mid-turn, and End review sends the rest', async () => {
  const w = await world();
  const worktree = await w.hos.client.createWorktree(w.project.id, { branch: 'fix-cart', baseRef: 'main' });
  const onBranch = await w.hos.client.createWorkspace({ projectId: w.project.id, kind: 'worktree', path: worktree.path });
  await w.hos.client.attachWorkspace(w.topic.id, onBranch.id);
  const post = await opened(w);
  const stream = collect(w.hos.client);

  const started = await post({ action: 'start', pr: PR, head: 'fix-cart', chat: true });
  expect(started.status).toBe(201);
  const { chatId, file } = (await started.json()) as { chatId: string; file: string };
  await stream.until((es) => messagesTo(es, chatId).length >= 1);
  expect(stream.events.find((e) => e.type === 'chat.created' && e.chat.id === chatId)).toMatchObject({ chat: { topicId: w.topic.id } });
  const [intro] = messagesTo(stream.events, chatId);
  expect(intro).toContain(PR);
  expect(intro).toContain('PROGRESS.md');
  expect(intro).toContain(worktree.path);
  expect(intro).toContain('fix-cart');
  expect(file).toBe(join(w.brainDir, w.topic.workDir!, 'reviews', 'PR-42.md'));

  for (const n of [1, 2, 3]) expect((await post(comment(n))).status).toBe(201);
  await settle();
  expect(messagesTo(stream.events, chatId)).toHaveLength(1);
  const lines = readFileSync(file, 'utf8');
  expect(lines).toContain('- [ ] C1 · src/cart.ts:11 · comment 1');
  expect(lines).toContain('- [ ] C3 · src/cart.ts:13 · comment 3');

  await w.hos.clock.advance(1000);
  await stream.until((es) => messagesTo(es, chatId).length >= 2);
  const batch = messagesTo(stream.events, chatId)[1]!;
  expect(batch).toContain('C1');
  expect(batch).toContain('comment 3');
  expect(batch).toContain(file);

  await w.hos.clock.advance(1000);
  await stream.until(turnsOf(chatId, 2));
  for (const n of [4, 5]) await post(comment(n));
  await settle();
  expect(messagesTo(stream.events, chatId)).toHaveLength(2);

  expect((await post({ action: 'end', pr: PR })).status).toBe(201);
  await stream.until((es) => messagesTo(es, chatId).length >= 3);
  const rest = messagesTo(stream.events, chatId)[2]!;
  expect(rest).toContain('comment 4');
  expect(rest).toContain('comment 5');
  expect(rest).not.toContain('comment 1');
  expect(readFileSync(file, 'utf8').match(/^- \[ \] C\d+/gm)).toHaveLength(5);
});

test('End review while the chat is mid-turn sends the rest once the turn ends', async () => {
  const w = await world();
  const post = await opened(w);
  const stream = collect(w.hos.client);
  const { chatId } = (await (await post({ action: 'start', pr: PR, head: 'fix-cart', chat: true })).json()) as { chatId: string };
  await stream.until((es) => messagesTo(es, chatId).length >= 1);
  expect(messagesTo(stream.events, chatId)[0]).toContain('workspace_choose');

  await post(comment(1));
  await post({ action: 'end', pr: PR });
  await settle();
  expect(messagesTo(stream.events, chatId)).toHaveLength(1);

  await w.hos.clock.advance(1000);
  await stream.until((es) => messagesTo(es, chatId).length >= 2);
  expect(messagesTo(stream.events, chatId)[1]).toContain('comment 1');
});

test('a review session without a chat only fills the reviews file; a Code view review needs the hos-code token from loopback and a linked PR', async () => {
  const w = await world();
  const post = await opened(w);

  const started = (await (await post({ action: 'start', pr: PR, head: 'main', chat: false })).json()) as { chatId: string | null; file: string };
  expect(started.chatId).toBeNull();
  await post(comment(1));
  await post({ action: 'end', pr: PR });
  expect(readFileSync(started.file, 'utf8')).toContain('- [ ] C1 · src/cart.ts:11 · comment 1');
  expect(w.hos.agentRuntime.started).toHaveLength(0);

  expect((await post(comment(2), { authorization: 'Bearer nope' })).status).toBe(401);
  expect((await post(comment(2), { authorization: 'Bearer nope', 'x-forwarded-for': '100.64.0.9' })).status).toBe(403);
  const token = w.env().token!;
  expect((await post({ ...comment(2), pr: 'https://github.com/acme/shop/pull/7' }, { authorization: `Bearer ${token}` })).status).toBe(404);
  expect((await post({ action: 'comment', pr: PR, path: 'a.ts', line: 1, body: '  ' })).status).toBe(400);
  expect(existsSync(started.file)).toBe(true);
});
