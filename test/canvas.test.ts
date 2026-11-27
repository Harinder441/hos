import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import type { HosEvent } from '../src/api/types.js';
import { BLOCKS } from '../src/canvas/registry.js';
import type { BlockKind } from '../src/canvas/types.js';
import { callBus, listBusTools } from '../src/fakes/bus-client.js';
import { cleanupAll, collect, startTestDaemon, tempDir, tempGitRepo } from './harness.js';
import { newTopic } from './topics.js';

afterEach(cleanupAll);

const LESSONS = JSON.parse(await readFile(new URL('./canvas-lessons.json', import.meta.url), 'utf8')) as Record<'lesson' | 'explain' | 'html', { title: string; submit?: string; blocks: Array<Record<string, unknown>> }>;

async function profile(brain: string, id: string, frontmatter: string): Promise<void> {
  const dir = join(brain, 'profiles', id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'PROFILE.md'), `---\n${frontmatter}\n---\n${id} body.\n`);
  for (const name of ['SOUL', 'USER', 'MEMORY', 'RULES']) await writeFile(join(dir, `${name}.md`), `# ${name}\n`);
}

async function world() {
  const brainDir = await tempDir('hos-brain-');
  await writeFile(join(brainDir, 'CLAUDE.md'), '# rules\n');
  await profile(brainDir, 'generic', 'description: every skill');
  await profile(brainDir, 'learner', 'description: teaches\nskills: [canvas, tldr]');
  await profile(brainDir, 'engineer', 'description: builds\nskills: [work-in]');
  const hos = await startTestDaemon({ brainDir });
  const project = await hos.client.createProject(await tempGitRepo());
  const stream = collect(hos.client);
  const chat = async (profileId: string, title = profileId) => {
    const topic = await newTopic(hos.client, project.id, title);
    const c = await hos.client.addTopicChat(topic.id, { profile: profileId });
    await stream.until((es) => es.some((e) => e.type === 'context.loaded' && e.chatId === c.id));
    const bus = hos.agentRuntime.started.filter((s) => s.chatId === c.id).at(-1)!.bus;
    return { topic, chat: c, call: (tool: string, args: Record<string, unknown> = {}) => callBus(bus, tool, args), tools: () => listBusTools(bus) };
  };
  return { hos, stream, chat, brainDir };
}

const CANVAS_TOOLS = ['canvas_create', 'canvas_update', 'canvas_read'];

test('the canvas tools exist, deferred, for a profile that lists the canvas skill and for generic (every skill); a narrower list without it gets none', async () => {
  const { chat } = await world();
  const learner = await chat('learner');
  const engineer = await chat('engineer');
  const generic = await chat('generic');

  for (const own of [learner, generic]) {
    const mine = (await own.tools()).filter((t) => CANVAS_TOOLS.includes(t.name));
    expect(mine.map((t) => [t.name, t.alwaysLoad])).toEqual(CANVAS_TOOLS.map((name) => [name, false]));
  }
  expect((await engineer.tools()).map((t) => t.name).filter((n) => n.startsWith('canvas_'))).toEqual([]);
  expect((await engineer.call('canvas_create', { title: 'x', blocks: [{ kind: 'callout', text: 'hi' }] })).isError).toBe(true);
});

test('canvas_create returns one line; the card payload carries the versioned spec, ELK layout for the diagrams and the open questions', async () => {
  const { hos, stream, chat } = await world();
  const { topic, chat: c, call } = await chat('learner');

  const made = await call('canvas_create', LESSONS.lesson);
  expect(made).toEqual({ output: 'C1 v1', isError: false });

  const card = await hos.client.canvas(topic.id, 'C1');
  expect(card).toMatchObject({ ref: 'C1', version: 1, chatId: c.id, state: 'open', open: ['q1', 'q2', 'q3'], spec: { v: 1, title: 'Idempotency keys', submit: 'Check my answers' } });
  expect(card.spec.blocks.map((b) => b.id)).toEqual(['a1', 's1', 'f1', 'k1', 'q1', 'q2', 'q3', 'c1', 't1', 'sq1']);
  const flow = card.layout.f1 as { nodes: Record<string, { x: number; y: number; w: number; h: number }>; edges: unknown[] };
  expect(Object.keys(flow.nodes).sort()).toEqual(['d3', 'n1', 'n2', 'n4', 'n5', 'n6', 'n7', 'r1', 'r2']);
  expect(flow.nodes.n2!.y).toBeGreaterThan(flow.nodes.n1!.y);
  expect(flow.edges).toHaveLength(8);
  expect(Object.keys((card.layout.sq1 as { actors: object }).actors)).toEqual(['app', 'srv', 'pay']);
  await stream.until((es) => es.some((e) => e.type === 'canvas.created' && e.ref === 'C1' && e.topicId === topic.id));
});

