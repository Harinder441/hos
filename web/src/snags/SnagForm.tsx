import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { SNAG_KIND_LABELS, type SnagKind } from '../../../src/snags/types.js';
import { errorText } from '../lib.js';
import { Icon, IconButton } from '../shell/icons.js';
import { parseRoute } from '../shell/routes.js';
import { readBase64, snags, snagsChanged } from './store.js';

interface Picked {
  key: string;
  file: File;
  preview: string | null;
}

function revoke(picked: Picked): void {
  if (picked.preview) URL.revokeObjectURL(picked.preview);
}

export function SnagForm({ autoFocus, onDone }: { autoFocus?: boolean; onDone?: (added?: string) => void }) {
  const [text, setText] = useState('');
  const [kind, setKind] = useState<SnagKind>('fix');
  const [files, setFiles] = useState<Picked[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [note, setNote] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus) box.current?.focus();
  }, [autoFocus]);
  const latest = useRef(files);
  latest.current = files;
  useEffect(() => () => latest.current.forEach(revoke), []);

  const attach = (list: File[]) => {
    if (!list.length) return false;
    const stamp = Date.now();
    setFiles((current) => [
      ...current,
      ...list.map((file, i) => ({
        key: `${stamp}-${i}`,
        file: file.name ? file : new File([file], 'pasted-image.png', { type: file.type }),
        preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
      })),
    ]);
    return true;
  };

  const submit = async () => {
    if (busy || (!text.trim() && !files.length)) return;
    setBusy(true);
    setError(undefined);
    try {
      const data = await Promise.all(files.map(async ({ file }) => ({ name: file.name, data: await readBase64(file) })));
      const route = parseRoute(window.location.hash);
      const where = route.page === 'topic' ? { topicId: route.topicId, ...(route.chatId ? { chatId: route.chatId } : {}) } : {};
      const snag = await snags.add({ kind, text, files: data, ...where });
      setText('');
      files.forEach(revoke);
      setFiles([]);
      setNote(`Added ${snag.ref}`);
      snagsChanged();
      onDone?.(snag.ref);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="snag-form"
      aria-label="Add a snag"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e: DragEvent) => {
        e.preventDefault();
        attach([...e.dataTransfer.files]);
      }}
    >
      <textarea
        ref={box}
        aria-label="Snag text"
        placeholder="What broke, or what do you want to ask? Paste screenshots here."
        rows={3}
        value={text}
        readOnly={busy}
        onChange={(e) => {
          setText(e.target.value);
          setNote('');
        }}
        onPaste={(e: ClipboardEvent) => attach([...e.clipboardData.files]) && e.preventDefault()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
          if (e.key === 'Escape' && onDone) {
            e.stopPropagation();
            onDone();
          }
        }}
      />
      {files.length > 0 && (
        <ul className="snag-picked" aria-label="Files to add">
          {files.map((f) => (
            <li key={f.key}>
              {f.preview ? <img src={f.preview} alt={f.file.name} /> : <Icon id="i-file" />}
              <span className="snag-picked-name">{f.file.name}</span>
              <IconButton icon="i-x" label={`Remove ${f.file.name}`} tip="Remove this attachment" onClick={() => (revoke(f), setFiles(files.filter((x) => x !== f)))} />
            </li>
          ))}
        </ul>
      )}
      <div className="snag-form-row">
        <div className="snag-kind" role="group" aria-label="Kind">
          {(['fix', 'question', 'context'] as const).map((k) => (
            <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>
              {SNAG_KIND_LABELS[k]}
            </button>
          ))}
        </div>
        <button type="button" className="icon-btn" aria-label="Attach files" title="Attach files" onClick={() => picker.current?.click()}>
          <Icon id="i-file" />
        </button>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            attach([...(e.target.files ?? [])]);
            e.target.value = '';
          }}
        />
        <button type="submit" className="btn go snag-add" disabled={busy || (!text.trim() && !files.length)}>
          {busy ? 'Adding…' : 'Add'}
        </button>
      </div>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <span className="sr" role="status">
        {note}
      </span>
    </form>
  );
}
