import type {
  ActionClass,
  ActionRun,
  ApprovalDecision,
  BusOutcome,
  Chat,
  ChatLink,
  ContextSlice,
  DiffAction,
  HosEvent,
  InboxItem,
  Lock,
  DevServer,
  Project,
  SubagentEnd,
  Task,
  Topic,
  Workspace,
  Worktree,
} from './types.js';

export type TimelineItem =
  | {
      kind: 'message';
      id: string;
      role: 'user' | 'hos' | 'chat' | 'assistant' | 'error';
      text: string;
      done: boolean;
      at: number;
      attachments?: Array<{ name: string; path: string }>;
      canvas?: string;
    }
  | { kind: 'thinking'; id: string; text: string; done: boolean }
  | { kind: 'tool'; id: string; name: string; input: string; output?: string; isError?: boolean; parent?: string }
  | {
      kind: 'approval';
      id: string;
      tool: string;
      title?: string;
      input: string;
      actionClass: ActionClass | null;
      reason: string;
      createdAt: number;
      decision?: ApprovalDecision | 'cancelled';
    }
  | { kind: 'policy'; id: string; tool: string; decision: 'approve' | 'deny'; reason: string }
  | { kind: 'bus'; id: string; tool: string; outcome: BusOutcome; tokens: number; message?: string }
  | { kind: 'lifecycle'; id: string; text: string }
  | { kind: 'divider'; id: string; text: string; at: number };

export interface Subagent {
  chatId: string;
  description: string;
  agentType: string | null;
  depth: number;
  prompt: string;
  status: 'running' | SubagentEnd;
  startedAt: number;
  endedAt?: number;
  tokens: number;
  tools: number;
  durationMs: number;
  lastTool: string | null;
  summary: string;
}

export interface DiffActionNote {
  seq: number;
  action: DiffAction;
  state: 'done' | 'failed' | 'denied';
  detail: string;
}

export interface State {
  lastSeq: number;
  projects: Project[];
  worktrees: Record<string, Worktree>;
  topics: Record<string, Topic>;
  workspaces: Record<string, Workspace>;
  chats: Record<string, Chat>;
  timeline: Record<string, TimelineItem[]>;
  subagents: Record<string, Subagent>;
  inbox: Record<string, InboxItem>;
  diffActions: Record<string, DiffActionNote>;
  terminals: Record<string, string>;
  servers: DevServer[];
  actionRuns: Record<string, ActionRun>;
  holds: Record<string, { priority: number; reason: string }>;
  refreshing: Record<string, true>;
  locks: Record<string, Lock>;
  tasks: Record<string, Task>;
  workspaceGitSeq: Record<string, number>;
  diagramSeq: number;
  canvasSeq: Record<string, number>;
  links: Record<string, ChatLink[]>;
  context: Record<string, { tokens: number; handoff: number; breakdown?: ContextSlice[] }>;
}

export interface Snapshot {
  seq: number;
  state: State;
}

export const initialState: State = {
  lastSeq: 0,
  projects: [],
  worktrees: {},
  topics: {},
  workspaces: {},
  chats: {},
  timeline: {},
  subagents: {},
  inbox: {},
  diffActions: {},
  terminals: {},
  servers: [],
  actionRuns: {},
  holds: {},
  refreshing: {},
  locks: {},
  tasks: {},
  workspaceGitSeq: {},
  diagramSeq: 0,
  canvasSeq: {},
  links: {},
  context: {},
};

export function applyEvents(state: State, events: readonly HosEvent[]): State {
  return events.reduce(applyEvent, state);
}

