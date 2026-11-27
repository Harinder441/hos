import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { runKit } from '../src/plugins/kit.js';
import { localPlugin } from '../src/plugins/local.js';
import { SnagsClient } from '../src/snags/client.js';
import { cleanupAll, startTestDaemon, tempDir, tempGitRepo } from './harness.js';

afterEach(cleanupAll);

const FAKE = `
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export default {
  name: 'fake',
  apiVersion: 1,
  register(host) {
    const tasks = [{ id: 'a1', title: 'From the fake list', due: '09:30', open: true }];
    const result = (ok) => ({ available: true, ok, ...(ok ? {} : { error: 'no such task' }) });
    const close = (id) => {
      const task = tasks.find((t) => t.id === id && t.open);
      if (task) task.open = false;
      return result(!!task);
    };
    host.provide({
      kind: 'tasks', version: 1, label: 'Fake list',
      async today() { return { available: true, tasks: tasks.filter((t) => t.open).map(({ id, title, due }) => ({ id, title, due })) }; },
      async done(id) { return close(id); },
      async drop(id) { return close(id); },
      async addLinked(title) { const id = 'm' + tasks.length; tasks.push({ id, title, due: null, open: true }); return { ok: true, id }; },
      async setPriority(id) { return result(tasks.some((t) => t.id === id)); },
    });
    host.provide({
      kind: 'calendar', version: 1, label: 'Fake calendar', link: 'https://calendar.example/now',
      async today() { return { available: true, events: [{ time: '10:00', title: 'Standup' }] }; },
      async now() { return { available: true, now: { prev: null, current: { start: '09:00', end: '10:00', emoji: '🧠', label: 'Deep work' }, next: null, minutesLeft: 20, minutesToNext: null } }; },
    });
    host.provide({
      kind: 'notifier', version: 1, label: 'Fake desk',
      async push(screen) { mkdirSync(host.dataDir, { recursive: true }); writeFileSync(join(host.dataDir, 'pushed.json'), JSON.stringify({ screen, options: host.options })); },
    });
  },
};
`;

const BROKEN: Record<string, string> = {
  'throws.mjs': `throw new Error('the backend config is missing');`,
  'future.mjs': `export default { name: 'future', apiVersion: 99, register() {} };`,
  'weather.mjs': `export default { name: 'weather', apiVersion: 1, register(host) { host.provide({ kind: 'weather', version: 1, label: 'Sky' }); } };`,
  'second.mjs': `export default { name: 'second', apiVersion: 1, register(host) { host.provide({ kind: 'capture', version: 1, label: 'Second', async capture() { return { available: true, ok: true }; } }); host.provide({ kind: 'tasks', version: 1, label: 'Second list', async today() { return { available: true, tasks: [] }; }, async done() {}, async drop() {}, async addLinked() {}, async setPriority() {} }); } };`,
};

async function brainWith(plugins: Record<string, string>, policy: string): Promise<string> {
  const brain = await tempGitRepo('main');
  mkdirSync(join(brain, 'hos', 'plugins'), { recursive: true });
  for (const [name, code] of Object.entries(plugins)) writeFileSync(join(brain, 'hos', 'plugins', name), code);
  writeFileSync(join(brain, 'hos', 'policy.yaml'), policy);
  return brain;
}

test('with no plug-in, Home and Snags run on the built-in local sources and Calendar has no source', async () => {
  const hos = await startTestDaemon({ brainDir: await tempGitRepo('main') });
  const snags = new SnagsClient(hos.client);

  await hos.client.capture('Read the release notes');
  await snags.add({ kind: 'question', text: 'Where do snags live?' });
  const done = await hos.client.myTaskDone((await hos.client.myToday()).tasks[0]!.id);

  expect(await hos.client.sources()).toEqual({
    tasks: { label: 'This computer' },
    capture: { label: 'This computer' },
    calendar: null,
    snags: { label: 'This computer' },
    notifiers: [],
  });
  expect(done).toEqual({ available: true, ok: true });
  expect((await hos.client.myToday()).tasks).toEqual([]);
  expect(await snags.summary()).toMatchObject({ open: 1, label: 'This computer', offline: false, queued: 0 });
  await expect(hos.client.myCalendar()).rejects.toThrow('hos has no calendar source');
  expect((await hos.client.doctorChecks()).filter((c) => c.id.startsWith('plugin'))).toEqual([]);
});

test('the built-in snag source keeps its files apart from a snag plug-in’s S<n> folders', async () => {
  const brain = await tempGitRepo('main');
  const theirs = join(brain, '.context', 'snags', 'S1');
  mkdirSync(theirs, { recursive: true });
  writeFileSync(join(theirs, 'old-shot.png'), 'from another snag store');
  const hos = await startTestDaemon({ brainDir: brain });
  const snags = new SnagsClient(hos.client);

  const added = await snags.add({ kind: 'fix', text: 'Local snag with a file', files: [{ name: 'shot.png', data: Buffer.from('local').toString('base64') }] });
  const stored = added.files[0]!.path;
  const storedBytes = readFileSync(stored, 'utf8');
  await snags.remove('S1');

  expect(added.ref).toBe('S1');
  expect(stored).toBe(join(brain, '.context', 'snags', 'local', 'S1', 'shot.png'));
  expect(storedBytes).toBe('local');
  expect(existsSync(stored)).toBe(false);
  expect(readFileSync(join(theirs, 'old-shot.png'), 'utf8')).toBe('from another snag store');
});

