import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { FakeMachine } from '../src/fakes/fake-machine.js';
import type { DeskScreen } from '../src/plugins/types.js';
import { cleanupAll, startTestDaemon, tempGitRepo } from './harness.js';

afterEach(cleanupAll);

const RECORDER = `
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
export default {
  name: 'recorder',
  apiVersion: 1,
  register(host) {
    host.provide({
      kind: 'notifier', version: 1, label: 'Recorder',
      async push(screen) {
        mkdirSync(host.dataDir, { recursive: true });
        if (existsSync(join(host.dataDir, 'fail'))) throw new Error('the desk is offline');
        appendFileSync(join(host.dataDir, 'pushes.jsonl'), JSON.stringify(screen) + '\\n');
      },
    });
  },
};
`;

const SECOND = 15_000;

async function daemonWith(policy: string, machine = new FakeMachine()) {
  const brain = await tempGitRepo('main');
  mkdirSync(join(brain, 'hos', 'plugins'), { recursive: true });
  writeFileSync(join(brain, 'hos', 'plugins', 'recorder.mjs'), RECORDER);
  writeFileSync(join(brain, 'hos', 'policy.yaml'), `plugins: [recorder.mjs]\n${policy}`);
  const hos = await startTestDaemon({ brainDir: brain, machine });
  const dir = join(hos.dataDir, 'plugins', 'recorder');
  const file = join(dir, 'pushes.jsonl');
  const pushes = (): DeskScreen[] => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as DeskScreen) : []);
  const advance = async (ms: number, count: number) => {
    const before = pushes().length;
    await hos.clock.advance(ms);
    for (let i = 0; i < 100 && pushes().length < before + count; i++) await new Promise((r) => setTimeout(r, 20));
    return pushes();
  };
  return { hos, machine, pushes, advance, dir, start: hos.clock.now() };
}

const at = (start: number, ms: number) => new Date(start + ms).toISOString();

test('the desk push carries no presence unless desk.presence is on', async () => {
  const { advance } = await daemonWith('');

  const pushes = await advance(5_000, 1);

  expect(pushes).toHaveLength(1);
  expect(pushes[0]).not.toHaveProperty('presence');
});

test('a computer without a presence sampler sends no presence even when desk.presence is on', async () => {
  const machine = new FakeMachine();
  machine.presence = undefined;
  const { advance } = await daemonWith('desk: { presence: true }\n', machine);

  const pushes = await advance(5_000, 1);

  expect(pushes[0]).not.toHaveProperty('presence');
});

test('with desk.presence on, each push carries the 15 s samples taken since the last good push, nulls as read', async () => {
  const { advance, machine, start } = await daemonWith('desk: { presence: true }\n');
  const host = hostname().split('.')[0]!.toLowerCase();

  const first = (await advance(5_000, 1))[0]!;
  machine.reading = { idle_s: 200, locked: true, display_asleep: false, camera: null, mic: false };
  const second = (await advance(60_000, 1))[1]!;
  machine.reading = new Error('helper died');
  const third = (await advance(60_000, 1))[2]!;

  expect(first.presence).toEqual({ host, samples: [{ t: at(start, 0), idle_s: 3, locked: false, display_asleep: false, camera: false, mic: false }] });
  expect(second.presence!.samples).toEqual([1, 2, 3, 4].map((n) => ({ t: at(start, n * SECOND), idle_s: 200, locked: true, display_asleep: false, camera: null, mic: false })));
  expect(third.presence!.samples).toEqual([5, 6, 7, 8].map((n) => ({ t: at(start, n * SECOND), idle_s: null, locked: null, display_asleep: null, camera: null, mic: null })));
});

test('a failed push keeps its samples; the next good pushes resend them oldest first, 40 at a time, keeping the newest 240', async () => {
  const { advance, pushes, dir, start } = await daemonWith('desk: { presence: true }\n');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'fail'), '');

  await advance(5_000, 0);
  for (let minute = 0; minute < 70; minute++) await advance(60_000, 0);
  expect(pushes()).toHaveLength(0);
  rmSync(join(dir, 'fail'));
  const resumed = (await advance(60_000, 1))[0]!.presence!.samples;
  const next = (await advance(60_000, 1))[1]!.presence!.samples;

  const newestAtResume = (5_000 + 71 * 60_000) / SECOND;
  const oldestKept = Math.floor(newestAtResume) - 239;
  expect(resumed).toHaveLength(40);
  expect(resumed[0]!.t).toBe(at(start, oldestKept * SECOND));
  expect(resumed.map((s) => Date.parse(s.t) - start)).toEqual(Array.from({ length: 40 }, (_, i) => (oldestKept + i) * SECOND));
  expect(next).toHaveLength(40);
  expect(next[0]!.t).toBe(at(start, (oldestKept + 40) * SECOND));
});
