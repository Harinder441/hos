import { useEffect, useRef, useState } from 'react';
import type { DiagramInfo } from '../../../src/api/types.js';
import { client, errorText } from '../lib.js';

const SETTLE_MS = 2000;

export function useSettledSeq(seq: number): number {
  const [settled, setSettled] = useState(seq);
  const latest = useRef(seq);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  latest.current = seq;
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      timer.current = undefined;
    },
    [],
  );
  useEffect(() => {
    if (seq === settled || timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = undefined;
      setSettled(latest.current);
    }, SETTLE_MS);
  }, [seq, settled]);
  return settled;
}

export function useDiagrams(changeSeq: number, query = ''): { diagrams: DiagramInfo[] | null; error?: string } {
  const seq = useSettledSeq(changeSeq);
  const [diagrams, setDiagrams] = useState<DiagramInfo[] | null>(null);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(
      () =>
        client.searchDiagrams(query.trim() || undefined).then(
          (found) => {
            if (cancelled) return;
            setDiagrams(found);
            setError(undefined);
          },
          (e: unknown) => cancelled || setError(errorText(e)),
        ),
      query ? 200 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [seq, query]);
  return { diagrams, ...(error ? { error } : {}) };
}

export function lightTheme(): boolean {
  const chosen = document.documentElement.dataset.theme;
  return chosen ? chosen === 'light' : matchMedia('(prefers-color-scheme: light)').matches;
}

export function whoName(who: DiagramInfo['updatedBy']): string | null {
  return who === 'user' ? 'you' : who === 'agent' ? 'Claude' : null;
}
