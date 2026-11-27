import type { ReactNode } from 'react';
import { ART_LINK } from '../../../src/canvas/kinds/story.js';

const AC = '#7aa2f7';
const OK = '#9ece6a';
const BAD = '#f7768e';
const WARM = '#e0af68';
const BG = '#1b2030';

type Pic = (x: number) => ReactNode;

const PICS: Record<string, Pic> = {
  phone: (x) => (
    <g>
      <rect x={x} y={22} width={58} height={96} rx={10} fill={BG} stroke={AC} strokeWidth={1.5} />
      <rect x={x + 8} y={34} width={42} height={58} rx={4} fill="#11141a" />
      <circle cx={x + 29} cy={106} r={4} fill={AC} />
    </g>
  ),
  browser: (x) => (
    <g>
      <rect x={x - 6} y={30} width={70} height={76} rx={6} fill={BG} stroke={AC} strokeWidth={1.5} />
      <line x1={x - 6} y1={44} x2={x + 64} y2={44} stroke={AC} strokeWidth={1.5} />
      <circle cx={x + 2} cy={37} r={2.5} fill={BAD} />
      <circle cx={x + 10} cy={37} r={2.5} fill={WARM} />
      <circle cx={x + 18} cy={37} r={2.5} fill={OK} />
    </g>
  ),
  server: (x) => (
    <g>
      {[34, 60, 86].map((y) => (
        <g key={y}>
          <rect x={x} y={y} width={58} height={22} rx={4} fill={BG} stroke={OK} strokeWidth={1.5} />
          <circle cx={x + 10} cy={y + 11} r={2.5} fill={OK} />
        </g>
      ))}
    </g>
  ),
  db: (x) => (
    <g fill={BG} stroke={OK} strokeWidth={1.5}>
      <path d={`M${x} 38 v56 a29 9 0 0 0 58 0 v-56`} />
      <ellipse cx={x + 29} cy={38} rx={29} ry={9} />
      <path d={`M${x} 66 a29 9 0 0 0 58 0`} fill="none" />
    </g>
  ),
  store: (x) => (
    <g stroke={WARM} strokeWidth={1.5} fill={BG}>
      <rect x={x} y={56} width={58} height={56} rx={3} />
      <path d={`M${x - 4} 56 l8 -22 h50 l8 22 z`} />
      <rect x={x + 20} y={80} width={18} height={32} fill="#11141a" />
    </g>
  ),
  card: (x) => (
    <g>
      <rect x={x - 8} y={42} width={74} height={48} rx={6} fill={BG} stroke={AC} strokeWidth={1.5} />
      <rect x={x - 8} y={52} width={74} height={9} fill={AC} />
      <rect x={x} y={72} width={22} height={8} rx={2} fill={WARM} />
    </g>
  ),
  money: (x) => (
    <g>
      <rect x={x - 8} y={44} width={74} height={44} rx={5} fill="rgb(158 206 106 / .12)" stroke={OK} strokeWidth={1.5} />
      <text x={x + 29} y={67} fontSize={18} fill={OK} textAnchor="middle" dominantBaseline="central" fontFamily="system-ui" fontWeight={700}>
        ₹
      </text>
    </g>
  ),
  cloud: (x) => <path d={`M${x - 2} 92 a16 16 0 0 1 4 -31 a22 22 0 0 1 42 -6 a17 17 0 0 1 16 37 z`} fill={BG} stroke={AC} strokeWidth={1.5} />,
  person: (x) => (
    <g fill={BG} stroke={WARM} strokeWidth={1.5}>
      <circle cx={x + 29} cy={44} r={14} />
      <path d={`M${x + 3} 110 a26 28 0 0 1 52 0 z`} />
    </g>
  ),
  lock: (x) => (
    <g fill={BG} stroke={WARM} strokeWidth={1.5}>
      <path d={`M${x + 14} 64 v-12 a15 15 0 0 1 30 0 v12`} fill="none" strokeWidth={3} />
      <rect x={x + 4} y={64} width={50} height={40} rx={6} />
    </g>
  ),
  clock: (x) => (
    <g stroke={AC} strokeWidth={1.5}>
      <circle cx={x + 29} cy={70} r={30} fill={BG} />
      <path d={`M${x + 29} 52 v18 h14`} fill="none" strokeWidth={2.5} />
    </g>
  ),
  queue: (x) => (
    <g fill={BG} stroke={AC} strokeWidth={1.5}>
      {[0, 1, 2].map((i) => (
        <rect key={i} x={x - 8 + i * 26} y={56} width={20} height={28} rx={3} />
      ))}
    </g>
  ),
  warning: (x) => (
    <g>
      <path d={`M${x + 29} 34 l32 60 h-64 z`} fill="rgb(247 118 142 / .12)" stroke={BAD} strokeWidth={1.5} />
      <text x={x + 29} y={78} fontSize={22} fill={BAD} textAnchor="middle" dominantBaseline="central" fontWeight={800}>
        !
      </text>
    </g>
  ),
  check: (x) => (
    <g>
      <circle cx={x + 29} cy={70} r={30} fill="rgb(158 206 106 / .12)" stroke={OK} strokeWidth={1.5} />
      <path d={`M${x + 15} 70 l10 10 l20 -22`} fill="none" stroke={OK} strokeWidth={3} />
    </g>
  ),
};

function arrow(kind: string): ReactNode {
  const lost = kind.includes('~');
  const back = kind.startsWith('<');
  const color = lost ? BAD : AC;
  const [x1, x2] = back ? [196, 92] : [92, 196];
  return (
    <g>
      <line x1={x1} y1={68} x2={x2} y2={68} stroke={color} strokeWidth={2} strokeDasharray={lost ? '5 4' : undefined} markerEnd={`url(#cv-ah-${lost ? 'bad' : 'ac'})`} />
      {lost && (
        <text x={144} y={92} fontSize={16} textAnchor="middle">
          ⚡
        </text>
      )}
    </g>
  );
}

export function Art({ art, label }: { art: string; label: string }) {
  const m = ART_LINK.exec(art);
  const [a, link, b] = m ? [m[1]!, m[2], m[3]] : [art, undefined, undefined];
  const pic = (name: string | undefined, x: number) => (name && PICS[name] ? PICS[name]!(x) : null);
  return (
    <svg viewBox="0 0 290 136" role="img" aria-label={label}>
      <defs>
        {[
          ['ac', AC],
          ['bad', BAD],
        ].map(([id, c]) => (
          <marker key={id} id={`cv-ah-${id}`} viewBox="0 0 10 10" refX={8} refY={5} markerWidth={6} markerHeight={6} orient="auto-start-reverse">
            <path d="M0 0L10 5L0 10z" fill={c} />
          </marker>
        ))}
      </defs>
      {b ? (
        <>
          {pic(a, 24)}
          {arrow(link!)}
          {pic(b, 206)}
        </>
      ) : (
        pic(a, 116)
      )}
    </svg>
  );
}
