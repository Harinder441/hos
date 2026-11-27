import type { Clock } from './adapters/clock.js';
import type { Chat, ChatState, Role, Task, TaskPatch, TaskPriority, TaskState } from './api/types.js';
import type { BusReply, Recorder } from './bus.js';
import { owner } from './owner.js';
import type { Store } from './store.js';

export const MIN_EVIDENCE = 4;
const ACTIVE: TaskState[] = ['open', 'claimed', 'review', 'blocked'];
const GONE: ChatState[] = ['done', 'failed', 'paused', 'killed', 'handed_off', 'archived'];
const FINISHED: ChatState[] = ['done', 'failed', 'killed', 'handed_off', 'archived'];
const LEADS: Role[] = ['main'];
function stateLabel(state: TaskState): string {
  return state === 'blocked' ? `blocked on ${owner()}` : state;
}

export interface NewTask {
  title: string;
  dependsOn?: string[];
  limitMinutes?: number;
  priority?: TaskPriority;
  criteria?: string[];
  foundWhile?: string;
  fromSnag?: string;
}

export type TaskChanged = (before: Task | null, after: Task) => void;

// by is the acting chat, or null when the user acts from the web app.
type Actor = Chat | null;

export class Tasks {
  constructor(
    private readonly store: Store,
    private readonly record: Recorder,
    private readonly clock: Clock,
    private readonly changed: TaskChanged = () => {},
  ) {}

  missingDependencies(topicId: string, refs: string[]): string[] {
    const known = new Set(this.store.tasks(topicId).map((t) => t.ref));
    return refs.filter((ref) => !known.has(ref));
  }

  create(topicId: string, by: Actor, input: NewTask): Task {
    const tasks = this.store.tasks(topicId);
    const task: Task = {
      topicId,
      ref: `T${this.store.nextTaskNumber(topicId)}`,
      title: input.title.trim(),
      dependsOn: input.dependsOn ?? [],
      state: input.foundWhile ? 'proposed' : 'open',
      claimedBy: null,
      claimedAt: null,
      limitMinutes: input.limitMinutes ?? null,
      flagged: false,
      note: null,
      createdByChat: by?.id ?? null,
      createdAt: this.clock.now(),
      doneAt: null,
      priority: input.priority ?? 2,
      rank: Math.max(0, ...tasks.map((t) => t.rank)) + 1,
      criteria: (input.criteria ?? []).map((text) => ({ text: text.trim(), met: false })).filter((c) => c.text),
      evidence: null,
      question: null,
      fromSnag: input.fromSnag ?? null,
      discoveredFrom: input.foundWhile ? taskRef(input.foundWhile) : null,
      closedByChat: null,
      mirrorId: null,
      mirrorAuto: false,
    };
    this.save(null, task);
    return task;
  }

  claim(chat: Chat, ref: string | undefined): BusReply {
    const tasks = this.store.tasks(chat.topicId);
    if (!ref) {
      const ready = ordered(tasks).find((t) => t.state === 'open' && !this.blockers(t, tasks).length);
      if (ready) return this.take(chat, ready);
      const waiting = ordered(tasks).filter((t) => t.state === 'open').map((t) => `${t.ref} waits for ${this.blockers(t, tasks).join(', ')}`);
      return { outcome: 'ok', text: `No task is ready to claim.${waiting.length ? ` ${waiting.join('; ')}.` : ''}` };
    }
    const task = tasks.find((t) => t.ref === taskRef(ref));
    if (!task) return { outcome: 'refused', text: `There is no task ${ref} in your topic; call tasks to see the list.` };
    if (task.state === 'claimed' && task.claimedBy === chat.id) return { outcome: 'ok', text: `You already hold ${task.ref}.` };
    if (task.claimedBy !== chat.id && ACTIVE.includes(task.state) && this.canTakeOver(task, chat)) return this.take(chat, task);
    if (task.state === 'claimed') return { outcome: 'refused', text: `${task.ref} is claimed by ${this.chatName(task.claimedBy)}.` };
    if (task.state === 'proposed') return { outcome: 'refused', text: `${task.ref} is only proposed; ${owner()} or a main chat must accept it first.` };
    if (task.state !== 'open') return { outcome: 'refused', text: `${task.ref} is ${stateLabel(task.state)}, so it can't be claimed.` };
    const blockers = this.blockers(task, tasks);
    if (blockers.length) return { outcome: 'refused', text: `${task.ref} waits for ${blockers.join(', ')}; claim it once they are done.` };
    return this.take(chat, task);
  }

