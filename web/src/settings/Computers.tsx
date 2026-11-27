import { useState, type FormEvent, type ReactNode } from 'react';
import type { Computer, PairCode } from '../../../src/api/types.js';
import { client, errorText } from '../lib.js';
import { useComputers } from '../model/computers.js';

const WHEN = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const TIME = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

function capsLine(computer: Computer): string {
  const caps = computer.caps;
  if (!caps) return computer.hosVersion ? `hos ${computer.hosVersion}` : 'not reached yet';
  const slots = Object.values(caps.slots);
  const free = slots.reduce((sum, s) => sum + Math.max(0, s.max - s.running), 0);
  const total = slots.reduce((sum, s) => sum + s.max, 0);
  return [
    `hos ${caps.hosVersion}`,
    `${free} of ${total} slots free`,
    caps.harnesses.map((h) => `${h.label} ${h.loggedIn ? '✓' : '✗'}`).join(' '),
    caps.browser ? 'Chrome ✓' : 'no Chrome',
    `${caps.projects.length} ${caps.projects.length === 1 ? 'project' : 'projects'}`,
  ].join(' · ');
}

export function Computers() {
  const { view, error, reload } = useComputers();
  const [adding, setAdding] = useState(false);
  const [code, setCode] = useState<PairCode>();
  const [codeError, setCodeError] = useState<string>();
  const out = view?.computers.filter((c) => c.direction === 'out') ?? [];
  const allowed = view?.computers.filter((c) => c.direction === 'in') ?? [];
  const allow = () =>
    void client.pairCode().then(
      (next) => (setCode(next), setCodeError(undefined)),
      (e: unknown) => setCodeError(errorText(e)),
    );
  if (!view) return error ? <p className="error-text">{error}</p> : <p className="muted">Loading…</p>;
  return (
    <div className="computers">
      {error && <p className="error-text">{error}</p>}
      <div className="computer-card" role="group" aria-label="This computer">
        <div className="computer-name">
          <span className="computer-dot on" />
          {view.self.name}
          <span className="tag">this computer</span>
        </div>
        <p className="computer-kv">
          hos {view.self.hosVersion} · API v{view.self.apiVersion}
        </p>
      </div>

      <h3>Can start chats there</h3>
      {out.length === 0 ? (
        <p className="muted">None</p>
      ) : (
        <ul className="computer-list" aria-label="Can start chats there">
          {out.map((c) => (
            <ComputerRow key={c.name} computer={c} onRemoved={() => void reload()}>
              <p className="computer-kv">
                {c.online ? 'online' : 'offline'} · {c.lastSeen === null ? 'never seen' : `last seen ${WHEN.format(c.lastSeen)}`}
                {c.needsUpdate && (
                  <span className="tag warn">
                    update needed: hos {c.hosVersion ?? 'unknown'} (API v{c.apiVersion}) there, {view.self.hosVersion} (API v{view.self.apiVersion}) here
                  </span>
                )}
              </p>
              <p className="computer-kv">{capsLine(c)}</p>
              {!c.online && c.error && <p className="computer-kv computer-error">{c.error}</p>}
              <p className="computer-kv">
                <a href={`#/settings/schedules?computer=${encodeURIComponent(c.name)}`}>
                  {c.schedules.length} {c.schedules.length === 1 ? 'schedule' : 'schedules'} on {c.name}
                </a>
              </p>
            </ComputerRow>
          ))}
        </ul>
      )}
      {adding ? (
        <AddComputer
          onCancel={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            void reload();
          }}
        />
      ) : (
        <button type="button" className="btn" onClick={() => setAdding(true)}>
          Add a computer
        </button>
      )}

      <h3>Can start chats here</h3>
      {allowed.length === 0 ? (
        <p className="muted">None</p>
      ) : (
        <ul className="computer-list" aria-label="Can start chats here">
          {allowed.map((c) => (
            <ComputerRow key={c.name} computer={c} onRemoved={() => void reload()}>
              <p className="computer-kv">
                added {WHEN.format(c.addedAt)}
                {c.lastSeen !== null && ` · last call ${WHEN.format(c.lastSeen)}`}
              </p>
            </ComputerRow>
          ))}
        </ul>
      )}
      {code ? (
        <div className="computer-card computer-code" role="group" aria-label="Pairing code">
          <p className="computer-kv">Pairing code, one use, valid until {TIME.format(code.expiresAt)}</p>
          <code>{code.code}</code>
          <div className="computer-acts">
            <button type="button" className="btn" onClick={allow}>
              New code
            </button>
            <button type="button" className="btn quiet" onClick={() => setCode(undefined)}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="btn" onClick={allow}>
          Allow a computer
        </button>
      )}
      {codeError && (
        <p className="error-text" role="alert">
          {codeError}
        </p>
      )}
    </div>
  );
}

function ComputerRow({ computer, onRemoved, children }: { computer: Computer; onRemoved: () => void; children: ReactNode }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const remove = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await client.removeComputer(computer.name);
      onRemoved();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };
  const live = computer.direction === 'out' && computer.online;
  return (
    <li className="computer-row" aria-label={computer.name}>
      <div className="computer-main">
        <div className="computer-name">
          {computer.direction === 'out' && <span className={`computer-dot${live ? ' on' : ''}`} />}
          {computer.name}
          {computer.url && <span className="computer-url">{computer.url}</span>}
        </div>
        {children}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
      </div>
      {confirm ? (
        <div className="computer-acts" role="group" aria-label={`Remove ${computer.name}?`}>
          <span>Remove {computer.name}?</span>
          <button type="button" className="btn danger" disabled={busy} onClick={() => void remove()}>
            Remove
          </button>
          <button type="button" className="btn" onClick={() => setConfirm(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="computer-acts">
          <button type="button" className="btn" onClick={() => setConfirm(true)}>
            Remove
          </button>
        </div>
      )}
    </li>
  );
}

function AddComputer({ onCancel, onAdded }: { onCancel: () => void; onAdded: () => void }) {
  const [url, setUrl] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await client.addComputer({ url: url.trim(), code: code.trim() });
      onAdded();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <form className="computer-card computer-add" aria-label="Add a computer" onSubmit={submit}>
      <label>
        Address
        <input value={url} required autoFocus placeholder="https://my-server.example.ts.net" disabled={busy} onChange={(e) => setUrl(e.target.value)} />
      </label>
      <label>
        Pairing code
        <input value={code} required placeholder="XXXX-XXXX" className="computer-code-in" disabled={busy} onChange={(e) => setCode(e.target.value)} />
      </label>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <div className="computer-acts">
        <button type="submit" className="btn go" disabled={busy || !url.trim() || !code.trim()}>
          Pair
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
