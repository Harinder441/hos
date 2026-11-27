import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { callBus, listBusTools } from '../src/fakes/bus-client.js';
import { FakeClock } from '../src/fakes/fake-clock.js';
import { ScriptedAgentRuntime } from '../src/fakes/scripted-agent-runtime.js';
import { NO_FEATURES, type Harness } from '../src/harnesses/harness.js';
import { cleanupAll, collect, startTestDaemon, tempDir, tempGitRepo } from './harness.js';
import { newTopic } from './topics.js';

afterEach(cleanupAll);

const IDENTITY = ['SOUL', 'USER', 'MEMORY', 'RULES'];

async function profile(brain: string, id: string, frontmatter: string, skip: string[] = []): Promise<void> {
  const dir = join(brain, 'profiles', id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'PROFILE.md'), `---\n${frontmatter}\n---\n${id} body.\n`);
  for (const name of IDENTITY.filter((n) => !skip.includes(n))) await writeFile(join(dir, `${name}.md`), `# ${name} of ${id}\n`);
}

async function brainWithProfiles(): Promise<{ brainDir: string; skillsHome: string }> {
  const brainDir = await tempDir('hos-brain-');
  await writeFile(join(brainDir, 'CLAUDE.md'), '# shared rules\n');
  await profile(brainDir, 'generic', 'description: every skill');
  await profile(brainDir, 'life', "description: life admin\nskills: [journal, tldr]\ncan_start: [generic]\ncolor: '#d97a9b'");
  await profile(brainDir, 'engineer', 'description: builds\nskills: [work-in]\ncan_start: [engineer, generic]');
  const skillsHome = await tempDir('hos-home-');
  for (const skill of ['journal', 'tldr', 'work-in', 'handoff']) {
    await mkdir(join(skillsHome, '.claude/skills', skill), { recursive: true });
    await writeFile(join(skillsHome, '.claude/skills', skill, 'SKILL.md'), `---\nname: ${skill}\ndescription: ${skill} skill\n---\n`);
  }
  return { brainDir, skillsHome };
}

async function startChat(profileId: string, brain: { brainDir: string; skillsHome: string }) {
  const hos = await startTestDaemon(brain);
  const project = await hos.client.createProject(await tempGitRepo());
  const topic = await newTopic(hos.client, project.id, profileId);
  const events = collect(hos.client);
  const chat = await hos.client.addTopicChat(topic.id, { profile: profileId });
  await events.until((es) => es.some((e) => e.type === 'context.loaded' && e.chatId === chat.id));
  return { hos, chat, events };
}

test("a life chat's system prompt carries life's four identity files before its body, and none of engineer's", async () => {
  const brain = await brainWithProfiles();
  const { hos } = await startChat('life', brain);

  const append = hos.agentRuntime.started.at(-1)!.profileAppend!;
  const at = IDENTITY.map((name) => append.indexOf(`# ${name} of life`));
  expect(at.every((i) => i >= 0)).toBe(true);
  expect(at).toEqual([...at].sort((a, b) => a - b));
  expect(append.indexOf('life body.')).toBeGreaterThan(at.at(-1)!);
  expect(append).toContain(join(brain.brainDir, 'profiles/life/SOUL.md'));
  expect(append).not.toContain('of engineer');
  expect(hos.agentRuntime.started.at(-1)!.allowSkills).toEqual(['journal', 'tldr', 'handoff']);
});

test('a missing identity file is a doctor row and the chat still starts with the profile’s other files', async () => {
  const brain = await brainWithProfiles();
  await rm(join(brain.brainDir, 'profiles/life/RULES.md'));
  await writeFile(join(brain.brainDir, 'profiles/old.md'), '---\ndescription: old layout\n---\n');
  const { hos } = await startChat('life', brain);

  const append = hos.agentRuntime.started.at(-1)!.profileAppend!;
  expect(append).toContain('# MEMORY of life');
  expect(append).not.toContain('RULES of life');
  const rows = (await hos.client.doctorChecks()).filter((item) => item.id.startsWith('profile:'));
  expect(rows.map((row) => row.id)).toEqual(['profile:profiles/life/RULES.md', 'profile:profiles/old.md']);
  expect(rows[1]!.detail).toContain('old layout: move it to profiles/old/PROFILE.md');
});

