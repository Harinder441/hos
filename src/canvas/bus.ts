import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BusReplyFn } from '../bus-http.js';
import { owner, ownerStart } from '../owner.js';
import type { Canvases } from './canvases.js';

const loose = z.array(z.any());
const id = z.string().describe('e.g. C1');

export function registerCanvasTools(server: McpServer, canvases: Canvases, chatId: string, reply: BusReplyFn): void {
  server.registerTool(
    'canvas_create',
    {
      description:
        `Put a canvas in this chat: a lesson, diagram or quiz made of blocks (reference: the canvas skill). ${ownerStart()}'s answers arrive as your next message when they press its hos bar.`,
      inputSchema: {
        title: z.string(),
        blocks: loose.describe('{kind, id?, fold?, ...fields}'),
        submit: z.string().optional().describe('hos bar label'),
      },
    },
    ({ title, blocks, submit }) => reply('canvas_create', { title, blocks: blocks.length }, () => canvases.create(chatId, { title, blocks, ...(submit ? { submit } : {}) })),
  );
  server.registerTool(
    'canvas_update',
    {
      description: 'Change a canvas with ops (add, set, remove, feedback, reopen, title, submit); base = the version you last saw. It moves to the newest point in the chat.',
      inputSchema: { id, base: z.number(), ops: loose },
    },
    ({ id, base, ops }) => reply('canvas_update', { id, base, ops: ops.length }, () => canvases.update(chatId, { id, base, ops })),
  );
  server.registerTool(
    'canvas_read',
    { description: `A canvas as text: where ${owner()} is in each diagram, their unsent answers, the last submit.`, inputSchema: { id } },
    ({ id }) => reply('canvas_read', { id }, () => canvases.read(chatId, id)),
  );
}
