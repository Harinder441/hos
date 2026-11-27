import type { Compare as Block } from '../../../../src/canvas/kinds/compare.js';
import type { BlockProps, BlockView } from '../types.js';

export const compare: BlockView = {
  label: 'compare',
  Render: ({ block }: BlockProps<Block>) => (
    <>
      <span className="cv-kick">Compare</span>
      {block.title && <h3>{block.title}</h3>}
      <div className="cv-cmp">
        <table>
          <thead>
            <tr>
              {block.columns.map((c, i) => (
                <th key={i} scope="col">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, r) => (
              <tr key={r}>
                <th scope="row">{row[0]}</th>
                {row.slice(1).map((cell, i) => (
                  <td key={i} className={block.win === undefined ? '' : i + 1 === block.win ? 'win' : 'lose'}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  ),
};
