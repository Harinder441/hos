import { useCallback, useEffect, useState } from 'react';
import type { ConfigFile, ConfigPreview, ConfigTarget, ConfigTargetState, ConfigTree } from '../../../src/api/types.js';
import { client, errorText, plural, trapTab } from '../lib.js';
import { Icon, IconButton } from '../shell/icons.js';
import type { State } from '../state.js';
import '../styles/config.css';

const STATE_LABEL: Record<ConfigTargetState, string> = {
  'in-sync': 'in sync',
  'not-applied': 'not applied',
  edited: 'edited in worktree',
  missing: 'missing',
  'upstream-changed': 'upstream changed',
};

interface Selected {
  repo: string;
  path: string;
}

const targetLabel = (t: ConfigTarget) => (t.kind === 'root' ? 'root' : `${t.kind} · ${t.name}`);

function StateTag({ state }: { state: ConfigTargetState }) {
  return <span className={`config-state ${state}`}>{STATE_LABEL[state]}</span>;
}

function EnvEditor({ file, onSaved }: { file: ConfigFile; onSaved: (file: ConfigFile) => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [removed, setRemoved] = useState<string[]>([]);
  const [added, setAdded] = useState<Array<{ name: string; value: string }>>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const reveal = async (name: string) => {
    try {
      const { value } = await client.configReveal(file.repo, file.path, name);
      setRevealed((r) => ({ ...r, [name]: value }));
    } catch (e) {
      setError(errorText(e));
    }
  };
  const set = { ...values, ...Object.fromEntries(added.filter((a) => a.name.trim()).map((a) => [a.name.trim(), a.value])) };
  const dirty = Object.keys(set).length > 0 || removed.length > 0;
  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      onSaved(await client.configSave({ repo: file.repo, path: file.path, set, remove: removed }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <ul className="config-keys" aria-label="Keys">
        {(file.keys ?? []).map(({ name, length }) => {
          const gone = removed.includes(name);
          const shown = name in revealed;
          return (
            <li key={name} className={gone ? 'gone' : undefined} aria-label={name}>
              <code className="config-key">{name}</code>
              {shown ? (
                <input
                  className="config-input"
                  aria-label={`Value of ${name}`}
                  value={values[name] ?? revealed[name]}
                  onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))}
                  disabled={gone}
                />
              ) : (
                <span className="config-mask">
                  •••••••• <span className="muted">{plural(length, 'char')}</span>
                </span>
              )}
              {!shown && (
                <button type="button" className="btn config-small" aria-label={`Reveal ${name}`} onClick={() => void reveal(name)}>
                  Reveal
                </button>
              )}
              <IconButton
                icon={gone ? 'i-sync' : 'i-x'}
                label={gone ? `Keep ${name}` : `Remove ${name}`}
                tip={gone ? 'Keep this key' : 'Remove this key'}
                onClick={() => setRemoved((r) => (gone ? r.filter((k) => k !== name) : [...r, name]))}
              />
            </li>
          );
        })}
        {added.map((row, index) => (
          <li key={index} className="config-new-key">
            <input
              className="config-input"
              aria-label="New key name"
              placeholder="KEY"
              value={row.name}
              onChange={(e) => setAdded((a) => a.map((r, i) => (i === index ? { ...r, name: e.target.value } : r)))}
            />
            <input
              className="config-input"
              aria-label="New key value"
              placeholder="value"
              value={row.value}
              onChange={(e) => setAdded((a) => a.map((r, i) => (i === index ? { ...r, value: e.target.value } : r)))}
            />
          </li>
        ))}
      </ul>
      {error && <p className="error-text">{error}</p>}
      <div className="config-acts">
        <button type="button" className="btn" title="Add a new key" onClick={() => setAdded((a) => [...a, { name: '', value: '' }])}>
          + key
        </button>
        <button type="button" className="btn go" disabled={!dirty || busy} onClick={() => void save()}>
          Save
        </button>
      </div>
    </>
  );
}

