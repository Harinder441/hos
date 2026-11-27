import type { Chat, ComputersView, Effort, InboxItem, Topic } from '../../../src/api/types.js';
import { topicUnseen } from '../../../src/api/types.js';
import { client } from '../lib.js';
import { lineageChats, openInbox, type State } from '../state.js';
import { approvalText, runningSubagents, topicRoots } from '../topic/timeline.js';

export type Sign = 'needs' | 'running' | 'stopped' | 'done' | 'idle';
export interface WorkspaceChip {
  id: string;
  repo: string;
  kind: 'root' | 'worktree';
  branch: string | null;
}
export interface NeedsItem {
  id: string;
  topicId: string;
  chatId: string | null;
  kind: 'plan' | 'question' | 'approval';
  text: string;
  at: number;
}
export interface TopicRow {
  id: string;
  title: string;
  naming: boolean;
  sign: Sign;
  stateText: string;
  unseen: boolean;
  workspaces: WorkspaceChip[];
  lastChatId: string | null;
  needs: NeedsItem[];
  lastActivityAt: number;
  desk: boolean;
  home: string | null;
  liveOn?: string[];
  remote?: RemoteTopic;
}
export interface RemoteTopic {
  computer: string;
  online: boolean;
  lastSeen: number | null;
}
export interface TopicTab {
  chatId: string;
  title: string;
  naming: boolean;
  sign: Sign;
  agent: boolean;
  lastAt: number;
  computer?: string;
}

const SIGN_ORDER: Sign[] = ['needs', 'running', 'stopped', 'idle', 'done'];
const NEEDS_KINDS = new Set<InboxItem['kind']>(['approval', 'question', 'plan']);
const LIVE = new Set<Chat['state']>(['starting', 'running']);

export function topicOfChat(state: State, chatId: string): string | undefined {
  return state.chats[chatId]?.topicId;
}

function needsText(state: State, item: InboxItem, topicId: string): string {
  if (item.kind === 'plan') return item.plan?.text ?? item.title;
  if (item.kind === 'question') return item.questions?.[0]?.question ?? item.title;
  const approval = item.chatId ? state.timeline[item.chatId]?.find((t) => t.kind === 'approval' && t.id === item.id) : undefined;
  return approval?.kind === 'approval' ? approvalText(state.chats[item.chatId!], approval, topicRoots(state, topicId)) : item.title;
}

export function needsYou(state: State): NeedsItem[] {
  return openInbox(state)
    .filter((item) => NEEDS_KINDS.has(item.kind))
    .flatMap((item): NeedsItem[] => {
      const topicId = item.topicId ?? (item.chatId ? topicOfChat(state, item.chatId) : undefined);
      if (!topicId) return [];
      return [{ id: item.id, topicId, chatId: item.chatId, kind: item.kind as NeedsItem['kind'], text: needsText(state, item, topicId), at: item.createdAt }];
    })
    .sort((a, b) => a.at - b.at);
}

function topicChats(state: State, topicId: string): Chat[] {
  return Object.values(state.chats).filter((chat) => chat.topicId === topicId);
}

function newest(state: State, chat: Chat): Chat {
  return lineageChats(state, chat).at(-1) ?? chat;
}

function heads(state: State, topicId: string): Chat[] {
  return topicChats(state, topicId)
    .filter((chat) => chat.generation === 1)
    .sort((a, b) => a.createdAt - b.createdAt);
}

function lastMessageAt(state: State, chat: Chat): number {
  return lineageChats(state, chat).reduce(
    (last, c) => (state.timeline[c.id] ?? []).reduce((at, item) => (item.kind === 'message' && item.at > at ? item.at : at), last),
    chat.createdAt,
  );
}

function lastActive(state: State, chats: Chat[]): Chat | undefined {
  return chats.reduce<Chat | undefined>((best, chat) => (!best || lastMessageAt(state, chat) >= lastMessageAt(state, best) ? chat : best), undefined);
}

