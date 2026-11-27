import { place, type Fitted, type LayoutSpec, type NodeShape } from '../diagram-layout.js';
import { wrapLabel } from './kinds/common.js';
import { kindOf } from './spec.js';
import type { BlockLayout, Box, Spec } from './types.js';

const CHAR = 7.2;
const SUB_CHAR = 6.4;
const LINE = 17;
const PAD = 12;
// Card scale, not Excalidraw scale: boxes ~150 px wide inside a ~400 px card.
const SPACING = { 'elk.spacing.nodeNode': '28', 'elk.layered.spacing.nodeNodeBetweenLayers': '30', 'elk.spacing.edgeNode': '16', 'elk.spacing.edgeEdge': '12' };

function fit(shape: NodeShape, text: string): Fitted {
  const [label, sub] = text.split('\n');
  const lines = wrapLabel(label ?? '');
  const textW = Math.max(...lines.map((l) => l.length * CHAR), (sub ?? '').length * SUB_CHAR);
  const textH = lines.length * LINE + (sub ? 15 : 0);
  const diamond = shape === 'diamond';
  const width = Math.ceil(Math.min(diamond ? 220 : 190, Math.max(diamond ? 120 : 110, textW * (diamond ? 1.55 : 1) + 28)));
  const height = Math.ceil(Math.max(diamond ? 64 : 44, textH * (diamond ? 1.6 : 1) + 20));
  return { width, height, text, label: { width: textW, height: textH } };
}

const measure = (text: string) => ({ width: Math.ceil(text.length * SUB_CHAR), height: 14 });

function bounds(boxes: Box[], points: Array<[number, number]>): { minX: number; minY: number; w: number; h: number } {
  const xs = [...boxes.flatMap((b) => [b.x, b.x + b.w]), ...points.map((p) => p[0])];
  const ys = [...boxes.flatMap((b) => [b.y, b.y + b.h]), ...points.map((p) => p[1])];
  const minX = Math.min(...xs) - PAD;
  const minY = Math.min(...ys) - PAD;
  return { minX, minY, w: Math.ceil(Math.max(...xs) + PAD - minX), h: Math.ceil(Math.max(...ys) + PAD - minY) };
}

function labelAt(points: Array<[number, number]>): [number, number] {
  let best = 0;
  let at: [number, number] = points[0] ?? [0, 0];
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1]!;
    const [bx, by] = points[i]!;
    const len = Math.abs(bx - ax) + Math.abs(by - ay);
    if (i === 1 && len >= 40) return [(ax + bx) / 2, (ay + by) / 2];
    if (len > best) [best, at] = [len, [(ax + bx) / 2, (ay + by) / 2]];
  }
  return at;
}

async function layoutBlock(spec: LayoutSpec): Promise<BlockLayout> {
  const placed = await place(spec, fit, measure, SPACING);
  if (spec.kind === 'graph') {
    const boxes = placed.nodes.map((n) => ({ id: n.key.slice(2), x: n.x, y: n.y, w: n.fit.width, h: n.fit.height }));
    const arrows = placed.arrows.map((a) => ({ a, points: a.points.map((p): [number, number] => [p.x, p.y]) }));
    const b = bounds(boxes, arrows.flatMap((a) => a.points));
    const shift = (p: [number, number]): [number, number] => [Math.round(p[0] - b.minX), Math.round(p[1] - b.minY)];
    return {
      w: b.w,
      h: b.h,
      nodes: Object.fromEntries(boxes.map((n) => [n.id, { x: Math.round(n.x - b.minX), y: Math.round(n.y - b.minY), w: n.w, h: n.h }])),
      edges: arrows.map(({ a, points }) => {
        const shifted = points.map(shift);
        const [lx, ly] = labelAt(shifted);
        return { from: a.from!.slice(2), to: a.to!.slice(2), points: shifted, ...(a.label ? { label: a.label, lx: Math.round(lx), ly: Math.round(ly) } : {}) };
      }),
    };
  }
  const actors = placed.nodes.map((n) => ({ id: n.key.slice(2), x: n.x, y: n.y, w: n.fit.width, h: n.fit.height }));
  const messages = placed.arrows.filter((a) => !a.line);
  const b = bounds(actors, placed.arrows.flatMap((a) => a.points.map((p): [number, number] => [p.x, p.y])));
  return {
    w: b.w,
    h: b.h,
    actors: Object.fromEntries(actors.map((n) => [n.id, { x: Math.round(n.x - b.minX), y: Math.round(n.y - b.minY), w: n.w, h: n.h }])),
    messages: messages.map((m) => ({ y: Math.round(m.points[0]!.y - b.minY), x1: Math.round(m.points[0]!.x - b.minX), x2: Math.round(m.points.at(-1)!.x - b.minX) })),
  };
}

export async function layoutSpec(spec: Spec): Promise<Record<string, BlockLayout>> {
  const out: Record<string, BlockLayout> = {};
  for (const block of spec.blocks) {
    const graph = kindOf(block.kind)?.graph;
    if (graph) out[block.id] = await layoutBlock(graph(block));
  }
  return out;
}
