import { EFFORTS } from '../api/types.js';
import type { CalendarSource, CaptureSource, HarnessSource, NotifierSource, SnagSource, Source, SourceKinds, TasksSource } from './types.js';

export interface KindSpec {
  versions: number[];
  many: boolean;
  methods: string[];
  optional?: string[];
  check?(source: Record<string, unknown>): string | null;
}

const HARNESS_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const RUNTIME_METHODS = ['start', 'transcript', 'terminalCommand'];
const RUNTIME_OPTIONAL = ['loginCommand', 'signedIn', 'usage', 'title', 'dispose'];
const FEATURE_NAMES = ['takeover', 'browser', 'contextRefresh', 'usageLimits'];

export function harnessProblem(source: Record<string, unknown>): string | null {
  const label = String(source.label);
  if (typeof source.id !== 'string' || !HARNESS_ID.test(source.id)) return `harness "${label}" needs an id of lowercase letters, digits and dashes`;
  if (source.pool !== undefined && (typeof source.pool !== 'string' || !HARNESS_ID.test(source.pool))) return `harness ${source.id}: pool must be lowercase letters, digits and dashes`;
  if (source.slots !== undefined && !(Number.isInteger(source.slots) && (source.slots as number) >= 0)) return `harness ${source.id}: slots must be a whole number`;
  if (source.aliases !== undefined && !(Array.isArray(source.aliases) && source.aliases.every((a) => typeof a === 'string' && HARNESS_ID.test(a)))) return `harness ${source.id}: aliases must be a list of harness ids`;
  const features = source.features as Record<string, unknown> | undefined;
  if (features !== undefined && (typeof features !== 'object' || Object.entries(features).some(([k, v]) => !FEATURE_NAMES.includes(k) || typeof v !== 'boolean'))) {
    return `harness ${source.id}: features takes booleans for ${FEATURE_NAMES.join(', ')}`;
  }
  const badge = badgeProblem(source.badge);
  if (badge) return `harness ${source.id}: ${badge}`;
  const runtime = source.runtime as Record<string, unknown> | undefined;
  if (!runtime || typeof runtime !== 'object') return `harness ${source.id} has no runtime`;
  const missing = RUNTIME_METHODS.filter((name) => typeof runtime[name] !== 'function');
  const wrong = RUNTIME_OPTIONAL.filter((name) => runtime[name] !== undefined && typeof runtime[name] !== 'function');
  if (missing.length || wrong.length) return `harness ${source.id}: runtime ${[...missing.map((m) => `is missing ${m}()`), ...wrong.map((w) => `${w} is not a function`)].join(', ')}`;
  let models: unknown;
  try {
    models = (source.models as () => unknown)();
  } catch (error) {
    return `harness ${source.id}: models() threw ${(error as Error).message}`;
  }
  const m = models as { default?: unknown; effort?: unknown; list?: unknown } | null;
  const list = Array.isArray(m?.list) ? (m!.list as Array<{ id?: unknown; label?: unknown }>) : null;
  if (!list?.length || !list.every((c) => typeof c?.id === 'string' && typeof c.label === 'string')) return `harness ${source.id}: models() must return {default, effort, list: [{id, label}]}`;
  if (!list.some((c) => c.id === m!.default)) return `harness ${source.id}: models().default must be one of the ids in its list`;
  if (!EFFORTS.includes(m!.effort as never)) return `harness ${source.id}: models().effort must be one of ${EFFORTS.join(', ')}`;
  return null;
}

const BADGE_TEXT = /^\S{1,3}$/;
const BADGE_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function badgeProblem(badge: unknown): string | null {
  if (badge === undefined) return null;
  const b = badge as { text?: unknown; color?: unknown; aliases?: unknown } | null;
  const shape = 'badge takes {text: 1–3 characters, color: #rgb or #rrggbb, aliases: {old id: text}}';
  if (!b || typeof b !== 'object' || Object.keys(b).some((k) => !['text', 'color', 'aliases'].includes(k))) return shape;
  if (b.text !== undefined && !(typeof b.text === 'string' && BADGE_TEXT.test(b.text))) return shape;
  if (b.color !== undefined && !(typeof b.color === 'string' && BADGE_COLOR.test(b.color))) return shape;
  if (b.aliases !== undefined && !(b.aliases && typeof b.aliases === 'object' && Object.entries(b.aliases).every(([k, v]) => HARNESS_ID.test(k) && typeof v === 'string' && BADGE_TEXT.test(v)))) return shape;
  return null;
}

