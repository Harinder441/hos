import { loadavg } from 'node:os';

// Polling-loop tests timed out under load because a fixed deadline does not account for a busy CI box or a machine
// running the full suite. Scale every poll deadline by the 1-minute load average (over the CPU count) so the same
// test is patient when the box is busy and still fast when it is idle (H8). One shared copy, not six per-file ones.
export function deadlineMs(base: number): number {
  const load = loadavg()[0] ?? 0;
  return Math.round(base * Math.min(Math.max(1, load), 8));
}

export interface UntilOptions {
  timeoutMs?: number;
  label?: string;
  stepMs?: number;
}

// Poll read() until done(value) is truthy, then return the value. The deadline scales with the machine's load.
// A read that throws counts as "not yet" (e.g. JSON.parse of a file the daemon is still writing, S112); the last
// error is rethrown at the deadline.
export async function until<T>(read: () => T | Promise<T>, done: (value: T) => unknown, options: UntilOptions = {}): Promise<T> {
  const deadline = Date.now() + deadlineMs(options.timeoutMs ?? 5000);
  const step = options.stepMs ?? 15;
  for (;;) {
    let value: T | undefined;
    let failure: unknown;
    try {
      value = await read();
      if (done(value)) return value;
    } catch (error) {
      failure = error;
    }
    if (Date.now() > deadline) {
      if (failure !== undefined) throw failure;
      throw new Error(`timed out${options.label ? ` waiting for ${options.label}` : ''}; last value ${JSON.stringify(value)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, step));
  }
}
