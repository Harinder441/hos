import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import type { AgentEvent, AgentSink } from '../src/adapters/agent-runtime.js';
import { ClaudeAgentRuntime } from '../src/adapters/claude-agent-runtime.js';
import { cleanupAll, tempDir } from './harness.js';

afterEach(cleanupAll);

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/bin/fake-claude.mjs', import.meta.url));
const BUS_TOKEN = 'bus-token-for-the-argv-test';
const MCP_KEY = 'mcp-key-for-the-argv-test';

const sink: AgentSink = {
  event: () => {},
  permission: async () => 'allow',
  beforeTurn: () => undefined,
  needsDecision: () => false,
  beforeTool: async () => undefined,
  refuse: () => undefined,
  beforeStop: () => undefined,
  beforeCompact: () => undefined,
} as unknown as AgentSink;

test('a Claude chat gets the bus token and mcp_servers keys over the SDK control channel, never on the claude command line', async () => {
  const dir = await tempDir('hos-claude-argv-');
  const log = join(dir, 'claude.log');
  const runtime = new ClaudeAgentRuntime({ executable: FAKE_CLAUDE });

  const session = await runtime.start(
    {
      chatId: 'c1',
      cwd: dir,
      extraDirs: [],
      env: { FAKE_CLAUDE_LOG: log },
      compactAt: 100_000,
      bus: { url: 'http://127.0.0.1:9/mcp', token: BUS_TOKEN },
      mcpServers: [{ name: 'scratch', url: 'https://mcp.example/mcp', headers: { Authorization: `Bearer ${MCP_KEY}` } }],
    },
    sink,
  );
  await session.stop();

  const entries = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { argv?: string[]; request?: { subtype: string; servers?: unknown } });
  const argv = entries.find((entry) => entry.argv)!.argv!.join(' ');
  expect(argv).not.toContain(BUS_TOKEN);
  expect(argv).not.toContain(MCP_KEY);
  expect(argv).not.toContain('--mcp-config');
  expect(entries.find((entry) => entry.request?.subtype === 'mcp_set_servers')?.request?.servers).toEqual({
    scratch: { type: 'http', url: 'https://mcp.example/mcp', headers: { Authorization: `Bearer ${MCP_KEY}` } },
    hos: { type: 'http', url: 'http://127.0.0.1:9/mcp', headers: { authorization: `Bearer ${BUS_TOKEN}` } },
  });
});

test('a Claude chat whose hos bus did not connect still starts and says so in a warning event', async () => {
  const dir = await tempDir('hos-claude-bus-');
  const events: AgentEvent[] = [];
  const runtime = new ClaudeAgentRuntime({ executable: FAKE_CLAUDE });

  const session = await runtime.start(
    {
      chatId: 'c1',
      cwd: dir,
      extraDirs: [],
      env: { FAKE_CLAUDE_LOG: join(dir, 'claude.log'), FAKE_CLAUDE_MCP_STATUS: 'failed' },
      compactAt: 100_000,
      bus: { url: 'http://127.0.0.1:9/mcp', token: BUS_TOKEN },
    },
    { ...sink, event: (event) => events.push(event) },
  );
  await session.stop();

  expect(events.filter((event) => event.type === 'warning')).toEqual([
    { type: 'warning', message: 'The hos bus did not connect within 10 s, so this chat has no hos tools; restart the chat to retry.' },
  ]);
  expect(events.some((event) => event.type === 'context.loaded')).toBe(true);
});