test('a chat whose profile folder is gone restarts as generic with generic’s identity files', async () => {
  const brain = await brainWithProfiles();
  const { hos, chat, events } = await startChat('life', brain);
  await rm(join(brain.brainDir, 'profiles/life'), { recursive: true });

  await hos.client.restartChat(chat.id);
  await events.until((es) => es.filter((e) => e.type === 'context.loaded' && e.chatId === chat.id).length >= 2);

  const append = hos.agentRuntime.started.at(-1)!.profileAppend!;
  expect(append).toContain('# SOUL of generic');
  expect(append).not.toContain('of life');
  expect(hos.agentRuntime.started.at(-1)!.allowSkills).toBeUndefined();
  expect(events.events.some((e) => e.type === 'chat.error' && e.message.includes('there is no profiles/life/PROFILE.md'))).toBe(true);
});

test("the / menu's skill list is the profile's own; generic and no profile list every installed skill", async () => {
  const brain = await brainWithProfiles();
  const hos = await startTestDaemon(brain);
  const names = async (profileId?: string) => (await hos.client.skills(profileId)).map((skill) => skill.name);

  expect(await names('life')).toEqual(['handoff', 'journal', 'tldr']);
  expect(await names('engineer')).toEqual(['handoff', 'work-in']);
  expect(await names('generic')).toEqual(['handoff', 'journal', 'tldr', 'work-in']);
  expect(await names()).toEqual(['handoff', 'journal', 'tldr', 'work-in']);
  expect(await names('nobody')).toEqual(['handoff', 'journal', 'tldr', 'work-in']);
  expect((await hos.client.profiles()).map((p) => [p.id, p.color])).toEqual([['generic', null], ['engineer', null], ['life', '#d97a9b']]);
});

const SECOND_MODELS = { default: 'm-a', effort: 'low' as const, list: [{ id: 'm-a', label: 'A' }, { id: 'm-b', label: 'B' }] };

async function defaultsDaemon() {
  const brain = await brainWithProfiles();
  await profile(brain.brainDir, 'lead', 'description: leads\nmodels:\n  scripted: { model: claude-sonnet-5-5, effort: medium }');
  await profile(brain.brainDir, 'away', 'description: other harness\nharness: second\nmodels:\n  second: { model: m-b, effort: max }\n  scripted: { model: claude-haiku-5-5 }');
  const runtime = new ScriptedAgentRuntime(new FakeClock(), undefined, 'second');
  const second: Harness = { id: 'second', label: 'Second', pool: 'second', runtime, models: () => SECOND_MODELS, slots: 2, features: NO_FEATURES };
  const hos = await startTestDaemon({ ...brain, extraHarnesses: [second] });
  const project = await hos.client.createProject(await tempGitRepo());
  const topic = await newTopic(hos.client, project.id, 'defaults');
  const spec = (chatId: string) => [...hos.agentRuntime.started, ...runtime.started].filter((s) => s.chatId === chatId).at(-1)!;
  const chat = async (chatId: string) => (await hos.client.snapshot()).state.chats[chatId]!;
  return { hos, topic, spec, chat };
}

