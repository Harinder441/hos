import { useState, type MouseEvent, type ReactNode } from 'react';
import type { DiagramInfo } from '../../../src/api/types.js';
import { errorText, plural } from '../lib.js';
import { computerLabels, openComputerTopic, useComputers } from '../model/computers.js';
import { markAllSeen, markSeen, mergedTopicRows, type RemoteTopic, type TopicRow } from '../model/index.js';
import type { State } from '../state.js';
import { useTopicActions } from '../topic/TopicHeader.js';
import { Icon, SignMark } from './icons.js';
import { MoreButton } from './Menu.js';
import { NameText } from './Naming.js';
import { routeTopicId, TOPIC_HISTORY_HREF, topicHref, type Route } from './routes.js';

export function SidebarSection({ label, extra, defaultOpen = true, children }: { label: string; extra?: ReactNode; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={open ? 'sec' : 'sec closed'} aria-label={label}>
      <div className="sec-head-row">
        <button type="button" className="sec-head" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon id="i-chev" className="chev" />
          {label}
        </button>
        {extra}
      </div>
      {open && <div className="sec-body">{children}</div>}
    </section>
  );
}

const CHIP_KEY = 'hos.topicComputer';
const TIME = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export function SidebarTopics({ rows, route, state, diagrams }: { rows: TopicRow[]; route: Route; state: State; diagrams: DiagramInfo[] }) {
  const current = routeTopicId(route);
  const { view } = useComputers();
  const [stored, setStored] = useState(() => localStorage.getItem(CHIP_KEY));
  const merged = mergedTopicRows(state, rows, view);
  const self = view?.self.name ?? '';
  const label = computerLabels(view);
  const out = view?.computers.filter((c) => c.direction === 'out') ?? [];
  const names = out.length ? [self, ...out.map((c) => c.name)].sort((a, b) => Number(label(b) === 'PC') - Number(label(a) === 'PC')) : [];
  const only = stored !== null && (stored === '' || names.includes(stored)) ? stored || undefined : names.find((name) => label(name) === 'PC');
  const pick = (name: string | undefined) => {
    localStorage.setItem(CHIP_KEY, name ?? '');
    setStored(name ?? '');
  };
  const shown = (row: TopicRow) => !only || (row.home ?? self) === only || !!row.liveOn?.includes(only);
  const mark = (row: TopicRow) => (names.length > 0 && !only && row.home && row.home !== self ? row.home : undefined);
  const topics = merged.filter(shown);
  const unseen = topics.some((row) => row.unseen);
  return (
    <>
      <SidebarSection
        label="Topics"
        extra={
          <>
            {unseen && (
              <button type="button" className="sidebar-seen-all" onClick={() => void markAllSeen()}>
                Mark all seen
              </button>
            )}
            <a
              className="icon-btn sidebar-topic-history"
              href={TOPIC_HISTORY_HREF}
              aria-label="Topic history"
              title="All topics, including archived ones"
              aria-current={route.page === 'topicHistory' ? 'page' : undefined}
            >
              <Icon id="i-history" />
            </a>
          </>
        }
      >
        {names.length > 0 && (
          <div className="sidebar-chips" role="group" aria-label="Show topics from">
            {[undefined, ...names].map((name) => (
              <button key={name ?? ''} type="button" aria-pressed={only === name} title={name} onClick={() => pick(name)}>
                {name === undefined ? 'All' : label(name)}
              </button>
            ))}
          </div>
        )}
        {topics.length === 0 && <p className="sidebar-empty">No topics yet. Start one with New chat.</p>}
        <ul className="sidebar-list" aria-label="Topics">
          {topics.map((row) =>
            row.remote ? (
              <SidebarRemoteTopic key={row.id} row={row} remote={row.remote} home={mark(row)} label={label} />
            ) : (
              <SidebarTopic key={row.id} row={row} current={row.id === current} state={state} home={mark(row)} label={label} count={diagrams.filter((d) => d.topic === row.id).length} />
            ),
          )}
        </ul>
      </SidebarSection>
    </>
  );
}

function HomeMark({ home, label }: { home?: string; label: (name: string) => string }) {
  return home ? (
    <span className="sidebar-home" title={home}>
      {label(home)}
    </span>
  ) : null;
}

function SidebarRemoteTopic({ row, remote, home, label }: { row: TopicRow; remote: RemoteTopic; home?: string; label: (name: string) => string }) {
  const [error, setError] = useState<string>();
  const seen = remote.lastSeen === null ? 'never seen' : `last seen ${TIME.format(remote.lastSeen)}`;
  const open = (event: MouseEvent) => {
    event.preventDefault();
    if (!remote.online) return;
    setError(undefined);
    openComputerTopic(remote.computer, row.id).then(
      () => (location.hash = topicHref(row.id)),
      (e: unknown) => setError(errorText(e)),
    );
  };
  return (
    <li className={`sidebar-topic remote${remote.online ? '' : ' offline'}`}>
      <SignMark sign={row.sign} label={row.stateText} />
      <span className="sidebar-dot" aria-hidden="true" />
      <a
        className="title"
        href={topicHref(row.id)}
        aria-disabled={remote.online ? undefined : true}
        title={remote.online ? `${row.title} · on ${remote.computer}` : `${row.title} · ${remote.computer} is offline, ${seen}`}
        onClick={open}
      >
        {row.title}
      </a>
      <HomeMark home={home} label={label} />
      {error && (
        <p className="sidebar-error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

function SidebarTopic({ row, current, state, home, label, count = 0 }: { row: TopicRow; current: boolean; state: State; home?: string; label: (name: string) => string; count?: number }) {
  const { menu, dialogs } = useTopicActions(state, row.id, row.lastChatId);
  const title = row.title;
  return (
    <li className={`sidebar-topic${row.unseen ? ' unseen' : ''}`} data-current={current ? '' : undefined} data-menu-open={menu.open ? '' : undefined}>
      <SignMark sign={row.sign} label={row.stateText} />
      <span className="sidebar-dot" aria-hidden="true" />
      <a
        className="title"
        href={topicHref(row.id)}
        aria-current={current ? 'page' : undefined}
        title={title}
        onClick={() => row.unseen && void markSeen(row.id)}
      >
        <NameText text={title} naming={row.naming} />
        {row.unseen && <span className="sr">, unseen</span>}
      </a>
      {count > 0 && (
        <span className="sidebar-dias" title={plural(count, 'diagram')}>
          <Icon id="i-diagram" />
          {count}
          <span className="sr"> {count === 1 ? 'diagram' : 'diagrams'}</span>
        </span>
      )}
      <HomeMark home={home} label={label} />
      <MoreButton label={`More for ${title}`} tip="More actions for this topic" menu={menu} className="sidebar-more" />
      {menu.element}
      {dialogs}
    </li>
  );
}
