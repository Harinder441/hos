import { useCallback, useSyncExternalStore } from 'react';

export interface DraftFile {
  key: string;
  name: string;
  path?: string;
  error?: string;
}

export interface Draft {
  text: string;
  files: DraftFile[];
  queued?: string;
}

const KEY = 'hos.drafts';
const EMPTY: Draft = { text: '', files: [] };
const listeners = new Set<() => void>();
let drafts = read();

function read(): Record<string, Draft> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, Draft>;
  } catch {
    return {};
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function updateDraft(id: string, update: (draft: Draft) => Draft): void {
  const next = update(drafts[id] ?? EMPTY);
  const { [id]: _old, ...rest } = drafts;
  drafts = next.text || next.files.length || next.queued ? { ...rest, [id]: next } : rest;
  const saved = Object.fromEntries(Object.entries(drafts).map(([key, draft]) => [key, { ...draft, files: draft.files.filter((file) => file.path) }]));
  localStorage.setItem(KEY, JSON.stringify(saved));
  for (const listener of listeners) listener();
}

export function useDraft(id: string): [Draft, (update: (draft: Draft) => Draft) => void] {
  const draft = useSyncExternalStore(subscribe, () => drafts[id] ?? EMPTY);
  return [draft, useCallback((update: (draft: Draft) => Draft) => updateDraft(id, update), [id])];
}
