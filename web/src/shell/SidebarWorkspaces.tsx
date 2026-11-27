import { useEffect, useRef, useState } from 'react';
import {
  archiveWorkspace,
  copyPath,
  deleteWorkspace,
  openInCodeView,
  openWorkspaceTerminal,
  renameWorkspace,
  rerunSetup,
  setupLog,
  workspaceRows,
  type WorkspaceRow,
} from '../model/index.js';
import { errorText, trapTab } from '../lib.js';
import type { State } from '../state.js';
import '../styles/workspaces.css';
import { Icon } from './icons.js';
import { usePanel } from './Layout.js';
import { MoreButton, useMenu, type MenuItem } from './Menu.js';
import { SidebarSection } from './SidebarTopics.js';

type Pending = { kind: 'archive' | 'delete'; row: WorkspaceRow };

export function SidebarWorkspaces({ state, topicId }: { state: State; topicId: string | undefined }) {
  const rows = workspaceRows(state);
  const repos = [...new Set(rows.map((row) => row.repo))];
  const [note, setNote] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  return (
    <SidebarSection label="Workspaces" defaultOpen={false}>
      {rows.length === 0 && <p className="sidebar-empty">No workspaces yet. Chats ask you before they work in a repo.</p>}
      {repos.map((repo) => (
        <div key={repo} className="sidebar-repo" role="group" aria-label={repo}>
          <div className="sidebar-repo-name" aria-hidden="true">
            {repo}
          </div>
          <ul className="sidebar-list">
            {rows
              .filter((row) => row.repo === repo)
              .map((row) => (
                <WorkspaceLine key={row.id} row={row} topicId={topicId} inDock={!!topicId && !!state.topics[topicId]?.workspaceIds.includes(row.id)} onNote={setNote} onConfirm={setPending} />
              ))}
          </ul>
        </div>
      ))}
      <span className="sr" role="status">
        {note}
      </span>
      {pending && <WorkspaceDialog pending={pending} onNote={setNote} onClose={() => setPending(null)} />}
    </SidebarSection>
  );
}

function WorkspaceLine(props: { row: WorkspaceRow; topicId: string | undefined; inDock: boolean; onNote: (text: string) => void; onConfirm: (pending: Pending) => void }) {
  const { row, topicId, inDock, onNote, onConfirm } = props;
  const panel = usePanel();
  const name = rowName(row);
  const [renaming, setRenaming] = useState(false);
  const [log, setLog] = useState<string | null>(null);
  const run = (what: string, action: () => Promise<unknown>) => void action().then(() => onNote(what), (e) => onNote(errorText(e)));
  const items: MenuItem[] = [
    { label: 'Copy path', onSelect: () => run(`Copied ${row.path}`, () => copyPath(row.path)) },
    { label: 'Open in Code view', onSelect: () => run(`Opened ${row.path} in Code view`, () => openInCodeView(row.path)) },
    {
      label: 'Open terminal',
      onSelect: () =>
        run(`Opened a terminal in ${row.path}`, async () => {
          await openWorkspaceTerminal(row.id, topicId, inDock);
          if (inDock && !panel.open) panel.toggle();
        }),
    },
    { label: 'Rename', onSelect: () => setRenaming(true) },
    ...(row.kind === 'worktree'
      ? ([
          'separator',
          { label: 'Archive', onSelect: () => onConfirm({ kind: 'archive', row }) },
          { label: 'Delete', danger: true, onSelect: () => onConfirm({ kind: 'delete', row }) },
        ] satisfies MenuItem[])
      : []),
  ];
  const menu = useMenu(`Actions for ${name}`, items);
  const branch = row.branch ?? row.repo;
  const tooltip = `${row.kind === 'root' ? 'Root checkout' : 'Worktree'} · ${branch}\n${
    row.usedBy.length ? `Used by: ${row.usedBy.map((t) => t.title).join(', ')}` : 'No topic'
  }`;
  return (
    <li className="ws sidebar-ws" title={tooltip} aria-label={`${row.kind === 'root' ? 'Root' : 'Worktree'} ${branch}`} onContextMenu={menu.onContextMenu}>
      {row.kind === 'root' ? (
        <svg className="sidebar-kind" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
          <path d="M8 2v12" />
          <circle cx="8" cy="8" r="2.2" fill="currentColor" />
        </svg>
      ) : (
        <Icon id="i-branch" className="sidebar-kind" />
      )}
      {renaming ? (
        <RenameBox row={row} onNote={onNote} onClose={() => setRenaming(false)} />
      ) : (
        <span className="sidebar-branch">{branch}</span>
      )}
      {row.setup === 'running' || row.setup === 'pending' ? (
        <span className="sidebar-setup running">setting up</span>
      ) : row.setup === 'failed' ? (
        <button
          type="button"
          className="sidebar-setup failed"
          aria-label="setup failed, show the log"
          title="Setup failed; click to see the log"
          aria-expanded={log !== null}
          onClick={() => (log !== null ? setLog(null) : void setupLog(row.id).then(setLog, (e) => setLog(errorText(e))))}
        >
          setup failed
        </button>
      ) : null}
      <MoreButton label={`Actions for ${name}`} tip="More actions for this workspace" menu={menu} className="more" />
      {menu.element}
      {log !== null && <SetupLog row={row} text={log} onNote={onNote} onClose={() => setLog(null)} />}
    </li>
  );
}

