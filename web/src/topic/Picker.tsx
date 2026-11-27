import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { InboxItem, PickerOption, PickerQuestion } from '../../../src/api/types.js';
import { client, useAction } from '../lib.js';
import { Icon } from '../shell/icons.js';
import type { State } from '../state.js';

export function WorkspacePicker({ topicId, state }: { topicId: string; chatId: string; state: State }) {
  const items = Object.values(state.inbox)
    .filter((item): item is InboxItem & { picker: PickerQuestion } => item.state === 'open' && !!item.picker && (item.topicId ?? (item.chatId ? state.chats[item.chatId]?.topicId : undefined)) === topicId)
    .sort((a, b) => a.createdAt - b.createdAt);
  return (
    <>
      {items.map((item) => (
        <PickerCard key={item.id} item={item} topicId={topicId} />
      ))}
    </>
  );
}

function PickerCard({ item, topicId }: { item: InboxItem & { picker: PickerQuestion }; topicId: string }) {
  const { picker } = item;
  const [chosen, setChosen] = useState(picker.suggested);
  const [draft, setDraft] = useState(picker.suggestedBranch ?? '');
  const [open, setOpen] = useState(true);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [tried, setTried] = useState<string | null>(null);
  const { error, busy, run } = useAction();
  const root = useRef<HTMLElement>(null);
  const branch = draft.trim();
  const problem = !branch ? 'Name the branch' : picker.options.some((o) => o.branch === branch) ? `A worktree on ${branch} already exists` : '';
  const blocked = busy || (chosen === 'new' && !!problem);

  const focusChosen = () => root.current?.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.focus();
  useEffect(() => {
    if (document.activeElement === document.body || !document.activeElement) focusChosen();
  }, []);
  useEffect(() => {
    if (open) root.current?.querySelector('.picker-scroll .picker-opt.on')?.scrollIntoView({ block: 'nearest' });
  }, [open]);

  const accept = () => {
    if (blocked) return;
    void run(() => client.pickWorkspace(item.id, chosen, chosen === 'new' ? branch : undefined));
  };

  const dirty = !!error && tried === confirming && /confirm to (remove|archive) it anyway/.test(error);
  const remove = (value: string) => {
    setTried(value);
    void run(async () => {
      const updated = await client.removePickerWorktree(item.id, value, { force: dirty });
      setConfirming(null);
      if (chosen === value) setChosen(updated.picker?.suggested ?? 'new');
    });
  };

  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    const target = e.target as HTMLElement;
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      return;
    }
    if (e.key === 'Enter' && !e.nativeEvent.isComposing && target.tagName !== 'BUTTON') {
      e.preventDefault();
      accept();
      return;
    }
    if (target.id === `picker-branch-${item.id}` && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      const values = picker.options.map((o) => o.value);
      const i = values.indexOf('new');
      const next = values[(i + (e.key === 'ArrowUp' ? values.length - 1 : 1)) % values.length]!;
      setChosen(next);
      requestAnimationFrame(focusChosen);
    }
  };

  if (!open) {
    return (
      <section className="picker done" aria-label={`Pick a ${picker.repo} workspace`}>
        <p className="picker-receipt">
          <span className="muted">The chat is waiting for a {picker.repo} workspace.</span>
          <button
            type="button"
            className="btn quiet"
            title="Choose a workspace for this chat"
            onClick={() => {
              setOpen(true);
              requestAnimationFrame(focusChosen);
            }}
          >
            Pick one
          </button>
        </p>
      </section>
    );
  }

  const worktreeRow = (option: PickerOption) => {
    const name = folderName(option, picker.repo);
    const others = option.usedBy.filter((use) => use.topicId !== topicId);
    return (
      <div key={option.value} className="picker-line">
        {plainOption(option)}
        {confirming === option.value ? (
          <div className="picker-confirm" role="group" aria-label={`Confirm removing ${name}`}>
            <button type="button" className="btn quiet" onClick={() => setConfirming(null)}>
              Cancel
            </button>
            <button type="button" className="btn danger" disabled={busy} onClick={() => remove(option.value)}>
              {dirty ? 'Remove anyway' : 'Remove'}
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="btn quiet picker-remove"
            aria-label={`Remove ${name}`}
            title={others.length ? `Used by ${others.map((use) => use.title).join(', ')}; archive it from that topic` : `Remove ${option.path}`}
            disabled={busy || others.length > 0}
            onClick={() => setConfirming(option.value)}
          >
            Remove
          </button>
        )}
      </div>
    );
  };
  const confirmingOption = picker.options.find((o) => o.value === confirming);

  const option = (option: PickerOption) => (option.kind === 'worktree' ? worktreeRow(option) : plainOption(option));
  const plainOption = (option: PickerOption) => (
    <Option key={option.value} option={option} topicId={topicId} picker={picker} chosen={chosen} onChoose={setChosen} name={`picker-${item.id}`}>
      {option.kind === 'new' && chosen === 'new' && (
        <div className="picker-name">
          <label htmlFor={`picker-branch-${item.id}`}>Branch</label>
          <input
            id={`picker-branch-${item.id}`}
            className="picker-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            aria-describedby={`picker-hint-${item.id}`}
            aria-invalid={!!problem}
          />
          <span id={`picker-hint-${item.id}`} className={problem ? 'picker-warn' : 'muted'}>
            {problem || `from ${picker.base}, set up in the background`}
          </span>
        </div>
      )}
    </Option>
  );
  const worktrees = picker.options.filter((o) => o.kind === 'worktree');

  return (
    <section className="picker" aria-label={`Pick a ${picker.repo} workspace`} ref={root} onKeyDown={onKey}>
      <div className="picker-head">
        <b>Which {picker.repo} checkout should I work in?</b>
        <span className="muted">{picker.why}</span>
      </div>
      <fieldset className="picker-opts">
        <legend className="sr">Workspace in {picker.repo}</legend>
        {picker.options.filter((o) => o.kind === 'root').map(option)}
        {worktrees.length > 0 && <div className="picker-scroll">{worktrees.map(option)}</div>}
        {picker.options.filter((o) => o.kind === 'new').map(option)}
      </fieldset>
      {confirmingOption && (
        <p className="picker-note muted" title={confirmingOption.path ?? undefined}>
          Remove deletes the folder {folderName(confirmingOption, picker.repo)}; branch {confirmingOption.branch ?? '(detached)'} stays.
        </p>
      )}
      {error && (
        <p className="picker-error picker-warn" role="alert">
          {error}
        </p>
      )}
      <div className="picker-bar">
        <span className="picker-keys">↑↓ to move</span>
        <button type="button" className="btn quiet" onClick={() => setOpen(false)}>
          Not now <kbd>Esc</kbd>
        </button>
        <button type="button" className="btn go" disabled={blocked} onClick={accept}>
          Work here <kbd>↵</kbd>
        </button>
      </div>
    </section>
  );
}

