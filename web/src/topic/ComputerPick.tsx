import { useEffect, useRef, useState } from 'react';
import type { Computer, ComputerCaps } from '../../../src/api/types.js';
import { useComputers } from '../model/computers.js';
import { Icon } from '../shell/icons.js';
import type { State } from '../state.js';
import '../styles/computer-pick.css';

const TIME = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export interface ComputerChoice {
  self: string;
  out: Computer[];
  picked: Computer | undefined;
  caps: ComputerCaps | null;
  pick(computer: Computer | undefined): void;
}

export function useComputerChoice(home?: string): ComputerChoice {
  const { view } = useComputers();
  const [chosen, setChosen] = useState<string | null>();
  const out = view?.computers.filter((c) => c.direction === 'out') ?? [];
  const wanted = chosen === undefined ? home : chosen;
  const picked = out.find((c) => c.name === wanted);
  return { self: view?.self.name ?? 'this computer', out, picked, caps: picked?.caps ?? null, pick: (computer) => setChosen(computer?.name ?? null) };
}

export const lacksHarness = (caps: ComputerCaps | null, id: string) => caps !== null && !caps.harnesses.some((h) => h.id === id && h.loggedIn);

function note(computer: Computer): string {
  if (!computer.online) return `offline · ${computer.lastSeen === null ? 'never seen' : `last seen ${TIME.format(computer.lastSeen)}`}`;
  if (computer.needsUpdate) return 'needs a hos update';
  const slots = Object.values(computer.caps?.slots ?? {});
  const free = slots.reduce((sum, s) => sum + Math.max(0, s.max - s.running), 0);
  return `online · room for ${free} of ${slots.reduce((sum, s) => sum + s.max, 0)} chats${computer.caps?.browser ? '' : ' · no Chrome'}`;
}

export function ComputerNote({ name, state, topicId }: { name: string; state: State; topicId: string }) {
  const lines = (state.topics[topicId]?.workspaceIds ?? []).flatMap((id) => {
    const workspace = state.workspaces[id];
    if (!workspace || workspace.archivedAt !== null) return [];
    const project = state.projects.find((p) => p.id === workspace.projectId);
    const tree = state.worktrees[workspace.path];
    const label = `${project?.key ?? project?.name ?? workspace.name} · ${workspace.kind === 'worktree' ? (workspace.branch ?? 'detached') : 'root'}`;
    const warn = tree?.dirty
      ? 'has uncommitted changes'
      : workspace.kind === 'worktree' && tree && !tree.upstream
        ? 'isn’t pushed'
        : tree?.unpushed
          ? `has ${tree.unpushed} unpushed commit${tree.unpushed === 1 ? '' : 's'}`
          : null;
    return warn ? [`${label} ${warn}`] : [];
  });
  if (!lines.length) return null;
  return (
    <p className="computer-note" aria-label={`Workspaces on ${name}`}>
      <b>{`${lines.join(', ')}; ${name} won’t see it`}</b>
    </p>
  );
}

export function ComputerPick({ choice, onPick }: { choice: ComputerChoice; onPick?: (computer: Computer | undefined) => void }) {
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
  if (!choice.out.length) return null;
  const shown = choice.picked?.name ?? choice.self;
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  const choose = (computer: Computer | undefined) => {
    choice.pick(computer);
    onPick?.(computer);
    close();
  };
  return (
    <div className="computer-picker" ref={wrap}>
      <button ref={button} type="button" className="computer-pick" aria-haspopup="menu" aria-expanded={open} aria-label={`Computer: ${shown}`} title={`Computer this chat runs on: ${shown}`} onClick={() => setOpen(!open)}>
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
          <rect x="2" y="2.5" width="12" height="8.5" rx="1.2" />
          <path d="M6 13.5h4M8 11v2.5" />
        </svg>
        <span>{shown}</span>
        <Icon id="i-chev" />
      </button>
      {open && (
        <div
          className="computer-pop"
          role="menu"
          aria-label="Computer"
          onKeyDown={(e) => {
            const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
            const i = items.indexOf(document.activeElement as HTMLButtonElement);
            if (e.key === 'Escape') close();
            else if (e.key === 'ArrowDown') items[(i + 1) % items.length]?.focus();
            else if (e.key === 'ArrowUp') items[(i - 1 + items.length) % items.length]?.focus();
            else return;
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <h4>Run on</h4>
          <button type="button" role="menuitemradio" aria-checked={!choice.picked} onClick={() => choose(undefined)}>
            <b>{choice.self}</b>
            <small>this computer</small>
          </button>
          {choice.out.map((computer) => (
            <button
              key={computer.name}
              type="button"
              role="menuitemradio"
              aria-checked={choice.picked?.name === computer.name}
              disabled={!computer.online || computer.needsUpdate}
              onClick={() => choose(computer)}
            >
              <b>{computer.name}</b>
              <small>{note(computer)}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