  complete(topicId: string, by: Actor, ref: string, evidence: string | undefined, met: number[] = []): BusReply {
    const tasks = this.store.tasks(topicId);
    const task = tasks.find((t) => t.ref === taskRef(ref));
    if (!task) return { outcome: 'refused', text: `There is no task ${ref} in your topic.` };
    if (task.state === 'done') return { outcome: 'refused', text: `${task.ref} is already done.` };
    if (task.state !== 'claimed' && task.state !== 'review') return { outcome: 'refused', text: `${task.ref} is ${stateLabel(task.state)}; only a claimed or review task can be done.` };
    const takeover = by && task.claimedBy !== by.id && this.canTakeOver(task, by);
    if (by && task.claimedBy !== by.id && !takeover) {
      return { outcome: 'refused', text: task.claimedBy ? `${task.ref} is claimed by ${this.chatName(task.claimedBy)}, not you.` : `${task.ref} is not claimed; claim it first.` };
    }
    const bad = met.filter((n) => !Number.isInteger(n) || n < 1 || n > task.criteria.length);
    if (bad.length) return { outcome: 'refused', text: `${task.ref} has ${task.criteria.length} criteria; there is no criterion ${bad.join(', ')}.` };
    const criteria = task.criteria.map((c, i) => (met.includes(i + 1) ? { ...c, met: true } : c));
    const given = evidence?.trim() || task.evidence;
    const unmet = criteria.flatMap((c, i) => (c.met ? [] : [`${i + 1}. ${c.text}`]));
    if (unmet.length || !given || given.length < MIN_EVIDENCE) {
      const missing = [
        ...(unmet.length ? [`criteria not met: ${unmet.join('; ')} (pass met with their numbers once they are)`] : []),
        ...(!given || given.length < MIN_EVIDENCE ? ['evidence: a commit sha, a test run or a file path'] : []),
      ];
      if (by) this.save(task, { ...task, criteria });
      return { outcome: 'refused', text: `${task.ref} is not done yet. Missing ${missing.join(' and ')}.` };
    }
    const proof = takeover ? `${given} · closed for ${this.chatName(task.claimedBy)}` : given;
    const now = this.clock.now();
    const done: Task = { ...task, criteria, evidence: proof, state: 'done', doneAt: now, closedByChat: by?.id ?? null, question: null };
    this.save(task, done);
    const after = tasks.map((t) => (t.ref === done.ref ? done : t));
    const ready = after.filter((t) => t.state === 'open' && t.dependsOn.includes(done.ref) && !this.blockers(t, after).length).map((t) => t.ref);
    if (task.createdByChat && task.createdByChat !== by?.id) {
      const who = by ? `chat ${by.id.slice(0, 8)} (${by.role})` : owner();
      const tail = `: ${proof.slice(0, 120)}${ready.length ? `; now ready: ${ready.join(', ')}` : ''}`;
      this.store.insertNotice(task.createdByChat, `${task.ref} was completed by ${who}${tail}`, now, false);
    }
    return { outcome: 'ok', text: `${task.ref} is done.${ready.length ? ` Now ready: ${ready.join(', ')}.` : ''}` };
  }