test("a chat the user starts with a profile runs on that profile's default model and effort unless they picked one", async () => {
  const { hos, topic, spec, chat } = await defaultsDaemon();

  const lead = await hos.client.addTopicChat(topic.id, { profile: 'lead' });
  expect([lead.model, lead.effort]).toEqual(['claude-sonnet-5-5', 'medium']);
  expect([spec(lead.id).model, spec(lead.id).effort]).toEqual(['claude-sonnet-5-5', 'medium']);

  const picked = await hos.client.addTopicChat(topic.id, { profile: 'lead', model: 'claude-haiku-5-5', effort: 'low' });
  expect([picked.model, picked.effort]).toEqual(['claude-haiku-5-5', 'low']);

  const generic = await hos.client.addTopicChat(topic.id, {});
  expect([generic.model, generic.effort]).toEqual(['claude-opus-5-5', 'high']);

  const started = await hos.client.startTopic({ text: 'lead a new topic', profile: 'lead' });
  const first = await chat(started.chatId);
  expect([first.model, first.effort]).toEqual(['claude-sonnet-5-5', 'medium']);
});

test("a profile's default harness picks the harness and that harness's model and effort; an explicit harness keeps the profile's defaults for it", async () => {
  const { hos, topic, spec } = await defaultsDaemon();

  const away = await hos.client.addTopicChat(topic.id, { profile: 'away' });
  expect([away.agent, away.model, away.effort]).toEqual(['second', 'm-b', 'max']);
  expect(spec(away.id).model).toBe('m-b');

  const home = await hos.client.addTopicChat(topic.id, { profile: 'away', agent: 'scripted' });
  expect([home.agent, home.model, home.effort]).toEqual(['scripted', 'claude-haiku-5-5', 'high']);
});

test("a spawned chat takes its own profile's defaults unless the spawn names a model, effort or harness", async () => {
  const { hos, topic, spec, chat } = await defaultsDaemon();
  const parent = await hos.client.addTopicChat(topic.id, {});
  const spawn = async (id: string, extra: Record<string, unknown> = {}) => {
    const { output } = await callBus(spec(parent.id).bus, 'spawn', { intent: `child ${id}`, prompt: 'go', client_request_id: id, ...extra });
    const chatId = /chat ([0-9a-f-]{36})/.exec(output)?.[1];
    expect(chatId, output).toBeDefined();
    return chat(chatId!);
  };

  const lead = await spawn('lead', { profile: 'lead' });
  expect([lead.model, lead.effort]).toEqual(['claude-sonnet-5-5', 'medium']);

  const overridden = await spawn('picked', { profile: 'lead', model: 'claude-haiku-5-5', effort: 'xhigh' });
  expect([overridden.model, overridden.effort]).toEqual(['claude-haiku-5-5', 'xhigh']);

  const away = await spawn('away', { profile: 'away' });
  expect([away.agent, away.model, away.effort]).toEqual(['second', 'm-b', 'max']);

  const pinned = await spawn('pinned', { profile: 'away', agent: 'scripted' });
  expect([pinned.agent, pinned.model, pinned.effort]).toEqual(['scripted', 'claude-haiku-5-5', 'high']);

  const generic = await spawn('generic');
  expect([generic.agent, generic.model, generic.effort]).toEqual(['scripted', 'claude-opus-5-5', 'high']);
});

test("a spawned chat with no model from its spawn, the governor or its profile runs on the brain's models.default and effort", async () => {
  const brain = await brainWithProfiles();
  await mkdir(join(brain.brainDir, 'hos'), { recursive: true });
  await writeFile(
    join(brain.brainDir, 'hos', 'policy.yaml'),
    'models:\n  default: claude-haiku-5-5\n  effort: low\n  list:\n    - { id: claude-opus-5-5, label: Opus 5.5 }\n    - { id: claude-haiku-5-5, label: Haiku 5.5 }\n',
  );
  const hos = await startTestDaemon(brain);
  const topic = await newTopic(hos.client, (await hos.client.createProject(await tempGitRepo())).id, 'models');
  const parent = await hos.client.addTopicChat(topic.id, { model: 'claude-opus-5-5', effort: 'high' });
  const bus = hos.agentRuntime.started.filter((s) => s.chatId === parent.id).at(-1)!.bus;

  const { output } = await callBus(bus, 'spawn', { intent: 'helper', prompt: 'go', client_request_id: 'helper' });

  const child = (await hos.client.snapshot()).state.chats[/chat ([0-9a-f-]{36})/.exec(output)![1]!]!;
  expect([child.model, child.effort]).toEqual(['claude-haiku-5-5', 'low']);
});

