import { z } from 'zod';
import type { Block, BlockKind } from '../types.js';
import { line } from './common.js';

export interface Compare extends Block {
  title?: string;
  columns: string[];
  rows: string[][];
  win?: number;
}

const cell = z.string().max(120);

export const compare: BlockKind<Compare> = {
  kind: 'compare',
  fields: z.strictObject({ title: line.optional(), columns: z.array(cell).min(2).max(6), rows: z.array(z.array(cell)).min(1).max(12), win: z.number().int().min(1).optional() }),
  check: (block) => {
    const bad = block.rows.findIndex((row) => row.length !== block.columns.length);
    if (bad >= 0) return `rows[${bad}]: ${block.rows[bad]!.length} cells for ${block.columns.length} columns`;
    return block.win !== undefined && block.win >= block.columns.length ? `win: column ${block.win} is past the last column (${block.columns.length - 1})` : null;
  },
};
