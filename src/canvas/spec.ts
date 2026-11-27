import { z } from 'zod';
import { BLOCKS } from './registry.js';
import type { Block, BlockKind, Canvas, Draft, Feedback, Spec } from './types.js';
import { SPEC_VERSION } from './types.js';
import { clip } from './kinds/common.js';

// A lesson is ~10 blocks and ~5.5 KB; the caps keep one canvas to a few screens and a few thousand tokens.
export const LIMITS = { blocks: 40, specChars: 24_000, ops: 60, open: 10, draftChars: 32_768 };

export class SpecError extends Error {}

export function kindOf(name: string): BlockKind | undefined {
  return BLOCKS.find((k) => k.kind === name);
}

export const answerable = (block: Block): boolean => !!kindOf(block.kind)?.answer;

const ID = /^[A-Za-z][\w-]{0,31}$/;

function issue(error: z.ZodError): string {
  const first = error.issues[0]!;
  const path = first.path.map(String);
  if (first.code === 'unrecognized_keys') return `${[...path, first.keys.join(', ')].join('.')}: not a field here`;
  return `${path.join('.') || '(block)'}: ${first.message}`;
}

export function checkBlock(raw: unknown, at: string, taken: Set<string>, fallbackId: string): Block {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SpecError(`${at}: a block is an object with kind`);
  const { id: rawId, kind: rawKind, fold, ...fields } = raw as Record<string, unknown>;
  const kind = typeof rawKind === 'string' ? kindOf(rawKind) : undefined;
  const id = rawId === undefined ? fallbackId : rawId;
  const label = `${at} ${typeof id === 'string' ? id : '?'}`;
  if (!kind) throw new SpecError(`${label}.kind: "${String(rawKind)}" is not a block; use ${BLOCKS.map((k) => k.kind).join(', ')}`);
  if (typeof id !== 'string' || !ID.test(id)) throw new SpecError(`${label} (${kind.kind}).id: letters, digits, - or _, starting with a letter`);
  if (taken.has(id)) throw new SpecError(`${label} (${kind.kind}).id: "${id}" is used twice`);
  if (fold !== undefined && typeof fold !== 'boolean') throw new SpecError(`${label} (${kind.kind}).fold: true or false`);
  const parsed = kind.fields.safeParse(fields);
  if (!parsed.success) throw new SpecError(`${label} (${kind.kind}).${issue(parsed.error)}`);
  const block = { id, kind: kind.kind, ...(fold ? { fold: true } : {}), ...(parsed.data as object) } as Block;
  const problem = kind.check?.(block);
  if (problem) throw new SpecError(`${label} (${kind.kind}).${problem}`);
  taken.add(id);
  return block;
}

export function parseSpec(input: { title: string; blocks: unknown[]; submit?: string }): Spec {
  if (!input.title.trim() || input.title.length > 120) throw new SpecError('title: 1 to 120 characters');
  if ((input.submit ?? '').length > 40) throw new SpecError('submit: at most 40 characters');
  if (!input.blocks.length) throw new SpecError('blocks: a canvas needs at least one block');
  if (input.blocks.length > LIMITS.blocks) throw new SpecError(`blocks: at most ${LIMITS.blocks} blocks per canvas (you sent ${input.blocks.length}); split it`);
  const taken = new Set<string>();
  const ids = new Set(input.blocks.flatMap((b) => (b && typeof b === 'object' && typeof (b as Block).id === 'string' ? [(b as Block).id] : [])));
  let auto = 0;
  const nextId = () => {
    do auto += 1;
    while (ids.has(`b${auto}`));
    return `b${auto}`;
  };
  const blocks = input.blocks.map((raw, i) => checkBlock(raw, `blocks[${i}]`, taken, nextId()));
  const spec: Spec = { v: SPEC_VERSION, title: input.title.trim(), ...(input.submit?.trim() ? { submit: input.submit.trim() } : {}), blocks };
  checkSize(spec);
  checkPointers(spec);
  return spec;
}

function checkSize(spec: Spec): void {
  const size = JSON.stringify(spec).length;
  if (size > LIMITS.specChars) throw new SpecError(`spec is ${size} chars, over ${LIMITS.specChars}; split it into two canvases`);
}

function checkPointers(spec: Spec): void {
  const nodes = new Set(spec.blocks.flatMap((b) => kindOf(b.kind)?.nodes?.(b) ?? []));
  for (const block of spec.blocks) {
    const pointers = [block.node, ...Object.values((block.lines as Record<string, { node?: string }> | undefined) ?? {}).map((l) => l.node)];
    const missing = pointers.find((n) => typeof n === 'string' && !nodes.has(n));
    if (missing) throw new SpecError(`${block.id} (${block.kind}).node: no flow node "${missing}"`);
  }
}