const KINDS = new Map<string, KindSpec>([
  ['tasks', { versions: [1], many: false, methods: ['today', 'done', 'addLinked', 'drop', 'setPriority'] }],
  ['capture', { versions: [1], many: false, methods: ['capture'] }],
  ['calendar', { versions: [1], many: false, methods: ['today'], optional: ['now'] }],
  ['snags', { versions: [1], many: false, methods: ['status', 'list', 'get', 'find', 'add', 'change', 'comment', 'localFile'] }],
  ['notifier', { versions: [1], many: true, methods: ['push'] }],
  ['harness', { versions: [1], many: true, methods: ['models'], check: harnessProblem }],
]);

export function defineKind(kind: string, spec: KindSpec): void {
  if (KINDS.has(kind)) throw new Error(`the source kind ${kind} is already defined`);
  KINDS.set(kind, spec);
}

export function kindNames(): string[] {
  return [...KINDS.keys()];
}

export function sourceProblem(source: unknown): string | null {
  if (!source || typeof source !== 'object') return 'provide() needs a source object';
  const { kind, version, label } = source as Record<string, unknown>;
  const spec = typeof kind === 'string' ? KINDS.get(kind) : undefined;
  if (!spec) return `hos knows no source kind ${String(kind)} (known: ${kindNames().join(', ')})`;
  if (typeof version !== 'number' || !spec.versions.includes(version)) return `${kind} source version ${String(version)} is not supported (this hos takes ${spec.versions.join(', ')})`;
  if (typeof label !== 'string' || !label.trim()) return `${kind} source needs a label`;
  const missing = [...spec.methods, ...(spec.optional ?? [])].filter((name) => {
    const member = (source as Record<string, unknown>)[name];
    return spec.methods.includes(name) ? typeof member !== 'function' : member !== undefined && typeof member !== 'function';
  });
  if (missing.length) return `${kind} source "${label}" is missing ${missing.join(', ')}`;
  return spec.check?.(source as Record<string, unknown>) ?? null;
}

export interface Provided {
  source: Source;
  plugin: string;
  builtIn: boolean;
}

export class Sources {
  private readonly provided: Provided[] = [];

  add(source: Source, plugin: string, builtIn: boolean): string | null {
    const spec = KINDS.get(source.kind)!;
    if (!spec.many && !builtIn) {
      const taken = this.provided.find((p) => p.source.kind === source.kind && !p.builtIn);
      if (taken) return `${source.kind} already comes from the plug-in ${taken.plugin}; the one from ${plugin} is not used`;
    }
    this.provided.push({ source, plugin, builtIn });
    return null;
  }

  all(): Provided[] {
    return [...this.provided];
  }

  one<K extends keyof SourceKinds>(kind: K): SourceKinds[K] | null {
    const candidates = this.provided.filter((p) => p.source.kind === kind);
    return ((candidates.find((p) => !p.builtIn) ?? candidates[0])?.source as SourceKinds[K] | undefined) ?? null;
  }

  many<K extends keyof SourceKinds>(kind: K): Array<SourceKinds[K]> {
    return this.provided.filter((p) => p.source.kind === kind).map((p) => p.source as SourceKinds[K]);
  }

  get tasks(): TasksSource | null {
    return this.one('tasks');
  }

  get capture(): CaptureSource | null {
    return this.one('capture');
  }

  get calendar(): CalendarSource | null {
    return this.one('calendar');
  }

  get snags(): SnagSource | null {
    return this.one('snags');
  }

  get notifiers(): NotifierSource[] {
    return this.many('notifier');
  }

  get harnesses(): Array<{ source: HarnessSource; plugin: string }> {
    return this.provided.filter((p) => p.source.kind === 'harness').map((p) => ({ source: p.source as HarnessSource, plugin: p.plugin }));
  }

  async close(): Promise<void> {
    for (const { source } of this.provided) {
      try {
        await source.close?.();
      } catch (error) {
        console.error(`closing the ${source.kind} source "${source.label}" failed: ${(error as Error).message}`);
      }
    }
  }
}
