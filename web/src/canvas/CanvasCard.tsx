import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { stepNodes, type Flow } from '../../../src/canvas/kinds/flow.js';
import { answerable, barLabel, hasBar, pendingAnswers, submitText } from '../../../src/canvas/spec.js';
import type { Block, Canvas, Draft, View } from '../../../src/canvas/types.js';
import { client, errorText } from '../lib.js';
import { useOwner } from '../topic/catalog.js';
import '../styles/canvas.css';
import { VIEWS } from './registry.js';

const SAVE_MS = 600;

export interface CanvasCardProps {
  topicId: string;
  canvasRef: string;
  seq: number;
}

export function CanvasStub({ text }: { text: string }) {
  return <p className="cv-stub">{text}</p>;
}

// Lazy mount: a thread with many canvases only renders the ones near the viewport; once seen, a card stays mounted.
export function CanvasCard(props: CanvasCardProps) {
  const [near, setNear] = useState(false);
  const holder = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = holder.current;
    if (near || !el) return;
    if (typeof IntersectionObserver === 'undefined') return setNear(true);
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setNear(true), { rootMargin: '800px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [near]);
  if (!near)
    return (
      <div ref={holder} className="cv-wait" style={{ minHeight: 320 }} data-canvas={props.canvasRef}>
        Canvas {props.canvasRef}
      </div>
    );
  return <LiveCanvas {...props} />;
}

function LiveCanvas({ topicId, canvasRef, seq }: CanvasCardProps) {
  const [canvas, setCanvas] = useState<Canvas>();
  const [draft, setDraft] = useState<Draft>({ a: {}, view: {} });
  const [error, setError] = useState<string>();
  const [pointed, setPointed] = useState<string | null>(null);
  const [peek, setPeek] = useState(false);
  const [sending, setSending] = useState(false);
  const [asked, setAsked] = useState(false);
  const [fresh, setFresh] = useState(false);
  const owner = useOwner()?.name ?? 'The user';
  const loaded = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const root = useRef<HTMLElement>(null);

  useEffect(() => {
    let live = true;
    client.canvas(topicId, canvasRef).then(
      (next) => {
        if (!live) return;
        setFresh(loaded.current !== null && loaded.current !== next.version);
        if (loaded.current === null) setDraft(next.draft);
        loaded.current = next.version;
        setCanvas(next);
        setAsked(false);
      },
      (e) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [topicId, canvasRef, seq]);

  useEffect(() => () => clearTimeout(timer.current), []);

  const save = useCallback(
    (next: Draft) => {
      setDraft(next);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void client.saveCanvasDraft(topicId, canvasRef, next).catch(() => {}), SAVE_MS);
    },
    [topicId, canvasRef],
  );

  const point = useCallback(
    (node: string) => {
      if (!canvas) return;
      const flow = canvas.spec.blocks.find((b) => b.kind === 'flow' && (b as Flow).nodes.some((n) => n.id === node)) as Flow | undefined;
      if (!flow) return;
      const s = (flow.steps ?? []).findIndex((step) => stepNodes(step).includes(node));
      setPointed(node);
      save({ ...draft, view: { ...draft.view, [flow.id]: { ...draft.view[flow.id], ...(s >= 0 ? { s } : {}), o: node } } });
      requestAnimationFrame(() => {
        const el = root.current?.querySelector<HTMLElement>(`[data-block="${flow.id}"]`);
        if (!el) return;
        el.closest('details')?.setAttribute('open', '');
        el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
        el.classList.remove('flash');
        void el.offsetWidth;
        el.classList.add('flash');
      });
    },
    [canvas, draft, save],
  );

  const pending = useMemo(() => (canvas ? pendingAnswers(canvas, draft.a) : {}), [canvas, draft]);

  if (error && !canvas) return <p className="cv-stub">Canvas {canvasRef}: {error}</p>;
  if (!canvas) return <div className="cv-wait">Canvas {canvasRef}…</div>;
  if (canvas.state === 'closed')
    return (
      <p className="cv-stub">
        {canvasRef} · {canvas.spec.title} · closed to keep the thread light{' '}
        <button type="button" title="Reopen this canvas" onClick={() => void client.showCanvas(topicId, canvasRef).catch((e) => setError(errorText(e)))}>
          Show
        </button>
      </p>
    );

  const questions = canvas.spec.blocks.filter(answerable);
  const open = questions.filter((b) => canvas.open.includes(b.id));
  const ready = open.length > 0 && open.every((b) => b.id in pending);
  const bar = hasBar(canvas.spec);
  const answered = open.filter((b) => b.id in pending).length;
  const status = !open.length
    ? canvas.submits.length
      ? 'Sent to the chat · locked until the agent updates it'
      : 'Nothing to answer'
    : canvas.submits.length
      ? `${open.map((b) => b.id).join(', ')} open again for a retry`
      : `${answered} of ${open.length} answered · saved as you go`;

  const send = async () => {
    setSending(true);
    setError(undefined);
    try {
      clearTimeout(timer.current);
      await client.submitCanvas(topicId, canvasRef, draft);
      setPeek(false);
      setCanvas(await client.canvas(topicId, canvasRef));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSending(false);
    }
  };

  const renderBlock = (block: Block) => {
    const view = VIEWS[block.kind];
    if (!view) return null;
    const qi = questions.indexOf(block);
    return (
      <div key={block.id} className={`cv-blk${qi >= 0 ? ' cv-q' : ''}`} data-block={block.id}>
        <view.Render
          block={block}
          layout={canvas.layout[block.id]}
          answer={draft.a[block.id]}
          setAnswer={(value: unknown) => save({ ...draft, a: { ...draft.a, [block.id]: value } })}
          locked={answerable(block) && !canvas.open.includes(block.id)}
          fb={canvas.fb[block.id]}
          view={draft.view[block.id] ?? {}}
          setView={(v: View) => {
            if (block.kind === 'flow') setPointed(null);
            save({ ...draft, view: { ...draft.view, [block.id]: v } });
          }}
          point={point}
          pointed={pointed}
          q={qi >= 0 && questions.length > 1 ? { k: qi + 1, n: questions.length } : null}
          canvas={canvas}
          request={() => setAsked(true)}
        />
      </div>
    );
  };

  const main = canvas.spec.blocks.filter((b) => !b.fold);
  const deep = canvas.spec.blocks.filter((b) => b.fold);
  const deepLabels = [...new Set(deep.map((b) => VIEWS[b.kind]?.label ?? b.kind))];
  const kind = canvas.spec.blocks.length === 1 && canvas.spec.blocks[0]!.kind === 'flow' ? ' · diagram' : '';
  return (
    <section ref={root} className={`cv${fresh ? ' fresh' : ''}`} aria-label={`Canvas ${canvasRef}, ${canvas.spec.title}`} data-canvas={canvasRef}>
      <header className="cv-head">
        <span className="cv-kick">
          Canvas · {canvasRef}
          {kind}
        </span>
        <span className="cv-ver">
          v{canvas.version}
          {Object.keys(canvas.fb).length ? ' · marked by the agent' : ''}
        </span>
        <h2>{canvas.spec.title}</h2>
      </header>
      <div className="cv-blocks">
        {main.map(renderBlock)}
        {deep.length > 0 && (
          <details className="cv-deeper">
            <summary>Go deeper · {deepLabels.join(', ')}</summary>
            <div className="cv-blocks">{deep.map(renderBlock)}</div>
          </details>
        )}
      </div>
      {bar && (
        <div className="cv-bar" role="group" aria-label="hos send bar">
          <span className="who">HOS</span>
          <span className="grow">{status}</span>
          {open.length > 0 && (
            <button type="button" className="peek" aria-expanded={peek} title={peek ? 'Hide the preview' : 'Preview what this canvas will send'} onClick={() => setPeek(!peek)}>
              {peek ? 'Hide' : 'What gets sent'}
            </button>
          )}
          <button type="button" className={`send${asked && ready ? ' ask' : ''}`} disabled={!ready || sending} onClick={() => void send()}>
            {!open.length && canvas.submits.length ? 'Sent' : asked && ready ? 'Confirm: send' : barLabel(canvas)}
          </button>
          {peek && open.length > 0 && <pre>{submitText(canvas, pending, draft, owner)}</pre>}
          {error && (
            <span className="error-text" role="alert">
              {error}
            </span>
          )}
        </div>
      )}
    </section>
  );
}

export function CanvasSent({ text, at }: { text: string; at: number }) {
  const ref = /^\[hos\] .+? (?:submitted|re-answered) (C\d+)/.exec(text)?.[1] ?? 'canvas';
  const answers = text.split('\n').filter((l) => l.startsWith('- ')).length;
  return (
    <details className="cv-sent">
      <summary>
        <span className="pill">canvas</span>
        {text.includes('re-answered') ? 'Re-answered' : 'Submitted'} {ref} · {answers} answer{answers === 1 ? '' : 's'}
        <span className="when">{new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}</span>
      </summary>
      <pre>{text}</pre>
    </details>
  );
}
