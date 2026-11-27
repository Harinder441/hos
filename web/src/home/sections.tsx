import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import type { CalendarDay, HomeAlert, HomeSummary, TodayList as Today } from '../../../src/api/types.js';
import { client, errorText } from '../lib.js';
import { Icon, ShapeMark } from '../shell/icons.js';
import { useSources } from '../sources.js';
import type { State } from '../state.js';

const HOME_REFRESH_MS = 60_000;
const USAGE_WARN_PCT = 80;

function useHomeSummary(state: State): [HomeSummary | undefined, () => void] {
  const [summary, setSummary] = useState<HomeSummary>();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), HOME_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    let live = true;
    client.home().then(
      (next) => live && setSummary(next),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [state.inbox, tick]);
  return [summary, () => setTick((n) => n + 1)];
}

let today: Today | undefined;
const todayListeners = new Set<() => void>();

function setToday(next: Today) {
  today = next;
  for (const listener of todayListeners) listener();
}

function loadToday(): Promise<void> {
  return client.myToday().then(setToday, (e: unknown) => setToday({ available: false, tasks: [], error: errorText(e) }));
}

function useToday(enabled: boolean): Today | undefined {
  const value = useSyncExternalStore(
    (listener) => {
      todayListeners.add(listener);
      return () => todayListeners.delete(listener);
    },
    () => today,
  );
  useEffect(() => {
    if (enabled) void loadToday();
  }, [enabled]);
  return value;
}

const ALERTS: Record<HomeAlert['kind'], { label: string; shape: 's-stop' | 's-needs'; className: string }> = {
  keeper: { label: 'Background service', shape: 's-stop', className: 'home-alert stop' },
  battery: { label: 'Battery', shape: 's-needs', className: 'home-alert' },
  usage: { label: 'Usage', shape: 's-needs', className: 'home-alert' },
};

function alertTime(at: number): string {
  const when = new Date(at);
  const time = when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(at).setHours(0, 0, 0, 0)) / 86_400_000);
  if (days === 0) return `today ${time}`;
  if (days === 1) return `yesterday ${time}`;
  return `${when.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`;
}

