import { useEffect, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { PanelAction, PanelWorkspace, Terminal, Workspace } from '../../../src/api/types.js';
import { chatLabel, client, errorText, useAction } from '../lib.js';
import { Icon, IconButton, ShapeMark } from '../shell/icons.js';
import { usePanel } from '../shell/Layout.js';
import { useMenu, type MenuItem } from '../shell/Menu.js';
import type { State } from '../state.js';
import { TerminalView } from '../Terminal.js';
import { onDockTerminal, readDockTabs, writeDockTabs } from './dock.js';
import { activeTasks, TasksPanel, useTopicTasks } from './TasksPanel.js';

export function WorkspacesPanel({ topicId, state }: { topicId: string; state: State }) {
  const panel = usePanel();
  const { setAvailable } = panel;
  const [workspaces, setWorkspaces] = useState<PanelWorkspace[]>();
  const [error, setError] = useState<string>();
  const topic = state.topics[topicId];
  const tasks = useTopicTasks(topicId, state);
  const [view, setView] = useState<'tasks' | 'workspaces'>();
  const [adding, setAdding] = useState(false);
  // One refetch per attach, detach, setup change and workspace.git event of this topic.
  const fetchKey = (topic?.workspaceIds ?? [])
    .map((id) => `${id}:${state.workspaces[id]?.setup ?? '?'}:${state.workspaceGitSeq[id] ?? 0}`)
    .join('|');

  useEffect(() => {
    let live = true;
    client.topicPanel(topicId).then(
      (list) => {
        if (!live) return;
        setWorkspaces(list);
        setError(undefined);
      },
      (e) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [topicId, fetchKey]);

  const [terminals, setTerminals] = useState<Terminal[]>();
  const [openTabs, setOpenTabs] = useState(() => readDockTabs(topicId));
  const [shownName, setShownName] = useState<string>();
  const [dockError, setDockError] = useState<string>();
  const [reload, setReload] = useState(0);
  const refresh = () => setReload((n) => n + 1);
  useEffect(() => {
    setOpenTabs(readDockTabs(topicId));
    setTerminals(undefined);
    return onDockTerminal((id, name) => {
      if (id !== topicId) return;
      setOpenTabs(readDockTabs(topicId));
      setShownName(name);
      setView('workspaces');
      refresh();
    });
  }, [topicId]);
  useEffect(() => {
    let live = true;
    const load = () => client.listTerminals(topicId).then((list) => live && setTerminals(list), () => {});
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [topicId, reload]);
  const setTabs = (next: string[]) => {
    writeDockTabs(topicId, next);
    setOpenTabs(next);
  };
  const showTab = (name: string) => {
    setTabs([...readDockTabs(topicId).filter((tab) => tab !== name), name]);
    setShownName(name);
  };
  const dockAction = (action: () => Promise<void>) =>
    action().then(
      () => setDockError(undefined),
      (e) => setDockError(errorText(e)),
    );
  const openShell = async (workspaceId: string) => {
    showTab((await client.openWorkspaceTerminal(workspaceId, topicId)).name);
    refresh();
  };
  const killShell = async (terminal: Terminal, label: string) => {
    if (terminal.busy && !confirm(`${label} is still running something. Kill it anyway?`)) return;
    await client.killTerminal(terminal.name);
    setTabs(readDockTabs(topicId).filter((tab) => tab !== terminal.name));
    refresh();
  };

  const rows = (topic?.workspaceIds ?? []).flatMap((id) => {
    const fetched = workspaces?.find((workspace) => workspace.workspaceId === id);
    if (fetched) return [{ workspace: fetched, loading: false }];
    const known = state.workspaces[id];
    if (!known || known.archivedAt !== null) return [];
    return [{ workspace: stubWorkspace(known, state.projects.find((project) => project.id === known.projectId)?.name ?? known.name), loading: true }];
  });
  useEffect(() => {
    setAvailable(true);
    return () => setAvailable(false);
  }, [setAvailable]);

  const folders = rows.map((row) => row.workspace);
  const label = (terminal: Terminal) => {
    if (terminal.chatId) return chatLabel(state, terminal.chatId);
    const folder = folders.filter((w) => terminal.cwd === w.path || terminal.cwd.startsWith(`${w.path}/`)).sort((a, b) => b.path.length - a.path.length)[0];
    const repo = folder?.repo ?? terminal.cwd.split('/').filter(Boolean).pop() ?? terminal.name;
    const n = /-(t\d+)$/.exec(terminal.name)?.[1];
    return n ? `${repo} · ${n}` : repo;
  };
  const live = terminals ?? [];
  const tabs = openTabs.flatMap((name) => live.filter((t) => t.name === name));
  const shown = tabs.find((t) => t.name === shownName) ?? tabs.at(-1);
  const hidden = live.filter((t) => !openTabs.includes(t.name));
  const shownFolder = shown && folders.find((w) => shown.cwd === w.path || shown.cwd.startsWith(`${w.path}/`));
  const ready = folders.filter((w) => w.setup === 'ready');
  const newIn = shownFolder && ready.includes(shownFolder) ? [shownFolder, ...ready.filter((w) => w !== shownFolder)] : ready;
  const activeCount = activeTasks(tasks).length;
  const shownView = view ?? (activeCount > 0 || rows.length === 0 ? 'tasks' : 'workspaces');
  return (
    <>
      <div className="panel-head">
        <div className="panel-tabs" role="tablist" aria-label="Panel">
          <button type="button" role="tab" aria-selected={shownView === 'tasks'} title="Tasks for this topic, by priority" onClick={() => setView('tasks')}>
            Tasks <span className="panel-count">{activeCount}</span>
          </button>
          <button type="button" role="tab" aria-selected={shownView === 'workspaces'} title="Checkouts this topic works in" onClick={() => setView('workspaces')}>
            Workspaces <span className="panel-count">{rows.length}</span>
          </button>
        </div>
        {shownView === 'tasks' && (
          <button type="button" className="icon-btn" aria-label="Add task" title="Add task" aria-pressed={adding} onClick={() => setAdding(!adding)}>
            <Icon id="i-plus" />
          </button>
        )}
        <IconButton className="icon-btn panel-close" icon="i-x" label="Close workspaces" tip="Close the panel" onClick={panel.toggle} />
      </div>
      {shownView === 'tasks' ? (
        <TasksPanel topicId={topicId} tasks={tasks} adding={adding} onAdded={() => setAdding(false)} />
      ) : (
        <>
          <div className="panel-body">
            {error && <p className="error">{error}</p>}
            {rows.map(({ workspace, loading }) => (
              <WorkspaceBlock key={workspace.workspaceId} workspace={workspace} loading={loading} topicId={topicId} topicTitle={topic?.title ?? ''} state={state} onTerminal={() => openShell(workspace.workspaceId)} />
            ))}
          </div>
          {(tabs.length > 0 || hidden.length > 0) && (
            <TerminalDock
              tabs={tabs.map((t) => ({ name: t.name, label: label(t), busy: t.busy }))}
              shown={shown?.name}
              hidden={hidden.map((t) => ({ name: t.name, label: label(t), busy: t.busy, kill: t.chatId ? undefined : () => void dockAction(() => killShell(t, label(t))) }))}
              folders={newIn.map((w) => ({ id: w.workspaceId, label: w.repo }))}
              error={dockError}
              onShow={setShownName}
              onClose={(name) => setTabs(openTabs.filter((tab) => tab !== name))}
              onNew={(id) => void dockAction(() => openShell(id))}
              onReopen={showTab}
            />
          )}
        </>
      )}
    </>
  );
}

const DOCK_HEIGHT_KEY = 'hos.dock.height';

function stubWorkspace(workspace: Workspace, repo: string): PanelWorkspace {
  return {
    workspaceId: workspace.id,
    repo,
    kind: workspace.kind,
    branch: workspace.branch,
    base: workspace.base,
    against: null,
    path: workspace.path,
    setup: workspace.setup,
    git: { dirty: false, ahead: 0, behind: 0, upstream: null, pr: null },
    changed: { files: [], additions: 0, deletions: 0 },
    touched: [],
    actions: [],
    errors: [],
  };
}

interface DockTab {
  name: string;
  label: string;
  busy: boolean;
}

function TerminalDock(props: {
  tabs: DockTab[];
  shown: string | undefined;
  hidden: Array<DockTab & { kill?: () => void }>;
  folders: Array<{ id: string; label: string }>;
  error: string | undefined;
  onShow: (name: string) => void;
  onClose: (name: string) => void;
  onNew: (workspaceId: string) => void;
  onReopen: (name: string) => void;
}) {
  const running = (tab: DockTab) => `${tab.label}${tab.busy ? ' (running)' : ''}`;
  const newMenu = useMenu(
    'Open a terminal in',
    props.folders.map((folder): MenuItem => ({ label: folder.label, onSelect: () => props.onNew(folder.id) })),
  );
  const history = useMenu(
    'Running terminals',
    props.hidden.flatMap((tab, i): MenuItem[] => [
      ...(i > 0 ? (['separator'] as const) : []),
      { label: `Reopen ${running(tab)}`, onSelect: () => props.onReopen(tab.name) },
      ...(tab.kill ? [{ label: `Kill ${tab.label}`, danger: true, onSelect: tab.kill }] : []),
    ]),
  );
  const tools = (
    <div className="dock-tools">
      {props.folders.length === 1 ? (
        <button type="button" className="dock-x dock-tool" aria-label={`New terminal in ${props.folders[0]!.label}`} title="New terminal in this workspace" onClick={() => props.onNew(props.folders[0]!.id)}>
          <Icon id="i-plus" />
        </button>
      ) : (
        props.folders.length > 1 && (
          <button {...newMenu.trigger} className="dock-x dock-tool" aria-label="New terminal" title="New terminal in a workspace">
            <Icon id="i-plus" />
          </button>
        )
      )}
      {props.hidden.length > 0 && (
        <button {...history.trigger} className="dock-x dock-tool" aria-label={`Running terminals (${props.hidden.length})`} title="Running shells in this topic">
          <Icon id="i-term" />
          <span className="dock-count">{props.hidden.length}</span>
        </button>
      )}
      {newMenu.element}
      {history.element}
    </div>
  );
  const tabStrip = (
    <div className="dock-bar">
      <div className="dock-tabs" role="tablist" aria-label="Workspace terminals">
        {props.tabs.map((tab) => (
          <div key={tab.name} className="dock-tab" aria-current={tab.name === props.shown ? 'true' : undefined}>
            <button type="button" role="tab" aria-selected={tab.name === props.shown} title={tab.name} onClick={() => props.onShow(tab.name)}>
              <Icon id="i-term" />
              {tab.label}
            </button>
            <button type="button" className="dock-x" aria-label={`Close the ${tab.label} terminal`} title="Close; the shell keeps running" onClick={() => props.onClose(tab.name)}>
              <Icon id="i-x" />
            </button>
          </div>
        ))}
      </div>
      {tools}
    </div>
  );
  if (!props.shown) {
    return (
      <section className="dock dock-collapsed" aria-label="Workspace terminal">
        {tabStrip}
        {props.error && <p className="error dock-error">{props.error}</p>}
      </section>
    );
  }
  return <OpenDock tabStrip={tabStrip} shown={props.shown} error={props.error} />;
}

function OpenDock({ tabStrip, shown, error }: { tabStrip: ReactNode; shown: string; error: string | undefined }) {
  const [height, setHeight] = useState(() => Number(localStorage.getItem(DOCK_HEIGHT_KEY)) || 280);
  const latest = useRef(height);
  const resize = (next: number) => {
    latest.current = Math.round(Math.min(Math.max(next, 120), window.innerHeight * 0.75));
    setHeight(latest.current);
  };
  const keep = () => localStorage.setItem(DOCK_HEIGHT_KEY, String(latest.current));
  const drag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const from = e.clientY;
    const start = latest.current;
    const move = (ev: PointerEvent) => resize(start + from - ev.clientY);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      keep();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    e.preventDefault();
  };
  return (
    <section className="dock" aria-label="Workspace terminal" style={{ height }}>
      <div
        className="dock-grip"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize the terminal"
        aria-valuenow={height}
        tabIndex={0}
        onPointerDown={drag}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
          e.preventDefault();
          resize(latest.current + (e.key === 'ArrowUp' ? 24 : -24));
          keep();
        }}
      />
      {tabStrip}
      {error && <p className="error dock-error">{error}</p>}
      <div className="dock-body">
        <TerminalView key={shown} name={shown} />
      </div>
    </section>
  );
}

function WorkspaceBlock({
  workspace,
  loading,
  topicId,
  topicTitle,
  state,
  onTerminal,
}: {
  workspace: PanelWorkspace;
  loading: boolean;
  topicId: string;
  topicTitle: string;
  state: State;
  onTerminal: () => Promise<void>;
}) {
  const { changed, touched, git } = workspace;
  const ready = workspace.setup === 'ready';
  const base = workspace.against ?? workspace.base ?? 'its base';
  const { error, busy, run } = useAction();
  const fetching = useAction();
  const [committing, setCommitting] = useState(false);
  const [message, setMessage] = useState(`hos: ${topicTitle}`);
  const [removing, setRemoving] = useState(false);
  const shared = removing && !!error && /remove it from this topic instead/.test(error);
  const dirty = removing && !!error && /confirm to archive it anyway/.test(error);
  const note = state.diffActions[workspace.workspaceId];
  const lastRun = Object.values(state.actionRuns)
    .filter((candidate) => candidate.workspaceId === workspace.workspaceId)
    .sort((a, b) => b.createdAt - a.createdAt)[0];

  const openCodeView = (file?: string) =>
    void run(async () => {
      const { url } = await client.openCodeView(workspace.path, file);
      window.open(url, '_blank', 'noopener');
    });
  const commit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await client.commit(workspace.workspaceId, message.trim());
      setCommitting(false);
    });
  };
  const gitActions = workspace.actions.filter((action) => action.kind === 'git');
  const sync = (
    <button
      type="button"
      className={`panel-sync${fetching.busy ? ' spinning' : ''}`}
      aria-label={`Fetch origin for ${workspace.repo}`}
      title={fetching.error ?? 'Fetch to compare with the latest base'}
      disabled={fetching.busy}
      onClick={() => void fetching.run(() => client.fetchWorkspace(workspace.workspaceId))}
    >
      <Icon id="i-sync" />
    </button>
  );
  const start = (action: PanelAction) => {
    if (action.name === 'commit') return setCommitting(true);
    if (action.name === 'push') return void run(() => client.pushWorkspace(workspace.workspaceId));
    if (action.name === 'pull') return void run(() => client.pullWorkspace(workspace.workspaceId));
    if (action.name === 'pull-request') return void run(() => client.openPullRequest(workspace.workspaceId));
    return void run(() => client.reviewWorkspace(workspace.workspaceId));
  };
  const remove = () =>
    void run(async () => {
      if (shared) await client.detachWorkspace(topicId, workspace.workspaceId);
      else await client.removeTopicWorkspace(topicId, workspace.workspaceId, { force: dirty });
      setRemoving(false);
    });

  return (
    <section className="panel-ws" aria-label={`${workspace.repo}, ${workspace.branch ?? 'no branch'}`}>
      <div className="panel-ws-head">
        <div className="panel-ws-name">
          <b>{workspace.repo}</b>
          <span className="tag">{workspace.kind}</span>
        </div>
        <button
          type="button"
          className="btn panel-code-view"
          disabled={!ready || busy}
          title="Open this workspace in Code view"
          onClick={() => openCodeView()}
        >
          <OpenMark />
          Open in Code view
        </button>
        <div className="panel-ws-branch mono">
          <Icon id="i-branch" />
          <span className="panel-ws-ref">
            {workspace.branch ?? 'no branch'}
            {workspace.kind === 'worktree' && workspace.base && <span className="faint"> from {workspace.base}</span>}
          </span>
          {ready && !loading && (
            <span className="panel-ws-stats" aria-label="Git state">
              {git.ahead > 0 && <span title={`${git.ahead} commits to push`}>↑{git.ahead}</span>}
              {git.behind > 0 && <span title={`${git.behind} commits to pull`}>↓{git.behind}</span>}
              <span>
                {changed.files.length} {changed.files.length === 1 ? 'change' : 'changes'}
              </span>
            </span>
          )}
        </div>
      </div>

      {workspace.setup === 'running' || workspace.setup === 'pending' ? (
        <p className="panel-setup run" role="status">
          <ShapeMark shape="s-queued" />
          Setting up…
          <span className="faint">Actions wait for setup</span>
        </p>
      ) : (
        workspace.setup === 'failed' && <SetupFailure workspaceId={workspace.workspaceId} />
      )}

      <div className="panel-actions" role="group" aria-label="Actions">
        {gitActions.map((action, i) => (
          <button key={action.name} type="button" className={`btn${i === 0 ? ' go' : ''}`} title={action.title} disabled={!ready || busy} onClick={() => start(action)}>
            {action.label}
          </button>
        ))}
        {gitActions.length > 0 && <span className="panel-sep" aria-hidden="true" />}
        <button type="button" className="btn panel-script" title={`Opens a shell in ${workspace.path} below`} disabled={!ready || busy} onClick={() => void run(onTerminal)}>
          <Icon id="i-term" />
          Open terminal
        </button>
        <button
          type="button"
          className="btn quiet panel-remove"
          title={workspace.kind === 'root' ? 'Detach from topic; files stay on disk' : 'Deletes this worktree’s folder; the branch stays'}
          disabled={busy || removing}
          onClick={() => (workspace.kind === 'root' ? remove() : setRemoving(true))}
        >
          {workspace.kind === 'root' ? 'Remove from topic' : 'Remove'}
        </button>
      </div>
      {removing && (
        <div className="panel-commit" role="group" aria-label="Remove this worktree">
          <span className="panel-confirm muted">
            {shared ? 'Other topics keep it.' : `Deletes the folder; branch ${workspace.branch ?? '(none)'} stays.`}
          </span>
          <button type="button" className="btn danger" disabled={busy} onClick={remove}>
            {shared ? 'Remove from this topic' : dirty ? 'Remove anyway' : 'Remove'}
          </button>
          <button type="button" className="btn" onClick={() => setRemoving(false)}>
            Cancel
          </button>
        </div>
      )}
      {committing && (
        <form className="panel-commit" aria-label="Commit this workspace" onSubmit={commit}>
          <input aria-label="Commit message" value={message} onChange={(e) => setMessage(e.target.value)} required />
          <button className="btn go" disabled={busy}>
            Commit
          </button>
          <button type="button" className="btn" onClick={() => setCommitting(false)}>
            Cancel
          </button>
        </form>
      )}
      {error && <p className="panel-error error">{error}</p>}
      {note && (
        <p className="panel-note" role="status">
          {note.state === 'denied' ? 'Denied' : note.detail}
        </p>
      )}
      {lastRun && (
        <div className="panel-run" role="group" aria-label="Last action run">
          <span>
            {lastRun.name} <span className={`run-state ${lastRun.state}`}>{lastRun.state}</span>
          </span>
          {lastRun.output && <pre>{lastRun.output}</pre>}
        </div>
      )}

      {ready && loading && (
        <p className="panel-none" role="status" aria-label="Loading changes">
          <span className="naming" aria-hidden="true">
            <i />
            <i />
          </span>
        </p>
      )}
      {ready && !loading && (
        <>
          {changed.files.length > 0 ? (
            <div className="panel-changed">
              <div className="panel-sub">
                <span>Changed vs {base}</span>
                {sync}
                <span className="panel-total" aria-label="Total lines changed">
                  <span className="num-add">+{changed.additions}</span> <span className="num-del">−{changed.deletions}</span>
                </span>
              </div>
              <ul>
                {changed.files.map((file) => (
                  <li key={file.path}>
                    <button type="button" className="panel-file" aria-label={`Open ${file.path} in Code view`} onClick={() => openCodeView(file.path)}>
                      <span className="path">
                        <FilePath path={file.path} />
                      </span>
                      <span className="panel-n">
                        <span className="num-add">+{file.additions}</span> <span className="num-del">−{file.deletions}</span>
                      </span>
                      <OpenMark className="panel-go" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="panel-none">
              No changes against {base}
              {sync}
            </p>
          )}
          {touched.length > 0 && (
            <details className="panel-touched">
              <summary>Touched by this topic</summary>
              <ul>
                {touched.map((file) => (
                  <li key={file.path}>
                    <span className="path mono">{file.path}</span>
                    {!file.inDiff && <span className="faint">not in diff</span>}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      {workspace.errors.map((problem) => (
        <p key={problem} className="panel-error error">
          Skipped {problem}
        </p>
      ))}
    </section>
  );
}

function SetupFailure({ workspaceId }: { workspaceId: string }) {
  const [log, setLog] = useState<string>();
  const open = () => {
    if (log !== undefined) return;
    client.workspaceSetupLog(workspaceId).then(
      (answer) => setLog(answer.text || 'No log'),
      () => setLog('No log'),
    );
  };
  return (
    <div className="panel-setup fail" role="alert">
      <p>
        <ShapeMark shape="s-stop" />
        Setup failed
      </p>
      <details className="panel-log" onToggle={open}>
        <summary>Setup log</summary>
        <pre className="mono">{log ?? 'Loading…'}</pre>
      </details>
    </div>
  );
}

function FilePath({ path }: { path: string }) {
  const cut = path.lastIndexOf('/');
  return (
    <>
      {cut >= 0 && <span>{path.slice(0, cut + 1)}</span>}
      <b>{path.slice(cut + 1)}</b>
    </>
  );
}

function OpenMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M9.5 2.5h4v4" />
      <path d="m13.5 2.5-6 6" />
      <path d="M12 9.5v3.5H3V4h3.5" />
    </svg>
  );
}
