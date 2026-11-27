import { lazy, Suspense, useEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import type { Subscription } from '../../src/api/client.js';
import type { Snapshot } from '../../src/api/state.js';
import { CODE_PR_HASH, type HosEvent } from '../../src/api/types.js';
import { CodePr } from './CodePr.js';
import { DiffView } from './Diff.js';
import { Gate } from './Gate.js';
import { Home } from './home/Home.js';
import { client, useHash } from './lib.js';
import { deskTitle, needsYou, topicOfChat } from './model/index.js';
import { NewChat } from './new/NewChat.js';
import { ActionsView, AuditView, GovernorView, KeeperView, ServersView } from './Ops.js';
import { SettingsPage } from './settings/SettingsPage.js';
import { FirstRun, useFirstRun } from './setup/FirstRun.js';
import { onSnagEvent } from './snags/store.js';
import { Layout } from './shell/Layout.js';
import { parseRoute, topicHref, type OpsView } from './shell/routes.js';
import { applyEvents, initialState, type State } from './state.js';
import { TerminalTabs, TerminalsView, useTerminals } from './Terminal.js';
import { DiagramPage, OpenDiagram } from './topic/DiagramPage.js';
import { TopicHistoryPage } from './topic/TopicHistoryPage.js';
import { WorkspacesPanel } from './topic/Panel.js';
import { TopicPage } from './topic/TopicPage.js';
import './styles/panel.css';
import './styles/shell.css';

const SnagsPage = lazy(() => import('./snags/SnagsPage.js'));

export function App() {
  return <Gate>{location.hash.startsWith(CODE_PR_HASH) ? <CodePr /> : <Hos />}</Gate>;
}

const BATCH_MS = 32;
const PRESENCE_HEARTBEAT_MS = 20_000;

const TAB_ICON = '/icon.svg';

let tabIconSvg: Promise<string> | undefined;

const badgedIcon = async (count: number) => {
  tabIconSvg ??= fetch(TAB_ICON).then((res) => res.text());
  const badge = `<circle cx="352" cy="160" r="160" fill="#e5484d"/><text x="352" y="160" dominant-baseline="central" font-family="-apple-system, system-ui, sans-serif" font-size="${count > 9 ? 170 : 220}" font-weight="700" text-anchor="middle" fill="#fff">${count > 9 ? '9+' : count}</text>`;
  return `data:image/svg+xml,${encodeURIComponent((await tabIconSvg).replace('</svg>', `${badge}</svg>`))}`;
};

const reduce = (state: State, action: HosEvent[] | Snapshot): State => (Array.isArray(action) ? applyEvents(state, action) : action.state);

const bundleOf = (html: string) => html.match(/<script type="module"[^>]*\ssrc="([^"]+)"/)?.[1];

async function reloadIfDeployed() {
  const running = bundleOf(document.documentElement.outerHTML);
  const served = bundleOf(await fetch('/', { cache: 'no-store' }).then((res) => (res.ok ? res.text() : ''), () => ''));
  if (running && served && served !== running) location.reload();
}