  update(topicId: string, by: Actor, ref: string, patch: TaskPatch): BusReply {
    const tasks = this.store.tasks(topicId);
    const task = tasks.find((t) => t.ref === taskRef(ref));
    if (!task) return { outcome: 'refused', text: `There is no task ${ref} in your topic.` };
    if (patch.state === 'done') return this.complete(topicId, by, task.ref, patch.evidence);
    let next: Task = { ...task };
    const said: string[] = [];
    if (patch.priority !== undefined) {
      next.priority = patch.priority;
      said.push(`priority P${patch.priority}`);
    }
    if (patch.check) {
      if (!next.criteria[patch.check.index]) return { outcome: 'refused', text: `${task.ref} has no criterion ${patch.check.index + 1}.` };
      next.criteria = next.criteria.map((c, i) => (i === patch.check!.index ? { ...c, met: patch.check!.met } : c));
      said.push(`criterion ${patch.check.index + 1} ${patch.check.met ? 'met' : 'not met'}`);
    }
    if (patch.evidence !== undefined) next.evidence = patch.evidence.trim() || null;
    if (patch.state && patch.state !== task.state) {
      const refusal = this.transition(task, by, patch);
      if (refusal) return { outcome: 'refused', text: refusal };
      next = { ...next, ...this.moved(task, by, patch) };
      said.push(stateLabel(next.state));
    }
    if (patch.move) {
      const order = ordered(tasks).filter((t) => ACTIVE.includes(t.state) && t.priority === next.priority);
      const at = order.findIndex((t) => t.ref === task.ref);
      const other = order[patch.move === 'up' ? at - 1 : at + 1];
      if (at < 0 || !other) return { outcome: 'refused', text: `${task.ref} is already ${patch.move === 'up' ? 'first' : 'last'} in P${next.priority}.` };
      const to = order.indexOf(other);
      [order[at], order[to]] = [order[to]!, order[at]!];
      const base = Math.min(...order.map((t) => t.rank));
      order.forEach((t, i) => {
        if (t.ref === task.ref) next.rank = base + i;
        else if (t.rank !== base + i) this.save(t, { ...t, rank: base + i });
      });
      said.push(`moved ${patch.move}`);
    }
    this.save(task, next);
    return { outcome: 'ok', text: `${task.ref}: ${said.join(', ') || 'nothing changed'}.` };
  }

  setMirror(topicId: string, ref: string, mirrorId: string | null, auto: boolean): void {
    const task = this.store.tasks(topicId).find((t) => t.ref === ref);
    if (task) this.save(task, { ...task, mirrorId, mirrorAuto: mirrorId ? auto : false });
  }

  list(chat: Chat): BusReply {
    const tasks = this.store.tasks(chat.topicId);
    if (!tasks.length) return { outcome: 'ok', text: 'Your topic has no tasks yet.' };
    const line = (t: Task) => {
      const status =
        t.state === 'claimed'
          ? `claimed by ${t.claimedBy === chat.id ? 'you' : `chat ${t.claimedBy!.slice(0, 8)}`}`
          : t.state === 'open'
            ? this.blockers(t, tasks).length ? 'open, blocked' : 'open, ready'
            : stateLabel(t.state);
      const flag = t.flagged ? ', past its time limit' : '';
      const deps = t.dependsOn.length ? ` (after ${t.dependsOn.join(', ')})` : '';
      const met = t.criteria.length ? ` · criteria ${t.criteria.filter((c) => c.met).length}/${t.criteria.length}` : '';
      const from = t.discoveredFrom ? ` · found while doing ${t.discoveredFrom}` : t.fromSnag ? ` · from snag ${t.fromSnag}` : '';
      return `${t.ref} [P${t.priority} ${status}${flag}] ${t.title.split('\n')[0]!.slice(0, 120)}${deps}${met}${from}`;
    };
    return { outcome: 'ok', text: ordered(tasks).map(line).join('\n') };
  }

  summary(topicId: string): string | null {
    const tasks = this.store.tasks(topicId).filter((t) => t.state !== 'proposed' && t.state !== 'dropped');
    if (!tasks.length) return null;
    const done = tasks.filter((t) => t.state === 'done').length;
    const next = ordered(tasks)
      .filter((t) => ACTIVE.includes(t.state))
      .slice(0, 3)
      .map((t) => `${t.ref} (P${t.priority}, ${stateLabel(t.state)})`);
    return `Tasks ${done}/${tasks.length} done${next.length ? ` · next ${next.join(', ')}` : ''}`;
  }

  transfer(topicId: string, fromChatId: string, toChatId: string): void {
    for (const task of this.store.tasks(topicId)) {
      if (task.claimedBy === fromChatId && task.state !== 'done' && task.state !== 'dropped') this.save(task, { ...task, claimedBy: toChatId });
    }
  }

  flagOverdue(): void {
    const now = this.clock.now();
    for (const task of this.store.overdueTasks(now)) {
      this.save(task, { ...task, flagged: true });
      const limit = `${task.limitMinutes}-minute time limit`;
      this.store.insertNotice(task.claimedBy!, `${task.ref} is past its ${limit}: finish it with task_complete, or tell your parent chat what blocks you`, now);
      if (task.createdByChat && task.createdByChat !== task.claimedBy) {
        this.store.insertNotice(task.createdByChat, `${task.ref} claimed by chat ${task.claimedBy!.slice(0, 8)} is past its ${limit}`, now);
      }
    }
  }

