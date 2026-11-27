import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  Excalidraw,
  exportToBlob,
  getCommonBounds,
  MainMenu,
  newElementWith,
  reconcileElements,
  restoreElements,
  sceneCoordsToViewportCoords,
} from '@excalidraw/excalidraw';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { AppState, BinaryFileData, BinaryFiles, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import '@excalidraw/excalidraw/index.css';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { lightTheme } from '../diagrams/data.js';
import { client } from '../lib.js';
import { Icon } from '../shell/icons.js';

(window as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = '/excalidraw/';

type Message =
  | { type: 'init' | 'update'; elements: ExcalidrawElement[]; files?: BinaryFiles; agent?: boolean }
  | { type: 'export'; reqId: string }
  | { type: 'mermaid'; reqId: string; mermaid: string }
  | { type: 'error'; message: string };

interface Bar {
  ids: string[];
  x: number;
  y: number;
  key: string;
}

const SEND_EVERY_MS = 80;
const POINTER_MS = 2000;
const BAR_MIN_TOP = 64;
const FIT = { fitToViewport: true, viewportZoomFactor: 0.8 } as const;
const CLAUDE = { username: 'Claude', color: { background: '#8e6cef', stroke: '#8e6cef' } };

export default function DiagramCanvas({
  diagramId,
  hand = false,
  topRight,
}: {
  diagramId: string;
  hand?: boolean;
  topRight?: ReactNode;
}) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [bar, setBar] = useState<Bar | null>(null);
  const [styles, setStyles] = useState(false);
  const [live, setLive] = useState(false);
  const socket = useRef<WebSocket | null>(null);
  const sent = useRef(new Map<string, number>());
  const sentFiles = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pointer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!api) return;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      const ws = client.diagramSocket(diagramId);
      socket.current = ws;
      ws.onopen = () => setLive(true);
      ws.onclose = () => {
        setLive(false);
        if (!closed) retry = setTimeout(connect, 1000);
      };
      ws.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as Message;
        if (message.type === 'export') return void exportPng(api).then((png) => ws.send(JSON.stringify({ type: 'export', reqId: message.reqId, png })));
        if (message.type === 'mermaid') {
          return void importMermaid(api, message.mermaid).then(
            (made) => ws.send(JSON.stringify({ type: 'mermaid', reqId: message.reqId, ...made })),
            (error: Error) => ws.send(JSON.stringify({ type: 'mermaid', reqId: message.reqId, error: error.message })),
          );
        }
        if (message.type === 'error') return void api.setToast({ message: message.message, closable: true, duration: 8000 });
        const files = Object.values(message.files ?? {});
        for (const file of files) sentFiles.current.add(file.id);
        if (files.length) api.addFiles(files);
        const local = api.getSceneElementsIncludingDeleted();
        const incoming = new Set(message.elements.map((element) => element.id));
        const context = local.filter((element: ExcalidrawElement) => !incoming.has(element.id));
        const restored: ExcalidrawElement[] = restoreElements([...context, ...message.elements], local, { refreshDimensions: true, repairBindings: true }).filter(
          (element: ExcalidrawElement) => incoming.has(element.id),
        );
        for (const element of restored) sent.current.set(element.id, element.version);
        const elements = reconcileElements(local, restored as never, api.getAppState());
        api.updateScene({ elements, captureUpdate: message.agent ? CaptureUpdateAction.IMMEDIATELY : CaptureUpdateAction.NEVER });
        if (message.type === 'update' && message.agent) showClaude(restored.filter((element) => !element.isDeleted));
        if (message.type === 'init' && message.elements.length) api.scrollToContent(undefined, FIT);
      };
    };
    const showClaude = (changed: ExcalidrawElement[]) => {
      if (!changed.length) return;
      const [left, top, right, bottom] = getCommonBounds(changed);
      const at = { x: (left + right) / 2, y: (top + bottom) / 2, tool: 'pointer' as const };
      api.updateScene({ collaborators: new Map([['claude', { ...CLAUDE, pointer: at }]]) as AppState['collaborators'] });
      clearTimeout(pointer.current);
      pointer.current = setTimeout(() => api.updateScene({ collaborators: new Map() as AppState['collaborators'] }), POINTER_MS);
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      clearTimeout(timer.current);
      clearTimeout(pointer.current);
      socket.current?.close();
    };
  }, [api, diagramId]);

  const flush = () => {
    timer.current = undefined;
    const ws = socket.current;
    if (!api || ws?.readyState !== WebSocket.OPEN) return;
    const changed = api.getSceneElementsIncludingDeleted().filter((e: ExcalidrawElement) => (sent.current.get(e.id) ?? -1) < e.version);
    const files = Object.values(api.getFiles() as BinaryFiles).filter((file) => !sentFiles.current.has(file.id));
    if (!changed.length && !files.length) return;
    for (const element of changed) sent.current.set(element.id, element.version);
    for (const file of files) sentFiles.current.add(file.id);
    ws.send(JSON.stringify({ type: 'update', elements: changed, ...(files.length ? { files: Object.fromEntries(files.map((file) => [file.id, file])) } : {}) }));
  };

  const remove = () => {
    if (!api || !bar) return;
    const ids = new Set(bar.ids);
    const gone = (element: ExcalidrawElement) => ids.has(element.id) || ('containerId' in element && !!element.containerId && ids.has(element.containerId));
    api.updateScene({
      elements: api.getSceneElementsIncludingDeleted().map((element: ExcalidrawElement) => (gone(element) ? newElementWith(element, { isDeleted: true }) : element)),
      appState: { selectedElementIds: {} },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  };

  return (
    <div className="dia-excal" data-styles={styles ? 'open' : undefined} data-live={live}>
      <Excalidraw
        excalidrawAPI={setApi}
        initialData={{
          appState: {
            currentItemStrokeWidth: 0.33,
            ...(hand ? { activeTool: { type: 'hand', customType: null, lastActiveTool: null, locked: false, fromSelection: false } } : {}),
          },
        }}
        theme={lightTheme() ? 'light' : 'dark'}
        onChange={(elements: readonly ExcalidrawElement[], appState: AppState) => {
          timer.current ??= setTimeout(flush, SEND_EVERY_MS);
          const next = selectionBar(elements, appState);
          setBar((shown) => (shown?.key === next?.key ? shown : next));
        }}
        UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false } }}
        renderTopRightUI={(mobile: boolean) => (
          <div className="dia-top-right">
            {!live && (
              <span className="dia-conn" role="status" title="Connecting to the diagram">
                connecting…
              </span>
            )}
            {!mobile && (
              <button type="button" className={`sidebar-trigger${styles ? ' active' : ''}`} aria-pressed={styles} title="Show stroke, colour and layer settings" onClick={() => setStyles((open) => !open)}>
                <Icon id="i-palette" />
                Style
              </button>
            )}
            {topRight}
          </div>
        )}
      >
        <MainMenu>
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.SearchMenu />
          <MainMenu.DefaultItems.Help />
          <MainMenu.DefaultItems.ClearCanvas />
        </MainMenu>
      </Excalidraw>
      {bar && (
        <div className="dia-selbar" role="toolbar" aria-label="Selected shapes" style={{ left: bar.x, top: bar.y }}>
          <button type="button" className="btn" aria-label="Delete the selected shapes" title="Delete selected shapes" onClick={remove}>
            🗑
          </button>
        </div>
      )}
    </div>
  );
}

