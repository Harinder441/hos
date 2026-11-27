import { useEffect, useRef, useState } from 'react';
import { MAX_PAGE_STATE, type Html as Block } from '../../../../src/canvas/kinds/html.js';
import { client, errorText } from '../../lib.js';
import type { BlockProps, BlockView } from '../types.js';

function HtmlBlock({ block, answer, setAnswer, locked, canvas, request }: BlockProps<Block>) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState<string>();
  const [height, setHeight] = useState(block.height ?? 320);
  const latest = useRef({ answer, setAnswer, locked, request });
  latest.current = { answer, setAnswer, locked, request };

  useEffect(() => {
    let live = true;
    client.canvasPage(canvas.topicId, canvas.ref, block.id).then(
      (r) => live && setUrl(r.url),
      (e) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [canvas.topicId, canvas.ref, canvas.version, block.id, block.src]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const win = frame.current?.contentWindow;
      const data = e.data as { hos?: string; type?: string; patch?: unknown; height?: unknown } | null;
      if (!win || e.source !== win || data?.hos !== 'canvas') return;
      if (data.type === 'size' && typeof data.height === 'number') setHeight(Math.min(1200, Math.max(160, Math.ceil(data.height))));
      if (data.type === 'request') latest.current.request();
      if (data.type === 'state' && data.patch && typeof data.patch === 'object' && !Array.isArray(data.patch) && !latest.current.locked) {
        const before = latest.current.answer && typeof latest.current.answer === 'object' ? (latest.current.answer as Record<string, unknown>) : {};
        const next = { ...before, ...(data.patch as Record<string, unknown>) };
        if (JSON.stringify(next).length > MAX_PAGE_STATE) return setError(`the page's state is over ${MAX_PAGE_STATE / 1024} KB, so hos kept the last one`);
        latest.current.setAnswer(next);
      }
    };
    addEventListener('message', onMessage);
    return () => removeEventListener('message', onMessage);
  }, []);

  const init = () => frame.current?.contentWindow?.postMessage({ hos: 'canvas', type: 'init', state: latest.current.answer ?? {} }, '*');
  const state = answer && typeof answer === 'object' ? Object.keys(answer).length : 0;
  return (
    <>
      <span className="cv-kick">Page · sandboxed · it can report, only the hos bar sends</span>
      {url ? (
        <iframe ref={frame} className="cv-html" title={`Agent-written page ${block.id}`} sandbox="allow-scripts" src={url} style={{ height }} onLoad={init} />
      ) : (
        !error && <div className="cv-hint">Opening the page…</div>
      )}
      {state > 0 && <div className="cv-hint">The page reported {state} value{state === 1 ? '' : 's'}; the hos bar sends them labelled as the page's.</div>}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

export const html: BlockView = { label: 'page', Render: HtmlBlock };
