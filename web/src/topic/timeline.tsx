import { useEffect, useId, useState, type ReactNode } from 'react';
import { LOGIN_FAILURE, NOTICE_HEADER_RE, type Chat, type InboxItem } from '../../../src/api/types.js';
import { CanvasCard, CanvasSent, CanvasStub } from '../canvas/CanvasCard.js';
import { ApplyCard } from '../diagrams/ApplyCard.js';
import { client, useAction } from '../lib.js';
import { TerminalView } from '../Terminal.js';
import { Icon, SignMark } from '../shell/icons.js';
import { topicHref } from '../shell/routes.js';
import type { Sign } from '../model/index.js';
import type { State, Subagent, TimelineItem } from '../state.js';
import { agentLabel } from './catalog.js';
import { Markdown, type FileRoots } from './markdown.js';
import { Wrap } from './TopicHeader.js';
import { When } from './when.js';
import { shortPath } from './where.js';

type ToolItem = Extract<TimelineItem, { kind: 'tool' }>;
type BusItem = Extract<TimelineItem, { kind: 'bus' }>;
type PolicyItem = Extract<TimelineItem, { kind: 'policy' }>;
type Step = ToolItem | BusItem | PolicyItem;

const DENIED = /^.+ denied this request\.$/;
const BUS = 'mcp__hos__';
const PLAN_TOOLS = new Set([`${BUS}propose_plan`]);
const QUESTION_TOOLS = new Set(['AskUserQuestion', `${BUS}ask`]);
const DIAGRAM_TOOLS = new Set([`${BUS}diagram_apply`, `${BUS}diagram_import_mermaid`]);
const CANVAS_TOOLS = new Set([`${BUS}canvas_create`, `${BUS}canvas_update`]);
const CANVAS_RESULT = /^(C\d+) v(\d+)$/;

function canvasStep(step: Step): { ref: string; version: string } | undefined {
  if (step.kind !== 'tool' || !CANVAS_TOOLS.has(step.name) || step.isError) return undefined;
  const m = CANVAS_RESULT.exec(step.output ?? '');
  return m ? { ref: m[1]!, version: m[2]! } : undefined;
}

function diagramApply(step: ToolItem): { diagramId: string; applyId: string; summary: string } | undefined {
  const applyId = /\(apply (\w+)\)/.exec(step.output ?? '')?.[1];
  const args = parse(step.input);
  const diagramId = str(args.id);
  if (!applyId || !diagramId) return undefined;
  const made = /new ids: ([^.]+)\./.exec(step.output!)?.[1]?.split(',').length ?? Number(/as (\d+) element/.exec(step.output!)?.[1] ?? 0);
  const ops = Array.isArray(args.ops) ? args.ops.length : 0;
  return { diagramId, applyId, summary: made ? `+${made} shape${made === 1 ? '' : 's'}` : `${ops} change${ops === 1 ? '' : 's'}` };
}

export interface ToolRow {
  id: string;
  name: string;
  target: string;
  status: 'ok' | 'running' | 'failed' | 'denied' | 'refused' | 'auto-approved' | 'denied by policy';
}

