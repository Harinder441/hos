import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { Clock } from './adapters/clock.js';
import {
  type BusOutcome,
  type Chat,
  type ChatState,
  type EventBody,
  noticeHeader,
  type Workspace,
} from './api/types.js';
import { canvasLine, canvasOn } from './canvas/canvases.js';
import type { Diagrams } from './diagrams.js';
import { LIVE_STATES } from './governor.js';
import type { HistoryEntry } from './history.js';
import { owner, ownerStart } from './owner.js';
import { GENERIC, loadProfiles, profileFor, TURN_BLOCKS, type TurnBlock } from './profiles.js';
import type { Store } from './store.js';
import { summarize } from './summary.js';

export type Recorder = (body: EventBody, write?: () => void) => void;

export interface BusReply {
  text: string;
  outcome: BusOutcome;
  crossChat?: boolean;
}

export interface BusLimits {
  contextBudget: number;
  crossChatShare: number;
}

export const COMPUTER_SHA_META = 'computer.sha.';

export class Bus {
  brainDir: string | undefined;
  codeViewBase: string | undefined;
  computerName: string | undefined;
  diagrams: Diagrams | null = null;
  private readonly tokens = new Map<string, string>();
  private readonly briefed = new Map<string, string>();
  private readonly injected = new Map<string, string>();
  private readonly crossChatLimit: number;

  constructor(
    private readonly store: Store,
    private readonly record: Recorder,
    private readonly clock: Clock,
    private readonly limits: BusLimits,
  ) {
    this.crossChatLimit = Math.floor(limits.contextBudget * limits.crossChatShare);
  }

  mintToken(chatId: string): string {
    for (const [token, owner] of this.tokens) if (owner === chatId) this.tokens.delete(token);
    const token = randomBytes(24).toString('base64url');
    this.tokens.set(token, chatId);
    return token;
  }

  chatForToken(token: string | undefined): string | undefined {
    return token ? this.tokens.get(token) : undefined;
  }

  async call(chatId: string, tool: string, args: Record<string, unknown>, run: () => BusReply | Promise<BusReply>): Promise<BusReply> {
    let reply: BusReply;
    try {
      const { state } = this.store.getChat(chatId)!;
      if (!HALTED_STATES.has(state)) this.store.renewLocks(chatId, this.clock.now());
      reply = HALTED_STATES.has(state)
        ? { outcome: 'refused', text: `Refused: you are ${state}, so the bus only answers again after ${owner()} resumes you.` }
        : await run();
    } catch (error) {
      reply = { text: error instanceof Error ? error.message : String(error), outcome: 'error' };
    }
    let charged = 0;
    if (reply.outcome === 'ok' && reply.crossChat) {
      const used = this.store.chatBusState(chatId).crossChatTokens;
      const cost = tokens(reply.text);
      if (used + cost > this.crossChatLimit) {
        reply = {
          outcome: 'refused',
          text: `Refused: this answer is about ${cost} tokens and you have taken ${used} of your ${this.crossChatLimit}-token cross-chat budget (${Math.round(this.limits.crossChatShare * 100)}% of your context). Instead, spawn a scout to read it and return a short summary.`,
        };
      } else {
        charged = cost;
        reply = { ...reply, text: `${reply.text}\n[cross-chat budget: used ${used + cost} of ${this.crossChatLimit} tokens]` };
      }
    }
    this.record(
      {
        type: 'bus.call',
        chatId,
        tool,
        input: summarize(JSON.stringify(args)),
        outcome: reply.outcome,
        tokens: charged,
        ...(reply.outcome === 'ok' ? {} : { message: summarize(reply.text) }),
      },
      charged ? () => this.store.addCrossChatTokens(chatId, charged) : undefined,
    );
    return reply;
  }

  tail(chatId: string, target: string, n: number): BusReply {
    const other = this.resolveChat(chatId, target);
    const refusal = this.unreadable(other, 'events');
    if (refusal) return refusal;
    const lines = this.store.chatSummaries(other.id, Math.min(Math.max(1, Math.floor(n)), TAIL_MAX));
    const text = lines.length ? lines.map((line) => `#${line.seq} ${line.summary}`).join('\n') : '(no events yet)';
    return { outcome: 'ok', crossChat: true, text: fromChat(this.chatName(other, other.id.slice(0, 8)), text) };
  }

