import { useEffect, useRef, useState, type ReactNode } from 'react';
import { needsYou, topicRows } from '../model/index.js';
import type { State } from '../state.js';
import { trapTab } from '../lib.js';
import { Icon, ShapeMark, SignMark, type IconId } from './icons.js';
import { topicHref } from './routes.js';

export interface Command {
  id: string;
  label: string;
  icon: ReactNode;
  kbd?: string;
  run(): void;
}

const go = (hash: string) => () => {
  location.hash = hash;
};

const icon = (id: IconId) => <Icon id={id} />;

export function usePaletteCommands(
  state: State,
  topicId: string | undefined,
  shell: { confirmKill(): void },
  panel: { toggle(): void },
  toggleSide: () => void,
): Command[] {
  const rows = topicRows(state);
  const next = needsYou(state)[0];
  return [
    {
      id: 'next',
      label: 'Go to next that needs you',
      icon: <ShapeMark shape="s-needs" />,
      kbd: '⌘⌥L',
      run: () => {
        if (next) location.hash = topicHref(next.topicId, next.chatId);
      },
    },
    { id: 'new', label: 'New chat', icon: icon('i-plus'), kbd: '⌘N', run: go('#/new') },
    ...rows.map((row) => ({
      id: `topic:${row.id}`,
      label: `Continue ${row.title}`,
      icon: <SignMark sign={row.sign} label={false} />,
      run: go(topicHref(row.id)),
    })),
    { id: 'side', label: 'Toggle sidebar', icon: icon('i-side'), run: toggleSide },
    { id: 'panel', label: 'Toggle workspaces panel', icon: icon('i-panel'), kbd: '⌘⌥B', run: panel.toggle },
    { id: 'config', label: 'Environment files', icon: icon('i-file'), run: go('#/settings/workspaces') },
    { id: 'doctor', label: 'Doctor', icon: icon('i-ops'), run: go('#/settings/doctor') },
    { id: 'settings', label: 'Settings', icon: icon('i-gear'), run: go('#/settings') },
    { id: 'schedules', label: 'Schedules', icon: icon('i-wait'), run: go('#/settings/schedules') },
    { id: 'servers', label: 'Ops: servers', icon: icon('i-server'), run: go('#/ops/servers') },
    { id: 'terminals', label: 'Ops: terminals', icon: icon('i-term'), run: go('#/ops/terminals') },
    { id: 'governor', label: 'Ops: limits', icon: icon('i-ops'), run: go('#/ops/governor') },
    { id: 'keeper', label: 'Ops: background service', icon: icon('i-ops'), run: go('#/ops/keeper') },
    { id: 'audit', label: 'Ops: audit log', icon: icon('i-file'), run: go('#/ops/audit') },
    { id: 'actions', label: 'Ops: actions', icon: icon('i-term'), run: go('#/ops/actions') },
    { id: 'kill', label: 'Stop all chats', icon: <ShapeMark shape="s-stop" />, run: shell.confirmKill },
  ];
}

export function Palette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = commands.filter((c) => words.every((w) => c.label.toLowerCase().includes(w)));
  const active = Math.min(selected, Math.max(shown.length - 1, 0));
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    input.current?.focus();
    return () => before?.focus?.();
  }, []);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  const run = (command: Command | undefined) => {
    if (!command) return;
    onClose();
    command.run();
  };
  return (
    <div className="palette-wrap" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Search and commands" onKeyDown={trapTab}>
        <input
          ref={input}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={shown[active] ? `palette-${active}` : undefined}
          aria-label="Search topics and commands"
          placeholder="Search topics and commands"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSelected((active + 1) % Math.max(shown.length, 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSelected((active - 1 + shown.length) % Math.max(shown.length, 1));
            } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              run(shown[active]);
            }
          }}
        />
        <ul role="listbox" id="palette-list" aria-label="Commands" ref={list}>
          {shown.map((command, i) => (
            <li
              key={command.id}
              id={`palette-${i}`}
              role="option"
              aria-selected={i === active}
              onPointerMove={() => i !== active && setSelected(i)}
              onClick={() => run(command)}
            >
              {command.icon}
              {command.label}
              {command.kbd && <kbd aria-hidden="true">{command.kbd}</kbd>}
            </li>
          ))}
          {shown.length === 0 && <li className="palette-empty">Nothing matches “{query}”.</li>}
        </ul>
      </div>
    </div>
  );
}
