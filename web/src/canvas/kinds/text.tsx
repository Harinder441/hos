import type { Text as Block } from '../../../../src/canvas/kinds/text.js';
import { Md } from '../md.js';
import type { BlockProps, BlockView } from '../types.js';
import { Feedback } from './feedback.js';

function TextBlock({ block, answer, setAnswer, locked, fb, point, q }: BlockProps<Block>) {
  return (
    <>
      <span className="cv-kick">{q ? `Check · ${q.k} of ${q.n}` : 'Your answer'}</span>
      <label className="prompt" htmlFor={`cv-${block.id}`}>
        <Md text={block.prompt} />
      </label>
      <textarea id={`cv-${block.id}`} value={typeof answer === 'string' ? answer : ''} disabled={locked} maxLength={2000} placeholder="Your answer" onChange={(e) => setAnswer(e.target.value)} />
      {fb && <Feedback fb={fb} point={point} />}
    </>
  );
}

export const text: BlockView = { label: 'question', Render: TextBlock };
