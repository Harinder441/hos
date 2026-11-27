import { createContext, useContext, useState, type ReactNode } from 'react';
import { client, errorText } from '../lib.js';
import { Icon } from '../shell/icons.js';

export interface FileRoots {
  known: string[];
  relativeTo: string | undefined;
}

const Files = createContext<FileRoots>({ known: [], relativeTo: undefined });

const LINE_SUFFIX = /(?::\d+(?:[-:]\d+)?|#L\d+(?:-L?\d+)?)$/;
const HTML_FILE = /^\/.*\.html?(?::\d+(?:[-:]\d+)?|#L\d+(?:-L?\d+)?)?$/i;
const RELATIVE_FILE =/^(?:\.\/)?(?:\.?[\w@+-][\w@.+-]*\/)+\.?[\w@+-][\w@.+-]*\.\w+$/;

function locate(path: string, files: FileRoots): { root: string; file?: string } | undefined {
  const clean = path.replace(LINE_SUFFIX, '').replace(/(.)\/+$/, '$1');
  if (clean.startsWith('/')) {
    const root = files.known.find((r) => clean === r || clean.startsWith(`${r}/`));
    return root ? { root, file: clean === root ? undefined : clean.slice(root.length + 1) } : undefined;
  }
  return files.relativeTo && RELATIVE_FILE.test(clean) ? { root: files.relativeTo, file: clean.replace(/^\.\//, '') } : undefined;
}

function FileLink({ path, children }: { path: string; children: ReactNode }) {
  const files = useContext(Files);
  const [error, setError] = useState<string>();
  const target = locate(path, files);
  const html = HTML_FILE.test(path) ? path.replace(LINE_SUFFIX, '') : undefined;
  if (!target && !html) return <>{children}</>;
  const openTab = async (opened: () => Promise<{ url: string }>) => {
    setError(undefined);
    const tab = window.open('', '_blank');
    try {
      const url = new URL((await opened()).url, location.href).href;
      if (tab) {
        tab.opener = null;
        tab.location.href = url;
      } else window.open(url, '_blank', 'noopener');
    } catch (e) {
      tab?.close();
      setError(errorText(e));
    }
  };
  return (
    <>
      {target ? (
        <a
          href="#"
          className="md-file"
          aria-label={`Open ${path} in Code view`}
          onClick={(e) => {
            e.preventDefault();
            void openTab(() => client.openCodeView(target.root, target.file));
          }}
        >
          {children}
        </a>
      ) : (
        children
      )}
      {html && (
        <button
          type="button"
          className="md-open-tab"
          aria-label={`Open ${html} in a new tab`}
          title="Open in a new tab"
          onClick={() => void openTab(() => client.openFile(html))}
        >
          <Icon id="i-external" />
        </button>
      )}
      {error && (
        <span className="md-file-error" role="alert">
          {' '}
          {error}
        </span>
      )}
    </>
  );
}

function CodeBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string>();
  const copy = () => {
    setError(undefined);
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(text))
      .then(
        () => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        },
        (e: unknown) => setError(errorText(e)),
      );
  };
  return (
    <div className="md-code">
      <pre>
        <code>{text}</code>
      </pre>
      <button type="button" className="md-copy" aria-label="Copy code" title="Copy code" onClick={copy}>
        <Icon id={copied ? 'i-check' : 'i-copy'} />
        {copied && 'Copied'}
      </button>
      {error && (
        <p className="md-file-error" role="alert">
          Could not copy: {error}
        </p>
      )}
    </div>
  );
}

type Block =
  | { kind: 'p'; text: string }
  | { kind: 'h'; level: number; text: string }
  | { kind: 'ul' | 'ol'; items: string[] }
  | { kind: 'code'; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'table'; head: string[]; rows: string[][] };

const TABLE_RULE = /^\s*\|(\s*:?-+:?\s*\|)*\s*:?-+:?\s*\|?\s*$/;

function cells(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

function blocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const out: Block[] = [];
  for (let i = 0; i < lines.length; ) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) {
      const body: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]!); i++) body.push(lines[i]!);
      i++;
      out.push({ kind: 'code', text: body.join('\n') });
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      out.push({ kind: 'h', level: heading[1]!.length, text: heading[2]! });
      i++;
      continue;
    }
    const list = /^\s*([-*+]|\d+[.)])\s+/.exec(line);
    if (list) {
      const ordered = /\d/.test(list[1]!);
      const items: string[] = [];
      while (i < lines.length) {
        const item = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]!);
        if (item && /\d/.test(item[1]!) === ordered) items.push(item[2]!);
        else if (items.length && /^\s{2,}\S/.test(lines[i]!)) items[items.length - 1] += ` ${lines[i]!.trim()}`;
        else break;
        i++;
      }
      out.push({ kind: ordered ? 'ol' : 'ul', items });
      continue;
    }
    if (/^\s*\|/.test(line) && TABLE_RULE.test(lines[i + 1] ?? '')) {
      const head = cells(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && /^\s*\|/.test(lines[i]!); i++) rows.push(cells(lines[i]!));
      out.push({ kind: 'table', head, rows });
      continue;
    }
    if (/^>\s?/.test(line)) {
      const body: string[] = [];
      for (; i < lines.length && /^>\s?/.test(lines[i]!); i++) body.push(lines[i]!.replace(/^>\s?/, ''));
      out.push({ kind: 'quote', text: body.join(' ') });
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const body: string[] = [];
    for (; i < lines.length && lines[i]!.trim() && !/^\s*(```|#{1,4}\s|[-*+]\s|\d+[.)]\s|>|\|)/.test(lines[i]!); i++) body.push(lines[i]!);
    if (!body.length) body.push(lines[i++]!);
    out.push({ kind: 'p', text: body.join('\n') });
  }
  return out;
}

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|((?<![\w/:.~])\/(?:[\w@.+-]+\/)+[\w@.+-]*[\w@+-](?::\d+(?:[-:]\d+)?)?)/g;

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${n++}`;
    if (m[1]) {
      const code = m[1].slice(1, -1);
      out.push(
        code.includes('/') ? (
          <FileLink key={k} path={code}>
            <code>{code}</code>
          </FileLink>
        ) : (
          <code key={k}>{code}</code>
        ),
      );
    }
    else if (m[2]) out.push(<strong key={k}>{inline(m[2].slice(2, -2), k)}</strong>);
    else if (m[3]) out.push(<em key={k}>{inline(m[3].slice(1, -1), k)}</em>);
    else if (m[4])
      out.push(
        <a key={k} href={m[5]} target="_blank" rel="noreferrer noopener">
          {m[4].slice(1, m[4].indexOf(']('))}
        </a>,
      );
    else if (m[6])
      out.push(
        <a key={k} href={m[6]} target="_blank" rel="noreferrer noopener">
          {m[6]}
        </a>,
      );
    else if (m[7])
      out.push(
        <FileLink key={k} path={m[7]}>
          {m[7]}
        </FileLink>,
      );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function lines(text: string, key: string): ReactNode[] {
  return text.split('\n').flatMap((line, i) => (i ? [<br key={`${key}-br${i}`} />, ...inline(line, `${key}-${i}`)] : inline(line, `${key}-${i}`)));
}

export function Markdown({ text, files }: { text: string; files: FileRoots }) {
  return (
    <Files.Provider value={files}>
      {blocks(text).map((block, i) => {
        const key = `b${i}`;
        switch (block.kind) {
          case 'p':
            return <p key={key}>{lines(block.text, key)}</p>;
          case 'h':
            return <p key={key} className={`md-h md-h${block.level}`}>{inline(block.text, key)}</p>;
          case 'quote':
            return <blockquote key={key}>{inline(block.text, key)}</blockquote>;
          case 'code':
            return <CodeBlock key={key} text={block.text} />;
          case 'table':
            return (
              <div key={key} className="md-table">
                <table>
                  <thead>
                    <tr>
                      {block.head.map((cell, j) => (
                        <th key={j}>{inline(cell, `${key}-h${j}`)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, r) => (
                      <tr key={r}>
                        {block.head.map((_, j) => (
                          <td key={j}>{inline(row[j] ?? '', `${key}-${r}-${j}`)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'ul':
          case 'ol': {
            const Tag = block.kind;
            return (
              <Tag key={key}>
                {block.items.map((item, j) => (
                  <li key={j}>{inline(item, `${key}-${j}`)}</li>
                ))}
              </Tag>
            );
          }
        }
      })}
    </Files.Provider>
  );
}
