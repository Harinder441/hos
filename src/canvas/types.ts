import type { z } from 'zod';
import type { LayoutSpec } from '../diagram-layout.js';

export const SPEC_VERSION = 1;

export interface Block {
  id: string;
  kind: string;
  fold?: boolean;
  [field: string]: unknown;
}

export interface Spec {
  v: number;
  title: string;
  submit?: string;
  blocks: Block[];
}

export interface Feedback {
  ok: boolean;
  note: string;
  node?: string;
}

// Where the user is in a block: s = step, o = opened node, c = story card, l = code line.
export interface View {
  s?: number;
  o?: string;
  c?: number;
  l?: number;
}

export interface Draft {
  a: Record<string, unknown>;
  view: Record<string, View>;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GraphLayout {
  w: number;
  h: number;
  nodes: Record<string, Box>;
  edges: Array<{ from: string; to: string; points: Array<[number, number]>; label?: string; lx?: number; ly?: number }>;
}

export interface SequenceLayout {
  w: number;
  h: number;
  actors: Record<string, Box>;
  messages: Array<{ y: number; x1: number; x2: number }>;
}

export type BlockLayout = GraphLayout | SequenceLayout;

export interface Submission {
  version: number;
  at: number;
  answers: Record<string, unknown>;
}

export interface Canvas {
  topicId: string;
  ref: string;
  chatId: string;
  version: number;
  spec: Spec;
  layout: Record<string, BlockLayout>;
  draft: Draft;
  open: string[];
  fb: Record<string, Feedback>;
  submits: Submission[];
  state: 'open' | 'closed';
  createdAt: number;
  updatedAt: number;
}

export interface LineContext {
  fb?: Feedback;
}

// One block kind. Adding a kind = one module exporting this + one line in registry.ts (and one renderer + one line on the web side).
export interface BlockKind<B extends Block = Block, A = unknown> {
  kind: string;
  fields: z.ZodType<Omit<B, 'id' | 'kind' | 'fold'>>;
  answer?: z.ZodType<A>;
  check?: (block: B) => string | null;
  graph?: (block: B) => LayoutSpec;
  answered?: (block: B, answer: A | undefined) => boolean;
  correct?: (block: B, answer: A) => boolean | undefined;
  line?: (block: B, answer: A, context: LineContext) => string;
  view?: (block: B, view: View) => string | null;
  nodes?: (block: B) => string[];
}
