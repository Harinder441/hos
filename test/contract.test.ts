import { afterEach, expect, test } from 'vitest';
import { FakeClock } from '../src/fakes/fake-clock.js';
import { ScriptedAgentRuntime, type AgentScript } from '../src/fakes/scripted-agent-runtime.js';
import { CONTRACT_PROMPTS, eventGrammar, runContractScenario } from './contract.js';
import { cleanupAll, startTestDaemon, tempDir } from './harness.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

afterEach(cleanupAll);

const contractScript = (): AgentScript => {
  let file = 'hello.txt';
  return (input) => {
    if (input === CONTRACT_PROMPTS.recall) return [{ delta: 'hello.txt' }];
    file = /create a file at (\S+)/.exec(input)?.[1] ?? file;
    return [
      {
        tool: 'Write',
        input: { file_path: file, content: 'hi' },
        output: 'File created successfully',
        ask: true,
        writes: { path: file, content: 'hi' },
      },
      { delta: input.startsWith('Use the Write tool') ? 'DENIED' : 'Done.' },
    ];
  };
};

test('the scripted runtime plays the contract scenario that the live Claude test plays', async () => {
  const brainDir = await tempDir('hos-brain-');
  await writeFile(join(brainDir, 'CLAUDE.md'), '# brain\n');
  const agentRuntime = new ScriptedAgentRuntime(new FakeClock(), contractScript());

  const { events, chatId } = await runContractScenario((dataDir) => startTestDaemon({ agentRuntime, brainDir, ...(dataDir ? { dataDir } : {}) }), 5000);

  expect(eventGrammar(events, chatId)).toBe('CiurtavkdmxiurtavkdmxiCurdmxi');
});
