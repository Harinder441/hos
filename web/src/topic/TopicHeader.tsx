import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import type { Chat, DiagramInfo } from '../../../src/api/types.js';
import { client, errorText, PHONE_QUERY, trapTab, useMediaQuery } from '../lib.js';
import { computerLabels, useComputers } from '../model/computers.js';
import { topicRow, topicTabs, type TopicTab } from '../model/index.js';
import { Icon, IconButton, SignMark } from '../shell/icons.js';
import { NameText } from '../shell/Naming.js';
import { usePanel, useShell } from '../shell/Layout.js';
import { Menu, MoreButton, useMenu, type MenuItem } from '../shell/Menu.js';
import { diagramHref, newChatHref, topicHref } from '../shell/routes.js';
import type { State } from '../state.js';
import { DRAG_CHAT, DRAG_DIAGRAM, LinkPicker } from './Links.js';
import { profileStyle, useProfileColors } from './ProfilePick.js';
import { When } from './when.js';

export function useTopicActions(state: State, topicId: string, chatId: string | null) {
  const row = topicRow(state, topicId);
  const chat = chatId ? state.chats[chatId] : undefined;
  const [asking, setAsking] = useState<'rename' | 'archive' | 'kill'>();
  const menu = useMenu('More for this topic', [
    { label: 'Rename topic', onSelect: () => setAsking('rename') },
    ...(row?.desk ? [] : [{ label: 'Archive topic', onSelect: () => setAsking('archive') }]),
    ...(chat
      ? [
          {
            label: 'Hand off',
            onSelect: () => void client.handOff(chat.id).catch(() => {}),
          },
        ]
      : []),
    ...(chatId ? (['separator', { label: 'Stop chats', danger: true, onSelect: () => setAsking('kill') }] as const) : []),
  ]);
  const dialogs = (
    <>
      {asking === 'rename' && <RenameDialog title={row?.title ?? ''} onClose={() => setAsking(undefined)} onRename={(title) => client.renameTopic(topicId, title)} />}
      {asking === 'archive' && (
        <ConfirmDialog
          title="Archive this topic?"
          detail="Every chat in it stops and hos writes its history entry. Its worktrees are committed, pushed to their branch and removed; root checkouts stay. It leaves the sidebar."
          act="Archive topic"
          onClose={() => setAsking(undefined)}
          onConfirm={() => client.archiveTopic(topicId)}
          after={() => {
            if (location.hash.includes(topicId)) location.hash = '#/';
          }}
        />
      )}
      {asking === 'kill' && chatId && (
        <ConfirmDialog
          title="Stop this chat and the chats it started?"
          detail={`${killable(chat)} stops now. Your next message resumes it.`}
          act="Stop chats"
          danger
          onClose={() => setAsking(undefined)}
          onConfirm={() => client.kill({ scope: 'subtree', chatId })}
        />
      )}
    </>
  );
  return { menu, dialogs };
}

const CLOSED_TABS_CHANGED = 'hos:closed-tabs';
const isDiagram = (key: string) => key.startsWith('diagram:');

// Chat tabs are closed on the server so every device agrees; only diagram tabs stay in this browser.
export function useClosedTabs(state: State, topicId: string) {
  const key = `hos.closedTabs.${topicId}`;
  const read = () => JSON.parse(localStorage.getItem(key) ?? '[]') as string[];
  const [local, setLocal] = useState(() => read().filter(isDiagram));
  useEffect(() => {
    const stored = read();
    const chats = stored.filter((id) => !isDiagram(id));
    for (const chatId of chats) client.setChatTabClosed(chatId, true).catch(() => {});
    if (chats.length) localStorage.setItem(key, JSON.stringify(stored.filter(isDiagram)));
    const sync = () => setLocal(read().filter(isDiagram));
    sync();
    window.addEventListener(CLOSED_TABS_CHANGED, sync);
    return () => window.removeEventListener(CLOSED_TABS_CHANGED, sync);
  }, [key]);
  const serverClosed = Object.values(state.chats)
    .filter((chat) => chat.topicId === topicId && chat.tabClosed)
    .map((chat) => chat.id);
  const closed = [...serverClosed, ...local];
  const setClosed = (next: string[]) => {
    for (const chatId of serverClosed) if (!next.includes(chatId)) client.setChatTabClosed(chatId, false).catch(() => {});
    for (const chatId of next.filter((id) => !isDiagram(id))) if (!serverClosed.includes(chatId)) client.setChatTabClosed(chatId, true).catch(() => {});
    const diagrams = next.filter(isDiagram);
    localStorage.setItem(key, JSON.stringify(diagrams));
    setLocal(diagrams);
    window.dispatchEvent(new Event(CLOSED_TABS_CHANGED));
  };
  return [closed, setClosed] as const;
}

