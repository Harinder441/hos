import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { ClaudeAgentRuntime } from '../src/adapters/claude-agent-runtime.js';
import { systemClock } from '../src/adapters/clock.js';
import { TailscaleTransport } from '../src/adapters/tailscale-transport.js';
import { startDaemon } from '../src/daemon.js';
import { CapturedNotifier } from '../src/fakes/captured-notifier.js';
import { FakeTransportIdentity } from '../src/fakes/fake-transport-identity.js';
import { cleanupAll, cleanupLater, collect, git, signedInClient, tempDir, tempGitRepo } from './harness.js';

afterEach(cleanupAll);

const MARKERS = ['session-start.marker', 'prompt.marker', 'stop.marker'];

async function liveBrain(): Promise<string> {
  const brainDir = await tempGitRepo('main', await tempDir('hos-s13-'), 'my-brain');
  await writeFile(join(brainDir, 'CLAUDE.md'), '# S13 brain\n\n@identity/SOUL.md\n');
  await mkdir(join(brainDir, 'identity'), { recursive: true });
  await writeFile(join(brainDir, 'identity', 'SOUL.md'), 'The S13 soul file.\n');
  await mkdir(join(brainDir, '.claude', 'skills', 's13-skill'), { recursive: true });
  await writeFile(
    join(brainDir, '.claude', 'skills', 's13-skill', 'SKILL.md'),
    '---\nname: s13-skill\ndescription: a skill that only exists in the S13 brain\n---\nNothing to do.\n',
  );
  const hook = (name: string) => ({ hooks: [{ type: 'command', command: `[ "$HOS_CHAT" = 1 ] && touch "$CLAUDE_PROJECT_DIR/${name}"; exit 0` }] });
  await writeFile(
    join(brainDir, '.claude', 'settings.json'),
    JSON.stringify({
      hooks: { SessionStart: [hook('session-start.marker')], UserPromptSubmit: [hook('prompt.marker')], Stop: [hook('stop.marker')] },
    }),
  );
  git(brainDir, 'add', '.');
  git(brainDir, 'commit', '-q', '-m', 'brain');
  return brainDir;
}

describe.skipIf(!process.env.HOS_LIVE_CLAUDE)('live S13: the brain as cwd, and attaching a workspace to a running chat', () => {
  test('the brain loads from cwd and runs its own hooks with HOS_CHAT=1, and an attached workspace reaches the next turn', async () => {
    const brainDir = await liveBrain();
    const dataDir = await tempDir('hos-s13-data-');
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
    cleanupLater(() => daemon.stop());
    const { client } = await signedInClient(daemon.url, identity, dataDir);
    const stream = collect(client);

    const { topicId, chatId } = await client.startTopic({ text: 'Reply with the single word READY and stop.' });
    await stream.until((es) => es.some((e) => e.type === 'message.completed' && e.chatId === chatId), 180_000);

    expect(stream.events.find((e) => e.type === 'context.loaded' && e.chatId === chatId)).toMatchObject({
      memoryFiles: expect.arrayContaining([join(brainDir, 'CLAUDE.md'), join(brainDir, 'identity', 'SOUL.md')]),
      skills: expect.arrayContaining(['s13-skill']),
    });

    const repo = await tempGitRepo('main', await tempDir('hos-s13-repo-'), 'web-backend');
    const project = await client.createProject(repo);
    const workspace = await client.createWorkspace({ projectId: project.id, kind: 'root' });
    await client.attachWorkspace(topicId, workspace.id);

    await client.sendMessage(chatId, 'List the absolute paths of every folder you may work in, one per line, and stop.');
    await stream.until((es) => es.filter((e) => e.type === 'message.completed' && e.chatId === chatId).length === 2, 180_000);

    const replies = stream.events.filter((e) => e.type === 'message.completed' && e.chatId === chatId).map((e) => (e as { text: string }).text);
    expect(replies.at(-1)).toContain(repo);
    for (const marker of MARKERS) expect(existsSync(join(brainDir, marker))).toBe(true);
  }, 600_000);
});
