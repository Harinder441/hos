import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { TailscaleTransport } from '../src/adapters/tailscale-transport.js';
import { ClaudeAgentRuntime } from '../src/adapters/claude-agent-runtime.js';
import { systemClock } from '../src/adapters/clock.js';
import { startDaemon } from '../src/daemon.js';
import { CapturedNotifier } from '../src/fakes/captured-notifier.js';
import { FakeTransportIdentity } from '../src/fakes/fake-transport-identity.js';
import { cleanupAll, collect, signedInClient, screen, tempDir, tempGitRepo } from './harness.js';
import { newTopic } from './topics.js';

afterEach(cleanupAll);

const brainDir = process.env.HOS_LIVE_BRAIN ?? join(homedir(), 'hos-brain');

describe.skipIf(!process.env.HOS_LIVE_CLAUDE)('live contract: take over a real Claude chat (spends subscription quota)', () => {
  test('the claude CLI opens the chat’s native session in tmux, and hos keeps the history after hand back', async () => {
    const dataDir = await tempDir('hos-live-');
    const tmuxSocket = join(dataDir, 'tmux.sock');
    const identity = new FakeTransportIdentity();
    const daemon = await startDaemon(
      { dataDir, port: 0, brainDir, tmuxSocket },
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
      const workspace = await newTopic(client, project.id, 'live takeover');
      const chat = await client.createChat(workspace.id);
      const stream = collect(client);
      await client.sendMessage(chat.id, 'Reply with exactly the word PINEAPPLE and nothing else.');
      await stream.until((es) => es.some((e) => e.type === 'message.completed') && es.findLast((e) => e.type !== 'workspace.git')?.type === 'chat.state', 120_000);

      const { terminal } = await client.takeOver(chat.id);
      const term = screen(client, terminal);
      await term.until(/PINEAPPLE|trust|Welcome to Claude Code/i, 30_000);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      expect(await client.listTerminals()).toEqual([expect.objectContaining({ name: terminal, chatId: chat.id })]);
      expect(term.text()).not.toMatch(/unknown option|error:/i);

      await client.handBack(chat.id);
      expect(await client.getTranscript(chat.id)).toContainEqual({ kind: 'assistant', text: expect.stringContaining('PINEAPPLE') });
    } finally {
      await daemon.stop();
      try {
        execFileSync('tmux', ['-S', tmuxSocket, 'kill-server'], { stdio: 'ignore' });
      } catch {}
    }
  }, 300_000);
});
