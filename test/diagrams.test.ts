import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { HosEvent } from '../src/api/types.js';
import { callBus } from '../src/fakes/bus-client.js';
import type { AgentScript } from '../src/fakes/scripted-agent-runtime.js';
import { cleanupAll, collect, git, startTestDaemon, tempGitRepo } from './harness.js';
import { until } from './helpers.js';

afterEach(cleanupAll);

type Frame = { type: string; elements?: Array<Record<string, unknown>>; files?: Record<string, unknown>; agent?: boolean; message?: string };
type Scene = { elements: Array<Record<string, unknown>> };

const waitFor = (check: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<unknown> => until(check, Boolean, { timeoutMs });

async function openTab(client: { diagramSocket(id: string): WebSocket }, id: string) {
  const ws = client.diagramSocket(id);
  const frames: Frame[] = [];
  ws.onmessage = (event) => frames.push(JSON.parse(String(event.data)) as Frame);
  await waitFor(() => frames.some((f) => f.type === 'init'));
  return { ws, frames, send: (message: Record<string, unknown>) => ws.send(JSON.stringify(message)), close: () => ws.close() };
}

const committed = (id: string) => (es: HosEvent[]) => es.filter((e) => e.type === 'brain.committed' && e.files.some((f) => f.startsWith(`diagrams/${id}/`)));
const byId = (scene: Scene, id: string) => scene.elements.find((e) => e.id === id)!;
const labels = (scene: Scene) => scene.elements.flatMap((e) => (typeof e.text === 'string' ? [e.text] : [])).sort();
const applyIdOf = (output: string) => /\(apply ([a-z0-9]+)\)/.exec(output)![1]!;

const echoContext: AgentScript = (_input, _history, turn) => [{ delta: turn.context ?? '(no context)' }];

async function world() {
  const brain = await tempGitRepo('main');
  const hos = await startTestDaemon({ brainDir: brain, script: echoContext });
  const stream = collect(hos.client);
  const topic = async (title: string) => {
    const made = await hos.client.createTopic({ title });
    const chat = await hos.client.addTopicChat(made.id);
    return { topic: made, chat };
  };
  const bus = (chatId: string, tool: string, args: Record<string, unknown> = {}) =>
    callBus(hos.agentRuntime.started.filter((spec) => spec.chatId === chatId).at(-1)?.bus, tool, args);
  return { hos, brain, stream, topic, bus };
}

const changed = (id: string) => (es: HosEvent[]) => es.some((e) => e.type === 'diagram.changed' && e.id === id);

test('a diagram is created in its topic at once with a default name, and a rename rewrites diagram.md', async () => {
  const { hos, brain, stream, topic } = await world();
  const { topic: tiers } = await topic('Price tiers');

  const first = await hos.client.createDiagram(tiers.id);
  const second = await hos.client.createDiagram(tiers.id);

  expect(first).toMatchObject({ title: 'Price tiers · Diagram 1', topic: tiers.id, chats: [], naming: true, elementCount: 0, hasInk: false, updatedBy: null });
  expect(second.title).toBe('Price tiers · Diagram 2');
  const file = join(brain, 'diagrams', first.id, 'diagram.md');
  expect(await readFile(file, 'utf8')).toContain(`topic: ${tiers.id}\nnaming: true\n`);
  await stream.until(changed(first.id));

  const renamed = await hos.client.renameDiagram(first.id, 'Tier ladder');

  expect(renamed).toMatchObject({ title: 'Tier ladder', naming: false });
  const meta = await readFile(file, 'utf8');
  expect(meta).toContain('title: Tier ladder');
  expect(meta).toContain('# Tier ladder');
  expect(meta).not.toContain('naming');
  expect((await hos.client.listTopics()).find((t) => t.id === tiers.id)!.title).toBe('Price tiers');
  await expect(hos.client.renameDiagram(first.id, '  ')).rejects.toMatchObject({ status: 400 });
  expect((await hos.client.listDiagrams(tiers.id)).map((d) => d.id).sort()).toEqual([first.id, second.id].sort());
});

test('New diagram makes a topic named after it with no chat yet; renaming the diagram renames that topic', async () => {
  const { hos, stream } = await world();

  const made = await hos.client.newDiagram();

  expect(made).toMatchObject({ id: 'diagram-1', title: 'Diagram 1', chats: [], naming: true });
  const topic = (await hos.client.listTopics()).find((t) => t.id === made.topic)!;
  expect(topic.title).toBe('Diagram 1');
  await stream.until(changed(made.id));
  expect(stream.events.some((e) => e.type === 'chat.created' && e.chat.topicId === topic.id)).toBe(false);

  await hos.client.renameDiagram(made.id, 'Checkout flow');

  expect((await hos.client.listTopics()).find((t) => t.id === topic.id)!.title).toBe('Checkout flow');
  expect((await hos.client.newDiagram('Named')).title).toBe('Named');
});

test('the first message on a diagram starts a chat linked to it, named by that message, and briefed as linked', async () => {
  const { hos, brain, stream, topic } = await world();
  const { topic: t, chat: main } = await topic('Gift tiers');
  const diagram = await hos.client.createDiagram(t.id);

  const drawn = await hos.client.addTopicChat(t.id, { diagramId: diagram.id });

  expect(drawn.id).not.toBe(main.id);
  expect(await hos.client.diagram(diagram.id)).toMatchObject({ chats: [drawn.lineageId] });
  expect(await readFile(join(brain, 'diagrams', diagram.id, 'diagram.md'), 'utf8')).not.toContain('chat:');
  const second = await hos.client.addTopicChat(t.id, { diagramId: diagram.id });
  expect((await hos.client.diagram(diagram.id)).chats).toEqual([drawn.lineageId, second.lineageId]);

  await hos.client.sendMessage(drawn.id, `[diagram ${diagram.id}] sketch the tiers, name it Tier ladder`);
  const events = await stream.until((es) => es.some((e) => e.type === 'message.completed' && e.chatId === drawn.id));
  const briefing = (events.find((e) => e.type === 'message.completed' && e.chatId === drawn.id) as { text: string }).text;
  expect(briefing).toContain(`- ${diagram.id} · ${diagram.title} · ${diagram.path} · linked to this chat`);
  await waitFor(async () => (await hos.client.diagram(diagram.id)).title === 'Tier ladder');
  expect(await hos.client.diagram(diagram.id)).toMatchObject({ naming: false });

  await hos.client.sendMessage(main.id, 'hello');
  const later = await stream.until((es) => es.some((e) => e.type === 'message.completed' && e.chatId === main.id));
  const mainBriefing = (later.find((e) => e.type === 'message.completed' && e.chatId === main.id) as { text: string }).text;
  expect(mainBriefing).toContain('Diagrams in this topic');
  expect(mainBriefing).not.toContain(' · linked to this chat');
});

test('search matches a text label inside a shape, and the scene endpoint returns the live elements', async () => {
  const { hos, topic, bus } = await world();
  const { topic: t, chat } = await topic('Payments');
  await hos.client.createDiagram(t.id, 'Architecture');
  await hos.client.createDiagram(t.id, 'Roadmap');

  const applied = await bus(chat.id, 'diagram_apply', { id: 'architecture', ops: [{ op: 'add', type: 'rectangle', text: 'Stripe Webhook' }] });

  expect(applied.isError).toBe(false);
  expect((await hos.client.searchDiagrams('webhook')).map((d) => d.id)).toEqual(['architecture']);
  expect((await hos.client.searchDiagrams('ROADMAP')).map((d) => d.id)).toEqual(['roadmap']);
  expect(await hos.client.searchDiagrams('nothing like this')).toEqual([]);
  const scene = await hos.client.diagramScene('architecture');
  expect(scene.files).toEqual({});
  expect(scene.elements.map((e) => e.type).sort()).toEqual(['rectangle', 'text']);
  expect(scene.elements.find((e) => e.type === 'text')).toMatchObject({ text: 'Stripe Webhook' });
  expect(await hos.client.diagram('architecture')).toMatchObject({ elementCount: 2, updatedBy: 'agent', hasInk: false });
});

test('old diagram.md files read as one topic; an old standalone one links its home topic’s first chat', async () => {
  const { hos, brain, topic } = await world();
  const { topic: a } = await topic('Legacy');
  const { topic: b } = await topic('Second');
  const { topic: home, chat: homeChat } = await topic('Old sketch');
  const write = async (id: string, front: string) => {
    await mkdir(join(brain, 'diagrams', id), { recursive: true });
    await writeFile(join(brain, 'diagrams', id, 'diagram.md'), `---\n${front}created: 2026-10-12T00:00:00.000Z\n---\n\n# ${id}\n`);
  };
  await write('single', `title: Single\ntopic: ${a.id}\n`);
  await write('linked', `title: Linked\ntopics:\n  - ${a.id}\n  - ${b.id}\n`);
  await write('solo', `title: Solo\ntopics:\n  - ${home.id}\n  - ${a.id}\nhome: ${home.id}\nstandalone: true\n`);

  expect((await hos.client.listDiagrams(a.id)).map((d) => [d.id, d.chats])).toEqual([
    ['linked', []],
    ['single', []],
  ]);
  expect(await hos.client.listDiagrams(b.id)).toEqual([]);
  expect(await hos.client.diagram('solo')).toMatchObject({ topic: home.id, chats: [homeChat.lineageId] });

  await hos.client.renameDiagram('solo', 'Solo board');

  expect(await readFile(join(brain, 'diagrams/solo/diagram.md'), 'utf8')).toBe(
    `---\ntitle: Solo board\ntopic: ${home.id}\ncreated: 2026-10-12T00:00:00.000Z\n---\n\n# solo\n`,
  );
});

test('a chat is briefed on its topic’s diagrams, and lists and creates them over the bus', async () => {
  const { hos, stream, topic, bus } = await world();
  const { topic: t, chat } = await topic('Gift tiers');
  const { topic: second } = await topic('Second');
  await hos.client.createDiagram(t.id, 'Tier ladder');
  await hos.client.createDiagram(second.id, 'Elsewhere');

  await hos.client.sendMessage(chat.id, 'hello');
  const events = await stream.until((es) => es.some((e) => e.type === 'message.completed' && e.chatId === chat.id));
  const briefing = (events.find((e) => e.type === 'message.completed' && e.chatId === chat.id) as { text: string }).text;
  expect(briefing).toContain('Diagrams in this topic');
  expect(briefing).toContain('- tier-ladder · Tier ladder · diagrams/tier-ladder/board.excalidraw');
  expect(briefing).not.toContain('elsewhere');

  const created = await bus(chat.id, 'diagram_create', { title: 'Side note' });
  expect(created).toMatchObject({ isError: false, output: 'Created diagram side-note at diagrams/side-note/board.excalidraw in your topic.' });
  expect(await hos.client.diagram('side-note')).toMatchObject({ topic: t.id, naming: false });
  const mine = await bus(chat.id, 'diagram_list');
  expect(mine.output).toContain('side-note');
  expect(mine.output).not.toContain('elsewhere');
  const found = await bus(chat.id, 'diagram_list', { query: 'elsew' });
  expect(found.output).toContain('elsewhere · "Elsewhere" · diagrams/elsewhere/board.excalidraw · in another topic');
});

test('every agent apply is a brain commit of the diagram folder; Versions lists them and Restore brings one back as a new version', async () => {
  const { hos, brain, stream, topic, bus } = await world();
  const { topic: t, chat } = await topic('Flows');
  await hos.client.createDiagram(t.id, 'Flow');
  const tab = await openTab(hos.client, 'flow');

  await bus(chat.id, 'diagram_apply', { id: 'flow', ops: [{ op: 'add', id: 'one', type: 'rectangle', text: 'One' }] });
  await stream.until((es) => committed('flow')(es).length >= 1);
  await bus(chat.id, 'diagram_apply', { id: 'flow', ops: [{ op: 'add', id: 'two', type: 'ellipse', text: 'Two' }, { op: 'delete', ids: ['one'] }] });
  await stream.until((es) => committed('flow')(es).length >= 2);

  const versions = await hos.client.diagramVersions('flow');
  expect(versions).toEqual([
    { sha: expect.stringMatching(/^[0-9a-f]{40}$/), at: expect.any(Number), who: 'agent', summary: '2 op(s), +1 new' },
    { sha: expect.stringMatching(/^[0-9a-f]{40}$/), at: expect.any(Number), who: 'agent', summary: '1 op(s), +1 new' },
  ]);
  expect(git(brain, 'show', '--name-only', '--format=', versions[1]!.sha).split('\n').sort()).toEqual(['diagrams/flow/board.excalidraw', 'diagrams/flow/diagram.md']);
  expect(git(brain, 'log', '-1', '--format=%s', versions[0]!.sha)).toBe('hos: diagram flow · agent · 2 op(s), +1 new · 1 file(s)');

  const seen = tab.frames.length;
  const restored = await hos.client.restoreDiagram('flow', versions[1]!.sha);

  expect(restored.applyId).toMatch(/^[a-z0-9]{6}$/);
  expect(labels(await hos.client.diagramScene('flow'))).toEqual(['One']);
  await waitFor(() => tab.frames.length > seen);
  expect(tab.frames.at(-1)).toMatchObject({ type: 'update', agent: true });
  expect(tab.frames.at(-1)!.elements!.map((e) => [e.id, !!e.isDeleted]).filter(([id]) => id === 'one' || id === 'two')).toEqual(
    expect.arrayContaining([
      ['one', false],
      ['two', true],
    ]),
  );
  await stream.until((es) => committed('flow')(es).length >= 3);
  const after = await hos.client.diagramVersions('flow');
  expect(after).toHaveLength(3);
  expect(after[0]).toMatchObject({ who: 'user', summary: `restored ${versions[1]!.sha.slice(0, 7)}` });
  const saved = JSON.parse(await readFile(join(brain, 'diagrams/flow/board.excalidraw'), 'utf8')) as Scene;
  expect(labels(saved)).toEqual(['One']);
  await expect(hos.client.restoreDiagram('flow', 'abcdef0')).rejects.toMatchObject({ status: 404 });
  await expect(hos.client.restoreDiagram('flow', 'HEAD; rm')).rejects.toMatchObject({ status: 400 });
});

test('two applies in quick succession are two checkpoints, each holding only its own state', async () => {
  const { hos, brain, stream, topic, bus } = await world();
  const { topic: t, chat } = await topic('Flows');
  await hos.client.createDiagram(t.id, 'Flow');

  await bus(chat.id, 'diagram_apply', { id: 'flow', ops: [{ op: 'add', id: 'one', type: 'rectangle', text: 'One' }] });
  await bus(chat.id, 'diagram_apply', { id: 'flow', ops: [{ op: 'add', id: 'two', type: 'ellipse', text: 'Two' }] });
  await stream.until((es) => committed('flow')(es).length >= 2);

  const [second, first] = await hos.client.diagramVersions('flow');
  const at = (sha: string) => labels(JSON.parse(git(brain, 'show', `${sha}:diagrams/flow/board.excalidraw`)) as Scene);
  expect(at(first!.sha)).toHaveLength(1);
  expect(at(second!.sha)).toEqual(['One', 'Two']);
  await waitFor(async () => labels(JSON.parse(await readFile(join(brain, 'diagrams/flow/board.excalidraw'), 'utf8')) as Scene).length === 2);
});

test('human edits are checkpointed once they have been quiet for 30 s', async () => {
  const { hos, stream, topic } = await world();
  const { topic: t } = await topic('Sketches');
  await hos.client.createDiagram(t.id, 'Sketch');
  const tab = await openTab(hos.client, 'sketch');
  const ink = (version: number) => ({ id: 'ink', type: 'freedraw', x: 0, y: 0, width: 10, height: 10, points: [[0, 0], [10, version]], version, versionNonce: version });

  tab.send({ type: 'update', elements: [ink(1)] });
  await waitFor(async () => (await hos.client.diagram('sketch')).elementCount === 1);
  await hos.clock.advance(29_000);
  tab.send({ type: 'update', elements: [ink(2)] });
  await waitFor(async () => (await hos.client.diagramScene('sketch')).elements[0]!.version === 2);
  await hos.clock.advance(29_000);
  expect(committed('sketch')(stream.events)).toEqual([]);

  await hos.clock.advance(1_000);

  await stream.until((es) => committed('sketch')(es).length === 1);
  expect(await hos.client.diagramVersions('sketch')).toEqual([expect.objectContaining({ who: 'user', summary: 'edited' })]);
  expect(await hos.client.diagram('sketch')).toMatchObject({ updatedBy: 'user', hasInk: true });
});

test('a brain sweep between a saved edit and its checkpoint leaves the diagram for its own commit, so Versions never shows the sweep', async () => {
  const { hos, brain, stream, topic } = await world();
  const { topic: t, chat } = await topic('Sketches');
  await hos.client.createDiagram(t.id, 'Sketch');
  const tab = await openTab(hos.client, 'sketch');
  tab.send({ type: 'update', elements: [{ id: 'ink', type: 'freedraw', x: 0, y: 0, width: 10, height: 10, points: [[0, 0], [10, 1]], version: 1, versionNonce: 1 }] });
  await waitFor(async () => (await readFile(join(brain, 'diagrams/sketch/board.excalidraw'), 'utf8')).includes('"ink"'));
  await writeFile(join(brain, 'other.md'), 'x\n');

  await hos.client.sendMessage(chat.id, 'hello');
  const swept = (await stream.until((es) => es.some((e) => e.type === 'brain.committed' && e.chatId === null && e.files.includes('other.md')))).find(
    (e) => e.type === 'brain.committed' && e.files.includes('other.md'),
  ) as Extract<HosEvent, { type: 'brain.committed' }>;
  expect(swept.files).toEqual(['other.md']);

  await hos.clock.advance(30_000);
  await stream.until((es) => committed('sketch')(es).length === 1);
  expect(await hos.client.diagramVersions('sketch')).toEqual([expect.objectContaining({ who: 'user', summary: 'edited' })]);
});

test('the chat card Undo reverts one apply, and refuses when its elements changed since', async () => {
  const { hos, topic, bus } = await world();
  const { topic: t, chat } = await topic('Undo');
  await hos.client.createDiagram(t.id, 'Board');
  const tab = await openTab(hos.client, 'board');

  const added = await bus(chat.id, 'diagram_apply', { id: 'board', ops: [{ op: 'add', id: 'box', type: 'rectangle', x: 0, y: 0, text: 'Box' }] });
  const renamed = await bus(chat.id, 'diagram_apply', { id: 'board', ops: [{ op: 'update', id: 'box', x: 300, text: 'Renamed' }] });
  expect(added.output).toMatch(/\(apply [a-z0-9]{6}\)/);

  expect(await hos.client.undoDiagramApply('board', applyIdOf(renamed.output))).toMatchObject({ changed: 2 });
  const back = await hos.client.diagramScene('board');
  expect(labels(back)).toEqual(['Box']);
  expect(byId(back, 'box')).toMatchObject({ x: 0 });
  expect(tab.frames.at(-1)).toMatchObject({ type: 'update', agent: true });

  await hos.client.undoDiagramApply('board', applyIdOf(added.output));
  expect((await hos.client.diagramScene('board')).elements).toEqual([]);
  await expect(hos.client.undoDiagramApply('board', applyIdOf(added.output))).rejects.toMatchObject({ status: 404 });

  const again = await bus(chat.id, 'diagram_apply', { id: 'board', ops: [{ op: 'add', id: 'moved', type: 'ellipse', x: 0, y: 0 }] });
  const live = byId(await hos.client.diagramScene('board'), 'moved') as { version: number };
  tab.send({ type: 'update', elements: [{ ...live, x: 50, version: live.version + 1 }] });
  await waitFor(async () => byId(await hos.client.diagramScene('board'), 'moved').x === 50);

  await expect(hos.client.undoDiagramApply('board', applyIdOf(again.output))).rejects.toMatchObject({ status: 409, message: expect.stringContaining('moved changed since') });
  expect(byId(await hos.client.diagramScene('board'), 'moved')).toMatchObject({ x: 50, isDeleted: false });
});

test('diagram_apply adds notes, frames around children and plain lines as valid Excalidraw elements', async () => {
  const { hos, topic, bus } = await world();
  const { topic: t, chat } = await topic('Shapes');
  await hos.client.createDiagram(t.id, 'Shapes');

  const applied = await bus(chat.id, 'diagram_apply', {
    id: 'shapes',
    ops: [
      { op: 'add', id: 'note', type: 'note', x: 0, y: 300, text: 'Remember' },
      { op: 'add', id: 'a', type: 'rectangle', x: 0, y: 0, text: 'A' },
      { op: 'add', id: 'b', type: 'ellipse', x: 300, y: 0 },
      { op: 'add', id: 'link', type: 'line', from: 'a', to: 'b' },
      { op: 'add', id: 'group', type: 'frame', text: 'Group', children: ['a', 'b'] },
    ],
  });

  expect(applied.isError).toBe(false);
  const scene = await hos.client.diagramScene('shapes');
  for (const e of scene.elements) expect(e).toMatchObject({ id: expect.any(String), version: expect.any(Number), versionNonce: expect.any(Number), seed: expect.any(Number), isDeleted: false });
  const note = byId(scene, 'note');
  expect(note).toMatchObject({ type: 'rectangle', backgroundColor: '#ffec99', strokeColor: '#f08c00', fillStyle: 'solid', width: 200, height: 120 });
  const noteLabel = scene.elements.find((e) => e.containerId === 'note')!;
  expect(noteLabel).toMatchObject({ type: 'text', text: 'Remember' });
  expect(note.boundElements).toEqual([{ id: noteLabel.id, type: 'text' }]);
  expect(byId(scene, 'link')).toMatchObject({ type: 'line', startArrowhead: null, endArrowhead: null, startBinding: null, endBinding: null, points: [[0, 0], [expect.any(Number), expect.any(Number)]] });
  expect(byId(scene, 'a').boundElements).toEqual([{ id: expect.any(String), type: 'text' }]);
  expect(byId(scene, 'group')).toMatchObject({ type: 'frame', name: 'Group', x: -40, y: -40, width: 560, height: 160 });
  expect(byId(scene, 'a').frameId).toBe('group');
  expect(byId(scene, 'b').frameId).toBe('group');
  expect(scene.elements.find((e) => e.containerId === 'a')!.frameId).toBe('group');
  expect(byId(scene, 'note').frameId).toBeNull();
  const refused = await bus(chat.id, 'diagram_apply', { id: 'shapes', ops: [{ op: 'add', type: 'frame', children: ['ghost'] }] });
  expect(refused.output).toContain('no element "ghost"');
});

test('images travel with the room: files sync live, save to board.excalidraw and reload; a file over 2 MB is refused', async () => {
  const { hos, brain, topic } = await world();
  const { topic: t } = await topic('Pictures');
  await hos.client.createDiagram(t.id, 'Pics');
  const drawer = await openTab(hos.client, 'pics');
  const watcher = await openTab(hos.client, 'pics');
  const photo = { id: 'photo', mimeType: 'image/png', dataURL: `data:image/png;base64,${Buffer.from('tiny png').toString('base64')}`, created: 1 };
  const image = { id: 'img', type: 'image', fileId: 'photo', status: 'saved', x: 0, y: 0, width: 40, height: 40, version: 1, versionNonce: 1 };

  drawer.send({ type: 'update', elements: [image], files: { photo } });
  await waitFor(() => watcher.frames.some((f) => f.type === 'update' && !!f.files?.photo));
  drawer.send({ type: 'update', elements: [], files: { huge: { id: 'huge', mimeType: 'image/png', dataURL: `data:image/png;base64,${'A'.repeat(2_900_000)}` } } });
  await waitFor(() => drawer.frames.some((f) => f.type === 'error' && /over 2 MB/.test(f.message ?? '')));

  expect(Object.keys((await hos.client.diagramScene('pics')).files)).toEqual(['photo']);
  expect(watcher.frames.some((f) => !!f.files?.huge)).toBe(false);
  drawer.close();
  watcher.close();
  await hos.stop();
  const saved = JSON.parse(await readFile(join(brain, 'diagrams/pics/board.excalidraw'), 'utf8')) as { files: Record<string, unknown> };
  expect(saved.files).toEqual({ photo });

  const again = await startTestDaemon({ brainDir: brain, dataDir: hos.dataDir, passkeyOf: hos.dataDir });
  expect((await again.client.diagramScene('pics')).files).toEqual({ photo });
  const reopened = await openTab(again.client, 'pics');
  expect(reopened.frames[0]).toMatchObject({ type: 'init', files: { photo } });
  reopened.close();
});

test('diagram_import_mermaid asks the open tab to convert, records the result as one undoable apply, and needs a tab', async () => {
  const { hos, stream, topic, bus } = await world();
  const { topic: t, chat } = await topic('Mermaid');
  await hos.client.createDiagram(t.id, 'Graph');

  const closed = await bus(chat.id, 'diagram_import_mermaid', { id: 'graph', mermaid: 'graph TD; A-->B' });
  expect(closed.output).toContain('isn’t open in any tab');

  const tab = await openTab(hos.client, 'graph');
  tab.ws.addEventListener('message', (event) => {
    const frame = JSON.parse(String(event.data)) as { type: string; reqId?: string; mermaid?: string };
    if (frame.type !== 'mermaid') return;
    const box = (id: string, x: number) => ({ id, type: 'rectangle', x, y: 0, width: 100, height: 50, version: 1, versionNonce: 1, isDeleted: false });
    tab.send({ type: 'mermaid', reqId: frame.reqId, elements: [box('m-a', 400), box('m-b', 600)], files: {} });
  });
  const imported = await bus(chat.id, 'diagram_import_mermaid', { id: 'graph', mermaid: 'graph TD; A-->B' });

  expect(imported.output).toMatch(/Imported the Mermaid diagram as 2 element\(s\).*\(apply [a-z0-9]{6}\)/);
  expect((await hos.client.diagramScene('graph')).elements.map((e) => e.id).sort()).toEqual(['m-a', 'm-b']);
  expect(tab.frames.at(-1)).toMatchObject({ type: 'update', agent: true });
  await stream.until((es) => committed('graph')(es).length === 1);
  expect((await hos.client.diagramVersions('graph'))[0]).toMatchObject({ who: 'agent', summary: 'mermaid import, +2 new' });
  await hos.client.undoDiagramApply('graph', applyIdOf(imported.output));
  expect((await hos.client.diagramScene('graph')).elements).toEqual([]);
});

test('diagram_apply fits long labels to their boxes, places with near, and styles fills, sizes, dashes and arrow ends', async () => {
  const { hos, topic, bus } = await world();
  const { topic: t, chat } = await topic('Fit');
  await hos.client.createDiagram(t.id, 'Fit');
  const long = 'The checkout extension reads the cart attributes and decides which free gift tier applies before payment';

  const applied = await bus(chat.id, 'diagram_apply', {
    id: 'fit',
    ops: [
      { op: 'add', id: 'wide', type: 'rectangle', x: 0, y: 0, text: long },
      { op: 'add', id: 'narrow', type: 'rectangle', x: 0, y: 400, width: 180, height: 80, text: long },
      { op: 'add', id: 'a', type: 'rectangle', x: 0, y: 800, text: 'Cart', fill: 'green' },
      { op: 'add', id: 'b', type: 'ellipse', text: 'Gift engine', near: { id: 'a', side: 'right', gap: 160 } },
      { op: 'add', id: 'ab', type: 'arrow', from: 'a', to: 'b', label: 'reads', stroke: 'dashed', ends: 'both' },
      { op: 'add', id: 'title', type: 'text', x: 0, y: -100, text: 'Free gift flow', size: 'title', align: 'left' },
    ],
  });

  expect(applied.output).toContain('Check: clean');
  const scene = await hos.client.diagramScene('fit');
  const labelOf = (id: string) => scene.elements.find((e) => e.containerId === id)!;
  const wide = byId(scene, 'wide') as { width: number; height: number };
  expect(wide.width).toBeGreaterThan(180);
  expect(wide.width).toBeLessThanOrEqual(360);
  expect(wide.height).toBeGreaterThan(80);
  const narrow = byId(scene, 'narrow') as { width: number; height: number };
  expect(narrow.width).toBe(180);
  expect(narrow.height).toBeGreaterThan(wide.height);
  for (const id of ['wide', 'narrow']) {
    const label = labelOf(id) as { width: number; height: number; text: string; originalText: string };
    const box = byId(scene, id) as { width: number; height: number };
    expect(label.originalText).toBe(long);
    expect(label.text).toContain('\n');
    expect(label.width).toBeLessThanOrEqual(box.width - 20);
    expect(label.height).toBeLessThanOrEqual(box.height - 20);
  }
  const a = byId(scene, 'a') as { x: number; y: number; width: number; height: number };
  const b = byId(scene, 'b') as { x: number; y: number; width: number; height: number };
  expect(b.x).toBe(a.x + a.width + 160);
  expect(b.y + b.height / 2).toBe(a.y + a.height / 2);
  expect(a).toMatchObject({ backgroundColor: '#b2f2bb' });
  expect(byId(scene, 'ab')).toMatchObject({ strokeStyle: 'dashed', startArrowhead: 'arrow', endArrowhead: 'arrow' });
  expect(labelOf('ab')).toMatchObject({ type: 'text', text: 'reads', fontSize: 16 });
  expect(byId(scene, 'ab').boundElements).toEqual(expect.arrayContaining([{ id: labelOf('ab').id, type: 'text' }]));
  expect(byId(scene, 'title')).toMatchObject({ fontSize: 28, textAlign: 'left', containerId: null });

  const read = await bus(chat.id, 'diagram_read', { id: 'fit' });
  expect(read.output).toContain('"fill":"#b2f2bb"');
  expect(read.output).toContain('"stroke":"dashed"');
  expect(read.output).toContain(`"text":"${long}"`);
});

test('moving a shape moves its label and its arrows, and the check line names overlaps and arrows through shapes', async () => {
  const { hos, topic, bus } = await world();
  const { topic: t, chat } = await topic('Move');
  await hos.client.createDiagram(t.id, 'Move');
  await bus(chat.id, 'diagram_apply', {
    id: 'move',
    ops: [
      { op: 'add', id: 'a', type: 'rectangle', x: 0, y: 0, text: 'A' },
      { op: 'add', id: 'b', type: 'rectangle', x: 600, y: 0, text: 'B' },
      { op: 'add', id: 'ab', type: 'arrow', from: 'a', to: 'b', label: 'calls' },
    ],
  });

  const moved = await bus(chat.id, 'diagram_apply', { id: 'move', ops: [{ op: 'update', id: 'a', y: 300 }] });

  expect(moved.isError).toBe(false);
  const scene = await hos.client.diagramScene('move');
  const label = scene.elements.find((e) => e.containerId === 'a') as { y: number; height: number };
  expect(label.y + label.height / 2).toBe(340);
  const arrow = byId(scene, 'ab') as { x: number; y: number; points: number[][] };
  expect(arrow.y).toBeGreaterThan(200);
  expect(arrow.y + arrow.points[1]![1]!).toBeLessThan(90);
  const arrowLabel = scene.elements.find((e) => e.containerId === 'ab') as { x: number; y: number; width: number; height: number };
  expect(arrowLabel.x + arrowLabel.width / 2).toBeCloseTo(arrow.x + arrow.points[1]![0]! / 2);

  const crowded = await bus(chat.id, 'diagram_apply', {
    id: 'move',
    ops: [
      { op: 'add', id: 'c', type: 'rectangle', x: 100, y: 320, text: 'C' },
      { op: 'add', id: 'wall', type: 'rectangle', x: 300, y: 100, width: 60, height: 120 },
    ],
  });
  expect(crowded.output).toMatch(/1 overlap\(s\) \(a×c\)/);
  expect(crowded.output).toMatch(/1 arrow\(s\) through shapes \(ab→wall\)/);
});

test('fit re-fits labels that spill out of their boxes on an existing board, as one undoable apply', async () => {
  const { hos, topic, bus } = await world();
  const { topic: t, chat } = await topic('Old');
  await hos.client.createDiagram(t.id, 'Old');
  const tab = await openTab(hos.client, 'old');
  const box = { id: 'box', type: 'rectangle', x: 0, y: 0, width: 200, height: 60, version: 1, versionNonce: 1, isDeleted: false, boundElements: [{ id: 'lbl', type: 'text' }] };
  const lbl = { id: 'lbl', type: 'text', x: 0, y: 0, width: 600, height: 75, text: 'one\ntwo\nthree', originalText: 'one two three four five six seven eight nine ten eleven twelve', fontSize: 20, containerId: 'box', version: 1, versionNonce: 1, isDeleted: false };
  tab.send({ type: 'update', elements: [box, lbl] });
  await waitFor(async () => (await hos.client.diagram('old')).elementCount === 2);

  const before = await bus(chat.id, 'diagram_read', { id: 'old' });
  expect(before.output).toContain('Check: 1 label overflow (box)');

  const fitted = await bus(chat.id, 'diagram_apply', { id: 'old', ops: [{ op: 'fit' }] });

  expect(fitted.output).toContain('Grew box to fit their labels.');
  expect(fitted.output).toContain('Check: clean');
  const scene = await hos.client.diagramScene('old');
  expect((byId(scene, 'box') as { height: number }).height).toBeGreaterThan(60);
  expect((byId(scene, 'lbl') as { width: number }).width).toBeLessThanOrEqual(180);
  await hos.client.undoDiagramApply('old', applyIdOf(fitted.output));
  expect(byId(await hos.client.diagramScene('old'), 'box')).toMatchObject({ height: 60 });
});

test('diagram_layout draws a grouped graph with no overlaps and bound arrows as one undoable apply, and re-runs in place keeping ids and colours', async () => {
  const { hos, topic, bus } = await world();
  const { topic: t, chat } = await topic('Layout');
  await hos.client.createDiagram(t.id, 'Arch');
  await bus(chat.id, 'diagram_apply', { id: 'arch', ops: [{ op: 'add', id: 'old', type: 'rectangle', x: 0, y: 0, text: 'Already here' }] });
  const spec = {
    id: 'arch',
    kind: 'graph',
    title: 'Free gift flow',
    nodes: [
      { id: 'cart', label: 'Cart', shape: 'ellipse' },
      { id: 'fn', label: 'Discount function', focal: true },
      { id: 'tier', label: 'Which tier applies?', shape: 'diamond' },
      { id: 'pg', label: 'PostgreSQL', group: 'store' },
      { id: 'redis', label: 'Redis cache', group: 'store' },
    ],
    groups: [{ id: 'store', label: 'Storage' }],
    edges: [
      { from: 'cart', to: 'fn', label: 'reads' },
      { from: 'fn', to: 'tier' },
      { from: 'tier', to: 'pg', label: 'saves' },
      { from: 'tier', to: 'redis', dashed: true },
    ],
  };

  const drawn = await bus(chat.id, 'diagram_layout', spec);

  expect(drawn.isError).toBe(false);
  expect(drawn.output).toMatch(/Laid out graph "(layout-[a-z0-9]{4})": 5 box\(es\), 4 arrow\(s\), 1 group frame\(s\) \(apply [a-z0-9]{6}\)/);
  expect(drawn.output).toContain('Check: clean');
  const lid = /"(layout-[a-z0-9]{4})"/.exec(drawn.output)![1]!;
  const scene = await hos.client.diagramScene('arch');
  const el = (key: string) => byId(scene, `${lid}-${key}`) as Record<string, unknown> & { x: number; y: number; width: number; height: number };
  expect(el('n-cart')).toMatchObject({ type: 'ellipse' });
  expect(el('n-tier')).toMatchObject({ type: 'diamond' });
  expect(el('n-fn')).toMatchObject({ strokeWidth: 4 });
  expect(el('g-store')).toMatchObject({ type: 'frame', name: 'Storage' });
  expect(el('n-pg').frameId).toBe(`${lid}-g-store`);
  expect(el('title')).toMatchObject({ type: 'text', text: 'Free gift flow', fontSize: 28 });
  expect(el('n-cart').x).toBeGreaterThan(180);
  const arrows = scene.elements.filter((e) => e.type === 'arrow');
  expect(arrows).toHaveLength(4);
  for (const arrow of arrows) {
    const start = (arrow.startBinding as { elementId: string }).elementId;
    const end = (arrow.endBinding as { elementId: string }).elementId;
    expect(byId(scene, start).boundElements).toEqual(expect.arrayContaining([{ id: arrow.id, type: 'arrow' }]));
    expect(byId(scene, end).boundElements).toEqual(expect.arrayContaining([{ id: arrow.id, type: 'arrow' }]));
  }
  expect(scene.elements.find((e) => e.containerId === `${lid}-e-cart-fn-0`)).toMatchObject({ text: 'reads', fontSize: 16 });
  expect(el('e-tier-redis-3')).toMatchObject({ strokeStyle: 'dashed' });
  const read = await bus(chat.id, 'diagram_read', { id: 'arch' });
  expect(read.output).toContain(`"layout":"${lid}"`);
  expect(read.output).toContain('"spec":{"kind":"graph"');

  const tab = await openTab(hos.client, 'arch');
  const fn = el('n-fn');
  tab.send({ type: 'update', elements: [{ ...fn, strokeColor: '#e03131', version: Number(fn.version) + 1, versionNonce: 7 }] });
  await waitFor(async () => byId(await hos.client.diagramScene('arch'), `${lid}-n-fn`).strokeColor === '#e03131');

  const rerun = await bus(chat.id, 'diagram_layout', { ...spec, layout: lid, nodes: spec.nodes.filter((n) => n.id !== 'redis'), edges: spec.edges.slice(0, 3) });

  expect(rerun.output).toContain(`Re-laid out graph "${lid}": 4 box(es), 3 arrow(s)`);
  const again = await hos.client.diagramScene('arch');
  expect(byId(again, `${lid}-n-fn`)).toMatchObject({ strokeColor: '#e03131' });
  expect(again.elements.some((e) => e.id === `${lid}-n-redis`)).toBe(false);
  expect(again.elements.filter((e) => e.type === 'arrow')).toHaveLength(3);
  expect(byId(again, 'old')).toMatchObject({ x: 0, y: 0 });

  await hos.client.undoDiagramApply('arch', applyIdOf(rerun.output));
  expect((await hos.client.diagramScene('arch')).elements.some((e) => e.id === `${lid}-n-redis`)).toBe(true);
  const missing = await bus(chat.id, 'diagram_layout', { ...spec, layout: 'layout-none' });
  expect(missing.output).toContain('no layout "layout-none"');
  const bad = await bus(chat.id, 'diagram_layout', { id: 'arch', kind: 'graph', nodes: [{ id: 'a', label: 'A' }], edges: [{ from: 'a', to: 'ghost' }] });
  expect(bad.output).toContain('no node "ghost"');
});

test('diagram_layout draws a sequence: actors, dashed lifelines, ordered messages with dashed replies and a self call', async () => {
  const { hos, topic, bus } = await world();
  const { topic: t, chat } = await topic('Sequence');
  await hos.client.createDiagram(t.id, 'Seq');

  const drawn = await bus(chat.id, 'diagram_layout', {
    id: 'seq',
    kind: 'sequence',
    actors: [
      { id: 'shop', label: 'Storefront' },
      { id: 'api', label: 'Shop API' },
      { id: 'db', label: 'Mongo' },
    ],
    messages: [
      { from: 'shop', to: 'api', label: 'POST /gift-tiers with the cart total' },
      { from: 'api', to: 'api', label: 'pick tier' },
      { from: 'api', to: 'db', label: 'find tier' },
      { from: 'api', to: 'shop', label: 'tier + gift', reply: true },
    ],
  });

  expect(drawn.output).toContain('Laid out sequence');
  expect(drawn.output).toContain('Check: clean');
  const scene = await hos.client.diagramScene('seq');
  const lid = /"(layout-[a-z0-9]{4})"/.exec(drawn.output)![1]!;
  const el = (key: string) => byId(scene, `${lid}-${key}`) as Record<string, unknown> & { x: number; y: number; width: number; height: number; points: number[][] };
  expect(el('a-shop-life')).toMatchObject({ type: 'line', strokeStyle: 'dashed' });
  const ys = [0, 1, 2, 3].map((i) => el(`m-${i}`).y);
  expect([...ys].sort((a, b) => a - b)).toEqual(ys);
  expect(el('m-1').points).toHaveLength(4);
  expect(el('m-3')).toMatchObject({ strokeStyle: 'dashed' });
  const gap = el('a-api').x + el('a-api').width / 2 - (el('a-shop').x + el('a-shop').width / 2);
  const label = scene.elements.find((e) => e.containerId === `${lid}-m-0`) as { width: number };
  expect(gap).toBeGreaterThan(label.width);
});

test('the check line flags an arrow label longer than its arrow', async () => {
  const { hos, topic, bus } = await world();
  const { topic: t, chat } = await topic('Short');
  await hos.client.createDiagram(t.id, 'Short');

  const applied = await bus(chat.id, 'diagram_apply', {
    id: 'short',
    ops: [
      { op: 'add', id: 'a', type: 'rectangle', x: 0, y: 0, text: 'A' },
      { op: 'add', id: 'b', type: 'rectangle', text: 'B', near: { id: 'a', side: 'right' } },
      { op: 'add', id: 'ab', type: 'arrow', from: 'a', to: 'b', label: 'reads the same cart' },
    ],
  });

  expect(applied.output).toContain('1 label overflow (ab label longer than its arrow)');
});

test('an add that reuses the id of a deleted element brings it back with its label and arrows, in a later call or the same one', async () => {
  const { hos, brain, topic, bus } = await world();
  const { topic: t, chat } = await topic('Revive');
  await hos.client.createDiagram(t.id, 'Revive');
  await bus(chat.id, 'diagram_apply', {
    id: 'revive',
    ops: [
      { op: 'add', id: 'd1', type: 'rectangle', x: 0, y: 0, text: 'Old' },
      { op: 'add', id: 'z', type: 'rectangle', x: 600, y: 200, text: 'Z' },
    ],
  });
  await bus(chat.id, 'diagram_apply', { id: 'revive', ops: [{ op: 'update', id: 'd1', x: 40 }] });
  await bus(chat.id, 'diagram_apply', { id: 'revive', ops: [{ op: 'delete', ids: ['d1'] }] });

  const revived = await bus(chat.id, 'diagram_apply', {
    id: 'revive',
    ops: [
      { op: 'add', id: 'd1', type: 'rectangle', x: 0, y: 200, text: 'New' },
      { op: 'add', id: 'a1', type: 'arrow', from: 'd1', to: 'z' },
    ],
  });

  expect(revived.isError).toBe(false);
  expect(revived.output).toContain('Check: clean');
  const scene = await hos.client.diagramScene('revive');
  expect(byId(scene, 'd1')).toMatchObject({ y: 200 });
  expect(scene.elements.find((e) => e.containerId === 'd1')).toMatchObject({ text: 'New' });
  expect(byId(scene, 'a1')).toMatchObject({ startBinding: { elementId: 'd1' } });
  await waitFor(async () => (JSON.parse(await readFile(join(brain, 'diagrams', 'revive', 'board.excalidraw'), 'utf8')) as Scene).elements.some((e) => e.id === 'd1' && e.y === 200));

  const again = await bus(chat.id, 'diagram_apply', {
    id: 'revive',
    ops: [
      { op: 'delete', ids: ['d1'] },
      { op: 'add', id: 'd1', type: 'rectangle', x: 0, y: 400, text: 'Again' },
    ],
  });

  expect(again.isError).toBe(false);
  expect(byId(await hos.client.diagramScene('revive'), 'd1')).toMatchObject({ y: 400 });
});

test('an add with the id of a live element is refused and changes nothing', async () => {
  const { hos, topic, bus } = await world();
  const { topic: t, chat } = await topic('Taken');
  await hos.client.createDiagram(t.id, 'Taken');
  await bus(chat.id, 'diagram_apply', { id: 'taken', ops: [{ op: 'add', id: 'd1', type: 'rectangle', x: 0, y: 0, text: 'Old' }] });
  const before = await hos.client.diagramScene('taken');

  const refused = await bus(chat.id, 'diagram_apply', { id: 'taken', ops: [{ op: 'add', id: 'd1', type: 'rectangle', x: 0, y: 300, text: 'New' }] });

  expect(refused.isError).toBe(true);
  expect(refused.output).toMatch(/already exists/);
  expect(await hos.client.diagramScene('taken')).toEqual(before);
});

test('the check line flags labels and arrows whose shape is missing or deleted', async () => {
  const { hos, topic, bus } = await world();
  const { topic: t, chat } = await topic('Orphans');
  await hos.client.createDiagram(t.id, 'Orphans');
  await bus(chat.id, 'diagram_apply', {
    id: 'orphans',
    ops: [
      { op: 'add', id: 'a', type: 'rectangle', x: 0, y: 0, text: 'A' },
      { op: 'add', id: 'b', type: 'rectangle', x: 600, y: 0, text: 'B' },
      { op: 'add', id: 'ab', type: 'arrow', from: 'a', to: 'b' },
    ],
  });

  const deleted = await bus(chat.id, 'diagram_apply', { id: 'orphans', ops: [{ op: 'delete', ids: ['a'] }] });

  expect(deleted.output).toContain('1 orphan(s) pointing at a missing shape (ab→a)');

  const tab = await openTab(hos.client, 'orphans');
  tab.send({ type: 'update', elements: [{ id: 't', type: 'text', x: 0, y: 400, width: 40, height: 25, text: 'lost', originalText: 'lost', fontSize: 20, containerId: 'ghost', version: 1, versionNonce: 1, isDeleted: false }] });
  await waitFor(async () => (await hos.client.diagramScene('orphans')).elements.some((e) => e.id === 't'));

  const read = await bus(chat.id, 'diagram_read', { id: 'orphans' });
  expect(read.output).toContain('t→ghost');
  expect(read.output).toContain('ab→a');
});
