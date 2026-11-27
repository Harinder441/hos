import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, sep } from 'node:path';
import { z } from 'zod';
import type { Clock } from '../adapters/clock.js';
import type { BusReply, Recorder } from '../bus.js';
import { HosError } from '../core.js';
import { owner, ownerStart } from '../owner.js';
import type { Profile } from '../profiles.js';
import type { Store } from '../store.js';
import { clip } from './kinds/common.js';
import { layoutSpec } from './layout.js';
import { LIMITS, SpecError, answerable, applyOps, emptyDraft, parseSpec, pendingAnswers, readText, submitText, upgrade } from './spec.js';
import type { Canvas, Draft, Spec } from './types.js';

export const CANVAS_SKILL = 'canvas';

export function canvasOn(profile: Pick<Profile, 'skills'>): boolean {
  return profile.skills === 'all' || profile.skills.includes(CANVAS_SKILL);
}

export function canvasLine(store: Store, topicId: string): string | null {
  const open = store.canvases(topicId).filter((c) => c.state === 'open').slice(-6);
  if (!open.length) return null;
  return `Canvases here (canvas_read <id> for ${owner()}'s place and answers): ${open.map((c) => `${c.ref} "${clip(c.spec.title, 60)}"`).join(', ')}`;
}

const DRAFT = z.strictObject({
  a: z.record(z.string().max(32), z.unknown()),
  view: z.record(z.string().max(32), z.strictObject({ s: z.number().int().min(0).optional(), o: z.string().max(40).optional(), c: z.number().int().min(0).optional(), l: z.number().int().min(1).optional() })),
});

export type Deliver = (chatId: string, text: string, ref: string) => Promise<void>;

export class Canvases {
  constructor(
    private readonly store: Store,
    private readonly record: Recorder,
    private readonly clock: Clock,
    private readonly deliver: Deliver,
    private readonly brainDir: () => string | undefined = () => undefined,
  ) {}

  private async pagePath(src: string): Promise<string | null> {
    const brain = this.brainDir();
    if (!brain) return null;
    const root = await realpath(brain).catch(() => null);
    const file = root && (await realpath(isAbsolute(src) ? src : join(root, src)).catch(() => null));
    if (!root || !file || !file.startsWith(root + sep)) return null;
    return (await stat(file)).isFile() ? file : null;
  }

  private async missingPage(spec: Spec): Promise<string | null> {
    for (const block of spec.blocks) {
      if (block.kind !== 'html') continue;
      if (!(await this.pagePath(String(block.src)))) return `${block.id} (html).src: no such .html file in the brain: ${String(block.src)}`;
    }
    return null;
  }

  async htmlFile(topicId: string, ref: string, blockId: string): Promise<string> {
    const block = this.card(topicId, ref).spec.blocks.find((b) => b.id === blockId && b.kind === 'html');
    if (!block) throw new HosError(404, `no html block ${blockId} in ${ref}`);
    const file = await this.pagePath(String(block.src));
    if (!file) throw new HosError(404, `${blockId}: ${String(block.src)} is gone from the brain`);
    return file;
  }

  private find(topicId: string, id: string): Canvas | undefined {
    const canvas = this.store.canvas(topicId, id.trim().toUpperCase());
    return canvas && { ...canvas, spec: upgrade(canvas.spec) };
  }

  private refused(text: string): BusReply {
    return { outcome: 'refused', text: `Refused: ${text}` };
  }

  async create(chatId: string, input: { title: string; blocks: unknown[]; submit?: string }): Promise<BusReply> {
    const chat = this.store.getChat(chatId)!;
    let spec;
    try {
      spec = parseSpec(input);
    } catch (error) {
      if (error instanceof SpecError) return this.refused(error.message);
      throw error;
    }
    const missing = await this.missingPage(spec);
    if (missing) return this.refused(missing);
    const now = this.clock.now();
    const canvas: Canvas = {
      topicId: chat.topicId,
      ref: `C${this.store.nextCanvasNumber(chat.topicId)}`,
      chatId,
      version: 1,
      spec,
      layout: await layoutSpec(spec),
      draft: emptyDraft(),
      open: spec.blocks.filter(answerable).map((b) => b.id),
      fb: {},
      submits: [],
      state: 'open',
      createdAt: now,
      updatedAt: now,
    };
    const open = this.store.canvases(chat.topicId).filter((c) => c.state === 'open');
    for (const old of open.slice(0, Math.max(0, open.length - LIMITS.open + 1))) this.save('canvas.updated', { ...old, state: 'closed' });
    this.save('canvas.created', canvas);
    return { outcome: 'ok', text: `${canvas.ref} v1` };
  }

