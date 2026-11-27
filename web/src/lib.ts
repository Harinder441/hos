import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { useEffect, useState, type KeyboardEvent } from 'react';
import { HosClient } from '../../src/api/client.js';
import type { Surface } from '../../src/api/types.js';
import { lineageHeads, type State } from './state.js';

export const SESSION_KEY = 'hos.session';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function trapTab(e: KeyboardEvent<HTMLElement>): void {
  if (e.key !== 'Tab') return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
  const first = items[0];
  const last = items.at(-1);
  if (!first || !last) return void e.preventDefault();
  const at = document.activeElement;
  if (e.shiftKey ? at === first || !e.currentTarget.contains(at) : at === last || !e.currentTarget.contains(at)) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  }
}
export const PHONE_QUERY = '(max-width: 700px)';

export const client = new HosClient(location.origin, {
  authenticator: {
    create: (optionsJSON) => startRegistration({ optionsJSON }),
    get: (optionsJSON) => startAuthentication({ optionsJSON }),
  },
  sessionToken: localStorage.getItem(SESSION_KEY) ?? undefined,
});

export function useAction() {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { error, busy, run };
}

export function useHash(): [string, (chatId: string) => void] {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const onChange = () => setHash(location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return [hash, (id) => (location.hash = `#/chat/${id}`)];
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const list = matchMedia(query);
    const onChange = () => setMatches(list.matches);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

export function surface(): Surface {
  return /iPhone|iPad|Android/.test(navigator.userAgent) || matchMedia('(pointer: coarse)').matches ? 'phone' : 'mac';
}

export function openTerminal(name: string) {
  location.hash = `#/terminal/${encodeURIComponent(name)}`;
}

export function chatLabel(state: State, chatId: string): string {
  const chat = state.chats[chatId];
  const topic = chat ? state.topics[chat.topicId] : undefined;
  const index = chat ? lineageHeads(state, chat.topicId).findIndex((head) => head.id === chat.lineageId) : -1;
  return `${topic?.title ?? 'topic'} · Chat ${index + 1}`;
}

export function ownerLabel(state: State, item: { chatId: string | null; topicId?: string | null; workspaceId?: string | null }): string {
  if (item.chatId) return chatLabel(state, item.chatId);
  if (!item.workspaceId && !item.topicId) return 'Mac';
  const name = (item.topicId ? state.topics[item.topicId]?.title : undefined) ?? (item.workspaceId ? state.workspaces[item.workspaceId]?.name : undefined);
  return `${name ?? 'workspace'} · diff`;
}

export function ownerHref(item: { chatId: string | null; workspaceId?: string | null }): string {
  if (!item.chatId && !item.workspaceId) return '#/keeper';
  return item.chatId ? `#/chat/${item.chatId}` : `#/diff/workspace/${item.workspaceId}`;
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
