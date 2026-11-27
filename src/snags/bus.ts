import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BusReplyFn } from '../bus-http.js';
import { owner, ownerStart, ownerSettings } from '../owner.js';
import { byLabel, type Snags } from './snags.js';
import { SNAG_KINDS, type Snag } from './types.js';

const LIST_TEXT_CHARS = 140;
const LIST_MAX = 50;
const SNAG_REF = z.string().min(1).max(20).describe('snag ref, e.g. S4');

export function registerSnagTools(server: McpServer, snags: Snags, chatId: string, reply: BusReplyFn): void {
  server.registerTool(
    'snags',
    {
      description:
        `${owner()}'s snags: bugs, slowness and questions they log while using hos, each with an S ref (S4). Lists open ones by default, newest first; call snag_read for one snag's full text and file paths.`,
      inputSchema: { state: z.enum(['open', 'resolved', 'all']).default('open') },
    },
    ({ state }) =>
      reply('snags', { state }, async () => {
        const list = await snags.list(state);
        if (!list.length) return { outcome: 'ok', text: `No ${state === 'all' ? '' : `${state} `}snags.` };
        const lines = list.slice(0, LIST_MAX).map(line);
        const more = list.length > LIST_MAX ? `\n…and ${list.length - LIST_MAX} older.` : '';
        return { outcome: 'ok', text: `${lines.join('\n')}${more}` };
      }),
  );
  server.registerTool(
    'snag_read',
    { description: "One snag's full text, state, who added and resolved it, linked topics and the absolute paths of its files (open screenshots with Read).", inputSchema: { snag: SNAG_REF } },
    ({ snag }) => reply('snag_read', { snag }, async () => ({ outcome: 'ok', text: detail(await snags.get(snag)) })),
  );
  server.registerTool(
    'snag_add',
    {
      description: `Log a snag for ${owner()}: a bug, slowness or question about hos you noticed. kind is question or fix (bugs and slowness are fixes), or context when a skill, profile or shared memory needs a line because you got stuck on something routine.`,
      inputSchema: { kind: z.enum(SNAG_KINDS), text: z.string().min(1).max(4000) },
    },
    ({ kind, text }) => reply('snag_add', { kind }, async () => ({ outcome: 'ok', text: `Added ${(await snags.add({ kind, text, chatId }, chatId)).ref}.` })),
  );
  server.registerTool(
    'snag_comment',
    {
      description:
        `Post a comment on a snag's thread for ${owner()}, e.g. a question you need them to decide. They reply on the snag's card or wherever the snag store lets them; snag_read shows the thread. Fails if the snag store is unreachable.`,
      inputSchema: { snag: SNAG_REF, text: z.string().min(1).max(4000) },
    },
    ({ snag, text }) => reply('snag_comment', { snag }, async () => ({ outcome: 'ok', text: `Commented on ${(await snags.comment(snag, text)).ref}.` })),
  );
  server.registerTool(
    'snag_resolve',
    {
      description:
        'Close a snag. Fixing it needs a note that names the commit that fixed it (a git sha); if there is no fix, pass state "wontfix" or "not-reproduced" with a one-line reason. Reopen with reopen: true.',
      inputSchema: {
        snag: SNAG_REF,
        note: z.string().max(500).optional().describe('one line; for a fix it must name the commit sha'),
        state: z.enum(['wontfix', 'not-reproduced']).optional().describe('close without a fix; omit when the note names the fixing commit'),
        reopen: z.boolean().default(false),
      },
    },
    ({ snag, note, state, reopen }) =>
      reply('snag_resolve', { snag, state, reopen }, async () => {
        if (reopen) {
          const done = await snags.reopen(snag);
          return { outcome: 'ok', text: `${done.ref} is ${done.state}.` };
        }
        if (!state && !(note && /\b[0-9a-f]{7,40}\b/i.test(note))) {
          return {
            outcome: 'refused',
            text: `Refused: to resolve ${snag} name the commit that fixed it in the note (a git sha), or pass state "wontfix" or "not-reproduced" with a reason.`,
          };
        }
        const done = await snags.resolve(snag, chatId, note, state ?? 'resolved');
        return { outcome: 'ok', text: `${done.ref} is ${done.state}.` };
      }),
  );
  server.registerTool(
    'snag_delete',
    { description: `Delete a snag and its files for good. Prefer snag_resolve unless ${owner()} asked for a delete or it is a duplicate.`, inputSchema: { snag: SNAG_REF } },
    ({ snag }) => reply('snag_delete', { snag }, async () => ({ outcome: 'ok', text: `Deleted ${(await snags.remove(snag)).deleted}.` })),
  );
}

function line(snag: Snag): string {
  const text = snag.text.replace(/\s+/g, ' ');
  const short = text.length > LIST_TEXT_CHARS ? `${text.slice(0, LIST_TEXT_CHARS)}…` : text;
  const files = snag.files.length ? ` [${snag.files.length} file${snag.files.length > 1 ? 's' : ''}]` : '';
  const thread = snag.lastCommentAuthor === 'claude' ? ` · waiting on ${owner()}` : snag.lastCommentAuthor === 'user' ? ` · ${ownerStart()} replied` : '';
  return `${snag.ref} · ${snag.kind} · ${snag.state} · ${when(snag.createdAt)} · ${short || '(no text)'}${files}${thread}`;
}

function detail(snag: Snag): string {
  return [
    `${snag.ref} · ${snag.kind} · ${snag.state}`,
    `Added by ${snag.from ?? byLabel(snag.createdBy)} on ${when(snag.createdAt)}.`,
    ...(snag.context ? [`Context when added (a hint, may be stale or unrelated; trust the snag text first): ${snag.context}`] : []),
    ...(snag.resolvedAt ? [`Resolved by ${byLabel(snag.resolvedBy!)} on ${when(snag.resolvedAt)}${snag.note ? `: ${snag.note}` : '.'}`] : []),
    ...(snag.links.length ? [`Worked on in: ${snag.links.map((l) => `topic ${l.topicId.slice(0, 8)} chat ${l.chatId.slice(0, 8)}`).join('; ')}`] : []),
    '',
    snag.text || '(no text)',
    ...(snag.comments.length ? ['', 'Comments:', ...snag.comments.map((c) => `${stamp(c.createdAt)} ${c.author}: ${c.body}`)] : []),
    ...(snag.files.length ? ['', 'Files:', ...snag.files.map((f) => `- ${f.path}`)] : []),
  ].join('\n');
}

function stamp(at: number): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: ownerSettings().timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
}

function when(at: number): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: ownerSettings().timezone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
}
