import { useEffect, useState, type FormEvent } from 'react';
import type { Computer, ScheduleInput, ScheduleList, ScheduleView } from '../../../src/api/types.js';
import { client, errorText } from '../lib.js';
import { openComputerTopic, useComputers } from '../model/computers.js';
import { topicHref } from '../shell/routes.js';
import { useOwner } from '../topic/catalog.js';
import { cronText } from './cron.js';
import './schedules.css';

function formatAt(at: number, timeZone: string | undefined): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
}

type Target = 'new' | 'desk' | 'topic';

interface Host {
  value: string;
  label: string;
}

const norm = (host: string) => host.trim().toLowerCase().replace(/\.local$/, '');

interface Draft {
  id: string;
  host: string;
  cron: string;
  target: Target;
  topic: string;
  prompt: string;
  model: string;
  profile: string;
  paused: boolean;
}

type Editing = { id?: string; draft: Draft };

function draftOf(row: ScheduleView): Draft {
  return {
    id: row.id,
    host: row.host,
    cron: row.cron,
    target: row.topic ? 'topic' : row.desk ? 'desk' : 'new',
    topic: row.topic ?? '',
    prompt: row.prompt,
    model: row.model ?? '',
    profile: row.profile ?? '',
    paused: row.paused === true,
  };
}

function inputOf(d: Draft): ScheduleInput {
  return {
    id: d.id.trim(),
    host: d.host,
    cron: d.cron.trim(),
    prompt: d.prompt,
    ...(d.target === 'desk' ? { desk: true } : {}),
    ...(d.target === 'topic' ? { topic: d.topic.trim() } : {}),
    ...(d.model.trim() ? { model: d.model.trim() } : {}),
    ...(d.profile.trim() ? { profile: d.profile.trim() } : {}),
    ...(d.paused ? { paused: true } : {}),
  };
}

