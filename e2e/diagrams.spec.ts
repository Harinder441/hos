import type { Page } from '@playwright/test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { signIn } from './access.js';
import { api, newTopic, topicHash } from './fixtures.js';
import { expect, test } from './test.js';

type Saved = { elements: Array<{ id: string; type: string; text?: string }> };

const board = (id: string): Saved | null => {
  const file = join(process.env.HOS_E2E_BRAIN!, 'diagrams', id, 'board.excalidraw');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Saved;
  } catch {
    return null;
  }
};
const types = (id: string) => (board(id)?.elements ?? []).map((e) => e.type).sort();
const screenshot = (id: string) => {
  const topics = join(process.env.HOS_E2E_BRAIN!, '.context/topics');
  const file = (existsSync(topics) ? readdirSync(topics) : []).map((t) => join(topics, t, 'scratch', `diagram-${id}.png`)).find(existsSync);
  return file ? readFileSync(file) : undefined;
};
const texts = (id: string) => (board(id)?.elements ?? []).flatMap((e) => (e.text ? [e.text] : [])).sort();
const diagramId = (page: Page) => decodeURIComponent(page.url().split('/diagram/')[1]!);

async function tell(chatId: string, text: string, reply: string) {
  const hos = await api();
  const replies = async () => (await hos.chatTimeline(chatId)).filter((item) => item.kind === 'message' && item.role === 'assistant' && item.done && item.text === reply).length;
  const before = await replies();
  await hos.sendMessage(chatId, text);
  await expect.poll(replies, { timeout: 15_000 }).toBe(before + 1);
}

async function penStroke(page: Page) {
  const canvas = page.locator('.diagram-canvas canvas.interactive');
  const box = (await canvas.boundingBox())!;
  const y = box.height * 0.58;
  await canvas.click({ position: { x: 30, y } });
  await page.keyboard.press('p');
  await page.mouse.move(box.x + 40, box.y + y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + 40 + i * 12, box.y + y + Math.sin(i) * 14);
  await page.mouse.up();
  await page.keyboard.press('v');
}

test('New diagram in the tab bar’s + menu makes a diagram at once; pen ink and a chat’s live edits share it; one Undo reverts the chat’s edit', async ({ page }, info) => {
  test.skip(info.project.name === 'phone', 'pen drawing is checked at desktop size');
  const stamp = Date.now();
  const { topicId, chatId } = await newTopic({ title: `Ink ${stamp}` });
  await signIn(page);
  await page.goto(topicHash(topicId));

  await page.getByRole('button', { name: 'New chat in this topic' }).hover();
  await page.getByRole('menuitem', { name: 'New diagram' }).click();
  await expect(page).toHaveURL(new RegExp(`#/topic/${topicId}/diagram/[^/]+$`));
  const id = diagramId(page);
  const tabs = page.getByRole('tablist', { name: 'Chats in this topic' });
  await expect(tabs.getByRole('tab', { name: new RegExp(`Ink ${stamp} · Diagram 1`) })).toHaveAttribute('aria-selected', 'true');
  await expect(tabs.getByRole('tab').filter({ hasNotText: 'Diagram 1' })).toHaveCount(1);
  await expect(page.locator('.dia-excal[data-live="true"]')).toBeAttached({ timeout: 15_000 });

  const canvas = page.locator('.diagram-canvas canvas.interactive');
  const box = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await page.keyboard.press('p');
  await page.mouse.move(box.x + 120, box.y + 320);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(box.x + 120 + i * 15, box.y + 320 + Math.sin(i) * 20);
  await page.mouse.up();
  await expect.poll(() => types(id), { timeout: 10_000 }).toEqual(['freedraw']);

  const ops = [
    { op: 'add', id: 'api', type: 'rectangle', x: 100, y: 80, text: 'API' },
    { op: 'add', id: 'db', type: 'rectangle', x: 420, y: 80, text: 'DB' },
    { op: 'add', type: 'arrow', from: 'api', to: 'db' },
  ];
  await tell(chatId, `draw ${id} ${JSON.stringify(ops)}`, 'Drew it.');
  await expect.poll(() => types(id), { timeout: 10_000 }).toEqual(['arrow', 'freedraw', 'rectangle', 'rectangle', 'text', 'text']);
  expect(texts(id)).toEqual(['API', 'DB']);
  await page.screenshot({ path: info.outputPath('diagram-live.png') });

  await tell(chatId, `shot ${id}`, 'Took a screenshot.');
  await expect.poll(() => screenshot(id)?.subarray(1, 4).toString(), { timeout: 10_000 }).toBe('PNG');

  await page.locator('.diagram-canvas').getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => types(id), { timeout: 10_000 }).toEqual(['freedraw']);

  await page.reload();
  await expect(page.locator('.dia-excal[data-live="true"]')).toBeAttached({ timeout: 15_000 });
  expect(types(id)).toEqual(['freedraw']);

  await tell(chatId, `mermaid ${id} graph LR; A[Start]-->B[End]`, 'Imported it.');
  await expect.poll(() => texts(id), { timeout: 15_000 }).toEqual(['End', 'Start']);
  expect(types(id)).toEqual(expect.arrayContaining(['arrow', 'freedraw', 'rectangle', 'rectangle']));
});

test('phone: a diagram is the canvas alone, in hand mode, above the app’s own bottom tabs; a chat’s edits and pen ink land on it @phone', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', 'the canvas-only head is the phone layout');
  const stamp = Date.now();
  const { topicId, chatId } = await newTopic({ title: `Phone topic ${stamp}` });
  const made = await (await api()).createDiagram(topicId, `Phone flow ${stamp}`);
  const id = made.id;
  await signIn(page);
  await page.goto(`#/topic/${topicId}/diagram/${id}`);

  const head = page.locator('.dia-head');
  await expect(head.getByRole('button', { name: `Phone flow ${stamp}` })).toBeVisible();
  const tabs = page.getByRole('navigation', { name: 'Tabs', exact: true });
  await expect(tabs.getByRole('button', { name: 'Chats' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('navigation', { name: 'Diagram tabs' })).toHaveCount(0);
  await expect(page.locator('.dia-excal[data-live="true"]')).toBeAttached({ timeout: 15_000 });
  await expect(page.getByTestId('toolbar-hand')).toBeChecked();
  await expect(page.getByRole('region', { name: 'Chat', exact: true })).toHaveCount(0);

  const ops = [
    { op: 'add', id: 'api', type: 'rectangle', x: 40, y: 60, text: 'API' },
    { op: 'add', id: 'db', type: 'rectangle', x: 40, y: 260, text: 'DB' },
    { op: 'add', type: 'arrow', from: 'api', to: 'db' },
  ];
  await tell(chatId, `draw ${id} ${JSON.stringify(ops)}`, 'Drew it.');
  await expect.poll(() => texts(id), { timeout: 10_000 }).toEqual(['API', 'DB']);
  await penStroke(page);
  await expect.poll(() => types(id), { timeout: 10_000 }).toContain('freedraw');
  await page.screenshot({ path: info.outputPath('phone-diagram-canvas.png') });
});
