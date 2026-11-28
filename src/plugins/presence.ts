import type { Clock } from '../adapters/clock.js';
import type { PresenceReading, PresenceSample } from './types.js';

export const PRESENCE_EVERY_MS = 15_000;
export const PRESENCE_PUSH_CAP = 40;
export const PRESENCE_KEEP_CAP = 240;
export const UNREAD: PresenceReading = { idle_s: null, locked: null, display_asleep: null, camera: null, mic: null };

export interface PresenceBatch {
  samples: PresenceSample[];
  last: number;
}

export class PresenceSampler {
  private samples: Array<{ seq: number; sample: PresenceSample }> = [];
  private seq = 0;
  private readonly sent = new Map<object, number>();
  private cancel: (() => void) | null = null;

  constructor(
    readonly host: string,
    private readonly read: () => Promise<PresenceReading>,
    private readonly clock: Clock,
  ) {}

  start(): void {
    if (this.cancel) return;
    const tick = () => {
      const t = new Date(this.clock.now()).toISOString();
      this.cancel = this.clock.setTimeout(tick, PRESENCE_EVERY_MS);
      void this.read()
        .catch(() => UNREAD)
        .then((reading) => {
          if (!this.cancel) return;
          this.samples.push({ seq: ++this.seq, sample: { t, ...reading } });
          if (this.samples.length > PRESENCE_KEEP_CAP) this.samples.splice(0, this.samples.length - PRESENCE_KEEP_CAP);
        });
    };
    tick();
  }

  stop(): void {
    this.cancel?.();
    this.cancel = null;
  }

  batch(reader: object): PresenceBatch | null {
    const after = this.sent.get(reader) ?? 0;
    const unsent = this.samples.filter((entry) => entry.seq > after).slice(0, PRESENCE_PUSH_CAP);
    if (!unsent.length) return null;
    return { samples: unsent.map((entry) => entry.sample), last: unsent[unsent.length - 1]!.seq };
  }

  ack(reader: object, batch: PresenceBatch): void {
    this.sent.set(reader, Math.max(batch.last, this.sent.get(reader) ?? 0));
  }
}
