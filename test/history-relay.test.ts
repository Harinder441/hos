import { readdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { HosEvent } from '../src/api/types.js';
import { callBus } from '../src/fakes/bus-client.js';
import { cleanupAll, collect, startTestDaemon, tempDir, tempGitRepo } from './harness.js';

afterEach(cleanupAll);

type TestHos = Awaited<ReturnType<typeof startTestDaemon>>;

const HOUR = 3_600_000;
const REPORT = '/brain/work/web/2026-11-11-web-ai/D-LOCAL-TEST-REPORT.html';

const bus = (hos: TestHos, chatId: string, tool: string, args: Record<string, unknown>) =>
  callBus(hos.agentRuntime.started.filter((spec) => spec.chatId === chatId).at(-1)?.bus, tool, args);

const historyFile = (hos: TestHos, brainDir: string) => {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(hos.clock.now());
  return join(brainDir, 'history', day.slice(0, 4), day.slice(5, 7), `${day}.md`);
};

const blocks = (text: string) => text.split(/\n(?=## )/).filter((b) => b.startsWith('## '));

async function world() {
  const brainDir = await tempGitRepo('main');
  const policyFile = join(await tempDir(), 'policy.yaml');
  await writeFile(policyFile, 'version: 1\nowner:\n  timezone: Europe/Berlin\n  timezone_label: CET\n');
  const hos = await startTestDaemon({ brainDir, policyFile, script: () => [{ delta: 'ok' }] });
  const { chatId: parent, topicId } = await hos.client.startTopic({ text: 'coordinate the web app fixes' });
  const stream = collect(hos.client);
  await stream.until((es: HosEvent[]) => es.some((e) => e.type === 'message.completed' && e.chatId === parent));
  let n = 0;
  const spawn = async (from: string) => {
    n += 1;
    const out = await bus(hos, from, 'spawn', { role: 'worker', intent: `helper ${n}`, prompt: 'Do it.', client_request_id: `req-${n}`, ttl_minutes: 600 });
    const id = /chat ([0-9a-f-]{36})/.exec(out.output)![1]!;
    await stream.until((es: HosEvent[]) => es.some((e) => e.type === 'message.completed' && e.chatId === id));
    return id;
  };
  return { hos, brainDir, parent, topicId, spawn };
}

test('a parent relaying a child’s logged work gets a reference entry, not a second full one, whether it names the child or lists the same file', async () => {
  const { hos, brainDir, parent, spawn } = await world();
  const child = await spawn(parent);
  const tester = await spawn(parent);

  await bus(hos, child, 'history_append', { title: 'Fixes F1–F4 built', asked: 'fix F1–F4', did: 'fixed four bugs in PR #1833', wrote: 'none', open: 'none' });
  await bus(hos, tester, 'history_append', {
    title: 'Test run 3: 15/15 PASS',
    asked: 'retest F1–F4 in Chrome',
    did: 'ran 15 cases, all pass',
    wrote: `${REPORT}, /brain/work/web/2026-11-11-web-ai/screenshots/ (29 run3-*.jpg)`,
    open: 'stop the run-3 servers',
  });

  const named = await bus(hos, parent, 'history_append', {
    title: 'F1–F4 fixed',
    asked: '(hos notice) chat finished',
    did: `Chat ${child.slice(0, 8)} fixed F1–F4 in PR #1833; read its report.`,
    wrote: 'none',
    open: 'the user reviews PR #1833',
  });
  const shared = await bus(hos, parent, 'history_append', {
    title: 'F1–F4 retested: 15/15 PASS',
    asked: 'test the fixes',
    did: 'The Chrome chat retested: 15/15 PASS, 0 bugs.',
    wrote: `${REPORT}, /brain/work/web/2026-11-11-web-ai/PROGRESS.md`,
    open: 'retarget #1833',
  });

  const text = readFileSync(historyFile(hos, brainDir), 'utf8');
  const [childBlock, testerBlock, namedBlock, sharedBlock] = blocks(text);
  expect(childBlock).toContain('- Did: fixed four bugs in PR #1833');
  expect(testerBlock).toContain('- Did: ran 15 cases, all pass');
  const time = /^## (\d\d:\d\d) CET/.exec(childBlock!)![1];

  expect(namedBlock).toMatch(/^## \d\d:\d\d CET · main · F1–F4 fixed\n/);
  expect(namedBlock).toContain('- Asked: (hos notice) chat finished');
  expect(namedBlock).toContain(`- Did: Relays work already logged: chat ${child.slice(0, 8)} at ${time} CET ("Fixes F1–F4 built").`);
  expect(namedBlock).not.toContain('read its report');
  expect(namedBlock).toContain('- Open: the user reviews PR #1833');
  expect(named.output).toContain(`chat ${child.slice(0, 8)} already logged this work`);

  expect(sharedBlock).toContain(`- Did: Relays work already logged: chat ${tester.slice(0, 8)} at`);
  expect(sharedBlock).toContain('- Wrote: /brain/work/web/2026-11-11-web-ai/PROGRESS.md\n');
  expect(sharedBlock).not.toContain('15/15 PASS, 0 bugs');
  expect(shared.output).toContain(`chat ${tester.slice(0, 8)} already logged this work`);
});

test('the full entry stays when the child logged over two hours ago, when the writer is not the child’s parent, or when nothing ties the entries', async () => {
  const { hos, brainDir, parent, topicId, spawn } = await world();
  const child = await spawn(parent);
  const sibling = await hos.client.createChat(topicId);

  await bus(hos, child, 'history_append', { title: 'Report built', asked: 'build it', did: 'built the report', wrote: REPORT, open: 'none' });
  const unrelated = await bus(hos, parent, 'history_append', { title: 'Own plan', asked: 'plan it', did: 'wrote my own plan', wrote: '/brain/work/x/PLAN.md', open: 'none' });
  await bus(hos, sibling.id, 'history_append', { title: 'Same file elsewhere', asked: 'review it', did: `reviewed ${child.slice(0, 8)}'s report`, wrote: REPORT, open: 'none' });
  await hos.clock.advance(2 * HOUR + 60_000);
  await bus(hos, parent, 'history_append', { title: 'Late relay', asked: 'relay', did: `chat ${child.slice(0, 8)} built the report`, wrote: REPORT, open: 'none' });

  expect(unrelated.output).not.toContain('already logged');
  const written = allHistory(brainDir);
  expect(written).toContain('- Did: wrote my own plan');
  expect(written).toContain(`- Did: reviewed ${child.slice(0, 8)}'s report`);
  expect(written).toContain(`- Did: chat ${child.slice(0, 8)} built the report`);
  expect(written).not.toContain('Relays work already logged');
});

function allHistory(brainDir: string): string {
  const root = join(brainDir, 'history');
  return readdirSync(root, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => readFileSync(join(root, f), 'utf8'))
    .join('\n');
}