export function upgrade(spec: Spec): Spec {
  return spec.v === SPEC_VERSION ? spec : { ...spec, v: SPEC_VERSION };
}

const blockRef = z.string().min(1).max(32);
const OP = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('add'), block: z.record(z.string(), z.unknown()), after: blockRef.optional() }),
  z.strictObject({ op: z.literal('set'), block: blockRef, fields: z.record(z.string(), z.unknown()) }),
  z.strictObject({ op: z.literal('remove'), block: blockRef }),
  z.strictObject({ op: z.literal('feedback'), block: blockRef, ok: z.boolean(), note: z.string().trim().min(1).max(600), node: z.string().max(40).optional() }),
  z.strictObject({ op: z.literal('reopen'), block: blockRef }),
  z.strictObject({ op: z.literal('title'), title: z.string().trim().min(1).max(120) }),
  z.strictObject({ op: z.literal('submit'), label: z.string().trim().max(40) }),
]);
export type Op = z.infer<typeof OP>;

export interface Applied {
  spec: Spec;
  fb: Record<string, Feedback>;
  open: string[];
}

export function applyOps(canvas: Canvas, rawOps: unknown[]): Applied {
  if (rawOps.length > LIMITS.ops) throw new SpecError(`ops: at most ${LIMITS.ops} per update`);
  const blocks = [...canvas.spec.blocks];
  const fb = { ...canvas.fb };
  const open = new Set(canvas.open);
  let { title, submit } = canvas.spec;
  const find = (id: string, at: string) => {
    const i = blocks.findIndex((b) => b.id === id);
    if (i < 0) throw new SpecError(`${at}: no block "${id}" in ${canvas.ref}`);
    return i;
  };
  rawOps.forEach((raw, n) => {
    const at = `ops[${n}]`;
    const parsed = OP.safeParse(raw);
    if (!parsed.success) throw new SpecError(`${at}.${issue(parsed.error)}`);
    const op = parsed.data;
    const others = (skip?: string) => new Set(blocks.map((b) => b.id).filter((id) => id !== skip));
    switch (op.op) {
      case 'add': {
        const taken = others();
        let k = blocks.length;
        while (taken.has(`b${k + 1}`)) k += 1;
        const block = checkBlock(op.block, `${at}.block`, taken, `b${k + 1}`);
        const after = op.after === undefined ? blocks.length - 1 : find(op.after, `${at}.after`);
        blocks.splice(after + 1, 0, block);
        if (answerable(block)) open.add(block.id);
        return;
      }
      case 'set': {
        const i = find(op.block, `${at}.block`);
        const { id: _id, kind: _kind, ...rest } = blocks[i]!;
        const merged = { ...rest, ...op.fields, id: blocks[i]!.id, kind: blocks[i]!.kind };
        for (const [key, value] of Object.entries(op.fields)) if (value === null) delete (merged as Record<string, unknown>)[key];
        blocks[i] = checkBlock(merged, `${at}.fields`, others(op.block), op.block);
        return;
      }
      case 'remove': {
        blocks.splice(find(op.block, `${at}.block`), 1);
        delete fb[op.block];
        open.delete(op.block);
        return;
      }
      case 'feedback': {
        const block = blocks[find(op.block, `${at}.block`)]!;
        fb[block.id] = { ok: op.ok, note: op.note, ...(op.node ? { node: op.node } : {}) };
        return;
      }
      case 'reopen': {
        const block = blocks[find(op.block, `${at}.block`)]!;
        if (!answerable(block)) throw new SpecError(`${at}.block: ${block.id} (${block.kind}) takes no answer, so it can't reopen`);
        open.add(block.id);
        return;
      }
      case 'title':
        title = op.title;
        return;
      case 'submit':
        submit = op.label || undefined;
        return;
    }
  });
  if (!blocks.length) throw new SpecError(`ops: ${canvas.ref} would have no blocks left`);
  if (blocks.length > LIMITS.blocks) throw new SpecError(`ops: ${canvas.ref} would have ${blocks.length} blocks, over ${LIMITS.blocks}`);
  const spec: Spec = { v: SPEC_VERSION, title, ...(submit ? { submit } : {}), blocks };
  checkSize(spec);
  checkPointers(spec);
  const ids = new Set(blocks.map((b) => b.id));
  const nodes = new Set(blocks.flatMap((b) => kindOf(b.kind)?.nodes?.(b) ?? []));
  for (const [id, f] of Object.entries(fb)) {
    if (!ids.has(id)) delete fb[id];
    else if (f.node && !nodes.has(f.node)) throw new SpecError(`feedback ${id}.node: no flow node "${f.node}"`);
  }
  return { spec, fb, open: [...open].filter((id) => ids.has(id)) };
}

