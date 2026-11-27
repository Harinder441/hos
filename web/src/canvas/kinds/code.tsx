import type { ReactNode } from 'react';
import type { Code as Block } from '../../../../src/canvas/kinds/code.js';
import type { BlockProps, BlockView } from '../types.js';

const TOKENS = /(\/\/.*$|#.*$|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`|\b(?:const|let|var|await|async|return|if|else|for|while|function|class|new|import|from|export|def|try|catch|throw)\b|\b\d+(?:\.\d+)?\b)/;

function highlight(line: string, lang: string | undefined): ReactNode[] {
  const parts = line.split(new RegExp(TOKENS.source, 'g'));
  return parts.map((part, i) => {
    if (i % 2 === 0 || !part) return part;
    if (part.startsWith('//') || (part.startsWith('#') && lang !== 'js' && lang !== 'ts')) return <span key={i} className="tk-c">{part}</span>;
    if (/^['"`]/.test(part)) return <span key={i} className="tk-s">{part}</span>;
    if (/^\d/.test(part)) return <span key={i} className="tk-n">{part}</span>;
    if (part.startsWith('#')) return part;
    return <span key={i} className="tk-k">{part}</span>;
  });
}

function CodeBlock({ block, view, setView, point }: BlockProps<Block>) {
  const lines = block.code.split('\n');
  const marks = block.lines ?? {};
  const on = view.l ? marks[String(view.l)] : undefined;
  const toggle = (n: number) => setView({ l: view.l === n ? undefined : n });
  return (
    <>
      <span className="cv-kick">Code{Object.keys(marks).length ? ' · tap a lit line' : ''}</span>
      {block.title && <h3>{block.title}</h3>}
      <div className="cv-code">
        {lines.map((text, i) => {
          const n = i + 1;
          const mark = marks[String(n)];
          return (
            <div
              key={n}
              className={`ln${mark ? ' hl' : ''}${view.l === n ? ' on' : ''}`}
              {...(mark
                ? {
                    role: 'button',
                    tabIndex: 0,
                    'aria-label': `Line ${n}: ${mark.note}`,
                    onClick: () => toggle(n),
                    onKeyDown: (e: React.KeyboardEvent) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        toggle(n);
                      }
                    },
                  }
                : {})}
            >
              <i>{n}</i>
              <span>{highlight(text, block.lang)}</span>
            </div>
          );
        })}
      </div>
      {on && (
        <div className="cv-detail">
          <div>
            <b>Line {view.l}</b> · {on.note}
          </div>
          {on.node && (
            <button type="button" className="cv-sbtn" style={{ marginLeft: 'auto', fontSize: '.8rem' }} onClick={() => point(on.node!)}>
              Show in the flow ↑
            </button>
          )}
        </div>
      )}
    </>
  );
}

export const code: BlockView = { label: 'code', Render: CodeBlock };
