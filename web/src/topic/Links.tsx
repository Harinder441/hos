import { useState, type DragEvent } from 'react';
import type { DiagramInfo } from '../../../src/api/types.js';
import { useDiagrams } from '../diagrams/data.js';
import { client, errorText } from '../lib.js';
import { chatHeads } from '../model/index.js';
import { Icon } from '../shell/icons.js';
import { diagramHref, topicHref } from '../shell/routes.js';
import type { State } from '../state.js';
import { Wrap } from './TopicHeader.js';

export const DRAG_CHAT = 'application/x-hos-chat';
export const DRAG_DIAGRAM = 'application/x-hos-diagram';

const linkable = (e: DragEvent) => e.dataTransfer.types.includes(DRAG_CHAT) || e.dataTransfer.types.includes(DRAG_DIAGRAM);

export function useLinkDrop(state: State, chatId: string | undefined) {
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string>();
  if (!chatId) return { over: false, error: undefined, props: {} };
  const lineageId = state.chats[chatId]?.lineageId ?? chatId;
  return {
    over,
    error,
    props: {
      onDragOver: (e: DragEvent<HTMLElement>) => {
        if (!linkable(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'link';
        if (!over) setOver(true);
      },
      onDragLeave: (e: DragEvent<HTMLElement>) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      },
      onDrop: (e: DragEvent<HTMLElement>) => {
        if (!linkable(e)) return;
        e.preventDefault();
        setOver(false);
        const chat = e.dataTransfer.getData(DRAG_CHAT);
        const diagramId = e.dataTransfer.getData(DRAG_DIAGRAM);
        if (chat === lineageId) return;
        setError(undefined);
        client.linkChat(chatId, chat ? { chatId: chat } : { diagramId }).catch((err: unknown) => setError(errorText(err)));
      },
    },
  };
}

export function LinkChips({ state, chatId, diagrams, error }: { state: State; chatId: string; diagrams: DiagramInfo[]; error?: string }) {
  const [failed, setFailed] = useState<string>();
  const lineageId = state.chats[chatId]?.lineageId ?? chatId;
  const links = state.links[lineageId] ?? [];
  const shown = error ?? failed;
  if (!links.length && !shown) return null;
  const heads = chatHeads(state);
  return (
    <div className="link-chips">
      <ul aria-label="Linked">
        {links.map((link) => {
          const head = link.kind === 'chat' ? heads.find((h) => h.lineageId === link.target) : undefined;
          const diagram = link.kind === 'diagram' ? diagrams.find((d) => d.id === link.target) : undefined;
          const title = head?.title ?? diagram?.title ?? link.target;
          const href = head ? topicHref(head.topicId, head.chatId) : diagram ? diagramHref(diagram.topic, diagram.id) : `#/diagram/${encodeURIComponent(link.target)}`;
          return (
            <li key={link.target} className="link-chip">
              <a href={href} title={head ? `${title} · ${head.topicTitle}` : title}>
                <Icon id={link.kind === 'diagram' ? 'i-diagram' : 'i-chats'} />
                <span className="link-chip-title">{title}</span>
              </a>
              <button
                type="button"
                aria-label={`Unlink ${title}`}
                title="Unlink"
                onClick={() => client.unlinkChat(chatId, link.target).catch((e: unknown) => setFailed(errorText(e)))}
              >
                <Icon id="i-x" />
              </button>
            </li>
          );
        })}
      </ul>
      {shown && (
        <span className="error-text" role="alert">
          {shown}
        </span>
      )}
    </div>
  );
}

export function LinkPicker({ kind, state, chatId, onClose }: { kind: 'chat' | 'diagram'; state: State; chatId: string; onClose: () => void }) {
  const { diagrams } = useDiagrams(state.diagramSeq);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string>();
  const lineageId = state.chats[chatId]?.lineageId ?? chatId;
  const taken = new Set((state.links[lineageId] ?? []).map((link) => link.target));
  const options =
    kind === 'chat'
      ? chatHeads(state)
          .filter((head) => !head.archived && head.lineageId !== lineageId && !taken.has(head.lineageId))
          .reverse()
          .map((head) => ({ key: head.lineageId, title: head.title, where: head.topicTitle, to: { chatId: head.lineageId } }))
      : (diagrams ?? [])
          .filter((diagram) => !taken.has(diagram.id))
          .map((diagram) => ({ key: diagram.id, title: diagram.title, where: state.topics[diagram.topic]?.title ?? diagram.topic, to: { diagramId: diagram.id } }));
  const needle = query.trim().toLowerCase();
  const shown = options.filter((option) => !needle || `${option.title} ${option.where}`.toLowerCase().includes(needle));
  const label = kind === 'chat' ? 'Link chat' : 'Attach diagram';
  const pick = (to: { chatId: string } | { diagramId: string }) => {
    setError(undefined);
    client.linkChat(chatId, to).then(onClose, (e: unknown) => setError(errorText(e)));
  };
  return (
    <Wrap onClose={onClose} role="dialog" label={label} className="link-picker">
      <h2>{label}</h2>
      <input
        className="topic-rename"
        aria-label={kind === 'chat' ? 'Find a chat' : 'Find a diagram'}
        placeholder="Search every topic"
        value={query}
        autoFocus
        onChange={(e) => setQuery(e.target.value)}
      />
      <ul className="link-options" aria-label={kind === 'chat' ? 'Chats' : 'Diagrams'}>
        {shown.map((option) => (
          <li key={option.key}>
            <button type="button" onClick={() => pick(option.to)}>
              <Icon id={kind === 'diagram' ? 'i-diagram' : 'i-chats'} />
              <span className="link-option-title">{option.title}</span>
              <span className="link-option-where">{option.where}</span>
            </button>
          </li>
        ))}
      </ul>
      {!shown.length && <p>{kind === 'diagram' && !diagrams ? 'Loading diagrams…' : 'Nothing left to link.'}</p>}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-acts">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Wrap>
  );
}
