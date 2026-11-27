import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { Chat, Effort, HarnessChoice, InboxItem, ModelsConfig } from '../../../src/api/types.js';
import { client, errorText, surface } from '../lib.js';
import { Icon, IconButton } from '../shell/icons.js';
import { topicHref } from '../shell/routes.js';
import { updateDraft, useDraft, type DraftFile } from '../drafts.js';
import type { State } from '../state.js';
import { badgeText, extraHarness, harnessHas, modelLabel, useHarnesses, useModels } from './catalog.js';
import { ComputerNote, ComputerPick, lacksHarness, useComputerChoice } from './ComputerPick.js';
import { lastProfile, profileDefaults, profileStyle, useContextRefresh, useProfileColors, useProfilePick } from './ProfilePick.js';
import { RESTART_COMMAND, useSlash } from './slash.js';
import { AttachmentChip } from './timeline.js';
import { useAttach } from './useAttach.js';

const EFFORT_CHOICES = (['low', 'medium', 'high', 'xhigh', 'max'] as const).map((effort) => ({ value: effort, label: effort }));

let focusedLineage: string | undefined;

export interface ComposerHandle {
  edit(prefill: string): void;
}

export const Composer = forwardRef<
  ComposerHandle,
  { chat: Chat; state: State; working: boolean; plan: InboxItem | undefined; asking: boolean }