export function SchedulesPage() {
  const [list, setList] = useState<ScheduleList>();
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState<Editing>();
  const owner = useOwner();
  useEffect(() => {
    const load = () => void client.schedules().then((l) => (setList(l), setError(undefined)), (e: unknown) => setError(errorText(e)));
    load();
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, []);
  const { view } = useComputers();
  const [only, setOnly] = useState(() => new URLSearchParams(location.hash.split('?')[1]).get('computer') ?? undefined);
  const out = view?.computers.filter((c) => c.direction === 'out') ?? [];
  const self = view?.self.name ?? list?.host ?? '';
  const hosts: Host[] = [];
  for (const host of list ? [{ value: list.host, label: `${self} (this computer)` }, ...out.flatMap((c) => (c.caps ? [{ value: c.caps.scheduleHost, label: c.name }] : [])), ...list.schedules.map((s) => ({ value: s.host, label: s.host }))] : []) {
    if (!hosts.some((h) => norm(h.value) === norm(host.value))) hosts.push(host);
  }
  const shown = list?.schedules.filter((row) => only === undefined || (only === self ? row.local : row.computer === only)) ?? [];
  const add = () => list && setEditing({ draft: { id: '', host: list.host, cron: '', target: 'new', topic: '', prompt: '', model: '', profile: '', paused: false } });
  return (
    <>
      <div className="schedules-body">
        <div className="schedules-head">
          <p className="muted">
            {list && <code>{list.file}</code>} Times are {owner ? `${owner.timezone} (${owner.timezoneLabel})` : 'in the hos computer’s time zone'}.
          </p>
          <button type="button" className="btn go" disabled={!list || editing !== undefined} onClick={add}>
            Add schedule
          </button>
        </div>
        {error && <p className="error-text">{error}</p>}
        {list?.applyError && (
          <p className="error-text" role="alert">
            {list.applyError}
          </p>
        )}
        {out.length > 0 && (
          <div className="schedules-chips" role="group" aria-label="Show schedules from">
            {[undefined, self, ...out.map((c) => c.name)].map((name) => (
              <button key={name ?? ''} type="button" aria-pressed={only === name} onClick={() => setOnly(name)}>
                {name ?? 'All'}
              </button>
            ))}
          </div>
        )}
        {list && list.problems.length > 0 && (
          <div className="schedules-problems" role="alert">
            {list.problems.map((problem) => (
              <p key={problem}>Skipped {problem}</p>
            ))}
          </div>
        )}
        {editing && list && (
          <ScheduleForm
            key={editing.id ?? ''}
            editing={editing}
            hosts={hosts}
            deskTitle={list.deskTitle ?? 'Quick chats'}
            onCancel={() => setEditing(undefined)}
            onSaved={(next) => {
              setList(next);
              setEditing(undefined);
            }}
          />
        )}
        {!list ? (
          !error && <p className="muted">Loading…</p>
        ) : list.schedules.length === 0 ? (
          <p className="muted">No schedules yet.</p>
        ) : (
          <table className="schedules-table" aria-label="Schedules">
            <thead>
              <tr>
                <th>ID</th>
                <th>Host</th>
                <th>When</th>
                <th>Target</th>
                <th>Next run</th>
                <th>Last run</th>
                <th>
                  <span className="sr">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <ScheduleRow
                  key={row.id}
                  row={row}
                  self={self}
                  computer={out.find((c) => c.name === row.computer)}
                  onChange={setList}
                  onEdit={() => setEditing({ id: row.id, draft: draftOf(row) })}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function ScheduleRow({ row, self, computer, onChange, onEdit }: { row: ScheduleView; self: string; computer?: Computer; onChange: (list: ScheduleList) => void; onEdit: () => void }) {
  const zone = useOwner()?.timezone;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [confirm, setConfirm] = useState(false);
  const act = async (action: () => Promise<ScheduleList>) => {
    setBusy(true);
    setError(undefined);
    try {
      onChange(await action());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  };
  const go = async (start: () => Promise<{ topicId: string; chatId: string | null; computer?: string }>) => {
    setBusy(true);
    setError(undefined);
    try {
      const { topicId, chatId, computer } = await start();
      if (computer) await openComputerTopic(computer, topicId);
      location.hash = topicHref(topicId, chatId);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };
  const open = row.computer && row.topicId ? () => void go(async () => ({ topicId: row.topicId!, chatId: row.chatId, computer: row.computer })) : undefined;
  const description = cronText(row.cron);
  return (
    <tr className={row.paused ? 'paused' : undefined} aria-label={row.id}>
      <td>
        <span className="schedules-id">{row.id}</span>
        {row.paused && <span className="tag">Paused</span>}
      </td>
      <td>
        {row.local ? (
          self
        ) : row.computer ? (
          <>
            <span className="schedules-computer">{row.computer}</span>
            <div className="muted">
              {computer && !computer.online ? `offline · last seen ${computer.lastSeen === null ? 'never' : formatAt(computer.lastSeen, zone)} · ` : ''}
              {row.applied ? `applied on ${row.computer}` : 'not yet applied'}
            </div>
          </>
        ) : (
          `runs on ${row.host}`
        )}
      </td>
      <td>
        <code>{row.cron}</code>
        {description !== row.cron && <div className="muted">{description}</div>}
      </td>
      <td>{row.target}</td>
      <td className="schedules-when">{row.paused ? 'Paused' : row.nextRun === null ? '—' : formatAt(row.nextRun, zone)}</td>
      <td className="schedules-when">{row.local || row.computer ? <LastRun row={row} open={open} /> : '—'}</td>
      <td>
        {confirm ? (
          <div className="schedules-acts" role="group" aria-label={`Delete ${row.id}?`}>
            <span>Delete {row.id}?</span>
            <button type="button" className="btn danger" disabled={busy} onClick={() => void act(() => client.deleteSchedule(row.id))}>
              Delete
            </button>
            <button type="button" className="btn" onClick={() => setConfirm(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <div className="schedules-acts">
            <button type="button" className="btn" disabled={busy} onClick={onEdit}>
              Edit
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => void act(() => client.pauseSchedule(row.id, !row.paused))}>
              {row.paused ? 'Resume' : 'Pause'}
            </button>
            {(row.local || computer?.online) && (
              <button type="button" className="btn" disabled={busy} onClick={() => void go(() => client.runSchedule(row.id))}>
                Run now
              </button>
            )}
            <button type="button" className="btn danger" disabled={busy} onClick={() => setConfirm(true)}>
              Delete
            </button>
          </div>
        )}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
      </td>
    </tr>
  );
}

function LastRun({ row, open }: { row: ScheduleView; open?: () => void }) {
  const zone = useOwner()?.timezone;
  if (row.lastRun === null) return <>—</>;
  const when = formatAt(row.lastRun, zone);
  return (
    <>
      {row.topicId ? (
        <a href={topicHref(row.topicId, row.chatId)} onClick={open && ((e) => (e.preventDefault(), open()))}>
          {when}
        </a>
      ) : (
        when
      )}
      {row.result && (
        <span className={`tag${row.result === 'failed' ? ' stop' : ''}`} title={row.summary ?? undefined}>
          {row.result}
        </span>
      )}
    </>
  );
}

function ScheduleForm({ editing, hosts, deskTitle, onCancel, onSaved }: { editing: Editing; hosts: Host[]; deskTitle: string; onCancel: () => void; onSaved: (list: ScheduleList) => void }) {
  const [draft, setDraft] = useState(editing.draft);
  const label = useOwner()?.timezoneLabel;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      onSaved(await client.saveSchedule(inputOf(draft), editing.id));
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  const description = draft.cron.trim() ? cronText(draft.cron) : '';
  const title = editing.id === undefined ? 'Add schedule' : `Edit ${editing.id}`;
  return (
    <form className="schedules-form" aria-label={title} onSubmit={save}>
      <h2>{title}</h2>
      <label>
        ID
        <input value={draft.id} required autoFocus onChange={(e) => set({ id: e.target.value })} />
      </label>
      <label>
        Host
        <select value={hosts.find((h) => norm(h.value) === norm(draft.host))?.value ?? draft.host} onChange={(e) => set({ host: e.target.value })}>
          {hosts.map((h) => (
            <option key={h.value} value={h.value}>
              {h.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Cron{label ? ` (${label})` : ''}
        <input value={draft.cron} required placeholder="0 9 * * 1-5" onChange={(e) => set({ cron: e.target.value })} />
        {description && description !== draft.cron.trim() && <span className="muted">{description}</span>}
      </label>
      <label>
        Target
        <select value={draft.target} onChange={(e) => set({ target: e.target.value as Target })}>
          <option value="new">New topic</option>
          <option value="desk">{deskTitle}</option>
          <option value="topic">Topic</option>
        </select>
      </label>
      {draft.target === 'topic' && (
        <label>
          Topic title
          <input value={draft.topic} required onChange={(e) => set({ topic: e.target.value })} />
        </label>
      )}
      <label className="schedules-wide">
        Prompt
        <textarea rows={5} value={draft.prompt} required onChange={(e) => set({ prompt: e.target.value })} />
      </label>
      <label>
        Model (optional)
        <input value={draft.model} placeholder="default" onChange={(e) => set({ model: e.target.value })} />
      </label>
      <label>
        Profile (optional)
        <input value={draft.profile} placeholder="generic" onChange={(e) => set({ profile: e.target.value })} />
      </label>
      {error && (
        <p className="error-text schedules-wide" role="alert">
          {error}
        </p>
      )}
      <div className="schedules-acts schedules-wide">
        <button type="submit" className="btn go" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