export function applyEvent(state: State, event: HosEvent): State {
  if (event.seq <= state.lastSeq) return state;
  const next = { ...state, lastSeq: event.seq };
  switch (event.type) {
    case 'project.created':
      return { ...next, projects: [...state.projects, event.project] };
    case 'project.updated':
      return { ...next, projects: state.projects.map((p) => (p.id === event.project.id ? event.project : p)) };
    case 'project.removed':
      return {
        ...next,
        projects: state.projects.filter((p) => p.id !== event.projectId),
        worktrees: Object.fromEntries(Object.entries(state.worktrees).filter(([, w]) => w.projectId !== event.projectId)),
      };
    case 'worktree.updated':
      return { ...next, worktrees: { ...state.worktrees, [event.worktree.path]: event.worktree } };
    case 'worktree.removed': {
      const { [event.path]: _removed, ...worktrees } = state.worktrees;
      return { ...next, worktrees };
    }
    case 'topic.created':
    case 'topic.updated':
      return { ...next, topics: { ...state.topics, [event.topic.id]: event.topic } };
    case 'workspace.created':
    case 'workspace.updated':
      return { ...next, workspaces: { ...state.workspaces, [event.workspace.id]: event.workspace } };
    case 'chat.created':
      return { ...next, chats: { ...state.chats, [event.chat.id]: event.chat } };
    case 'chat.state': {
      const chat = state.chats[event.chatId];
      return chat ? { ...next, chats: { ...state.chats, [chat.id]: { ...chat, state: event.state } } } : next;
    }
    case 'chat.error':
      return upsert(next, event.chatId, { kind: 'message', id: `error-${event.seq}`, role: 'error', text: event.message, done: true, at: event.ts });
    case 'message.user':
      return upsert(next, event.chatId, {
        kind: 'message',
        id: event.messageId,
        role: event.from ?? 'user',
        text: event.text,
        done: true,
        at: event.ts,
        ...(event.attachments?.length ? { attachments: event.attachments } : {}),
        ...(event.canvas ? { canvas: event.canvas } : {}),
      });
    case 'message.delta': {
      const existing = find(state, event.chatId, event.messageId);
      const text = (existing?.kind === 'message' ? existing.text : '') + event.text;
      return upsert(next, event.chatId, { kind: 'message', id: event.messageId, role: 'assistant', text, done: false, at: event.ts });
    }
    case 'message.completed':
      return upsert(next, event.chatId, { kind: 'message', id: event.messageId, role: 'assistant', text: event.text, done: true, at: event.ts });
    case 'thinking.delta': {
      const existing = find(state, event.chatId, event.thinkingId);
      const text = (existing?.kind === 'thinking' ? existing.text : '') + event.text;
      return upsert(next, event.chatId, { kind: 'thinking', id: event.thinkingId, text, done: false });
    }
    case 'thinking.completed':
      return upsert(next, event.chatId, { kind: 'thinking', id: event.thinkingId, text: event.text, done: true });
    case 'tool.started':
      return upsert(next, event.chatId, {
        kind: 'tool',
        id: event.toolUseId,
        name: event.name,
        input: event.input,
        ...(event.parentToolUseId ? { parent: event.parentToolUseId } : {}),
      });
    case 'tool.completed': {
      const existing = find(state, event.chatId, event.toolUseId);
      if (existing?.kind !== 'tool') return next;
      return upsert(next, event.chatId, { ...existing, output: event.output, isError: event.isError });
    }
    case 'subagent.started': {
      const subagent: Subagent = {
        chatId: event.chatId,
        description: event.description,
        agentType: event.agentType,
        depth: event.depth,
        prompt: event.prompt,
        status: 'running',
        startedAt: event.ts,
        tokens: 0,
        tools: 0,
        durationMs: 0,
        lastTool: null,
        summary: '',
      };
      return { ...next, subagents: { ...state.subagents, [event.toolUseId]: subagent } };
    }
    case 'subagent.progress': {
      const subagent = state.subagents[event.toolUseId];
      if (!subagent) return next;
      const { tokens, tools, durationMs, lastTool } = event;
      return { ...next, subagents: { ...state.subagents, [event.toolUseId]: { ...subagent, tokens, tools, durationMs, lastTool } } };
    }
    case 'subagent.finished': {
      const subagent = state.subagents[event.toolUseId];
      if (!subagent) return next;
      const ended = {
        ...subagent,
        status: event.status,
        summary: event.summary,
        endedAt: event.ts,
        tokens: event.tokens ?? subagent.tokens,
        tools: event.tools ?? subagent.tools,
        durationMs: event.durationMs ?? subagent.durationMs,
      };
      return { ...next, subagents: { ...state.subagents, [event.toolUseId]: ended } };
    }
    case 'approval.requested':
      if (event.chatId === null) {
        const item: InboxItem = {
          id: event.approvalId,
          kind: 'approval',
          chatId: null,
          ...(event.topicId ? { topicId: event.topicId } : {}),
          ...(event.workspaceId ? { workspaceId: event.workspaceId } : {}),
          title: event.title ?? event.tool,
          detail: event.input,
          state: 'open',
          createdAt: event.ts,
          actionClass: event.actionClass,
        };
        return { ...next, inbox: { ...state.inbox, [item.id]: item } };
      }
      return upsert(next, event.chatId, {
        kind: 'approval',
        id: event.approvalId,
        tool: event.tool,
        ...(event.title ? { title: event.title } : {}),
        input: event.input,
        actionClass: event.actionClass,
        reason: event.reason,
        createdAt: event.ts,
      });
    case 'approval.resolved': {
      if (event.chatId === null) {
        const item = state.inbox[event.approvalId];
        return item ? { ...next, inbox: { ...state.inbox, [item.id]: { ...item, state: 'done' } } } : next;
      }
      const existing = find(state, event.chatId, event.approvalId);
      if (existing?.kind !== 'approval') return next;
      return upsert(next, event.chatId, { ...existing, decision: event.decision });
    }
    case 'chat.takeover':
      return { ...next, terminals: { ...state.terminals, [event.chatId]: event.terminal } };
    case 'chat.handback': {
      const { [event.chatId]: _handedBack, ...terminals } = state.terminals;
      return { ...next, terminals };
    }
    case 'approval.policy':
      if (event.chatId === null) return next;
      return upsert(next, event.chatId, {
        kind: 'policy',
        id: event.approvalId,
        tool: event.tool,
        decision: event.decision,
        reason: event.reason,
      });
    case 'diff.action': {
      const note = { seq: event.seq, action: event.action, state: event.state, detail: event.detail };
      return { ...next, diffActions: { ...state.diffActions, [event.workspaceId]: note } };
    }
    case 'action.run':
      return { ...next, actionRuns: { ...state.actionRuns, [event.run.id]: event.run } };
    case 'action.output': {
      const run = state.actionRuns[event.runId];
      return run ? { ...next, actionRuns: { ...state.actionRuns, [run.id]: { ...run, output: run.output + event.text } } } : next;
    }
    case 'inbox.added':
    case 'inbox.updated':
      return { ...next, inbox: { ...state.inbox, [event.item.id]: event.item } };
    case 'bus.call':
      return upsert(next, event.chatId, {
        kind: 'bus',
        id: `bus-${event.seq}`,
        tool: event.tool,
        outcome: event.outcome,
        tokens: event.tokens,
        ...(event.message ? { message: event.message } : {}),
      });
    case 'servers.updated':
      return { ...next, servers: event.servers };
    case 'chat.result':
      return next;
    case 'chat.queued':
      return { ...next, holds: { ...state.holds, [event.chatId]: { priority: event.priority, reason: event.reason } } };
    case 'chat.suspended': {
      const chat = state.chats[event.chatId];
      return chat ? { ...next, chats: { ...state.chats, [chat.id]: { ...chat, suspended: event.suspended } } } : next;
    }
    case 'chat.restarted':
      return note(next, event.chatId, event.seq, 'Restarted by you');
    case 'context.refresh_requested':
      return { ...next, refreshing: { ...state.refreshing, [event.chatId]: true } };
    case 'context.refresh_failed':
      return note({ ...next, refreshing: without(state.refreshing, event.chatId) }, event.chatId, event.seq, `Context refresh cancelled: ${event.problems.join('; ')}`);
    case 'context.refreshed':
      return upsert({ ...next, refreshing: without(state.refreshing, event.chatId) }, event.chatId, { kind: 'divider', id: `divider-${event.seq}`, text: 'Context refreshed', at: event.ts });
    case 'tokens.used':
      return next;
    case 'lock.acquired':
      return { ...next, locks: { ...state.locks, [event.lock.id]: event.lock } };
    case 'lock.released': {
      const { [event.lock.id]: _released, ...locks } = state.locks;
      return { ...next, locks };
    }
    case 'task.updated':
      return { ...next, tasks: { ...state.tasks, [`${event.task.topicId}:${event.task.ref}`]: event.task } };
    case 'handoff.requested':
      return note(next, event.chatId, event.seq, `Handoff requested · into ${event.dir}`);
    case 'handoff.rejected':
      return note(next, event.chatId, event.seq, `Handoff rejected${event.final ? ' again; salvaging' : ''}: ${event.problems.join('; ')}`);
    case 'handoff.completed': {
      const { handoff } = event;
      const how = handoff.kind === 'agent' ? 'written by the chat' : `salvaged by hos (${handoff.reason})`;
      return note(next, event.chatId, event.seq, `Handed off to generation ${handoff.generation + 1}, ${how} · ${handoff.path}`);
    }
    case 'context.compacted':
      return note(next, event.chatId, event.seq, event.blocked ? 'Native compaction blocked by hos' : 'Native compaction ran');
    case 'workspace.deleted': {
      const workspaces = { ...state.workspaces };
      delete workspaces[event.workspaceId];
      return { ...next, workspaces };
    }
    case 'workspace.picked': {
      if (!event.chatId) return next;
      const where = `${event.purpose === 'read' ? 'Reading' : 'Working in'} ${event.repo} · ${event.branch ?? state.workspaces[event.workspaceId]?.name ?? 'detached'}`;
      const setting = event.setup === 'pending' || event.setup === 'running' ? ' · setting up…' : '';
      return note(next, event.chatId, event.seq, `${where}${setting}${event.rule ? ` · Brain rule: ${event.rule}` : ''}`);
    }
    case 'workspace.git':
      return { ...next, workspaceGitSeq: { ...state.workspaceGitSeq, [event.workspaceId]: event.seq } };
    case 'diagram.changed':
      return { ...next, diagramSeq: event.seq };
    case 'canvas.created':
    case 'canvas.updated':
    case 'canvas.submitted':
      return { ...next, canvasSeq: { ...state.canvasSeq, [`${event.topicId}/${event.ref}`]: event.seq } };
    case 'chat.pick': {
      const chat = state.chats[event.chatId];
      return chat ? { ...next, chats: { ...state.chats, [chat.id]: { ...chat, model: event.model, effort: event.effort } } } : next;
    }
    case 'chat.titled': {
      const chat = state.chats[event.chatId];
      return chat ? { ...next, chats: { ...state.chats, [chat.id]: { ...chat, title: event.title, naming: event.naming } } } : next;
    }
    case 'chat.tab': {
      const chat = state.chats[event.chatId];
      return chat ? { ...next, chats: { ...state.chats, [chat.id]: { ...chat, tabClosed: event.closed } } } : next;
    }
    case 'chat.notify': {
      const chat = state.chats[event.chatId];
      return chat ? { ...next, chats: { ...state.chats, [chat.id]: { ...chat, notify: event.notify } } } : next;
    }
    case 'topic.tabs': {
      const topic = state.topics[event.topicId];
      return topic ? { ...next, topics: { ...state.topics, [topic.id]: { ...topic, tabOrder: event.order } } } : next;
    }
    case 'chat.links': {
      const linked = { ...next, links: { ...state.links, [event.lineageId]: event.links } };
      return event.chatId && event.note ? note(linked, event.chatId, event.seq, event.note) : linked;
    }
    case 'context.usage':
      return { ...next, context: { ...state.context, [event.chatId]: { ...state.context[event.chatId], tokens: event.tokens, handoff: event.limits.handoff } } };
    case 'context.breakdown': {
      const known = state.context[event.chatId] ?? { tokens: 0, handoff: 0 };
      return { ...next, context: { ...state.context, [event.chatId]: { ...known, breakdown: event.categories } } };
    }
  }
  return next;
}

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _gone, ...rest } = record;
  return rest;
}