  async update(chatId: string, input: { id: string; base: number; ops: unknown[] }): Promise<BusReply> {
    const chat = this.store.getChat(chatId)!;
    const canvas = this.find(chat.topicId, input.id);
    if (!canvas) return this.refused(`no canvas ${input.id} in this topic`);
    if (input.base !== canvas.version) return this.refused(`${canvas.ref} is v${canvas.version}, not v${input.base}. Current state:\n${readText(canvas)}`);
    let applied;
    try {
      applied = applyOps(canvas, input.ops);
    } catch (error) {
      if (error instanceof SpecError) return this.refused(error.message);
      throw error;
    }
    const missing = await this.missingPage(applied.spec);
    if (missing) return this.refused(missing);
    const next: Canvas = { ...canvas, ...applied, chatId, version: canvas.version + 1, layout: await layoutSpec(applied.spec), state: 'open', updatedAt: this.clock.now() };
    this.save('canvas.updated', next);
    return { outcome: 'ok', text: `${next.ref} v${next.version}` };
  }

  read(chatId: string, id: string): BusReply {
    const chat = this.store.getChat(chatId)!;
    const canvas = this.find(chat.topicId, id);
    return canvas ? { outcome: 'ok', text: readText(canvas) } : this.refused(`no canvas ${id} in this topic`);
  }

  card(topicId: string, ref: string): Canvas {
    const canvas = this.find(topicId, ref);
    if (!canvas) throw new HosError(404, `no canvas ${ref} in this topic`);
    return canvas;
  }

  saveDraft(topicId: string, ref: string, body: unknown): { ok: true } {
    const canvas = this.card(topicId, ref);
    const draft = this.parseDraft(body);
    if (!this.store.saveCanvasDraft(canvas.topicId, canvas.ref, draft)) throw new HosError(404, `no canvas ${ref} in this topic`);
    return { ok: true };
  }

  private parseDraft(body: unknown): Draft {
    const parsed = DRAFT.safeParse(body);
    if (!parsed.success) throw new HosError(400, `draft: ${parsed.error.issues[0]!.path.join('.')} ${parsed.error.issues[0]!.message}`);
    if (JSON.stringify(parsed.data).length > LIMITS.draftChars) throw new HosError(413, `draft is over ${LIMITS.draftChars / 1024} KB`);
    return parsed.data as Draft;
  }

  async submit(topicId: string, ref: string, body: unknown): Promise<{ text: string }> {
    const canvas = this.card(topicId, ref);
    const draft = this.parseDraft(body);
    const answers = pendingAnswers(canvas, draft.a);
    if (!Object.keys(answers).length) throw new HosError(400, `nothing to send: no answer on an open block of ${canvas.ref}`);
    const text = submitText(canvas, answers, draft, ownerStart());
    const next: Canvas = { ...canvas, draft, open: [], submits: [...canvas.submits, { version: canvas.version, at: this.clock.now(), answers }], updatedAt: this.clock.now() };
    this.save('canvas.submitted', next);
    await this.deliver(canvas.chatId, text, canvas.ref);
    return { text };
  }

  show(topicId: string, ref: string): { ok: true } {
    const canvas = this.card(topicId, ref);
    if (canvas.state === 'closed') this.save('canvas.updated', { ...canvas, state: 'open', updatedAt: this.clock.now() });
    return { ok: true };
  }

  private save(type: 'canvas.created' | 'canvas.updated' | 'canvas.submitted', canvas: Canvas): void {
    this.record({ type, topicId: canvas.topicId, chatId: canvas.chatId, ref: canvas.ref, version: canvas.version }, () => this.store.saveCanvas(canvas));
  }
}
