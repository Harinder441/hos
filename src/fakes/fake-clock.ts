import type { Clock } from '../adapters/clock.js';

interface Timer {
  at: number;
  order: number;
  fn: () => void;
}

export class FakeClock implements Clock {
  private current: number;
  private timers: Timer[] = [];
  private order = 0;

  constructor(start = Date.parse('2026-01-01T00:00:00Z')) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  setTimeout(fn: () => void, ms: number): () => void {
    const timer = { at: this.current + Math.max(0, ms), order: this.order++, fn };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((t) => t !== timer);
    };
  }

  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    await settle();
    for (;;) {
      const next = this.timers
        .filter((t) => t.at <= target)
        .sort((a, b) => a.at - b.at || a.order - b.order)[0];
      if (!next) break;
      this.timers = this.timers.filter((t) => t !== next);
      this.current = next.at;
      next.fn();
      await settle();
    }
    this.current = target;
  }

  // Like a host waking from sleep: every timer due by then fires once, late, so periodic loops re-arm from the new time instead of replaying each tick.
  async jump(ms: number): Promise<void> {
    const target = this.current + ms;
    const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at || a.order - b.order);
    for (const timer of due) Object.assign(timer, { at: target, order: this.order++ });
    this.current = target;
    await this.advance(0);
  }
}

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
