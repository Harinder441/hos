import Database from 'better-sqlite3';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { EventBody } from '../src/api/types.js';
import { UiFold } from '../src/snapshot.js';
import { Store } from '../src/store.js';
import { cleanupAll, collect, startTestDaemon, tempDir, tempGitRepo } from './harness.js';

afterEach(cleanupAll);

const MINUTE = 60_000;

function seed(store: Store): Record<string, number> {
  const seqs: Record<string, number> = {};
  let ts = 1_800_000_000_000;
  const add = (name: string, body: EventBody) => (seqs[name] = store.appendEvent(body, (ts += 1000)).seq);
  const chatId = 'chat-a';
  const other = 'chat-b';
  add('th1', { type: 'thinking.delta', chatId, thinkingId: 'th', text: 'think ' });
  add('m0', { type: 'message.delta', chatId: other, messageId: 'th', text: 'same id, other chat ' });
  add('th2', { type: 'thinking.delta', chatId, thinkingId: 'th', text: 'more ' });
  add('tool', { type: 'tool.started', chatId, toolUseId: 'tool', name: 'Read', input: '{}' });
  add('th3', { type: 'thinking.delta', chatId, thinkingId: 'th', text: 'still ' });
  add('progress', { type: 'subagent.progress', chatId, toolUseId: 'tool', tokens: 1, tools: 1, durationMs: 1, lastTool: null });
  add('thDone', { type: 'thinking.completed', chatId, thinkingId: 'th', text: 'think more still' });
  add('m1', { type: 'message.delta', chatId, messageId: 'm', text: 'part ' });
  add('toolDone', { type: 'tool.completed', chatId, toolUseId: 'tool', output: 'ok', isError: false });
  add('m2', { type: 'message.delta', chatId, messageId: 'm', text: 'two' });
  add('mDone', { type: 'message.completed', chatId, messageId: 'm', text: 'part two' });
  add('m0b', { type: 'message.delta', chatId: other, messageId: 'th', text: 'more' });
  add('m0Done', { type: 'message.completed', chatId: other, messageId: 'th', text: 'same id, other chat more' });
  add('late1', { type: 'message.delta', chatId, messageId: 'late', text: 'a ' });
  add('late2', { type: 'message.delta', chatId, messageId: 'late', text: 'b ' });
  add('lateDone', { type: 'message.completed', chatId, messageId: 'late', text: 'a b' });
  add('late3', { type: 'message.delta', chatId, messageId: 'late', text: 'after' });
  add('open1', { type: 'message.delta', chatId, messageId: 'open', text: 'still ' });
  add('open2', { type: 'message.delta', chatId, messageId: 'open', text: 'streaming' });
  return seqs;
}

function fold(store: Store, after = 0, from = new UiFold()): string {
  store.foldEventsSince(after, (event) => from.apply(event));
  return from.save();
}

function foldEverything(store: Store): string {
  const ui = new UiFold();
  for (const event of store.eventsSince(0)) ui.apply(event);
  return ui.save();
}

test('the prune keeps the first delta of each completed thinking/message block and every other row', async () => {
  const store = new Store(await tempDir());
  const seqs = seed(store);
  const all = store.eventsSince(0).length;

  expect(store.supersededDeltas(0)).toEqual([seqs.th2, seqs.th3, seqs.m2, seqs.m0b, seqs.late2]);
  expect(store.supersededDeltas(seqs.th2!)).toEqual([seqs.m2, seqs.late2]);

  expect(store.deleteDeltas(store.supersededDeltas(0))).toBe(5);
  const kept = store.eventsSince(0).map((event) => event.seq);
  expect(kept).toHaveLength(all - 5);
  for (const name of ['th1', 'm0', 'tool', 'progress', 'thDone', 'm1', 'toolDone', 'mDone', 'm0Done', 'late1', 'lateDone', 'late3', 'open1', 'open2']) {
    expect(kept).toContain(seqs[name]);
  }
  expect(store.supersededDeltas(0)).toEqual([]);
  store.close();
});

test('the fold skips the rows the prune deletes, so a full fold, a pruned fold and a fold from a saved point all give the same state', async () => {
  const store = new Store(await tempDir());
  const seqs = seed(store);
  const everything = foldEverything(store);

  const skipping = new UiFold();
  expect(fold(store, 0, skipping)).toBe(everything);
  expect(skipping.folded).toBe(store.eventsSince(0).length - 5);
  const half = new UiFold();
  for (const event of store.eventsSince(0).filter((e) => e.seq <= seqs.th2!)) half.apply(event);
  expect(fold(store, seqs.th2!, half)).toBe(everything);

  store.deleteDeltas(store.supersededDeltas(0));
  expect(fold(store)).toBe(everything);
  expect(foldEverything(store)).toBe(everything);
  store.close();
});

