import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import type { DiagramInfo, DiagramVersion } from '../../../src/api/types.js';
import { useDiagrams, useSettledSeq, whoName } from '../diagrams/data.js';
import { client, errorText, PHONE_QUERY, useMediaQuery } from '../lib.js';
import { markSeen, topicRow, topicTabs } from '../model/index.js';
import { Icon, IconButton } from '../shell/icons.js';
import { useShell } from '../shell/Layout.js';
import { useMenu } from '../shell/Menu.js';
import { diagramHref } from '../shell/routes.js';
import type { State } from '../state.js';
import '../styles/topic.css';
import '../styles/diagram.css';
import { ChatTabs, diagramKey, TopicHeader } from './TopicHeader.js';
import { When } from './when.js';

const DiagramCanvas = lazy(() => import('./DiagramCanvas.js'));

function useDiagramInfo(diagramId: string, changeSeq: number) {
  const seq = useSettledSeq(changeSeq);
  const [info, setInfo] = useState<DiagramInfo>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    client.diagram(diagramId).then(setInfo, (e: unknown) => setError(errorText(e)));
  }, [diagramId, seq]);
  return { info, setInfo, error };
}

function useFullscreen() {
  const [full, setFull] = useState(false);
  useEffect(() => {
    const sync = () => setFull(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);
  const toggle = (from: Element) => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void from.closest('.diagram-split')?.requestFullscreen();
  };
  return { full, toggle };
}

function DiagramTitle({ info, onRenamed }: { info: DiagramInfo | undefined; onRenamed: (info: DiagramInfo) => void }) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string>();
  const title = info?.title ?? 'Diagram';
  const save = (next: string) => {
    setEditing(false);
    if (!info || !next.trim() || next.trim() === info.title) return;
    setError(undefined);
    client.renameDiagram(info.id, next).then(onRenamed, (e: unknown) => setError(errorText(e)));
  };
  return (
    <>
      {editing ? (
        <input
          className="cv-rename"
          aria-label="Diagram title"
          defaultValue={title}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => save(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save(e.currentTarget.value);
            if (e.key === 'Escape') setEditing(false);
          }}
        />
      ) : (
        <button type="button" className="cv-name" title="Rename this diagram" disabled={!info} onClick={() => setEditing(true)}>
          {title}
        </button>
      )}
      {error && (
        <span className="error-text" role="alert">
          {error}
        </span>
      )}
    </>
  );
}

function CanvasPane({ diagramId, hand, state }: { diagramId: string; hand: boolean; state: State }) {
  const fullscreen = useFullscreen();
  const tools = (
    <>
      <VersionsButton diagramId={diagramId} state={state} />
      {document.fullscreenEnabled && (
        <button
          type="button"
          className="icon-btn"
          aria-label={fullscreen.full ? 'Exit full screen' : 'Full screen'}
          title={fullscreen.full ? 'Exit full screen' : 'Full screen'}
          onClick={(event) => fullscreen.toggle(event.currentTarget)}
        >
          <Icon id={fullscreen.full ? 'i-unfull' : 'i-full'} />
        </button>
      )}
    </>
  );
  return (
    <section className="diagram-canvas" aria-label="Diagram canvas">
      <div className="cv-body">
        <Suspense fallback={<p className="page-empty muted">Loading the canvas…</p>}>
          <DiagramCanvas diagramId={diagramId} hand={hand} topRight={tools} />
        </Suspense>
      </div>
    </section>
  );
}

function DiagramHead({ title }: { title: ReactNode }) {
  const shell = useShell();
  return (
    <header className="topbar dia-head">
      <IconButton className="icon-btn menu-btn" icon="i-menu" label="Open navigation" tip="Open the sidebar" onClick={shell.openSide} />
      <Icon id="i-diagram" className="dia-head-mark" />
      <h1>{title}</h1>
    </header>
  );
}

function VersionsButton({ diagramId, state }: { diagramId: string; state: State }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => box.current?.contains(e.target as Node) || setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', esc, true);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('keydown', esc, true);
    };
  }, [open]);
  return (
    <div className="dia-versions" ref={box}>
      <button type="button" className="icon-btn" aria-label="Versions" title="Diagram versions; restore an older one" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon id="i-history" />
      </button>
      {open && (
        <div className="dia-versions-pop" role="dialog" aria-label="Versions">
          <Versions diagramId={diagramId} state={state} />
        </div>
      )}
    </div>
  );
}

