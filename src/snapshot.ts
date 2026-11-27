import { applyEvent, initialState, type Snapshot, type State, type TimelineItem } from './api/state.js';
import type { ChatState, HosEvent } from './api/types.js';

const TIMELINE_CAP = 200;
const RECENT_MS = 24 * 60 * 60_000;
const ENDED = new Set<ChatState>(['done', 'failed', 'killed', 'archived', 'handed_off']);
// Bump on any change to how events fold (api/state.ts applyEvent, State, or this file); a saved fold of another version is rebuilt.
export const FOLD_VERSION = 2;

export class UiFold {
  private state: State = initialState;
  private readonly activeAt = new Map<string, number>();
  folded = 0;
  restoredAt: number | null = null;

  get seq(): number {
    return this.state.lastSeq;
  }

  save(): string {
    return JSON.stringify({ version: FOLD_VERSION, state: this.state, activeAt: [...this.activeAt] });
  }

  static restore(saved: string): UiFold | null {
    try {
      const parsed = JSON.parse(saved) as { version?: unknown; state?: State; activeAt?: Array<[string, number]> };
      const { state, activeAt } = parsed;
      if (parsed.version !== FOLD_VERSION || !state || !Array.isArray(activeAt) || !Object.keys(initialState).every((key) => key in state)) return null;
      const ui = new UiFold();
      ui.state = state;
      for (const [chatId, at] of activeAt) ui.activeAt.set(chatId, at);
      ui.restoredAt = state.lastSeq;
      return ui;
    } catch {
      return null;
    }
  }

  apply(event: HosEvent): void {
    this.folded++;
    this.state = applyEvent(this.state, event);
    const chatId = 'chatId' in event ? event.chatId : event.type === 'chat.created' ? event.chat.id : null;
    if (typeof chatId !== 'string') return;
    this.activeAt.set(chatId, event.ts);
    const items = this.state.timeline[chatId];
    if (items && items.length > TIMELINE_CAP) this.state = { ...this.state, timeline: { ...this.state.timeline, [chatId]: trim(items, TIMELINE_CAP) } };
  }

  snapshot(now: number): Snapshot {
    const timeline = Object.fromEntries(Object.entries(this.state.timeline).map(([chatId, items]) => [chatId, this.shown(chatId, now) ? items : trim(items, 0)]));
    return { seq: this.state.lastSeq, state: { ...this.state, timeline } };
  }

  private shown(chatId: string, now: number): boolean {
    const chat = this.state.chats[chatId];
    return (chat !== undefined && !ENDED.has(chat.state)) || now - (this.activeAt.get(chatId) ?? 0) < RECENT_MS;
  }
}

// Keeps what views derive from a whole timeline: the inbox's open approvals, the chat title and the last-message time.
function trim(items: TimelineItem[], newest: number): TimelineItem[] {
  const cut = items.length - newest;
  const firstUser = items.findIndex((item) => item.kind === 'message' && item.role === 'user');
  let latest = -1;
  items.forEach((item, i) => {
    const best = items[latest];
    if (item.kind === 'message' && (best?.kind !== 'message' || item.at > best.at)) latest = i;
  });
  return items.filter((item, i) => i >= cut || i === firstUser || i === latest || (item.kind === 'approval' && !item.decision));
}