function AgentMark() {
  return (
    <span className="chat-agent" role="img" aria-label="started by an agent" title="Started by another chat, not by you">
      <Icon id="i-agent" />
    </span>
  );
}

export const diagramKey = (diagramId: string) => `diagram:${diagramId}`;

function useChatHistory(state: State, topicId: string, diagrams: DiagramInfo[]) {
  const [closed, setClosed] = useClosedTabs(state, topicId);
  const lineage = (chatId: string) => state.chats[chatId]?.lineageId ?? chatId;
  const all = topicTabs(state, topicId);
  const rows = [
    ...all.map((tab) => ({ key: lineage(tab.chatId), href: topicHref(topicId, tab.chatId), title: tab.title, agent: tab.agent, lastAt: tab.lastAt, mark: <SignMark sign={tab.sign} /> })),
    ...diagrams.map((diagram) => ({
      key: diagramKey(diagram.id),
      href: diagramHref(topicId, diagram.id),
      title: diagram.title,
      agent: false,
      lastAt: Math.max(diagram.updated, ...all.filter((tab) => diagram.chats.includes(lineage(tab.chatId))).map((tab) => tab.lastAt)),
      mark: <Icon id="i-diagram" className="hist-dia" />,
    })),
  ].sort((a, b) => b.lastAt - a.lastAt);
  return useMenu(
    'Chat history',
    rows.map((tab) => {
      const shut = closed.includes(tab.key);
      return {
        label: `${tab.title}${tab.agent ? ', started by an agent' : ''}${shut ? ', closed' : ''}`,
        match: tab.title,
        onSelect: () => {
          if (shut) setClosed(closed.filter((id) => id !== tab.key));
          location.hash = tab.href;
        },
        content: (
          <span className="hist-row">
            {tab.mark}
            <span className="hist-title">{tab.title}</span>
            {tab.agent && (
              <span className="hist-tag">
                <AgentMark />
                agent
              </span>
            )}
            {shut && <span className="hist-tag">closed</span>}
            <When at={tab.lastAt} className="when hist-when" />
          </span>
        ),
      };
    }),
    'Search chats',
  );
}

