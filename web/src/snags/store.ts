import { useSyncExternalStore } from 'react';
import type { HosEvent } from '../../../src/api/types.js';
import { SnagsClient } from '../../../src/snags/client.js';
import { client } from '../lib.js';

export const snags = new SnagsClient(client);

const CHANGE_DEBOUNCE_MS = 300;
const listeners = new Set<() => void>();
let version = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

export function snagsChanged(): void {
  clearTimeout(timer);
  timer = setTimeout(() => {
    version++;
    for (const listener of listeners) listener();
  }, CHANGE_DEBOUNCE_MS);
}

export function onSnagEvent(event: HosEvent): void {
  if (event.type === 'bus.call' && event.tool.startsWith('snag') && event.tool !== 'snags' && event.tool !== 'snag_read' && event.outcome === 'ok') snagsChanged();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('focus', snagsChanged);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) window.removeEventListener('focus', snagsChanged);
  };
}

export function useSnagsVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}

export async function fileBlobUrl(ref: string, name: string): Promise<string> {
  const response = await fetch(snags.fileUrl(ref, name), { headers: client.sessionToken ? { authorization: `Bearer ${client.sessionToken}` } : {} });
  if (!response.ok) throw new Error(`could not load ${name}`);
  return URL.createObjectURL(await response.blob());
}

export function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error ?? new Error('could not read the file'));
    reader.readAsDataURL(file);
  });
}
