import { callout } from './kinds/callout.js';
import { choice } from './kinds/choice.js';
import { code } from './kinds/code.js';
import { compare } from './kinds/compare.js';
import { flow } from './kinds/flow.js';
import { html } from './kinds/html.js';
import { sequence } from './kinds/sequence.js';
import { story } from './kinds/story.js';
import { text } from './kinds/text.js';
import type { BlockKind } from './types.js';

export const BLOCKS: BlockKind<any, any>[] = [callout, story, flow, sequence, code, compare, choice, text, html];