export function TopicHeader({
  topicId,
  chatId,
  state,
  diagrams = [],
  meta,
  actions,
  tabs,
}: {
  topicId: string;
  chatId: string;
  state: State;
  diagrams?: DiagramInfo[];
  meta?: ReactNode;
  actions?: ReactNode;
  tabs: ReactNode;
}) {
  const row = topicRow(state, topicId);
  const chat = state.chats[chatId];
  const shell = useShell();
  const panel = usePanel();
  const phone = useMediaQuery(PHONE_QUERY);
  const { menu, dialogs } = useTopicActions(state, topicId, chatId);
  const history = useChatHistory(state, topicId, diagrams);
  const title = <h1 className={phone ? undefined : 'sr'}>{row ? <NameText text={row.title} naming={row.naming} /> : 'Topic'}</h1>;
  const header = (
    <header className={phone ? 'topbar topic-head' : 'topbar topic-head merged'}>
      {phone ? (
        <>
          <IconButton className="icon-btn menu-btn" icon="i-menu" label="Open navigation" tip="Open the sidebar" onClick={shell.openSide} />
          {row && <SignMark sign={row.sign} className="lg" label={false} />}
          {title}
        </>
      ) : (
        <>
          {title}
          {tabs}
        </>
      )}
      {meta}
      <div className="right">
        {actions}
        {chat && (
          <button
            type="button"
            className="icon-btn"
            aria-label="Notify me when this chat finishes"
            aria-pressed={chat.notify}
            title={`Notify me when this chat finishes: ${chat.notify ? 'on' : 'off'}`}
            onClick={() => void client.setChatNotify(chat.id, !chat.notify).catch(() => {})}
          >
            <Icon id={chat.notify ? 'i-bell' : 'i-bell-off'} />
          </button>
        )}
        <IconButton icon="i-history" label="Chat history" tip="All chats in this topic, newest first" {...history.trigger} />
        <MoreButton label="More for this topic" tip="More actions for this topic" menu={menu} />
        <IconButton icon="i-panel" data-toggle-panel label="Toggle the workspaces panel" tip="Show or hide the side panel (⌘⌥B)" aria-pressed={panel.open} onClick={panel.toggle} />
      </div>
      {history.element}
      {menu.element}
      {dialogs}
    </header>
  );
  return phone ? (
    <>
      {header}
      {tabs}
    </>
  ) : (
    header
  );
}

