import { z } from 'zod';
import type { Block, BlockKind } from '../types.js';
import { prose } from './common.js';

export interface Text extends Block {
  prompt: string;
}

export const text: BlockKind<Text, string> = {
  kind: 'text',
  fields: z.strictObject({ prompt: prose }),
  answer: z.string().max(2000),
  answered: (_, answer) => !!answer?.trim(),
  line: (_, answer) => `→ "${answer.trim().replace(/\s*\n\s*/g, ' / ')}"`,
};
