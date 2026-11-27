export type Signal = 'go' | 'needs' | 'yield' | 'stop' | 'queued' | 'rest';

export const SIGNAL_TITLES: Record<Signal, string> = {
  go: 'working',
  needs: 'needs you',
  yield: 'handing off',
  stop: 'stopped',
  queued: 'waiting for a running chat to finish',
  rest: 'at rest',
};

const OCTAGON = '5.4,1.7 10.6,1.7 14.3,5.4 14.3,10.6 10.6,14.3 5.4,14.3 1.7,10.6 1.7,5.4';

function Shape({ signal }: { signal: Signal }) {
  switch (signal) {
    case 'go':
      return <circle cx="8" cy="8" r="6.25" />;
    case 'needs':
      return <path d="M8 1.2 14.8 8 8 14.8 1.2 8Z" />;
    case 'yield':
      return <path d="M2 3.2h12L8 13.6Z" />;
    case 'stop':
      return <polygon points={OCTAGON} />;
    case 'queued':
      return <circle cx="8" cy="8" r="5.5" />;
    case 'rest':
      return <rect x="2.5" y="6.75" width="11" height="2.5" rx="1" />;
  }
}

export function Mark({ signal, title }: { signal: Signal; title?: string }) {
  return (
    <span className={`mark ${signal}`} title={title ?? SIGNAL_TITLES[signal]} aria-hidden="true">
      <svg viewBox="0 0 16 16" focusable="false">
        <Shape signal={signal} />
      </svg>
    </span>
  );
}
