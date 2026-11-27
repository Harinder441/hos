import Database from 'better-sqlite3';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { pair } from './computers-net.js';
import { cleanupAll, startTestDaemon, tempGitRepo } from './harness.js';

afterEach(cleanupAll);

const SERVER = 'home-server';
const TOTAL = 30_000;
const BIG = 12_000;

function seed(dataDir: string, chatIds: string[]): void {
  const db = new Database(join(dataDir, 'hos.db'));
  const insert = db.prepare('INSERT INTO events (ts, type, chat_id, body) VALUES (?, ?, ?, ?)');
  const body = (i: number, chatId: string) => {
    const id = `m${Math.floor(i / 10)}`;
    switch (i % 10) {
      case 0:
      case 1:
      case 2:
      case 3:
        return { type: 'message.delta', chatId, messageId: id, text: 'streamed piece of a reply '.repeat(3) };
      case 4:
      case 5:
        return { type: 'thinking.delta', chatId, thinkingId: id, text: 'a piece of thinking '.repeat(3) };
      case 6:
        return { type: 'tool.started', chatId, toolUseId: `t${i}`, name: 'Bash', input: JSON.stringify({ command: 'npm run check -- computers '.repeat(8) }) };
      case 7:
        return { type: 'tool.completed', chatId, toolUseId: `t${i - 1}`, output: 'a line of tool output\n'.repeat(30), isError: false };
      case 8:
        return { type: 'thinking.completed', chatId, thinkingId: id, text: 'a piece of thinking '.repeat(18) };
      default:
        return { type: 'message.completed', chatId, messageId: id, text: 'streamed piece of a reply '.repeat(12) };
    }
  };
  db.transaction(() => {
    for (let i = 0; i < TOTAL; i += 1) {
      const chatId = i < BIG ? chatIds[0]! : chatIds[1 + (i % (chatIds.length - 1))]!;
      const event = body(i, chatId);
      insert.run(Date.now(), event.type, chatId, JSON.stringify(event));
    }
  })();
  db.close();
}

test('a 30k-event topic: the open is only the topic and its chat list, and one chat loads in pages without its streaming pieces', async () => {
  const server = await startTestDaemon({ brainDir: await tempGitRepo('main'), computerName: SERVER });
  const mac = await startTestDaemon({ computerName: 'Mac' });
  const topic = await server.client.createTopic({ title: 'Busy rituals' });
  const chats = [];
  for (let i = 0; i < 10; i += 1) chats.push(await server.client.addTopicChat(topic.id));
  seed(server.dataDir, chats.map((c) => c.id));
  const { serve, token } = await pair(server, mac);
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  let at = performance.now();
  const raw = await (await fetch(`${serve.url}/api/computer/topics/${topic.id}/open`, { method: 'POST', headers, body: '{}' })).text();
  const open = { bytes: raw.length, ms: Math.round(performance.now() - at) };
  at = performance.now();
  await mac.client.openComputerTopic(SERVER, topic.id);
  const mirrored = Math.round(performance.now() - at);
  const answer = JSON.parse(raw) as { chats?: unknown[]; events?: unknown[] };
  console.log(`open: ${open.bytes} bytes, ${answer.events?.length ?? 0} events, route ${open.ms} ms, open on the caller ${mirrored} ms`);
  if (!answer.chats) return;

  expect(answer.events).toBeUndefined();
  expect(answer.chats).toHaveLength(10);
  expect(open.bytes).toBeLessThan(50_000);

  const pages: number[] = [];
  for (let after: number | null = 0; after !== null; ) {
    const text = await (await fetch(`${serve.url}/api/computer/chats/${chats[0]!.id}/events?after=${after}&limit=2000`, { headers })).text();
    pages.push(text.length);
    after = (JSON.parse(text) as { next: number | null }).next;
  }
  at = performance.now();
  const loaded = await mac.client.loadChat(chats[0]!.id);
  const ms = Math.round(performance.now() - at);
  console.log(`load one chat (${BIG} events): ${loaded.events} events in ${pages.length} pages of ${pages.join(', ')} bytes, ${ms} ms`);
  expect(pages.length).toBeGreaterThan(1);
  expect(loaded.events).toBeGreaterThan(BIG * 0.4);
}, 120_000);