test('right after the daily backup the keeper prunes the superseded deltas; the backup keeps them', async () => {
  const script = () => [{ delta: 'one ' }, { delta: 'two ' }, { delta: 'three' }];
  const hos = await startTestDaemon({ refreshMs: 60 * MINUTE, brainDir: await tempGitRepo(), script });
  const topic = await hos.client.createTopic({ title: 'Prune' });
  const chat = await hos.client.addTopicChat(topic.id);
  await hos.client.sendMessage(chat.id, 'hello');
  await collect(hos.client).until((es) => es.some((e) => e.type === 'message.completed' && e.chatId === chat.id));
  const deltas = (file: string) => {
    const db = new Database(file, { readonly: true });
    const n = (db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'message.delta' AND chat_id = ?").get(chat.id) as { n: number }).n;
    db.close();
    return n;
  };
  const live = join(hos.dataDir, 'hos.db');
  const before = deltas(live);
  expect(before).toBeGreaterThan(1);

  await hos.clock.jump(24 * 60 * MINUTE);
  await expect.poll(() => deltas(live)).toBe(1);
  const [backup] = await readdir(join(hos.dataDir, 'backups'));
  expect(deltas(join(hos.dataDir, 'backups', backup!))).toBe(before);
});

test('after the daily backup the keeper drops thinking and progress events of topics archived longer than events.retention_days; other topics and the messages stay', async () => {
  const dir = await tempDir();
  const policyFile = join(dir, 'policy.yaml');
  await writeFile(policyFile, 'version: 1\nevents:\n  retention_days: 1\n');
  const script = () => [{ think: 'it' }, { delta: 'done' }];
  const hos = await startTestDaemon({ refreshMs: 60 * MINUTE, brainDir: await tempGitRepo(), policyFile, script });
  const stream = collect(hos.client);
  const chatIn = async (title: string) => {
    const topic = await hos.client.createTopic({ title });
    const chat = await hos.client.addTopicChat(topic.id);
    await hos.client.sendMessage(chat.id, 'hello');
    await stream.until((es) => es.some((e) => e.type === 'message.completed' && e.chatId === chat.id));
    return { topic, chat };
  };
  const old = await chatIn('Old');
  const live = await chatIn('Live');
  await hos.client.archiveTopic(old.topic.id);
  const count = (chatId: string, type: string) => {
    const db = new Database(join(hos.dataDir, 'hos.db'), { readonly: true });
    const n = (db.prepare('SELECT COUNT(*) AS n FROM events WHERE type = ? AND chat_id = ?').get(type, chatId) as { n: number }).n;
    db.close();
    return n;
  };
  expect(count(old.chat.id, 'thinking.completed')).toBe(1);

  await hos.clock.jump(48 * 60 * MINUTE);
  await expect.poll(() => count(old.chat.id, 'thinking.completed')).toBe(0);
  expect(count(old.chat.id, 'thinking.delta')).toBe(0);
  expect(count(old.chat.id, 'message.completed')).toBe(1);
  expect(count(live.chat.id, 'thinking.completed')).toBe(1);
});

test('without events.retention_days the keeper keeps every event of an archived topic', async () => {
  const script = () => [{ think: 'it' }, { delta: 'done' }];
  const hos = await startTestDaemon({ refreshMs: 60 * MINUTE, brainDir: await tempGitRepo(), script });
  const topic = await hos.client.createTopic({ title: 'Old' });
  const chat = await hos.client.addTopicChat(topic.id);
  await hos.client.sendMessage(chat.id, 'hello');
  await collect(hos.client).until((es) => es.some((e) => e.type === 'message.completed' && e.chatId === chat.id));
  await hos.client.archiveTopic(topic.id);
  const thoughts = () => {
    const db = new Database(join(hos.dataDir, 'hos.db'), { readonly: true });
    const n = (db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'thinking.completed' AND chat_id = ?").get(chat.id) as { n: number }).n;
    db.close();
    return n;
  };

  await hos.clock.jump(400 * 24 * 60 * MINUTE);
  await expect.poll(async () => (await readdir(join(hos.dataDir, 'backups'))).length).toBeGreaterThan(0);
  expect(thoughts()).toBe(1);
});
