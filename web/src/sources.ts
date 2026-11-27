import { useEffect, useSyncExternalStore } from 'react';
import type { SourcesInfo } from '../../src/api/types.js';
import { client } from './lib.js';

let info: SourcesInfo | undefined;
let asked = false;
const listeners = new Set<() => void>();

function load(): void {
  if (asked) return;
  asked = true;
  client.sources().then(
    (next) => {
      info = next;
      for (const listener of listeners) listener();
    },
    () => {
      asked = false;
    },
  );
}

export function useSources(): SourcesInfo | undefined {
  const value = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => info,
  );
  useEffect(load, []);
  return value;
}
