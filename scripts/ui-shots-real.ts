import { chromium, type Locator, type Page } from '@playwright/test';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { HosClient } from '../src/api/client.js';
import type { Chat, TranscriptEntry } from '../src/api/types.js';
import { FakeAuthenticator } from '../src/fakes/fake-authenticator.js';

// Docs shots from real chats on a demo hos started by scripts/demo-hos.sh; steps in docs/site/README.md "Screenshots".
const D = process.env.HOS_DEMO_DIR ?? '/tmp/demo';
const port = Number(process.env.HOS_DEMO_PORT ?? 4627);
const base = `http://localhost:${port}`;
const storyFile = join(D, 'story.json');
const tokenFile = join(D, 'session.token');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Story = { topics: Record<string, { topicId: string; chatId: string; workspaceId: string | null }> };
const story = (): Story => (existsSync(storyFile) ? JSON.parse(readFileSync(storyFile, 'utf8')) : { topics: {} });
const save = (s: Story) => writeFileSync(storyFile, JSON.stringify(s, null, 2));

function client(): HosClient {
  if (!existsSync(tokenFile)) throw new Error('run enrol first');
  return new HosClient(`http://127.0.0.1:${port}`, { sessionToken: readFileSync(tokenFile, 'utf8').trim() });
}

async function docShot(page: Page, out: string, name: string, target?: Locator) {
  await page.mouse.move(1, 1).catch(() => {});
  await sleep(300);
  await page.emulateMedia({ colorScheme: 'dark' });
  const path = join(out, `${name}.png`);
  if (target) await target.screenshot({ path });
  else await page.screenshot({ path });
  stripPng(path);
  console.log(`${name}.png ${Math.round(statSync(path).size / 1024)} KB`);
}

const KEEP_CHUNKS = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);

function stripPng(path: string) {
  const png = readFileSync(path);
  const parts = [png.subarray(0, 8)];
  for (let at = 8; at < png.length; ) {
    const size = png.readUInt32BE(at);
    const end = at + 12 + size;
    if (KEEP_CHUNKS.has(png.toString('latin1', at + 4, at + 8))) parts.push(png.subarray(at, end));
    at = end;
  }
  writeFileSync(path, Buffer.concat(parts));
}

async function enrol(out: string) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
  const page = await context.newPage();
  await page.goto(`${base}/`);
  const box = page.getByLabel('Setup code');
  await box.waitFor({ timeout: 30_000 });
  await box.fill('a7k2pm9qxr');
  await docShot(page, out, 's6-enrolment');
  await browser.close();
  const api = new HosClient(`http://127.0.0.1:${port}`, { authenticator: new FakeAuthenticator(base) });
  await api.registerPasskey(readFileSync(join(D, 'data', 'enrolment-code'), 'utf8').trim());
  writeFileSync(tokenFile, `${api.sessionToken}\n`, { mode: 0o600 });
  console.log('passkey registered');
}

async function workspaceFor(api: HosClient, spec: string): Promise<string | null> {
  if (spec === 'none') return null;
  const projects = await api.listProjects();
  const [repo, branch] = spec === 'brain' ? ['brain', 'root'] : spec.split(':');
  const project = repo === 'brain' ? projects.find((p) => p.brain) : (projects.find((p) => p.name === repo) ?? (await api.createProject(join(D, 'code', repo!))));
  if (!project) throw new Error(`no project for ${spec}`);
  const workspace = await api.createWorkspace(branch === 'root' ? { projectId: project.id, kind: 'root' } : { projectId: project.id, kind: 'worktree', branch: branch! });
  for (let i = 0; i < 200; i++) {
    const now = (await api.listWorkspaces()).find((w) => w.id === workspace.id);
    if (now && now.setup !== 'pending' && now.setup !== 'running') break;
    await sleep(300);
  }
  return workspace.id;
}

async function topic(key: string, title: string, profile: string, spec: string) {
  const api = client();
  const s = story();
  const workspaceId = await workspaceFor(api, spec);
  const t = await api.createTopic({ title, ...(workspaceId ? { workspaceId } : {}) });
  const chat = await api.addTopicChat(t.id, profile === 'generic' ? {} : { profile });
  s.topics[key] = { topicId: t.id, chatId: chat.id, workspaceId };
  save(s);
  console.log(`${key}: topic ${t.id} chat ${chat.id}`);
}