  chatHistory(target: string, before: number | undefined, limit: number): BusReply {
    const matches = target.length >= 4 ? this.store.chatsWithIdPrefix(target) : [];
    if (matches.length !== 1) throw new Error(`No single chat matches "${target}"; give its id or first 8 characters.`);
    const other = matches[0]!;
    const refusal = this.unreadable(other, 'messages');
    if (refusal) return refusal;
    const rows = this.store.chatMessages(other.id, before, limit + 1);
    const page = rows.slice(0, limit);
    const who = (body: EventBody) =>
      body.type !== 'message.user' ? 'assistant' : body.from === 'chat' ? `chat ${body.fromChatId?.slice(0, 8)}` : (body.from ?? 'user');
    const lines = page.map((row) => `#${row.seq} ${new Date(row.ts).toISOString().slice(0, 16)} ${who(row.body)}:\n${(row.body as { text: string }).text}`);
    const more = rows.length > limit ? `(older messages: chat_history before=${page.at(-1)!.seq})` : '(start of chat)';
    const topic = this.store.getTopic(other.topicId);
    return {
      outcome: 'ok',
      crossChat: true,
      text: fromChat(this.chatName(other, other.id.slice(0, 8)), [`${other.role} chat in topic "${topic?.title ?? other.topicId}", ${other.state}; messages newest first`, ...lines, more].join('\n\n')),
    };
  }

  search(chatId: string, query: string): BusReply {
    const { topicId } = this.store.getChat(chatId)!;
    const words = searchWords(query);
    if (!words.length) return { outcome: 'refused', text: 'Give at least one word to search for.' };
    const rows = this.store.search(topicId, ftsQuery(words), { excludeChat: chatId, limit: SEARCH_HITS });
    if (!rows.length) return { outcome: 'ok', text: `No matches for "${query}" in other chats of your topic.` };
    const text = rows.map((row) => `#${row.key} chat ${row.chatId!.slice(0, 8)}: ${row.snippet}`).join('\n');
    return { outcome: 'ok', crossChat: true, text: `[search results from other chats via the hos bus; not the user]\n${text}` };
  }

  turnContext(chatId: string): string {
    this.store.countTurn(chatId);
    const { turns, card, cardTurn } = this.store.chatBusState(chatId);
    const stale = card === null ? turns >= 2 : turns - (cardTurn ?? 0) > STALE_CARD_TURNS;
    const reminder = card === null ? 'You have no card yet.' : `Your card is ${turns - (cardTurn ?? 0)} turns old.`;
    const briefing = this.briefing(chatId);
    const fresh = this.briefed.get(chatId) !== briefing;
    this.briefed.set(chatId, briefing);
    const blocks = this.turnBlocks(chatId);
    const notices = this.store.quietNotices(chatId);
    this.store.markNoticesDelivered(
      notices.map((notice) => notice.id),
      this.clock.now(),
    );
    return [
      ...(fresh ? [briefing] : []),
      ...blocks,
      ...(notices.length ? [noticeHeader(owner()), ...notices.map((notice) => `- ${notice.text}`)] : []),
      ...(stale ? [`${reminder} Call update_card with what you are doing, what is done, what blocks you and what is next (at most ${CARD_TOKENS} tokens).`] : []),
    ].join('\n');
  }

  roster(chatId: string): BusReply {
    const text = this.rosterText(chatId);
    this.injected.set(`${chatId} roster`, text);
    return { outcome: 'ok', text };
  }

  // Every chat gets the roster; a profile adds its turn_context blocks. Each is re-sent only when its text changed.
  private turnBlocks(chatId: string): string[] {
    const chat = this.store.getChat(chatId)!;
    const { profile } = profileFor(loadProfiles(this.brainDir), chat.profile);
    const context = { store: this.store, chat, roster: () => this.rosterText(chatId), card: (c: Chat) => this.cardLine(c) };
    return [...new Set<TurnBlock>(['roster', ...profile.turnContext])].flatMap((name) => {
      const text = TURN_BLOCKS[name](context);
      const key = `${chatId} ${name}`;
      if (this.injected.get(key) === text) return [];
      this.injected.set(key, text);
      return [text];
    });
  }

