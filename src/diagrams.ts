import { execFile } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { promisify } from 'node:util';
import type { WebSocket } from 'ws';
import { parse, stringify } from 'yaml';
import type { Clock } from './adapters/clock.js';
import type { DiagramChange, DiagramInfo, DiagramScene, DiagramVersion } from './api/types.js';
import type { BusReply } from './bus.js';
import { HosError } from './core.js';
import { type LayoutSpec, place, validate } from './diagram-layout.js';
import { owner, ownerStart } from './owner.js';

const run = promisify(execFile);

export const DIAGRAMS_DIR = 'diagrams';
const BOARD = 'board.excalidraw';
const META = 'diagram.md';
const SAVE_DELAY_MS = 1500;
const QUIET_CHECKPOINT_MS = 30_000;
const EXPORT_TIMEOUT_MS = 10_000;
const MERMAID_TIMEOUT_MS = 30_000;
const KEPT_APPLIES = 50;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

type Who = 'user' | 'agent';

export interface Element {
  id: string;
  type: string;
  version: number;
  versionNonce: number;
  isDeleted?: boolean;
  [key: string]: unknown;
}

interface Style {
  color?: string;
  fill?: string;
  size?: 'title' | 'heading' | 'body' | 'small';
  stroke?: 'solid' | 'dashed';
  align?: 'left' | 'center';
  label?: string;
  ends?: 'none' | 'end' | 'both';
}

export type DiagramOp =
  | (Style & {
      op: 'add';
      id?: string;
      type: 'rectangle' | 'ellipse' | 'diamond' | 'text' | 'arrow' | 'note' | 'frame' | 'line';
      x?: number;
      y?: number;
      width?: number;
      height?: number;
      text?: string;
      from?: string;
      to?: string;
      children?: string[];
      near?: { id: string; side: 'right' | 'below' | 'left' | 'above'; gap?: number };
    })
  | (Style & { op: 'update'; id: string; x?: number; y?: number; width?: number; height?: number; text?: string })
  | { op: 'fit'; ids?: string[] }
  | { op: 'delete'; ids: string[] };

interface Applied {
  before: Map<string, Element | null>;
  after: Map<string, Element>;
}

interface Reply {
  png?: string;
  elements?: Element[];
  files?: Record<string, unknown>;
  error?: string;
}

interface Room {
  id: string;
  elements: Map<string, Element>;
  files: Record<string, unknown>;
  clients: Set<WebSocket>;
  saveTimer?: ReturnType<typeof setTimeout>;
  cancelQuiet?: () => void;
  requests: Map<string, (reply: Reply) => void>;
  applies: Map<string, Applied>;
  updatedBy: Who | null;
  holds: number;
  dirty: boolean;
  held: Promise<void>;
  edits: number;
}

interface Meta {
  title: string;
  topic: string;
  chat?: string;
  naming?: boolean;
  created?: string;
}

export interface DiagramLinks {
  chats(id: string): string[];
  add(id: string, lineageId: string): void;
  firstChat(topicId: string): string | undefined;
}

const COLORS: Record<string, string> = {
  black: '#1e1e1e',
  grey: '#868e96',
  red: '#e03131',
  green: '#2f9e44',
  blue: '#1971c2',
  amber: '#f08c00',
  violet: '#9c36b5',
};
const FILLS: Record<string, string> = {
  grey: '#e9ecef',
  red: '#ffc9c9',
  green: '#b2f2bb',
  blue: '#a5d8ff',
  amber: '#ffec99',
  violet: '#eebefa',
};
const FONT_SIZES: Record<string, number> = { title: 28, heading: 20, body: 16, small: 14 };
const NOTE_FILL = FILLS.amber!;
const LABELLED = new Set(['rectangle', 'ellipse', 'diamond', 'note']);
const SIZES: Record<string, [number, number]> = { note: [200, 120], frame: [400, 300] };
const DEFAULT_SIZE: [number, number] = [180, 80];
// Share of a container's box that Excalidraw lets bound text use (getMaxContainerWidth/Height).
const TEXT_RATIO: Record<string, number> = { ellipse: Math.SQRT1_2, diamond: 0.5 };
const CHAR_EM = 0.6;
const LINE_HEIGHT = 1.25;
const PAD = 12;
const MAX_FIT_WIDTH = 360;
const GAP = 60;
const ARROW_LABEL_SIZE = 16;

export function newerThan(incoming: Element, current: Element | undefined): boolean {
  if (!current) return true;
  if (incoming.version !== current.version) return incoming.version > current.version;
  return incoming.versionNonce < current.versionNonce;
}

export class Diagrams {
  private readonly rooms = new Map<string, Promise<Room>>();
  private readonly uncommitted = new Set<string>();

  constructor(
    private readonly brainDir: string,
    private readonly clock: Clock,
    private readonly changed: (id: string) => void = () => {},
    private readonly checkpoint: (paths: string[], subject: string) => Promise<void> | void = () => {},
    private readonly links: DiagramLinks = { chats: () => [], add: () => {}, firstChat: () => undefined },
  ) {}

  private now(): number {
    return this.clock.now();
  }

  awaitsCheckpoint(path: string): boolean {
    const [dir, id] = path.split('/');
    return dir === DIAGRAMS_DIR && !!id && this.uncommitted.has(id);
  }

  async list(filter: { topicId?: string; query?: string } = {}): Promise<DiagramInfo[]> {
    const names = await readdir(join(this.brainDir, DIAGRAMS_DIR)).catch(() => [] as string[]);
    const needle = filter.query?.trim().toLowerCase();
    const found = await Promise.all(
      names
        .filter((name) => ID.test(name))
        .map(async (id) => {
          const info = await this.info(id).catch(() => null);
          if (!info || (filter.topicId && info.topic !== filter.topicId)) return null;
          if (!needle || info.title.toLowerCase().includes(needle)) return info;
          const labels = [...(await this.room(id)).elements.values()].filter((e) => !e.isDeleted && typeof e.text === 'string').map((e) => String(e.text).toLowerCase());
          return labels.some((label) => label.includes(needle)) ? info : null;
        }),
    );
    return found.filter((d): d is DiagramInfo => !!d).sort((a, b) => b.updated - a.updated || a.title.localeCompare(b.title));
  }

