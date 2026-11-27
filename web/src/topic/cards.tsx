import { useEffect, useRef, useState } from 'react';
import type { Chat, InboxItem, Question } from '../../../src/api/types.js';
import { client, errorText, surface } from '../lib.js';
import { IconButton, SignMark } from '../shell/icons.js';
import { openInbox, type State, type TimelineItem } from '../state.js';
import { approvalText, topicRoots } from './timeline.js';
import { approvalWhere } from './where.js';

type ApprovalItem = Extract<TimelineItem, { kind: 'approval' }>;

export type OpenCard =
  | { kind: 'plan'; item: InboxItem }
  | { kind: 'question'; item: InboxItem }
  | { kind: 'approval'; item: ApprovalItem; chat: Chat }
  | { kind: 'workspace-approval'; item: InboxItem };

const CARD_KINDS = new Set<InboxItem['kind']>(['plan', 'question', 'approval']);

export function openCards(state: State, chats: Chat[]): OpenCard[] {
  const byId = new Map(chats.map((c) => [c.id, c]));
  const topicId = chats[0]?.topicId;
  return openInbox(state)
    .filter(
      (item) =>
        (item.chatId ? byId.has(item.chatId) : item.kind === 'approval' && !!item.workspaceId && !!topicId && item.topicId === topicId) &&
        CARD_KINDS.has(item.kind) &&
        !item.picker,
    )
    .sort((a, b) => a.createdAt - b.createdAt)
    .flatMap((item): OpenCard[] => {
      if (item.kind === 'plan') return [{ kind: 'plan', item }];
      if (item.kind === 'question') return item.questions?.length ? [{ kind: 'question', item }] : [];
      if (!item.chatId) return [{ kind: 'workspace-approval', item }];
      const approval = (state.timeline[item.chatId] ?? []).find((t): t is ApprovalItem => t.kind === 'approval' && t.id === item.id);
      return approval ? [{ kind: 'approval', item: approval, chat: byId.get(item.chatId)! }] : [];
    });
}

function workspaceWhere(state: State, workspaceId: string | undefined): string {
  const workspace = workspaceId ? state.workspaces[workspaceId] : undefined;
  if (!workspace) return '';
  const repo = state.projects.find((p) => p.id === workspace.projectId)?.name ?? workspace.name;
  return `in ${repo}, ${workspace.branch ?? workspace.name}`;
}

function typing(): boolean {
  const el = document.activeElement as HTMLElement | null;
  return Boolean(el && (/^(TEXTAREA|INPUT|SELECT)$/.test(el.tagName) || el.isContentEditable));
}

function overlayOpen(): boolean {
  return Boolean(document.querySelector('[role="menu"], [role="dialog"], [role="alertdialog"]'));
}

function useCardKeys(card: OpenCard | undefined, act: (key: string) => boolean) {
  const latest = useRef(act);
  latest.current = act;
  useEffect(() => {
    if (!card) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.repeat || typing() || overlayOpen()) return;
      const onControl = (document.activeElement as HTMLElement | null)?.closest?.('button, summary, a, [role="tab"]');
      if (e.key === 'Enter' && onControl) return;
      if (latest.current(e.key)) e.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [card?.item.id]);
}

const OTHER = '\u0000other';

interface Draft {
  step: number;
  picks: Record<string, string[]>;
  other: Record<string, string>;
}

const drafts = new Map<string, Draft>();

function draftOf(id: string): Draft {
  return drafts.get(id) ?? { step: 0, picks: {}, other: {} };
}

function answerOf(question: Question, draft: Draft): string {
  const picks = draft.picks[question.question] ?? [];
  const other = picks.includes(OTHER) ? (draft.other[question.question] ?? '').trim() : '';
  const labels = question.options.filter((o) => picks.includes(o.label)).map((o) => o.label);
  return [...labels, ...(other ? [other] : [])].join(', ');
}

const otherId = (itemId: string) => `q-other-${itemId}`;

