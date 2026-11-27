import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { extname, join } from 'node:path';
import { ATTACHMENT_MAX_BYTES, safeName } from '../attachments.js';
import { HosError, type Hos } from '../core.js';
import type { SnagChange, SnagFiles, SnagRecord, SnagSource } from '../plugins/types.js';
import { refLabel } from './files.js';
import { owner } from '../owner.js';
import { SNAG_KINDS, type CommentAuthor, type NewSnag, type ResolvedState, type Snag, type SnagFilter, type SnagLink, type SnagSummary } from './types.js';

const TEXT_MAX = 20_000;
const FILES_MAX = 10;
// A note "carries a commit ref" when it names a git sha (7-40 hex) — enough to trace the fix (H9).
export const COMMIT_REF = /\b[0-9a-f]{7,40}\b/i;
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export class Snags {
  constructor(
    private readonly store: SnagSource,
    private readonly files: SnagFiles,
    private readonly brainDir: string | undefined,
    private readonly hos: Hos,
    private readonly log: (line: string) => void = console.error,
  ) {}

  get label(): string {
    return this.store.label;
  }

  async list(filter: SnagFilter = 'all'): Promise<Snag[]> {
    // "resolved" covers every closed state (resolved, wontfix, not-reproduced), so the filter is open vs not-open (H9).
    const all = (await this.store.list()).map((row) => this.toSnag(row));
    return filter === 'all' ? all : all.filter((snag) => (filter === 'open') === (snag.state === 'open'));
  }

  async summary(): Promise<SnagSummary> {
    const all = await this.store.list();
    const open = all.filter((row) => row.state === 'open');
    return { open: open.length, openContext: open.filter((row) => row.kind === 'context').length, total: all.length, label: this.store.label, ...this.store.status() };
  }

  async get(ref: string): Promise<Snag> {
    const row = await this.store.get(snagId(ref));
    for (const file of this.brainDir ? row.files : []) {
      await this.store.localFile(row, file.name).catch(() => {});
    }
    return this.toSnag(row);
  }

  async add(input: NewSnag, by: string): Promise<Snag> {
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    const files = Array.isArray(input.files) ? input.files : [];
    if ((input.kind as string) === 'task') input = { ...input, kind: 'fix' };
    if (!SNAG_KINDS.includes(input.kind)) throw new HosError(400, `kind must be one of ${SNAG_KINDS.join(', ')}`);
    if (!text && !files.length) throw new HosError(400, 'a snag needs text or a file');
    if (text.length > TEXT_MAX) throw new HosError(400, `a snag's text is at most ${TEXT_MAX} characters`);
    if (files.length > FILES_MAX) throw new HosError(400, `a snag holds at most ${FILES_MAX} files`);
    const decoded = files.map((file) => ({ name: safeName(String(file?.name ?? '')), bytes: decode(file?.data) }));
    if (decoded.reduce((sum, file) => sum + file.bytes.length, 0) > ATTACHMENT_MAX_BYTES) throw new HosError(413, 'snag files are at most 25 MB in total');
    const taken = new Set<string>();
    for (const file of decoded) {
      let unique = file.name;
      for (let n = 1; taken.has(unique); n++) unique = `${n}-${file.name}`;
      taken.add(unique);
      file.name = unique;
    }
    const chatId = typeof input.chatId === 'string' && input.chatId ? input.chatId : undefined;
    const topicId = typeof input.topicId === 'string' && input.topicId ? input.topicId : chatId && this.hos.chatTopic(chatId).id;
    const context = topicId ? this.hos.snagContext(topicId, chatId) : null;
    const row = await this.store.add({ kind: input.kind, text, created_by: by, source_host: sourceHost(), context }, decoded);
    return this.toSnag(row);
  }

  async resolve(ref: string, by: string, note?: string, state: ResolvedState = 'resolved'): Promise<Snag> {
    return this.change(ref, { type: 'resolve', state, note: note?.trim() || null, by });
  }

  // Resolve with the H9 rule: a fix must name the commit (a git sha) in the note, else close as wontfix or
  // not-reproduced. Shared by the bus tool and the local-ops land route. Throws HosError on a bare resolve.
  async resolveChecked(ref: string, by: string, note: string | undefined, state: ResolvedState | undefined): Promise<Snag> {
    if (!state && !(note && COMMIT_REF.test(note))) {
      throw new HosError(400, `to resolve ${ref} name the commit that fixed it in the note (a git sha), or pass state "wontfix" or "not-reproduced"`);
    }
    return this.resolve(ref, by, note, state ?? 'resolved');
  }

  async comment(ref: string, text: string, author: CommentAuthor = 'claude'): Promise<Snag> {
    const body = typeof text === 'string' ? text.trim() : '';
    if (!body) throw new HosError(400, 'a comment needs text');
    return this.toSnag(await this.store.comment(snagId(ref), body, author));
  }

  async edit(ref: string, text: string): Promise<Snag> {
    const trimmed = typeof text === 'string' ? text.trim() : '';
    if (!trimmed) throw new HosError(400, 'a snag needs text');
    if (trimmed.length > TEXT_MAX) throw new HosError(400, `a snag's text is at most ${TEXT_MAX} characters`);
    return this.change(ref, { type: 'update', text: trimmed });
  }

  async reopen(ref: string): Promise<Snag> {
    return this.change(ref, { type: 'reopen' });
  }

  async remove(ref: string): Promise<{ deleted: string }> {
    const id = snagId(ref);
    const snag = this.toSnag(await this.store.find(id));
    await this.store.change(id, { type: 'delete' });
    return { deleted: snag.ref };
  }

  async startTopic(ref: string): Promise<SnagLink> {
    const snag = await this.get(ref);
    const started = await this.hos.startTopic({ text: prompt(snag) });
    const title = snag.text.split('\n').find((line) => line.trim())?.trim().slice(0, 200) || `Snag ${snag.ref}`;
    this.hos.addTask(started.topicId, { title, criteria: [`${snag.ref} fixed and resolved with the landing commit`], fromSnag: snag.ref });
    return this.link(snag, started.topicId, started.chatId);
  }

  async chatInTopic(ref: string, topicId: string): Promise<SnagLink> {
    const snag = await this.get(ref);
    const chat = await this.hos.addTopicChat(topicId);
    await this.hos.sendMessage(chat.id, prompt(snag));
    return this.link(snag, topicId, chat.id);
  }

  async file(ref: string, name: string): Promise<{ type: string; data: Buffer }> {
    const row = await this.store.find(snagId(ref));
    if (!row.files.some((f) => f.name === name)) throw new HosError(404, `snag ${ref} has no file ${name}`);
    const path = await this.store.localFile(row, name);
    const data = await readFile(path).catch((error: NodeJS.ErrnoException) => {
      throw error.code === 'ENOENT' ? new HosError(404, `snag ${ref} has no file ${name}`) : error;
    });
    return { type: IMAGE_TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream', data };
  }

  private async change(ref: string, change: SnagChange): Promise<Snag> {
    return this.toSnag((await this.store.change(snagId(ref), change))!);
  }

  private async link(snag: Snag, topicId: string, chatId: string): Promise<SnagLink> {
    const row = await this.store.change(snag.id, { type: 'link', topicId, chatId });
    return { topicId, chatId, at: Date.parse(row!.links.at(-1)!.at) };
  }

  reached(n: number, row: SnagRecord): void {
    this.log(`snags: queued snag S?${n} reached ${this.store.label} as S${row.ref}`);
    if (row.created_by !== 'you' && !this.store.authors?.[row.created_by]) {
      this.hos.noteChat(row.created_by, `Your snag S?${n} reached ${this.store.label} as S${row.ref}; use S${row.ref} from now on.`);
    }
  }

  private toSnag(row: SnagRecord): Snag {
    const brain = this.brainDir;
    return {
      id: row.ref,
      ref: refLabel(row.ref),
      kind: (row.kind as string) === 'task' ? 'fix' : row.kind,
      text: row.text,
      files: row.files.map((f) => ({ name: f.name, path: brain ? join(this.files.dir(row.ref), f.name) : (f.path ?? '') })),
      state: row.state,
      createdAt: Date.parse(row.created_at),
      createdBy: row.created_by,
      from: this.store.authors?.[row.created_by] ?? null,
      resolvedAt: row.resolved_at ? Date.parse(row.resolved_at) : null,
      resolvedBy: row.resolved_by,
      note: row.note,
      links: row.links.map((l) => ({ topicId: l.topicId, chatId: l.chatId, at: Date.parse(l.at) })),
      context: row.context,
      comments: (row.comments ?? []).map((c) => ({ id: c.id, author: c.author, body: c.body, createdAt: Date.parse(c.created_at) })),
      lastCommentAuthor: row.last_comment_author ?? row.comments?.at(-1)?.author ?? null,
    };
  }
}

export function snagId(ref: string): number {
  const match = /^\s*S?(\?)?(\d{1,9})\s*$/i.exec(String(ref));
  if (!match) throw new HosError(400, `${ref} is not a snag ref; use S4 or 4`);
  return match[1] ? -Number(match[2]) : Number(match[2]);
}

export function byLabel(by: string): string {
  return by === 'you' ? owner() : `chat ${by.slice(0, 8)}`;
}

function sourceHost(): string {
  return process.platform === 'darwin' ? 'mac' : hostname();
}

function decode(data: unknown): Buffer {
  if (typeof data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new HosError(400, 'file data must be base64');
  if (Math.floor((data.length * 3) / 4) > ATTACHMENT_MAX_BYTES + 2) throw new HosError(413, 'snag files are at most 25 MB in total');
  return Buffer.from(data, 'base64');
}

function prompt(snag: Snag): string {
  return [
    snag.text || '(no text, see the files)',
    '',
    `Snag ${snag.ref} · ${snag.kind} · added by ${snag.from ?? byLabel(snag.createdBy)}.`,
    ...(snag.files.length ? ['Files (open them with Read):', ...snag.files.map((f) => `- ${f.path}`)] : []),
    `When it is done, call snag_resolve with ${snag.ref} and a one-line note.`,
  ].join('\n');
}