test('a profile lists hos tools to hide: its chats never see or call them, other chats keep them', async () => {
  const brain = await brainWithProfiles();
  const hidden = ['diagram_apply', 'server_start', 'snag_delete'];
  await profile(brain.brainDir, 'quiet', `description: fewer tools\nhide_tools: [${hidden.join(', ')}]`);
  const { hos, chat } = await startChat('quiet', brain);
  const project = await hos.client.createProject(await tempGitRepo());
  const other = await hos.client.addTopicChat((await newTopic(hos.client, project.id, 'other')).id, {});
  const bus = (id: string) => hos.agentRuntime.started.filter((s) => s.chatId === id).at(-1)!.bus;

  const quiet = (await listBusTools(bus(chat.id))).map((t) => t.name);
  const all = (await listBusTools(bus(other.id))).map((t) => t.name);
  expect(all).toEqual(expect.arrayContaining(hidden));
  expect(quiet).toEqual(all.filter((name) => !hidden.includes(name)));
  expect((await callBus(bus(chat.id), 'server_start', { name: 'web' })).isError).toBe(true);
});

test('a profile that hides a tool every chat needs is a doctor row and its chats run as generic', async () => {
  const brain = await brainWithProfiles();
  await profile(brain.brainDir, 'broken', 'description: hides complete\nhide_tools: [complete]');
  const hos = await startTestDaemon(brain);

  const rows = (await hos.client.doctorChecks()).filter((item) => item.id === 'profile:profiles/broken/PROFILE.md');
  expect(rows[0]?.detail).toContain('complete');
  expect((await hos.client.profiles()).map((p) => p.id)).not.toContain('broken');
});

test('the profile list shows each profile’s default harness, model and effort', async () => {
  const { hos } = await defaultsDaemon();
  const byId = Object.fromEntries((await hos.client.profiles()).map((p) => [p.id, p.defaults]));
  expect(byId.lead).toEqual({ harness: null, models: { scripted: { model: 'claude-sonnet-5-5', effort: 'medium' } } });
  expect(byId.away).toEqual({ harness: 'second', models: { second: { model: 'm-b', effort: 'max' }, scripted: { model: 'claude-haiku-5-5', effort: null } } });
  expect(byId.generic).toEqual({ harness: null, models: {} });
});

async function testerDaemon(extra: Parameters<typeof startTestDaemon>[0] = {}) {
  const brain = await brainWithProfiles();
  await profile(brain.brainDir, 'tester', 'description: tests in Chrome\nbrowser: true\npicker: false');
  const hos = await startTestDaemon({ ...brain, ...extra });
  const project = await hos.client.createProject(await tempGitRepo());
  const topic = await newTopic(hos.client, project.id, 'tester');
  const spec = (chatId: string) => hos.agentRuntime.started.filter((s) => s.chatId === chatId).at(-1)!;
  const chat = async (chatId: string) => (await hos.client.snapshot()).state.chats[chatId]!;
  return { hos, topic, spec, chat, brain };
}

