import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type {
  ActionDef,
  ActionList,
  ActionRun,
  Approval,
  DevServer,
  GovernorStatus,
  StatusItem,
  UnmanagedListener,
  Worktree,
} from '../../src/api/types.js';
import { chatLabel, client, errorText, ownerLabel, plural, useAction } from './lib.js';
import { DECISION_LABELS, ViewHeader } from './shared.js';
import { Mark, type Signal } from './signals.js';
import './styles/ops.css';
import type { State } from './state.js';

function Headline({ signal, children, detail }: { signal: Signal; children: ReactNode; detail?: ReactNode }) {
  return (
    <div className={`headline ${signal}`}>
      <Mark signal={signal} />
      <p className="headline-text">{children}</p>
      {detail && <p className="headline-detail">{detail}</p>}
    </div>
  );
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function shortWhen(ms: number): string {
  const at = new Date(ms);
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  if (sameDay(at, new Date())) return time;
  return `${at.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${time}`;
}

const VIA_LABELS: Record<string, string> = { mac: 'Mac', phone: 'phone', policy: 'policy', system: 'system' };

export function AuditView({ state }: { state: State }) {
  const [approvals, setApprovals] = useState<Approval[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    client.listApprovals().then(setApprovals, (e: unknown) => setError(errorText(e)));
  }, [state.lastSeq]);
  const waiting = approvals?.filter((a) => !a.decision).length ?? 0;
  const denied = approvals?.filter((a) => a.decision === 'deny').length ?? 0;
  const approved = approvals?.filter((a) => a.decision?.startsWith('approve')).length ?? 0;
  const latest = approvals?.find((a) => a.decision);
  return (
    <section className="audit ops-view" aria-label="Audit log">
      <ViewHeader title="Audit log" back />
      {error && <p className="error">{error}</p>}
      {approvals && (
        <div className="view-scroll">
          {approvals.length === 0 ? (
            <Headline signal="rest">No decisions yet</Headline>
          ) : (
            <Headline
              signal={waiting ? 'needs' : 'rest'}
              detail={`${plural(approvals.length, 'decision')}, newest first: ${approved} approved, ${denied} denied, ${waiting} waiting.`}
            >
              {waiting ? (
                <>
                  {plural(waiting, 'request')} waiting in <a href="#/">Needs you</a>
                </>
              ) : latest ? (
                `Last decision ${shortWhen(latest.decidedAt ?? latest.createdAt)}: ${(DECISION_LABELS[latest.decision!] ?? latest.decision!).toLowerCase()}`
              ) : null}
            </Headline>
          )}
          {approvals.length > 0 && (
            <table className="data stack" role="table">
              <thead>
                <tr role="row">
                  <th role="columnheader">When</th>
                  <th role="columnheader">Decision</th>
                  <th role="columnheader">Class</th>
                  <th role="columnheader">Chat</th>
                  <th role="columnheader">What</th>
                  <th role="columnheader">Where</th>
                  <th role="columnheader">Why</th>
                </tr>
              </thead>
              <tbody>
                {approvals.map((a) => {
                  const at = a.decidedAt ?? a.createdAt;
                  return (
                    <tr key={a.id} role="row" className={a.decision ? `decided ${a.decision}` : 'waiting'}>
                      <td role="cell" className="when" title={new Date(at).toLocaleString()}>
                        {shortWhen(at)}
                      </td>
                      <td role="cell" className="decision">
                        {a.decision ? (DECISION_LABELS[a.decision] ?? a.decision) : 'Waiting'}
                      </td>
                      <td role="cell" className="class">
                        <span className="tag">{a.actionClass ?? 'unclassified'}</span>
                      </td>
                      <td role="cell" className="owner">
                        {ownerLabel(state, a)}
                      </td>
                      <td role="cell" className="what" title={a.input}>
                        {a.tool} <code>{a.input.slice(0, 80)}</code>
                      </td>
                      <td role="cell" className="where">
                        {a.via ? (VIA_LABELS[a.via] ?? a.via) : ''}
                        {a.decidedBy ? ` · ${a.decidedBy}` : ''}
                      </td>
                      <td role="cell" className="why">
                        {a.reason}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}

const STEP_LABELS = {
  cheaper_models: 'cheaper models for new chats',
  top_priorities_only: 'only P0-P1 run',
  pause_batch: 'batch paused',
} as const;

type WindowReading = GovernorStatus['windows']['fiveHour'];

function windowValue(window: WindowReading): string {
  return window ? `${Math.round(window.pct)}%` : 'no reading';
}

function level(pct: number): '' | ' warn' | ' stop' {
  return pct >= 90 ? ' stop' : pct >= 70 ? ' warn' : '';
}

function Gauge({ pct }: { pct: number | undefined }) {
  return (
    <span className={`gauge${pct === undefined ? ' no-reading' : level(pct)}`} aria-hidden="true">
      {pct !== undefined && <span style={{ width: `${Math.min(100, pct)}%` }} />}
    </span>
  );
}

function governorHeadline(status: GovernorStatus): { signal: Signal; text: string } {
  const { windows, machine, queue } = status;
  if (windows.step === 'pause_batch') return { signal: 'stop', text: 'At a limit: batch work is paused' };
  if (machine?.memory === 'critical') return { signal: 'stop', text: 'At a limit: the Mac is under critical memory pressure' };
  if (windows.step) return { signal: 'needs', text: `Near a limit: ${STEP_LABELS[windows.step]}` };
  const hot = (
    [
      ['5-hour', windows.fiveHour],
      ['weekly', windows.weekly],
    ] as const
  ).find(([, w]) => w && w.pct >= 70);
  if (hot) return { signal: 'needs', text: `Near a limit: the Claude ${hot[0]} window is at ${windowValue(hot[1])}` };
  if (machine && (machine.memory === 'warn' || machine.thermalWarning))
    return { signal: 'needs', text: `Near a limit: the Mac reports ${machine.thermalWarning ? 'a thermal warning' : 'memory pressure'}` };
  if (queue.length) return { signal: 'queued', text: `${plural(queue.length, 'chat')} waiting to start` };
  return { signal: 'go', text: 'Under every limit' };
}

function queueReason(reason: string): string {
  const slots = /^all \d+ (\w+) slots are running$/.exec(reason);
  if (slots) return `every ${slots[1]} chat is busy`;
  return reason;
}

function Reading({ label, value, children, sub }: { label: string; value: ReactNode; children?: ReactNode; sub?: ReactNode }) {
  return (
    <div className="reading">
      <dt>{label}</dt>
      <dd>
        <span className="value">{value}</span>
        {children}
        {sub && <span className="sub">{sub}</span>}
      </dd>
    </div>
  );
}

function resetsText(window: WindowReading): string | undefined {
  return window?.resetsAt ? `resets ${shortWhen(window.resetsAt)}` : undefined;
}

export function GovernorView({ state }: { state: State }) {
  const [status, setStatus] = useState<GovernorStatus>();
  const [error, setError] = useState<string>();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    client.governor().then(setStatus, (e: unknown) => setError(errorText(e)));
  }, [state.lastSeq, tick]);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, []);
  const machine = status?.machine;
  const headline = status && governorHeadline(status);
  const credits = status?.ledger.chats.reduce((sum, row) => sum + row.credits, 0) ?? 0;
  return (
    <section className="governor ops-view" aria-label="Limits">
      <ViewHeader title="Limits" back />
      {error && <p className="error">{error}</p>}
      {status && headline && (
        <div className="view-scroll">
          <Headline signal={headline.signal} detail={status.queue.length ? 'Queued chats start on their own when the reason clears.' : 'Nothing is queued.'}>
            {headline.text}
          </Headline>
          <dl className="readings">
            <Reading label="Claude 5-hour window" value={<span aria-label="Claude 5-hour window">{windowValue(status.windows.fiveHour)}</span>} sub={resetsText(status.windows.fiveHour)}>
              <Gauge pct={status.windows.fiveHour?.pct} />
            </Reading>
            <Reading label="Claude weekly window" value={<span aria-label="Claude weekly window">{windowValue(status.windows.weekly)}</span>} sub={resetsText(status.windows.weekly)}>
              <Gauge pct={status.windows.weekly?.pct} />
            </Reading>
            <Reading
              label="Throttle"
              value={status.windows.step ? STEP_LABELS[status.windows.step] : 'none'}
              sub={status.windows.peak ? 'weekday peak hours: batch deferred' : undefined}
            />
            {credits > 0 && <Reading label="Credits, last 24h" value={<span aria-label="Credits, last 24h">{credits.toFixed(2)} credits</span>} />}
            <Reading
              label="Mac"
              value={
                <span aria-label="Mac">
                  {machine
                    ? `memory ${machine.memory}${machine.thermalWarning ? ' · thermal warning' : ''}${
                        machine.battery ? ` · battery ${machine.battery.percent}%${machine.battery.onBattery ? ' on battery' : ''}` : ''
                      }`
                    : 'no reading yet'}
                </span>
              }
            />
          </dl>
          <h2>Queue</h2>
          {status.queue.length === 0 ? (
            <p className="meta">Nothing is queued.</p>
          ) : (
            <table className="data stack" role="table" aria-label="Queue">
              <thead>
                <tr role="row">
                  <th role="columnheader">Chat</th>
                  <th role="columnheader">Priority</th>
                  <th role="columnheader">Why it waits</th>
                </tr>
              </thead>
              <tbody>
                {status.queue.map((q) => (
                  <tr key={q.chatId} role="row">
                    <td role="cell" className="lead">
                      <a href={`#/chat/${q.chatId}`}>{chatLabel(state, q.chatId)}</a>
                    </td>
                    <td role="cell">
                      P{q.priority}
                      {q.effectivePriority !== q.priority && ` (aged to P${q.effectivePriority})`}
                    </td>
                    <td role="cell">{queueReason(q.reason)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}

const STATUS_SIGNALS: Record<StatusItem['status'], Signal> = { ok: 'go', warn: 'needs', down: 'stop', off: 'rest' };
const STATUS_ORDER: Record<StatusItem['status'], number> = { down: 0, warn: 1, ok: 2, off: 3 };

export function bySeverity(items: StatusItem[]): StatusItem[] {
  return [...items].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
}

function keeperHeadline(health: StatusItem[], checks: StatusItem[] | undefined): { signal: Signal; text: string; detail: string } {
  const down = health.filter((i) => i.status === 'down');
  const warn = health.filter((i) => i.status === 'warn');
  const setup = (checks ?? []).filter((i) => i.status === 'down' || i.status === 'warn').length;
  const detail = checks ? (setup ? `The doctor has ${`${setup} setup ${setup === 1 ? 'fix' : 'fixes'}`} below.` : 'The doctor finds nothing to fix.') : 'The doctor is still checking.';
  const names = (items: StatusItem[]) => items.map((i) => i.label).join(', ');
  if (down.length) return { signal: 'stop', text: `${down.length === 1 ? 'Down' : `${down.length} down`}: ${names(down)}`, detail };
  if (warn.length) return { signal: 'needs', text: `Needs a look: ${names(warn)}`, detail };
  return { signal: 'go', text: 'The Mac and hos are healthy', detail };
}

export function KeeperView({ state }: { state: State }) {
  const [health, setHealth] = useState<StatusItem[]>();
  const [checks, setChecks] = useState<StatusItem[]>();
  const [error, setError] = useState<string>();
  const [tick, setTick] = useState(0);
  const fail = (e: unknown) => setError(errorText(e));
  useEffect(() => {
    client.health().then(setHealth, fail);
  }, [state.lastSeq, tick]);
  useEffect(() => {
    client.doctorChecks().then(setChecks, fail);
  }, [tick]);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, []);
  const headline = health && keeperHeadline(health, checks);
  return (
    <section className="keeper ops-view" aria-label="Background service">
      <ViewHeader title="Background service" back>
        <button className="quiet" onClick={() => setTick((n) => n + 1)}>
          Check again
        </button>
      </ViewHeader>
      {error && <p className="error">{error}</p>}
      <div className="view-scroll">
        {headline && (
          <Headline signal={headline.signal} detail={headline.detail}>
            {headline.text}
          </Headline>
        )}
        <div className="keeper-columns">
          <div>
            <h2>Health</h2>
            {health ? <StatusList label="Health" items={bySeverity(health)} /> : <p className="meta">Checking…</p>}
          </div>
          <div>
            <h2>Doctor</h2>
            {checks ? <StatusList label="Doctor" items={bySeverity(checks)} /> : <p className="meta">Checking the machine setup…</p>}
          </div>
        </div>
      </div>
    </section>
  );
}

export function StatusList({ label, items }: { label: string; items: StatusItem[] }) {
  return (
    <ul className="status-list" aria-label={label}>
      {items.map((item) => (
        <li key={item.id} className={`status-item status-${item.status}`} aria-label={item.label}>
          <Mark signal={STATUS_SIGNALS[item.status]} />
          <strong>{item.label}</strong>
          <span className="status-word">{item.status}</span>
          <span className="detail">{item.detail}</span>
          {item.fix && (
            <span className="fix">
              Fix: <code>{item.fix}</code>
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

const SERVER_SIGNALS: Record<DevServer['state'], Signal> = { listening: 'go', starting: 'queued', exited: 'stop' };

function serversHeadline(servers: DevServer[]): { signal: Signal; text: string; detail?: string } {
  const count = (s: DevServer['state']) => servers.filter((x) => x.state === s).length;
  const listening = count('listening');
  const exited = count('exited');
  const others = [
    count('starting') && `${count('starting')} starting`,
    exited && `${exited} exited`,
  ].filter(Boolean);
  const detail = others.length ? `Also ${others.join(', ')}.` : undefined;
  if (servers.length === 0) return { signal: 'rest', text: 'No dev servers running' };
  if (exited) return { signal: 'stop', text: `${plural(exited, 'server')} exited`, detail: `${listening} listening.` };
  return { signal: listening ? 'go' : 'rest', text: listening ? `${plural(listening, 'server')} listening` : 'Nothing is listening', detail };
}

export function ServersView({ state }: { state: State }) {
  const servers = state.servers;
  const [unmanaged, setUnmanaged] = useState<UnmanagedListener[]>([]);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      client.listServers().then(
        (view) => cancelled || setUnmanaged(view.unmanaged),
        () => {},
      );
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
  const headline = serversHeadline(servers);
  return (
    <section className="servers ops-view" aria-label="Servers">
      <ViewHeader title="Servers" />
      <div className="view-scroll">
        <div className="servers-layout">
          <div className="servers-main">
            <Headline signal={headline.signal} detail={headline.detail}>
              {headline.text}
            </Headline>
            {servers.length === 0 ? (
              <p className="meta">Nothing hos manages is running in tmux. Start one here.</p>
            ) : (
              <ul className="rows" aria-label="Managed servers">
                {servers.map((server) => (
                  <ServerRow key={server.name} server={server} worktree={server.worktreePath ? state.worktrees[server.worktreePath] : undefined} />
                ))}
              </ul>
            )}
            <details className="unmanaged">
              <summary>
                Unmanaged <span className="count">{unmanaged.length}</span>
                <span className="meta">listeners outside tmux</span>
              </summary>
              {unmanaged.length === 0 ? (
                <p className="meta">Every listener runs inside tmux.</p>
              ) : (
                <ul className="listeners" aria-label="Unmanaged listeners">
                  {unmanaged.map((listener) => (
                    <li key={listener.pid} aria-label={`Unmanaged ${listener.command} ${listener.pid}`}>
                      <strong>{listener.command}</strong>
                      <span className="ports">{listener.ports.map((port) => `port ${port}`).join(', ')}</span>
                      <span className="meta">pid {listener.pid}</span>
                      {listener.previewUrl && (
                        <a href={listener.previewUrl} target="_blank" rel="noreferrer">
                          Preview
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </details>
          </div>
          <StartServer worktrees={Object.values(state.worktrees)} />
        </div>
      </div>
    </section>
  );
}

function ServerRow({ server, worktree }: { server: DevServer; worktree: Worktree | undefined }) {
  const [tail, setTail] = useState<string>();
  const { error, busy, run } = useAction();
  const showTail = () => run(async () => setTail(await client.tailServer(server.name)));
  return (
    <li className={`server-row ${server.state}`} aria-label={`Server ${server.name}`}>
      <Mark signal={SERVER_SIGNALS[server.state]} />
      <div className="server-main">
        <div className="server-title">
          <strong className="mono">{server.name}</strong>
          <span className={`server-state ${server.state}`}>{server.state}</span>
        </div>
        <div className="server-meta">
          <span title={server.cwd}>{worktree?.name ?? server.cwd}</span>
          {server.ports.map((port) => (
            <span key={port}>port {port}</span>
          ))}
          {server.previewUrl && (
            <a href={server.previewUrl} target="_blank" rel="noreferrer" aria-label={`Preview ${server.name}`}>
              Preview
            </a>
          )}
        </div>
        {server.command && <code className="command">{server.command}</code>}
      </div>
      <div className="server-actions">
        <button className="quiet" title="Show this server's latest log" disabled={busy} onClick={showTail}>
          Tail
        </button>
        <button className="quiet" disabled={busy} onClick={() => run(() => client.restartServer(server.name))}>
          Restart
        </button>
        <button className="quiet danger stop-server" disabled={busy} onClick={() => run(() => client.stopServer(server.name))}>
          Stop
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {tail !== undefined && <pre aria-label={`Output of ${server.name}`}>{tail || '(no output yet)'}</pre>}
    </li>
  );
}

function StartServer({ worktrees }: { worktrees: Worktree[] }) {
  const sorted = [...worktrees].sort((a, b) => a.name.localeCompare(b.name));
  const [path, setPath] = useState('');
  const [app, setApp] = useState('web');
  const [command, setCommand] = useState('');
  const [port, setPort] = useState('');
  const { error, busy, run } = useAction();
  const worktree = sorted.find((w) => w.path === path) ?? sorted[0];
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!worktree) return;
    const request = { worktreePath: worktree.path, app: app.trim(), command: command.trim(), ...(port ? { port: Number(port) } : {}) };
    if (await run(() => client.startServer(request))) setCommand('');
  };
  return (
    <form className="start-server" onSubmit={submit} aria-label="Start a server">
      <h2>Start a server</h2>
      <label className="worktree">
        <span className="field-label">Worktree</span>
        <select value={worktree?.path ?? ''} onChange={(e) => setPath(e.target.value)}>
          {sorted.map((w) => (
            <option key={w.path} value={w.path}>
              {w.name} (port {w.port})
            </option>
          ))}
        </select>
      </label>
      <label className="command-field">
        <span className="field-label">Command</span>
        <input className="mono" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npm run dev" required />
      </label>
      <label>
        <span className="field-label">App</span>
        <input value={app} onChange={(e) => setApp(e.target.value)} required />
      </label>
      <label>
        <span className="field-label">Port</span>
        <input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" placeholder={worktree ? String(worktree.port) : ''} />
      </label>
      <button className="primary" disabled={busy || !worktree}>
        Start server
      </button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

const RUN_SIGNALS: Record<ActionRun['state'], Signal> = { pending: 'queued', running: 'go', done: 'rest', failed: 'stop', denied: 'stop' };

export function ActionsView({ state }: { state: State }) {
  const [workspaceId, setWorkspaceId] = useState('');
  const folders = Object.values(state.workspaces);
  const chosen = workspaceId || folders[0]?.id || '';
  return (
    <section className="actions-view ops-view" aria-label="Workspace actions">
      <ViewHeader title="Actions" />
      <div className="view-scroll">
        {folders.length === 0 ? (
          <p className="empty">No workspaces yet.</p>
        ) : (
          <label className="inline-form workspace-pick">
            <span className="field-label">Workspace</span>
            <select value={chosen} onChange={(e) => setWorkspaceId(e.target.value)}>
              {folders.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {chosen && <ActionsList key={chosen} workspaceId={chosen} state={state} />}
      </div>
    </section>
  );
}

function ActionsList({ workspaceId, state }: { workspaceId: string; state: State }) {
  const [list, setList] = useState<ActionList>();
  const { error, busy, run } = useAction();
  useEffect(() => {
    client.listActions(workspaceId).then(setList, () => setList({ actions: [], errors: ['could not load actions'] }));
  }, [workspaceId]);
  const runs = Object.values(state.actionRuns)
    .filter((r) => r.workspaceId === workspaceId)
    .sort((a, b) => b.createdAt - a.createdAt);
  const latestOf = (name: string) => runs.find((r) => r.name === name);
  const start = (action: ActionDef) => {
    const args: Record<string, string> = {};
    for (const name of action.args) {
      const value = window.prompt(`${action.name}: ${name}`);
      if (!value) return;
      args[name] = value;
    }
    if (action.confirm && !window.confirm(`Run ${action.name}?\n${action.run}`)) return;
    void run(() => client.runAction(workspaceId, action.name, { args, confirmed: action.confirm }));
  };
  if (!list) return <p className="meta">Loading actions…</p>;
  const live = runs.filter((r) => r.state === 'running' || r.state === 'pending').length;
  const last = runs[0];
  return (
    <section className="actions-list" aria-label="Action list">
      <Headline
        signal={live ? 'go' : last && RUN_SIGNALS[last.state] === 'stop' ? 'stop' : 'rest'}
        detail={last ? `Last run: ${last.name} ${last.state}${last.exitCode !== null ? `, exit ${last.exitCode}` : ''}, ${shortWhen(last.createdAt)}.` : 'Nothing has run here yet.'}
      >
        {list.actions.length === 0 ? 'No actions defined' : live ? `${plural(live, 'action')} running` : `${plural(list.actions.length, 'action')} ready`}
      </Headline>
      {list.errors.map((e) => (
        <p key={e} className="error">
          {e}
        </p>
      ))}
      {error && <p className="error">{error}</p>}
      {list.actions.length === 0 && !list.errors.length && (
        <p className="meta">
          Define actions in <code>.hos/actions.yaml</code> in the repo or <code>hos/actions.yaml</code> in the brain.
        </p>
      )}
      <ul className="action-rows">
        {list.actions.map((action) => (
          <ActionRow key={action.name} action={action} latest={latestOf(action.name)} busy={busy} onRun={() => start(action)} />
        ))}
      </ul>
    </section>
  );
}

function ActionRow({ action, latest, busy, onRun }: { action: ActionDef; latest: ActionRun | undefined; busy: boolean; onRun: () => void }) {
  return (
    <li className="action-row" aria-label={`Action ${action.name}`}>
      <div className="action-head">
        <strong>{action.name}</strong>
        {action.confirm && <span className="tag">confirm</span>}
        <span className="meta">
          {action.where}, {action.source === 'repo' ? 'repo' : 'brain'}
          {action.args.length > 0 && `, asks for ${action.args.join(', ')}`}
        </span>
      </div>
      <button className="run" disabled={busy} onClick={onRun}>
        Run <span className="sr-only">{action.name}</span>
      </button>
      <code className="command">{action.run}</code>
      {latest ? (
        <div className="action-last" role="region" aria-label={`Last run of ${action.name}`}>
          <div className="row">
            <Mark signal={RUN_SIGNALS[latest.state]} />
            <span className={`run-state ${latest.state}`}>{latest.state}</span>
            {latest.exitCode !== null && <span>exit {latest.exitCode}</span>}
            <span className="meta" title={new Date(latest.createdAt).toLocaleString()}>
              {shortWhen(latest.createdAt)}
            </span>
            {latest.terminal && <a href={`#/terminal/${encodeURIComponent(latest.terminal)}`}>{latest.terminal}</a>}
            {latest.chatId && <span className="meta">by {latest.requestedBy}</span>}
          </div>
          {latest.output && <pre>{latest.output}</pre>}
        </div>
      ) : (
        <p className="meta action-last">Not run yet.</p>
      )}
    </li>
  );
}