  linked(topicId: string, lineageId?: string): Array<{ id: string; title: string; path: string; topic: string; linked: boolean }> {
    return this.allMeta()
      .map(({ id, front }) => ({ id, title: front.title, path: boardPath(id), topic: front.topic, linked: !!lineageId && this.links.chats(id).includes(lineageId) }))
      .filter((d) => d.topic === topicId || d.linked)
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  byChat(lineageId: string): { id: string; title: string; topic: string; naming: boolean } | undefined {
    const found = this.allMeta().find(({ id }) => this.links.chats(id)[0] === lineageId);
    return found && { id: found.id, title: found.front.title, topic: found.front.topic, naming: !!found.front.naming };
  }

  private allMeta(): Array<{ id: string; front: Meta }> {
    const root = join(this.brainDir, DIAGRAMS_DIR);
    return (existsSync(root) ? readdirSync(root) : [])
      .filter((name) => ID.test(name))
      .flatMap((id) => {
        try {
          return [{ id, front: this.migrate(id, parseMeta(id, readFileSync(join(root, id, META), 'utf8'))).front }];
        } catch {
          return [];
        }
      });
  }

  private migrate(id: string, meta: { front: Meta; body: string; home?: string }): { front: Meta; body: string } {
    const chat = meta.front.chat ?? (meta.home ? this.links.firstChat(meta.home) : undefined);
    if (!chat) return meta;
    const { chat: _, ...front } = meta.front;
    this.links.add(id, chat);
    writeFileSync(join(this.brainDir, DIAGRAMS_DIR, id, META), metaText(front, meta.body));
    return { front, body: meta.body };
  }

  async info(id: string): Promise<DiagramInfo> {
    const { front } = await this.meta(id);
    const room = await this.room(id);
    const live = [...room.elements.values()].filter((e) => !e.isDeleted);
    const updated = await stat(join(this.brainDir, DIAGRAMS_DIR, id, BOARD)).then(
      (s) => s.mtimeMs,
      () => 0,
    );
    return {
      id,
      title: front.title,
      topic: front.topic,
      chats: this.links.chats(id),
      naming: !!front.naming,
      path: boardPath(id),
      open: this.isOpen(id),
      updated,
      updatedBy: room.updatedBy,
      hasInk: live.some((e) => e.type === 'freedraw'),
      elementCount: live.length,
    };
  }

  async scene(id: string): Promise<DiagramScene> {
    const room = await this.room(id);
    return { elements: [...room.elements.values()].filter((e) => !e.isDeleted), files: room.files };
  }

  async rename(id: string, title: string): Promise<DiagramInfo> {
    const { front, body } = await this.meta(id);
    const heading = `# ${front.title}`;
    const { naming: _, ...kept } = front;
    await this.writeMeta(id, { ...kept, title }, body.replace(heading, () => `# ${title}`));
    this.changed(id);
    return this.info(id);
  }

  async stopNaming(id: string): Promise<void> {
    const { front, body } = await this.meta(id);
    if (!front.naming) return;
    const { naming: _, ...kept } = front;
    await this.writeMeta(id, kept, body);
    this.changed(id);
  }

  async create(title: string, topic: string, naming = false): Promise<DiagramInfo> {
    const base = slug(title);
    for (let n = 1; ; n++) {
      const id = n === 1 ? base : `${base}-${n}`;
      const dir = join(this.brainDir, DIAGRAMS_DIR, id);
      const made = await mkdir(dir, { recursive: false }).then(
        () => true,
        (error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? mkdir(dir, { recursive: true }).then(() => true) : false),
      );
      if (!made) continue;
      await this.writeMeta(id, { title, topic, ...(naming ? { naming } : {}), created: new Date(this.now()).toISOString() }, `\n# ${title}\n`);
      await writeFile(join(dir, BOARD), board([], {}));
      this.changed(id);
      return this.info(id);
    }
  }

  private async meta(id: string): Promise<{ front: Meta; body: string }> {
    if (!ID.test(id)) throw new HosError(400, `no diagram "${id}"`);
    const text = await readFile(join(this.brainDir, DIAGRAMS_DIR, id, META), 'utf8').catch(() => null);
    if (text === null) throw new HosError(404, `no diagram "${id}"`);
    return this.migrate(id, parseMeta(id, text));
  }

  private writeMeta(id: string, meta: Meta, body: string): Promise<void> {
    return writeFile(join(this.brainDir, DIAGRAMS_DIR, id, META), metaText(meta, body));
  }

  attach(id: string, ws: WebSocket): void {
    void this.room(id).then(
      (room) => {
        room.clients.add(ws);
        this.openTabs.set(id, (this.openTabs.get(id) ?? 0) + 1);
        ws.send(JSON.stringify({ type: 'init', elements: [...room.elements.values()], files: room.files }));
        ws.on('message', (data) => {
          let message: { type?: string; elements?: Element[]; files?: Record<string, unknown>; reqId?: string } & Reply;
          try {
            message = JSON.parse(String(data));
          } catch {
            return;
          }
          if (message.type === 'update' && Array.isArray(message.elements)) {
            const { files, refused } = sizedFiles(message.files);
            if (refused.length) ws.send(JSON.stringify({ type: 'error', message: tooBig(refused) }));
            this.accept(room, message.elements, ws, 'user', files);
          }
          if ((message.type === 'export' || message.type === 'mermaid') && message.reqId) room.requests.get(message.reqId)?.(message);
        });
        ws.on('close', () => {
          room.clients.delete(ws);
          this.openTabs.set(id, (this.openTabs.get(id) ?? 1) - 1);
        });
      },
      () => ws.close(4404, 'no such diagram'),
    );
  }

  async read(id: string): Promise<string> {
    const room = await this.room(id);
    const info = await this.info(id);
    const live = [...room.elements.values()].filter((e) => !e.isDeleted);
    const lines = live.map((e) => JSON.stringify(summary(e)));
    return [
      `Diagram "${info.title}" (${id}), file ${info.path}, ${live.length} element(s), ${info.open ? `open in ${owner()}’s browser now` : 'not open anywhere'}.`,
      'Pen ink is type "freedraw" (bounds only); call diagram_screenshot to see what it says.',
      check(live),
      ...lines,
    ].join('\n');
  }

  async apply(id: string, ops: DiagramOp[]): Promise<string> {
    const room = await this.room(id);
    const changed = new Map<string, Element>();
    const current = (ref: string) => changed.get(ref) ?? room.elements.get(ref);
    const bump = (element: Element, patch: Record<string, unknown>) => {
      const next = { ...element, ...patch, version: element.version + 1, versionNonce: nonce(), updated: this.now() } as Element;
      changed.set(next.id, next);
      return next;
    };
    const made: string[] = [];
    const grew = new Set<string>();
    const labelOf = (ref: string) => {
      for (const key of new Set([...room.elements.keys(), ...changed.keys()])) {
        const e = current(key)!;
        if (e.containerId === ref && !e.isDeleted) return e;
      }
      return undefined;
    };
    const refit = (ref: string, raw?: string, size?: number, align?: string, force = false) => {
      let container = current(ref)!;
      const label = labelOf(ref);
      if (label && raw === undefined && size === undefined && !force && !spills(label, container)) {
        bump(current(label.id)!, { ...centred(container, boxOf(label)), ...(align ? { textAlign: align } : {}) });
        return;
      }
      const value = raw ?? (label ? String(label.originalText ?? label.text ?? '') : undefined);
      if (value === undefined) return;
      const fontSize = size ?? Number(label?.fontSize ?? 20);
      const box = fitBox(container.type, value, fontSize, Number(container.width), Number(container.height), false);
      if (box.width > Number(container.width) || box.height > Number(container.height)) {
        container = bump(container, { width: box.width, height: box.height });
        grew.add(ref);
      }
      const fields = { ...centred(container, box.label), text: box.text, originalText: value, fontSize, ...(align ? { textAlign: align } : {}) };
      if (label) bump(current(label.id)!, fields);
      else this.label(container, fields, changed, bump);
    };
    const reroute = (arrowId: string) => {
      const arrow = current(arrowId);
      if (!arrow || arrow.isDeleted || (arrow.points as unknown[] | undefined)?.length !== 2) return;
      const from = current(String((arrow.startBinding as { elementId?: string } | null)?.elementId ?? ''));
      const to = current(String((arrow.endBinding as { elementId?: string } | null)?.elementId ?? ''));
      if (!from || !to || from.isDeleted || to.isDeleted) return;
      const moved = bump(arrow, straight(edge(from, center(to)), edge(to, center(from))));
      const label = labelOf(arrowId);
      if (label) bump(current(label.id)!, centredOn(midpoint(moved), boxOf(label)));
    };
    for (const op of ops) {
      if (op.op === 'delete') {
        for (const ref of op.ids) {
          const element = current(ref);
          if (!element) throw new HosError(400, `no element "${ref}"`);
          bump(element, { isDeleted: true });
          for (const other of room.elements.values()) if (other.containerId === ref && !other.isDeleted) bump(current(other.id)!, { isDeleted: true });
        }
      } else if (op.op === 'fit') {
        const refs = op.ids ?? [...new Set([...room.elements.keys(), ...changed.keys()])].filter((key) => isContainer(current(key)!) && !!labelOf(key) && spills(labelOf(key)!, current(key)!));
        for (const ref of refs) {
          const element = current(ref);
          if (!element) throw new HosError(400, `no element "${ref}"`);
          if (isContainer(element)) refit(ref, undefined, undefined, undefined, !!op.ids);
        }
      } else if (op.op === 'update') {
        const element = current(op.id);
        if (!element) throw new HosError(400, `no element "${op.id}"`);
        const patch: Record<string, unknown> = { ...style(op, element.type) };
        for (const key of ['x', 'y', 'width', 'height'] as const) if (op[key] !== undefined) patch[key] = op[key];
        if (element.type === 'text' && (op.text !== undefined || op.size)) {
          const value = op.text ?? String(element.originalText ?? element.text ?? '');
          Object.assign(patch, textSize(value, fontSizeOf(op.size) ?? Number(element.fontSize ?? 20)), { text: value, originalText: value });
        }
        bump(element, patch);
        if (isContainer(element) && (op.text !== undefined || op.size || op.align || labelOf(op.id))) refit(op.id, op.text, fontSizeOf(op.size), op.align);
        if (element.type === 'arrow' && op.label !== undefined) this.arrowLabel(current(op.id)!, op.label, labelOf(op.id), changed, bump);
      } else {
        const fontSize = fontSizeOf(op.size) ?? 20;
        const element = op.type === 'arrow' || op.type === 'line' ? this.arrow(op, current, bump) : this.shape(op, room, changed, current, fontSize);
        const prior = current(element.id);
        if (prior && !prior.isDeleted) throw new HosError(400, `element "${element.id}" already exists; update it, or delete it first`);
        if (prior) element.version = prior.version + 1;
        changed.set(element.id, element);
        if (op.text && LABELLED.has(op.type)) {
          const box = fitBox(element.type, op.text, fontSize, Number(element.width), Number(element.height), false);
          this.label(element, { ...centred(element, box.label), text: box.text, originalText: op.text, fontSize, ...(op.align ? { textAlign: op.align } : {}) }, changed, bump);
        }
        if (op.type === 'arrow' && op.label) this.arrowLabel(changed.get(element.id)!, op.label, undefined, changed, bump);
        if (op.type === 'frame') {
          for (const ref of op.children ?? []) {
            const child = current(ref);
            if (!child) throw new HosError(400, `no element "${ref}" to put in frame ${element.id}`);
            bump(child, { frameId: element.id });
            for (const other of new Set([...room.elements.keys(), ...changed.keys()])) {
              const label = current(other)!;
              if (label.containerId === ref && !label.isDeleted) bump(label, { frameId: element.id });
            }
          }
        }
        made.push(element.id);
      }
    }
    const arrows = new Set<string>();
    for (const element of [...changed.values()]) {
      if (element.isDeleted || !isContainer(element)) continue;
      const before = room.elements.get(element.id);
      if (before && ['x', 'y', 'width', 'height'].every((key) => before[key] === element[key])) continue;
      for (const bound of (element.boundElements as Array<{ id: string; type: string }> | null) ?? []) if (bound.type === 'arrow') arrows.add(bound.id);
    }
    for (const arrowId of arrows) reroute(arrowId);
    const applyId = await this.change(room, changed, 'agent', `${ops.length} op(s)${made.length ? `, +${made.length} new` : ''}`);
    const live = [...room.elements.values()].filter((e) => !e.isDeleted);
    return [
      `Applied ${ops.length} op(s) (apply ${applyId})${made.length ? `; new ids: ${made.join(', ')}` : ''}.`,
      ...(grew.size ? [`Grew ${[...grew].join(', ')} to fit their labels.`] : []),
      check(live, new Set(changed.keys())),
      room.clients.size ? `${ownerStart()} sees it live; one Undo in their tab reverts it.` : 'Saved; nobody has it open.',
    ].join(' ');
  }

  async undo(id: string, applyId: string): Promise<DiagramChange> {
    const room = await this.room(id);
    const applied = room.applies.get(applyId);
    if (!applied) throw new HosError(404, `no apply ${applyId} on diagram ${id} (hos keeps the last ${KEPT_APPLIES} since it started)`);
    const moved = [...applied.after.values()].filter((after) => {
      const live = room.elements.get(after.id);
      return !live || look(live) !== look(after);
    });
    if (moved.length) throw new HosError(409, `can’t undo apply ${applyId}: ${moved.map((e) => e.id).join(', ')} changed since`);
    const changed = new Map<string, Element>();
    for (const [elementId, before] of applied.before) {
      const live = room.elements.get(elementId)!;
      changed.set(elementId, { ...(before ?? { ...live, isDeleted: true }), version: live.version + 1, versionNonce: nonce(), updated: this.now() });
    }
    room.applies.delete(applyId);
    await this.change(room, changed, 'user', `undid apply ${applyId}`, {}, false);
    return { applyId, changed: changed.size };
  }

  async versions(id: string): Promise<DiagramVersion[]> {
    await this.meta(id);
    const log = await this.git('log', '-n', '50', '--format=%H%x1f%ct%x1f%s', '--', posix.join(DIAGRAMS_DIR, id)).catch(() => '');
    return log
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha, at, subject] = line.split('\x1f') as [string, string, string];
        const parsed = /^hos: diagram \S+ · (\w+) · (.*) · \d+ file\(s\)$/.exec(subject);
        const who: Who | null = parsed ? (parsed[1] === 'agent' ? 'agent' : 'user') : null;
        return { sha, at: Number(at) * 1000, who, summary: parsed?.[2] ?? subject };
      });
  }

  async restore(id: string, sha: string): Promise<DiagramChange> {
    const room = await this.room(id);
    if (!/^[0-9a-f]{4,40}$/i.test(sha)) throw new HosError(400, `"${sha}" is not a commit sha`);
    const text = await this.git('show', `${sha}:${boardPath(id)}`).catch(() => null);
    if (text === null) throw new HosError(404, `diagram ${id} has no version ${sha}`);
    const saved = JSON.parse(text) as { elements?: Element[]; files?: Record<string, unknown> };
    const target = new Map((saved.elements ?? []).filter((e) => e && typeof e.id === 'string' && !e.isDeleted).map((e) => [e.id, e]));
    const changed = new Map<string, Element>();
    for (const [elementId, element] of target) {
      const live = room.elements.get(elementId);
      changed.set(elementId, { ...element, version: Math.max(live?.version ?? 0, element.version) + 1, versionNonce: nonce(), updated: this.now() });
    }
    for (const live of room.elements.values()) {
      if (!live.isDeleted && !target.has(live.id)) changed.set(live.id, { ...live, isDeleted: true, version: live.version + 1, versionNonce: nonce(), updated: this.now() });
    }
    const applyId = await this.change(room, changed, 'user', `restored ${sha.slice(0, 7)}`, saved.files ?? {});
    return { applyId, changed: changed.size };
  }

  async importMermaid(id: string, mermaid: string): Promise<string> {
    const room = await this.room(id);
    const reply = await this.ask(room, { type: 'mermaid', mermaid }, MERMAID_TIMEOUT_MS);
    if (reply.error) throw new HosError(400, `Mermaid didn’t convert: ${reply.error}`);
    const elements = (reply.elements ?? []).filter((e) => e && typeof e.id === 'string' && typeof e.type === 'string');
    if (!elements.length) throw new HosError(400, 'the Mermaid text converted to no elements');
    const { files, refused } = sizedFiles(reply.files);
    if (refused.length) throw new HosError(413, tooBig(refused));
    const applyId = await this.change(room, new Map(elements.map((e) => [e.id, e])), 'agent', `mermaid import, +${elements.length} new`, files);
    return `Imported the Mermaid diagram as ${elements.length} element(s) to the right of the existing content (apply ${applyId}). ${ownerStart()} sees it live; one Undo in their tab reverts it.`;
  }

  async layout(id: string, spec: LayoutSpec, options: { layout?: string; at?: Point } = {}): Promise<string> {
    const room = await this.room(id);
    try {
      validate(spec);
    } catch (error) {
      throw new HosError(400, (error as Error).message);
    }
    const live = [...room.elements.values()].filter((e) => !e.isDeleted);
    const lid = options.layout ?? `layout-${randomInt(36 ** 4).toString(36).padStart(4, '0')}`;
    const old = new Map(live.filter((e) => layoutOf(e)?.layout === lid).map((e) => [e.id, e]));
    if (options.layout && !old.size) throw new HosError(404, `no layout "${lid}" on diagram ${id}; diagram_read shows each element's layout`);
    const placed = await place(
      spec,
      (shape, value) => fitBox(shape === 'note' ? 'rectangle' : shape, value, 20, 160, 70, true),
      (value) => textSize(value, ARROW_LABEL_SIZE),
    );
    const others = live.filter((e) => !old.has(e.id));
    const origin =
      options.at ??
      (old.size
        ? { x: Math.min(...[...old.values()].map((e) => Number(e.x))), y: Math.min(...[...old.values()].map((e) => Number(e.y))) }
        : others.length
          ? { x: Math.max(...others.map((e) => Number(e.x) + Number(e.width))) + 120, y: Math.min(...others.map((e) => Number(e.y))) }
          : { x: 100, y: 100 });
    const xs = [...placed.nodes.map((n) => n.x), ...placed.groups.map((g) => g.x), ...placed.arrows.flatMap((a) => a.points.map((p) => p.x)), ...(placed.title ? [placed.title.x] : [])];
    const ys = [...placed.nodes.map((n) => n.y), ...placed.groups.map((g) => g.y), ...placed.arrows.flatMap((a) => a.points.map((p) => p.y)), ...(placed.title ? [placed.title.y] : [])];
    const [dx, dy] = [origin.x - Math.min(...xs), origin.y - Math.min(...ys)];
    const elementId = (key: string) => `${lid}-${key.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60)}`;
    const built = new Map<string, Element>();
    const make = (key: string, type: string, box: Box, stroke: string | undefined, extra: Record<string, unknown>) => {
      const eid = elementId(key);
      const before = old.get(eid);
      const element: Element = { ...base(eid, type, box.x, box.y, box.width, box.height, stroke, this.now()), ...extra, customData: { hosLayout: { layout: lid, key } } };
      if (before) {
        element.version = before.version + 1;
        if (!stroke) element.strokeColor = before.strokeColor;
        if (extra.backgroundColor === undefined) element.backgroundColor = before.backgroundColor;
      }
      built.set(eid, element);
      return element;
    };
    for (const group of placed.groups) make(group.key, 'frame', { x: group.x + dx, y: group.y + dy, width: group.width, height: group.height }, undefined, { name: group.label });
    for (const node of placed.nodes) {
      const type = node.shape === 'note' ? 'rectangle' : node.shape;
      const frameId = node.group ? { frameId: elementId(node.group) } : {};
      const shape = make(node.key, type, { x: node.x + dx, y: node.y + dy, width: node.fit.width, height: node.fit.height }, node.color ?? (node.shape === 'note' ? 'amber' : undefined), {
        ...(type === 'ellipse' ? {} : { roundness: { type: 3 } }),
        ...(node.fill ? { backgroundColor: fill(node.fill) } : node.shape === 'note' ? { backgroundColor: NOTE_FILL } : {}),
        ...(node.focal ? { strokeWidth: 4 } : {}),
        ...frameId,
      });
      const label = make(`${node.key}-t`, 'text', centred(shape, node.fit.label), undefined, { ...text(node.fit.text, shape.id), originalText: node.raw, ...frameId });
      shape.boundElements = [{ id: label.id, type: 'text' }];
    }
    for (const arrow of placed.arrows) {
      const first = arrow.points[0];
      if (!first || arrow.points.length < 2) continue;
      const from = arrow.from ? built.get(elementId(arrow.from)) : undefined;
      const to = arrow.to ? built.get(elementId(arrow.to)) : undefined;
      const px = arrow.points.map((p) => p.x);
      const py = arrow.points.map((p) => p.y);
      const element = make(arrow.key, arrow.line ? 'line' : 'arrow', { x: first.x + dx, y: first.y + dy, width: Math.max(...px) - Math.min(...px), height: Math.max(...py) - Math.min(...py) }, arrow.color, {
        points: arrow.points.map((p) => [p.x - first.x, p.y - first.y]),
        lastCommittedPoint: null,
        startBinding: from ? { elementId: from.id, focus: 0, gap: 4 } : null,
        endBinding: to ? { elementId: to.id, focus: 0, gap: 4 } : null,
        startArrowhead: null,
        endArrowhead: arrow.line ? null : 'arrow',
        ...(arrow.line ? {} : { elbowed: false }),
        roundness: null,
        ...(arrow.dashed ? { strokeStyle: 'dashed' } : {}),
      });
      for (const end of [from, to]) if (end) end.boundElements = [...((end.boundElements as Array<{ id: string; type: string }> | null) ?? []), { id: element.id, type: 'arrow' }];
      if (arrow.label) {
        const label = make(`${arrow.key}-t`, 'text', centredOn(midpoint(element), textSize(arrow.label, ARROW_LABEL_SIZE)), undefined, { ...text(arrow.label, element.id), fontSize: ARROW_LABEL_SIZE });
        element.boundElements = [{ id: label.id, type: 'text' }];
      }
    }
    if (placed.title) {
      const size = textSize(placed.title.text, FONT_SIZES.title);
      make('title', 'text', { x: placed.title.x + dx, y: placed.title.y + dy, ...size }, undefined, { ...text(placed.title.text, null), fontSize: FONT_SIZES.title, textAlign: 'left' });
    }
    const carrier = built.get(elementId(placed.title ? 'title' : placed.nodes[0]!.key))!;
    carrier.customData = { hosLayout: { ...layoutOf(carrier), spec } };
    for (const element of built.values()) {
      const before = old.get(element.id);
      const foreign = ((before?.boundElements as Array<{ id: string; type: string }> | null) ?? []).filter((b) => !built.has(b.id) && !old.has(b.id) && room.elements.get(b.id)?.isDeleted === false);
      if (foreign.length) element.boundElements = [...((element.boundElements as Array<{ id: string; type: string }> | null) ?? []), ...foreign];
    }
    const changed = new Map(built);
    for (const before of old.values()) if (!built.has(before.id)) changed.set(before.id, { ...before, isDeleted: true, version: before.version + 1, versionNonce: nonce(), updated: this.now() });
    const nodes = placed.nodes.length;
    const arrows = placed.arrows.filter((a) => !a.line).length;
    const applyId = await this.change(room, changed, 'agent', `${old.size ? 're-ran' : 'drew'} ${spec.kind} ${lid}, ${nodes} box(es)`);
    const after = [...room.elements.values()].filter((e) => !e.isDeleted);
    return [
      `${old.size ? 'Re-laid out' : 'Laid out'} ${spec.kind} "${lid}": ${nodes} box(es), ${arrows} arrow(s)${placed.groups.length ? `, ${placed.groups.length} group frame(s)` : ''} (apply ${applyId}).`,
      `Box ids are ${lid}-${spec.kind === 'graph' ? 'n-<node id>' : 'a-<actor id>'}; to change it, call diagram_layout again with layout "${lid}" and the full new spec (the current spec is on ${carrier.id} in diagram_read).`,
      check(after, new Set(changed.keys())),
      room.clients.size ? `${ownerStart()} sees it live; one Undo in their tab reverts it.` : 'Saved; nobody has it open.',
    ].join(' ');
  }

  async screenshot(id: string, outFile: string): Promise<string> {
    const room = await this.room(id);
    const { png } = await this.ask(room, { type: 'export' }, EXPORT_TIMEOUT_MS);
    if (!png) throw new HosError(502, 'the open tab sent no image');
    await mkdir(join(outFile, '..'), { recursive: true });
    await writeFile(outFile, Buffer.from(png.replace(/^data:image\/png;base64,/, ''), 'base64'));
    return outFile;
  }

  async flush(): Promise<void> {
    await Promise.all(
      [...this.rooms.values()].map(async (pending) => {
        const room = await pending.catch(() => null);
        if (room?.saveTimer) await this.saveNow(room);
        if (room?.cancelQuiet) {
          room.cancelQuiet();
          room.cancelQuiet = undefined;
          this.commit(room, 'user', 'edited');
        }
        await room?.held;
      }),
    );
  }

  private async ask(room: Room, message: Record<string, unknown>, timeoutMs: number): Promise<Reply> {
    const tab = [...room.clients][0];
    if (!tab) throw new HosError(409, `the diagram isn’t open in any tab; ask ${owner()} to open it, or use diagram_read`);
    const reqId = String(randomInt(1e9));
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        room.requests.delete(reqId);
        reject(new HosError(504, `the open tab didn’t answer within ${timeoutMs / 1000} s`));
      }, timeoutMs);
      room.requests.set(reqId, (reply) => {
        clearTimeout(timer);
        room.requests.delete(reqId);
        resolve(reply);
      });
      tab.send(JSON.stringify({ ...message, reqId }));
    });
  }

  private async change(room: Room, changed: Map<string, Element>, by: Who, summary: string, files: Record<string, unknown> = {}, remember = true): Promise<string> {
    const applyId = randomInt(36 ** 6).toString(36).padStart(6, '0');
    if (remember) {
      room.applies.set(applyId, { before: new Map([...changed.keys()].map((id) => [id, room.elements.get(id) ?? null])), after: new Map(changed) });
      for (const old of [...room.applies.keys()].slice(0, -KEPT_APPLIES)) room.applies.delete(old);
    }
    this.accept(room, [...changed.values()], null, by, files);
    await this.saveNow(room);
    this.commit(room, by, summary);
    return applyId;
  }

  private commit(room: Room, by: Who, summary: string): void {
    const snapshot = boardOf(room);
    const edits = room.edits;
    room.holds++;
    room.held = room.held
      .then(async () => {
        await writeFile(join(this.brainDir, DIAGRAMS_DIR, room.id, BOARD), snapshot);
        await this.checkpoint([boardPath(room.id), posix.join(DIAGRAMS_DIR, room.id, META)], `hos: diagram ${room.id} · ${by} · ${summary}`);
      })
      .catch(() => {})
      .then(async () => {
        if (room.edits === edits) this.uncommitted.delete(room.id);
        if (--room.holds === 0 && room.dirty) {
          room.dirty = false;
          await this.save(room);
        }
        this.changed(room.id);
      });
  }

  private async git(...args: string[]): Promise<string> {
    const { stdout } = await run('git', args, { cwd: this.brainDir, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  }

  private isOpen(id: string): boolean {
    return (this.openTabs.get(id) ?? 0) > 0;
  }

  private readonly openTabs = new Map<string, number>();

  private room(id: string): Promise<Room> {
    let room = this.rooms.get(id);
    if (!room) {
      room = this.meta(id).then(async () => {
        const text = await readFile(join(this.brainDir, DIAGRAMS_DIR, id, BOARD), 'utf8').catch(() => board([], {}));
        const saved = JSON.parse(text) as { elements?: Element[]; files?: Record<string, unknown> };
        const elements = (saved.elements ?? []).filter((e) => e && typeof e.id === 'string');
        return { id, elements: new Map(elements.map((e) => [e.id, e])), files: saved.files ?? {}, clients: new Set<WebSocket>(), requests: new Map(), applies: new Map(), updatedBy: null, holds: 0, dirty: false, held: Promise.resolve(), edits: 0 };
      });
      room.catch(() => this.rooms.delete(id));
      this.rooms.set(id, room);
    }
    return room;
  }

  private accept(room: Room, incoming: Element[], from: WebSocket | null, by: Who, files: Record<string, unknown> = {}): void {
    const accepted = incoming.filter((element) => element && typeof element.id === 'string' && newerThan(element, room.elements.get(element.id)));
    const added = Object.entries(files).filter(([fileId]) => !(fileId in room.files));
    if (!accepted.length && !added.length) return;
    for (const element of accepted) room.elements.set(element.id, element);
    for (const [fileId, file] of added) room.files[fileId] = file;
    room.updatedBy = by;
    room.edits++;
    this.uncommitted.add(room.id);
    const frame = JSON.stringify({ type: 'update', elements: accepted, agent: !from, ...(added.length ? { files: Object.fromEntries(added) } : {}) });
    for (const client of room.clients) if (client !== from) client.send(frame);
    clearTimeout(room.saveTimer);
    room.saveTimer = setTimeout(() => {
      room.saveTimer = undefined;
      void this.save(room);
    }, SAVE_DELAY_MS);
    if (!from) return;
    room.cancelQuiet?.();
    room.cancelQuiet = this.clock.setTimeout(() => {
      room.cancelQuiet = undefined;
      void this.saveNow(room).then(() => this.commit(room, 'user', 'edited'));
    }, QUIET_CHECKPOINT_MS);
  }

  private async saveNow(room: Room): Promise<void> {
    clearTimeout(room.saveTimer);
    room.saveTimer = undefined;
    await this.save(room);
  }

  private async save(room: Room): Promise<void> {
    if (room.holds) {
      room.dirty = true;
      return;
    }
    await writeFile(join(this.brainDir, DIAGRAMS_DIR, room.id, BOARD), boardOf(room));
    this.changed(room.id);
  }

  private shape(op: Extract<DiagramOp, { op: 'add' }>, room: Room, changed: Map<string, Element>, current: (ref: string) => Element | undefined, fontSize: number): Element {
    const live = [...room.elements.values(), ...changed.values()].filter((e) => !e.isDeleted);
    const bottom = live.length ? Math.max(...live.map((e) => Number(e.y) + Number(e.height ?? 0))) + GAP : 100;
    const left = live.length ? Math.min(...live.map((e) => Number(e.x))) : 100;
    const isText = op.type === 'text';
    const note = op.type === 'note';
    const type = note ? 'rectangle' : op.type;
    const children = (op.children ?? []).flatMap((ref) => current(ref) ?? []);
    const box = op.type === 'frame' && children.length ? around(children, 40) : null;
    const [width, height] = SIZES[op.type] ?? DEFAULT_SIZE;
    const size = isText
      ? textSize(op.text ?? '', fontSize)
      : op.text && LABELLED.has(op.type)
        ? fitBox(type, op.text, fontSize, op.width ?? width, op.height ?? height, op.width === undefined)
        : { width: op.width ?? box?.width ?? width, height: op.height ?? box?.height ?? height };
    const near = op.near ? beside(current(op.near.id), op.near, size) : null;
    if (op.near && !near) throw new HosError(400, `no element "${op.near.id}" to place ${op.id ?? 'this'} near`);
    return {
      ...base(op.id ?? newId(), type, op.x ?? near?.x ?? box?.x ?? left, op.y ?? near?.y ?? box?.y ?? bottom, size.width, size.height, op.color ?? (note ? 'amber' : undefined), this.now()),
      ...(isText ? { ...text(op.text ?? '', null), fontSize, ...(op.align ? { textAlign: op.align } : {}) } : {}),
      ...(op.type === 'rectangle' || op.type === 'diamond' || note ? { roundness: { type: 3 } } : {}),
      ...(note ? { backgroundColor: NOTE_FILL } : {}),
      ...(op.type === 'frame' ? { name: op.text ?? null } : {}),
      ...style({ ...op, color: undefined }, type),
    };
  }

  private label(container: Element, fields: Record<string, unknown> & { x: number; y: number; width: number; height: number }, changed: Map<string, Element>, bump: (e: Element, patch: Record<string, unknown>) => Element): void {
    const id = newId();
    changed.set(id, { ...base(id, 'text', fields.x, fields.y, fields.width, fields.height, undefined, this.now()), ...text(String(fields.text ?? ''), container.id), ...fields });
    const owner = changed.get(container.id) ?? container;
    const bound = [...((owner.boundElements as Array<{ id: string; type: string }> | null) ?? []), { id, type: 'text' }];
    if (changed.has(container.id)) changed.set(container.id, { ...owner, boundElements: bound });
    else bump(owner, { boundElements: bound });
  }

  private arrowLabel(arrow: Element, value: string, existing: Element | undefined, changed: Map<string, Element>, bump: (e: Element, patch: Record<string, unknown>) => Element): void {
    if (existing && !value) {
      bump(existing, { isDeleted: true });
      return;
    }
    if (!value) return;
    const size = textSize(value, ARROW_LABEL_SIZE);
    const fields = { ...centredOn(midpoint(arrow), size), text: value, originalText: value, fontSize: ARROW_LABEL_SIZE };
    if (existing) bump(existing, fields);
    else this.label(arrow, fields, changed, bump);
  }

  private arrow(op: Extract<DiagramOp, { op: 'add' }>, current: (ref: string) => Element | undefined, bump: (e: Element, patch: Record<string, unknown>) => Element): Element {
    const from = op.from ? current(op.from) : undefined;
    const to = op.to ? current(op.to) : undefined;
    if (op.from && !from) throw new HosError(400, `no element "${op.from}" to draw an arrow from`);
    if (op.to && !to) throw new HosError(400, `no element "${op.to}" to draw an arrow to`);
    const id = op.id ?? newId();
    const line = op.type === 'line';
    const start = from && to ? edge(from, center(to)) : { x: op.x ?? 100, y: op.y ?? 100 };
    const end = from && to ? edge(to, center(from)) : { x: start.x + (op.width ?? 200), y: start.y + (op.height ?? 0) };
    const element: Element = {
      ...base(id, op.type, start.x, start.y, 0, 0, op.color, this.now()),
      ...straight(start, end),
      lastCommittedPoint: null,
      startBinding: from && !line ? { elementId: from.id, focus: 0, gap: 8 } : null,
      endBinding: to && !line ? { elementId: to.id, focus: 0, gap: 8 } : null,
      startArrowhead: null,
      endArrowhead: line ? null : 'arrow',
      ...(line ? {} : { elbowed: false }),
      roundness: line ? null : { type: 2 },
      ...style({ ...op, color: undefined }, op.type),
    };
    if (line) return element;
    for (const shape of [from, to]) {
      if (!shape) continue;
      const latest = current(shape.id)!;
      bump(latest, { boundElements: [...((latest.boundElements as Array<{ id: string; type: string }> | null) ?? []), { id, type: 'arrow' }] });
    }
    return element;
  }
}

function summary(e: Element): Record<string, unknown> {
  const out: Record<string, unknown> = { id: e.id, type: e.type, x: Math.round(Number(e.x)), y: Math.round(Number(e.y)), w: Math.round(Number(e.width)), h: Math.round(Number(e.height)) };
  if (typeof e.text === 'string') out.text = typeof e.originalText === 'string' ? e.originalText : e.text;
  if (e.containerId) out.in = e.containerId;
  if (e.type === 'arrow') {
    out.from = (e.startBinding as { elementId?: string } | null)?.elementId ?? null;
    out.to = (e.endBinding as { elementId?: string } | null)?.elementId ?? null;
  }
  if (e.type === 'freedraw') out.points = (e.points as unknown[] | undefined)?.length ?? 0;
  if (e.strokeColor && e.strokeColor !== '#1e1e1e') out.color = e.strokeColor;
  if (e.backgroundColor && e.backgroundColor !== 'transparent') out.fill = e.backgroundColor;
  if (e.type === 'text' && e.fontSize && e.fontSize !== 20) out.size = e.fontSize;
  if (e.strokeStyle && e.strokeStyle !== 'solid') out.stroke = e.strokeStyle;
  if (e.frameId) out.frame = e.frameId;
  const layout = layoutOf(e);
  if (layout?.layout) out.layout = layout.layout;
  if (layout?.spec) out.spec = layout.spec;
  return out;
}

function layoutOf(e: Element): { layout?: string; key?: string; spec?: LayoutSpec } | undefined {
  return (e.customData as { hosLayout?: { layout?: string; key?: string; spec?: LayoutSpec } } | undefined)?.hosLayout;
}

type Box = { x: number; y: number; width: number; height: number };
type Point = { x: number; y: number };

function isContainer(e: Element): boolean {
  return !e.isDeleted && (e.type === 'rectangle' || e.type === 'ellipse' || e.type === 'diamond');
}

function fontSizeOf(size: string | undefined): number | undefined {
  return size ? FONT_SIZES[size] : undefined;
}

function style(op: Style, type: string): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (op.color) patch.strokeColor = color(op.color);
  if (op.fill) patch.backgroundColor = fill(op.fill);
  if (op.stroke) patch.strokeStyle = op.stroke;
  if (op.align && type === 'text') patch.textAlign = op.align;
  if (op.ends && (type === 'arrow' || type === 'line')) {
    patch.startArrowhead = op.ends === 'both' ? 'arrow' : null;
    patch.endArrowhead = op.ends === 'none' ? null : 'arrow';
  }
  return patch;
}

