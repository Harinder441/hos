import { z } from 'zod';
import type { Block, BlockKind } from '../types.js';
import { line, prose } from './common.js';

export const ART = ['phone', 'browser', 'server', 'db', 'store', 'card', 'money', 'cloud', 'person', 'lock', 'clock', 'queue', 'warning', 'check'] as const;
// "phone>server" draws an arrow between two pictures, "phone<~server" a lost (red, dashed) reply.
export const ART_LINK = /^([a-z]+)(?:(>|<|~>|<~)([a-z]+))?$/;

export interface Story extends Block {
  cards: Array<{ art: string; title: string; text?: string }>;
}

export const story: BlockKind<Story> = {
  kind: 'story',
  fields: z.strictObject({
    cards: z.array(z.strictObject({ art: z.string().trim(), title: line, text: prose.optional() })).min(1).max(6),
  }),
  check: (block) => {
    for (const [i, card] of block.cards.entries()) {
      const m = ART_LINK.exec(card.art);
      const names = m ? [m[1], m[3]].filter(Boolean) : [card.art];
      const bad = names.find((name) => !(ART as readonly string[]).includes(name!));
      if (!m || bad) return `cards[${i}].art: "${card.art}" is not a picture; use ${ART.join(', ')}, or two joined by > < ~> <~`;
    }
    return null;
  },
  view: (block, view) => (view.c ? `${block.id} card ${view.c + 1}/${block.cards.length}` : null),
};
