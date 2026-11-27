import { z } from 'zod';
import type { LayoutSpec } from '../../diagram-layout.js';
import type { Block, BlockKind } from '../types.js';
import { line, nodeId, prose } from './common.js';

type Edge = string | { from: string; to: string; label?: string };

export interface Flow extends Block {
  title?: string;
  dir?: 'TD' | 'LR';
  nodes: Array<{ id: string; label: string; sub?: string; shape?: 'rect' | 'diamond' | 'ellipse'; detail?: string }>;
  edges?: Edge[];
  steps?: Array<{ at: string | string[]; say: string }>;
}

const EDGE = /^([^>:\s]+)>([^>:\s]+)(?::(.+))?$/;

export function flowEdges(block: Flow): Array<{ from: string; to: string; label?: string }> {
  return (block.edges ?? []).map((edge) => {
    if (typeof edge !== 'string') return edge;
    const m = EDGE.exec(edge.trim())!;
    return { from: m[1]!, to: m[2]!, ...(m[3] ? { label: m[3].trim() } : {}) };
  });
}

export const stepNodes = (step: { at: string | string[] }): string[] => (Array.isArray(step.at) ? step.at : [step.at]);

export const flow: BlockKind<Flow> = {
  kind: 'flow',
  fields: z.strictObject({
    title: line.optional(),
    dir: z.enum(['TD', 'LR']).optional(),
    nodes: z
      .array(z.strictObject({ id: nodeId, label: z.string().trim().min(1).max(60), sub: z.string().trim().max(60).optional(), shape: z.enum(['rect', 'diamond', 'ellipse']).optional(), detail: prose.optional() }))
      .min(1)
      .max(24),
    edges: z.array(z.union([z.string().regex(EDGE, 'write an edge as "from>to" or "from>to:label"'), z.strictObject({ from: nodeId, to: nodeId, label: z.string().max(40).optional() })])).max(48).optional(),
    steps: z.array(z.strictObject({ at: z.union([nodeId, z.array(nodeId).min(1).max(6)]), say: prose })).max(24).optional(),
  }),
  check: (block) => {
    const ids = new Set<string>();
    for (const node of block.nodes) {
      if (ids.has(node.id)) return `nodes: id "${node.id}" is used twice`;
      ids.add(node.id);
    }
    for (const [i, edge] of flowEdges(block).entries()) for (const end of [edge.from, edge.to]) if (!ids.has(end)) return `edges[${i}]: no node "${end}"`;
    for (const [i, step] of (block.steps ?? []).entries()) for (const id of stepNodes(step)) if (!ids.has(id)) return `steps[${i}].at: no node "${id}"`;
    return null;
  },
  graph: (block): LayoutSpec => ({
    kind: 'graph',
    direction: block.dir ?? 'TD',
    nodes: block.nodes.map((node) => ({ id: node.id, label: node.sub ? `${node.label}\n${node.sub}` : node.label, shape: node.shape === 'diamond' ? 'diamond' : node.shape === 'ellipse' ? 'ellipse' : 'rectangle' })),
    edges: flowEdges(block),
  }),
  view: (block, view) => {
    const steps = block.steps?.length ?? 0;
    if (!view.s && !view.o) return null;
    return [block.id, steps ? `${(view.s ?? 0) + 1}/${steps}` : '', view.o ? `open ${view.o}` : ''].filter(Boolean).join(' ');
  },
  nodes: (block) => block.nodes.map((node) => node.id),
};
