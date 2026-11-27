import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { Effort } from '../../../src/api/types.js';
import { useDraft } from '../drafts.js';
import { errorText } from '../lib.js';
import { startTopic } from '../model/index.js';
import { Icon, IconButton } from '../shell/icons.js';
import { useShell } from '../shell/Layout.js';
import { topicHref } from '../shell/routes.js';
import { extraHarness, harnessHas, modelLabel, useHarnesses, useModels } from '../topic/catalog.js';
import { BrowserSwitch } from '../topic/Composer.js';
import { ComputerPick, lacksHarness, useComputerChoice } from '../topic/ComputerPick.js';
import { profileDefaults, useProfilePick } from '../topic/ProfilePick.js';
import { useSlash } from '../topic/slash.js';
import { AttachmentChip } from '../topic/timeline.js';
import { readBase64, useFileInput } from '../topic/useAttach.js';
import '../styles/new-chat.css';
import '../styles/topic.css';

const EFFORT_CHOICES: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export function NewChat({ prompt, quickTitle = 'Quick chats' }: { prompt: string; quickTitle?: string }) {
  const shell = useShell();
  const policyModels = useModels();
  const harnesses = useHarnesses();
  const computer = useComputerChoice();
  const noChrome = computer.caps !== null && !computer.caps.browser;
  const [pickedAgent, setAgent] = useState<string>();
  const profilePick = useProfilePick();
  const agent = pickedAgent ?? profilePick.defaults?.harness ?? harnesses?.[0]?.id;
  const harness = extraHarness(harnesses, agent);
  const models = harness?.models ?? policyModels;
  const [{ text }, setDraft] = useDraft('new');
  const setText = (next: string) => setDraft((draft) => ({ ...draft, text: next }));
  const [picked, setModel] = useState<string>();
  const [pickedEffort, setEffort] = useState<Effort>();
  const [pickedChrome, setChrome] = useState<boolean>();
  const chrome = pickedChrome ?? profilePick.browser;
  const [quick, setQuick] = useState(false);
  const pickAgent = (id: string) => {
    setAgent(id);
    setModel(undefined);
    setEffort(undefined);
  };
  const fallback = profileDefaults(profilePick.defaults, agent, models);
  const model = picked ?? fallback.model;
  const effort = pickedEffort ?? fallback.effort ?? 'high';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const box = useRef<HTMLTextAreaElement>(null);
  const slash = useSlash(text, setText, box, profilePick.profile);
  const [files, setFiles] = useState<Array<{ key: string; file: File }>>([]);
  const { drop, handlers } = useFileInput((list) => {
    if (!list.length || busy) return false;
    const added = list.map((file, i) => ({ key: `${Date.now()}-${i}-${file.name}`, file: file.name ? file : new File([file], 'pasted-image.png', { type: file.type }) }));
    setFiles((current) => [...current, ...added]);
    return true;
  }, busy);
  useEffect(() => {
    if (prompt) setText(prompt);
    const el = box.current!;
    el.focus();
    const end = (prompt || el.value).length;
    el.setSelectionRange(end, end);
  }, [prompt]);
  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    const message = text.trim();
    if ((!message && !files.length) || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const data = await Promise.all(files.map(async ({ file }) => ({ name: file.name, data: await readBase64(file) })));
      const pick = {
        model,
        effort,
        desk: quick,
        ...profilePick.pick,
        ...(agent ? { agent } : {}),
        ...(harnessHas(harness, 'browser') ? { chrome: chrome && !noChrome } : {}),
        ...(computer.picked ? { computer: computer.picked.name } : {}),
      };
      const { topicId, chatId } = await startTopic(message || 'See the attached files.', pick, data);
      setText('');
      setFiles([]);
      location.hash = topicHref(topicId, quick ? chatId : undefined);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <>
      <header className="topbar">
        <IconButton className="icon-btn menu-btn" icon="i-menu" label="Open navigation" tip="Open the sidebar" onClick={shell.openSide} />
        <h1>New chat</h1>
      </header>
      <div className="new-chat-body">
        <div className="new-chat-col">
          <div className="new-chat-empty">
            <h2>What should the brain work on?</h2>
            <p className="muted">
              {quick
                ? `Quick is on: sending starts a new chat in ${quickTitle}, the topic for quick, unrelated asks. The chat runs in the brain and asks you before it works in a repo.`
                : 'Sending starts a new topic, named from your prompt. The chat runs in the brain and asks you before it works in a repo.'}
            </p>
            <p className="muted">
              To add to an earlier topic instead,{' '}
              <button type="button" className="new-chat-link" title="Open search to pick an earlier topic" onClick={shell.openPalette}>
                continue a topic
              </button>{' '}
              from Search and commands
              <span className="new-chat-key">
                {' '}
                <kbd>⌘K</kbd>
              </span>
              .
            </p>
          </div>
        </div>
      </div>
      <div className="new-chat-wrap">
        <form className={`new-chat-composer${drop ? ' thread-drop' : ''}`} aria-label="New chat" onSubmit={send} {...handlers}>
          {files.length > 0 && (
            <div className="thread-pending" aria-label="Attachments to send">
              {files.map(({ key, file }) => (
                <AttachmentChip key={key} name={file.name} title={file.name} note="copies to topic attachments">
                  <IconButton className="thread-att-x" icon="i-x" label={`Remove ${file.name}`} tip="Remove this attachment" onClick={() => setFiles((current) => current.filter((f) => f.key !== key))} />
                </AttachmentChip>
              ))}
            </div>
          )}
          {slash.menu}
          <label className="sr" htmlFor="new-chat-msg">
            Prompt for the new topic
          </label>
          <textarea
            id="new-chat-msg"
            ref={box}
            rows={3}
            value={text}
            enterKeyHint="send"
            placeholder="Describe the work. / for skills"
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
            <p className="error-text new-chat-error" role="alert">
              {error}
            </p>
          )}
          <div className="new-chat-bar">
            {harnesses && harnesses.length > 1 && (
              <Picker
                label="Agent"
                value={harness?.id ?? harnesses[0]!.id}
                shown={harness?.label ?? harnesses[0]!.label}
                options={harnesses.map((choice) => ({
                  value: choice.id,
                  label: choice.label,
                  ...(lacksHarness(computer.caps, choice.id) ? { disabled: true, title: `${choice.label} isn’t logged in on ${computer.picked!.name}` } : {}),
                }))}
                onPick={pickAgent}
              />
            )}
            <Picker
              label="Model"
              value={model ?? ''}
              shown={model ? modelLabel(models, model) : '…'}
              options={(models?.list ?? []).map((choice) => ({ value: choice.id, label: choice.label }))}
              onPick={setModel}
            />
            <Picker
              label="Effort"
              value={effort}
              shown={effort}
              options={EFFORT_CHOICES.map((choice) => ({ value: choice, label: choice }))}
              onPick={(v) => setEffort(v as Effort)}
            />
            {profilePick.picker && <Picker {...profilePick.picker} />}
            <ComputerPick choice={computer} onPick={(picked) => pickedAgent && lacksHarness(picked?.caps ?? null, pickedAgent) && pickAgent(harnesses![0]!.id)} />
            {harnessHas(harness, 'browser') &&
              (noChrome ? (
                <BrowserSwitch on={false} title={`${computer.picked!.name} has no Chrome`} />
              ) : (
                <BrowserSwitch on={chrome} onToggle={() => setChrome(!chrome)} />
              ))}
            <button
              type="button"
              className={`mode-switch quick-switch${quick ? ' on' : ''}`}
              aria-pressed={quick}
              title={quick ? `Quick on: this chat goes to ${quickTitle}` : `Quick: put this in ${quickTitle}, not a new topic`}
              onClick={() => setQuick(!quick)}
            >
              Quick
            </button>
            <span className="new-chat-spacer" />
            <IconButton
              type="submit"
              className="new-chat-send"
              icon="i-send"
              label={quick ? `Send to ${quickTitle}` : 'Send and start the topic'}
              tip={quick ? `Send to ${quickTitle} (Enter)` : 'Send and start a topic (Enter)'}
              disabled={busy || (!text.trim() && !files.length)}
            />
          </div>
        </form>
      </div>
    </>
  );
}

function Picker({
  label,
  value,
  shown,
  options,
  onPick,
}: {
  label: string;
  value: string;
  shown: string;
  options: readonly { value: string; label: string; hint?: string; disabled?: boolean; title?: string }[];
  onPick: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    wrap.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
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
        className="new-chat-pop"
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
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="menuitemradio"
            aria-checked={option.value === value}
            disabled={option.disabled}
            title={option.title ?? option.label}
            onClick={() => {
              onPick(option.value);
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
    );
  return (
    <div className="new-chat-picker" ref={wrap}>
      <button
        ref={button}
        type="button"
        className="new-chat-pick"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${label}: ${shown}`}
        title={`${label}: ${shown}; click to change`}
        onClick={() => setOpen(!open)}
      >
        <span>{shown}</span>
        <Icon id="i-chev" />
      </button>
      {pop}
    </div>
  );
}
