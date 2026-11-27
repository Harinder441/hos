import type { Choice as Block } from '../../../../src/canvas/kinds/choice.js';
import { Md } from '../md.js';
import type { BlockProps, BlockView } from '../types.js';
import { Feedback } from './feedback.js';

function ChoiceBlock({ block, answer, setAnswer, locked, fb, point, q }: BlockProps<Block>) {
  const marked = locked && fb !== undefined && block.answer !== undefined;
  return (
    <>
      <span className="cv-kick">{q ? `Check · ${q.k} of ${q.n}` : 'Check'}</span>
      <div className="prompt">
        <Md text={block.prompt} />
      </div>
      <div className="cv-opts" role="group" aria-label={block.prompt.replace(/[*`]/g, '')}>
        {block.options.map((option, i) => {
          const mark = marked ? (i === block.answer ? ' right' : answer === i ? ' wrong' : '') : '';
          return (
            <button key={i} type="button" className={`cv-opt${mark}`} aria-pressed={answer === i} disabled={locked} onClick={() => setAnswer(i)}>
              <kbd>{String.fromCharCode(65 + i)}</kbd>
              <span>{option}</span>
            </button>
          );
        })}
      </div>
      {fb && <Feedback fb={fb} point={point} />}
    </>
  );
}

export const choice: BlockView = { label: 'question', Render: ChoiceBlock };