export function fitBox(type: string, value: string, fontSize: number, width: number, height: number, growWidth: boolean): { width: number; height: number; text: string; label: { width: number; height: number } } {
  const ratio = TEXT_RATIO[type] ?? 1;
  const natural = (textSize(value, fontSize).width + 2 * PAD) / ratio;
  const word = (Math.max(...value.split(/\s+/).map((part) => part.length), 1) * fontSize * CHAR_EM + 2 * PAD) / ratio;
  const w = Math.max(width, word, growWidth ? Math.min(MAX_FIT_WIDTH, natural) : 0);
  const wrapped = wrap(value, Math.max(1, Math.floor((w * ratio - 2 * PAD) / (fontSize * CHAR_EM))));
  const label = textSize(wrapped, fontSize);
  return {
    width: Math.ceil(Math.max(w, (label.width + 2 * PAD) / ratio)),
    height: Math.ceil(Math.max(height, (label.height + 2 * PAD) / ratio)),
    text: wrapped,
    label,
  };
}

function wrap(value: string, maxChars: number): string {
  return value
    .split('\n')
    .flatMap((paragraph) => {
      const lines: string[] = [];
      let line = '';
      for (const word of paragraph.split(/\s+/).filter(Boolean)) {
        let rest = word;
        while (rest) {
          const space = line ? maxChars - line.length - 1 : maxChars;
          if (rest.length <= space) {
            line = line ? `${line} ${rest}` : rest;
            rest = '';
          } else if (line) {
            lines.push(line);
            line = '';
          } else {
            lines.push(rest.slice(0, maxChars));
            rest = rest.slice(maxChars);
          }
        }
      }
      lines.push(line);
      return lines;
    })
    .join('\n');
}

