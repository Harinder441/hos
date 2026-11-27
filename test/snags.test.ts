import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { HosEvent } from '../src/api/types.js';
import { callBus } from '../src/fakes/bus-client.js';
import { SnagsClient } from '../src/snags/client.js';
import { cleanupAll, collect, startTestDaemon, tempGitRepo } from './harness.js';

afterEach(cleanupAll);

const replies = (chatId: string) => (es: HosEvent[]) => es.some((e) => e.type === 'message.completed' && e.chatId === chatId);

test('a context snag added on the bus round-trips with its kind, and the summary counts open context snags apart', async () => {
  const hos = await startTestDaemon({ brainDir: await tempGitRepo('main'), script: (input) => [{ delta: `Got: ${input}` }] });
  const snags = new SnagsClient(hos.client);
  const stream = collect(hos.client);
  const { chatId } = await hos.client.startTopic({ text: 'log a context snag' });
  await stream.until(replies(chatId));
  const bus = hos.agentRuntime.started.filter((spec) => spec.chatId === chatId).at(-1)?.bus;

  await snags.add({ kind: 'fix', text: 'Composer loses focus' });
  expect((await callBus(bus, 'snag_add', { kind: 'context', text: 'work-in needs the hos worktree path rule' })).output).toBe('Added S2.');
  expect(await snags.get('S2')).toMatchObject({ kind: 'context', createdBy: chatId, state: 'open' });
  expect((await callBus(bus, 'snags')).output).toMatch(/^S2 · context · open · /m);
  expect(await snags.summary()).toMatchObject({ open: 2, openContext: 1, total: 2 });

  await callBus(bus, 'snag_resolve', { snag: 'S2', state: 'wontfix', note: 'applied by the sweep' });
  expect(await snags.summary()).toMatchObject({ open: 1, openContext: 0, total: 2 });
  await expect(snags.add({ kind: 'bug' as never, text: 'x' })).rejects.toThrow('kind must be one of question, fix, context');
});

test('a snag file that is gone from disk (the snag was just deleted) answers 404, not 500', async () => {
  const brainDir = await tempGitRepo('main');
  const hos = await startTestDaemon({ brainDir });
  const snags = new SnagsClient(hos.client);
  const added = await snags.add({ kind: 'fix', text: 'Board flickers', files: [{ name: 'screen.png', data: Buffer.from('png').toString('base64') }] });
  const get = () => fetch(`${hos.daemon.url}${snags.fileUrl(added.ref, 'screen.png')}`, { headers: { ...hos.transportIdentity.headers(), authorization: `Bearer ${hos.client.sessionToken}` } });
  expect((await get()).status).toBe(200);

  rmSync(join(brainDir, '.context', 'snags', 'local', added.ref, 'screen.png'));

  const gone = await get();
  expect(gone.status).toBe(404);
  expect(await gone.text()).toContain(`snag ${added.ref} has no file screen.png`);
});

test('a snag being added lists its files only once they are on disk, so a page loading meanwhile never gets a 500 for one', async () => {
  const hos = await startTestDaemon({ brainDir: await tempGitRepo('main') });
  const snags = new SnagsClient(hos.client);
  const headers = { ...hos.transportIdentity.headers(), authorization: `Bearer ${hos.client.sessionToken}` };
  let added = false;
  const adding = snags.add({ kind: 'fix', text: 'Big screenshot', files: [{ name: 'big.png', data: Buffer.alloc(20 * 1024 * 1024).toString('base64') }] }).finally(() => (added = true));

  const statuses: number[] = [];
  while (!added) {
    const [snag] = await snags.list();
    if (snag?.files.length) statuses.push((await fetch(`${hos.daemon.url}${snags.fileUrl(snag.ref, 'big.png')}`, { headers })).status);
  }
  await adding;

  expect(statuses.filter((status) => status !== 200)).toEqual([]);
});

test('the desk screen open snag count leaves open context snags out', async () => {
  const hos = await startTestDaemon({ brainDir: await tempGitRepo('main') });
  const snags = new SnagsClient(hos.client);
  const token = readFileSync(join(hos.dataDir, 'desk.token'), 'utf8').trim();
  const openSnags = async () => ((await (await fetch(`${hos.daemon.url}/api/desk`, { headers: { authorization: `Bearer ${token}` } })).json()) as { open_snags: number }).open_snags;

  await snags.add({ kind: 'fix', text: 'Composer loses focus' });
  await snags.add({ kind: 'context', text: 'work-in needs the hos worktree path rule' });
  expect(await snags.summary()).toMatchObject({ open: 2, openContext: 1 });
  expect(await openSnags()).toBe(1);
});
