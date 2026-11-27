import { useEffect, useRef, useState } from 'react';
import { SNAG_KIND_LABELS, type Snag, type SnagFilter, type SnagKind, type SnagSummary } from '../../../src/snags/types.js';
import { errorText } from '../lib.js';
import { topicRows } from '../model/index.js';
import { Icon, IconButton } from '../shell/icons.js';
import { useOwner } from '../topic/catalog.js';
import { useShell } from '../shell/Layout.js';
import { topicHref } from '../shell/routes.js';
import type { State } from '../state.js';
import { SnagForm } from './SnagForm.js';
import { fileBlobUrl, snags, snagsChanged, useSnagsVersion } from './store.js';
import './snags.css';

const STATES: Array<[SnagFilter, string]> = [
  ['open', 'Open'],
  ['resolved', 'Resolved'],
  ['all', 'All'],
];
const KINDS: Array<[SnagKind | 'all', string]> = [
  ['all', 'Any kind'],
  ['fix', 'Fixes'],
  ['question', 'Questions'],
  ['context', 'Context'],
];

export default function SnagsPage({ state }: { state: State }) {
  const shell = useShell();
  const version = useSnagsVersion();
  const [filter, setFilter] = useState<SnagFilter>('open');
  const [kind, setKind] = useState<SnagKind | 'all'>('all');
  const [list, setList] = useState<Snag[]>();
  const [summary, setSummary] = useState<SnagSummary>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    snags.list(filter).then(
      (found) => cancelled || (setList(found), setError(undefined)),
      (e: unknown) => cancelled || setError(errorText(e)),
    );
    snags.summary().then((s) => cancelled || setSummary(s), () => {});
    return () => {
      cancelled = true;
    };
  }, [filter, version]);
  const shown = list?.filter((s) => kind === 'all' || s.kind === kind);
  return (
    <>
      <header className="topbar">
        <IconButton className="icon-btn menu-btn" icon="i-menu" label="Open navigation" tip="Open the sidebar" onClick={shell.openSide} />
        <h1>Snags</h1>
      </header>
      <div className="snags-body">
        <p className="snags-subtitle muted">Bugs, questions and context you note while you work. Any chat can pick one up, fix it and resolve it.</p>
        <SnagForm />
        <div className="snags-filters">
          <Segmented label="State" options={STATES} value={filter} onChange={setFilter} />
          <Segmented label="Kind" options={KINDS} value={kind} onChange={setKind} />
        </div>
        {summary?.offline && (
          <p className="snags-offline">
            {summary.label} offline · {summary.queued} queued
          </p>
        )}
        {error && <p className="error-text">{error}</p>}
        {shown && shown.length === 0 && <p className="muted snags-empty">{filter === 'open' ? 'Nothing open. Nice.' : 'No snags here.'}</p>}
        <ul className="snags-list" aria-label="Snags">
          {shown?.map((snag) => (
            <SnagCard key={snag.id} snag={snag} state={state} />
          ))}
        </ul>
      </div>
    </>
  );
}

