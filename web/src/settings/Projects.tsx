import { useEffect, useRef, useState } from 'react';
import type { Project } from '../../../src/api/types.js';
import { workspaceRows } from '../model/index.js';
import { client, errorText, trapTab } from '../lib.js';
import type { State } from '../state.js';
import '../styles/workspaces.css';
import { Icon } from '../shell/icons.js';
import { MoreButton, useMenu, type MenuItem } from '../shell/Menu.js';

export function Projects({ state }: { state: State }) {
  const projects = [...state.projects].sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.name.localeCompare(b.name));
  const shown = projects.filter((p) => !p.hidden);
  const hidden = projects.filter((p) => p.hidden);
  const [adding, setAdding] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [removing, setRemoving] = useState<Project | null>(null);
  const [note, setNote] = useState('');
  const usedBy = (project: Project) => [...new Set(workspaceRows(state).filter((row) => row.projectId === project.id).flatMap((row) => row.usedBy.map((t) => t.title)))];
  const line = (project: Project) => <ProjectLine key={project.id} project={project} onNote={setNote} onRemove={setRemoving} />;
  return (
    <div className="settings-projects">
      <button type="button" className="btn" aria-expanded={adding} onClick={() => setAdding(!adding)}>
        Add a project
      </button>
      {adding && <AddProject onNote={setNote} onClose={() => setAdding(false)} />}
      {projects.length === 0 && <p className="sidebar-empty">No projects yet.</p>}
      <ul className="sidebar-list">{shown.map(line)}</ul>
      {hidden.length > 0 && (
        <>
          <button type="button" className="sidebar-seen-all sidebar-hidden-toggle" aria-expanded={showHidden} onClick={() => setShowHidden(!showHidden)}>
            Hidden ({hidden.length})
          </button>
          {showHidden && <ul className="sidebar-list">{hidden.map(line)}</ul>}
        </>
      )}
      <span className="sr" role="status">
        {note}
      </span>
      {removing && <RemoveDialog project={removing} usedBy={usedBy(removing)} onNote={setNote} onClose={() => setRemoving(null)} />}
    </div>
  );
}

function ProjectLine({ project, onNote, onRemove }: { project: Project; onNote: (text: string) => void; onRemove: (project: Project) => void }) {
  const [renaming, setRenaming] = useState(false);
  const run = (what: string, action: () => Promise<unknown>) => void action().then(() => onNote(what), (e) => onNote(errorText(e)));
  const items: MenuItem[] = [
    { label: 'Rename', onSelect: () => setRenaming(true) },
    { label: project.pinned ? 'Unpin' : 'Pin', onSelect: () => run(`${project.pinned ? 'Unpinned' : 'Pinned'} ${project.name}`, () => client.setProjectPinned(project.id, !project.pinned)) },
    ...(project.brain
      ? []
      : ([
          { label: project.hidden ? 'Unhide' : 'Hide', onSelect: () => run(`${project.hidden ? 'Unhid' : 'Hid'} ${project.name}`, () => client.setProjectHidden(project.id, !project.hidden)) },
          'separator',
          { label: 'Remove', danger: true, onSelect: () => onRemove(project) },
        ] satisfies MenuItem[])),
  ];
  const menu = useMenu(`Actions for ${project.name}`, items);
  return (
    <li className="ws sidebar-ws" title={project.path} aria-label={`Project ${project.name}`} onContextMenu={menu.onContextMenu}>
      <Icon id="i-root" className="sidebar-kind" />
      {renaming ? (
        <RenameBox project={project} onNote={onNote} onClose={() => setRenaming(false)} />
      ) : (
        <span className="sidebar-branch">{project.name}</span>
      )}
      {project.pinned && <span className="sidebar-pin">pinned</span>}
      <MoreButton label={`Actions for ${project.name}`} tip="More actions for this project" menu={menu} className="more" />
      {menu.element}
    </li>
  );
}

function RenameBox({ project, onNote, onClose }: { project: Project; onNote: (text: string) => void; onClose: () => void }) {
  const [name, setName] = useState(project.name);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const submit = async () => {
    setBusy(true);
    try {
      await client.renameProject(project.id, name.trim());
      onNote(`Renamed to ${name.trim()}`);
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
        if (name.trim() && name.trim() !== project.name) void submit();
        else onClose();
      }}
    >
      <input
        ref={input}
        type="text"
        aria-label={`New name for ${project.name}`}
        value={name}
        disabled={busy}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), onClose())}
        onBlur={onClose}
      />
    </form>
  );
}

function AddProject({ onNote, onClose }: { onNote: (text: string) => void; onClose: () => void }) {
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const project = await client.createProject(path.trim());
      onNote(`Added ${project.name}`);
      onClose();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };
  return (
    <form
      className="sidebar-rename sidebar-project-add"
      onSubmit={(e) => {
        e.preventDefault();
        if (path.trim()) void submit();
      }}
    >
      <input
        autoFocus
        type="text"
        aria-label="Repo path"
        placeholder="/path/to/repo"
        value={path}
        disabled={busy}
        onChange={(e) => setPath(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), onClose())}
      />
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function RemoveDialog({ project, usedBy, onNote, onClose }: { project: Project; usedBy: string[]; onNote: (text: string) => void; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    cancel.current?.focus();
    return () => before?.focus?.();
  }, []);
  const blocked = usedBy.length > 0;
  const go = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await client.removeProject(project.id);
      onNote(`Removed ${project.name}`);
      onClose();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };
  return (
    <div className="dialog-wrap" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="project-dialog-title"
        aria-describedby="project-dialog-detail"
        onKeyDown={(e) => (trapTab(e), e.key === 'Escape' && (e.stopPropagation(), onClose()))}
      >
        <h2 id="project-dialog-title">Remove {project.name}?</h2>
        <p id="project-dialog-detail">
          {blocked
            ? `${project.name} is used by ${usedBy.join(', ')}. Archive ${usedBy.length === 1 ? 'that topic' : 'those topics'} first.`
            : `hos forgets ${project.path} and its workspaces, and discovery stops adding it back. Nothing on disk is deleted; add the path again to bring it back.`}
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
          <button type="button" className="btn danger" disabled={busy || blocked} onClick={() => void go()}>
            Remove
          </button>
        </div>
      </div>
    </div>
  );
}
