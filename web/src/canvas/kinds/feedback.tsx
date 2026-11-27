import type { Feedback as Fb } from '../../../../src/canvas/types.js';
import { Md } from '../md.js';

export function Feedback({ fb, point }: { fb: Fb; point: (node: string) => void }) {
  return (
    <div className={`cv-fb ${fb.ok ? 'ok' : 'no'}`} role="status">
      <span>
        {fb.ok ? '✓ ' : '✗ '}
        <Md text={fb.note} />
      </span>
      {fb.node && (
        <button type="button" className="cv-go" onClick={() => point(fb.node!)}>
          Show me in the flow ↑
        </button>
      )}
    </div>
  );
}