export function ChatTabs({
  topicId,
  tabs,
  selected,
  drafting = false,
  state,
  diagrams = [],
  diagramId,
  onRenamed,
}: {
  topicId: string;
  tabs: TopicTab[];
  selected: string | undefined;
  drafting?: boolean;
  state: State;
  diagrams?: DiagramInfo[];
  diagramId?: string;
  onRenamed?: (info: DiagramInfo) => void;
}) {
  const [closed, setClosed] = useClosedTabs(state, topicId);
  const label = computerLabels(useComputers().view);
  const colors = useProfileColors();
  const phone = useMediaQuery(PHONE_QUERY);
  const [error, setError] = useState<string>();
  const [renaming, setRenaming] = useState<string>();
  const rename = (diagram: DiagramInfo, text: string) => {
    setRenaming(undefined);
    const title = text.trim();
    if (!title || title === diagram.title) return;
    setError(undefined);
    client.renameDiagram(diagram.id, title).then(
      (info) => onRenamed?.(info),
      (e: unknown) => setError(errorText(e)),
    );
  };
  const lineage = (chatId: string) => state.chats[chatId]?.lineageId ?? chatId;
  const starting = (tab: TopicTab) => drafting && !tab.agent && !state.timeline[tab.chatId]?.some((item) => item.kind === 'message');
  const shown = tabs.filter((tab) => !starting(tab) && (tab.sign === 'needs' || tab.chatId === selected || !closed.includes(lineage(tab.chatId))));
  const [linking, setLinking] = useState<{ kind: 'chat' | 'diagram'; chatId: string }>();
  const [tabMenu, setTabMenu] = useState<{ tab: TopicTab; x: number; y: number }>();
  const shownDiagrams = diagrams.filter((diagram) => diagram.id === diagramId || !closed.includes(diagramKey(diagram.id)));
  const stored = state.topics[topicId]?.tabOrder ?? [];
  const [moved, setMoved] = useState<string[]>();
  useEffect(() => setMoved(undefined), [stored.join('\n')]);
  const order = moved ?? stored;
  const rank = (key: string) => (order.includes(key) ? order.indexOf(key) : order.length);
  const items = [
    ...shown.map((tab) => ({ key: lineage(tab.chatId), tab, diagram: undefined })),
    ...shownDiagrams.map((diagram) => ({ key: diagramKey(diagram.id), tab: undefined, diagram })),
  ].sort((a, b) => rank(a.key) - rank(b.key));
  const keys = items.map((item) => item.key);
  const reorder = (next: string[]) => {
    const all = [...next, ...order.filter((key) => !next.includes(key))];
    setMoved(all);
    setError(undefined);
    client.setTabOrder(topicId, all).catch((e: unknown) => {
      setMoved(undefined);
      setError(errorText(e));
    });
  };
  const move = (key: string, to: string, after: boolean) => {
    if (key === to) return;
    const rest = keys.filter((k) => k !== key);
    rest.splice(rest.indexOf(to) + (after ? 1 : 0), 0, key);
    reorder(rest);
  };
  const [dragging, setDragging] = useState<string>();
  const [marker, setMarker] = useState<{ key: string; after: boolean }>();
  const endDrag = () => {
    setDragging(undefined);
    setMarker(undefined);
  };
  const drag = (key: string, link: [type: string, id: string]) =>
    phone
      ? {}
      : {
          draggable: true,
          onDragStart: (e: DragEvent<HTMLDivElement>) => {
            e.dataTransfer.setData('application/x-hos-tab', key);
            e.dataTransfer.setData(...link);
            e.dataTransfer.effectAllowed = 'linkMove';
            setDragging(key);
          },
          onDragOver: (e: DragEvent<HTMLDivElement>) => {
            if (!dragging) return;
            e.preventDefault();
            const box = e.currentTarget.getBoundingClientRect();
            const after = e.clientX > box.left + box.width / 2;
            if (marker?.key !== key || marker.after !== after) setMarker({ key, after });
          },
          onDrop: (e: DragEvent<HTMLDivElement>) => {
            if (!dragging) return;
            e.preventDefault();
            const box = e.currentTarget.getBoundingClientRect();
            move(dragging, key, e.clientX > box.left + box.width / 2);
            endDrag();
          },
          onDragEnd: endDrag,
        };
  const dropClass = (key: string) => (marker?.key === key && dragging !== key ? (marker.after ? ' drop-after' : ' drop-before') : '');
  const closing = useRef(new Set<string>());
  useEffect(() => closing.current.clear(), [closed.join('\n')]);
  const shut = (drop: string[], current: boolean) => {
    for (const key of drop) closing.current.add(key);
    setClosed([...closed, ...drop]);
    if (!current) return;
    const rest = items.filter((item) => !closing.current.has(item.key));
    const chat = rest.find((item) => item.tab)?.tab;
    const diagram = rest.find((item) => item.diagram)?.diagram;
    location.hash = chat ? topicHref(topicId, chat.chatId) : diagram ? diagramHref(topicId, diagram.id) : newChatHref(topicId);
  };
  const close = (tab: TopicTab) => shut([lineage(tab.chatId)], tab.chatId === selected);
  const closeDiagram = (diagram: DiagramInfo) => shut([diagramKey(diagram.id)], diagram.id === diagramId);
  const closeChats = (keep?: TopicTab) => {
    const drop = items.filter((item) => item.tab && item.tab.chatId !== keep?.chatId);
    shut(
      drop.map((item) => item.key),
      drop.some((item) => item.tab!.chatId === selected),
    );
  };
  const tabMenuItems = (tab: TopicTab): MenuItem[] => [
    { label: 'Link chat…', onSelect: () => setLinking({ kind: 'chat', chatId: tab.chatId }) },
    { label: 'Attach diagram…', onSelect: () => setLinking({ kind: 'diagram', chatId: tab.chatId }) },
    'separator',
    { label: 'Close others', onSelect: () => closeChats(tab) },
    { label: 'Close all', onSelect: () => closeChats() },
  ];
  const addDiagram = () => {
    setError(undefined);
    client.createDiagram(topicId).then(
      (made) => (location.hash = diagramHref(topicId, made.id)),
      (e: unknown) => setError(errorText(e)),
    );
  };
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    if (e.altKey && e.shiftKey) {
      const key = (document.activeElement?.closest('[data-tab-key]') as HTMLElement | null)?.dataset.tabKey;
      const to = key ? keys[keys.indexOf(key) + (e.key === 'ArrowRight' ? 1 : -1)] : undefined;
      if (key && to) {
        move(key, to, e.key === 'ArrowRight');
        const nav = e.currentTarget;
        requestAnimationFrame(() => nav.querySelector<HTMLElement>(`[data-tab-key="${CSS.escape(key)}"] [role="tab"]`)?.focus());
      }
      e.preventDefault();
      return;
    }
    const links = [...e.currentTarget.querySelectorAll<HTMLAnchorElement>('[role="tab"]')];
    const i = links.indexOf(document.activeElement as HTMLAnchorElement);
    const next = links[(i + (e.key === 'ArrowRight' ? 1 : links.length - 1)) % links.length];
    next?.focus();
    next?.click();
    e.preventDefault();
  };
  return (
    <div className="chat-tabs">
      <nav className="ctabs" role="tablist" aria-label="Chats in this topic" onKeyDown={onKey}>
        {items.map(({ key, tab, diagram }) => {
          if (tab) {
            const title = tab.title;
            const tint = profileStyle(colors[state.chats[tab.chatId]?.profile ?? 'generic']);
            return (
              <div
                key={key}
                data-tab-key={key}
                className={`ctab${tint.className}${dropClass(key)}`}
                style={tint.style}
                aria-current={tab.chatId === selected ? 'page' : undefined}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setTabMenu({ tab, x: e.clientX, y: e.clientY });
                }}
                {...drag(key, [DRAG_CHAT, key])}
              >
                <a role="tab" href={topicHref(topicId, tab.chatId)} aria-selected={tab.chatId === selected} tabIndex={tab.chatId === selected ? 0 : -1} title={title}>
                  <SignMark sign={tab.sign} />
                  {tab.agent && <AgentMark />}
                  <span className="ctab-title">
                    <NameText text={title} naming={tab.naming} />
                  </span>
                  {state.chats[tab.chatId]?.profile && state.chats[tab.chatId]!.profile !== 'generic' && <span className="ctab-kind">{state.chats[tab.chatId]!.profile}</span>}
                  {diagrams.length > 0 && <span className="ctab-kind">chat</span>}
                  {tab.computer && (
                    <span className="ctab-kind" title={`Runs on ${tab.computer}`}>
                      {label(tab.computer)}
                    </span>
                  )}
                </a>
                <button type="button" className="ctab-x" aria-label={`Close ${title}`} title="Close this tab; the chat keeps its history" onClick={() => close(tab)}>
                  <Icon id="i-x" />
                </button>
              </div>
            );
          }
          return (
            <div key={key} data-tab-key={key} className={`ctab${dropClass(key)}`} aria-current={diagram.id === diagramId ? 'page' : undefined} {...drag(key, [DRAG_DIAGRAM, diagram.id])}>
              {renaming === diagram.id ? (
                <input
                  className="ctab-rename"
                  aria-label="Diagram title"
                  defaultValue={diagram.title}
                  autoFocus
                  onFocus={(e) => e.currentTarget.select()}
                  onBlur={(e) => rename(diagram, e.currentTarget.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Escape') e.currentTarget.value = diagram.title;
                    if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur();
                  }}
                />
              ) : (
                <a
                  role="tab"
                  href={diagramHref(topicId, diagram.id)}
                  aria-selected={diagram.id === diagramId}
                  tabIndex={diagram.id === diagramId ? 0 : -1}
                  title={`${diagram.title}\nDouble-click to rename`}
                  onDoubleClick={(e) => {
                    e.preventDefault();
                    setRenaming(diagram.id);
                  }}
                >
                  <Icon id="i-diagram" />
                  <span className="ctab-title">{diagram.title}</span>
                  <span className="ctab-kind">diagram</span>
                </a>
              )}
              <button
                type="button"
                className="ctab-x"
                aria-label={`Close ${diagram.title}`}
                title="Close this tab; the diagram stays in history"
                onClick={() => closeDiagram(diagram)}
              >
                <Icon id="i-x" />
              </button>
            </div>
          );
        })}
        {drafting && (
          <div className="ctab" aria-current="page">
            <a role="tab" href={newChatHref(topicId)} aria-selected={true} tabIndex={0} title="New chat">
              <span className="ctab-title">New chat</span>
            </a>
          </div>
        )}
      </nav>
      <AddButton topicId={topicId} onDiagram={addDiagram} />
      {error && (
        <span className="error-text" role="alert">
          {error}
        </span>
      )}
      {tabMenu && (
        <Menu
          label={`Actions for ${tabMenu.tab.title}`}
          items={tabMenuItems(tabMenu.tab)}
          at={{ x: tabMenu.x, y: tabMenu.y }}
          onClose={(refocus) => {
            setTabMenu(undefined);
            if (refocus) document.querySelector<HTMLElement>(`[data-tab-key="${CSS.escape(lineage(tabMenu.tab.chatId))}"] [role="tab"]`)?.focus();
          }}
        />
      )}
      {linking && <LinkPicker kind={linking.kind} state={state} chatId={linking.chatId} onClose={() => setLinking(undefined)} />}
    </div>
  );
}