export function AlertBanner({ state }: { state: State }) {
  const [summary, refresh] = useHomeSummary(state);
  const [gone, setGone] = useState<string[]>([]);
  const alerts = (summary?.alerts ?? []).filter((alert) => !gone.includes(alert.id));
  if (alerts.length === 0) return null;
  const dismiss = (id: string) => {
    setGone((ids) => [...ids, id]);
    client.dismissHomeAlert(id).then(refresh, () => setGone((ids) => ids.filter((x) => x !== id)));
  };
  return (
    <div className="home-alerts" role="status" aria-label="Alerts">
      {alerts.map((alert) => {
        const look = ALERTS[alert.kind];
        return (
          <div key={alert.id} className={look.className}>
            <ShapeMark shape={look.shape} />
            <span className="home-alert-k">{look.label}</span>
            <span className="home-alert-t">{alert.text}</span>
            <time className="home-alert-at" dateTime={new Date(alert.at).toISOString()}>
              {alertTime(alert.at)}
            </time>
            <button type="button" className="home-alert-x" aria-label={`Dismiss: ${alert.text}`} title="Dismiss this alert" onClick={() => dismiss(alert.id)}>
              <Icon id="i-x" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function CaptureBox(_props: { state: State }) {
  const sources = useSources();
  const capture = sources?.capture;
  const sameStore = !!capture && capture.label === sources?.tasks?.label;
  const tasks = useToday(sameStore);
  const [text, setText] = useState('');
  const [note, setNote] = useState<{ text: string; error: boolean }>();
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const unavailable = sameStore && tasks !== undefined && !tasks.available;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.code === 'KeyC') {
        e.preventDefault();
        input.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  const send = async (e: FormEvent) => {
    e.preventDefault();
    const thought = text.trim();
    if (!thought || busy || !capture) return;
    setBusy(true);
    try {
      const result = await client.capture(thought);
      if (result.ok) {
        setText('');
        setNote({ text: `Saved to ${capture.label}.`, error: false });
        if (sameStore) void loadToday();
      } else setNote({ text: `${capture.label} didn’t take it (${result.error ?? 'no reason given'}).`, error: true });
    } catch (err) {
      setNote({ text: errorText(err), error: true });
    } finally {
      setBusy(false);
    }
  };
  if (!capture) return null;
  return (
    <form className="home-capture-form" onSubmit={send}>
      <label className="home-capture">
        <Icon id="i-capture" />
        <span className="sr">Capture to {capture.label}</span>
        <input
          ref={input}
          value={text}
          disabled={unavailable}
          placeholder={unavailable ? `Capture needs ${capture.label}, which hos can’t reach` : 'Add a task for today, or a link to read later'}
          onChange={(e) => {
            setText(e.target.value);
            setNote(undefined);
          }}
        />
        <kbd aria-hidden="true">⌘⇧C</kbd>
      </label>
      <p className={`home-capture-note${note?.error ? ' error-text' : ''}`} role="status">
        {unavailable ? '' : (note?.text ?? '')}
      </p>
    </form>
  );
}

export function TodayTasks(_props: { state: State }) {
  const source = useSources()?.tasks;
  const list = useToday(!!source);
  const [error, setError] = useState<string>();
  if (!source) return null;
  const done = async (id: string) => {
    setError(undefined);
    try {
      const result = await client.myTaskDone(id);
      if (!result.ok) {
        setError(`${source.label} didn’t mark it done (${result.error ?? 'no reason given'}).`);
        return;
      }
      if (today) setToday({ ...today, tasks: today.tasks.filter((task) => task.id !== id) });
      void loadToday();
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <section className="home-blk" aria-labelledby="home-h-tasks">
      <h2 id="home-h-tasks">
        Today <span className="home-src">{source.label}</span>
      </h2>
      {!list ? (
        <p className="home-empty">Asking {source.label}…</p>
      ) : !list.available ? (
        <p className="home-empty">
          {source.label} isn’t reachable from hos ({list.error ?? 'no reason given'})
        </p>
      ) : list.tasks.length === 0 ? (
        <p className="home-empty">Nothing for today</p>
      ) : (
        <ul className="home-list" aria-label="Today">
          {list.tasks.map((task) => (
            <li key={task.id} className="home-task">
              <button type="button" className="home-box" role="checkbox" aria-checked="false" aria-label={`Done: ${task.title}`} title="Mark done" onClick={() => void done(task.id)} />
              <span className="home-t">
                {task.title}
                {task.due && <span className="home-due">due {task.due}</span>}
              </span>
              {task.link && task.link.includes('#/topic/') ? (
                <a className="btn home-hand" href={task.link.slice(task.link.indexOf('#/topic/'))} aria-label={`Open chat: ${task.title}`}>
                  Open chat
                </a>
              ) : (
                <a className="btn home-hand" href={`#/new?prompt=${encodeURIComponent(task.title)}`} aria-label={`Hand to an agent: ${task.title}`}>
                  Hand to an agent
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && <p className="error-text">{error}</p>}
    </section>
  );
}

export function CalendarToday(_props: { state: State }) {
  const source = useSources()?.calendar;
  const [calendar, setCalendar] = useState<CalendarDay>();
  useEffect(() => {
    if (!source) return;
    let live = true;
    client.myCalendar().then(
      (next) => live && setCalendar(next),
      (e: unknown) => live && setCalendar({ available: false, events: [], error: errorText(e) }),
    );
    return () => {
      live = false;
    };
  }, [source]);
  if (!source) return null;
  return (
    <section className="home-blk" aria-labelledby="home-h-cal">
      <h2 id="home-h-cal">
        Calendar <span className="home-src">{source.label}</span>
      </h2>
      {!calendar ? (
        <p className="home-empty">Asking {source.label}…</p>
      ) : !calendar.available ? (
        <p className="home-empty">
          {source.label} isn’t reachable from hos ({calendar.error ?? 'no reason given'})
        </p>
      ) : calendar.events.length === 0 ? (
        <p className="home-empty">Nothing on the calendar today</p>
      ) : (
        <ul className="home-list" aria-label="Calendar">
          {calendar.events.map((event, i) => (
            <li key={i} className="home-cal">
              <b>{event.time}</b>
              <span>{event.title}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Gauge({ label, pct }: { label: string; pct: number | null | undefined }) {
  const known = typeof pct === 'number';
  return (
    <div className="home-gauge" aria-label={label}>
      <span>{label}</span>
      <span className="home-bar" aria-hidden="true">
        {known && <i className={pct >= USAGE_WARN_PCT ? 'warn' : undefined} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />}
      </span>
      <span className="home-v">{known ? `${pct}%` : 'unknown'}</span>
    </div>
  );
}

export function UsageGauges({ state }: { state: State }) {
  const usage = useHomeSummary(state)[0]?.usage;
  return (
    <section className="home-blk" aria-labelledby="home-h-usage">
      <h2 id="home-h-usage">Usage</h2>
      <div className="home-gauges">
        <Gauge label="Claude 5-hour" pct={usage?.fiveHour} />
        <Gauge label="Claude weekly" pct={usage?.weekly} />
      </div>
    </section>
  );
}
