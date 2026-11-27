import { describe, expect, test } from 'vitest';
import { ClaudeAgentRuntime } from '../src/adapters/claude-agent-runtime.js';

describe.skipIf(!process.env.HOS_LIVE_CLAUDE)('live contract: Claude provider windows (no message is sent)', () => {
  test('the Claude driver reads the 5-hour and weekly windows of the logged-in subscription', async () => {
    const windows = await new ClaudeAgentRuntime().usage();

    expect(windows?.fiveHour).toEqual({ pct: expect.any(Number), resetsAt: expect.any(Number) });
    expect(windows?.weekly).toEqual({ pct: expect.any(Number), resetsAt: expect.any(Number) });
    expect(windows!.fiveHour!.pct).toBeGreaterThanOrEqual(0);
    expect(windows!.fiveHour!.pct).toBeLessThanOrEqual(100);
  });
});
