import { useSyncExternalStore } from 'react';

const TICK_MS = 30_000;

function subscribe(onTick: () => void): () => void {
  const timer = setInterval(onTick, TICK_MS);
  return () => clearInterval(timer);
}

const tick = () => Math.floor(Date.now() / TICK_MS) * TICK_MS;

export function whenText(at: number, now: number): string {
  const days = Math.round((new Date(now).setHours(0, 0, 0, 0) - new Date(at).setHours(0, 0, 0, 0)) / 86_400_000);
  if (days > 0) return days === 1 ? '1 day ago' : `${days} days ago`;
  const time = new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  const ago = minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)} h ago`;
  return `${time} · ${ago}`;
}

export function When({ at, className = 'when' }: { at: number; className?: string }) {
  const now = useSyncExternalStore(subscribe, tick);
  return (
    <time className={className} dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString()}>
      {whenText(at, now)}
    </time>
  );
}
