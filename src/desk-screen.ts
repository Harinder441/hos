import type { IncomingHttpHeaders } from 'node:http';
import type { Chat, InboxItem } from './api/types.js';
import type { Hos } from './core.js';
import type { DeskChat, DeskScreen } from './plugins/types.js';
import type { Snags } from './snags/snags.js';
import type { Store } from './store.js';

export type { DeskChat, DeskScreen };

export const DESK_PATH = '/api/desk';
export const DESK_TOKEN_FILE = 'desk.token';
const LIST_CAP = 12;
const ASK_MAX = 140;
const NEEDS_KINDS = new Set<InboxItem['kind']>(['approval', 'question', 'plan']);
const GONE = new Set<Chat['state']>(['killed', 'archived']);

export async function deskScreen(hos: Hos, store: Store, snags: Snags, now: number): Promise<DeskScreen> {
  const topics = new Map(hos.listTopics().map((topic) => [topic.id, topic.title]));
  const view = (chat: Chat, since: number | null): DeskChat => ({
    chat_id: chat.id,
    topic: topics.get(chat.topicId) ?? chat.topicId,
    title: chat.title,
    since: since === null ? null : new Date(since).toISOString(),
  });
  const asks = new Map<string, InboxItem>();
  for (const item of hos.listInbox()) {
    if (!item.chatId || !NEEDS_KINDS.has(item.kind)) continue;
    const seen = asks.get(item.chatId);
    if (!seen || item.createdAt < seen.createdAt) asks.set(item.chatId, item);
  }
  const waitingChats = [...asks.keys()].map((id) => store.getChat(id)).filter((chat): chat is Chat => !!chat && !GONE.has(chat.state));
  for (const chat of store.chatsInState(['waiting_input'])) if (!asks.has(chat.id)) waitingChats.push(chat);
  const waiting = waitingChats
    .map((chat) => {
      const item = asks.get(chat.id);
      return { ...view(chat, item?.createdAt ?? store.chatStateSince(chat.id)), ask: oneLine(item ? itemAsk(item) : lastReply(store, chat.id)) };
    })
    .sort((a, b) => (a.since ?? '').localeCompare(b.since ?? ''))
    .slice(0, LIST_CAP);
  const waitingIds = new Set(waitingChats.map((chat) => chat.id));
  const running = store
    .chatsInState(['starting', 'running'])
    .filter((chat) => !waitingIds.has(chat.id))
    .map((chat) => view(chat, store.chatStateSince(chat.id)))
    .sort((a, b) => (b.since ?? '').localeCompare(a.since ?? ''))
    .slice(0, LIST_CAP);
  const summary = await snags.summary();
  return { generated_at: new Date(now).toISOString(), waiting, running, open_snags: summary.open - summary.openContext };
}

export function deskCors(headers: IncomingHttpHeaders, preflight: boolean, origins: readonly string[]): Record<string, string> {
  const origin = headers.origin;
  if (!origin || !origins.includes(origin)) return { vary: 'Origin' };
  const allowed = { 'access-control-allow-origin': origin, vary: 'Origin' };
  if (!preflight) return allowed;
  return {
    ...allowed,
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'authorization',
    'access-control-max-age': '600',
    ...(headers['access-control-request-private-network'] === 'true' ? { 'access-control-allow-private-network': 'true' } : {}),
  };
}

function itemAsk(item: InboxItem): string {
  if (item.kind === 'plan') return item.plan?.text ?? item.title;
  if (item.kind === 'question') return item.questions?.[0]?.question ?? (item.detail || item.title);
  return `Approve ${item.title}: ${item.detail}`;
}

function lastReply(store: Store, chatId: string): string {
  const reply = store.chatMessages(chatId, undefined, 10).find((message) => message.body.type === 'message.completed');
  return reply?.body.type === 'message.completed' ? reply.body.text : '';
}

function oneLine(text: string): string {
  const line = text.split('\n').map((part) => part.trim()).find(Boolean) ?? '';
  return line.length > ASK_MAX ? `${line.slice(0, ASK_MAX - 1)}…` : line;
}
