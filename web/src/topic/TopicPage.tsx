import { useEffect, useRef } from 'react';
import { useDiagrams } from '../diagrams/data.js';
import { markSeen, topicRow, topicTabs, type TopicTab } from '../model/index.js';
import { diagramHref } from '../shell/routes.js';
import type { State } from '../state.js';
import '../styles/topic.css';
import '../styles/picker.css';
import { openCards } from './cards.js';
import { Composer, DraftComposer, type ComposerHandle } from './Composer.js';
import { WorkspacePicker } from './Picker.js';
import { isWorking, Thread, threadChats } from './Thread.js';
import { LinkChips, useLinkDrop } from './Links.js';
import { ChatTabs, diagramKey, TopicHeader, useClosedTabs } from './TopicHeader.js';
import { RemoteLine, RemoteRefresh, useRemoteHistory } from './remote.js';

export function TopicPage({ topicId, chatId, draft, state, live }: { topicId: string; chatId?: string; draft: boolean; state: State; live: boolean }) {
  const row = topicRow(state, topicId);
  const { diagrams } = useDiagrams(state.diagramSeq);
  const mine = diagrams?.filter((diagram) => diagram.topic === topicId) ?? [];
  const lineage = (id: string | undefined) => (id ? (state.chats[id]?.lineageId ?? id) : undefined);
  const tabs = topicTabs(state, topicId);
  const [closed] = useClosedTabs(state, topicId);
  const open = tabs.filter((tab) => tab.sign === 'needs' || !closed.includes(lineage(tab.chatId)!));
  const openDiagrams = mine.filter((diagram) => !closed.includes(diagramKey(diagram.id)));
  const lastKey = `hos.lastChat.${topicId}`;
  const stored = localStorage.getItem(lastKey) ?? undefined;
  const last = lineage(stored);
  const lastTab = open.find((tab) => lineage(tab.chatId) === last)?.chatId;
  const recent = open.reduce<TopicTab | undefined>((best, tab) => (!best || tab.lastAt > best.lastAt ? tab : best), undefined)?.chatId;
  const active = draft ? undefined : (chatId ?? lastTab ?? recent);
  const lastDiagram = openDiagrams.find((diagram) => diagramKey(diagram.id) === stored);
  const jump = draft || !diagrams || chatId ? undefined : (lastDiagram ?? (open.length ? undefined : openDiagrams[0]));
  const selected = tabs.find((tab) => lineage(tab.chatId) === lineage(active))?.chatId;
  const unseen = row?.unseen ?? false;
  const composer = useRef<ComposerHandle>(null);
  const chats = active ? threadChats(state, active) : [];
  const latest = chats.at(-1);
  const cards = openCards(state, chats);
  const plan = cards.find((card) => card.kind === 'plan')?.item;
  const asking = cards.some((card) => card.kind === 'question');
  const drop = useLinkDrop(state, active);
  const remote = useRemoteHistory(chats);

  useEffect(() => {
    void markSeen(topicId);
  }, [topicId]);

  useEffect(() => {
    if (jump) location.replace(diagramHref(topicId, jump.id));
    else if (selected) localStorage.setItem(lastKey, selected);
  }, [lastKey, selected, jump?.id]);

  useEffect(() => {
    const seeIfVisible = () => document.visibilityState === 'visible' && unseen && void markSeen(topicId);
    seeIfVisible();
    document.addEventListener('visibilitychange', seeIfVisible);
    return () => document.removeEventListener('visibilitychange', seeIfVisible);
  }, [topicId, unseen, row?.lastActivityAt]);

  if (!row) return <p className="page-empty muted">{live ? 'No topic with this id. It may have been archived.' : 'Loading the topic…'}</p>;
  if (jump || (!diagrams && !chatId && !draft)) return <p className="page-empty muted">Opening the topic…</p>;

  return (
    <>
      <TopicHeader
        topicId={topicId}
        chatId={active ?? ''}
        state={state}
        diagrams={mine}
        actions={remote && <RemoteRefresh history={remote} />}
        tabs={<ChatTabs key={topicId} topicId={topicId} tabs={tabs} selected={selected} drafting={!active} state={state} diagrams={mine} />}
      />
      {!active ? (
        <section className="thread" aria-label="Chat">
          <p className="page-empty muted">Pick the agent, model and effort, then send the first message to start this chat.</p>
          <DraftComposer topicId={topicId} home={state.topics[topicId]?.home} state={state} />
        </section>
      ) : (
        <section className="thread" aria-label="Chat" data-drop={drop.over || undefined} {...drop.props}>
          {drop.over && (
            <div className="link-drop" aria-hidden="true">
              Drop to link
            </div>
          )}
          <LinkChips state={state} chatId={active} diagrams={diagrams ?? []} error={drop.error} />
          {remote && <RemoteLine history={remote} />}
          <Thread topicId={topicId} chatId={active} state={state} onEditPlan={() => composer.current?.edit('Change the plan: ')} />
          <WorkspacePicker topicId={topicId} chatId={active} state={state} />
          {latest && <Composer key={latest.id} ref={composer} chat={latest} state={state} working={isWorking(state, chats)} plan={plan} asking={asking} />}
        </section>
      )}
    </>
  );
}
