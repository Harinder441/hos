import type { SecretReader } from '../adapters/script-secrets.js';

export class FakeSecretReader implements SecretReader {
  readonly asked: string[] = [];

  constructor(readonly values: Record<string, string> = {}) {}

  async read(name: string): Promise<string | null> {
    this.asked.push(name);
    return this.values[name] ?? null;
  }
}
