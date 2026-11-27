import { z } from 'zod';
import type { Block, BlockKind } from '../types.js';
import { line, nodeId } from './common.js';

export interface Code extends Block {
  title?: string;
  lang?: string;
  code: string;
  lines?: Record<string, { note: string; node?: string }>;
}

export const code: BlockKind<Code> = {
  kind: 'code',
  fields: z.strictObject({
    title: line.optional(),
    lang: z.string().max(20).optional(),
    code: z.string().min(1).max(4000),
    lines: z.record(z.string().regex(/^\d+$/, 'line numbers'), z.strictObject({ note: z.string().trim().min(1).max(300), node: nodeId.optional() })).optional(),
  }),
  check: (block) => {
    const count = block.code.split('\n').length;
    const past = Object.keys(block.lines ?? {}).find((n) => Number(n) < 1 || Number(n) > count);
    return past ? `lines.${past}: the code has ${count} lines` : null;
  },
  view: (block, view) => (view.l ? `${block.id} line ${view.l}` : null),
};