const BUSY = new Set(['queued', 'starting', 'running', 'handing_off']);
const allChats = async (api: HosClient) => Object.values((await api.snapshot()).state.chats) as Chat[];

function line(entry: TranscriptEntry): string {
  if (entry.kind === 'assistant') return `  assistant: ${entry.text.slice(0, 400).replace(/\n/g, ' ')}`;
  if (entry.kind === 'user') return `  user: ${entry.text.slice(0, 200).replace(/\n/g, ' ')}`;
  if (entry.kind === 'tool_use') return `  tool ${entry.name} ${JSON.stringify(entry.input).slice(0, 160)}`;
  return `  result${entry.isError ? ' ERROR' : ''}: ${entry.output.slice(0, 160).replace(/\n/g, ' ')}`;
}

async function turns(api: HosClient) {
  let n = 0;
  for (const chat of await allChats(api)) n += (await api.getTranscript(chat.id)).filter((e) => e.kind === 'user').length;
  return n;
}

async function send(target: string, text: string, hold: boolean) {
  const api = client();
  const chatId = story().topics[target]?.chatId ?? target;
  const topicId = (await allChats(api)).find((c) => c.id === chatId)?.topicId;
  const seen = new Map<string, number>();
  for (const chat of await allChats(api)) seen.set(chat.id, (await api.getTranscript(chat.id)).length);
  if (text === '/refresh') await api.refreshContext(chatId);
  else if (text) await api.sendMessage(chatId, text);
  const deadline = Date.now() + 8 * 60_000;
  let quiet = 0;
  while (Date.now() < deadline) {
    await sleep(2000);
    const waiting = (await api.listApprovals()).filter((a) => !a.decision && (a.outcome === 'ask' || a.outcome === 'ask_every_time'));
    const pending = waiting.filter((a) => a.topicId === topicId);
    if (pending.length && hold) {
      console.log(`held: ${pending.map((a) => `${a.tool} (${a.chatId?.slice(0, 8)})`).join(', ')}`);
      break;
    }
    for (const a of pending) {
      console.log(`approving ${a.tool} for ${a.chatId?.slice(0, 8)}`);
      await api.decideApproval(a.id, 'approve', { via: 'mac' }).catch((e: Error) => console.log(`approve failed: ${e.message}`));
    }
    const blocked = new Set(waiting.filter((a) => a.topicId !== topicId).map((a) => a.chatId));
    const busy = (await allChats(api)).filter((c) => BUSY.has(c.state) && !blocked.has(c.id));
    quiet = busy.length ? 0 : quiet + 1;
    if (quiet >= 5) break;
  }
  for (const chat of await allChats(api)) {
    const entries = (await api.getTranscript(chat.id)).slice(seen.get(chat.id) ?? 0);
    if (!entries.length) continue;
    console.log(`chat ${chat.id.slice(0, 8)} ${chat.profile} ${chat.model ?? ''} ${chat.state} ${chat.title ?? ''}`);
    for (const e of entries) console.log(line(e));
  }
  console.log(`turns so far: ${await turns(api)}`);
}

async function status() {
  const api = client();
  for (const chat of await allChats(api)) console.log(chat.id, chat.topicId.slice(0, 8), chat.profile, chat.model, chat.state, chat.parentId?.slice(0, 8) ?? '-', chat.title ?? '');
  for (const a of await api.listApprovals()) console.log('approval', a.id, a.tool, a.outcome, a.decision, a.chatId?.slice(0, 8));
  console.log(`turns so far: ${await turns(api)}`);
}

async function approve() {
  const api = client();
  for (const a of (await api.listApprovals()).filter((x) => !x.decision)) {
    await api.decideApproval(a.id, 'approve', { via: 'mac' });
    console.log(`approved ${a.tool}`);
  }
}

async function go(page: Page, hash: string) {
  await page.goto(`${base}/${hash}`);
  await page.reload();
  await page.getByRole('main').getByRole('heading', { level: 1 }).first().waitFor();
  await sleep(1200);
}

async function showPanel(page: Page, view: 'Tasks' | 'Workspaces') {
  const panel = page.getByRole('complementary', { name: 'Workspaces panel' });
  if (!(await panel.isVisible())) await page.getByRole('button', { name: 'Toggle the workspaces panel' }).click();
  await panel.getByRole('tab', { name: new RegExp(`^${view}`) }).click();
  await sleep(500);
  return panel;
}