function QuestionCard({
  item,
  draft,
  busy,
  onChoose,
  onOther,
  onMove,
  onSubmit,
  onSkip,
}: {
  item: InboxItem;
  draft: Draft;
  busy: boolean;
  onChoose: (question: Question, label: string) => void;
  onOther: (question: Question, text: string) => void;
  onMove: (step: number) => void;
  onSubmit: () => void;
  onSkip: () => void;
}) {
  const questions = item.questions ?? [];
  const step = Math.min(draft.step, questions.length - 1);
  const question = questions[step]!;
  const picks = draft.picks[question.question] ?? [];
  const last = step === questions.length - 1;
  const ready = questions.every((q) => answerOf(q, draft));
  const preview = question.options.find((o) => o.preview && picks.includes(o.label))?.preview;
  return (
    <section className="thread-card thread-question" aria-label="Question">
      {questions.length > 1 && (
        <div className="q-steps">
          <div className="q-tabs" role="tablist" aria-label="Questions">
            {questions.map((q, i) => (
              <button key={q.question} type="button" role="tab" className="q-tab" aria-selected={i === step} onClick={() => onMove(i)}>
                {answerOf(q, draft) && <span className="q-done">✓</span>}
                {q.header || `Question ${i + 1}`}
              </button>
            ))}
          </div>
          <span className="q-nav">
            <IconButton className="q-arrow" label="Previous question" disabled={step === 0} onClick={() => onMove(step - 1)}>
              ‹
            </IconButton>
            <span className="q-count">
              {step + 1} / {questions.length}
            </span>
            <IconButton className="q-arrow" label="Next question" disabled={last} onClick={() => onMove(step + 1)}>
              ›
            </IconButton>
          </span>
        </div>
      )}
      <div className="thread-card-head">
        <SignMark sign="needs" className="lg" label={false} />
        <h3>{question.question}</h3>
      </div>
      {question.multiSelect && <p className="q-hint">Pick any that apply</p>}
      <ol className="thread-answers" aria-label={question.question}>
        {question.options.map((option, i) => (
          <li key={option.label}>
            <button type="button" className="thread-answer" aria-pressed={picks.includes(option.label)} disabled={busy} onClick={() => onChoose(question, option.label)}>
              <kbd>{i + 1}</kbd>
              <span>{option.label}</span>
              {option.description && <span className="d">{option.description}</span>}
            </button>
          </li>
        ))}
        <li>
          <label className={`thread-answer thread-other${picks.includes(OTHER) ? ' on' : ''}`}>
            <kbd>{question.options.length + 1}</kbd>
            <input
              id={otherId(item.id)}
              type="text"
              aria-label="Other answer"
              placeholder="Other: type your own answer"
              value={draft.other[question.question] ?? ''}
              disabled={busy}
              onFocus={() => !picks.includes(OTHER) && onChoose(question, OTHER)}
              onChange={(e) => onOther(question, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') e.currentTarget.blur();
                if (e.key !== 'Enter') return;
                e.preventDefault();
                if (!last) onMove(step + 1);
                else if (ready) onSubmit();
              }}
            />
          </label>
        </li>
      </ol>
      {preview && <pre className="q-preview">{preview}</pre>}
      {item.recommendation && <p className="thread-card-detail">Recommended: {item.recommendation}</p>}
      <div className="q-foot">
        <button type="button" className="q-skip" disabled={busy} onClick={onSkip}>
          Skip, I'll reply in chat
        </button>
        <span className="thread-acts">
          {step > 0 && (
            <button type="button" className="btn" onClick={() => onMove(step - 1)}>
              Back
            </button>
          )}
          {last ? (
            <span title={ready ? undefined : 'Answer every question first'}>
              <button type="button" className="btn go" disabled={busy || !ready} onClick={onSubmit}>
                Submit <kbd className="kbd-desk">↵</kbd>
              </button>
            </span>
          ) : (
            <button type="button" className="btn go" onClick={() => onMove(step + 1)}>
              Next <kbd className="kbd-desk">↵</kbd>
            </button>
          )}
        </span>
      </div>
    </section>
  );
}