test('a plug-in from the brain replaces the built-in source for its kinds, feeds Home and receives the desk screen', async () => {
  const brain = await brainWith({ 'fake.mjs': FAKE }, 'plugins:\n  - file: fake.mjs\n    options: { account: test }\n');
  const hos = await startTestDaemon({ brainDir: brain });

  const sources = await hos.client.sources();
  const today = await hos.client.myToday();
  const done = await hos.client.myTaskDone('a1');
  await hos.client.capture('Still local');
  const calendar = await hos.client.myCalendar();
  const now = await hos.client.myNow();
  await hos.clock.advance(5_000);
  const pushed = join(hos.dataDir, 'plugins', 'fake', 'pushed.json');
  for (let i = 0; i < 100 && !existsSync(pushed); i++) await new Promise((r) => setTimeout(r, 20));

  expect(sources).toEqual({
    tasks: { label: 'Fake list' },
    capture: { label: 'This computer' },
    calendar: { label: 'Fake calendar', now: true, link: 'https://calendar.example/now' },
    snags: { label: 'This computer' },
    notifiers: ['Fake desk'],
  });
  expect(today).toEqual({ available: true, tasks: [{ id: 'a1', title: 'From the fake list', due: '09:30' }] });
  expect(done.ok).toBe(true);
  expect((await hos.client.myToday()).tasks).toEqual([]);
  expect(calendar.events).toEqual([{ time: '10:00', title: 'Standup' }]);
  expect(now.now?.current?.label).toBe('Deep work');
  expect(JSON.parse(readFileSync(pushed, 'utf8'))).toMatchObject({ screen: { waiting: [], running: [], open_snags: 0 }, options: { account: 'test' } });
  expect((await hos.client.doctorChecks()).find((c) => c.id === 'plugin:fake.mjs')).toMatchObject({ status: 'ok', detail: 'fake.mjs provides tasks, calendar, notifier' });
});

test('a plug-in that fails to load shows in the doctor and never stops hos from starting', async () => {
  const brain = await brainWith({ 'fake.mjs': FAKE, ...BROKEN }, 'plugins: [fake.mjs, throws.mjs, future.mjs, weather.mjs, second.mjs, ../policy.yaml, missing.mjs]\n');
  const hos = await startTestDaemon({ brainDir: brain });

  const rows = Object.fromEntries((await hos.client.doctorChecks()).filter((c) => c.id.startsWith('plugin')).map((c) => [c.id, c]));

  expect(rows['plugin:fake.mjs']).toMatchObject({ status: 'ok' });
  expect(rows['plugin:throws.mjs']).toMatchObject({ status: 'warn', detail: expect.stringContaining('the backend config is missing') });
  expect(rows['plugin:future.mjs']).toMatchObject({ status: 'warn', detail: expect.stringContaining('written for plug-in API 99') });
  expect(rows['plugin:weather.mjs']).toMatchObject({ status: 'warn', detail: expect.stringContaining('hos knows no source kind weather') });
  expect(rows['plugin:second.mjs']).toMatchObject({ status: 'warn', detail: expect.stringContaining('tasks already comes from the plug-in fake') });
  expect(rows['plugin:../policy.yaml']).toMatchObject({ status: 'warn', detail: expect.stringContaining('plug-in files must sit in') });
  expect(rows['plugin:missing.mjs']).toMatchObject({ status: 'warn', fix: expect.stringContaining('hos plugin-check') });
  expect(await hos.client.sources()).toMatchObject({ tasks: { label: 'Fake list' }, capture: { label: 'Second' }, snags: { label: 'This computer' } });
});

test('the desk screen answers cross-origin reads only from the origins in desk.origins', async () => {
  const brain = await brainWith({}, 'desk:\n  origins: [https://desk.example]\n');
  const hos = await startTestDaemon({ brainDir: brain });
  const token = readFileSync(join(hos.dataDir, 'desk.token'), 'utf8').trim();
  const allowed = async (origin: string) =>
    (await fetch(`${hos.daemon.url}/api/desk`, { headers: { authorization: `Bearer ${token}`, origin } })).headers.get('access-control-allow-origin');

  expect(await allowed('https://desk.example')).toBe('https://desk.example');
  expect(await allowed('https://elsewhere.example')).toBeNull();
});

test('the plug-in kit passes the built-in local sources, write checks included, and reports a plug-in that hangs', async () => {
  const brainDir = await tempDir('hos-kit-brain-');
  const local = await runKit(localPlugin, { write: true, brainDir });
  const dir = await tempDir('hos-kit-plugins-');
  writeFileSync(join(dir, 'fake.mjs'), FAKE);
  writeFileSync(join(dir, 'hangs.mjs'), `export default { name: 'hangs', apiVersion: 1, register() { return new Promise(() => {}); } };`);
  const fake = await runKit(join(dir, 'fake.mjs'), { write: true });
  const hangs = await runKit(join(dir, 'hangs.mjs'), { timeoutMs: 200 });

  expect(local.checks.filter((c) => !c.ok)).toEqual([]);
  expect(local.ok).toBe(true);
  expect(new Set(local.checks.map((c) => c.kind))).toEqual(new Set(['tasks', 'capture', 'snags']));
  expect(local.checks.length).toBeGreaterThan(10);
  expect(fake.ok).toBe(true);
  expect(hangs).toMatchObject({ ok: false, plugin: { problem: 'hangs did not finish register() within 0.2 s' } });
});
