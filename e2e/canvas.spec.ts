import type { Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { signIn } from './access.js';
import { api, newTopic, tempGitRepo, topicHash } from './fixtures.js';
import { expect, test } from './test.js';

const LESSONS = JSON.parse(readFileSync(join(process.cwd(), 'test/canvas-lessons.json'), 'utf8'));
const PROFILE = 'canvas-e2e';

function canvasProfile(): void {
  const dir = join(process.env.HOS_E2E_BRAIN!, 'profiles', PROFILE);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'PROFILE.md'), `---\ndescription: teaches with canvases\nskills: [canvas, tldr]\n---\n`);
}

async function canvasChat(title: string) {
  canvasProfile();
  const { topicId } = await newTopic({ title, repo: tempGitRepo() });
  const chatId = (await (await api()).addTopicChat(topicId, { profile: PROFILE })).id;
  return { topicId, chatId };
}

async function agent(chatId: string, verb: 'create' | 'update', args: unknown, result: RegExp) {
  const hos = await api();
  const done = async () => (await hos.chatTimeline(chatId)).filter((i) => i.kind === 'tool' && i.name === `mcp__hos__canvas_${verb}` && result.test(i.output ?? '')).length;
  const before = await done();
  await hos.sendMessage(chatId, `canvas ${verb} ${JSON.stringify(args)}`);
  await expect.poll(done, { timeout: 15_000 }).toBe(before + 1);
}

const card = (page: Page, ref = 'C1') => page.locator(`section.cv[data-canvas="${ref}"]`);

async function answerQuiz(page: Page) {
  const c = card(page);
  await c.locator('[data-block="q1"]').getByRole('button', { name: /Answers 409/ }).click();
  await c.locator('[data-block="q2"]').getByRole('button', { name: /The server, on the first request/ }).click();
  await c.locator('[data-block="q3"] textarea').fill('so a second request can’t also charge');
}

