import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { TerminalAttachment } from '../../src/api/client.js';
import type { Terminal } from '../../src/api/types.js';
import { PHONE_QUERY, client, openTerminal, useAction, useMediaQuery } from './lib.js';
import { ViewHeader } from './shared.js';
import type { State } from './state.js';
import './styles/nav.css';

const TERMINAL_FONT = '"Overpass Mono Variable", "Overpass Mono", ui-monospace, Menlo, monospace';

const LIGHT_QUERY = '(prefers-color-scheme: light)';

const ANSI = {
  dark: {
    black: '#2C3237',
    red: '#F0686C',
    green: '#4FC08D',
    yellow: '#F2B01E',
    blue: '#7FB0E8',
    magenta: '#C79BE0',
    cyan: '#5FC6C2',
    white: '#E3E7E1',
    brightBlack: '#6B757C',
    brightRed: '#FF8A8D',
    brightGreen: '#74D6A8',
    brightYellow: '#FFCB57',
    brightBlue: '#A3C8F0',
    brightMagenta: '#DAB8EC',
    brightCyan: '#86DAD6',
    brightWhite: '#FFFFFF',
  },
  light: {
    black: '#1C2125',
    red: '#B0262E',
    green: '#0B6B4C',
    yellow: '#8A5A00',
    blue: '#1F5FA8',
    magenta: '#7B3FA0',
    cyan: '#0E6E6A',
    white: '#5A6268',
    brightBlack: '#5A6268',
    brightRed: '#C9323A',
    brightGreen: '#0F7A57',
    brightYellow: '#9A6A00',
    brightBlue: '#2C6FBF',
    brightMagenta: '#8E4DB5',
    brightCyan: '#137F7A',
    brightWhite: '#1C2125',
  },
};

function terminalTheme(host: HTMLElement) {
  const css = getComputedStyle(host);
  const token = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const light = getComputedStyle(document.documentElement).colorScheme === 'light';
  const ansi = light ? ANSI.light : ANSI.dark;
  const background = token('--term-bg', light ? '#F8FAF9' : '#1A1E21');
  const foreground = token('--ink', light ? '#1C2125' : '#ECEFEA');
  return {
    ...ansi,
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: light ? 'rgba(11, 107, 76, 0.22)' : 'rgba(79, 192, 141, 0.32)',
    scrollbarSliderBackground: token('--line-strong', 'rgba(128, 128, 128, 0.3)'),
    black: light ? foreground : token('--shoulder', ansi.black),
    red: token('--red-ink', ansi.red),
    green: token('--green-ink', ansi.green),
    yellow: light ? ansi.yellow : token('--amber', ansi.yellow),
    white: light ? ansi.white : foreground,
    brightWhite: light ? foreground : ansi.brightWhite,
  };
}

export function useTerminals(reloadKey: string): Terminal[] {
  const [terminals, setTerminals] = useState<Terminal[]>([]);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      client.listTerminals().then(
        (list) => cancelled || setTerminals(list),
        () => {},
      );
    void load();
    const timer = setInterval(load, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [reloadKey]);
  return terminals;
}

