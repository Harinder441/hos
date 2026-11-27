import type { Clock } from '../adapters/clock.js';
import type { DeskScreen, NotifierSource } from './types.js';

export const NOTIFY_EVERY_MS = 60_000;
export const NOTIFY_FIRST_MS = 5_000;

export class NotifierLoop {
  private stopped = false;
  private readonly cancels = new Map<NotifierSource, () => void>();

  constructor(
    private readonly notifiers: NotifierSource[],
    private readonly clock: Clock,
    private readonly screen: () => Promise<DeskScreen>,
    private readonly log: (line: string) => void = console.warn,
  ) {}

  start(): void {
    for (const notifier of this.notifiers) {
      let failing = false;
      const every = notifier.everyMs && notifier.everyMs >= 1_000 ? notifier.everyMs : NOTIFY_EVERY_MS;
      const tick = () => {
        if (this.stopped) return;
        void this.screen()
          .then((screen) => notifier.push(screen))
          .then(
            () => {
              failing = false;
            },
            (error: Error) => {
              if (!failing && !this.stopped) this.log(`notifier "${notifier.label}" failed, retrying every ${Math.round(every / 1000)} s: ${error.message}`);
              failing = true;
            },
          )
          .finally(() => {
            if (!this.stopped) this.cancels.set(notifier, this.clock.setTimeout(tick, every));
          });
      };
      this.cancels.set(notifier, this.clock.setTimeout(tick, NOTIFY_FIRST_MS));
    }
  }

  stop(): void {
    this.stopped = true;
    for (const cancel of this.cancels.values()) cancel();
    this.cancels.clear();
  }
}