function centred(container: Element, size: { width: number; height: number }): Box {
  return centredOn(center(container), size);
}

function centredOn(point: Point, size: { width: number; height: number }): Box {
  const width = Number(size.width);
  const height = Number(size.height);
  return { x: point.x - width / 2, y: point.y - height / 2, width, height };
}

function absolutePoints(e: Element): Array<[number, number]> {
  return ((e.points as Array<[number, number]> | undefined) ?? []).map(([px, py]) => [Number(e.x) + px, Number(e.y) + py]);
}

// Same spot Excalidraw puts an arrow's bound label: the middle point, or the middle of the middle segment.
function midpoint(e: Element): Point {
  const points = absolutePoints(e);
  const n = points.length;
  if (!n) return { x: Number(e.x), y: Number(e.y) };
  if (n % 2) {
    const [x, y] = points[(n - 1) / 2]!;
    return { x, y };
  }
  const [ax, ay] = points[n / 2 - 1]!;
  const [bx, by] = points[n / 2]!;
  return { x: (ax + bx) / 2, y: (ay + by) / 2 };
}

function straight(start: Point, end: Point): Record<string, unknown> {
  return {
    x: start.x,
    y: start.y,
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
    points: [
      [0, 0],
      [end.x - start.x, end.y - start.y],
    ],
  };
}