function parse(input: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(input);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const str = (value: unknown) => (typeof value === 'string' ? value : '');

export function topicRoots(state: State, topicId: string | undefined): string[] {
  const ids = (topicId && state.topics[topicId]?.workspaceIds) || [];
  return ids.flatMap((id) => state.workspaces[id]?.path ?? []).sort((a, b) => b.length - a.length);
}

function fileRoots(state: State, topicId: string | undefined): FileRoots {
  const workspaces = ((topicId && state.topics[topicId]?.workspaceIds) || []).flatMap((id) => state.workspaces[id]?.path ?? []);
  return {
    known: [...workspaces, ...state.projects.map((project) => project.path)].sort((a, b) => b.length - a.length),
    relativeTo: workspaces[0] ?? state.projects.find((project) => project.brain)?.path,
  };
}

function clip(text: string, max = 48): string {
  const line = text.split('\n')[0]!.trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function target(name: string, args: Record<string, unknown>, roots: string[]): string {
  if (name.startsWith(BUS)) {
    const tool = name.slice(BUS.length);
    if (tool === 'spawn') return `spawn ${str(args.role)} "${clip(str(args.intent), 60)}"`;
    if (tool === 'update_card') return `update_card "${clip(str(args.text), 60)}"`;
    if (tool === 'propose_plan') return `propose_plan "${clip(str(args.title), 60)}"`;
    const first = Object.values(args).find((v) => typeof v === 'string') as string | undefined;
    return first ? `${tool} ${clip(first, 60)}` : tool;
  }
  const path = str(args.file_path) || str(args.notebook_path) || str(args.path);
  if (path) return shortPath(path, roots);
  if (args.command) return clip(str(args.command), 80);
  if (args.pattern) return clip(str(args.pattern), 80);
  if (args.url) return clip(str(args.url), 80);
  if (args.query) return clip(str(args.query), 80);
  if (args.description) return clip(str(args.description), 80);
  return '';
}

function phrase(name: string, args: Record<string, unknown>, roots: string[]): string {
  const path = shortPath(str(args.file_path) || str(args.notebook_path) || str(args.path), roots);
  switch (name) {
    case 'Read':
      return `read ${path || 'a file'}`;
    case 'Write':
      return `wrote ${path || 'a file'}`;
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `edited ${path || 'a file'}`;
    case 'Bash':
      return `ran ${clip(str(args.command), 40) || 'a command'}`;
    case 'Grep':
      return `searched for "${clip(str(args.pattern), 30)}"`;
    case 'Glob':
      return `listed ${clip(str(args.pattern), 30)}`;
    case 'WebFetch': {
      const url = str(args.url);
      try {
        return `fetched ${new URL(url).host}`;
      } catch {
        return 'fetched a page';
      }
    }
    case 'WebSearch':
      return `searched the web for "${clip(str(args.query), 30)}"`;
    case 'AskUserQuestion':
      return 'asked you a question';
    case 'Task':
    case 'Agent':
      return 'started a subagent';
    case 'TodoWrite':
      return 'updated its to-do list';
    case 'Skill':
      return `used the ${str(args.skill) || str(args.name) || 'a'} skill`;
  }
  if (name.startsWith(BUS)) {
    const tool = name.slice(BUS.length);
    const role = str(args.role);
    if (tool === 'spawn') return role === 'scout' ? `asked a scout about ${clip(str(args.intent), 40)}` : `started a ${role || 'helper'} on ${clip(str(args.intent), 40)}`;
    if (tool === 'update_card') return 'updated its card';
    if (tool === 'propose_plan') return 'proposed a plan';
    if (tool === 'ask') return 'asked you a question';
    if (tool === 'send') return 'messaged another chat';
    if (tool === 'wait') return 'waited on a helper';
    if (tool === 'complete') return 'handed in its result';
    return `used ${tool}`;
  }
  if (name.startsWith('mcp__')) {
    const [, server, tool] = name.split('__');
    return `used ${server} ${tool ?? ''}`.trim();
  }
  return `used ${name}`;
}

function wants(tool: string, args: Record<string, unknown>, roots: string[]): string {
  const path = shortPath(str(args.file_path) || str(args.notebook_path) || str(args.path), roots);
  switch (tool) {
    case 'Write':
      return `write ${path || 'a file'}`;
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `edit ${path || 'a file'}`;
    case 'Bash':
      return `run ${clip(str(args.command), 60) || 'a command'}`;
    case 'Read':
      return `read ${path || 'a file'}`;
    case 'WebFetch':
      return `fetch ${clip(str(args.url), 60) || 'a page'}`;
    case 'WebSearch':
      return `search the web for "${clip(str(args.query), 40)}"`;
  }
  if (tool.startsWith(BUS)) return `use ${tool.slice(BUS.length)}`;
  return `use ${tool}`;
}

export function approvalText(chat: Chat | undefined, item: { tool: string; title?: string; input: string }, roots: string[] = []): string {
  if (item.title) return item.title;
  const who = chat?.parentId ? `${chat.role.charAt(0).toUpperCase()}${chat.role.slice(1)}` : agentLabel(chat?.agent);
  return `${who} wants to ${wants(item.tool, parse(item.input), roots)}`;
}

export function summarise(steps: Step[], roots: string[] = []): string {
  const phrases: string[] = [];
  for (const step of steps) {
    if (step.kind !== 'tool') continue;
    const said = phrase(step.name, parse(step.input), roots);
    if (!phrases.includes(said)) phrases.push(said);
  }
  if (!phrases.length) {
    const policy = steps.find((s): s is PolicyItem => s.kind === 'policy');
    if (policy) return `${policy.decision === 'deny' ? 'Was refused' : 'Was allowed'} ${policy.tool}`;
    const bus = steps.find((s): s is BusItem => s.kind === 'bus');
    return bus ? `Used ${bus.tool}` : 'Used tools';
  }
  const shown = phrases.slice(0, 3);
  const rest = phrases.length - shown.length;
  const text = rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.length > 1 ? `${shown.slice(0, -1).join(', ')}, ${shown.at(-1)}` : shown[0]!;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function toolRows(steps: Step[], roots: string[] = []): ToolRow[] {
  const bus = steps.filter((s): s is BusItem => s.kind === 'bus');
  const used = new Set<BusItem>();
  const rows: ToolRow[] = [];
  for (const step of steps) {
    if (step.kind === 'tool') {
      const isBus = step.name.startsWith(BUS);
      const match = isBus ? bus.find((b) => !used.has(b) && `${BUS}${b.tool}` === step.name) : undefined;
      if (match) used.add(match);
      const status: ToolRow['status'] =
        step.output === undefined
          ? 'running'
          : match && match.outcome !== 'ok'
            ? 'refused'
            : step.isError
              ? DENIED.test(step.output)
                ? 'denied'
                : 'failed'
              : 'ok';
      rows.push({ id: step.id, name: isBus ? 'bus' : step.name, target: target(step.name, parse(step.input), roots), status });
    } else if (step.kind === 'policy') {
      rows.push({ id: step.id, name: step.tool, target: step.reason, status: step.decision === 'approve' ? 'auto-approved' : 'denied by policy' });
    }
  }
  for (const b of bus) if (!used.has(b)) rows.push({ id: b.id, name: 'bus', target: b.tool, status: b.outcome === 'ok' ? 'ok' : 'refused' });
  return rows;
}

function ToolList({ rows }: { rows: ToolRow[] }) {
  return (
    <div className="tools" role="list" aria-label="Tool calls">
      {rows.map((row) => (
        <div key={row.id} className="tool" role="listitem">
          <span className="name">{row.name}</span>
          <code title={row.target}>{row.target}</code>
          <span className={`st ${row.status === 'running' ? 'run' : row.status === 'ok' || row.status === 'auto-approved' ? '' : 'bad'}`}>{row.status}</span>
        </div>
      ))}
    </div>
  );
}

function Turn({ steps, open, roots }: { steps: Step[]; open?: boolean; roots: string[] }) {
  return (
    <details className="turn" open={open}>
      <summary>
        <Icon id="i-chev-r" />
        {summarise(steps, roots)}
      </summary>
      <ToolList rows={toolRows(steps, roots)} />
    </details>
  );
}

const AGENT_TOOLS = new Set(['Agent', 'Task']);
const SUBAGENT_SIGNS: Record<Subagent['status'], Sign> = { running: 'running', completed: 'done', failed: 'stopped', stopped: 'stopped' };

function isSubagent(step: { name: string; id: string }, state: State): boolean {
  return AGENT_TOOLS.has(step.name) || (step.name === 'SendMessage' && state.subagents[step.id] !== undefined);
}

function subagentStatus(step: ToolItem, subagent: Subagent | undefined): Subagent['status'] {
  if (subagent) return subagent.status;
  if (step.output !== undefined) return step.isError ? 'failed' : 'completed';
  return 'running';
}

const runningByChat = new WeakMap<State['subagents'], Map<string, number>>();

export function runningSubagents(state: State, chats: Chat[]): number {
  let counts = runningByChat.get(state.subagents);
  if (!counts) {
    counts = new Map();
    for (const subagent of Object.values(state.subagents)) {
      if (subagent.status === 'running') counts.set(subagent.chatId, (counts.get(subagent.chatId) ?? 0) + 1);
    }
    runningByChat.set(state.subagents, counts);
  }
  let sum = 0;
  for (const chat of chats) sum += counts.get(chat.id) ?? 0;
  return sum;
}

function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}

function tokenCount(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}

function useNow(ticking: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

function SubagentCard({ step, state, kidsOf, roots }: { step: ToolItem; state: State; kidsOf: Map<string, ToolItem[]>; roots: string[] }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const subagent = state.subagents[step.id];
  const args = parse(step.input);
  const status = subagentStatus(step, subagent);
  const now = useNow(status === 'running');
  const kids = kidsOf.get(step.id) ?? [];
  const type = subagent?.agentType ?? (str(args.subagent_type) || 'Agent');
  const description = subagent?.description ?? str(args.description);
  const prompt = subagent?.prompt || str(args.prompt);
  const took = subagent && (status === 'running' ? now - subagent.startedAt : subagent.durationMs || (subagent.endedAt ?? now) - subagent.startedAt);
  const tools = Math.max(subagent?.tools ?? 0, kids.length);
  const lastTool = subagent?.lastTool ?? kids.at(-1)?.name;
  const result = step.name === 'SendMessage' ? subagent?.summary || step.output : (step.output ?? (subagent?.summary || undefined));
  const parts = [
    description,
    took !== undefined ? elapsed(took) : '',
    `${tools} tool${tools === 1 ? '' : 's'}`,
    subagent?.tokens ? `${tokenCount(subagent.tokens)} tok` : '',
    lastTool ? `▸ ${lastTool}` : '',
  ].filter(Boolean);
  const body: ReactNode[] = [];
  let group: ToolItem[] = [];
  const flush = () => {
    if (group.length) body.push(<ToolList key={`tools-${group[0]!.id}`} rows={toolRows(group, roots)} />);
    group = [];
  };
  for (const kid of kids) {
    if (!isSubagent(kid, state)) {
      group.push(kid);
      continue;
    }
    flush();
    body.push(<SubagentCard key={kid.id} step={kid} state={state} kidsOf={kidsOf} roots={roots} />);
  }
  flush();
  return (
    <section className={`subagent ${status}`} aria-label={`Subagent ${type}: ${description}`} data-depth={subagent?.depth ?? 1}>
      <button type="button" className="subagent-head" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(!open)}>
        <Icon id="i-chev-r" />
        <SignMark sign={SUBAGENT_SIGNS[status]} label={status} />
        <b>{type}</b>
        <span className="subagent-meta">{parts.join(' · ')}</span>
      </button>
      {open && (
        <div className="subagent-body" id={bodyId}>
          {prompt && (
            <details className="subagent-prompt">
              <summary>Prompt</summary>
              <p>{prompt}</p>
            </details>
          )}
          {body}
          {result !== undefined && <p className="subagent-result">{result}</p>}
        </div>
      )}
    </section>
  );
}

export function chatSignOf(chat: Chat, open: InboxItem[]): Sign {
  if (chat.state === 'waiting_input' || open.some((item) => item.chatId === chat.id)) return 'needs';
  if (chat.state === 'starting' || chat.state === 'running' || chat.state === 'handing_off') return 'running';
  if (chat.state === 'failed') return 'stopped';
  if (chat.state === 'done') return 'done';
  return 'idle';
}

const SPAWN_WORDS: Record<Sign, string> = { needs: 'needs you', running: 'is working', stopped: 'stopped', done: 'is done', idle: 'is idle' };

function SpawnLine({ chat, state, open, intent, role }: { chat: Chat | undefined; state: State; open: InboxItem[]; intent: string; role: string }) {
  const title = `${role.charAt(0).toUpperCase()}${role.slice(1)}, ${intent}`;
  if (!chat) return null;
  const newest = Object.values(state.chats)
    .filter((c) => c.lineageId === chat.lineageId)
    .sort((a, b) => b.generation - a.generation)[0]!;
  const sign = chatSignOf(newest, open);
  return (
    <a className="spawn" href={topicHref(chat.topicId, newest.id)}>
      <SignMark sign={sign} label={false} />
      <span>
        <b>{title}</b> <span className="muted">{SPAWN_WORDS[sign]}</span>
      </span>
    </a>
  );
}

export function Resolved({ text, no }: { text: string; no?: boolean }) {
  return (
    <div className={`thread-card thread-resolved${no ? ' thread-no' : ''}`} role="note">
      <svg className="sign" aria-hidden="true" focusable="false">
        <use href={no ? '#s-stop' : '#s-go'} />
      </svg>
      {text}
    </div>
  );
}

function Attachments({ files, sent }: { files: Array<{ name: string; path: string }>; sent: boolean }) {
  return (
    <div className="thread-atts">
      {files.map((file) => (
        <AttachmentChip key={file.path} name={file.name} title={file.path} note={sent ? 'copied to topic attachments' : 'copies to topic attachments'} />
      ))}
    </div>
  );
}

export function AttachmentChip({ name, title, note, children }: { name: string; title: string; note: string; children?: ReactNode }) {
  return (
    <span className="thread-att" title={title}>
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="m13 7.5-5.2 5.2a3.2 3.2 0 0 1-4.5-4.5L8.8 2.7a2.1 2.1 0 0 1 3 3L6.4 11.1a1.1 1.1 0 0 1-1.5-1.5l4.8-4.8" />
      </svg>
      <code>{name}</code>
      <span className="thread-att-note">{note}</span>
      {children}
    </span>
  );
}

export function timelineRows(chats: Chat[], state: State, open: InboxItem[]): ReactNode[] {
  const ids = new Set(chats.map((c) => c.id));
  const closed = Object.values(state.inbox)
    .filter((item) => item.chatId && ids.has(item.chatId) && item.state === 'done' && !item.picker)
    .sort((a, b) => a.createdAt - b.createdAt);
  const plans = closed.filter((item) => item.kind === 'plan');
  const questions = closed.filter((item) => item.kind === 'question');
  const items = chats.flatMap((chat) => (state.timeline[chat.id] ?? []).map((item) => ({ chat, item })));
  const roots = topicRoots(state, chats[0]?.topicId);
  const files = fileRoots(state, chats[0]?.topicId);
  const rows: ReactNode[] = [];
  let steps: Step[] = [];
  let owner: Chat | undefined;
  let lastUser: string | undefined;
  const topicId = chats[0]?.topicId;
  const newestCanvas = new Map<string, string>();
  for (const { item } of items) {
    const made = item.kind === 'tool' ? canvasStep(item) : undefined;
    if (made) newestCanvas.set(made.ref, item.id);
  }
  const flush = () => {
    if (!steps.length) return;
    const group = steps;
    const key = `turn-${group[0]!.id}`;
    rows.push(<Turn key={key} steps={group} roots={roots} />);
    for (const step of group) {
      if (step.kind !== 'tool') continue;
      if (step.name === `${BUS}spawn` && step.output !== undefined && !step.isError) {
        const args = parse(step.input);
        const child = Object.values(state.chats)
          .filter((c) => c.parentId === owner?.id && c.intent === str(args.intent))
          .sort((a, b) => b.createdAt - a.createdAt)[0];
        rows.push(<SpawnLine key={`spawn-${step.id}`} chat={child} state={state} open={open} intent={str(args.intent)} role={str(args.role)} />);
      }
      if (PLAN_TOOLS.has(step.name) && step.output !== undefined) {
        const plan = plans.shift();
        if (plan) rows.push(<Resolved key={`plan-${plan.id}`} text={plan.resolution ?? 'Plan closed'} />);
      }
      if (QUESTION_TOOLS.has(step.name) && step.output !== undefined) {
        const question = questions.shift();
        if (question) rows.push(<Resolved key={`q-${question.id}`} text={question.resolution ?? `Answered: ${question.questions?.[0]?.question ?? question.detail}`} />);
      }
      const applied = DIAGRAM_TOOLS.has(step.name) && !step.isError ? diagramApply(step) : undefined;
      if (applied) rows.push(<ApplyCard key={`apply-${step.id}`} {...applied} />);
      const made = canvasStep(step);
      if (made && topicId)
        rows.push(
          newestCanvas.get(made.ref) === step.id ? (
            <CanvasCard key={`canvas-${made.ref}`} topicId={topicId} canvasRef={made.ref} seq={state.canvasSeq[`${topicId}/${made.ref}`] ?? 0} />
          ) : (
            <CanvasStub key={`canvas-${step.id}`} text={`${made.ref} v${made.version} · updated below`} />
          ),
        );
    }
    steps = [];
  };
  const kidsOf = new Map<string, ToolItem[]>();
  for (const { item } of items) if (item.kind === 'tool' && item.parent) kidsOf.set(item.parent, [...(kidsOf.get(item.parent) ?? []), item]);
  for (const { chat, item } of items) {
    if (item.kind === 'tool' && item.parent) continue;
    if (item.kind === 'tool' && isSubagent(item, state)) {
      flush();
      rows.push(<SubagentCard key={`subagent-${item.id}`} step={item} state={state} kidsOf={kidsOf} roots={roots} />);
      continue;
    }
    if (item.kind === 'tool' || item.kind === 'bus' || item.kind === 'policy') {
      if (owner && owner.id !== chat.id) flush();
      owner = chat;
      steps.push(item);
      continue;
    }
    if (item.kind === 'approval' && !item.decision) continue;
    flush();
    if (item.kind === 'message' && item.role === 'user') lastUser = item.text;
    if (item.kind === 'message' && item.role === 'error' && LOGIN_FAILURE.test(item.text)) {
      rows.push(<LoginFailure key={item.id} text={item.text} chatId={chats.at(-1)!.id} retry={lastUser} />);
      continue;
    }
    rows.push(<Row key={item.id} item={item} chat={chat} roots={roots} files={files} />);
  }
  flush();
  return rows;
}

function LoginFailure({ text, chatId, retry }: { text: string; chatId: string; retry: string | undefined }) {
  const [terminal, setTerminal] = useState<string>();
  const [done, setDone] = useState(false);
  const { error, busy, run } = useAction();
  const open = () =>
    void run(async () => {
      setDone(false);
      setTerminal((await client.openLoginTerminal()).name);
    });
  const again = () =>
    void run(async () => {
      setTerminal(undefined);
      await client.sendMessage(chatId, retry!);
    });
  return (
    <div className="login-failure">
      <p className="thread-error" role="alert">
        {text}
      </p>
      <button type="button" className="btn go" disabled={busy} onClick={open}>
        Log in
      </button>
      {error && <span className="error-text">{error}</span>}
      {terminal && (
        <Wrap onClose={() => setTerminal(undefined)} role="dialog" label="Log in to Claude" className="login-dialog">
          <h2>Log in to Claude</h2>
          <p className="muted">Finish the login in the browser tab it opens, or paste the code below. The token stays in Claude's own store; hos never reads it.</p>
          <div className="login-term">
            <TerminalView name={terminal} onExit={() => setDone(true)} />
          </div>
          <div className="dialog-acts">
            <button type="button" className="btn" onClick={() => setTerminal(undefined)}>
              Close
            </button>
            {retry !== undefined && (
              <button type="button" className="btn go" disabled={!done || busy} title={done ? 'Send your last message again' : 'Finish the login first'} onClick={again}>
                Retry last message
              </button>
            )}
          </div>
        </Wrap>
      )}
    </div>
  );
}

function Row({ item, chat, roots, files }: { item: Exclude<TimelineItem, Step>; chat: Chat; roots: string[]; files: FileRoots }) {
  switch (item.kind) {
    case 'message':
      if (item.role === 'user')
        return (
          <div className="msg-user">
            {item.text && <div className="msg-text">{item.text}</div>}
            {item.attachments?.length ? <Attachments files={item.attachments} sent /> : null}
            <When at={item.at} className="when msg-when" />
          </div>
        );
      if (item.role === 'assistant')
        return (
          <div className="prose" aria-busy={!item.done}>
            <Markdown text={item.text} files={files} />
            {!item.done && <span className="caret" aria-hidden="true" />}
            {item.done && <When at={item.at} className="when msg-when" />}
          </div>
        );
      if (item.role === 'error') return <p className="thread-error" role="alert">{item.text}</p>;
      if (item.role === 'hos' && item.canvas) return <CanvasSent text={item.text} at={item.at} />;
      const header = item.role === 'hos' ? NOTICE_HEADER_RE.exec(item.text) : null;
      if (item.role === 'hos' && header) {
        const notices = item.text.slice(header[0].length).trim().split('\n');
        return (
          <details className="msg-from hos notices">
            <summary>
              hos told this chat {notices.length} {notices.length === 1 ? 'thing' : 'things'} automatically · not from you
            </summary>
            <span>{notices.join('\n')}</span>
            <When at={item.at} className="when msg-when" />
          </details>
        );
      }
      return (
        <div className={`msg-from ${item.role}`}>
          <span>{item.text}</span>
          <When at={item.at} className="when msg-when" />
        </div>
      );
    case 'approval': {
      const no = item.decision === 'deny' || item.decision === 'cancelled';
      const what = approvalText(chat, item, roots);
      const verb = item.decision === 'deny' ? 'Denied' : item.decision === 'cancelled' ? 'Cancelled' : 'Approved';
      return <Resolved text={`${verb}: ${what}`} no={no} />;
    }
    case 'thinking':
      if (!item.text.trim()) return null;
      return (
        <details className="thinking">
          <summary>{item.done ? 'Thinking' : 'Thinking…'}</summary>
          <div>{item.text}</div>
        </details>
      );
    case 'lifecycle':
      return <p className="thread-life">{item.text}</p>;
    case 'divider':
      return (
        <p className="thread-divider" role="separator">
          {item.text} · {new Date(item.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}
        </p>
      );
  }
}
