import type { AgentRuntime } from '../adapters/agent-runtime.js';
import type { HarnessFeatures, HarnessMark, ModelsConfig } from '../api/types.js';

export type { HarnessFeatures, HarnessMark } from '../api/types.js';

export const ALL_FEATURES: HarnessFeatures = { takeover: true, browser: true, contextRefresh: true, usageLimits: true };
export const NO_FEATURES: HarnessFeatures = { takeover: false, browser: false, contextRefresh: false, usageLimits: false };

export interface Harness {
  id: string;
  label: string;
  pool: string;
  runtime: AgentRuntime;
  models(): ModelsConfig;
  slots: number;
  features: HarnessFeatures;
  aliases?: string[];
  badge?: HarnessMark;
}

export class Harnesses {
  private readonly byId = new Map<string, Harness>();
  private readonly byAlias = new Map<string, Harness>();

  constructor(
    readonly primary: Harness,
    extras: Harness[] = [],
  ) {
    for (const harness of [primary, ...extras]) {
      if (this.byId.has(harness.id)) throw new Error(`two harnesses share the id ${harness.id}`);
      this.byId.set(harness.id, harness);
    }
    for (const harness of extras) for (const alias of harness.aliases ?? []) if (!this.byId.has(alias)) this.byAlias.set(alias, harness);
  }

  all(): Harness[] {
    return [...this.byId.values()];
  }

  get(id: string): Harness | undefined {
    return this.byId.get(id) ?? this.byAlias.get(id);
  }

  taken(id: string): boolean {
    return this.byId.has(id) || this.byAlias.has(id);
  }
}
