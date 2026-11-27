import { afterEach, expect, test } from 'vitest';
import { listBusTools } from '../src/fakes/bus-client.js';
import { cleanupAll, startTestDaemon, tempGitRepo } from './harness.js';

afterEach(cleanupAll);

// The tools a hos chat uses on almost every turn are marked anthropic/alwaysLoad so the agent SDK puts them in the
// turn-1 prompt instead of a ToolSearch call; the rarer tools stay deferred (H5).
const PRELOADED = ['history_append', 'progress_read', 'progress_update', 'update_card', 'wait', 'send', 'complete', 'handoff_ready'];

test('the everyday hos bus tools are marked always-load, and the rarer ones are not (H5)', async () => {
  const hos = await startTestDaemon({ brainDir: await tempGitRepo('main') });
  const { chatId } = await hos.client.startTopic({ text: 'preload check' });
  const endpoint = hos.agentRuntime.started.filter((spec) => spec.chatId === chatId).at(-1)?.bus;

  const tools = await listBusTools(endpoint);
  const byName = new Map(tools.map((t) => [t.name, t.alwaysLoad]));

  for (const name of PRELOADED) expect(byName.get(name), `${name} should be always-load`).toBe(true);
  // A sample of rarer tools stays deferred behind tool search.
  for (const name of ['spawn', 'lock', 'task_create', 'diagram_apply']) {
    expect(byName.get(name), `${name} should be deferred`).toBe(false);
  }
});