function AddButton({ topicId, onDiagram }: { topicId: string; onDiagram: () => void }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <div
      className="ctab-add"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={(e) => e.target.matches(':focus-visible') && setOpen(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setOpen(false)}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || !open) return;
        e.stopPropagation();
        setOpen(false);
        button.current?.focus();
      }}
    >
      <IconButton
        ref={button}
        className="ctab-new"
        icon="i-plus"
        label="New chat in this topic"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (location.hash = newChatHref(topicId))}
      />
      {open && (
        <div className="menu" role="menu" aria-label="Add to this topic">
          <button
            type="button"
            role="menuitem"
            title="New diagram in this topic"
            onClick={() => {
              setOpen(false);
              onDiagram();
            }}
          >
            <Icon id="i-diagram" />
            New diagram
          </button>
        </div>
      )}
    </div>
  );
}

function killable(chat: Chat | undefined): string {
  return chat?.parentId ? 'This chat and every chat it started' : 'This chat and every helper it started';
}

function ConfirmDialog(props: { title: string; detail: string; act: string; danger?: boolean; onClose: () => void; onConfirm: () => Promise<unknown>; after?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    cancel.current?.focus();
    return () => before?.focus?.();
  }, []);
  const confirm = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await props.onConfirm();
      props.onClose();
      props.after?.();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };
  return (
    <Wrap onClose={props.onClose} role="alertdialog" label={props.title}>
      <h2>{props.title}</h2>
      <p>{props.detail}</p>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-acts">
        <button ref={cancel} type="button" className="btn" onClick={props.onClose}>
          Cancel
        </button>
        <button type="button" className={props.danger ? 'btn danger' : 'btn go'} disabled={busy} onClick={() => void confirm()}>
          {props.act}
        </button>
      </div>
    </Wrap>
  );
}

