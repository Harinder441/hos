import type { Story as Block } from '../../../../src/canvas/kinds/story.js';
import { Art } from '../art.js';
import { Md } from '../md.js';
import type { BlockProps, BlockView } from '../types.js';

export const story: BlockView = {
  label: 'story',
  Render: ({ block, view, setView }: BlockProps<Block>) => (
    <>
      <span className="cv-kick">Story · {block.cards.length} cards</span>
      <div className="cv-story">
        {block.cards.map((card, i) => (
          <button key={i} type="button" className="cv-scard" aria-current={(view.c ?? 0) === i} onClick={() => setView({ c: i })}>
            <Art art={card.art} label={card.title} />
            <span className="n">{i + 1}</span>
            <b>{card.title}</b>
            {card.text && (
              <span>
                <Md text={card.text} />
              </span>
            )}
          </button>
        ))}
      </div>
    </>
  ),
};