function Hos() {
  const [state, dispatch] = useReducer(reduce, initialState);
  const [status, setStatus] = useState<'connecting' | 'live' | 'reconnecting'>('connecting');
  const [hash] = useHash();
  const [tabs, setTabs] = useState<string[]>([]);
  const route = parseRoute(hash);
  const terminal = route.page === 'terminal' ? route.name : undefined;
  const terminals = useTerminals(`${Object.values(state.terminals).join(',')}|${terminal ?? ''}`);
  const live = status === 'live';
  const dropped = useRef(false);
  const needs = needsYou(state).length;
  const chatTopic = route.page === 'chat' ? topicOfChat(state, route.chatId) : undefined;
  const firstRun = useFirstRun();

  useEffect(() => {
    let batch: HosEvent[] = [];
    let flushing: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      flushing = undefined;
      const events = batch;
      batch = [];
      if (events.length) dispatch(events);
    };
    let subscription: Subscription | undefined;
    let closed = false;
    const start = (since: number) => {
      if (closed) return;
      subscription = client.subscribe(
        (event) => {
          batch.push(event);
          flushing ??= setTimeout(flush, BATCH_MS);
          onSnagEvent(event);
        },
        { since, onStatus: setStatus },
      );
      presence();
    };
    const presence = () => subscription?.presence(document.visibilityState === 'visible', document.hasFocus());
    const heartbeat = setInterval(() => document.visibilityState === 'visible' && document.hasFocus() && presence(), PRESENCE_HEARTBEAT_MS);
    client.snapshot().then(
      (snapshot) => {
        if (closed) return;
        dispatch(snapshot);
        start(snapshot.seq);
      },
      () => start(0),
    );
    const resume = () => document.visibilityState === 'visible' && subscription?.resume();
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('online', resume);
    document.addEventListener('visibilitychange', presence);
    window.addEventListener('focus', presence);
    window.addEventListener('blur', presence);
    return () => {
      closed = true;
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('online', resume);
      document.removeEventListener('visibilitychange', presence);
      window.removeEventListener('focus', presence);
      window.removeEventListener('blur', presence);
      clearInterval(heartbeat);
      clearTimeout(flushing);
      subscription?.close();
    };
  }, []);

  useEffect(() => {
    if (status === 'reconnecting') dropped.current = true;
    else if (status === 'live' && dropped.current) {
      dropped.current = false;
      void reloadIfDeployed();
    }
  }, [status]);

  useEffect(() => {
    if (route.page === 'redirect') location.replace(route.to);
    if (route.page === 'chat' && chatTopic) location.replace(topicHref(chatTopic, route.chatId));
  }, [hash, chatTopic]);

  useEffect(() => {
    void navigator.setAppBadge?.(needs).catch(() => {});
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!icon) return;
    if (!needs) {
      icon.href = TAB_ICON;
      return;
    }
    let current = true;
    void badgedIcon(needs).then((href) => {
      if (current) icon.href = href;
    });
    return () => {
      current = false;
    };
  }, [needs]);

  useEffect(() => {
    if (terminal && !tabs.includes(terminal)) setTabs([...tabs, terminal]);
  }, [terminal]);

  const closeTab = (name: string) => {
    const rest = tabs.filter((t) => t !== name);
    setTabs(rest);
    location.hash = rest.length ? `#/terminal/${encodeURIComponent(rest.at(-1)!)}` : '#/ops/terminals';
  };

  let page: ReactNode;
  let panel: ReactNode | undefined;
  switch (route.page) {
    case 'home':
      page = <Home state={state} />;
      break;
    case 'new':
      page = <NewChat prompt={route.prompt} quickTitle={deskTitle(state)} />;
      break;
    case 'topic':
      page = <TopicPage key={route.topicId} topicId={route.topicId} {...(route.chatId ? { chatId: route.chatId } : {})} draft={route.draft === true} state={state} live={live} />;
      panel = <WorkspacesPanel key={route.topicId} topicId={route.topicId} state={state} />;
      break;
    case 'diagram':
      page = <DiagramPage key={route.diagramId} topicId={route.topicId} diagramId={route.diagramId} state={state} />;
      panel = <WorkspacesPanel key={route.topicId} topicId={route.topicId} state={state} />;
      break;
    case 'openDiagram':
      page = <OpenDiagram key={route.diagramId} diagramId={route.diagramId} />;
      break;
    case 'chat':
      page = <p className="page-empty muted">{live && !chatTopic ? 'No chat with this id.' : 'Opening the chat…'}</p>;
      break;
    case 'settings':
      page = <SettingsPage state={state} {...(route.tab ? { tab: route.tab } : {})} />;
      break;
    case 'snags':
      page = (
        <Suspense fallback={<p className="page-empty muted">Loading snags…</p>}>
          <SnagsPage state={state} />
        </Suspense>
      );
      break;
    case 'topicHistory':
      page = <TopicHistoryPage state={state} />;
      break;
    case 'diff':
      page = (
        <div className="legacy pane">
          <DiffView key={hash} route={{ kind: route.kind, id: route.id, ref: route.ref }} state={state} />
        </div>
      );
      break;
    case 'ops':
      page = <div className="legacy pane">{route.view === 'terminals' ? <TerminalsView terminals={terminals} state={state} /> : <OpsPage view={route.view} state={state} />}</div>;
      break;
    case 'terminal':
      page = (
        <div className="legacy pane terminal-pane">
          <TerminalTabs tabs={tabs.includes(route.name) ? tabs : [...tabs, route.name]} active={route.name} onClose={closeTab} />
        </div>
      );
      break;
    case 'redirect':
      page = null;
      break;
  }

  if (firstRun.active) return <FirstRun state={state} setup={firstRun.setup} onDone={firstRun.finish} />;
  return (
    <Layout state={state} status={status} route={route} {...(panel !== undefined ? { panel } : {})}>
      {page}
    </Layout>
  );
}

function OpsPage({ view, state }: { view: Exclude<OpsView, 'terminals'>; state: State }) {
  switch (view) {
    case 'servers':
      return <ServersView state={state} />;
    case 'governor':
      return <GovernorView state={state} />;
    case 'keeper':
      return <KeeperView state={state} />;
    case 'audit':
      return <AuditView state={state} />;
    case 'actions':
      return <ActionsView state={state} />;
  }
}