function RenameDialog({ title, onClose, onRename }: { title: string; onClose: () => void; onRename: (title: string) => Promise<unknown> }) {
  const [text, setText] = useState(title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    box.current?.select();
    return () => before?.focus?.();
  }, []);
  const save = async () => {
    const next = text.trim();
    if (!next || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await onRename(next);
      onClose();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };
  return (
    <Wrap onClose={onClose} role="dialog" label="Rename topic">
      <h2>Rename topic</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="sr" htmlFor="topic-rename">
          Topic title
        </label>
        <input id="topic-rename" ref={box} className="topic-rename" value={text} onChange={(e) => setText(e.target.value)} />
        <p className="muted">Its folders keep their old name, so status and attachments stay put.</p>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-acts">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn go" disabled={busy || !text.trim()}>
            Rename
          </button>
        </div>
      </form>
    </Wrap>
  );
}

export function Wrap({ onClose, role, label, className, children }: { onClose: () => void; role: 'dialog' | 'alertdialog'; label: string; className?: string; children: ReactNode }) {
  return (
    <div className="dialog-wrap" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className={className ? `dialog ${className}` : 'dialog'}
        role={role}
        aria-modal="true"
        aria-label={label}
        onKeyDown={(e) => {
          trapTab(e);
          if (e.key !== 'Escape') return;
          e.stopPropagation();
          onClose();
        }}
      >
        {children}
      </div>
    </div>
  );
}
