import { afterEach, describe, expect, test } from 'vitest';
import { TailscaleTransport } from '../src/adapters/tailscale-transport.js';
import { ClaudeAgentRuntime } from '../src/adapters/claude-agent-runtime.js';
import { systemClock } from '../src/adapters/clock.js';
import { startDaemon } from '../src/daemon.js';
import { CapturedNotifier } from '../src/fakes/captured-notifier.js';
import { FakeTransportIdentity } from '../src/fakes/fake-transport-identity.js';
import { cleanupAll, collect, signedInClient, tempDir, tempGitRepo } from './harness.js';
import { newTopic } from './topics.js';

afterEach(cleanupAll);

describe.skipIf(!process.env.HOS_LIVE_CLAUDE)('live contract: a real Claude chat on the hos bus (spends subscription quota)', () => {
  test('Claude sees the roster at turn start and updates its card through the bus without a permission card', async () => {
    const dataDir = await tempDir('hos-live-bus-');
    const identity = new FakeTransportIdentity();
    const daemon = await startDaemon(
      { dataDir, port: 0 },
      {
        agentRuntime: new ClaudeAgentRuntime({ model: process.env.HOS_LIVE_MODEL ?? 'haiku' }),
        transport: new TailscaleTransport(identity),
        clock: systemClock,
        notifier: new CapturedNotifier(),
      },
    );
    try {
      const { client } = await signedInClient(daemon.url, identity, dataDir);
      const project = await client.createProject(await tempGitRepo());
      const workspace = await newTopic(client, project.id, 'live bus');
      const chat = await client.createChat(workspace.id);
      const stream = collect(client);

      await client.sendMessage(
        chat.id,
        'Call the hos bus tool update_card once with text "the bus works". Then reply with one line: the 8-character chat id that the hos roster marks as (you). Use no other tools.',
      );
      const events = await stream.until(
        (es) =>
          es.some((e) => e.type === 'approval.requested') ||
          es.some((e) => e.type === 'chat.state' && e.chatId === chat.id && e.state === 'idle' && es.some((m) => m.type === 'message.completed')),
        180_000,
      );

      const tools = events.flatMap((e) => (e.type === 'tool.started' ? [`${e.name} ${e.input}`] : []));
      expect(events.filter((e) => e.type === 'approval.requested'), tools.join('\n')).toEqual([]);
      expect(events.find((e) => e.type === 'bus.call')).toMatchObject({ chatId: chat.id, tool: 'update_card', outcome: 'ok' });
      expect(events.find((e) => e.type === 'card.updated')).toMatchObject({ chatId: chat.id, card: 'the bus works' });
      const replies = events.filter((e) => e.type === 'message.completed' && e.chatId === chat.id).map((e) => (e as { text: string }).text).join('\n');
      expect(replies).toContain(chat.id.slice(0, 8));
    } finally {
      await daemon.stop();
    }
  }, 300_000);
});