function beside(ref: Element | undefined, near: { side: 'right' | 'below' | 'left' | 'above'; gap?: number }, size: { width: number; height: number }): Point | null {
  if (!ref || ref.isDeleted) return null;
  const gap = near.gap ?? GAP;
  const [x, y, w, h] = [Number(ref.x), Number(ref.y), Number(ref.width), Number(ref.height)];
  if (near.side === 'right') return { x: x + w + gap, y: y + (h - size.height) / 2 };
  if (near.side === 'left') return { x: x - gap - size.width, y: y + (h - size.height) / 2 };
  if (near.side === 'below') return { x: x + (w - size.width) / 2, y: y + h + gap };
  return { x: x + (w - size.width) / 2, y: y - gap - size.height };
}

function boxOf(e: Element): Box {
  return { x: Number(e.x), y: Number(e.y), width: Number(e.width), height: Number(e.height) };
}

function spills(label: Element, container: Element): boolean {
  const ratio = TEXT_RATIO[container.type] ?? 1;
  return Number(label.width) > Number(container.width) * ratio - 8 || Number(label.height) > Number(container.height) * ratio - 8;
}

function inside(a: Box, b: Box): boolean {
  return a.x >= b.x - 1 && a.y >= b.y - 1 && a.x + a.width <= b.x + b.width + 1 && a.y + a.height <= b.y + b.height + 1;
}