test("a profile with browser: true starts its chats with the Browser on unless the pick or spawn turns it off", async () => {
  const { hos, topic, spec, chat } = await testerDaemon();

  const started = await hos.client.addTopicChat(topic.id, { profile: 'tester' });
  expect([started.chrome, spec(started.id).chrome]).toEqual([true, true]);
  expect((await hos.client.addTopicChat(topic.id, { profile: 'tester', chrome: false })).chrome).toBe(false);
  expect((await hos.client.addTopicChat(topic.id, {})).chrome).toBe(false);

  const parent = await hos.client.addTopicChat(topic.id, {});
  const spawn = async (id: string, extra: Record<string, unknown> = {}) => {
    const { output } = await callBus(spec(parent.id).bus, 'spawn', { intent: `child ${id}`, prompt: 'go', client_request_id: id, ...extra });
    const chatId = /chat ([0-9a-f-]{36})/.exec(output)?.[1];
    expect(chatId, output).toBeDefined();
    return chat(chatId!);
  };
  expect((await spawn('tester', { profile: 'tester' })).chrome).toBe(true);
  expect((await spawn('off', { profile: 'tester', browser: false })).chrome).toBe(false);
  expect((await spawn('plain')).chrome).toBe(false);
});

test('a profile with picker: false is listed as spawn-only, and the directory and spawn still offer it', async () => {
  const { hos, spec, topic } = await testerDaemon();
  const info = Object.fromEntries((await hos.client.profiles()).map((p) => [p.id, [p.picker, p.browser]]));
  expect(info).toEqual({ generic: [true, false], engineer: [true, false], life: [true, false], tester: [false, true] });

  const engineer = await hos.client.addTopicChat(topic.id, { profile: 'engineer' });
  expect(spec(engineer.id).profileAppend).toContain('| tester |');
  const parent = await hos.client.addTopicChat(topic.id, {});
  const { output } = await callBus(spec(parent.id).bus, 'spawn', { intent: 'test it', prompt: 'go', client_request_id: 't', profile: 'tester' });
  expect(output).toMatch(/Spawned chat/);
});

test('hide_tools takes Claude built-in tool names: the chat is started without them, and hos tool names still leave the bus', async () => {
  const brain = await brainWithProfiles();
  await profile(brain.brainDir, 'lean', 'description: fewer tools\nhide_tools: [Agent, WebSearch, NotebookEdit, server_start]');
  const { hos, chat } = await startChat('lean', brain);
  const started = hos.agentRuntime.started.filter((s) => s.chatId === chat.id).at(-1)!;

  expect(started.hideTools).toEqual(['Agent', 'WebSearch', 'NotebookEdit']);
  expect((await listBusTools(started.bus)).map((t) => t.name)).not.toContain('server_start');
  const other = await startChat('engineer', brain);
  expect(other.hos.agentRuntime.started.filter((s) => s.chatId === other.chat.id).at(-1)!.hideTools).toBeUndefined();
});

test('a schedules.yaml row can name a profile; its run starts with it, and an unknown profile is a problem and runs as generic', async () => {
  const brain = await brainWithProfiles();
  await mkdir(join(brain.brainDir, 'hos'), { recursive: true });
  const row = (id: string, extra: string) => `- id: ${id}\n  host: here\n  cron: "0 9 * * *"\n  prompt: ${id} please\n${extra}`;
  await writeFile(join(brain.brainDir, 'hos', 'schedules.yaml'), row('life-run', '  profile: life\n  topic: Life runs\n') + row('fresh-run', '  profile: engineer\n') + row('ghost-run', '  profile: nobody\n'));
  const hos = await startTestDaemon({ ...brain, scheduleHost: 'here' });
  const profileOf = async (id: string) => {
    const { chatId } = await hos.client.runSchedule(id);
    return (await hos.client.snapshot()).state.chats[chatId]!.profile;
  };

  expect(await profileOf('life-run')).toBe('life');
  expect(await profileOf('fresh-run')).toBe('engineer');
  expect(await profileOf('ghost-run')).toBe('generic');
  const list = await hos.client.schedules();
  expect(list.schedules.map((s) => [s.id, s.profile])).toEqual([['life-run', 'life'], ['fresh-run', 'engineer'], ['ghost-run', 'nobody']]);
  expect(list.problems).toEqual([expect.stringContaining('ghost-run') as string]);
  expect(list.problems[0]).toContain('profile "nobody"');
});
