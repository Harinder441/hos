import type { Callout as Block } from '../../../../src/canvas/kinds/callout.js';
import { Md } from '../md.js';
import type { BlockView } from '../types.js';

export const callout: BlockView = {
  label: 'note',
  Render: ({ block }: { block: Block }) => {
    const tone = block.tone ?? 'key';
    return (
      <div className={`cv-callout cv-tone-${tone}`}>
        <span className="ico" aria-hidden="true">
          {tone === 'analogy' ? '≈' : '!'}
        </span>
        <div>
          {tone !== 'analogy' && (
            <>
              <span className="cv-kick" style={{ color: tone === 'warn' ? 'var(--bad)' : 'var(--ac)' }}>
                {tone === 'warn' ? 'Watch out' : 'Key idea'}
              </span>
              <br />
            </>
          )}
          <Md text={block.text} />
        </div>
      </div>
    );
  },
};