test('draft saves are row writes that add no events, and canvas_read shows his place and unsent answers compactly', async () => {
  const { hos, stream, chat } = await world();
  const { topic, call } = await chat('learner');
  await call('canvas_create', LESSONS.lesson);
  await stream.until((es) => es.some((e) => e.type === 'canvas.created'));
  const before = stream.events.length;

  for (let i = 0; i < 5; i++) await hos.client.saveCanvasDraft(topic.id, 'C1', { a: { q1: 1 }, view: { f1: { s: i, o: 'n4' }, s1: { c: 1 } } });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(stream.events.slice(before).filter((e) => e.type.startsWith('canvas.') || e.type === 'message.user')).toEqual([]);
  expect((await hos.client.canvas(topic.id, 'C1')).draft).toEqual({ a: { q1: 1 }, view: { f1: { s: 4, o: 'n4' }, s1: { c: 1 } } });

  expect((await call('canvas_read', { id: 'C1' })).output).toBe(
    ['C1 "Idempotency keys" v1 · open · not submitted', 'seen: s1 card 2/3 · f1 5/8 open n4', 'unsent draft:', '- q1 → Returns the saved reply ✗ key: Answers 409: try again shortly · node r2'].join('\n'),
  );
});

test('a submit from the hos bar reaches the chat as one compact hos message with a canvas tag, and locks the answered blocks', async () => {
  const { hos, stream, chat } = await world();
  const { topic, chat: c, call } = await chat('learner');
  await call('canvas_create', LESSONS.lesson);

  const draft = { a: { q1: 2, q2: 0, q3: 'so a second request at the same time can’t also charge' }, view: { f1: { s: 3, o: 'n4' } } };
  const { text } = await hos.client.submitCanvas(topic.id, 'C1', draft);

  expect(text).toBe(
    [
      '[hos] The user submitted C1 "Idempotency keys" v1 ("Check my answers", hos bar):',
      '- q1 → Answers 409: try again shortly ✓',
      '- q2 → The server, on the first request ✗ key: The app, before the first try · node n1',
      '- q3 → "so a second request at the same time can’t also charge"',
      'Score 1/2. Seen: f1 4/8 open n4. canvas_read C1 for the rest.',
    ].join('\n'),
  );
  const events = await stream.until((es) => es.some((e) => e.type === 'message.user' && e.chatId === c.id && e.canvas === 'C1'));
  expect(events.find((e) => e.type === 'message.user' && e.canvas === 'C1')).toMatchObject({ from: 'hos', text });
  expect(events.some((e) => e.type === 'canvas.submitted' && e.ref === 'C1')).toBe(true);
  expect((await hos.client.canvas(topic.id, 'C1')).open).toEqual([]);
  await expect(hos.client.submitCanvas(topic.id, 'C1', draft)).rejects.toThrow(/nothing to send/);
});

test('canvas_update with a stale base is refused with the fresh state; feedback and reopen make v2 and the retry sends only the reopened block', async () => {
  const { hos, chat } = await world();
  const { topic, call } = await chat('learner');
  await call('canvas_create', LESSONS.lesson);
  await hos.client.submitCanvas(topic.id, 'C1', { a: { q1: 1, q2: 1, q3: 'claim first' }, view: {} });

  const ops = [
    { op: 'feedback', block: 'q1', ok: false, note: 'While K1 is **running** there is no saved reply yet.', node: 'r2' },
    { op: 'feedback', block: 'q2', ok: true, note: 'Right.' },
    { op: 'reopen', block: 'q1' },
  ];
  expect(await call('canvas_update', { id: 'C1', base: 1, ops })).toEqual({ output: 'C1 v2', isError: false });
  const stale = await call('canvas_update', { id: 'C1', base: 1, ops: [{ op: 'title', title: 'x' }] });
  expect(stale.isError).toBe(true);
  expect(stale.output).toContain('Refused: C1 is v2, not v1. Current state:\nC1 "Idempotency keys" v2 · open · 1 submit (last on v1)');
  expect(stale.output).toContain('locked until you reopen: q2, q3');
  expect(stale.output).toContain('feedback: q1 ✗, q2 ✓');

  const card = await hos.client.canvas(topic.id, 'C1');
  expect([card.open, card.fb.q1]).toEqual([['q1'], { ok: false, note: 'While K1 is **running** there is no saved reply yet.', node: 'r2' }]);
  const { text } = await hos.client.submitCanvas(topic.id, 'C1', { a: { q1: 2, q2: 0, q3: 'changed' }, view: {} });
  expect(text).toBe(['[hos] The user re-answered C1 "Idempotency keys" v2 ("Check again", hos bar):', '- q1 → Answers 409: try again shortly ✓', 'Score 1/1. canvas_read C1 for the rest.'].join('\n'));
});