export function emptyDraft(): Draft {
  return { a: {}, view: {} };
}

export function hasBar(spec: Spec): boolean {
  return spec.blocks.some(answerable);
}

export function barLabel(canvas: Pick<Canvas, 'spec' | 'submits'>): string {
  return canvas.submits.length ? 'Check again' : (canvas.spec.submit ?? 'Send');
}

function answerOf(block: Block, answers: Record<string, unknown>): unknown {
  const kind = kindOf(block.kind)!;
  const value = answers[block.id];
  if (value === undefined || !kind.answer?.safeParse(value).success) return undefined;
  return kind.answered ? (kind.answered(block, value) ? value : undefined) : value;
}

export function pendingAnswers(canvas: Pick<Canvas, 'spec' | 'open'>, answers: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const block of canvas.spec.blocks) {
    if (!canvas.open.includes(block.id)) continue;
    const value = answerOf(block, answers);
    if (value !== undefined) out[block.id] = value;
  }
  return out;
}

function viewLine(canvas: Pick<Canvas, 'spec'>, draft: Draft): string {
  return canvas.spec.blocks
    .flatMap((block) => {
      const v = draft.view[block.id];
      const line = v && kindOf(block.kind)?.view?.(block, v);
      return line ? [line] : [];
    })
    .join(' · ');
}

function answerLines(canvas: Pick<Canvas, 'spec' | 'fb'>, answers: Record<string, unknown>): string[] {
  return canvas.spec.blocks.flatMap((block) => {
    if (!(block.id in answers)) return [];
    const kind = kindOf(block.kind)!;
    const value = answers[block.id];
    return [`- ${block.id} ${kind.line ? kind.line(block, value, { ...(canvas.fb[block.id] ? { fb: canvas.fb[block.id] } : {}) }) : JSON.stringify(value)}`];
  });
}

function score(canvas: Pick<Canvas, 'spec'>, answers: Record<string, unknown>): string {
  let right = 0;
  let keyed = 0;
  for (const block of canvas.spec.blocks) {
    if (!(block.id in answers)) continue;
    const ok = kindOf(block.kind)!.correct?.(block, answers[block.id]);
    if (ok === undefined) continue;
    keyed += 1;
    if (ok) right += 1;
  }
  return keyed ? `Score ${right}/${keyed}.` : '';
}

export function submitText(canvas: Pick<Canvas, 'ref' | 'version' | 'spec' | 'fb' | 'submits'>, answers: Record<string, unknown>, draft: Draft, who: string): string {
  const retry = canvas.submits.length > 0;
  const head = retry
    ? `[hos] ${who} re-answered ${canvas.ref} "${clip(canvas.spec.title, 80)}" v${canvas.version} ("${barLabel(canvas)}", hos bar):`
    : `[hos] ${who} submitted ${canvas.ref} "${clip(canvas.spec.title, 80)}" v${canvas.version} ("${barLabel(canvas)}", hos bar):`;
  const seen = viewLine(canvas, draft);
  const tail = [score(canvas, answers), seen ? `Seen: ${seen}.` : '', `canvas_read ${canvas.ref} for the rest.`].filter(Boolean).join(' ');
  return [head, ...answerLines(canvas, answers), tail].join('\n');
}

export function readText(canvas: Canvas): string {
  const last = canvas.submits.at(-1);
  const head = `${canvas.ref} "${clip(canvas.spec.title, 80)}" v${canvas.version} · ${canvas.state} · ${canvas.submits.length ? `${canvas.submits.length} submit${canvas.submits.length === 1 ? '' : 's'} (last on v${last!.version})` : 'not submitted'}`;
  const seen = viewLine(canvas, canvas.draft);
  const unsent = pendingAnswers(canvas, canvas.draft.a);
  const locked = canvas.spec.blocks.filter((b) => answerable(b) && !canvas.open.includes(b.id)).map((b) => b.id);
  const marks = Object.entries(canvas.fb).map(([id, f]) => `${id} ${f.ok ? '✓' : '✗'}`);
  return [
    head,
    ...(seen ? [`seen: ${seen}`] : []),
    ...(Object.keys(unsent).length ? ['unsent draft:', ...answerLines(canvas, unsent)] : []),
    ...(last ? ['last submit:', ...answerLines(canvas, last.answers)] : []),
    ...(locked.length && hasBar(canvas.spec) ? [`locked until you reopen: ${locked.join(', ')}`] : []),
    ...(marks.length ? [`feedback: ${marks.join(', ')}`] : []),
  ].join('\n');
}
