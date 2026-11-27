import { useEffect, useState } from 'react';
import { useDiagrams } from '../diagrams/data.js';
import type { TopicRow } from '../model/index.js';
import { client } from '../lib.js';
import { SidebarSnags } from '../snags/SidebarSnags.js';
import type { State } from '../state.js';
import { Icon, IconButton, ShapeMark } from './icons.js';
import { NeedsPill, useShell } from './Layout.js';
import { routeTopicId, type Route } from './routes.js';
import { SidebarTopics } from './SidebarTopics.js';
import { SidebarWorkspaces } from './SidebarWorkspaces.js';
import { NowLine } from './NowLine.js';

export function Sidebar(props: { state: State; route: Route; rows: TopicRow[]; drawer: boolean; onClose: () => void; onHide: () => void }) {
  const { state, route } = props;
  const shell = useShell();
  const { diagrams } = useDiagrams(state.diagramSeq);
  const current = route.page === 'home' ? 'home' : route.page === 'new' ? 'new' : route.page === 'settings' ? 'settings' : undefined;
  return (
    <aside className="side" aria-label="hos navigation">
      <div className="side-top">
        <a className="side-wordmark" href="#/" aria-label="hos home">
          hos
          <span className="side-signs" aria-hidden="true">
            <ShapeMark shape="s-go" />
            <ShapeMark shape="s-needs" />
            <ShapeMark shape="s-yield" />
            <ShapeMark shape="s-stop" />
          </span>
        </a>
        {!props.drawer && <NeedsPill state={state} />}
        {!props.drawer && (
          <button type="button" className="icon-btn side-hide" aria-label="Hide sidebar" title="Hide sidebar" onClick={props.onHide}>
            <Icon id="i-side" />
          </button>
        )}
        {props.drawer && (
          <IconButton icon="i-x" label="Close navigation" tip="Close the sidebar" onClick={props.onClose} />
        )}
      </div>
      {!props.drawer && <NowLine variant="side" />}
      <nav className="side-actions" aria-label="Places">
        <a className="nav-item" href="#/" aria-current={current === 'home' ? 'page' : undefined}>
          <Icon id="i-home" />
          Home
          <span className="kbd-hint" aria-hidden="true">
            <kbd>⌘</kbd>
            <kbd>1</kbd>
          </span>
        </a>
        <a className="nav-item" href="#/new" aria-current={current === 'new' ? 'page' : undefined}>
          <Icon id="i-plus" />
          New chat
          <span className="kbd-hint" aria-hidden="true">
            <kbd>⌘</kbd>
            <kbd>N</kbd>
          </span>
        </a>
        <button className="nav-item" type="button" onClick={shell.openPalette}>
          <Icon id="i-search" />
          Search and commands
          <span className="kbd-hint" aria-hidden="true">
            <kbd>⌘</kbd>
            <kbd>K</kbd>
          </span>
        </button>
      </nav>
      <div className="side-scroll">
        <SidebarTopics rows={props.rows} route={route} state={state} diagrams={diagrams ?? []} />
      </div>
      <div className="side-pinned">
        <SidebarWorkspaces state={state} topicId={routeTopicId(route)} />
        <SidebarSnags current={route.page === 'snags'} />
      </div>
      <SideFoot chats={state.chats} settings={current === 'settings'} />
    </aside>
  );
}

function SideFoot({ chats, settings }: { chats: State['chats']; settings: boolean }) {
  const [on, setOn] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    client.listKillSwitches().then(
      (switches) => cancelled || setOn(switches.some((s) => s.scope === 'global')),
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [chats]);
  const lift = async () => {
    setError(undefined);
    try {
      await client.liftKillSwitch({ scope: 'global' });
      setOn(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="side-foot">
      <a className="side-settings" href="#/settings" aria-current={settings ? 'page' : undefined}>
        <Icon id="i-gear" />
        Settings
      </a>
      {on && (
        <>
          <span className="side-killed" role="status">
            <ShapeMark shape="s-stop" />
            All chats stopped
          </span>
          <button type="button" className="side-lift" title="Let chats start and run again" onClick={lift}>
            Let chats run again
          </button>
        </>
      )}
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