>(function Composer({ chat, state, working, plan, asking }, ref) {
  const [{ text, files: pending, queued }, setDraft] = useDraft(chat.lineageId);
  const setText = (next: string) => setDraft((draft) => ({ ...draft, text: next }));
  const setPending = (next: (files: DraftFile[]) => DraftFile[]) => setDraft((draft) => ({ ...draft, files: next(draft.files) }));
  const setQueued = (next: string | undefined) => setDraft((draft) => ({ ...draft, queued: next }));
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const policyModels = useModels();
  const harness = extraHarness(useHarnesses(), chat.agent);
  const models = harness?.models ?? policyModels;
  const agentName = harness?.label ?? 'Claude';
  const slash = useSlash(text, setText, box, chat.profile, [RESTART_COMMAND]);
  const tint = profileStyle(useProfileColors()[chat.profile]);
  const terminal = state.terminals[chat.id];
  const retired = chat.state === 'handed_off';
  const disabled = Boolean(terminal) || retired;
  const { drop, handlers } = useAttach(chat.topicId, setPending, disabled);
  const canRefresh = useContextRefresh(chat.profile) && !chat.computer && harnessHas(harness, 'contextRefresh') && !disabled;
  const [refreshAsked, setRefreshAsked] = useState(false);
  const refreshing = refreshAsked || !!state.refreshing[chat.id];
  const refreshContext = async () => {
    setRefreshAsked(true);
    setError(undefined);
    try {
      await client.refreshContext(chat.id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setRefreshAsked(false);
    }
  };

  useEffect(() => {
    const el = box.current;
    if (!el || disabled || focusedLineage !== chat.lineageId) return;
    if (document.activeElement && document.activeElement !== document.body) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [disabled]);

  useImperativeHandle(ref, () => ({
    edit(prefill: string) {
      setDraft((draft) => ({ ...draft, text: draft.text || prefill }));
      requestAnimationFrame(() => {
        const el = box.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      });
    },
  }));

  const deliver = async (message: string, files: DraftFile[]) => {
    const paths = files.flatMap((f) => (f.path ? [f.path] : []));
    if (plan && !paths.length) await client.decidePlan(plan.id, 'edit', { text: message, via: surface() });
    else await client.sendMessage(chat.id, message || 'See the attached files.', paths);
  };

  const send = async (now = false) => {
    const typed = text.trim();
    const ready = pending.filter((f) => f.path);
    if (busy || disabled || (!typed && !ready.length)) return;
    if (pending.some((f) => !f.path && !f.error)) return setError('Wait for the attachments to finish copying.');
    if (typed === `/${RESTART_COMMAND.name}`) {
      setBusy(true);
      setError(undefined);
      try {
        await client.restartChat(chat.id);
        setText('');
      } catch (e) {
        setError(errorText(e));
      } finally {
        setBusy(false);
      }
      return;
    }
    if (working && !now && !ready.length) {
      setQueued([queued, typed].filter(Boolean).join('\n'));
      setText('');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await deliver(typed, ready);
      setDraft((draft) => ({ ...draft, text: '', files: [] }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const steer = async () => {
    const message = [queued, text.trim()].filter(Boolean).join('\n');
    if (!message) return;
    setQueued(undefined);
    setText('');
    try {
      await deliver(message, []);
    } catch (e) {
      setQueued(message);
      setError(errorText(e));
    }
  };

  useEffect(() => {
    if (working || !queued || disabled) return;
    const message = queued;
    setQueued(undefined);
    deliver(message, []).catch((e: unknown) => {
      setQueued(message);
      setError(errorText(e));
    });
  }, [working, queued, disabled]);

  useGrow(box, text);
  const pick = (choice: { model?: string; effort?: Effort }) => client.setChatPick(chat.id, choice).catch((e: unknown) => setError(errorText(e)));
  const hold = state.holds[chat.id];
  const governorQueued = chat.state === 'queued' && !queued;
  return (
    <div className="composer-wrap">
      {terminal && (
        <div className="thread-takeover" role="status">
          <span>Taken over in terminal {terminal}</span>
          <a href={`#/terminal/${encodeURIComponent(terminal)}`}>Open terminal</a>
          <button type="button" className="btn go" title="Give the chat back from the terminal" onClick={() => client.handBack(chat.id).catch((e: unknown) => setError(errorText(e)))}>
            Hand back
          </button>
        </div>
      )}
      <form
        className={`composer${tint.className}${drop ? ' thread-drop' : ''}`}
        style={tint.style}
        aria-label="Composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
        {...handlers}
      >
        {queued && (
          <div className="queue" role="status" aria-label="Queued message">
            <span>
              <b>Queued:</b> {queued}, sends when this turn ends
            </span>
            <button type="button" className="btn" title="Send now, while the chat is mid-turn" onClick={() => void steer()}>
              Steer now <kbd className="kbd-desk">⌘↵</kbd>
            </button>
          </div>
        )}
        {governorQueued && (
          <div className="queue" role="status" aria-label="Queued">
            <span>
              <b>Queued:</b> {hold?.reason ?? 'waiting for a running chat to finish'}
            </span>
          </div>
        )}
        <PendingFiles pending={pending} setPending={setPending} />
        {slash.menu}
        <label className="sr" htmlFor={`msg-${chat.id}`}>
          Message this topic
        </label>
        <textarea
          id={`msg-${chat.id}`}
          ref={box}
          rows={2}
          value={text}
          disabled={disabled}
          readOnly={busy}
          aria-busy={busy}
          enterKeyHint="send"
          placeholder={
            terminal
              ? 'Taken over in a terminal'
              : retired
                ? 'This generation has handed off'
                : asking
                  ? 'Or reply here instead of answering the questions'
                  : 'Message this topic. Paste or drop a file to attach it'
          }
          onChange={(e) => {
            setText(e.target.value);
            slash.typed();
          }}
          onFocus={() => (focusedLineage = chat.lineageId)}
          onBlur={(e) => {
            if (!e.currentTarget.disabled && e.currentTarget.isConnected) focusedLineage = undefined;
          }}
          onKeyDown={(e) => {
            if (slash.key(e)) return;
            if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
            if (e.metaKey || e.ctrlKey) {
              e.preventDefault();
              if (queued) void steer();
              else void send(true);
            } else if (!e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        {error && (
          <p className="error-text composer-error" role="alert">
            {error}
          </p>
        )}
        <div className="cbar">
          <HarnessBadge agent={chat.agent} label={agentName} harness={harness} />
          <ModelPick
            models={models}
            model={chat.model ?? 'default'}
            shownModel={modelLabel(models, chat.model)}
            effort={chat.effort ?? 'default'}
            onModel={(model) => void pick({ model })}
            onEffort={(effort) => void pick({ effort })}
          />
          {harnessHas(harness, 'browser') && <BrowserSwitch on={chat.chrome ?? false} />}
          {canRefresh && <ContextRefreshButton busy={refreshing} onClick={() => void refreshContext()} />}
          <span className="spacer" />
          {busy && <Sending />}
          <ContextRing sample={state.context[chat.id]} />
          {working ? (
            <button type="button" className="thread-stop" title="Stop this turn; the chat keeps its history" disabled={busy} onClick={() => client.stopChat(chat.id).catch((e: unknown) => setError(errorText(e)))}>
              <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" fill="currentColor" />
              </svg>
              Stop
            </button>
          ) : (
            <SendButton busy={busy} disabled={busy || disabled} />
          )}
        </div>
      </form>
    </div>
  );
});

export function DraftComposer({ topicId, home, state }: { topicId: string; home?: string; state: State }) {
  const harnesses = useHarnesses();
  const computer = useComputerChoice(home);
  const noChrome = computer.caps !== null && !computer.caps.browser;
  const policyModels = useModels();
  const [agent, setAgent] = useState<string>();
  const [model, setModel] = useState<string>();
  const [effort, setEffort] = useState<Effort>();
  const [pickedChrome, setChrome] = useState<boolean>();
  const profilePick = useProfilePick(lastProfile(Object.values(state.chats), topicId));
  const chrome = pickedChrome ?? profilePick.browser;
  const shownAgent = agent ?? profilePick.defaults?.harness ?? harnesses?.[0]?.id;
  const harness = extraHarness(harnesses, shownAgent);
  const models = harness?.models ?? policyModels;
  const [{ text, files: pending }, setDraft] = useDraft(`new:${topicId}`);
  const setText = (next: string) => setDraft((draft) => ({ ...draft, text: next }));
  const setPending = (next: (files: DraftFile[]) => DraftFile[]) => setDraft((draft) => ({ ...draft, files: next(draft.files) }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const box = useRef<HTMLTextAreaElement>(null);
  const slash = useSlash(text, setText, box, profilePick.profile);
  const tint = profileStyle(useProfileColors()[profilePick.profile]);
  const { drop, handlers } = useAttach(topicId, setPending);
  const ready = pending.filter((f) => f.path);
  useEffect(() => box.current?.focus(), []);
  useGrow(box, text);

  const pickAgent = (id: string) => {
    setAgent(id);
    setModel(undefined);
    setEffort(undefined);
  };
  const send = async () => {
    const message = text.trim();
    if ((!message && !ready.length) || busy) return;
    if (pending.some((f) => !f.path && !f.error)) return setError('Wait for the attachments to finish copying.');
    setBusy(true);
    setError(undefined);
    try {
      const chat = await client.addTopicChat(topicId, {
        ...(agent ? { agent } : {}),
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...(harnessHas(harness, 'browser') ? { chrome: chrome && !noChrome } : {}),
        ...profilePick.pick,
        ...(computer.picked ? { computer: computer.picked.name } : {}),
      });
      setDraft((draft) => ({ ...draft, text: '', files: [] }));
      location.hash = topicHref(topicId, chat.id);
      await client
        .sendMessage(chat.id, message || 'See the attached files.', ready.flatMap((f) => (f.path ? [f.path] : [])))
        .catch(() => updateDraft(chat.lineageId, (draft) => ({ ...draft, text: message, files: ready })));
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };
  const fallback = profileDefaults(profilePick.defaults, shownAgent, models);
  const shownModel = model ?? fallback.model ?? null;
  const shownEffort = effort ?? fallback.effort ?? 'high';

  return (
    <div className="composer-wrap">
      <form
        className={`composer${tint.className}${drop ? ' thread-drop' : ''}`}
        style={tint.style}
        aria-label="Composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
        {...handlers}
      >
        <PendingFiles pending={pending} setPending={setPending} />
        {slash.menu}
        <label className="sr" htmlFor={`msg-new-${topicId}`}>
          Message this topic
        </label>
        <textarea
          id={`msg-new-${topicId}`}
          ref={box}
          rows={2}
          value={text}
          readOnly={busy}
          aria-busy={busy}
          enterKeyHint="send"
          placeholder="First message for the new chat"
          onChange={(e) => {
            setText(e.target.value);
            slash.typed();
          }}
          onKeyDown={(e) => {
            if (slash.key(e)) return;
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        {error && (
          <p className="error-text composer-error" role="alert">
            {error}
          </p>
        )}
        <div className="cbar">
          {harnesses && harnesses.length > 1 && (
            <Pick
              label="Agent"
              shown={harnesses.find((choice) => choice.id === shownAgent)?.label ?? harnesses[0]!.label}
              sections={[
                {
                  label: 'Agent',
                  value: shownAgent ?? harnesses[0]!.id,
                  options: harnesses.map((choice) => ({
                    value: choice.id,
                    label: choice.label,
                    ...(lacksHarness(computer.caps, choice.id) ? { disabled: true, title: `${choice.label} isn’t logged in on ${computer.picked!.name}` } : {}),
                  })),
                  onPick: pickAgent,
                },
              ]}
            />
          )}
          <ModelPick
            models={models}
            model={shownModel ?? 'default'}
            shownModel={modelLabel(models, shownModel)}
            effort={shownEffort}
            onModel={setModel}
            onEffort={setEffort}
          />
          {profilePick.picker && <Pick label="Profile" shown={profilePick.profile} sections={[profilePick.picker]} />}
          <ComputerPick choice={computer} onPick={(picked) => agent && lacksHarness(picked?.caps ?? null, agent) && pickAgent(harnesses![0]!.id)} />
          {harnessHas(harness, 'browser') &&
            (noChrome ? (
              <BrowserSwitch on={false} title={`${computer.picked!.name} has no Chrome`} />
            ) : (
              <BrowserSwitch on={chrome} onToggle={() => setChrome(!chrome)} />
            ))}
          <span className="spacer" />
          {busy && <Sending />}
          <SendButton busy={busy} disabled={busy || (!text.trim() && !ready.length)} />
        </div>
        {computer.picked && <ComputerNote name={computer.picked.name} state={state} topicId={topicId} />}
      </form>
    </div>
  );
}

function PendingFiles({ pending, setPending }: { pending: DraftFile[]; setPending: (next: (files: DraftFile[]) => DraftFile[]) => void }) {
  if (!pending.length) return null;
  return (
    <div className="thread-pending" aria-label="Attachments to send">
      {pending.map((file) => (
        <AttachmentChip key={file.key} name={file.name} title={file.path ?? file.error ?? 'copying…'} note={file.error ? `not copied: ${file.error}` : 'copies to topic attachments'}>
          <IconButton className="thread-att-x" icon="i-x" label={`Remove ${file.name}`} tip="Remove this attachment" onClick={() => setPending((list) => list.filter((p) => p.key !== file.key))} />
        </AttachmentChip>
      ))}
    </div>
  );
}

function HarnessBadge({ agent, label, harness }: { agent: string; label: string; harness: HarnessChoice | undefined }) {
  const color = harness?.badge?.color;
  return (
    <span
      className={`harness-badge${harness ? ' other' : ' claude'}`}
      style={color ? { background: color } : undefined}
      role="img"
      aria-label={`Agent: ${label}`}
      title={`Agent: ${label}, fixed when the chat started`}
    >
      {badgeText(harness, agent, label)}
    </span>
  );
}

function Sending() {
  return (
    <span className="composer-sending" role="status">
      Sending…
    </span>
  );
}

function SendButton({ busy, disabled }: { busy: boolean; disabled: boolean }) {
  return (
    <IconButton type="submit" className="thread-send" icon={busy ? 'i-wait' : 'i-send'} label={busy ? 'Sending…' : 'Send'} tip={busy ? 'Sending…' : 'Send message (Enter)'} disabled={disabled} />
  );
}

function ContextRing({ sample }: { sample: { tokens: number; handoff: number } | undefined }) {
  const used = sample && sample.handoff > 0 ? Math.min(100, Math.round((sample.tokens / sample.handoff) * 100)) : 0;
  const tokens = `${Math.round((sample?.tokens ?? 0) / 1000)}k`;
  const words = `${tokens} tokens, ${used}% of context`;
  const length = 2 * Math.PI * 7;
  return (
    <span className={`context-ring${used >= 90 ? ' full' : used >= 70 ? ' high' : ''}`} role="img" aria-label={words} title={words}>
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <circle cx="8" cy="8" r="7" className="track" />
        <circle cx="8" cy="8" r="7" className="used" strokeDasharray={`${(length * used) / 100} ${length}`} transform="rotate(-90 8 8)" />
      </svg>
      <span aria-hidden="true">{tokens}</span>
    </span>
  );
}

function useGrow(box: RefObject<HTMLTextAreaElement | null>, text: string) {
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = '';
    el.style.height = `${Math.min(el.scrollHeight, el.offsetHeight * 2)}px`;
  }, [text]);
}

export function BrowserSwitch({ on, onToggle, title: reason }: { on: boolean; onToggle?: () => void; title?: string }) {
  const title =
    reason ??
    (onToggle ? `Start with Claude in Chrome: ${on ? 'on' : 'off'}` : `Browser: ${on ? 'on' : 'off'} (set when a chat starts)`);
  return (
    <button type="button" className={`mode-switch browser-switch${on ? ' on' : ''}`} aria-label="Browser" aria-pressed={on} title={title} disabled={!onToggle} onClick={onToggle}>
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
        <path d="M2 6h12" />
        <path d="M4.25 4.25h.01M6 4.25h.01" />
      </svg>
    </button>
  );
}

function ContextRefreshButton({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`mode-switch context-refresh${busy ? ' busy' : ''}`}
      aria-label="Refresh context"
      title="Save progress, then restart with fresh context"
      disabled={busy}
      aria-busy={busy || undefined}
      onClick={onClick}
    >
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        <path d="M13 8a5 5 0 1 1-1.6-3.7" />
        <path d="M13.2 2.3v2.6h-2.6" />
      </svg>
    </button>
  );
}

function ModelPick(props: {
  models: ModelsConfig | undefined;
  model: string;
  shownModel: string;
  effort: string;
  onModel: (model: string) => void;
  onEffort: (effort: Effort) => void;
}) {
  return (
    <Pick
      label="Model"
      shown={`${props.shownModel} · ${props.effort}`}
      name={`Model: ${props.shownModel}, effort ${props.effort}`}
      sections={[
        { label: 'Model', value: props.model, options: (props.models?.list ?? []).map((choice) => ({ value: choice.id, label: choice.label })), onPick: props.onModel },
        { label: 'Effort', value: props.effort, options: EFFORT_CHOICES, onPick: (effort) => props.onEffort(effort as Effort) },
      ]}
    />
  );
}

interface PickSection {
  label: string;
  value: string;
  options: readonly { value: string; label: string; hint?: string; disabled?: boolean; title?: string }[];
  onPick: (value: string) => void;
}

function Pick({ label, shown, name = `${label}: ${shown}`, sections }: { label: string; shown: string; name?: string; sections: PickSection[] }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    wrap.current?.querySelector<HTMLButtonElement>('[aria-checked="true"], [role="menuitemradio"]')?.focus();
    const away = (e: Event) => wrap.current?.contains(e.target as Node) || setOpen(false);
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [open]);
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  let pop: ReactNode = null;
  if (open)
    pop = (
      <div
        className="thread-pop"
        role="menu"
        aria-label={label}
        onKeyDown={(e) => {
          const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
          const i = items.indexOf(document.activeElement as HTMLButtonElement);
          if (e.key === 'Escape') close();
          else if (e.key === 'ArrowDown') items[(i + 1) % items.length]?.focus();
          else if (e.key === 'ArrowUp') items[(i - 1 + items.length) % items.length]?.focus();
          else return;
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        {sections.map((section) => (
          <div key={section.label} role="group" aria-label={section.label}>
            <h4>{section.label}</h4>
            {section.options.map((option) => (
              <button
                key={option.value}
                type="button"
                className="opt"
                role="menuitemradio"
                aria-checked={option.value === section.value}
                disabled={option.disabled}
                title={option.title ?? option.label}
                onClick={() => {
                  if (option.value !== section.value) section.onPick(option.value);
                  close();
                }}
              >
                {option.hint ? (
                  <span className="opt-text">
                    {option.label}
                    <small className="opt-hint">{option.hint}</small>
                  </span>
                ) : (
                  option.label
                )}
              </button>
            ))}
          </div>
        ))}
      </div>
    );
  return (
    <div className="thread-picker" ref={wrap}>
      <button
        ref={button}
        type="button"
        className="pick"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={name}
        title={`${name}; click to change`}
        onClick={() => setOpen(!open)}
      >
        <span>{shown}</span>
        <Icon id="i-chev" />
      </button>
      {pop}
    </div>
  );
}