function Segmented<T extends string>({ label, options, value, onChange }: { label: string; options: Array<[T, string]>; value: T; onChange: (v: T) => void }) {
  return (
    <div className="snag-kind" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" aria-pressed={value === v} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}

type Mode = 'idle' | 'resolve' | 'chat' | 'delete' | 'edit' | 'comment';

function SnagCard({ snag, state }: { snag: Snag; state: State }) {
  const [mode, setMode] = useState<Mode>('idle');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [note, setNote] = useState('');
  const [topicId, setTopicId] = useState('');
  const [draft, setDraft] = useState('');
  const ownerLabel = useOwner()?.name ?? 'You';
  const run = async (action: () => Promise<unknown>, after?: (out: unknown) => void) => {
    setBusy(true);
    setError(undefined);
    try {
      const out = await action();
      setMode('idle');
      snagsChanged();
      after?.(out);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const open = (out: unknown) => {
    const link = out as { topicId: string; chatId: string };
    location.hash = topicHref(link.topicId, link.chatId);
  };
  const topics = mode === 'chat' ? topicRows(state) : [];
  return (
    <li className={`snag-card${snag.state !== 'open' ? ' resolved' : ''}`} aria-label={snag.ref}>
      <div className="snag-meta">
        <span className="snag-ref">{snag.ref}</span>
        <span className={`snag-tag ${snag.kind}`}>{SNAG_KIND_LABELS[snag.kind]}</span>
        <span className="muted">
          {ago(snag.createdAt)}
          {snag.from ? ` · from ${snag.from}` : snag.createdBy !== 'you' && ` · by chat ${snag.createdBy.slice(0, 8)}`}
        </span>
        {snag.state !== 'open' && (
          <span className="snag-done">
            <Icon id="i-check" />
            {snag.state === 'wontfix' ? "Won't fix" : snag.state === 'not-reproduced' ? 'Not reproduced' : 'Resolved'}
            {snag.resolvedBy && snag.resolvedBy !== 'you' ? ` by chat ${snag.resolvedBy.slice(0, 8)}` : ''}
          </span>
        )}
      </div>
      {mode === 'edit' ? (
        <form
          className="snag-edit"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim()) void run(() => snags.edit(snag.ref, draft));
          }}
        >
          <textarea
            aria-label={`Text of ${snag.ref}`}
            value={draft}
            autoFocus
            rows={Math.min(12, draft.split('\n').length + 1)}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setMode('idle');
              else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
            }}
          />
          <div className="snag-acts">
            <button type="submit" className="btn go" disabled={busy || !draft.trim()}>
              Save
            </button>
            <button type="button" className="btn" onClick={() => setMode('idle')}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        snag.text && <p className="snag-text">{snag.text}</p>
      )}
      {snag.note && <p className="snag-resolution">{snag.note}</p>}
      {snag.comments.length > 0 && (
        <ol className="snag-thread" aria-label={`Comments on ${snag.ref}`}>
          {snag.comments.map((c) => (
            <li key={c.id} className={`snag-comment ${c.author === 'claude' ? 'claude' : 'user'}`}>
              <div className="snag-comment-meta">
                <strong>{c.author === 'claude' ? 'Claude' : ownerLabel}</strong>
                <time dateTime={new Date(c.createdAt).toISOString()} title={new Date(c.createdAt).toLocaleString()}>
                  {ago(c.createdAt)}
                </time>
              </div>
              <p>{c.body}</p>
            </li>
          ))}
        </ol>
      )}
      {snag.files.length > 0 && (
        <ul className="snag-files" aria-label="Files">
          {snag.files.map((f) => (
            <SnagFileThumb key={f.name} snagRef={snag.ref} name={f.name} />
          ))}
        </ul>
      )}
      {snag.links.length > 0 && (
        <p className="snag-links">
          {snag.links.map((l) => (
            <a key={l.chatId} href={topicHref(l.topicId, l.chatId)}>
              {state.topics[l.topicId]?.title ?? `topic ${l.topicId.slice(0, 8)}`}
            </a>
          ))}
        </p>
      )}
      {mode === 'idle' && (
        <div className="snag-acts">
          <button type="button" className="btn go" disabled={busy} onClick={() => void run(() => snags.startTopic(snag.ref), open)}>
            Start topic
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => setMode('chat')}>
            Chat in topic…
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => (setDraft(snag.text), setMode('edit'))}>
            Edit
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => (setDraft(''), setMode('comment'))}>
            Comment
          </button>
          {snag.state === 'open' ? (
            <button type="button" className="btn" disabled={busy} onClick={() => setMode('resolve')}>
              Resolve
            </button>
          ) : (
            <button type="button" className="btn" disabled={busy} onClick={() => void run(() => snags.reopen(snag.ref))}>
              Reopen
            </button>
          )}
          <button type="button" className="btn danger" disabled={busy} onClick={() => setMode('delete')}>
            Delete
          </button>
        </div>
      )}
      {mode === 'resolve' && (
        <form
          className="snag-acts"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => snags.resolve(snag.ref, note));
          }}
        >
          <input aria-label={`Resolution note for ${snag.ref}`} placeholder="What fixed it? (optional)" value={note} autoFocus onChange={(e) => setNote(e.target.value)} />
          <button type="submit" className="btn go" disabled={busy}>
            Resolve
          </button>
          <button type="button" className="btn" onClick={() => setMode('idle')}>
            Cancel
          </button>
        </form>
      )}
      {mode === 'chat' && (
        <form
          className="snag-acts"
          onSubmit={(e) => {
            e.preventDefault();
            if (topicId) void run(() => snags.chatInTopic(snag.ref, topicId), open);
          }}
        >
          <select aria-label={`Topic for ${snag.ref}`} title="Topic to start this snag's chat in" value={topicId} autoFocus onChange={(e) => setTopicId(e.target.value)}>
            <option value="">Pick a topic…</option>
            {topics.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
          <button type="submit" className="btn go" disabled={busy || !topicId}>
            Start chat
          </button>
          <button type="button" className="btn" onClick={() => setMode('idle')}>
            Cancel
          </button>
        </form>
      )}
      {mode === 'comment' && (
        <form
          className="snag-edit"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim()) void run(() => snags.comment(snag.ref, draft));
          }}
        >
          <textarea
            aria-label={`Comment on ${snag.ref}`}
            placeholder="Reply"
            value={draft}
            autoFocus
            rows={3}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setMode('idle');
              else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
            }}
          />
          <div className="snag-acts">
            <button type="submit" className="btn go" disabled={busy || !draft.trim()}>
              Post comment
            </button>
            <button type="button" className="btn" onClick={() => setMode('idle')}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {mode === 'delete' && (
        <div className="snag-acts" role="group" aria-label={`Delete ${snag.ref}?`}>
          <span>Delete {snag.ref} and its files?</span>
          <button type="button" className="btn danger" disabled={busy} onClick={() => void run(() => snags.remove(snag.ref))}>
            Delete
          </button>
          <button type="button" className="btn" onClick={() => setMode('idle')}>
            Cancel
          </button>
        </div>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

function SnagFileThumb({ snagRef, name }: { snagRef: string; name: string }) {
  const ref = useRef<HTMLLIElement>(null);
  const [url, setUrl] = useState<string>();
  const image = /\.(png|jpe?g|gif|webp)$/i.test(name);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let made: string | undefined;
    let cancelled = false;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      observer.disconnect();
      fileBlobUrl(snagRef, name).then(
        (u) => (cancelled ? URL.revokeObjectURL(u) : ((made = u), setUrl(u))),
        () => {},
      );
    });
    observer.observe(el);
    return () => {
      cancelled = true;
      observer.disconnect();
      if (made) URL.revokeObjectURL(made);
    };
  }, [snagRef, name]);
  return (
    <li ref={ref}>
      <a href={url} target="_blank" rel="noreferrer" aria-label={`Open ${name}`} title={name}>
        {image && url ? <img src={url} alt={name} /> : <span className="snag-file-name">{name}</span>}
      </a>
    </li>
  );
}

function ago(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
