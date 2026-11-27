import { z } from 'zod';
import type { Block, BlockKind } from '../types.js';
import { prose } from './common.js';

export interface Callout extends Block {
  tone?: 'analogy' | 'key' | 'warn';
  text: string;
}

export const callout: BlockKind<Callout> = {
  kind: 'callout',
  fields: z.strictObject({ tone: z.enum(['analogy', 'key', 'warn']).optional(), text: prose }),
};