export function TerminalsView({ terminals, state }: { terminals: Terminal[]; state: State }) {
  const worktrees = Object.values(state.worktrees);
  const [path, setPath] = useState('');
  const { error, busy, run } = useAction();
  const chosen = path || worktrees[0]?.path || '';
  return (
    <section className="terminals-view" aria-label="Terminal sessions">
      <ViewHeader title="Terminals" />
      <div className="view-scroll">
        <form
          className="inline-form open-terminal"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => openTerminal((await client.createTerminal({ worktreePath: chosen })).name));
          }}
        >
          <label>
            <span className="field-label">Worktree</span>
            <select value={chosen} onChange={(e) => setPath(e.target.value)}>
              {worktrees.map((w) => (
                <option key={w.path} value={w.path}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
          <button className="primary" disabled={busy || !chosen}>
            Open terminal
          </button>
          {error && <p className="error">{error}</p>}
        </form>
        <h2>
          Sessions {terminals.length > 0 && <span className="count">{terminals.length}</span>}
        </h2>
        {terminals.length === 0 && <p className="meta">No tmux sessions.</p>}
        <ul className="session-list">
          {terminals.map((terminal) => (
            <li key={terminal.name}>
              <a href={`#/terminal/${encodeURIComponent(terminal.name)}`} title={terminal.cwd}>
                <span className="mono name">{terminal.name}</span>
                <span className="tags">
                  {terminal.chatId && <span className="tag">chat</span>}
                  <span className="tag">{terminal.topicId ? (state.topics[terminal.topicId]?.title ?? 'topic') : 'no topic'}</span>
                </span>
                <small>{shortPath(terminal.cwd)}</small>
              </a>
              {!terminal.chatId && (
                <button
                  type="button"
                  className="btn"
                  aria-label={`Kill ${terminal.name}`}
                  disabled={busy}
                  onClick={() => {
                    if (!terminal.busy || confirm(`${terminal.name} is still running something. Kill it anyway?`)) void run(() => client.killTerminal(terminal.name));
                  }}
                >
                  Kill
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export function TerminalTabs({ tabs, active, onClose }: { tabs: string[]; active: string; onClose: (name: string) => void }) {
  return (
    <>
      <header className="view-header terminal-header">
        <a className="back" href="#/terminals">
          ‹ Back
        </a>
        <div className="tabs" role="tablist" aria-label="Terminal tabs">
          {tabs.map((name) => (
            <span key={name} className="tab">
              <a role="tab" aria-selected={name === active} href={`#/terminal/${encodeURIComponent(name)}`}>
                {name}
              </a>
              <button className="close" aria-label={`Close tab ${name}`} title="Close this terminal tab" onClick={() => onClose(name)}>
                ×
              </button>
            </span>
          ))}
        </div>
      </header>
      <TerminalView key={active} name={active} />
    </>
  );
}

export function TerminalView({ name, onExit }: { name: string; onExit?: () => void }) {
  const container = useRef<HTMLDivElement>(null);
  const session = useRef<{ term: XTerm; write: (data: string) => void }>(null);
  const ctrlRef = useRef(false);
  const [ctrl, setCtrl] = useState(false);
  const [line, setLine] = useState('');
  const [exited, setExited] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const keyBar = useMediaQuery(`${PHONE_QUERY}, (pointer: coarse)`);
  const latchCtrl = (on: boolean) => {
    ctrlRef.current = on;
    setCtrl(on);
  };
  const typed = (data: string) => {
    if (!ctrlRef.current) return data;
    latchCtrl(false);
    return withCtrl(data);
  };
  useEffect(() => {
    const host = container.current!;
    const term = new XTerm({ cursorBlink: true, cursorStyle: 'bar', cursorWidth: 2, fontSize: 13, fontFamily: TERMINAL_FONT, theme: terminalTheme(host) });
    const scheme = matchMedia(LIGHT_QUERY);
    const retheme = () => {
      term.options.theme = terminalTheme(host);
    };
    scheme.addEventListener('change', retheme);
    const themed = new MutationObserver(retheme);
    themed.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    let disposed = false;
    void document.fonts.load(`13px ${TERMINAL_FONT}`).then(() => {
      if (disposed) return;
      term.options.fontFamily = 'monospace';
      term.options.fontFamily = TERMINAL_FONT;
      fit.fit();
    });
    let attachment: TerminalAttachment | null = null;
    let retries = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      retry = undefined;
      attachment = client.attachTerminal(name, {
        cols: term.cols,
        rows: term.rows,
        onData: (data) => {
          retries = 0;
          setReconnecting(false);
          term.write(data);
        },
        onExit: () => void dropped(),
      });
    };
    const dropped = async () => {
      if (disposed) return;
      const alive = await client.listTerminals().then(
        (list) => list.some((t) => t.name === name),
        () => null,
      );
      if (disposed) return;
      if (alive === false) {
        setReconnecting(false);
        setExited(true);
        onExit?.();
        return;
      }
      setReconnecting(true);
      retry = setTimeout(reconnect, Math.min(500 * 2 ** retries++, 8000));
    };
    const reconnect = () => {
      if (disposed) return;
      term.reset();
      connect();
    };
    const wake = () => {
      if (retry === undefined || document.visibilityState === 'hidden') return;
      clearTimeout(retry);
      retries = 0;
      reconnect();
    };
    connect();
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    session.current = { term, write: (data) => attachment?.write(data) };
    const input = term.onData((data) => attachment?.write(typed(data)));
    const resize = term.onResize(({ cols, rows }) => attachment?.resize(cols, rows));
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(host);
    term.focus();
    return () => {
      disposed = true;
      clearTimeout(retry);
      session.current = null;
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
      scheme.removeEventListener('change', retheme);
      themed.disconnect();
      observer.disconnect();
      input.dispose();
      resize.dispose();
      attachment?.close();
      term.dispose();
    };
  }, [name]);
  const send = (data: string) => session.current?.write(data);
  const arrow = (code: string) => send(`${session.current?.term.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b['}${code}`);
  const paste = async () => {
    const text = await navigator.clipboard.readText().catch(() => '');
    if (text) session.current?.term.paste(text);
  };
  const sendLine = (e: FormEvent) => {
    e.preventDefault();
    send(ctrlRef.current && line.length === 1 ? typed(line) : `${line}\r`);
    setLine('');
  };
  const keys: Array<[label: string, title: string, press: () => void]> = [
    ['Tab', 'Tab', () => send('\t')],
    ['←', 'Left', () => arrow('D')],
    ['↑', 'Up', () => arrow('A')],
    ['↓', 'Down', () => arrow('B')],
    ['→', 'Right', () => arrow('C')],
    ['^C', 'Interrupt', () => send('\x03')],
    ['Paste', 'Paste', () => void paste()],
  ];
  return (
    <>
      {exited && <p className="error terminal-exit">Detached: the tmux session {name} ended or is unreachable.</p>}
      {reconnecting && !exited && (
        <p className="meta terminal-exit" role="status">
          Reconnecting to {name}…
        </p>
      )}
      <div className="term-host" role="region" aria-label={`Terminal ${name}`} ref={container} />
      {keyBar && (
        <div className="terminal-input">
          <div className="key-bar" role="toolbar" aria-label="Terminal keys" onPointerDown={(e) => e.preventDefault()}>
            <button className="key" aria-label="Escape" onClick={() => send('\x1b')}>
              Esc
            </button>
            <button className="key" aria-label="Control" aria-pressed={ctrl} onClick={() => latchCtrl(!ctrlRef.current)}>
              Ctrl
            </button>
            {keys.map(([label, title, press]) => (
              <button key={title} className="key" aria-label={title} onClick={press}>
                {label}
              </button>
            ))}
          </div>
          <form className="send-line" onSubmit={sendLine}>
            <input
              aria-label="Line to send"
              value={line}
              onChange={(e) => setLine(e.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="send"
            />
            <button className="primary">Send line</button>
          </form>
        </div>
      )}
    </>
  );
}

function shortPath(path: string | null | undefined): string {
  if (!path) return '';
  const parts = path.split('/').filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : path;
}

function withCtrl(data: string): string {
  if (data.length !== 1) return data;
  const code = data.toUpperCase().charCodeAt(0);
  if (code === 32) return '\x00';
  return code >= 64 && code <= 95 ? String.fromCharCode(code - 64) : data;
}