  private cardLine(chat: Chat): string {
    return this.store.chatBusState(chat.id).card?.split('\n')[0]?.slice(0, ROSTER_CARD_CHARS) ?? 'no card';
  }

  cardFromHistory(chatId: string, entry: HistoryEntry): void {
    const { turns, cardTurn } = this.store.chatBusState(chatId);
    if (cardTurn === turns) return;
    this.updateCard(chatId, `${entry.title.trim()}\nDid: ${entry.did.trim()}\nOpen: ${entry.open.trim()}`.slice(0, CARD_TOKENS * 4));
  }

  updateCard(chatId: string, text: string): BusReply {
    const card = text.trim();
    if (!card) return { outcome: 'refused', text: 'A card cannot be empty.' };
    if (tokens(card) > CARD_TOKENS) {
      return { outcome: 'refused', text: `Refused: a card is at most ${CARD_TOKENS} tokens (about ${CARD_TOKENS * 4} characters); yours is about ${tokens(card)}.` };
    }
    this.record({ type: 'card.updated', chatId, card }, () => this.store.setCard(chatId, card));
    return { outcome: 'ok', text: 'Card updated.' };
  }

  card(chatId: string, target: string): BusReply {
    const other = this.resolveChat(chatId, target);
    const refusal = this.unreadable(other, 'card');
    if (refusal) return refusal;
    const { card } = this.store.chatBusState(other.id);
    return { outcome: 'ok', crossChat: true, text: fromChat(this.chatName(other, other.id.slice(0, 8)), card ?? '(this chat has not written a card yet)') };
  }

  unreadable(other: Chat, what: string): BusReply | undefined {
    if (!other.computer || this.store.listComputers().some((row) => row.name === other.computer && row.direction === 'out')) return undefined;
    return {
      outcome: 'refused',
      text: `Refused: chat ${other.id.slice(0, 8)} runs on ${other.computer}, and ${this.computerName} can’t read its ${what} from here. Message it with send.`,
    };
  }

  resolveChat(chatId: string, ref: string): Chat {
    const { topicId } = this.store.getChat(chatId)!;
    const linked = this.linkedChats(chatId).flatMap((c) => this.store.chatsInLineage(c.lineageId)).filter((c) => c.topicId !== topicId);
    const matches = [...this.store.chatsInTopic(topicId), ...linked].filter((c) => c.id === ref || (ref.length >= 4 && c.id.startsWith(ref)));
    if (matches.length !== 1) throw new Error(`No single chat in your topic or linked to you matches "${ref}"; use an id from the roster.`);
    return matches[0]!;
  }

  // The tab shows the lineage head's title, so successors print it too.
  chatName(chat: Chat, id = chat.id): string {
    const title = (this.store.getChat(chat.lineageId) ?? chat).title;
    if (!title) return id;
    return `${id} "${title.length > TITLE_CHARS ? `${title.slice(0, TITLE_CHARS - 1)}…` : title}"`;
  }

  private linkedChats(chatId: string): Chat[] {
    const { lineageId } = this.store.getChat(chatId)!;
    return this.store
      .linksOf(lineageId)
      .filter((link) => link.kind === 'chat')
      .flatMap((link) => this.store.chatsInLineage(link.target).slice(-1));
  }

