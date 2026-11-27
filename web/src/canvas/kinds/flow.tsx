import { wrapLabel } from '../../../../src/canvas/kinds/common.js';
import { stepNodes, type Flow as Block } from '../../../../src/canvas/kinds/flow.js';
import type { GraphLayout } from '../../../../src/canvas/types.js';
import { Md } from '../md.js';
import type { BlockProps, BlockView } from '../types.js';

function Node({ node, box, cls, onPick }: { node: Block['nodes'][number]; box: { x: number; y: number; w: number; h: number }; cls: string; onPick: () => void }) {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const lines = wrapLabel(node.label);
  const lift = node.sub ? 8 : 0;
  const shape =
    node.shape === 'diamond' ? (
      <path d={`M${cx} ${box.y} L${box.x + box.w} ${cy} L${cx} ${box.y + box.h} L${box.x} ${cy}Z`} />
    ) : node.shape === 'ellipse' ? (
      <ellipse cx={cx} cy={cy} rx={box.w / 2} ry={box.h / 2} />
    ) : (
      <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={10} />
    );
  return (
    <g
      className={`cv-fn ${cls}`}
      data-node={node.id}
      tabIndex={0}
      role="button"
      aria-label={`${node.label}${node.sub ? `, ${node.sub}` : ''}: details`}
      onClick={onPick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onPick();
        }
      }}
    >
      <g className="box">{shape}</g>
      <g className="halo">{shape}</g>
      {lines.map((l, i) => (
        <text key={i} className="lab" x={cx} y={cy - lift + (i - (lines.length - 1) / 2) * 16}>
          {l}
        </text>
      ))}
      {node.sub && (
        <text className="sub" x={cx} y={cy + 10 + (lines.length - 1) * 8}>
          {node.sub}
        </text>
      )}
    </g>
  );
}

function FlowBlock({ block, layout, view, setView, pointed }: BlockProps<Block>) {
  const g = layout as GraphLayout | undefined;
  if (!g) return <p className="cv-hint">Laying out…</p>;
  const steps = block.steps ?? [];
  const at = Math.min(view.s ?? 0, Math.max(0, steps.length - 1));
  const step = steps[at];
  const cur = new Set(step ? stepNodes(step) : []);
  const seen = new Set(steps.slice(0, at).flatMap(stepNodes));
  const lit = (id: string) => !steps.length || seen.has(id) || cur.has(id);
  const open = view.o ? block.nodes.find((n) => n.id === view.o) : undefined;
  const cls = (id: string) =>
    [pointed === id ? 'pointed' : cur.has(id) ? 'cur' : !steps.length || seen.has(id) ? 'seen' : 'future', view.o === id ? 'open' : ''].join(' ');
  const go = (d: number) => setView({ ...view, s: Math.max(0, Math.min(steps.length - 1, at + d)) });
  return (
    <>
      <span className="cv-kick">{steps.length ? `The flow · step ${at + 1} of ${steps.length}` : 'Diagram'}</span>
      {block.title && <h3>{block.title}</h3>}
      <figure className="cv-dia">
        <svg viewBox={`0 0 ${g.w} ${g.h}`} style={{ maxWidth: Math.max(g.w, 300), maxHeight: '58vh' }} role="img" aria-label={block.title ?? 'Flow diagram'}>
          <defs>
            <marker id="cv-fa" viewBox="0 0 10 10" refX={8} refY={5} markerWidth={7} markerHeight={7} orient="auto">
              <path d="M0 0L10 5L0 10z" fill="#3a4250" />
            </marker>
            <marker id="cv-fal" viewBox="0 0 10 10" refX={8} refY={5} markerWidth={7} markerHeight={7} orient="auto">
              <path d="M0 0L10 5L0 10z" fill="#7aa2f7" />
            </marker>
          </defs>
          {g.edges.map((e, i) => {
            const on = lit(e.from) && lit(e.to) && !!steps.length;
            return (
              <g key={i}>
                <path className={`cv-edge${on ? ' lit' : ''}`} d={`M${e.points.map((p) => p.join(' ')).join(' L')}`} markerEnd={`url(#cv-fa${on ? 'l' : ''})`} />
                {e.label && (
                  <text className={`cv-elab${on ? ' lit' : ''}`} x={e.lx} y={e.ly}>
                    {e.label}
                  </text>
                )}
              </g>
            );
          })}
          {block.nodes.map((node) =>
            g.nodes[node.id] ? <Node key={node.id} node={node} box={g.nodes[node.id]!} cls={cls(node.id)} onPick={() => setView({ ...view, o: view.o === node.id ? undefined : node.id })} /> : null,
          )}
        </svg>
        {step && (
          <figcaption className="cv-say" aria-live="polite">
            <Md text={step.say} />
          </figcaption>
        )}
      </figure>
      {steps.length > 1 && (
        <div className="cv-ctl">
          <button type="button" className="cv-sbtn" disabled={at === 0} aria-label="Previous step" title="Previous step" onClick={() => go(-1)}>
            ←
          </button>
          <span className="cv-dots" aria-hidden="true">
            {steps.map((_, k) => (
              <i key={k} className={k === at ? 'on' : k < at ? 'done' : ''} />
            ))}
          </span>
          <button type="button" className="cv-sbtn primary" disabled={at === steps.length - 1} onClick={() => go(1)}>
            Next →
          </button>
        </div>
      )}
      {open ? (
        <div className="cv-detail" role="note">
          <div>
            <b>{open.label}</b>
            {open.detail && (
              <>
                {' · '}
                <Md text={open.detail} />
              </>
            )}
          </div>
          <button type="button" aria-label="Close" title="Close step details" onClick={() => setView({ ...view, o: undefined })}>
            ×
          </button>
        </div>
      ) : (
        block.nodes.some((n) => n.detail) && <div className="cv-hint">Tap a box for more</div>
      )}
    </>
  );
}

export const flow: BlockView = { label: 'diagram', Render: FlowBlock };
