import { z } from 'zod';
import type { Block, BlockKind } from '../types.js';
import { clip, nodeId, prose } from './common.js';

export interface Choice extends Block {
  prompt: string;
  options: string[];
  answer?: number;
  node?: string;
}

export const choice: BlockKind<Choice, number> = {
  kind: 'choice',
  fields: z.strictObject({ prompt: prose, options: z.array(z.string().trim().min(1).max(200)).min(2).max(8), answer: z.number().int().min(0).optional(), node: nodeId.optional() }),
  answer: z.number().int().min(0),
  check: (block) => (block.answer !== undefined && block.answer >= block.options.length ? `answer: ${block.answer} is past the ${block.options.length} options (0-based)` : null),
  answered: (_, answer) => answer !== undefined,
  correct: (block, answer) => (block.answer === undefined ? undefined : answer === block.answer),
  line: (block, answer) => {
    const picked = `→ ${clip(block.options[answer] ?? '(no such option)', 80)}`;
    if (block.answer === undefined) return picked;
    if (answer === block.answer) return `${picked} ✓`;
    return `${picked} ✗ key: ${clip(block.options[block.answer]!, 80)}${block.node ? ` · node ${block.node}` : ''}`;
  },
};
