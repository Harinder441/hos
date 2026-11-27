import { z } from 'zod';
import { owner } from '../../owner.js';
import type { Block, BlockKind } from '../types.js';

export const MAX_PAGE_STATE = 16_384;

export interface Html extends Block {
  src: string;
  height?: number;
}

export const html: BlockKind<Html, Record<string, unknown>> = {
  kind: 'html',
  fields: z.strictObject({ src: z.string().trim().regex(/\.html?$/i, 'must be an .html file in the brain').max(300), height: z.number().int().min(120).max(1200).optional() }),
  answer: z.record(z.string(), z.unknown()).refine((state) => JSON.stringify(state).length <= MAX_PAGE_STATE, `page state is over ${MAX_PAGE_STATE / 1024} KB`),
  answered: (_, answer) => !!answer && Object.keys(answer).length > 0,
  line: (_, answer) => `reported by the page (its own script, not ${owner()}'s words): ${JSON.stringify(answer)}`,
};
