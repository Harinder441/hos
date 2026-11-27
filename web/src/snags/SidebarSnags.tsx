import { useEffect, useState } from 'react';
import type { SnagSummary } from '../../../src/snags/types.js';
import { Icon } from '../shell/icons.js';
import { SnagForm } from './SnagForm.js';
import { snags, useSnagsVersion } from './store.js';
import './snags.css';

export function SidebarSnags({ current }: { current: boolean }) {
  const version = useSnagsVersion();
  const [summary, setSummary] = useState<SnagSummary>();
  const [adding, setAdding] = useState(false);
  const [note, setNote] = useState('');
  useEffect(() => {
    let cancelled = false;
    snags.summary().then((s) => cancelled || setSummary(s), () => {});
    return () => {
      cancelled = true;
    };
  }, [version]);
  useEffect(() => {
    if (!note) return;
    const timer = setTimeout(() => setNote(''), 4000);
    return () => clearTimeout(timer);
  }, [note]);
  const open = summary ? summary.open - summary.openContext : 0;
  return (
    <section className="side-snags" aria-label="Snags">
      <div className="sec-head-row">
        <a className="sec-head snags-head" href="#/snags" aria-current={current ? 'page' : undefined}>
          <Icon id="i-flag" />
          Snags
          {open > 0 && (
            <span className="snags-count" aria-label={`${open} open`}>
              {open}
            </span>
          )}
        </a>
        <button type="button" className="icon-btn snags-plus" aria-label="Add a snag" aria-expanded={adding} title="Add a snag" onClick={() => setAdding(!adding)}>
          <Icon id={adding ? 'i-x' : 'i-plus'} />
        </button>
        <a className="snags-all" href="#/snags">
          All
        </a>
      </div>
      {summary?.offline && (
        <p className="snags-offline">
          {summary.label} offline · {summary.queued} queued
        </p>
      )}
      {adding && (
        <SnagForm
          autoFocus
          onDone={(added) => {
            setAdding(false);
            setNote(added ? `Added ${added}` : '');
          }}
        />
      )}
      {note && !adding && (
        <p className="snags-note" role="status">
          {note}
        </p>
      )}
    </section>
  );
}
