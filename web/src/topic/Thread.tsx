import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Chat, InboxItem } from '../../../src/api/types.js';
import { client } from '../lib.js';
import { lineageChats, openInbox, type State, type TimelineItem } from '../state.js';
import { Cards, openCards } from './cards.js';
import { timelineRows } from './timeline.js';

// The snapshot keeps only a stub of chats that ended over a day ago; their full timeline comes from the events.
const ENDED = new Set<Chat['state']>(['done', 'failed', 'killed', 'archived', 'handed_off']);
const loaded = new Map<string, Promise<TimelineItem[]>>();

function loadTimeline(chatId: string): Promise<TimelineItem[]> {
  let load = loaded.get(chatId);
  if (!load) {
    load = client.chatTimeline(chatId);
    loaded.set(chatId, load);
    load.catch(() => loaded.delete(chatId));
  }
  return load;
}

function merged(full: TimelineItem[], live: TimelineItem[]): TimelineItem[] {
  const fresh = new Map(live.map((item) => [item.id, item]));
  const known = new Set(full.map((item) => item.id));
  return [...full.map((item) => fresh.get(item.id) ?? item), ...live.filter((item) => !known.has(item.id))];
}

function useFullTimelines(state: State, chats: Chat[]): State {
  const [full, setFull] = useState<Record<string, TimelineItem[]>>({});
  const ended = chats.filter((chat) => ENDED.has(chat.state)).map((chat) => chat.id);
  useEffect(() => {
    let cancelled = false;
    for (const id of ended) loadTimeline(id).then((items) => cancelled || setFull((had) => ({ ...had, [id]: items })), () => {});
    return () => {
      cancelled = true;
    };
  }, [ended.join()]);
  const ids = Object.keys(full).filter((id) => chats.some((chat) => chat.id === id));
  if (!ids.length) return state;
  return { ...state, timeline: { ...state.timeline, ...Object.fromEntries(ids.map((id) => [id, merged(full[id]!, state.timeline[id] ?? [])])) } };
}

export function threadChats(state: State, chatId: string): Chat[] {
  const chat = state.chats[chatId];
  return chat ? lineageChats(state, chat) : [];
}

export function isWorking(state: State, chats: Chat[]): boolean {
  const latest = chats.at(-1);
  if (!latest || state.terminals[latest.id]) return false;
  if (latest.state !== 'starting' && latest.state !== 'running' && latest.state !== 'handing_off') return false;
  return openCards(state, chats).length === 0;
}

export function Thread({ chatId, state: live, onEditPlan }: { topicId: string; chatId: string; state: State; onEditPlan?: (item: InboxItem) => void }) {
  const chats = threadChats(live, chatId);
  const state = useFullTimelines(live, chats);
  const body = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const shown = useRef<string>(undefined);
  const items = chats.flatMap((c) => state.timeline[c.id] ?? []);
  const last = items.at(-1);
  const cards = openCards(state, chats);
  const working = isWorking(state, chats);
  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    const opened = shown.current !== chatId;
    if (opened) {
      shown.current = chatId;
      pinned.current = true;
    }
    if (!pinned.current) return;
    el.scrollTop = el.scrollHeight;
    if (opened) requestAnimationFrame(() => (el.scrollTop = el.scrollHeight));
  }, [chatId, items.length, last?.kind === 'message' ? last.text.length : last?.kind === 'tool' ? last.output : undefined, cards.length]);
  if (!chats.length) return <p className="page-empty muted">No chat with this id.</p>;
  const open = openInbox(state);
  const streaming = last?.kind === 'message' && last.role === 'assistant' && !last.done;
  return (
    <div
      className="timeline"
      ref={body}
      onScroll={() => {
        const el = body.current!;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      <div className="col" role="log" aria-label="Conversation" aria-live="polite" aria-relevant="additions">
        {timelineRows(chats, state, open)}
        <Cards cards={cards} state={state} onEditPlan={onEditPlan ?? (() => {})} />
        {live.refreshing[chats.at(-1)!.id] ? (
          <p className="thread-working" role="status">
            Refreshing context…
          </p>
        ) : (
          working &&
          !streaming && (
            <p className="thread-working" role="status">
              {chats.at(-1)!.state === 'starting' ? 'Starting…' : 'Working…'}
            </p>
          )
        )}
      </div>
    </div>
  );
}