async function hidePanel(page: Page) {
  const panel = page.getByRole('complementary', { name: 'Workspaces panel' });
  if (await panel.isVisible()) await page.getByRole('button', { name: 'Toggle the workspaces panel' }).click();
  await sleep(300);
}

async function openTurns(page: Page, match: RegExp) {
  const turns = page.getByRole('main').locator('details.turn');
  for (let i = 0; i < (await turns.count()); i++) {
    const summary = turns.nth(i).locator('summary');
    if (match.test((await summary.textContent()) ?? '')) await summary.click();
  }
}

async function shoot(out: string, only: string[]) {
  const api = client();
  const s = story();
  const chats = await allChats(api);
  const t = (key: string) => s.topics[key]!;
  const helper = chats.find((c) => c.parentId === t('rate').chatId);
  const browser = await chromium.launch();
  const open = async (phone: boolean) => {
    const context = await browser.newContext(
      phone
        ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme: 'dark' }
        : { viewport: { width: 1280, height: 800 }, colorScheme: 'dark' },
    );
    await context.addInitScript((token) => localStorage.setItem('hos.session', token), api.sessionToken!);
    const page = await context.newPage();
    page.on('pageerror', (error) => console.error(`page error: ${error.message}`));
    return page;
  };
  const desk = await open(false);
  const phone = await open(true);
  const want = (name: string) => !only.length || only.includes(name);
  const thread = (key: string, chatId?: string) => go(desk, `#/topic/${t(key).topicId}/chat/${chatId ?? t(key).chatId}`);

  if (want('s1')) {
    await thread('rate');
    await desk.getByRole('main').getByRole('group', { name: /^Permission request/ }).waitFor();
    const tasks = await showPanel(desk, 'Tasks');
    await tasks.getByText(/^Done \d/).first().click();
    await sleep(300);
    await docShot(desk, out, 's1-lead');
  }
  if (want('s2') && helper) {
    await thread('rate', helper.id);
    await desk.getByRole('button', { name: 'Hide sidebar' }).click();
    const panel = await showPanel(desk, 'Tasks');
    await panel.getByText(/^Done \d/).first().click();
    const task = panel.getByRole('button', { name: /Rate limit notes-api/ });
    if (await task.count()) await task.first().click();
    await openTurns(desk, /^Edited README/);
    const ran = desk.getByRole('main').locator('details.turn[open]').first();
    if (await ran.count()) await ran.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await docShot(desk, out, 's2-team');
    await desk.getByRole('button', { name: 'Show sidebar' }).click();
  }
  if (want('s3')) {
    await thread('rate');
    await openTurns(desk, /progress/i);
    const panel = await showPanel(desk, 'Workspaces');
    const touched = panel.getByText('Touched by this topic');
    if (await touched.count()) await touched.first().click();
    await docShot(desk, out, 's3-progress');
  }
  if (want('s4')) {
    await go(desk, '#/new');
    await desk.getByRole('button', { name: /^Profile: / }).click();
    await sleep(400);
    await docShot(desk, out, 's4-profiles');
  }
  if (want('s5')) {
    await thread('del');
    await desk.getByRole('region', { name: 'Pick a notes-api workspace' }).getByRole('radio').first().waitFor();
    await docShot(desk, out, 's5-workspaces');
  }
  if (want('s7')) {
    await go(phone, `#/topic/${t('dark').topicId}`);
    await phone.getByRole('main').getByRole('group', { name: /^Permission request/ }).waitFor();
    await docShot(phone, out, 's7-phone-approval');
  }
  if (want('s8')) {
    await go(desk, `#/diff/workspace/${t('rate').workspaceId}`);
    const diff = desk.getByRole('region', { name: 'Diff' });
    const file = diff.getByRole('article', { name: 'Changes to src/rateLimit.js' });
    await file.waitFor();
    const lineNo = Number(process.env.HOS_DEMO_COMMENT_LINE ?? 1);
    await file.locator(`[data-line="${lineNo}"][data-line-type="change-addition"]`).first().click();
    await diff.getByLabel(`Comment on src/rateLimit.js line ${lineNo}`).fill('Read the limit from config so we can change it without a deploy');
    await diff.getByRole('button', { name: 'Add comment' }).click();
    await sleep(400);
    await file.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await docShot(desk, out, 's8-diff');
  }
  if (want('s9')) {
    await thread('dark');
    await desk.getByRole('main').getByRole('group', { name: /^Permission request/ }).waitFor();
    await desk.keyboard.press('Meta+k');
    await desk.keyboard.type('Stop all');
    await sleep(300);
    await desk.keyboard.press('Enter');
    await desk.getByRole('alertdialog', { name: 'Stop all chats?' }).waitFor();
    await docShot(desk, out, 's9-guardrails');
    await desk.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();
  }
  if (want('s10')) {
    await go(desk, '#/settings/remote');
    await desk.getByRole('heading', { name: 'How you reach this computer' }).evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await docShot(desk, out, 's10-remote-access');
  }
  if (want('s11')) {
    await thread('sync');
    const lazy = desk.locator('.cv-wait[data-canvas]').first();
    if (await lazy.count()) await lazy.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    const canvas = desk.locator('section.cv').first();
    await canvas.waitFor();
    await hidePanel(desk);
    const choice = canvas.getByRole('button', { name: new RegExp(process.env.HOS_DEMO_CANVAS_PICK ?? 'last-writer', 'i') }).first();
    await choice.click();
    await sleep(500);
    await choice.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await docShot(desk, out, 's11-canvas');
  }
  if (want('home')) {
    await go(desk, '#/');
    await docShot(desk, out, 'home');
  }
  await browser.close();
}

