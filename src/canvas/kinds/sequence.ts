import { z } from 'zod';
import type { LayoutSpec } from '../../diagram-layout.js';
import type { Block, BlockKind } from '../types.js';
import { line, nodeId, prose } from './common.js';

export interface Sequence extends Block {
  title?: string;
  actors: Array<{ id: string; label: string }>;
  messages: Array<{ from: string; to: string; label?: string; lost?: boolean; reply?: boolean; say?: string }>;
}

export const sequence: BlockKind<Sequence> = {
  kind: 'sequence',
  fields: z.strictObject({
    title: line.optional(),
    actors: z.array(z.strictObject({ id: nodeId, label: z.string().trim().min(1).max(40) })).min(1).max(6),
    messages: z
      .array(z.strictObject({ from: nodeId, to: nodeId, label: z.string().max(60).optional(), lost: z.boolean().optional(), reply: z.boolean().optional(), say: prose.optional() }))
      .min(1)
      .max(24),
  }),
  check: (block) => {
    const ids = new Set(block.actors.map((actor) => actor.id));
    if (ids.size !== block.actors.length) return 'actors: ids must be unique';
    for (const [i, m] of block.messages.entries()) for (const end of [m.from, m.to]) if (!ids.has(end)) return `messages[${i}]: no actor "${end}"`;
    return null;
  },
  graph: (block): LayoutSpec => ({
    kind: 'sequence',
    actors: block.actors,
    messages: block.messages.map((m) => ({ from: m.from, to: m.to, ...(m.label ? { label: m.label } : {}), ...(m.reply || m.lost ? { reply: true } : {}) })),
  }),
  view: (block, view) => (view.s ? `${block.id} ${view.s + 1}/${block.messages.length}` : null),
};