function TextEditor({ file, onSaved }: { file: ConfigFile; onSaved: (file: ConfigFile) => void }) {
  const [text, setText] = useState(file.text ?? '');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      onSaved(await client.configSave({ repo: file.repo, path: file.path, text }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <textarea className="config-text" aria-label={`Contents of ${file.path}`} value={text} spellCheck={false} onChange={(e) => setText(e.target.value)} />
      {error && <p className="error-text">{error}</p>}
      <div className="config-acts">
        <button type="button" className="btn go" disabled={busy || text === file.text} onClick={() => void save()}>
          Save
        </button>
      </div>
    </>
  );
}

function ApplyDialog({ file, onClose, onApplied }: { file: ConfigFile; onClose: () => void; onApplied: () => void }) {
  const [ticked, setTicked] = useState<string[]>(file.targets.filter((t) => t.state !== 'in-sync').map((t) => t.path));
  const [previews, setPreviews] = useState<ConfigPreview[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!ticked.length) return void setPreviews([]);
    let cancelled = false;
    client.configPreview(file.repo, file.path, ticked).then(
      (p) => cancelled || setPreviews(p),
      (e: unknown) => cancelled || setError(errorText(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [file, ticked]);
  const all = ticked.length === file.targets.length;
  const toggle = (path: string) => setTicked((t) => (t.includes(path) ? t.filter((p) => p !== path) : [...t, path]));
  const apply = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await client.configApply(file.repo, file.path, ticked);
      if (result.errors.length) setError(result.errors.join('\n'));
      else onApplied();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const nameOf = (path: string) => file.targets.find((t) => t.path === path)?.name ?? path;
  return (
    <div className="dialog-wrap" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="dialog config-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="config-apply-title"
        onKeyDown={(e) => (trapTab(e), e.key === 'Escape' && (e.stopPropagation(), onClose()))}
      >
        <h2 id="config-apply-title">
          Apply {file.path} to {file.repo}
        </h2>
        <label className="config-check">
          <input type="checkbox" checked={all} onChange={() => setTicked(all ? [] : file.targets.map((t) => t.path))} />
          All ({file.targets.length})
        </label>
        <ul className="config-targets" aria-label="Targets">
          {file.targets.map((target) => (
            <li key={target.path}>
              <label className="config-check">
                <input type="checkbox" checked={ticked.includes(target.path)} onChange={() => toggle(target.path)} />
                <span>{targetLabel(target)}</span>
                <StateTag state={target.state} />
              </label>
            </li>
          ))}
        </ul>
        {previews.map((preview) => (
          <section key={preview.target} className="config-preview" aria-label={`Preview of ${nameOf(preview.target)}`}>
            <h3>Preview · {nameOf(preview.target)}</h3>
            {preview.changes.length === 0 ? (
              <p className="muted">No changes.</p>
            ) : (
              <ul>
                {preview.changes.map((c) => (
                  <li key={`${c.change}:${c.name}`} className={`config-change ${c.change}`}>
                    <code>{c.change === 'added' ? '+' : c.change === 'removed' ? '−' : '~'}</code> <code>{c.name}</code> {c.change}
                    {file.env && ' (values hidden)'}
                  </li>
                ))}
              </ul>
            )}
            {preview.backup && <p className="muted">The worktree copy was edited; the old copy is saved to .overwritten/.</p>}
          </section>
        ))}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-acts">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn go" disabled={!ticked.length || busy} onClick={() => void apply()}>
            Apply to {ticked.length}
          </button>
        </div>
      </div>
    </div>
  );
}

function Targets({ file, onRestored }: { file: ConfigFile; onRestored: () => void }) {
  const [error, setError] = useState<string>();
  if (!file.targets.length) return <p className="muted">hos knows no checkout of this repo yet.</p>;
  const restore = async (target: ConfigTarget) => {
    if (!window.confirm(`Put the upstream ${file.path} back in ${targetLabel(target)}? Its current copy is saved to .overwritten/.`)) return;
    setError(undefined);
    try {
      await client.configRestore(file.repo, file.path, target.path);
      onRestored();
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <>
      <ul className="config-targets" aria-label="Worktrees">
        {file.targets.map((t) => (
          <li key={t.path} title={t.path}>
            <span>{targetLabel(t)}</span>
            <StateTag state={t.state} />
            {file.tracked && t.state !== 'missing' && (
              <button type="button" className="btn config-small" aria-label={`Restore upstream in ${targetLabel(t)}`} onClick={() => void restore(t)}>
                Restore upstream
              </button>
            )}
          </li>
        ))}
      </ul>
      {error && <p className="error-text">{error}</p>}
    </>
  );
}

function NewFile({ tree, onDone }: { tree: ConfigTree; onDone: (selected: Selected) => void }) {
  const [repo, setRepo] = useState(tree.projects[0]?.repo ?? '');
  const [path, setPath] = useState('');
  const [error, setError] = useState<string>();
  const [note, setNote] = useState<string>();
  const create = async () => {
    setError(undefined);
    try {
      await client.configSave({ repo, path: path.trim(), text: '' });
      onDone({ repo, path: path.trim() });
    } catch (e) {
      setError(errorText(e));
    }
  };
  const importRoot = async () => {
    setError(undefined);
    try {
      const { imported } = await client.configImport(repo);
      setNote(imported.length ? `Imported ${imported.join(', ')}` : 'Nothing new to import');
      onDone(imported[0] ? { repo, path: imported[0] } : { repo, path: '' });
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <section className="config-new" aria-label="Add files">
      <select className="config-input" aria-label="Repo" title="Repo for the new file" value={repo} onChange={(e) => setRepo(e.target.value)}>
        {tree.projects.map((p) => (
          <option key={p.repo} value={p.repo}>
            {p.repo}
          </option>
        ))}
      </select>
      <button type="button" className="btn" title="Import untracked .env files from the root checkout" disabled={!repo} onClick={() => void importRoot()}>
        Import from root
      </button>
      <input className="config-input" aria-label="New file path" placeholder="client/.env" value={path} onChange={(e) => setPath(e.target.value)} />
      <button type="button" className="btn" disabled={!repo || !path.trim()} onClick={() => void create()}>
        New file
      </button>
      {note && <p className="muted">{note}</p>}
      {error && <p className="error-text">{error}</p>}
    </section>
  );
}

export function ConfigPage(_props: { state: State }) {
  const [tree, setTree] = useState<ConfigTree>();
  const [selected, setSelected] = useState<Selected>();
  const [file, setFile] = useState<ConfigFile>();
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string>();
  const loadTree = useCallback(() => client.configTree().then(setTree, (e: unknown) => setError(errorText(e))), []);
  const loadFile = useCallback((s: Selected) => {
    setError(undefined);
    client.configFile(s.repo, s.path).then(setFile, (e: unknown) => setError(errorText(e)));
  }, []);
  useEffect(() => void loadTree(), [loadTree]);
  useEffect(() => {
    setFile(undefined);
    if (selected?.path) loadFile(selected);
  }, [selected, loadFile]);
  const refresh = () => {
    void loadTree();
    if (selected?.path) loadFile(selected);
  };
  const remove = async () => {
    if (!file || !window.confirm(`Remove ${file.repo}/${file.path} from hos Config? Worktree copies stay.`)) return;
    try {
      await client.configRemove(file.repo, file.path);
      setSelected(undefined);
      void loadTree();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const files = tree?.repos.reduce((n, r) => n + r.files.length, 0) ?? 0;
  const drift = tree?.repos.reduce((n, r) => n + r.files.filter((f) => f.drift > 0).length, 0) ?? 0;
  return (
    <>
      {tree && (
        <p className="muted config-summary">
          {tree.dir} · {plural(files, 'file')} · {drift} drift
        </p>
      )}
      <div className="config-body">
        <nav className="config-tree" aria-label="Config files">
          {tree?.errors.map((message) => (
            <p key={message} className="error-text">
              {message}
            </p>
          ))}
          {tree?.repos.map((repo) => (
            <section key={repo.repo} aria-label={repo.repo}>
              <h2>{repo.repo}</h2>
              <ul>
                {repo.files.map((f) => (
                  <li key={f.path}>
                    <button
                      type="button"
                      className="config-file"
                      aria-current={selected?.repo === repo.repo && selected.path === f.path ? 'true' : undefined}
                      onClick={() => setSelected({ repo: repo.repo, path: f.path })}
                    >
                      <code>{f.path}</code>
                      {f.tracked && <span className="config-tag">tracked</span>}
                      {f.drift > 0 && <span className="config-drift">{f.drift} drift</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {tree && tree.repos.length === 0 && <p className="muted">No files yet. Import a repo’s env files from its root checkout, or add a file.</p>}
          {tree && <NewFile tree={tree} onDone={(s) => (void loadTree(), setSelected(s))} />}
        </nav>
        <section className="config-main" aria-label="Config file">
          {error && <p className="error-text">{error}</p>}
          {!selected?.path && <p className="muted">Pick a file. Save writes only the central copy; Apply copies it to the worktrees you tick.</p>}
          {file && (
            <>
              <div className="config-head">
                <h2>
                  <code>
                    {file.repo}/{file.path}
                  </code>
                </h2>
                <button type="button" className="btn deny config-small" onClick={() => void remove()}>
                  Remove
                </button>
              </div>
              {file.env ? <EnvEditor key={JSON.stringify(file.keys)} file={file} onSaved={(f) => (setFile(f), void loadTree())} /> : <TextEditor key={file.text} file={file} onSaved={(f) => (setFile(f), void loadTree())} />}
              <h3>Worktrees</h3>
              <Targets file={file} onRestored={refresh} />
              <div className="config-acts">
                <button type="button" className="btn" disabled={!file.targets.length} onClick={() => setApplying(true)}>
                  Apply to worktrees…
                </button>
              </div>
            </>
          )}
        </section>
      </div>
      {applying && file && <ApplyDialog file={file} onClose={() => setApplying(false)} onApplied={() => (setApplying(false), refresh())} />}
    </>
  );
}