function note(state: State, chatId: string, seq: number, text: string): State {
  return upsert(state, chatId, { kind: 'lifecycle', id: `lifecycle-${seq}`, text });
}

export function lineageHeads(state: State, topicId: string): Chat[] {
  return Object.values(state.chats).filter((c) => c.topicId === topicId && c.generation === 1);
}

export function lineageChats(state: State, chat: Chat): Chat[] {
  return Object.values(state.chats)
    .filter((c) => c.lineageId === chat.lineageId)
    .sort((a, b) => a.generation - b.generation);
}

export function openInbox(state: State): InboxItem[] {
  const approvals = Object.entries(state.timeline).flatMap(([chatId, items]) =>
    items.flatMap((item): InboxItem[] =>
      item.kind === 'approval' && !item.decision
        ? [
            {
              id: item.id,
              kind: 'approval',
              chatId,
              title: item.title ?? item.tool,
              detail: item.input,
              state: 'open',
              createdAt: item.createdAt,
              actionClass: item.actionClass,
            },
          ]
        : [],
    ),
  );
  const others = Object.values(state.inbox).filter((item) => item.state === 'open');
  return [...approvals, ...others].sort((a, b) => b.createdAt - a.createdAt);
}

function find(state: State, chatId: string, id: string): TimelineItem | undefined {
  return state.timeline[chatId]?.findLast((item) => item.id === id);
}

function upsert(state: State, chatId: string, item: TimelineItem): State {
  const items = state.timeline[chatId] ?? [];
  const index = items.findLastIndex((i) => i.id === item.id);
  const updated = index === -1 ? [...items, item] : items.with(index, item);
  return { ...state, timeline: { ...state.timeline, [chatId]: updated } };
}
