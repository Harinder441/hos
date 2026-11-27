import { useEffect, useRef, useState } from 'react';
import type { Chat } from '../../../src/api/types.js';
import { client, errorText } from '../lib.js';
import { useComputers } from '../model/computers.js';
import { Icon } from '../shell/icons.js';

type Busy = 'loading' | 'refreshing' | null;

export type RemoteHistory = { computer: string; busy: Busy; error?: string; paused: boolean; refresh: () => Promise<void> };

export function useRemoteHistory(chats: Chat[]): RemoteHistory | undefined {
  const stubs = chats.filter((chat) => chat.computer);
  const computer = stubs.at(-1)?.computer;
  const { view, reload } = useComputers(!!computer);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string>();
  const run = useRef(0);
  const refreshing = useRef(false);
  const key = stubs.map((chat) => chat.id).join();
  const load = async (kind: Exclude<Busy, null>, before?: () => Promise<unknown>) => {
    if (!stubs.length) return;
    const mine = ++run.current;
    setBusy(kind);
    setError(undefined);
    try {
      await before?.();
      for (const chat of stubs) await client.loadChat(chat.id);
    } catch (e) {
      if (mine === run.current) setError(errorText(e));
    } finally {
      if (mine === run.current) setBusy(null);
    }
  };
  useEffect(() => void load('loading'), [key]);
  const remote = view?.computers.find((c) => c.name === computer && c.direction === 'out');
  const paused = !!computer && !!view && !(remote?.online && remote.connected);
  const wasPaused = useRef(paused);
  useEffect(() => {
    if (wasPaused.current && !paused && !refreshing.current) void load('loading');
    wasPaused.current = paused;
  }, [paused]);
  if (!computer) return undefined;
  const refresh = async () => {
    if (busy || refreshing.current) return;
    refreshing.current = true;
    try {
      await load('refreshing', () => reload(true));
    } finally {
      refreshing.current = false;
    }
  };
  return { computer, busy, error, paused, refresh };
}

export function RemoteRefresh({ history }: { history: RemoteHistory }) {
  const busy = !!history.busy;
  return (
    <button
      type="button"
      className={`icon-btn remote-refresh${busy ? ' busy' : ''}`}
      aria-label={`Refresh from ${history.computer}`}
      title={`Refresh from ${history.computer}`}
      disabled={busy}
      aria-busy={busy || undefined}
      onClick={() => void history.refresh()}
    >
      <Icon id="i-sync" />
    </button>
  );
}

export function RemoteLine({ history }: { history: RemoteHistory }) {
  if (history.busy) {
    return (
      <p className="remote-line" role="status">
        {history.busy === 'refreshing' ? 'Refreshing…' : 'Loading history…'}
      </p>
    );
  }
  if (history.paused) {
    return (
      <p className="remote-line" role="status">
        Live updates paused
      </p>
    );
  }
  if (history.error) {
    return (
      <p className="remote-line bad" role="alert">
        {history.error}
      </p>
    );
  }
  return null;
}
