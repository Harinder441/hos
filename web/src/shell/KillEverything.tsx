import { useEffect, useRef, useState } from 'react';
import { killEverything } from '../model/index.js';
import { errorText, trapTab } from '../lib.js';

export function KillDialog({ onClose }: { onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    cancel.current?.focus();
    return () => before?.focus?.();
  }, []);
  const kill = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await killEverything();
      onClose();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };
  return (
    <div className="dialog-wrap" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="kill-title"
        aria-describedby="kill-detail"
        onKeyDown={(e) => {
          trapTab(e);
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <h2 id="kill-title">Stop all chats?</h2>
        <p id="kill-detail">Every chat stops now, and no new chat starts until you press “Let chats run again” at the foot of the sidebar.</p>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-acts">
          <button ref={cancel} type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn danger" disabled={busy} onClick={kill}>
            Stop all chats
          </button>
        </div>
      </div>
    </div>
  );
}