async function runStory(out: string) {
  await topic('rate', 'Rate-limit the public API', 'lead', 'notes-api:rate-limit');
  await send('rate', 'Add rate limiting to notes-api: 60 requests a minute per API key, then 429 with a Retry-After header. Split it into tasks and start one engineer helper to build it with tests. Keep it small.', false);
  await send('rate', '1. Use the X-API-Key header, and fall back to the client IP when there is none.', false);
  await send('rate', 'Skip lint, there is none. One more: look up the IETF RateLimit header fields draft and tell me if we should also send RateLimit headers.', true);
  await shoot(out, ['s1']);
  await topic('notes', '2.14 release notes', 'product', 'brain');
  await send('notes', "Draft short 2.14 release notes for notes-api from its git log and the rate-limit branch. Put them in this topic's work folder.", false);
  await topic('dark', 'Dark mode for settings', 'engineer', 'notes-web:dark-mode');
  await send('dark', 'Add a dark palette to the settings screen in theme.css. Install wcag-contrast as a dev dependency and check the text colours pass AA.', true);
  await topic('search', 'Search results ranking bug', 'generic', 'none');
  await send('search', 'Exact title matches in notes-api search show up below notes that only mention the word in the body. Pick a notes-api workspace to look at it in.', false);
  await send('search', 'Makes sense. Fix it so exact title matches come first, with a test.', false);
  await topic('del', 'Delete notes from the API', 'engineer', 'none');
  await send('del', 'Add a DELETE /notes/:id route to notes-api, with a test.', false);
  await topic('sync', 'Offline sync for notes', 'generic', 'sync-service:root');
  await send('sync', 'Show me on a canvas how an offline edit gets merged in sync-service, and ask me which conflict rule I want.', false);
  await send('rate', '', false);
  await send('rate', '/refresh', false);
  await shoot(out, ['s2', 's3', 's4', 's5', 's7', 's8', 's9', 's10', 's11']);
}

const [command, ...args] = process.argv.slice(2);
const outDir = (arg?: string) => resolve(arg ?? 'docs/site/src/assets/shots');
if (command === 'enrol') await enrol(outDir(args[0]));
else if (command === 'topic') await topic(args[0]!, args[1]!, args[2]!, args[3]!);
else if (command === 'send') await send(args[0]!, args[1] ?? '', args.includes('--hold'));
else if (command === 'approve') await approve();
else if (command === 'status') await status();
else if (command === 'shoot') await shoot(outDir(args[0]), args[1] ? args[1].split(',') : []);
else if (command === 'story') await runStory(outDir(args[0]));
else if (command === 'strip') args.forEach(stripPng);
else console.log('usage: enrol [outDir] | story [outDir] | topic <key> <title> <profile> <repo:branch|repo:root|brain|none> | send <key|chatId> <text|/refresh> [--hold] | approve | status | shoot [outDir] [s1,s2,…] | strip <png…>');
process.exit(0);