test('spec validation errors name the block id and field', async () => {
  const { chat } = await world();
  const { call } = await chat('learner');
  const refused = async (blocks: unknown[]) => {
    const r = await call('canvas_create', { title: 'T', blocks });
    expect(r.isError).toBe(true);
    return r.output;
  };

  expect(await refused([{ id: 'q1', kind: 'choice', prompt: 'P', options: ['a', 'b', 'c'], answer: 3 }])).toBe('Refused: blocks[0] q1 (choice).answer: 3 is past the 3 options (0-based)');
  expect(await refused([{ id: 'x', kind: 'quiz' }])).toMatch(/^Refused: blocks\[0\] x\.kind: "quiz" is not a block; use callout, story, flow/);
  expect(await refused([{ id: 'f1', kind: 'flow', nodes: [{ id: 'a', label: 'A' }], edges: ['a>b'] }])).toBe('Refused: blocks[0] f1 (flow).edges[0]: no node "b"');
  expect(await refused([{ id: 'c', kind: 'callout', text: 'x', colour: 'red' }])).toBe('Refused: blocks[0] c (callout).colour: not a field here');
  expect(await refused([{ id: 'q', kind: 'choice', prompt: 'P', options: ['a', 'b'], node: 'zz' }])).toBe('Refused: q (choice).node: no flow node "zz"');
  expect(await refused(Array.from({ length: 41 }, () => ({ kind: 'callout', text: 'x' })))).toMatch(/at most 40 blocks per canvas/);
});

test('a canvas with no questions has nothing to send', async () => {
  const { hos, chat } = await world();
  const { topic, call } = await chat('learner');
  await call('canvas_create', LESSONS.explain);
  const card = await hos.client.canvas(topic.id, 'C1');
  expect(card.open).toEqual([]);
  await expect(hos.client.submitCanvas(topic.id, 'C1', { a: { f1: 1 }, view: {} })).rejects.toThrow(/nothing to send/);
});

test('a submit never settles a plan: an open plan card stays open even when the picked option says implement', async () => {
  const { hos, stream, chat } = await world();
  const { topic, chat: c, call } = await chat('learner');
  await call('propose_plan', { title: 'Teach idempotency in three canvases' });
  await call('canvas_create', { title: 'Go?', blocks: [{ id: 'q', kind: 'choice', prompt: 'Ready?', options: ['implement', 'approve'] }] });

  await hos.client.submitCanvas(topic.id, 'C1', { a: { q: 0 }, view: {} });
  await stream.until((es) => es.some((e) => e.type === 'message.user' && e.chatId === c.id && e.canvas === 'C1'));
  const plans = (await hos.client.listInbox()).filter((item) => item.kind === 'plan' && item.chatId === c.id);
  expect(plans.map((p) => p.state)).toEqual(['open']);
  expect((await call('approve_plan', { quote: 'implement' })).isError).toBe(true);
});

test('canvas routes are per topic: another topic cannot read, save or submit C1', async () => {
  const { hos, chat } = await world();
  const { call } = await chat('learner', 'mine');
  const other = await chat('learner', 'theirs');
  await call('canvas_create', LESSONS.lesson);

  await expect(hos.client.submitCanvas(other.topic.id, 'C1', { a: { q1: 1 }, view: {} })).rejects.toThrow(/no canvas C1/);
  await expect(hos.client.saveCanvasDraft(other.topic.id, 'C1', { a: {}, view: {} })).rejects.toThrow(/no canvas C1/);
  await expect(hos.client.canvas(other.topic.id, 'C1')).rejects.toThrow(/no canvas C1/);
});

test('the 11th open canvas closes the oldest; its unsent draft is kept and Show reopens it', async () => {
  const { hos, chat } = await world();
  const { topic, call } = await chat('learner');
  for (let i = 1; i <= 10; i++) await call('canvas_create', { title: `Q${i}`, blocks: [{ id: 'q', kind: 'text', prompt: 'Why?' }] });
  await hos.client.saveCanvasDraft(topic.id, 'C1', { a: { q: 'half an answer' }, view: {} });

  expect((await call('canvas_create', { title: 'Q11', blocks: [{ kind: 'callout', text: 'x' }] })).output).toBe('C11 v1');
  const first = await hos.client.canvas(topic.id, 'C1');
  expect([first.state, first.draft.a]).toEqual(['closed', { q: 'half an answer' }]);
  expect((await hos.client.canvas(topic.id, 'C2')).state).toBe('open');
  await hos.client.showCanvas(topic.id, 'C1');
  expect((await hos.client.canvas(topic.id, 'C1')).state).toBe('open');
});

