import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { TailscaleTransport } from '../src/adapters/tailscale-transport.js';
import { ClaudeAgentRuntime } from '../src/adapters/claude-agent-runtime.js';
import { systemClock } from '../src/adapters/clock.js';
import { startDaemon } from '../src/daemon.js';
import { CapturedNotifier } from '../src/fakes/captured-notifier.js';
import { FakeTransportIdentity } from '../src/fakes/fake-transport-identity.js';
import { runContractScenario, type ContractDaemon } from './contract.js';
import { cleanupAll, signedInClient, tempDir } from './harness.js';

afterEach(cleanupAll);

const brainDir = process.env.HOS_LIVE_BRAIN ?? join(homedir(), 'hos-brain');
const globalFiles = [join(homedir(), '.claude', 'settings.json'), join(homedir(), '.claude', 'CLAUDE.md')];
const fingerprint = () => globalFiles.map((file) => createHash('sha256').update(readFileSync(file)).digest('hex'));

describe.skipIf(!process.env.HOS_LIVE_CLAUDE)('live contract: real Claude driver (spends subscription quota)', () => {
  test('the Claude driver emits the normalized events the scripted runtime plays, with the brain loaded', async () => {
    const before = fingerprint();
    const policyFile = join(await tempDir('hos-live-policy-'), 'policy.yaml');
    writeFileSync(policyFile, 'context:\n  backstop: 120000\n');
    const start = async (dataDir?: string): Promise<ContractDaemon> => {
      const dir = dataDir ?? (await tempDir('hos-live-'));
      const identity = new FakeTransportIdentity();
      const daemon = await startDaemon(
        { dataDir: dir, port: 0, brainDir, policyFile },
        {
          agentRuntime: new ClaudeAgentRuntime({ model: process.env.HOS_LIVE_MODEL ?? 'haiku' }),
          transport: new TailscaleTransport(identity),
          clock: systemClock,
          notifier: new CapturedNotifier(),
        },
      );
      return { client: (await signedInClient(daemon.url, identity, dir)).client, dataDir: dir, stop: () => daemon.stop() };
    };

    const { events, chatId } = await runContractScenario(start, 120_000);

    const loaded = events.find((e) => e.type === 'context.loaded' && e.chatId === chatId);
    expect(loaded).toMatchObject({
      memoryFiles: expect.arrayContaining([join(brainDir, 'CLAUDE.md')]),
      skills: expect.arrayContaining(['work-in', 'history']),
    });
    const usages = events.filter((e) => e.type === 'context.usage' && e.chatId === chatId);
    expect(usages).toHaveLength(3);
    for (const usage of usages) expect(usage).toMatchObject({ tokens: expect.any(Number), compactAt: 120_000 });
    expect(Math.min(...usages.map((usage) => (usage as { tokens: number }).tokens))).toBeGreaterThan(10_000);
    expect(fingerprint()).toEqual(before);
  }, 600_000);
});