function chatSign(state: State, chat: Chat, needs: NeedsItem[]): Sign {
  if (chat.state === 'waiting_input' || needs.some((item) => item.chatId === chat.id)) return 'needs';
  if (LIVE.has(chat.state) || runningSubagents(state, [chat]) > 0) return 'running';
  if (chat.state === 'failed') return 'stopped';
  if (chat.state === 'done') return 'done';
  return 'idle';
}

function topicSign(chats: Chat[], topic: Topic, latest: Chat[], needs: NeedsItem[], subagents: number): Sign {
  if (needs.length > 0) return 'needs';
  if (subagents > 0 || chats.some((chat) => LIVE.has(chat.state))) return 'running';
  if (latest.some((chat) => chat.state === 'failed')) return 'stopped';
  if (topic.state === 'done') return 'done';
  return 'idle';
}

function signText(sign: Sign, last: Chat | undefined, needs: NeedsItem[]): string {
  switch (sign) {
    case 'needs': {
      const kind = needs[0]?.kind;
      return kind === 'plan' ? 'Plan ready for you' : kind === 'question' ? 'Waiting for your answer' : 'Waiting for your approval';
    }
    case 'running':
      return 'Working';
    case 'stopped':
      return 'Failed';
    case 'done':
      return 'Done';
    case 'idle':
      return last?.state === 'killed' ? 'Killed' : last?.state === 'paused' ? 'Paused' : 'Idle';
  }
}

export function topicRow(state: State, topicId: string): TopicRow | undefined {
  const topic = state.topics[topicId];
  if (!topic) return undefined;
  const needs = needsYou(state).filter((item) => item.topicId === topicId);
  const latest = heads(state, topicId).map((head) => newest(state, head));
  const last = lastActive(state, latest);
  const chats = topicChats(state, topicId);
  const subagents = runningSubagents(state, chats);
  const sign = topicSign(chats, topic, latest, needs, subagents);
  return {
    id: topic.id,
    title: topic.title,
    naming: topic.naming,
    sign,
    stateText: signText(sign, last, needs),
    unseen: topicUnseen(topic),
    workspaces: topic.workspaceIds.flatMap((id): WorkspaceChip[] => {
      const workspace = state.workspaces[id];
      if (!workspace) return [];
      const repo = state.projects.find((p) => p.id === workspace.projectId)?.name ?? workspace.name;
      return [{ id, repo, kind: workspace.kind, branch: workspace.branch }];
    }),
    lastChatId: last?.id ?? null,
    needs,
    lastActivityAt: topic.lastActivityAt ?? topic.createdAt,
    desk: topic.desk === true,
    home: topic.home ?? null,
  };
}

const byRow = (a: TopicRow, b: TopicRow) => Number(b.desk) - Number(a.desk) || SIGN_ORDER.indexOf(a.sign) - SIGN_ORDER.indexOf(b.sign) || b.lastActivityAt - a.lastActivityAt;

export function topicRows(state: State): TopicRow[] {
  return Object.values(state.topics)
    .filter((topic) => topic.state !== 'archived')
    .flatMap((topic) => {
      const row = topicRow(state, topic.id);
      return row ? [row] : [];
    })
    .sort(byRow);
}

export function mergedTopicRows(state: State, rows: TopicRow[], view: ComputersView | undefined): TopicRow[] {
  const out = view?.computers.filter((c) => c.direction === 'out') ?? [];
  if (!view || !out.length) return rows;
  const self = view.self.name;
  const live = (chats: Array<Pick<Chat, 'state'> & { computer?: string | null }>, here: string) => chats.filter((c) => LIVE.has(c.state)).map((c) => c.computer ?? here);
  const local = rows.map((row) => ({ ...row, liveOn: live(topicChats(state, row.id), self) }));
  const seen = new Set(Object.keys(state.topics));
  const remote = out.flatMap((computer) =>
    computer.topics.flatMap((topic): TopicRow[] => {
      if (seen.has(topic.id) || topic.home === self || topic.state === 'archived') return [];
      seen.add(topic.id);
      const home = topic.home ?? computer.name;
      const running = live(topic.chats, computer.name);
      const sign: Sign = running.length ? 'running' : topic.state === 'done' ? 'done' : 'idle';
      return [
        {
          id: topic.id,
          title: topic.title,
          naming: false,
          sign,
          stateText: computer.online ? signText(sign, undefined, []) : `${computer.name} is offline`,
          unseen: false,
          workspaces: [],
          lastChatId: null,
          needs: [],
          lastActivityAt: topic.lastActivityAt ?? 0,
          desk: false,
          home,
          liveOn: running,
          remote: { computer: computer.name, online: computer.online, lastSeen: computer.lastSeen },
        },
      ];
    }),
  );
  return [...local, ...remote].sort(byRow);
}