export function Cards({ cards, state, onEditPlan }: { cards: OpenCard[]; state: State; onEditPlan: (item: InboxItem) => void }) {
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [, redraw] = useState(0);
  const run = async (id: string, action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(id);
    setError(undefined);
    try {
      await action();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(undefined);
    }
  };
  const approvePlan = (item: InboxItem) => run(item.id, () => client.decidePlan(item.id, 'approve', { via: surface() }));
  const decide = (item: { id: string }, decision: 'approve' | 'deny') => run(item.id, () => client.decideApproval(item.id, decision, { via: surface() }));
  const saveDraft = (id: string, draft: Draft) => {
    drafts.set(id, draft);
    redraw((n) => n + 1);
  };
  const submit = (item: InboxItem, draft = draftOf(item.id)) => {
    const answers = Object.fromEntries((item.questions ?? []).map((q) => [q.question, answerOf(q, draft)]));
    void run(item.id, async () => {
      await client.answerQuestion(item.id, answers, { via: surface() });
      drafts.delete(item.id);
    });
  };
  const skip = (item: InboxItem) =>
    void run(item.id, async () => {
      await client.dismissInboxItem(item.id);
      drafts.delete(item.id);
    });
  const move = (item: InboxItem, step: number) => saveDraft(item.id, { ...draftOf(item.id), step: Math.max(0, Math.min(step, (item.questions?.length ?? 1) - 1)) });
  const choose = (item: InboxItem, question: Question, label: string) => {
    const questions = item.questions ?? [];
    const draft = draftOf(item.id);
    const had = draft.picks[question.question] ?? [];
    const picks = !question.multiSelect ? [label] : had.includes(label) ? had.filter((l) => l !== label) : [...had, label];
    const next = { ...draft, picks: { ...draft.picks, [question.question]: picks } };
    saveDraft(item.id, next);
    if (question.multiSelect || label === OTHER) return;
    if (questions.length === 1) return submit(item, next);
    if (next.step < questions.length - 1) saveDraft(item.id, { ...next, step: next.step + 1 });
  };
  const typeOther = (item: InboxItem, question: Question, text: string) => {
    const draft = draftOf(item.id);
    saveDraft(item.id, { ...draft, other: { ...draft.other, [question.question]: text } });
  };

  const first = cards[0];
  useCardKeys(first, (key) => {
    if (!first || busy) return false;
    if (first.kind === 'plan') {
      if (key === 'Enter') return void approvePlan(first.item), true;
      if (key === 'e' || key === 'E') return onEditPlan(first.item), true;
    }
    if (first.kind === 'approval' || first.kind === 'workspace-approval') {
      if (key === 'Enter') return void decide(first.item, 'approve'), true;
      if (key === 'Backspace') return void decide(first.item, 'deny'), true;
    }
    if (first.kind === 'question') {
      const questions = first.item.questions ?? [];
      const draft = draftOf(first.item.id);
      const step = Math.min(draft.step, questions.length - 1);
      const question = questions[step];
      if (!question) return false;
      if (/^[1-9]$/.test(key)) {
        const n = Number(key);
        const option = question.options[n - 1];
        if (option) return choose(first.item, question, option.label), true;
        if (n === question.options.length + 1) return document.getElementById(otherId(first.item.id))?.focus(), true;
      }
      if (key === 'ArrowRight' && step < questions.length - 1) return move(first.item, step + 1), true;
      if (key === 'ArrowLeft' && step > 0) return move(first.item, step - 1), true;
      if (key === 'Enter') {
        if (step < questions.length - 1) return move(first.item, step + 1), true;
        if (questions.every((q) => answerOf(q, draft))) return submit(first.item), true;
      }
    }
    return false;
  });

  if (!cards.length) return null;
  return (
    <>
      {cards.map((card) => {
        if (card.kind === 'plan')
          return (
            <section key={card.item.id} className="thread-card thread-plan" aria-label="Plan to approve">
              <div className="thread-card-head">
                <SignMark sign="needs" className="lg" label={false} />
                <h3>{card.item.plan?.text ?? card.item.title}</h3>
              </div>
              {card.item.detail && card.item.detail !== card.item.plan?.text && <p className="thread-card-detail">{card.item.detail}</p>}
              <div className="thread-acts">
                <button type="button" className="btn go" disabled={busy === card.item.id} onClick={() => void approvePlan(card.item)}>
                  Approve plan <kbd className="kbd-desk">↵</kbd>
                </button>
                <button type="button" className="btn" onClick={() => onEditPlan(card.item)}>
                  Edit <kbd className="kbd-desk">E</kbd>
                </button>
              </div>
            </section>
          );
        if (card.kind === 'approval' || card.kind === 'workspace-approval') {
          const item =
            card.kind === 'approval'
              ? {
                  id: card.item.id,
                  label: card.item.tool,
                  heading: approvalText(card.chat, card.item, topicRoots(state, card.chat.topicId)),
                  where: approvalWhere(state, card.chat, card.item.input),
                  reason: card.item.reason,
                  input: card.item.input,
                }
              : {
                  id: card.item.id,
                  label: card.item.title,
                  heading: card.item.title,
                  where: workspaceWhere(state, card.item.workspaceId),
                  reason: '',
                  input: card.item.detail,
                };
          return (
            <section key={item.id} className="thread-card thread-approval" role="group" aria-label={`Permission request: ${item.label}`}>
              <div className="thread-line">
                <SignMark sign="needs" className="lg" label={false} />
                <h3>{item.heading}</h3>
                <span className="thread-where">{item.where}</span>
                <span className="thread-acts">
                  <button type="button" className="btn go" aria-label="Approve once" title="Let it run this once; ask next time" disabled={busy === item.id} onClick={() => void decide(item, 'approve')}>
                    Approve <kbd className="kbd-desk">↵</kbd>
                  </button>
                  <button type="button" className="btn deny" aria-label="Deny" title="Refuse; the chat is told and carries on" disabled={busy === item.id} onClick={() => void decide(item, 'deny')}>
                    Deny <kbd className="kbd-desk">⌫</kbd>
                  </button>
                </span>
              </div>
              <details className="thread-raw">
                <summary>
                  <svg aria-hidden="true" focusable="false">
                    <use href="#i-chev-r" />
                  </svg>
                  Details
                </summary>
                {item.reason && <p>{item.reason}</p>}
                <pre>{item.input}</pre>
              </details>
            </section>
          );
        }
        const item = card.item;
        return (
          <QuestionCard
            key={item.id}
            item={item}
            draft={draftOf(item.id)}
            busy={busy === item.id}
            onChoose={(question, label) => choose(item, question, label)}
            onOther={(question, text) => typeOther(item, question, text)}
            onMove={(step) => move(item, step)}
            onSubmit={() => submit(item)}
            onSkip={() => skip(item)}
          />
        );
      })}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
