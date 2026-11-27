interface Warm {
  close(): void;
  readonly alive: boolean;
}

interface Held<T> {
  key: string;
  ready: Promise<T>;
  timer: NodeJS.Timeout;
}

export class SpareSlot<T extends Warm> {
  private held: Held<T> | null = null;

  constructor(
    private readonly ttlMs: number,
    private readonly make: (cwd: string, env: Record<string, string>) => Promise<T>,
  ) {}

  refill(cwd: string, env: Record<string, string>): void {
    const key = keyOf(cwd, env);
    if (this.held?.key === key) return;
    this.discard();
    const ready = this.make(cwd, env);
    const held: Held<T> = { key, ready, timer: setTimeout(() => this.expire(held), this.ttlMs) };
    held.timer.unref();
    ready.catch(() => this.expire(held));
    this.held = held;
  }

  async take(cwd: string, env: Record<string, string>): Promise<T | undefined> {
    const held = this.held;
    if (!held || held.key !== keyOf(cwd, env)) return undefined;
    this.held = null;
    clearTimeout(held.timer);
    const spare = await held.ready.catch(() => undefined);
    if (spare?.alive) return spare;
    spare?.close();
    return undefined;
  }

  dispose(): void {
    this.discard();
  }

  private expire(held: Held<T>): void {
    if (this.held === held) this.discard();
  }

  private discard(): void {
    const held = this.held;
    this.held = null;
    if (!held) return;
    clearTimeout(held.timer);
    void held.ready.then((spare) => spare.close(), () => undefined);
  }
}

// The spare is spawned with the env and cwd of the chat that came before it, so it only fits a chat with the same pair.
function keyOf(cwd: string, env: Record<string, string>): string {
  return JSON.stringify([cwd, Object.entries(env).sort(([a], [b]) => a.localeCompare(b))]);
}