function Option({
  option,
  topicId,
  picker,
  chosen,
  onChoose,
  name,
  children,
}: {
  option: PickerOption;
  topicId: string;
  picker: PickerQuestion;
  chosen: string;
  onChoose: (value: string) => void;
  name: string;
  children?: ReactNode;
}) {
  const on = chosen === option.value;
  const title =
    option.kind === 'new' ? (
      <>
        <Icon id="i-plus" className="picker-plus" />
        Create a new worktree
      </>
    ) : (
      <>
        <span className="picker-folder" title={option.path ?? undefined}>
          {folderName(option, picker.repo)}
        </span>
        {' · '}
        <span className="picker-branch">
          <Icon id="i-branch" />
          {option.branch ?? 'detached'}
        </span>
        {option.kind === 'root' && <span className="tag">root</span>}
      </>
    );
  return (
    <>
      <label className={`picker-opt${on ? ' on' : ''}`}>
        <input type="radio" name={name} value={option.value} checked={on} onChange={() => onChoose(option.value)} />
        <span className="picker-body">
          <span className="picker-title">
            {title}
            {picker.suggested === option.value && <span className="tag">suggested</span>}
          </span>
          <span className="picker-meta">
            {option.kind === 'new' ? (
              option.state
            ) : (
              <>
                <span className={option.warn ? 'picker-warn' : ''}>{option.state}</span> · <UsedBy option={option} topicId={topicId} />
              </>
            )}
          </span>
        </span>
      </label>
      {children}
    </>
  );
}

function folderName(option: PickerOption, repo: string): string {
  return option.path?.split('/').filter(Boolean).at(-1) ?? repo;
}

function UsedBy({ option, topicId }: { option: PickerOption; topicId: string }) {
  if (!option.usedBy.length) return <span className="picker-free">not used by a topic</span>;
  return (
    <>
      {option.usedBy.map((use, i) => (
        <span key={use.topicId}>
          {i > 0 && ' '}
          {use.topicId === topicId ? <span className="picker-free">used by this topic</span> : <span className="picker-used">used by {use.title}</span>}
        </span>
      ))}
    </>
  );
}