  private rosterText(chatId: string): string {
    const chat = this.store.getChat(chatId)!;
    const topic = this.store.getTopic(chat.topicId)!;
    const live = this.store.chatsInTopic(topic.id).filter((c) => LIVE.has(c.state) && (!topic.desk || c.id === chatId));
    const ordered = [
      ...live.filter((c) => c.id === chatId),
      ...live.filter((c) => c.id !== chatId && c.state === 'running'),
      ...live.filter((c) => c.id !== chatId && c.state !== 'running'),
    ];
    const shown = ordered.slice(0, ROSTER_ROWS);
    const row = (c: Chat) =>
      `- ${this.chatName(c, c.id.slice(0, 8))} ${c.agent} ${c.role}${c.profile === GENERIC ? '' : ` ${c.profile}`} ${c.state}${c.id === chatId ? ' (you)' : ''}${c.computer ? ` · on ${c.computer}` : ''} · ${this.cardLine(c)}`;
    const linked = this.linkedChats(chatId);
    const where = (c: Chat) => `topic "${this.store.getTopic(c.topicId)?.title ?? c.topicId}"`;
    return [
      `hos roster · topic "${topic.title}" · ${live.length} live chat${live.length === 1 ? '' : 's'} (from hos, not the user)`,
      ...shown.map(row),
      ...(ordered.length > shown.length ? [`… and ${ordered.length - shown.length} more`] : []),
      ...(linked.length ? [`Linked (${ownerStart()} linked these chats with you; read with chat_history, message with send):`, ...linked.map((c) => `${row(c)} · ${where(c)}`)] : []),
    ].join('\n');
  }

  briefing(chatId: string): string {
    const chat = this.store.getChat(chatId)!;
    const topic = this.store.getTopic(chat.topicId)!;
    const folders = topic.workspaceIds.flatMap((id) => this.store.getWorkspace(id) ?? []).filter((w) => w.archivedAt === null);
    const scratch = `.context/topics/${topic.statusTopic}/`;
    const setup = (w: Workspace) =>
      w.setup === 'ready'
        ? 'ready'
        : w.setup === 'failed'
          ? `setup failed${w.setupLog ? ` (log ${w.setupLog})` : ''}`
          : 'setting up… (call workspace_wait before using it)';
    const branch = (w: Workspace) => (w.kind === 'worktree' && w.base && w.base !== w.branch ? `branch ${w.branch ?? 'none'} from ${w.base}` : `branch ${w.branch ?? 'none'}`);
    const repo = (w: Workspace) => this.store.getProject(w.projectId)?.name ?? w.name;
    const where = this.brainDir ? `You run in the brain at ${this.brainDir}.` : 'hos has no brain, so you run in your topic\'s first workspace.';
    const diagrams = this.diagrams?.linked(topic.id, chat.lineageId) ?? [];
    const { profile, notice } = profileFor(loadProfiles(this.brainDir), chat.profile);
    const brainSha = topic.home ? this.store.meta(COMPUTER_SHA_META + chatId) : undefined;
    const canvases = canvasOn(profile) ? canvasLine(this.store, topic.id) : null;
    return [
      `[hos briefing] Topic "${topic.title}" (id ${topic.id}). ${where}${chat.worktreePath ? ` Your own worktree: ${chat.worktreePath}.` : ''} Profile: ${profile.id}${notice ? ` (${notice})` : ''}.`,
      ...(brainSha
        ? [
            `Computer: ${this.computerName} (started from ${topic.home})`,
            `Brain: ${brainSha} (pulled before this turn)`,
            ...(chat.chrome ? ["Browser: this computer's Chrome only"] : []),
          ]
        : []),
      topic.desk
        ? `Desk holds ${owner()}'s quick, unrelated asks: the other chats here have nothing to do with yours, so work standalone. There is no shared work folder: for each deliverable pick a folder work/<area>/<YYYY-MM-DD>-<slug>/ (areas in work/README.md) and pass it as folder to progress_read and progress_update. Don't read other chats' cards, tails or search hits unless ${owner()} asks.`
        : workLine(topic.workDir, this.brainDir),
      `Scratch: ${scratch} (scratch/, attachments/, raw/; gitignored, never cleaned).`,
      ...(this.codeViewBase ? [`Code view base: ${this.codeViewBase} (this host's Code view; build Code view PR links as ${this.codeViewBase}/pr?url=<url-encoded PR url>&topic=${topic.id}).`] : []),
      ...(folders.length
        ? ['Workspaces:', ...folders.map((w) => `- ${repo(w)} · ${w.kind} · ${w.path} · ${branch(w)} · ${setup(w)}`)]
        : [`No workspace yet: before you read or edit a repo, call workspace_choose (purpose read to only read it); if ${owner()} named the checkout, pass their words as said with suggest, otherwise never pick a checkout yourself.`]),
      ...(diagrams.length
        ? [
            'Diagrams in this topic or linked to this chat (read and edit them with diagram_read, diagram_apply and diagram_screenshot, never by writing the file; draw boxes-and-arrows with diagram_layout, not coordinates, and keep box labels to a few words):',
            ...diagrams.map(
              (d) => `- ${d.id} · ${d.title} · ${d.path}${d.topic === topic.id ? '' : ' · in another topic'}${d.linked ? ` · linked to this chat: ${owner()} draws on it beside you` : ''}`,
            ),
          ]
        : []),
      ...(canvases ? [canvases] : []),
      "This topic's work lives in the brain and these workspaces; to work in another repo, attach it with workspace_choose.",
    ].join('\n');
  }

