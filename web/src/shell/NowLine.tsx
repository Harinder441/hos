import { useEffect, useState } from 'react';
import type { NowBlocks, TimeBlock } from '../../../src/api/types.js';
import { client } from '../lib.js';
import { useSources } from '../sources.js';

const POLL_MS = 60_000;

type Now = NonNullable<NowBlocks['now']>;

function useNow(enabled: boolean): Now | null {
  const [now, setNow] = useState<Now | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const load = () =>
      client.myNow().then(
        (next) => live && setNow(next.now),
        () => live && setNow(null),
      );
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [enabled]);
  return now;
}

function duration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function length(block: TimeBlock): number {
  const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const span = (mins(block.end) - mins(block.start) + 1440) % 1440;
  return span || 1440;
}

function describe(block: TimeBlock): string {
  return `${block.emoji} ${block.label} ${block.start}–${block.end}`.trim();
}

function hover(now: Now): string {
  return [
    now.prev && `prev ${describe(now.prev)}`,
    `now ${now.current ? describe(now.current) : 'Free time'}`,
    now.next && `next ${describe(now.next)}`,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function NowLine({ variant }: { variant: 'side' | 'home' }) {
  const calendar = useSources()?.calendar;
  const now = useNow(!!calendar?.now);
  if (!calendar?.now || !now) return null;
  const { current, next } = now;
  const elapsed = current && now.minutesLeft !== null ? Math.min(1, Math.max(0, 1 - now.minutesLeft / length(current))) : null;
  const rest = current
    ? [now.minutesLeft !== null && `${duration(now.minutesLeft)} left`, next && `next ${next.emoji} ${next.start}`].filter(Boolean).join(' · ')
    : next
      ? `next ${next.emoji} ${next.label} ${next.start}`
      : '';
  return (
    <a className={`tt tt-${variant}`} {...(calendar.link ? { href: calendar.link, target: '_blank', rel: 'noreferrer' } : {})} title={hover(now)}>
      <span className="tt-now">
        <span className="tt-emoji" aria-hidden="true">
          {current ? current.emoji : '🕊️'}
        </span>
        <span className="tt-label">{current ? current.label : 'Free time'}</span>
      </span>
      {(elapsed !== null || rest) && (
        <span className="tt-sub">
          {elapsed !== null && (
            <span className="tt-bar" aria-hidden="true">
              <i style={{ width: `${Math.round(elapsed * 100)}%` }} />
            </span>
          )}
          {rest && <span className="tt-rest">{rest}</span>}
        </span>
      )}
    </a>
  );
}