function crosses([px, py]: [number, number], [qx, qy]: [number, number], r: Box): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = qx - px;
  const dy = qy - py;
  for (const [d, v] of [
    [-dx, px - r.x],
    [dx, r.x + r.width - px],
    [-dy, py - r.y],
    [dy, r.y + r.height - py],
  ] as const) {
    if (d === 0) {
      if (v < 0) return false;
      continue;
    }
    const t = v / d;
    if (d < 0) {
      if (t > t1) return false;
      t0 = Math.max(t0, t);
    } else {
      if (t < t0) return false;
      t1 = Math.min(t1, t);
    }
  }
  return t0 <= t1;
}

export function check(live: Element[], focus?: Set<string>): string {
  const byId = new Map(live.map((e) => [e.id, e]));
  const hits = (...ids: string[]) => !focus || ids.some((id) => focus.has(id));
  const overflow: string[] = [];
  for (const t of live) {
    const c = t.type === 'text' && t.containerId ? byId.get(String(t.containerId)) : undefined;
    if (c && isContainer(c) && hits(c.id, t.id) && spills(t, c)) overflow.push(c.id);
  }
  for (const t of live) {
    const arrow = t.type === 'text' && t.containerId ? byId.get(String(t.containerId)) : undefined;
    const points = arrow?.type === 'arrow' ? absolutePoints(arrow) : [];
    if (!arrow || !points.length || points.length % 2 || !hits(arrow.id, t.id)) continue;
    const [[ax, ay], [bx, by]] = [points[points.length / 2 - 1]!, points[points.length / 2]!];
    const along = Math.abs(bx - ax) >= Math.abs(by - ay) ? Number(t.width) : Number(t.height);
    if (along + 32 > Math.hypot(bx - ax, by - ay)) overflow.push(`${arrow.id} label longer than its arrow`);
  }
  const solid = live.filter((e) => !e.containerId && !['arrow', 'line', 'freedraw', 'frame', 'image', 'selection'].includes(e.type));
  const overlaps: string[] = [];
  for (let i = 0; i < solid.length; i++) {
    for (let j = i + 1; j < solid.length; j++) {
      const [a, b] = [solid[i]!, solid[j]!];
      if (!hits(a.id, b.id)) continue;
      const [A, B] = [boxOf(a), boxOf(b)];
      const ix = Math.min(A.x + A.width, B.x + B.width) - Math.max(A.x, B.x);
      const iy = Math.min(A.y + A.height, B.y + B.height) - Math.max(A.y, B.y);
      if (ix > 2 && iy > 2 && !inside(A, B) && !inside(B, A)) overlaps.push(`${a.id}×${b.id}`);
    }
  }
  const crossings: string[] = [];
  for (const arrow of live) {
    if (arrow.type !== 'arrow' && arrow.type !== 'line') continue;
    const ends = new Set([(arrow.startBinding as { elementId?: string } | null)?.elementId, (arrow.endBinding as { elementId?: string } | null)?.elementId]);
    const points = absolutePoints(arrow);
    for (const shape of solid) {
      if (ends.has(shape.id) || !hits(arrow.id, shape.id)) continue;
      const box = boxOf(shape);
      const inset = shape.type === 'rectangle' || shape.type === 'text' ? 4 : Math.min(box.width, box.height) * 0.15;
      const r = { x: box.x + inset, y: box.y + inset, width: box.width - 2 * inset, height: box.height - 2 * inset };
      if (r.width <= 0 || r.height <= 0 || points.some(([x, y]) => inside({ x, y, width: 0, height: 0 }, r))) continue;
      if (points.slice(1).some((q, k) => crosses(points[k]!, q, r))) crossings.push(`${arrow.id}→${shape.id}`);
    }
  }
  const orphans: string[] = [];
  for (const e of live) {
    const refs = [e.type === 'text' ? e.containerId : null, (e.startBinding as { elementId?: string } | null)?.elementId, (e.endBinding as { elementId?: string } | null)?.elementId];
    for (const ref of refs) if (ref && !byId.has(String(ref)) && hits(e.id, String(ref))) orphans.push(`${e.id}→${ref}`);
  }
  const scope = focus ? ' Only what this call changed is checked; diagram_read checks the whole diagram.' : '';
  if (!overflow.length && !overlaps.length && !crossings.length && !orphans.length) return `Check: clean (no label overflow, overlaps, arrows through shapes or orphans).${scope}`;
  const list = (items: string[]) => (items.length ? ` (${items.slice(0, 6).join(', ')}${items.length > 6 ? ', …' : ''})` : '');
  const orphaned = orphans.length ? ` · ${orphans.length} orphan(s) pointing at a missing shape${list(orphans)}` : '';
  return `Check: ${overflow.length} label overflow${list(overflow)} · ${overlaps.length} overlap(s)${list(overlaps)} · ${crossings.length} arrow(s) through shapes${list(crossings)}${orphaned}. Fix with update (move/resize) or {op:"fit"}${orphans.length ? '; delete orphans or re-add their shape' : ''}.${scope}`;
}

