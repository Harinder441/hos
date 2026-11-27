import ELK, { type ElkExtendedEdge, type ElkNode } from 'elkjs/lib/elk.bundled.js';

export type NodeShape = 'rectangle' | 'ellipse' | 'diamond' | 'note';

export interface LayoutSpec {
  kind: 'graph' | 'sequence';
  direction?: 'LR' | 'TD';
  title?: string;
  nodes?: Array<{ id: string; label: string; shape?: NodeShape; group?: string; color?: string; fill?: string; focal?: boolean }>;
  groups?: Array<{ id: string; label: string }>;
  edges?: Array<{ from: string; to: string; label?: string; dashed?: boolean }>;
  actors?: Array<{ id: string; label: string; color?: string; fill?: string }>;
  messages?: Array<{ from: string; to: string; label?: string; reply?: boolean }>;
}

export interface Fitted {
  width: number;
  height: number;
  text: string;
  label: { width: number; height: number };
}

type Point = { x: number; y: number };

export interface PlacedNode {
  key: string;
  shape: NodeShape;
  x: number;
  y: number;
  fit: Fitted;
  raw: string;
  group?: string;
  color?: string;
  fill?: string;
  focal?: boolean;
}

export interface PlacedArrow {
  key: string;
  line: boolean;
  points: Point[];
  from?: string;
  to?: string;
  label?: string;
  dashed?: boolean;
  color?: string;
}

export interface Placed {
  nodes: PlacedNode[];
  groups: Array<{ key: string; x: number; y: number; width: number; height: number; label: string }>;
  arrows: PlacedArrow[];
  title?: { x: number; y: number; text: string };
}

const TITLE_SPACE = 70;
const ACTOR_GAP = 80;
const MESSAGE_STEP = 70;
// Excalidraw wraps an arrow label wider than 70% of the arrow (ARROW_LABEL_WIDTH_FRACTION).
const ARROW_LABEL_SHARE = 0.7;

export function validate(spec: LayoutSpec): void {
  if (spec.kind === 'graph') {
    const ids = new Set<string>();
    for (const node of spec.nodes ?? []) {
      if (ids.has(node.id)) throw new Error(`node id "${node.id}" is used twice`);
      ids.add(node.id);
    }
    if (!ids.size) throw new Error('a graph needs at least one node');
    const groups = new Set((spec.groups ?? []).map((g) => g.id));
    for (const node of spec.nodes ?? []) if (node.group && !groups.has(node.group)) throw new Error(`node "${node.id}" is in group "${node.group}", which isn't in groups`);
    for (const edge of spec.edges ?? []) for (const end of [edge.from, edge.to]) if (!ids.has(end)) throw new Error(`edge ${edge.from}→${edge.to}: no node "${end}"`);
    return;
  }
  const actors = new Set((spec.actors ?? []).map((a) => a.id));
  if (!actors.size) throw new Error('a sequence needs at least one actor');
  if (actors.size !== (spec.actors ?? []).length) throw new Error('actor ids must be unique');
  for (const message of spec.messages ?? []) for (const end of [message.from, message.to]) if (!actors.has(end)) throw new Error(`message ${message.from}→${message.to}: no actor "${end}"`);
}

export async function place(
  spec: LayoutSpec,
  fit: (shape: NodeShape, text: string) => Fitted,
  measure: (text: string) => { width: number; height: number },
  spacing: Record<string, string> = {},
): Promise<Placed> {
  const placed = spec.kind === 'graph' ? await graph(spec, fit, measure, spacing) : sequence(spec, fit, measure);
  if (!spec.title) return placed;
  for (const node of placed.nodes) node.y += TITLE_SPACE;
  for (const group of placed.groups) group.y += TITLE_SPACE;
  for (const arrow of placed.arrows) for (const point of arrow.points) point.y += TITLE_SPACE;
  return { ...placed, title: { x: 0, y: 0, text: spec.title } };
}