export function deskTopicId(state: State): string | undefined {
  return Object.values(state.topics).find((topic) => topic.desk)?.id;
}

export function deskTitle(state: State): string {
  return Object.values(state.topics).find((topic) => topic.desk)?.title ?? 'Quick chats';
}

function helperTitle(chat: Chat): string {
  const role = chat.role.charAt(0).toUpperCase() + chat.role.slice(1);
  return chat.intent ? `${role}, ${chat.intent}` : role;
}

function chatTitle(state: State, chat: Chat): string {
  const first = state.timeline[chat.lineageId]?.find((item) => item.kind === 'message' && item.role === 'user');
  return (first?.kind === 'message' && first.text.split('\n')[0]?.trim()) || 'New chat';
}

function headTitle(state: State, head: Chat): string {
  const chat = newest(state, head);
  return head.title ?? (chat.role === 'main' ? chatTitle(state, chat) : helperTitle(chat));
}

export function topicTabs(state: State, topicId: string): TopicTab[] {
  if (!state.topics[topicId]) return [];
  const needs = needsYou(state).filter((item) => item.topicId === topicId);
  return heads(state, topicId).map((head) => {
    const chat = newest(state, head);
    return {
      chatId: chat.id,
      title: headTitle(state, head),
      naming: head.naming,
      sign: chatSign(state, chat, needs),
      agent: head.createdBy === 'agent',
      lastAt: lastMessageAt(state, chat),
      ...(chat.computer ? { computer: chat.computer } : {}),
    };
  });
}

export interface ChatHead {
  lineageId: string;
  chatId: string;
  topicId: string;
  title: string;
  topicTitle: string;
  archived: boolean;
}

export function chatHeads(state: State): ChatHead[] {
  return Object.values(state.chats)
    .filter((head) => head.generation === 1 && state.topics[head.topicId])
    .map((head) => {
      const topic = state.topics[head.topicId]!;
      return { lineageId: head.lineageId, chatId: newest(state, head).id, topicId: topic.id, title: headTitle(state, head), topicTitle: topic.title, archived: topic.state === 'archived' };
    });
}

export function startTopic(
  text: string,
  pick: { model?: string; effort?: Effort; agent?: string; chrome?: boolean; desk?: boolean; profile?: string; computer?: string },
  files: Array<{ name: string; data: string }> = [],
): Promise<{ topicId: string; chatId: string }> {
  return client.startTopic({
    text,
    ...(pick.model ? { model: pick.model } : {}),
    ...(pick.effort ? { effort: pick.effort } : {}),
    ...(pick.agent ? { agent: pick.agent } : {}),
    ...(pick.chrome ? { chrome: true } : {}),
    ...(pick.desk ? { desk: true } : {}),
    ...(pick.profile ? { profile: pick.profile } : {}),
    ...(pick.computer ? { computer: pick.computer } : {}),
    ...(files.length ? { files } : {}),
  });
}

export async function markSeen(topicId: string): Promise<void> {
  await client.markTopicSeen(topicId);
}

export async function markAllSeen(): Promise<void> {
  await client.markAllTopicsSeen();
}

export async function killEverything(): Promise<void> {
  await client.kill({ scope: 'global' });
}

export async function sendToChat(chatId: string, text: string): Promise<void> {
  await client.sendMessage(chatId, text);
}