  private transition(task: Task, by: Actor, patch: TaskPatch): string | null {
    const to = patch.state!;
    const holder = !by || task.claimedBy === by.id || this.canTakeOver(task, by);
    if (task.state === 'done' || task.state === 'dropped') return `${task.ref} is ${task.state}.`;
    if (to === 'dropped') return by && !patch.reason?.trim() ? `Give a reason to drop ${task.ref}.` : null;
    if (to === 'open' && task.state === 'proposed') {
      const lead = !by || (by.role === 'main' && by.id !== task.createdByChat);
      return lead ? null : `Only ${owner()} or a main chat can accept ${task.ref}.`;
    }
    if (to === 'open' && task.state === 'claimed') return holder ? null : `${task.ref} is claimed by ${this.chatName(task.claimedBy)}, not you.`;
    if (to === 'review' && task.state === 'claimed') return holder ? null : `${task.ref} is claimed by ${this.chatName(task.claimedBy)}, not you.`;
    if (to === 'blocked' && (task.state === 'claimed' || task.state === 'open' || task.state === 'review')) {
      if (by && task.state !== 'open' && !holder) return `${task.ref} is claimed by ${this.chatName(task.claimedBy)}, not you.`;
      return patch.question?.trim() || !by ? null : `Say what you need from ${owner()} in question.`;
    }
    if (to === 'claimed' && (task.state === 'blocked' || task.state === 'review') && task.claimedBy) return holder ? null : `${task.ref} is held by ${this.chatName(task.claimedBy)}.`;
    if (to === 'open' && (task.state === 'blocked' || task.state === 'review') && !task.claimedBy) return null;
    return `${task.ref} can't go from ${stateLabel(task.state)} to ${stateLabel(to)}.`;
  }

  private moved(task: Task, by: Actor, patch: TaskPatch): Partial<Task> {
    const to = patch.state!;
    if (to === 'dropped') return { state: 'dropped', note: patch.reason?.trim() || null, closedByChat: by?.id ?? null, question: null };
    if (to === 'blocked') return { state: 'blocked', question: patch.question?.trim() || task.question || `Needs ${owner()}` };
    if (to === 'open') return { state: 'open', claimedBy: null, claimedAt: null, question: null, flagged: false };
    if (to === 'claimed') return { state: 'claimed', question: null, ...(by && by.id !== task.claimedBy ? { claimedBy: by.id, claimedAt: this.clock.now() } : {}) };
    return { state: to };
  }

  private take(chat: Chat, task: Task): BusReply {
    this.save(task, { ...task, state: 'claimed', claimedBy: chat.id, claimedAt: this.clock.now(), flagged: false, question: null });
    const criteria = task.criteria.length ? `\nDone when:\n${task.criteria.map((c, i) => `${i + 1}. ${c.text}`).join('\n')}` : '';
    const verb = task.claimedBy ? `Took over ${task.ref} from ${this.chatName(task.claimedBy)}` : `Claimed ${task.ref}`;
    return {
      outcome: 'ok',
      text: `${verb}: ${task.title}${criteria}${task.limitMinutes ? `\nTime limit: ${task.limitMinutes} minutes.` : ''}\nCall task_complete with evidence (and met) when it is done.`,
    };
  }

  private blockers(task: Task, tasks: Task[]): string[] {
    return task.dependsOn.flatMap((ref) => {
      const dep = tasks.find((t) => t.ref === ref);
      if (!dep || dep.state === 'done' || dep.state === 'dropped') return [];
      return [`${ref} (${dep.state === 'claimed' ? `claimed by chat ${dep.claimedBy!.slice(0, 8)}` : dep.state})`];
    });
  }

  private canTakeOver(task: Task, by: Chat): boolean {
    if (!task.claimedBy) return false;
    const holder = this.store.getChat(task.claimedBy);
    return !holder || (LEADS.includes(by.role) ? GONE : FINISHED).includes(holder.state);
  }

  private chatName(chatId: string | null): string {
    const chat = chatId ? this.store.getChat(chatId) : undefined;
    return chat ? `chat ${chat.id.slice(0, 8)} (${chat.role}, ${chat.state})` : 'nobody';
  }

  private save(before: Task | null, task: Task): void {
    this.record({ type: 'task.updated', task }, () => this.store.saveTask(task));
    this.changed(before, task);
  }
}

export function ordered(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => a.priority - b.priority || a.rank - b.rank || a.createdAt - b.createdAt);
}

export function taskRef(ref: string): string {
  return ref.trim().toUpperCase();
}
