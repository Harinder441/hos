import { useEffect, useState } from 'react';
import type { ComputersView } from '../../../src/api/types.js';
import { client, errorText } from '../lib.js';

const POLL_MS = 30_000;

export function useComputers(active = true): { view?: ComputersView; error?: string; reload: (poll?: boolean) => Promise<void> } {
  const [view, setView] = useState<ComputersView>();
  const [error, setError] = useState<string>();
  const reload = (poll = false) => client.computers(poll).then((next) => (setView(next), setError(undefined)), (e: unknown) => setError(errorText(e)));
  useEffect(() => {
    if (!active) return;
    const load = () => void reload();
    load();
    const timer = setInterval(load, POLL_MS);
    window.addEventListener('focus', load);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', load);
    };
  }, [active]);
  return { view, error, reload };
}

export function computerLabels(view: ComputersView | undefined): (name: string) => string {
  if (!view) return (name) => name;
  const shorts = new Map<string, string | undefined>([[view.self.name, view.self.short], ...view.computers.filter((c) => c.direction === 'out').map((c) => [c.name, c.caps?.short] as const)]);
  const taken = [...shorts.values()];
  return (name) => {
    const short = shorts.get(name);
    return short && taken.filter((s) => s === short).length === 1 ? short : name;
  };
}

export async function openComputerTopic(name: string, topicId: string): Promise<void> {
  await client.openComputerTopic(name, topicId);
}