function RenameBox({ row, onNote, onClose }: { row: WorkspaceRow; onNote: (text: string) => void; onClose: () => void }) {
  const [branch, setBranch] = useState(row.branch ?? '');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const submit = async () => {
    setBusy(true);
    try {
      await renameWorkspace(row.id, branch.trim());
      onNote(`Renamed to ${branch.trim()}`);
      onClose();
    } catch (e) {
      onNote(errorText(e));
      setBusy(false);
      input.current?.focus();
    }
  };
  return (
    <form
      className="sidebar-rename"
      onSubmit={(e) => {
        e.preventDefault();
        if (branch.trim() && branch.trim() !== row.branch) void submit();
        else onClose();
      }}
    >
      <input
        ref={input}
        type="text"
        aria-label={`New branch for ${rowName(row)}`}
        value={branch}
        disabled={busy}
        onChange={(e) => setBranch(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), onClose())}
        onBlur={onClose}
      />
    </form>
  );
}

function SetupLog({ row, text, onNote, onClose }: { row: WorkspaceRow; text: string; onNote: (text: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: Event) => ref.current?.contains(e.target as Node) || onClose();
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [onClose]);
  return (
    <div className="setup-log" role="dialog" aria-label={`Setup log of ${rowName(row)}`} ref={ref} onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), onClose())}>
      <pre className="mono">{text || 'The log is empty.'}</pre>
      <div className="setup-log-acts">
        <button
          type="button"
          className="btn"
          onClick={() => {
            onClose();
            void rerunSetup(row.id).then(() => onNote(`Setup of ${rowName(row)} is running again`), (e) => onNote(errorText(e)));
          }}
        >
          Run setup again
        </button>
      </div>
    </div>
  );
}

function WorkspaceDialog({ pending, onNote, onClose }: { pending: Pending; onNote: (text: string) => void; onClose: () => void }) {
  const { kind, row } = pending;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    cancel.current?.focus();
    return () => before?.focus?.();
  }, []);
  const name = rowName(row);
  const go = async (force: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      await (kind === 'archive' ? archiveWorkspace(row.id, force) : deleteWorkspace(row.id));
      onNote(kind === 'archive' ? `Archived ${name}` : `Deleted ${name}`);
      onClose();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };
  const dirty = error !== undefined && /confirm to archive it anyway/.test(error);
  return (
    <div className="dialog-wrap" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="ws-dialog-title"
        aria-describedby="ws-dialog-detail"
        onKeyDown={(e) => (trapTab(e), e.key === 'Escape' && (e.stopPropagation(), onClose()))}
      >
        <h2 id="ws-dialog-title">{kind === 'archive' ? `Archive ${name}?` : `Delete ${name}?`}</h2>
        <p id="ws-dialog-detail">
          {kind === 'archive'
            ? `${row.path} is removed and ${row.branch ?? 'its branch'} is kept, so you can check it out again. Every topic using it lets it go.`
            : `${row.path} is removed, branch ${row.branch ?? '(none)'} is deleted and hos forgets the workspace. This cannot be undone.`}
        </p>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-acts">
          <button ref={cancel} type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={kind === 'delete' ? 'btn danger' : 'btn'} disabled={busy} onClick={() => void go(dirty)}>
            {dirty ? 'Archive anyway' : kind === 'archive' ? 'Archive' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}

function rowName(row: WorkspaceRow): string {
  return row.kind === 'root' ? `${row.repo} root` : `${row.repo} ${row.branch ?? row.path}`;
}
