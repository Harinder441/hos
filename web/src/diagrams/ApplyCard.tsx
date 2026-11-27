import { useEffect, useState } from 'react';
import type { DiagramInfo } from '../../../src/api/types.js';
import { client, errorText } from '../lib.js';
import { diagramHref } from '../shell/routes.js';
import '../styles/diagram.css';
import { Preview } from './Preview.js';

export function ApplyCard({ diagramId, applyId, summary }: { diagramId: string; applyId: string; summary: string }) {
  const [info, setInfo] = useState<DiagramInfo>();
  const [undo, setUndo] = useState<{ busy?: boolean; done?: boolean; error?: string }>({});
  useEffect(() => {
    client.diagram(diagramId).then(setInfo, () => {});
  }, [diagramId]);
  const revert = async () => {
    setUndo({ busy: true });
    try {
      await client.undoDiagramApply(diagramId, applyId);
      setUndo({ done: true });
    } catch (e) {
      setUndo({ error: errorText(e) });
    }
  };
  const title = info?.title ?? diagramId;
  return (
    <div className="dcard" role="group" aria-label={`Diagram change: ${title}`}>
      {info ? <Preview diagram={info} className="dcard-mini" /> : <span className="dcard-mini" />}
      <span className="dcard-text">
        <a href={info ? diagramHref(info.topic, info.id) : undefined}>{title}</a>
        <span>
          {summary} · apply <code>{applyId}</code>
        </span>
        {undo.error && (
          <span className="error-text" role="alert">
            {undo.error}
          </span>
        )}
      </span>
      <button type="button" className="btn" disabled={undo.busy || undo.done} onClick={() => void revert()}>
        {undo.done ? 'Undone' : 'Undo'}
      </button>
    </div>
  );
}
