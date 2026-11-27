import type { Sequence as Block } from '../../../../src/canvas/kinds/sequence.js';
import type { SequenceLayout } from '../../../../src/canvas/types.js';
import { Md } from '../md.js';
import type { BlockProps, BlockView } from '../types.js';

function SequenceBlock({ block, layout, view, setView }: BlockProps<Block>) {
  const s = layout as SequenceLayout | undefined;
  if (!s) return <p className="cv-hint">Laying out…</p>;
  const at = Math.min(view.s ?? 0, block.messages.length - 1);
  const say = block.messages[at]?.say;
  const go = (d: number) => setView({ s: Math.max(0, Math.min(block.messages.length - 1, at + d)) });
  return (
    <>
      <span className="cv-kick">
        Timeline · message {at + 1} of {block.messages.length}
      </span>
      {block.title && <h3>{block.title}</h3>}
      <figure className="cv-dia">
        <svg viewBox={`0 0 ${s.w} ${s.h}`} style={{ maxWidth: Math.max(s.w, 300) }} role="img" aria-label={block.title ?? 'Timeline'}>
          <defs>
            {[
              ['sa', '#7aa2f7'],
              ['sd', '#3a4250'],
              ['sl', '#f7768e'],
            ].map(([id, c]) => (
              <marker key={id} id={`cv-${id}`} viewBox="0 0 10 10" refX={8} refY={5} markerWidth={7} markerHeight={7} orient="auto">
                <path d="M0 0L10 5L0 10z" fill={c} />
              </marker>
            ))}
          </defs>
          {block.actors.map((a) => {
            const box = s.actors[a.id]!;
            const cx = box.x + box.w / 2;
            return (
              <g key={a.id}>
                <line className="cv-lane" x1={cx} y1={box.y + box.h} x2={cx} y2={s.h - 6} />
                <g className="cv-actor">
                  <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={8} />
                  <text x={cx} y={box.y + box.h / 2}>
                    {a.label}
                  </text>
                </g>
              </g>
            );
          })}
          {block.messages.map((m, i) => {
            const p = s.messages[i];
            if (!p) return null;
            const marker = m.lost ? 'sl' : i === at ? 'sa' : 'sd';
            const self = p.x1 === p.x2;
            const dir = Math.sign(p.x2 - p.x1);
            return (
              <g key={i} className={`cv-msg${i > at ? ' future' : i === at ? ' cur' : ''}${m.lost ? ' lost' : ''}`}>
                {self ? (
                  <path d={`M${p.x1} ${p.y} h40 v24 h-36`} markerEnd={`url(#cv-${marker})`} />
                ) : (
                  <line x1={p.x1} y1={p.y} x2={p.x2 - dir * 4} y2={p.y} markerEnd={`url(#cv-${marker})`} />
                )}
                {m.label && (
                  <text x={self ? p.x1 + 44 : (p.x1 + p.x2) / 2} y={p.y - 7} style={self ? { textAnchor: 'start' } : undefined}>
                    {m.label}
                    {m.lost ? ' ⚡' : ''}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        {say && (
          <figcaption className="cv-say" aria-live="polite">
            <Md text={say} />
          </figcaption>
        )}
      </figure>
      {block.messages.length > 1 && (
        <div className="cv-ctl">
          <button type="button" className="cv-sbtn" disabled={at === 0} aria-label="Previous message" title="Previous message" onClick={() => go(-1)}>
            ←
          </button>
          <button type="button" className="cv-sbtn primary" disabled={at === block.messages.length - 1} onClick={() => go(1)}>
            Next →
          </button>
        </div>
      )}
    </>
  );
}

export const sequence: BlockView = { label: 'timeline', Render: SequenceBlock };