function selectionBar(elements: readonly ExcalidrawElement[], appState: AppState): Bar | null {
  if (appState.newElement || appState.resizingElement || appState.editingTextElement || appState.selectedElementsAreBeingDragged) return null;
  const picked = elements.filter((element) => appState.selectedElementIds[element.id] && !element.isDeleted);
  const shapes = picked.filter((element) => !('containerId' in element && element.containerId && appState.selectedElementIds[element.containerId]));
  if (!shapes.length) return null;
  const [left, top, , bottom] = getCommonBounds(picked);
  const at = sceneCoordsToViewportCoords({ sceneX: left, sceneY: top }, appState);
  const below = sceneCoordsToViewportCoords({ sceneX: left, sceneY: bottom }, appState);
  const x = Math.max(8, Math.min(Math.round(at.x - appState.offsetLeft), appState.width - 340));
  const above = Math.round(at.y - appState.offsetTop - 48);
  const y = above >= BAR_MIN_TOP ? above : Math.min(Math.round(below.y - appState.offsetTop + 10), appState.height - 120);
  const ids = shapes.map((element) => element.id);
  return { ids, x, y, key: `${ids.join(',')}|${x}|${y}` };
}

async function importMermaid(api: ExcalidrawImperativeAPI, definition: string): Promise<{ elements: ExcalidrawElement[]; files: BinaryFiles }> {
  const { parseMermaidToExcalidraw } = await import('@excalidraw/mermaid-to-excalidraw');
  const parsed = await parseMermaidToExcalidraw(definition);
  const made: ExcalidrawElement[] = convertToExcalidrawElements(parsed.elements as never, { regenerateIds: true });
  if (!made.length) return { elements: [], files: {} };
  const live = api.getSceneElements();
  const [, top, right] = live.length ? getCommonBounds(live) : [0, 0, -100];
  const [left, y] = getCommonBounds(made);
  const dx = right + 100 - left;
  const dy = (live.length ? top : 0) - y;
  return { elements: made.map((element) => ({ ...element, x: element.x + dx, y: element.y + dy })), files: (parsed.files ?? {}) as Record<string, BinaryFileData> };
}

function exportState(api: ExcalidrawImperativeAPI) {
  return { ...api.getAppState(), exportBackground: true, exportWithDarkMode: false, viewBackgroundColor: '#ffffff' };
}

function exportBlob(api: ExcalidrawImperativeAPI): Promise<Blob> {
  return exportToBlob({ elements: api.getSceneElements(), appState: exportState(api), files: api.getFiles(), mimeType: 'image/png', exportPadding: 24 });
}

async function exportPng(api: ExcalidrawImperativeAPI): Promise<string> {
  const blob = await exportBlob(api);
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}
