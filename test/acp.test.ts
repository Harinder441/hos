import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import type { HosEvent } from '../src/api/types.js';
import { runKit } from '../src/plugins/kit.js';
import { eventGrammar, runContractScenario } from './contract.js';
import { cleanupAll, collect, startTestDaemon, tempDir, tempGitRepo } from './harness.js';
import { newTopic } from './topics.js';

afterEach(cleanupAll);

const FAKE_ACP = fileURLToPath(new URL('./fixtures/bin/fake-acp.mjs', import.meta.url));

interface Call {
  method: string;
  params: Record<string, unknown>;
  argv: string[];
  env: string | null;
}

function calls(dir: string): Call[] {
  const file = join(dir, 'calls.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Call) : [];
}

function settingsHarness(id: string, dir: string, extra = ''): string {
  return [
    `  - id: ${id}`,
    `    label: Fake ACP`,
    `    command: ${JSON.stringify(process.execPath)}`,
    `    args: [${JSON.stringify(FAKE_ACP)}, acp]`,
    `    env: { FAKE_ACP_DIR: ${JSON.stringify(dir)}, FAKE_ACP_MARK: settings }`,
    `    modes: { build: code, plan: plan }`,
    ...(extra ? [extra] : []),
  ].join('\n');
}

const PLUGIN = (dir: string, id: string, aliases: string[]) => `
export default {
  name: 'fake-acp',
  apiVersion: 2,
  register(host) {
    const runtime = host.acp(${JSON.stringify(id)}, {
      name: 'Fake ACP plug-in',
      command: ${JSON.stringify(process.execPath)},
      args: [${JSON.stringify(FAKE_ACP)}, 'acp'],
      env: { FAKE_ACP_DIR: ${JSON.stringify(dir)}, FAKE_ACP_MARK: 'plugin', FAKE_ACP_FLAVOUR: 'meta' },
      modes: { build: 'code', plan: 'plan' },
      hooks: {
        replay: (update) => Boolean(update._meta?.fake?.replay),
        update: (update, ctx) => { if (update.sessionUpdate === 'session_info_update') ctx.credits(2); },
      },
    });
    host.provide({
      kind: 'harness', version: 1, id: ${JSON.stringify(id)}, label: 'Fake plug-in', pool: 'fake', slots: 1, aliases: ${JSON.stringify(aliases)},
      badge: { text: 'F3', color: '#7b3fe4', aliases: ${JSON.stringify(Object.fromEntries(aliases.map((a) => [a, 'F2'])))} },
      models: () => ({ default: 'fast', effort: 'high', list: [{ id: 'fast', label: 'Fast' }, { id: 'smart', label: 'Smart' }] }),
      runtime,
    });
  },
};
`;

async function brainWith(policy: string, plugins: Record<string, string> = {}): Promise<string> {
  const brain = await tempGitRepo('main');
  mkdirSync(join(brain, 'hos', 'plugins'), { recursive: true });
  for (const [name, code] of Object.entries(plugins)) writeFileSync(join(brain, 'hos', 'plugins', name), code);
  writeFileSync(join(brain, 'hos', 'policy.yaml'), `approvals:\n  preset: ask_first\n${policy}`);
  return brain;
}

test('an ACP agent configured in policy.yaml by command, args and env plays the contract scenario offline', async () => {
  const dir = await tempDir('hos-fake-acp-');
  const brainDir = await brainWith(`harnesses:\n${settingsHarness('fake', dir)}\n`);

  const { events, chatId } = await runContractScenario((dataDir) => startTestDaemon({ brainDir, ...(dataDir ? { dataDir } : {}) }), 10_000, 'fake');

  expect(eventGrammar(events, chatId)).toBe('CiurtavkdmxiurtavkdmxiCurdmxi');
  const seen = calls(dir);
  expect(seen[0]).toMatchObject({ method: 'initialize', argv: ['acp'], env: 'settings' });
  const created = seen.find((c) => c.method === 'session/new')!;
  expect(created.params).toMatchObject({ mcpServers: [expect.objectContaining({ type: 'http', name: 'hos' })] });
  const loads = seen.filter((c) => c.method === 'session/load');
  expect(loads.at(-1)!.params.sessionId).toMatch(/^fake-/);
});

test('a plug-in harness built on host.acp opens and resumes chats that an older harness id started, through its aliases', async () => {
  const dir = await tempDir('hos-fake-acp-');
  const repo = await tempGitRepo();
  const before = await brainWith(`harnesses:\n${settingsHarness('older', dir)}\n`);
  const first = await startTestDaemon({ brainDir: before });
  const project = await first.client.createProject(repo);
  const topic = await newTopic(first.client, project.id, 'alias');
  const chat = await first.client.createChat(topic.id, { agent: 'older' });
  const stream = collect(first.client);
  await first.client.sendMessage(chat.id, 'Use the Write tool to create a file at ' + join(repo, 'a.txt') + ' containing exactly: hi.');
  const card = (await stream.until((es) => es.some((e) => e.type === 'approval.requested'), 10_000)).find((e) => e.type === 'approval.requested')!;
  await first.client.decideApproval(card.approvalId, 'approve');
  await stream.until((es) => es.filter((e) => e.type === 'chat.state' && e.chatId === chat.id && e.state === 'idle').length === 2, 10_000);
  expect(calls(dir).filter((c) => c.method === 'session/new' && c.env === 'settings')).toHaveLength(1);
  await first.stop();

  const after = await brainWith('plugins: [fake-acp.mjs]\n', { 'fake-acp.mjs': PLUGIN(dir, 'newer', ['older']) });
  const second = await startTestDaemon({ brainDir: after, dataDir: first.dataDir });
  expect((await second.client.harnesses()).map((h) => [h.id, h.features])).toEqual([
    ['scripted', { takeover: true, browser: true, contextRefresh: true, usageLimits: true }],
    ['newer', { takeover: false, browser: false, contextRefresh: false, usageLimits: false }],
  ]);
  expect((await second.client.harnesses())[1]).toMatchObject({ aliases: ['older'], badge: { text: 'F3', color: '#7b3fe4', aliases: { older: 'F2' } } });
  const transcript = await second.client.getTranscript(chat.id);
  expect(transcript.some((entry) => entry.kind === 'tool_use' && entry.name === 'Write')).toBe(true);
  const resumed = collect(second.client);
  await second.client.sendMessage(chat.id, 'Which file did you create earlier in this conversation? Answer with the filename only.');
  const replies = (es: HosEvent[]) => es.filter((e) => e.type === 'message.completed' && e.chatId === chat.id);
  const events = await resumed.until((es) => replies(es).length === 2, 10_000);
  expect(replies(events).at(-1)).toMatchObject({ text: 'a.txt' });
  const load = calls(dir).filter((c) => c.method === 'session/load' && c.env === 'plugin').at(-1)!;
  expect(load.params.sessionId).toBe(calls(dir).find((c) => c.method === 'session/prompt')!.params.sessionId);
  expect((await second.client.snapshot()).state.chats[chat.id]).toMatchObject({ agent: 'older' });
  expect(await second.client.takeOver(chat.id).catch((e: Error) => e.message)).toMatch(/has no Take over/);
});

test('Take over runs the terminal command a harness names, with the session id filled in', async () => {
  const dir = await tempDir('hos-fake-acp-');
  const brainDir = await brainWith(`harnesses:\n${settingsHarness('fake', dir, `    terminal: [/bin/sh, -c, 'echo resumed {session}; sleep 30']`)}\n`);
  const hos = await startTestDaemon({ brainDir });
  const project = await hos.client.createProject(await tempGitRepo());
  const topic = await newTopic(hos.client, project.id, 'takeover');
  const chat = await hos.client.createChat(topic.id, { agent: 'fake' });
  const stream = collect(hos.client);
  await hos.client.sendMessage(chat.id, 'hello');
  await stream.until((es) => es.some((e) => e.type === 'chat.state' && e.chatId === chat.id && e.state === 'idle' && es.some((m) => m.type === 'message.completed')), 10_000);
  expect((await hos.client.harnesses()).find((h) => h.id === 'fake')!.features).toMatchObject({ takeover: true, browser: false });

  const { terminal } = await hos.client.takeOver(chat.id);
  expect(terminal).toContain('fake-');
  await hos.client.handBack(chat.id);
  expect((await hos.client.snapshot()).state.chats[chat.id]!.state).toBe('idle');
});

test('the setup check shows a sign-in row per extra harness and warns about bad or clashing harness settings', async () => {
  const dir = await tempDir('hos-fake-acp-');
  const policy = [
    'harnesses:',
    settingsHarness('fake', dir, '    login: [fake-agent, login]\n    signed_in: [/usr/bin/false]'),
    settingsHarness('also', dir, "    signed_in: [/usr/bin/true]\n    badge: { text: AL, color: '#2f7d5b', aliases: { old-also: A1 } }\n    aliases: [old-also]"),
    settingsHarness('loud', dir, '    badge: { text: TOOLONG }'),
    settingsHarness('quiet', dir),
    settingsHarness('scripted', dir),
    '  - id: Bad Id',
    '    label: x',
    '    command: x',
    '',
  ].join('\n');
  const hos = await startTestDaemon({ brainDir: await brainWith(policy) });
  const rows = Object.fromEntries((await hos.client.doctorChecks()).map((row) => [row.id, row]));

  expect(rows['harness:fake']).toMatchObject({ label: 'Fake ACP sign-in', status: 'down', fix: 'fake-agent login' });
  expect(rows['harness:also']).toMatchObject({ status: 'ok', detail: 'signed in' });
  expect(rows['harness:quiet']).toMatchObject({ status: 'off' });
  expect(rows['harness:scripted:clash']).toMatchObject({ status: 'warn', detail: expect.stringContaining('already uses') });
  const settingRows = Object.values(rows).filter((row) => row.label === 'Harness settings');
  expect(settingRows.map((row) => row.detail)).toEqual([expect.stringContaining('harnesses[2] badge.text'), expect.stringContaining('harnesses[5]')]);
  expect(rows.claude ?? Object.values(rows).find((row) => row.label === 'Claude login')).toBeDefined();
  const list = await hos.client.harnesses();
  expect(list.map((h) => h.id)).toEqual(['scripted', 'fake', 'also', 'quiet']);
  expect(list.find((h) => h.id === 'also')).toMatchObject({ aliases: ['old-also'], badge: { text: 'AL', color: '#2f7d5b', aliases: { 'old-also': 'A1' } } });
});

test('hos plugin-check checks a harness plug-in and, with --write, runs one turn against the agent', async () => {
  const dir = await tempDir('hos-fake-acp-');
  const plugins = await tempDir('hos-kit-plugins-');
  const file = join(plugins, 'fake-acp.mjs');
  writeFileSync(file, PLUGIN(dir, 'kit', []));

  const dry = await runKit(file);
  expect(dry.ok).toBe(true);
  expect(dry.checks.map((c) => c.check)).toEqual(['id, models and runtime have the harness shape', 'features it declares', 'one chat turn (run with --write to start the agent for real)']);

  const live = await runKit(file, { write: true });
  expect(live.checks.at(-1)).toMatchObject({ check: 'one chat turn emits the events hos needs', ok: true });

  const broken = join(plugins, 'broken.mjs');
  writeFileSync(broken, PLUGIN(dir, 'Bad Id', []));
  const bad = await runKit(broken);
  expect(bad.ok).toBe(false);
  expect(bad.plugin?.problem).toContain('lowercase letters');
});