test('the briefing lists open canvases in one line, only for chats with the tools', async () => {
  const { hos, stream, chat } = await world();
  const learner = await chat('learner');
  const engineer = await chat('engineer');
  await learner.call('canvas_create', LESSONS.lesson);
  await engineer.call('canvas_create', LESSONS.lesson);

  const briefing = async (id: string) => {
    await hos.client.sendMessage(id, 'briefing');
    const es = await stream.until((all) => all.some((e) => e.type === 'message.completed' && e.chatId === id));
    return (es.find((e) => e.type === 'message.completed' && e.chatId === id) as Extract<HosEvent, { type: 'message.completed' }>).text;
  };
  expect((await briefing(learner.chat.id)).split('\n').filter((l) => l.startsWith('Canvases here'))).toEqual(['Canvases here (canvas_read <id> for the user\'s place and answers): C1 "Idempotency keys"']);
  expect(await briefing(engineer.chat.id)).not.toContain('Canvases');
});

test('an html block must be a page in the brain; its grant serves it with no network and the bridge, and its state goes labelled as the page’s', async () => {
  const { hos, chat, brainDir: brain } = await world();
  const { topic, call } = await chat('learner');
  expect((await call('canvas_create', LESSONS.html)).output).toBe('Refused: h1 (html).src: no such .html file in the brain: work/learn/2026-11-25-idempotency/stack.html');
  await mkdir(join(brain, 'work/learn/2026-11-25-idempotency'), { recursive: true });
  await writeFile(join(brain, 'work/learn/2026-11-25-idempotency/stack.html'), '<!doctype html><html><head><title>t</title></head><body>page</body></html>');
  expect((await call('canvas_create', { ...LESSONS.html, blocks: [{ id: 'h1', kind: 'html', src: '../outside.html' }] })).isError).toBe(true);
  expect((await call('canvas_create', LESSONS.html)).output).toBe('C1 v1');

  const { url } = await hos.client.canvasPage(topic.id, 'C1', 'h1');
  const page = await fetch(`${hos.daemon.url}${url}`, { headers: hos.transportIdentity.headers() });
  expect(page.status).toBe(200);
  const csp = page.headers.get('content-security-policy')!;
  expect(csp).toContain('sandbox allow-scripts;');
  expect(csp).toContain("connect-src 'none'");
  expect(csp).not.toContain('allow-same-origin');
  const body = await page.text();
  expect(body.indexOf('window.hosCanvas')).toBeGreaterThan(body.indexOf('<head>'));
  expect(body.indexOf('window.hosCanvas')).toBeLessThan(body.indexOf('<title>'));

  await expect(hos.client.submitCanvas(topic.id, 'C1', { a: { h1: { blob: 'x'.repeat(17_000) } }, view: {} })).rejects.toThrow(/nothing to send/);
  const { text } = await hos.client.submitCanvas(topic.id, 'C1', { a: { h1: { selected: 'redis' } }, view: {} });
  expect(text).toBe(
    ['[hos] The user submitted C1 "Where the key store sits" v1 ("Ask about this", hos bar):', '- h1 reported by the page (its own script, not the user\'s words): {"selected":"redis"}', 'canvas_read C1 for the rest.'].join('\n'),
  );
});

test('the registry is the only place a block kind is named: a kind added here works end to end', async () => {
  const { hos, chat } = await world();
  const { topic, call } = await chat('learner');
  const scale: BlockKind<{ id: string; kind: string; prompt: string; max: number }, number> = {
    kind: 'scale',
    fields: z.strictObject({ prompt: z.string(), max: z.number().int().min(2).max(10) }),
    answer: z.number().int().min(1),
    line: (block, answer) => `→ ${answer}/${block.max}`,
  };
  BLOCKS.push(scale);
  try {
    expect((await call('canvas_create', { title: 'How sure?', blocks: [{ id: 'sure', kind: 'scale', prompt: 'How sure are you?', max: 5 }] })).output).toBe('C1 v1');
    const { text } = await hos.client.submitCanvas(topic.id, 'C1', { a: { sure: 4 }, view: {} });
    expect(text.split('\n')[1]).toBe('- sure → 4/5');
  } finally {
    BLOCKS.pop();
  }
});
