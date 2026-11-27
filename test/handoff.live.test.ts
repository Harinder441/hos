import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { ClaudeAgentRuntime } from '../src/adapters/claude-agent-runtime.js';
import { TailscaleTransport } from '../src/adapters/tailscale-transport.js';
import { systemClock } from '../src/adapters/clock.js';
import type { HosEvent } from '../src/api/types.js';
import { startDaemon } from '../src/daemon.js';
import { CapturedNotifier } from '../src/fakes/captured-notifier.js';
import { FakeTransportIdentity } from '../src/fakes/fake-transport-identity.js';
import { cleanupAll, collect, git, signedInClient, tempDir, tempGitRepo } from './harness.js';
import { newTopic } from './topics.js';

afterEach(cleanupAll);

const HANDOFF_LINE = Number(process.env.HOS_LIVE_HANDOFF ?? 50_000);

describe.skipIf(!process.env.HOS_LIVE_CLAUDE)('live contract: a real Claude chat hands off to a successor (spends subscription quota: two chats)', () => {
  test('gen 1 crosses the handoff line, the user asks for a handoff, it writes a valid handoff with the skill, and gen 2 boots from it', async () => {
    const brainDir = await tempDir('hos-live-brain-');
    await writeFile(join(brainDir, 'CLAUDE.md'), '# brain\n');
    await mkdir(join(brainDir, 'hos'));
    const fixture = await readFile(join(import.meta.dirname, 'fixtures', 'policy.yaml'), 'utf8');
    await writeFile(
      join(brainDir, 'hos', 'policy.yaml'),
      fixture
        .replace(/^ {2}handoff: \d+/m, `  handoff: ${HANDOFF_LINE}`)
        .replace(/^ {2}backstop: \d+/m, `  backstop: ${HANDOFF_LINE + 60_000}`),
    );
    const repo = await tempGitRepo();
    const rows = Array.from({ length: 3600 }, (_, i) => `row ${i + 1}: ${['amber', 'quartz', 'quill', 'birch'][i % 4]} ${(i * 7919) % 1000}`);
    await writeFile(join(repo, 'data.txt'), `${rows.join('\n')}\n`);
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'data');

    const dataDir = await tempDir('hos-live-handoff-');
    const identity = new FakeTransportIdentity();
    const daemon = await startDaemon(
      { dataDir, port: 0, brainDir },
      {
        agentRuntime: new ClaudeAgentRuntime({ model: process.env.HOS_LIVE_MODEL ?? 'haiku' }),
        transport: new TailscaleTransport(identity),
        clock: systemClock,
        notifier: new CapturedNotifier(),
      },
    );
    const started = Date.now();
    try {
      const { client } = await signedInClient(daemon.url, identity, dataDir);
      const project = await client.createProject(repo);
      const workspace = await newTopic(client, project.id, 'live handoff');
      const chat = await client.createChat(workspace.id);
      const stream = collect(client);
      let asked = false;
      const handOff = client.subscribe((event) => {
        if (asked || event.type !== 'context.usage' || event.chatId !== chat.id || event.tokens < HANDOFF_LINE) return;
        asked = true;
        void client.handOff(chat.id).catch(() => {});
      });

      await client.sendMessage(
        chat.id,
        [
          'This is a two-step task in this repo. Step 1 now: read data.txt in full with the Read tool (all of it, in pages if needed) and count the rows whose word is quill; then call the hos bus tool update_card with text "quill=<n>" with your count.',
          'Step 2 (later, not now): reply with exactly one line "quill=<n>" with that count, without reading data.txt again.',
          'After step 1, reply "step 1 done" and stop.',
        ].join(' '),
      );
      const events = await stream
        .until((es) => es.some((e) => e.type === 'handoff.boot' || e.type === 'approval.requested'), 480_000)
        .catch(() => stream.events);
      handOff.close();

      const usage = (id: string) => events.flatMap((e) => (e.type === 'context.usage' && e.chatId === id ? [e.tokens] : []));
      const completed = events.find((e): e is Extract<HosEvent, { type: 'handoff.completed' }> => e.type === 'handoff.completed');
      const boot = events.find((e): e is Extract<HosEvent, { type: 'handoff.boot' }> => e.type === 'handoff.boot');
      const handoffText = completed ? await readFile(completed.handoff.path, 'utf8') : '';
      console.log(
        JSON.stringify(
          {
            seconds: Math.round((Date.now() - started) / 1000),
            gen1Usage: usage(chat.id),
            rejected: events.filter((e) => e.type === 'handoff.rejected').map((e) => (e as { problems: string[] }).problems),
            refusedTools: events.filter((e) => e.type === 'tool.completed' && e.chatId === chat.id && e.output.startsWith('[hos] Refused')).length,
            handoff: completed?.handoff ?? null,
            handoffChars: handoffText.length,
            bootTokens: boot?.tokens ?? null,
            tools: events.flatMap((e) => (e.type === 'tool.started' ? [`${e.chatId.slice(0, 8)} ${e.name} ${e.input.slice(0, 120)}`] : [])),
            approvals: events.flatMap((e) => (e.type === 'approval.requested' ? [`${e.tool} ${e.reason}`] : [])),
          },
          null,
          2,
        ),
      );

      expect(events.filter((e) => e.type === 'approval.requested')).toEqual([]);
      expect(completed?.handoff).toMatchObject({ chatId: chat.id, kind: 'agent', generation: 1 });
      expect(handoffText).toMatch(/quill=\d+/);
      expect(boot?.tokens).toBeGreaterThan(0);
    } finally {
      await daemon.stop();
    }
  }, 600_000);
});
