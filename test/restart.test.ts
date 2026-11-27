import Database from 'better-sqlite3';
import { cp } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { FOLD_VERSION } from '../src/snapshot.js';
import { cleanupAll, startTestDaemon, tempDir, tempGitRepo } from './harness.js';

afterEach(cleanupAll);

const FOLD = 'ui.fold';

function seed(dataDir: string, chatIds: string[], round: string, rounds: number): void {
  const db = new Database(join(dataDir, 'hos.db'));
  const insert = db.prepare('INSERT INTO events (ts, type, chat_id, body) VALUES (?, ?, ?, ?)');
  const add = (event: { type: string; chatId: string } & Record<string, unknown>) => insert.run(1_800_000_000_000, event.type, event.chatId, JSON.stringify(event));
  db.transaction(() => {
    for (let i = 0; i < rounds; i += 1) {
      for (const chatId of chatIds) {
        const id = `${round}-${i}`;
        add({ type: 'thinking.delta', chatId, thinkingId: `th-${id}`, text: 'think ' });
        add({ type: 'thinking.delta', chatId, thinkingId: `th-${id}`, text: 'more ' });
        add({ type: 'tool.started', chatId, toolUseId: `tool-${id}`, name: 'Read', input: '{}' });
        add({ type: 'thinking.completed', chatId, thinkingId: `th-${id}`, text: 'think more' });
        add({ type: 'message.delta', chatId, messageId: `m-${id}`, text: 'part ' });
        add({ type: 'tool.completed', chatId, toolUseId: `tool-${id}`, output: 'ok', isError: false });
        add({ type: 'message.completed', chatId, messageId: `m-${id}`, text: `reply ${id}` });
      }
    }
    for (const chatId of chatIds) add({ type: 'message.delta', chatId, messageId: `open-${round}`, text: 'still streaming' });
  })();
  db.close();
}

function setFold(dataDir: string, value: string | null): string | null {
  const db = new Database(join(dataDir, 'hos.db'));
  const before = (db.prepare('SELECT value FROM meta WHERE key = ?').get(FOLD) as { value: string } | undefined)?.value ?? null;
  if (value === null) db.prepare('DELETE FROM meta WHERE key = ?').run(FOLD);
  else db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(FOLD, value);
  db.close();
  return before;
}

async function copyOf(dataDir: string): Promise<string> {
  const copy = await tempDir('hos-data-copy-');
  await cp(dataDir, copy, { recursive: true });
  return copy;
}

test('a restart folds only the events after the saved fold, and gets the same state as a full fold, with a missing or corrupt saved fold rebuilt', async () => {
  const brainDir = await tempGitRepo();
  const first = await startTestDaemon({ brainDir });
  const topic = await first.client.createTopic({ title: 'Fold' });
  const chats = [await first.client.addTopicChat(topic.id), await first.client.addTopicChat(topic.id)];
  await first.stop();

  seed(first.dataDir, chats.map((c) => c.id), 'a', 120);
  const second = await startTestDaemon({ brainDir, dataDir: first.dataDir, passkeyOf: first.dataDir });
  await second.stop();
  seed(first.dataDir, chats.map((c) => c.id), 'b', 120);

  const full = await copyOf(first.dataDir);
  setFold(full, null);
  const corrupt = await copyOf(first.dataDir);
  setFold(corrupt, '{"version":');

  const states = [];
  for (const dataDir of [first.dataDir, full, corrupt]) {
    const hos = await startTestDaemon({ brainDir, dataDir, passkeyOf: first.dataDir });
    states.push((await hos.client.snapshot()).state);
    await hos.stop();
  }
  const [restored, rebuilt, fromCorrupt] = states;
  expect(restored!.timeline[chats[0]!.id]!.length).toBeLessThan(205);
  expect(restored!.timeline[chats[0]!.id]!.at(-1)).toMatchObject({ kind: 'message', text: 'still streaming', done: false });
  expect(restored).toEqual(rebuilt);
  expect(fromCorrupt).toEqual(rebuilt);
});

test('GET /healthz answers this machine with the daemon pid once it is up, and refuses requests that came through the transport', async () => {
  const hos = await startTestDaemon();
  const local = await fetch(`${hos.daemon.url}/healthz`);
  expect(local.status).toBe(200);
  expect(await local.json()).toEqual({ ok: true, pid: process.pid });
  const proxied = await fetch(`${hos.daemon.url}/healthz`, { headers: { 'x-forwarded-for': '100.64.0.2' } });
  expect(proxied.status).toBe(403);
});

test('a saved fold of this FOLD_VERSION is used as it is; one of another version is rebuilt from the events', async () => {
  const first = await startTestDaemon();
  const topic = await first.client.createTopic({ title: 'Real title' });
  await first.stop();
  const saved = JSON.parse(setFold(first.dataDir, null)!);
  saved.state.topics[topic.id].title = 'Title only in the saved fold';

  setFold(first.dataDir, JSON.stringify(saved));
  const current = await startTestDaemon({ dataDir: first.dataDir, passkeyOf: first.dataDir });
  expect((await current.client.snapshot()).state.topics[topic.id]!.title).toBe('Title only in the saved fold');
  await current.stop();

  setFold(first.dataDir, JSON.stringify({ ...saved, version: FOLD_VERSION + 1 }));
  const other = await startTestDaemon({ dataDir: first.dataDir, passkeyOf: first.dataDir });
  expect((await other.client.snapshot()).state.topics[topic.id]!.title).toBe('Real title');
});