test('a quiz answered on the canvas goes from the hos bar as one submitted bubble; the flow steps and taps on the way @phone', async ({ page }, info) => {
  const { topicId, chatId } = await canvasChat(`Canvas quiz ${info.project.name}`);
  await agent(chatId, 'create', LESSONS.lesson, /^C1 v1$/);
  await signIn(page);
  await page.goto(topicHash(topicId, chatId));

  const c = card(page);
  await expect(c.getByRole('heading', { name: 'Idempotency keys' })).toBeVisible();
  await expect(c.locator('.cv-scard')).toHaveCount(3);
  const flow = c.locator('[data-block="f1"]');
  await expect(flow.getByText('The flow · step 1 of 8')).toBeVisible();
  for (let i = 0; i < 3; i++) await flow.getByRole('button', { name: 'Next →' }).click();
  await expect(flow.getByText('The flow · step 4 of 8')).toBeVisible();
  await flow.locator('[data-node="n4"]').click();
  await expect(flow.locator('.cv-detail')).toContainText('Claim K1');

  const bar = c.getByRole('group', { name: 'hos send bar' });
  await expect(bar.getByRole('button', { name: 'Check my answers' })).toBeDisabled();
  await answerQuiz(page);
  await expect(bar).toContainText('3 of 3 answered');
  if (info.project.name !== 'phone') {
    await bar.getByRole('button', { name: 'What gets sent' }).click();
    await expect(bar.locator('pre')).toContainText('Score 1/2. Seen: f1 4/8 open n4.');
  }
  await bar.getByRole('button', { name: 'Check my answers' }).click();

  const sent = page.locator('details.cv-sent');
  await expect(sent).toContainText('Submitted C1 · 3 answers');
  await sent.locator('summary').click();
  await expect(sent.locator('pre')).toContainText('- q2 → The server, on the first request ✗ key: The app, before the first try · node n1');
  await expect(bar.getByRole('button', { name: 'Sent' })).toBeDisabled();
  await expect(c.locator('[data-block="q1"] .cv-opt').first()).toBeDisabled();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('feedback with a node moves the canvas to the newest point and "Show me in the flow" steps the flow to that box; a retry goes as Check again', async ({ page }) => {
  const { topicId, chatId } = await canvasChat('Canvas feedback');
  await agent(chatId, 'create', LESSONS.lesson, /^C1 v1$/);
  const hos = await api();
  await hos.submitCanvas(topicId, 'C1', { a: { q1: 1, q2: 1, q3: 'claim first' }, view: {} });
  const ops = [
    { op: 'feedback', block: 'q1', ok: false, note: 'Not yet: while K1 is **running** there is no saved reply.', node: 'r2' },
    { op: 'feedback', block: 'q2', ok: true, note: 'Right: the app makes it.' },
    { op: 'feedback', block: 'q3', ok: true, note: 'Yes.' },
    { op: 'reopen', block: 'q1' },
  ];
  await agent(chatId, 'update', { id: 'C1', base: 1, ops }, /^C1 v2$/);
  await signIn(page);
  await page.goto(topicHash(topicId, chatId));

  await expect(page.getByText('C1 v1 · updated below')).toBeVisible();
  const c = card(page);
  await expect(c.locator('.cv-ver')).toHaveText('v2 · marked by the agent');
  const q1 = c.locator('[data-block="q1"]');
  await expect(q1.locator('.cv-fb.no')).toContainText('while K1 is running there is no saved reply');
  await q1.getByRole('button', { name: 'Show me in the flow ↑' }).click();
  const flow = c.locator('[data-block="f1"]');
  await expect(flow.getByText('The flow · step 8 of 8')).toBeVisible();
  await expect(flow.locator('[data-node="r2"]')).toHaveClass(/pointed/);
  await expect(flow.locator('.cv-detail')).toContainText('409 · try again');

  await q1.getByRole('button', { name: /Answers 409/ }).click();
  const bar = c.getByRole('group', { name: 'hos send bar' });
  await expect(bar).toContainText('q1 open again for a retry');
  await bar.getByRole('button', { name: 'Check again' }).click();
  await expect(page.locator('details.cv-sent').last()).toContainText('Re-answered C1 · 1 answer');
});

test('an explain-simply canvas has no hos bar; tapping a box only opens its detail', async ({ page }) => {
  const { topicId, chatId } = await canvasChat('Canvas explain');
  await agent(chatId, 'create', LESSONS.explain, /^C1 v1$/);
  await signIn(page);
  await page.goto(topicHash(topicId, chatId));
  const c = card(page);
  await expect(c.locator('.cv-kick').first()).toHaveText('Canvas · C1 · diagram');
  await expect(c.getByRole('group', { name: 'hos send bar' })).toHaveCount(0);
  await c.locator('[data-node="d"]').click();
  await expect(c.locator('.cv-detail')).toContainText('cache TTL');
});

test('an html page reports state and asks through the bridge, but only the hos bar sends; the page cannot send by itself', async ({ page }) => {
  const dir = join(process.env.HOS_E2E_BRAIN!, 'work/learn/2026-11-25-idempotency');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'stack.html'),
    `<!doctype html><html><head><meta charset="utf-8"><style>body{background:#0e1416;color:#e6efef;font:16px system-ui}</style></head><body>
<h1>Where the key store sits</h1><button id="redis">Redis key store</button>
<script>
parent.postMessage({hos:'canvas',type:'submit',answers:{h1:{selected:'forged'}}},'*');
parent.postMessage({hos:'canvas',type:'send'},'*');
document.getElementById('redis').onclick=()=>{hosCanvas.set({selected:'redis'});hosCanvas.request();};
</script></body></html>`,
  );
  const { topicId, chatId } = await canvasChat('Canvas html');
  await agent(chatId, 'create', LESSONS.html, /^C1 v1$/);
  await signIn(page);
  await page.goto(topicHash(topicId, chatId));

  const c = card(page);
  const bar = c.getByRole('group', { name: 'hos send bar' });
  await expect(bar.getByRole('button', { name: 'Ask about this' })).toBeDisabled();
  await page.frameLocator('iframe.cv-html').getByRole('button', { name: 'Redis key store' }).click();
  const confirm = bar.getByRole('button', { name: 'Confirm: send' });
  await expect(confirm).toBeEnabled();
  await page.waitForTimeout(800);
  const sentByPage = (await (await api()).chatTimeline(chatId)).filter((i) => i.kind === 'message' && i.canvas);
  expect(sentByPage).toEqual([]);

  await confirm.click();
  const sent = page.locator('details.cv-sent');
  await sent.locator('summary').click();
  await expect(sent.locator('pre')).toContainText(`- h1 reported by the page (its own script, not the user's words): {"selected":"redis"}`);
});

test('twenty canvases in one thread: the oldest close to stubs, off-screen cards mount lazily, and a step still answers at once', async ({ page }) => {
  const { topicId, chatId } = await canvasChat('Canvas twenty');
  for (let i = 1; i <= 20; i++) await agent(chatId, 'create', { ...LESSONS.explain, title: `CDN ${i}` }, new RegExp(`^C${i} v1$`));
  await signIn(page);
  await page.goto(topicHash(topicId, chatId));

  await expect(page.locator('section.cv[data-canvas="C20"]')).toBeVisible();
  const hos = await api();
  const states = await Promise.all(Array.from({ length: 20 }, (_, i) => hos.canvas(topicId, `C${i + 1}`).then((c) => c.state)));
  expect(states.filter((s) => s === 'closed')).toHaveLength(10);
  expect(await page.locator('section.cv').count()).toBeLessThan(10);
  expect(await page.locator('.cv-wait').count()).toBeGreaterThan(0);
  const last = card(page, 'C20').locator('[data-block="f1"]');
  const started = Date.now();
  await last.getByRole('button', { name: 'Next →' }).click();
  await expect(last.getByText('The flow · step 2 of 5')).toBeVisible();
  expect(Date.now() - started).toBeLessThan(1000);

  await page.locator('[data-canvas="C1"]').scrollIntoViewIfNeeded();
  const stub = page.locator('.cv-stub', { hasText: 'C1 · CDN 1 · closed to keep the thread light' });
  await expect(stub).toBeVisible();
  await stub.getByRole('button', { name: 'Show' }).click();
  await expect(card(page, 'C1').getByRole('heading', { name: 'CDN 1' })).toBeVisible();
});