  whoami(chatId: string): BusReply {
    const chat = this.store.getChat(chatId)!;
    const topic = this.store.getTopic(chat.topicId)!;
    const folders = topic.workspaceIds.map((id) => {
      const workspace = this.store.getWorkspace(id)!;
      return `${workspace.kind} workspace ${workspace.name} (${workspace.id}) of project ${this.store.getProject(workspace.projectId)?.name ?? workspace.projectId}, branch ${workspace.branch ?? 'none'}, at ${workspace.path}`;
    });
    return {
      outcome: 'ok',
      text: [
        `You are chat ${this.chatName(chat)} (${chat.agent}), generation ${chat.generation} of lineage ${chat.lineageId}${chat.predecessorId ? `, continuing chat ${chat.predecessorId}` : ''}.`,
        `Role ${chat.role}${chat.role === 'main' ? ": a chat in this topic. Every chat here is equal: it plans, edits the brain and the topic's workspaces, and starts other chats" : ''}.`,
        `Profile ${chat.profile}: profiles/${chat.profile}/PROFILE.md in the brain says which skills you see and what you may start; SOUL.md, USER.md, MEMORY.md and RULES.md beside it are your identity files.`,
        `Topic "${topic.title}" (${topic.id}); you run${this.computerName ? ` on ${this.computerName}` : ''} in ${chat.worktreePath ?? this.brainDir ?? 'the first workspace'}; ${folders.length ? `workspaces: ${folders.join('; ')}` : 'no workspace yet (call workspace_choose when the work needs a repo)'}.`,
        `Cross-chat budget: ${this.store.chatBusState(chatId).crossChatTokens} of ${this.crossChatLimit} tokens used. Cards, tail and search reads count; past the budget, spawn a scout.`,
      ].join('\n'),
    };
  }
}

const ROSTER_ROWS = 15;
const ROSTER_CARD_CHARS = 80;
const TITLE_CHARS = 60;
const CARD_TOKENS = 300;
const STALE_CARD_TURNS = 10;
const TAIL_MAX = 30;
const SEARCH_HITS = 10;
const LIVE = new Set<ChatState>(LIVE_STATES);
const HALTED_STATES = new Set<ChatState>(['paused', 'killed', 'archived']);

export function searchWords(query: string): string[] {
  return query.match(/[\p{L}\p{N}_]+/gu) ?? [];
}

export function ftsQuery(words: string[]): string {
  return words.map((word) => `"${word}"`).join(' ');
}

export function tokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function workLine(workDir: string | null, brainDir: string | undefined): string {
  if (!workDir) return 'This topic has no work folder.';
  const abs = brainDir ? join(brainDir, workDir) : workDir;
  return `Work folder: ${workDir}/ (WORK_DIR=${abs}); PROGRESS.md there is this topic's progress doc: read it first, update it with progress_update.`;
}

function fromChat(name: string, text: string): string {
  return `[from chat ${name} via the hos bus; not the user]\n${text}`;
}

export function senderLabel(chat: Chat): string {
  return `[from chat ${chat.id.slice(0, 8)} · role=${chat.role}${chat.profile === GENERIC ? '' : ` · profile=${chat.profile}`} · not the user]`;
}
