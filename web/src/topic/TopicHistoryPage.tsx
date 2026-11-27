import { useEffect, useState } from 'react';
import type { Topic, TopicHistoryFact } from '../../../src/api/types.js';
import { client, errorText, plural } from '../lib.js';
import { Icon, IconButton } from '../shell/icons.js';
import { useShell } from '../shell/Layout.js';
import { topicHref } from '../shell/routes.js';
import type { State } from '../state.js';
import '../styles/topic-history.css';
import { When } from './when.js';

interface Row {
  topic: Topic;
  lastAt: number;
  chats: number;
  worktrees: Array<{ id: string; name: string; branch: string | null }>;
  historyEntries: number | undefined;
}

function rows(state: State, facts: Map<string, TopicHistoryFact> | undefined): Row[] {
  return Object.values(state.topics)
    .map((topic) => {
      const fact = facts?.get(topic.id);
      const ids = [...new Set([...(fact?.workspaceIds ?? []), ...topic.workspaceIds])];
      return {
        topic,
        lastAt: topic.lastActivityAt ?? topic.createdAt,
        chats: Object.values(state.chats).filter((chat) => chat.topicId === topic.id && chat.generation === 1).length,
        worktrees: ids.flatMap((id) => {
          const workspace = state.workspaces[id];
          return workspace ? [{ id, name: workspace.name, branch: workspace.branch }] : [];
        }),
        historyEntries: fact?.historyEntries,
      };
    })
    .sort((a, b) => b.lastAt - a.lastAt);
}

function matches(topic: Topic, query: string): boolean {
  const text = `${topic.title}\n${topic.request ?? ''}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((word) => text.includes(word));
}

function spanText(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return `${Math.max(1, Math.round(ms / 60_000))} min`;
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} days`;
}

function starter(topic: Topic): string {
  if (topic.createdBy === 'agent') return topic.createdByChat ? `by chat ${topic.createdByChat.slice(0, 8)}` : 'by an agent';
  return 'by you';
}

export function TopicHistoryPage({ state }: { state: State }) {
  const shell = useShell();
  const [query, setQuery] = useState('');
  const [facts, setFacts] = useState<Map<string, TopicHistoryFact>>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    client.topicHistory().then(
      (found) => cancelled || setFacts(new Map(found.map((fact) => [fact.topicId, fact]))),
      (e: unknown) => cancelled || setError(errorText(e)),
    );
    return () => {
      cancelled = true;
    };
  }, []);
  const all = rows(state, facts);
  const shown = query.trim() ? all.filter((row) => matches(row.topic, query.trim())) : all;
  return (
    <>
      <header className="topbar">
        <IconButton className="icon-btn menu-btn" icon="i-menu" label="Open navigation" tip="Open the sidebar" onClick={shell.openSide} />
        <h1>Topic history</h1>
      </header>
      <div className="th-body">
        <input
          className="th-search"
          type="search"
          placeholder="Search titles and requests"
          aria-label="Search topics"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <p className="muted th-count">
          {query.trim() ? `${shown.length} of ${plural(all.length, 'topic')}` : plural(all.length, 'topic')}
        </p>
        {error && <p className="error-text">{error}</p>}
        {shown.length === 0 && <p className="muted">{all.length ? 'No topic matches.' : 'No topics yet.'}</p>}
        <ul className="th-list" aria-label="Topics">
          {shown.map((row) => (
            <TopicHistoryRow key={row.topic.id} row={row} />
          ))}
        </ul>
      </div>
    </>
  );
}

function TopicHistoryRow({ row }: { row: Row }) {
  const { topic } = row;
  const archived = topic.state === 'archived';
  return (
    <li className={`th-row${archived ? ' archived' : ''}`} aria-label={topic.title}>
      <a className="th-title" href={topicHref(topic.id)}>
        {topic.title}
      </a>
      <span className={`th-state${archived ? ' archived' : ''}`}>{topic.state}</span>
      {topic.request && topic.request !== topic.title && <p className="th-request">{topic.request}</p>}
      <p className="th-meta">
        <span>
          Started <When at={topic.createdAt} className="when" /> {starter(topic)}
        </span>
        <span>
          Last activity <When at={row.lastAt} className="when" /> · over {spanText(row.lastAt - topic.createdAt)}
        </span>
        <span>{plural(row.chats, 'chat')}</span>
        {row.historyEntries !== undefined && row.historyEntries > 0 && <span>{row.historyEntries === 1 ? '1 history entry' : `${row.historyEntries} history entries`}</span>}
      </p>
      {row.worktrees.length > 0 && (
        <ul className="th-worktrees" aria-label="Workspaces">
          {row.worktrees.map((w) => (
            <li key={w.id}>
              <Icon id="i-branch" />
              {w.name}
              {w.branch && w.branch !== w.name && <span className="muted"> · {w.branch}</span>}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