function Versions({ diagramId, state }: { diagramId: string; state: State }) {
  const seq = useSettledSeq(state.diagramSeq);
  const [versions, setVersions] = useState<DiagramVersion[]>();
  const [error, setError] = useState<string>();
  const [restored, setRestored] = useState<string>();
  useEffect(() => {
    client.diagramVersions(diagramId).then(setVersions, (e: unknown) => setError(errorText(e)));
  }, [diagramId, seq]);
  const restore = async (sha: string) => {
    setError(undefined);
    try {
      await client.restoreDiagram(diagramId, sha);
      setRestored(sha);
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <>
      <h2>Versions</h2>
      {error && <p className="error-text dp-pad">{error}</p>}
      {versions && !versions.length && <p className="muted dp-pad dp-small">No checkpoints yet. The first lands after an agent edit, or 30 s after you stop drawing.</p>}
      <ol className="dp-versions" aria-label="Versions">
        {versions?.map((version) => (
          <li key={version.sha}>
            <span className="dp-v-text">
              <b>{whoName(version.who) ?? 'hos'}</b> · {version.summary}
            </span>
            <span className="dp-v-foot">
              <When at={version.at} className="when" />
              <button type="button" className="btn dp-restore" onClick={() => void restore(version.sha)} aria-label={`Restore ${version.sha.slice(0, 7)}`}>
                {restored === version.sha ? 'Restored' : 'Restore'}
              </button>
            </span>
          </li>
        ))}
      </ol>
      <p className="dp-note">
        Each agent edit is one checkpoint, and so is a pause in your drawing. <b>Restore</b> any row; one Undo on the canvas takes it back.
      </p>
    </>
  );
}

export function DiagramPage({ topicId, diagramId, state }: { topicId: string; diagramId: string; state: State }) {
  const { info, setInfo, error } = useDiagramInfo(diagramId, state.diagramSeq);
  const { diagrams } = useDiagrams(state.diagramSeq);
  const phone = useMediaQuery(PHONE_QUERY);
  const mine = (diagrams?.filter((diagram) => diagram.topic === topicId) ?? (info ? [info] : [])).map((diagram) => (diagram.id === info?.id ? info : diagram));

  const row = topicRow(state, topicId);
  const unseen = row?.unseen ?? false;

  useEffect(() => {
    if (info && info.topic !== topicId) location.replace(diagramHref(info.topic, info.id));
    else localStorage.setItem(`hos.lastChat.${topicId}`, diagramKey(diagramId));
  }, [info?.topic, topicId, diagramId]);

  useEffect(() => {
    const seeIfVisible = () => document.visibilityState === 'visible' && unseen && void markSeen(topicId);
    seeIfVisible();
    document.addEventListener('visibilitychange', seeIfVisible);
    return () => document.removeEventListener('visibilitychange', seeIfVisible);
  }, [topicId, unseen, row?.lastActivityAt]);

  return (
    <>
      {phone ? (
        <DiagramHead title={<DiagramTitle info={info} onRenamed={setInfo} />} />
      ) : (
        <>
          <TopicHeader
            topicId={topicId}
            chatId=""
            state={state}
            diagrams={mine}
            tabs={<ChatTabs key={topicId} topicId={topicId} tabs={topicTabs(state, topicId)} selected={undefined} state={state} diagrams={mine} diagramId={diagramId} onRenamed={setInfo} />}
          />
        </>
      )}
      {error ? (
        <p className="page-empty muted">{error}</p>
      ) : (
        <div className="diagram-split">
          <CanvasPane diagramId={diagramId} hand={phone} state={state} />
        </div>
      )}
    </>
  );
}

export function OpenDiagram({ diagramId }: { diagramId: string }) {
  const [error, setError] = useState<string>();
  useEffect(() => {
    client.diagram(diagramId).then(
      (info) => location.replace(diagramHref(info.topic, info.id)),
      (e: unknown) => setError(errorText(e)),
    );
  }, [diagramId]);
  return <p className="page-empty muted">{error ?? 'Opening the diagram…'}</p>;
}
