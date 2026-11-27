import { PHONE_QUERY, useMediaQuery } from '../lib.js';
import { needsYou, topicRows, type NeedsItem, type TopicRow, type WorkspaceChip } from '../model/index.js';
import { Icon, IconButton, ShapeMark } from '../shell/icons.js';
import { nextNeedsHref, useShell } from '../shell/Layout.js';
import { NameText } from '../shell/Naming.js';
import { useOwner } from '../topic/catalog.js';
import { Notifications } from '../shell/Notifications.js';
import { topicHref } from '../shell/routes.js';
import { NowLine } from '../shell/NowLine.js';
import type { State } from '../state.js';
import '../styles/home.css';
import { AlertBanner, CalendarToday, CaptureBox, TodayTasks, UsageGauges } from './sections.js';

const KIND: Record<NeedsItem['kind'], string> = { plan: 'Plan', question: 'Question', approval: 'Approval' };

function today(timeZone: string | undefined): string {
  return new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone }).format(new Date()).replace(',', '');
}

export function Home({ state }: { state: State }) {
  const shell = useShell();
  const phone = useMediaQuery(PHONE_QUERY);
  const zone = useOwner()?.timezone;
  const rows = topicRows(state);
  const titles = new Map(rows.map((row) => [row.id, row.title]));
  const needs = needsYou(state);
  return (
    <div className="home">
      <AlertBanner state={state} />
      <div className="home-in">
        <div className="home-head">
          <IconButton className="icon-btn menu-btn" icon="i-menu" label="Open navigation" tip="Open the sidebar" onClick={shell.openSide} />
          <h1>{today(zone)}</h1>
        </div>
        {phone && <NowLine variant="home" />}
        <CaptureBox state={state} />
        <div className="home-grid">
          <div>
            {needs.length > 0 && (
              <section className="home-blk" aria-labelledby="home-h-needs">
                <h2 id="home-h-needs">
                  Needs you
                  <a className="home-r" href={nextNeedsHref(state)} title="Open the next thing waiting on you">
                    Next one <kbd aria-hidden="true">⌘⌥L</kbd>
                  </a>
                </h2>
                <ul className="home-list" aria-label="Needs you">
                  {needs.map((item) => (
                    <li key={item.id}>
                      <a className="home-need" href={topicHref(item.topicId, item.chatId)}>
                        <ShapeMark shape="s-needs" className="home-sign" />
                        <span className="home-k">{KIND[item.kind]}</span>
                        <span className="home-txt">{item.text}</span>
                        <span className="home-in-topic">{titles.get(item.topicId) ?? ''}</span>
                      </a>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <section className="home-blk" aria-labelledby="home-h-topics">
              <h2 id="home-h-topics">Topics</h2>
              {rows.length === 0 ? (
                <p className="home-empty">
                  No topics yet. <a href="#/new">Start a new chat</a> and hos names the topic from your prompt.
                </p>
              ) : (
                <ul className="home-list" aria-label="Topics">
                  {rows.map((row) => (
                    <TopicLine key={row.id} row={row} />
                  ))}
                </ul>
              )}
            </section>
            <Notifications />
          </div>
          <div>
            <TodayTasks state={state} />
            <CalendarToday state={state} />
            <UsageGauges state={state} />
          </div>
        </div>
      </div>
    </div>
  );
}

const MAX_CHIPS = 6;

function TopicLine({ row }: { row: TopicRow }) {
  const shown = row.workspaces.length > MAX_CHIPS ? row.workspaces.slice(0, MAX_CHIPS - 1) : row.workspaces;
  const rest = row.workspaces.slice(shown.length);
  return (
    <li>
      <a className={`home-topic${row.unseen ? ' unseen' : ''}`} href={topicHref(row.id)}>
        <span className="home-dot" {...(row.unseen ? { role: 'img', 'aria-label': 'Unseen' } : { 'aria-hidden': true })} />
        <span className="home-t">
          <NameText text={row.title} naming={row.naming} />
        </span>
        <span className="home-chips">
          {shown.map((chip) => (
            <Chip key={chip.id} chip={chip} />
          ))}
          {rest.length > 0 && (
            <span className="home-chip" title={rest.map(chipTitle).join('\n')}>
              +{rest.length}
            </span>
          )}
        </span>
      </a>
    </li>
  );
}

function chipTitle(chip: WorkspaceChip): string {
  return `${chip.repo}${chip.kind === 'worktree' ? `, worktree ${chip.branch ?? ''}` : ', root checkout'}`;
}

function Chip({ chip }: { chip: WorkspaceChip }) {
  return (
    <span className="home-chip" title={chipTitle(chip)}>
      {chip.kind === 'worktree' && <Icon id="i-branch" />}
      {chip.repo}
    </span>
  );
}