async function graph(
  spec: LayoutSpec,
  fit: (shape: NodeShape, text: string) => Fitted,
  measure: (text: string) => { width: number; height: number },
  spacing: Record<string, string>,
): Promise<Placed> {
  const nodes = spec.nodes ?? [];
  const fitted = new Map(nodes.map((node) => [node.id, fit(node.shape ?? 'rectangle', node.label)]));
  const leaf = (node: (typeof nodes)[number]): ElkNode => ({ id: `n:${node.id}`, width: fitted.get(node.id)!.width, height: fitted.get(node.id)!.height });
  const root: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': spec.direction === 'TD' ? 'DOWN' : 'RIGHT',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.spacing.nodeNode': '60',
      'elk.layered.spacing.nodeNodeBetweenLayers': '100',
      'elk.spacing.edgeNode': '30',
      'elk.spacing.edgeEdge': '20',
      'elk.spacing.edgeLabel': '8',
      'elk.edgeLabels.placement': 'CENTER',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      ...spacing,
    },
    children: [
      ...nodes.filter((node) => !node.group).map(leaf),
      ...(spec.groups ?? []).map((group) => ({
        id: `g:${group.id}`,
        layoutOptions: { 'elk.padding': '[top=50,left=30,bottom=30,right=30]' },
        children: nodes.filter((node) => node.group === group.id).map(leaf),
      })),
    ],
    edges: (spec.edges ?? []).map((edge, i): ElkExtendedEdge => {
      const size = edge.label ? measure(edge.label) : null;
      return { id: `e:${i}`, sources: [`n:${edge.from}`], targets: [`n:${edge.to}`], ...(edge.label && size ? { labels: [{ text: edge.label, width: size.width + 12, height: size.height + 6 }] } : {}) };
    }),
  };
  const out = await new ELK.default().layout(root);
  const at = new Map<string, Point & { width: number; height: number }>();
  const walk = (node: ElkNode, ox: number, oy: number) => {
    for (const child of node.children ?? []) {
      const x = ox + (child.x ?? 0);
      const y = oy + (child.y ?? 0);
      at.set(child.id, { x, y, width: child.width ?? 0, height: child.height ?? 0 });
      walk(child, x, y);
    }
  };
  walk(out, 0, 0);
  return {
    nodes: nodes.map((node) => {
      const box = at.get(`n:${node.id}`)!;
      return {
        key: `n-${node.id}`,
        shape: node.shape ?? 'rectangle',
        x: box.x,
        y: box.y,
        fit: fitted.get(node.id)!,
        raw: node.label,
        ...(node.group ? { group: `g-${node.group}` } : {}),
        ...(node.color ? { color: node.color } : {}),
        ...(node.fill ? { fill: node.fill } : {}),
        ...(node.focal ? { focal: true } : {}),
      };
    }),
    groups: (spec.groups ?? []).map((group) => ({ key: `g-${group.id}`, ...at.get(`g:${group.id}`)!, label: group.label })),
    arrows: (out.edges ?? []).map((edge, i) => {
      const source = (spec.edges ?? [])[i]!;
      const container = (edge as ElkExtendedEdge & { container?: string }).container;
      const offset = container && container !== 'root' ? at.get(container)! : { x: 0, y: 0 };
      const section = edge.sections?.[0];
      const points = section ? [section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map((p) => ({ x: p.x + offset.x, y: p.y + offset.y })) : [];
      return {
        key: `e-${source.from}-${source.to}-${i}`,
        line: false,
        points,
        from: `n-${source.from}`,
        to: `n-${source.to}`,
        ...(source.label ? { label: source.label } : {}),
        ...(source.dashed ? { dashed: true } : {}),
      };
    }),
  };
}

function sequence(spec: LayoutSpec, fit: (shape: NodeShape, text: string) => Fitted, measure: (text: string) => { width: number; height: number }): Placed {
  const actors = spec.actors ?? [];
  const messages = spec.messages ?? [];
  const index = new Map(actors.map((actor, i) => [actor.id, i]));
  const boxes = actors.map((actor) => fit('rectangle', actor.label));
  const widths = messages.map((m) => (m.label ? measure(m.label).width / ARROW_LABEL_SHARE + 20 : 60));
  const centres: number[] = [];
  boxes.forEach((box, k) => {
    if (k === 0) {
      centres.push(box.width / 2);
      return;
    }
    let cx = centres[k - 1]! + boxes[k - 1]!.width / 2 + ACTOR_GAP + box.width / 2;
    messages.forEach((m, i) => {
      const [a, b] = [index.get(m.from)!, index.get(m.to)!];
      if (a === b && a === k - 1) cx = Math.max(cx, centres[a]! + widths[i]! + 40);
      else if (Math.max(a, b) === k && Math.min(a, b) < k) cx = Math.max(cx, centres[Math.min(a, b)]! + widths[i]!);
    });
    centres.push(cx);
  });
  const top = Math.max(...boxes.map((box) => box.height));
  const arrows: PlacedArrow[] = [];
  let y = top + 60;
  messages.forEach((m, i) => {
    const [a, b] = [index.get(m.from)!, index.get(m.to)!];
    const label = m.label ? measure(m.label) : { width: 0, height: 0 };
    y += label.height;
    const x = centres[a]!;
    const loop = Math.max(60, label.width / 2 + 30);
    const drop = a === b ? label.height * 2 + 40 : 0;
    const points =
      a === b
        ? [
            { x, y },
            { x: x + loop, y },
            { x: x + loop, y: y + drop },
            { x, y: y + drop },
          ]
        : [
            { x, y },
            { x: centres[b]!, y },
          ];
    arrows.push({ key: `m-${i}`, line: false, points, ...(m.label ? { label: m.label } : {}), ...(m.reply ? { dashed: true } : {}) });
    y += drop + MESSAGE_STEP - 20;
  });
  const bottom = y + 20;
  actors.forEach((actor, k) => {
    arrows.push({
      key: `a-${actor.id}-life`,
      line: true,
      points: [
        { x: centres[k]!, y: top },
        { x: centres[k]!, y: bottom },
      ],
      dashed: true,
      color: 'grey',
    });
  });
  return {
    nodes: actors.map((actor, k) => ({
      key: `a-${actor.id}`,
      shape: 'rectangle',
      x: centres[k]! - boxes[k]!.width / 2,
      y: top - boxes[k]!.height,
      fit: boxes[k]!,
      raw: actor.label,
      ...(actor.color ? { color: actor.color } : {}),
      ...(actor.fill ? { fill: actor.fill } : {}),
    })),
    groups: [],
    arrows,
  };
}