function base(id: string, type: string, x: number, y: number, width: number, height: number, stroke: string | undefined, now: number): Element {
  return {
    id,
    type,
    x,
    y,
    width,
    height,
    angle: 0,
    strokeColor: color(stroke),
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: randomInt(2 ** 31),
    version: 1,
    versionNonce: nonce(),
    isDeleted: false,
    boundElements: null,
    updated: now,
    link: null,
    locked: false,
  };
}

function text(value: string, containerId: string | null): Record<string, unknown> {
  return {
    text: value,
    originalText: value,
    fontSize: 20,
    fontFamily: 5,
    textAlign: 'center',
    verticalAlign: 'middle',
    containerId,
    autoResize: true,
    lineHeight: 1.25,
  };
}

function textSize(value: string, fontSize = 20): { width: number; height: number } {
  const lines = value.split('\n');
  return { width: Math.ceil(Math.max(...lines.map((line) => line.length), 1) * fontSize * CHAR_EM), height: Math.ceil(lines.length * fontSize * LINE_HEIGHT) };
}

function fill(name: string): string {
  const key = name.toLowerCase();
  if (key === 'none' || key === 'transparent') return 'transparent';
  return FILLS[key] ?? (/^#[0-9a-f]{3,8}$/i.test(name) ? name : 'transparent');
}

function around(elements: Element[], pad: number): { x: number; y: number; width: number; height: number } {
  const x = Math.min(...elements.map((e) => Number(e.x))) - pad;
  const y = Math.min(...elements.map((e) => Number(e.y))) - pad;
  const right = Math.max(...elements.map((e) => Number(e.x) + Number(e.width))) + pad;
  const bottom = Math.max(...elements.map((e) => Number(e.y) + Number(e.height))) + pad;
  return { x, y, width: right - x, height: bottom - y };
}

// The tab re-measures text and normalises fields without a real edit, so only what a person would change counts.
function look(e: Element): string {
  const keys = e.type === 'text' ? ['text', 'containerId', 'frameId', 'strokeColor'] : ['x', 'y', 'width', 'height', 'angle', 'strokeColor', 'backgroundColor', 'frameId', 'points', 'fileId'];
  return JSON.stringify([!!e.isDeleted, ...keys.map((key) => e[key] ?? null)]);
}

function sizedFiles(files: unknown): { files: Record<string, unknown>; refused: string[] } {
  const kept: Record<string, unknown> = {};
  const refused: string[] = [];
  for (const [fileId, file] of Object.entries(files && typeof files === 'object' ? files : {})) {
    const data = (file as { dataURL?: unknown } | null)?.dataURL;
    if (typeof data !== 'string') continue;
    if (Math.floor(((data.length - data.indexOf(',') - 1) * 3) / 4) > MAX_FILE_BYTES) refused.push(fileId);
    else kept[fileId] = file;
  }
  return { files: kept, refused };
}

function tooBig(fileIds: string[]): string {
  return `image over 2 MB not saved (${fileIds.join(', ')}); the brain keeps files small, so shrink it and add it again`;
}

function center(e: Element): { x: number; y: number } {
  return { x: Number(e.x) + Number(e.width) / 2, y: Number(e.y) + Number(e.height) / 2 };
}

function edge(e: Element, toward: { x: number; y: number }): { x: number; y: number } {
  const c = center(e);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  const scale = Math.min(Math.abs(Number(e.width) / 2 / (dx || 1e-9)), Math.abs(Number(e.height) / 2 / (dy || 1e-9)));
  const length = Math.hypot(dx, dy) || 1;
  return { x: c.x + dx * scale + (dx / length) * 8, y: c.y + dy * scale + (dy / length) * 8 };
}

function color(name: string | undefined): string {
  if (!name) return COLORS.black!;
  return COLORS[name.toLowerCase()] ?? (/^#[0-9a-f]{3,8}$/i.test(name) ? name : COLORS.black!);
}

function nonce(): number {
  return randomInt(2 ** 31);
}

function newId(): string {
  return `hos-${randomInt(36 ** 8).toString(36)}`;
}

function slug(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'diagram'
  );
}

function board(elements: Element[], files: Record<string, unknown>): string {
  return `${JSON.stringify({ type: 'excalidraw', version: 2, source: 'hos', elements, appState: { viewBackgroundColor: '#ffffff' }, files }, null, 2)}\n`;
}

function boardOf(room: Room): string {
  return board(
    [...room.elements.values()].filter((e) => !e.isDeleted),
    room.files,
  );
}

function boardPath(id: string): string {
  return posix.join(DIAGRAMS_DIR, id, BOARD);
}

function parseMeta(id: string, text: string): { front: Meta; body: string; home?: string } {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  const raw = (parse(match?.[1] ?? '') ?? {}) as { title?: string; topic?: string; topics?: unknown; home?: string; chat?: string; naming?: boolean; created?: string };
  const topic = raw.home ?? raw.topic ?? (Array.isArray(raw.topics) ? String(raw.topics[0] ?? '') : '');
  return {
    front: { title: raw.title ?? id, topic, ...(raw.chat ? { chat: raw.chat } : {}), ...(raw.naming ? { naming: true } : {}), ...(raw.created ? { created: raw.created } : {}) },
    body: text.slice(match?.[0].length ?? 0),
    ...(raw.home ? { home: raw.home } : {}),
  };
}

function metaText(meta: Meta, body: string): string {
  const front = stringify({ title: meta.title, topic: meta.topic, ...(meta.naming ? { naming: true } : {}), created: meta.created }).trimEnd();
  return `---\n${front}\n---\n${body}`;
}

export function diagramReply(run: () => Promise<string>): Promise<BusReply> {
  return Promise.resolve().then(run).then(
    (text) => ({ outcome: 'ok' as const, text }),
    (error: Error) => ({ outcome: 'refused' as const, text: `Refused: ${error.message}` }),
  );
}
