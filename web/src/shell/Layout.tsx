import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { needsYou, topicRows } from '../model/index.js';
import { PHONE_QUERY, useMediaQuery } from '../lib.js';
import type { State } from '../state.js';
import { ColumnResizer } from './ColumnResizer.js';
import { Icon, Sprite } from './icons.js';
import { KillDialog } from './KillEverything.js';
import { Palette, usePaletteCommands } from './Palette.js';
import { PhoneTabs } from './PhoneTabs.js';
import { Sidebar } from './Sidebar.js';
import { routeTopicId, topicHref, type Route } from './routes.js';

interface Panel {
  open: boolean;
  toggle(): void;
  setAvailable(available: boolean): void;
}

interface Shell {
  openPalette(): void;
  openSide(): void;
  confirmKill(): void;
}

const PanelContext = createContext<Panel>({ open: false, toggle() {}, setAvailable() {} });
const ShellContext = createContext<Shell>({ openPalette() {}, openSide() {}, confirmKill() {} });

export function usePanel(): Panel {
  return useContext(PanelContext);
}

export function useShell(): Shell {
  return useContext(ShellContext);
}

const NARROW_QUERY = '(max-width: 1100px)';

export function nextNeedsHref(state: State): string | undefined {
  const next = needsYou(state)[0];
  return next && topicHref(next.topicId, next.chatId);
}

export function NeedsPill({ state, className = '' }: { state: State; className?: string }) {
  const count = needsYou(state).length;
  const href = nextNeedsHref(state);
  if (!count || !href) return null;
  return (
    <a className={`needs-pill ${className}`.trim()} href={href} aria-label={`${count} waiting on you, open the oldest`} title="Open the oldest thing waiting on you (⌥⌘L)">
      {count}
    </a>
  );
}

export function Layout(props: { state: State; status: string; route: Route; panel?: ReactNode; children: ReactNode }) {
  const { state, route } = props;
  const phone = useMediaQuery(PHONE_QUERY);
  const [panelOpen, setPanelOpen] = useState(() => !matchMedia(NARROW_QUERY).matches && localStorage.getItem('hos.panelOpen') !== 'false');
  const [sideHidden, setSideHidden] = useState(() => localStorage.getItem('hos.sideHidden') === 'true');
  const [available, setAvailable] = useState(false);
  const [sideOpen, setSideOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [killOpen, setKillOpen] = useState(false);
  const topicId = routeTopicId(route);
  const panel: Panel = { open: panelOpen && available, toggle: () => setPanelOpen((open) => !open), setAvailable };
  const shell: Shell = {
    openPalette: () => {
      setSideOpen(false);
      setPaletteOpen(true);
    },
    openSide: () => (phone ? setSideOpen(true) : setSideHidden(false)),
    confirmKill: () => {
      setSideOpen(false);
      setKillOpen(true);
    },
  };
  const commands = usePaletteCommands(state, topicId, shell, panel, () => setSideHidden((hidden) => !hidden));

  useEffect(() => {
    if (!matchMedia(NARROW_QUERY).matches) localStorage.setItem('hos.panelOpen', String(panelOpen));
  }, [panelOpen]);

  useEffect(() => {
    localStorage.setItem('hos.sideHidden', String(sideHidden));
  }, [sideHidden]);

  useEffect(() => {
    setSideOpen(false);
    setPaletteOpen(false);
  }, [location.hash]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === 'Escape' && sideOpen) setSideOpen(false);
      if (!mod) return;
      if (e.altKey && e.code === 'KeyL') {
        const href = nextNeedsHref(state);
        e.preventDefault();
        if (href) location.hash = href;
      } else if (e.altKey && e.code === 'KeyB') {
        e.preventDefault();
        setPanelOpen((open) => !open);
      } else if (e.altKey || e.shiftKey) {
        return;
      } else if (e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((open) => !open);
      } else if (e.key.toLowerCase() === 'n') {
        e.preventDefault();
        location.hash = '#/new';
      } else if (e.key === '1') {
        e.preventDefault();
        location.hash = '#/';
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [state, sideOpen]);

  const hidden = sideHidden && !phone;
  const className = ['app', available ? '' : 'no-panel', panelOpen ? 'panel-open' : '', sideOpen ? 'side-open' : '', hidden ? 'side-hidden' : ''].filter(Boolean).join(' ');
  return (
    <PanelContext.Provider value={panel}>
      <ShellContext.Provider value={shell}>
        <Sprite />
        <div className={className}>
          <Sidebar state={state} route={route} rows={topicRows(state)} drawer={phone} onClose={() => setSideOpen(false)} onHide={() => setSideHidden(true)} />
          {hidden && (
            <div className="side-rail">
              <button type="button" className="icon-btn" aria-label="Show sidebar" title="Show sidebar" onClick={() => setSideHidden(false)}>
                <Icon id="i-side" />
              </button>
              <NeedsPill state={state} />
            </div>
          )}
          {phone && sideOpen && <button className="side-scrim" aria-label="Close navigation" title="Close the sidebar" tabIndex={-1} onClick={() => setSideOpen(false)} />}
          <main className="main" aria-label="Main">
            {props.status !== 'live' && (
              <p className="conn-status" role="status">
                {props.status}…
              </p>
            )}
            {props.children}
          </main>
          {props.panel !== undefined && (
            <aside className="panel" aria-label="Workspaces panel">
              {props.panel}
            </aside>
          )}
          {!phone && <ColumnResizer className="side-resizer" variable="--side-w" storageKey="hos.sideW" side="start" min={200} max={420} label="Resize the sidebar" />}
          {!phone && props.panel !== undefined && (
            <ColumnResizer className="panel-resizer" variable="--panel-w" storageKey="hos.panelW" side="end" min={280} max={640} label="Resize the workspaces panel" />
          )}
        </div>
        <PhoneTabs state={state} route={route} sideOpen={sideOpen} paletteOpen={paletteOpen} />
        {paletteOpen && <Palette commands={commands} onClose={() => setPaletteOpen(false)} />}
        {killOpen && <KillDialog onClose={() => setKillOpen(false)} />}
      </ShellContext.Provider>
    </PanelContext.Provider>
  );
}
