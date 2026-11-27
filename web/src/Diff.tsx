import { parsePatchFiles, type DiffLineAnnotation, type FileDiffMetadata } from '@pierre/diffs';
import { FileDiff } from '@pierre/diffs/react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { Chat, Diff, DiffActionResult, DiffFile, DiffScope, ReviewComment, Workspace } from '../../src/api/types.js';
import { PHONE_QUERY, chatLabel, client, errorText, useAction, useMediaQuery } from './lib.js';
import type { DiffActionNote, State } from './state.js';
import './styles/nav.css';

type DiffChoice = 'workspace' | 'start' | 'turn' | 'ref';
type LineRef = Pick<ReviewComment, 'path' | 'line' | 'side'>;
type Note = { comment?: ReviewComment; draft?: LineRef };

const CHOICE_LABELS: Record<DiffChoice, string> = {
  workspace: 'Workspace',
  start: 'Since chat start',
  turn: 'Since last turn',
  ref: 'Agent ref',
};

const DIFF_CSS = `:host {
  --diffs-dark-bg: var(--sunk);
  --diffs-light-bg: var(--shoulder);
  --diffs-font-family: var(--font-code);
}`;

export function DiffView({ route, state }: { route: { kind: 'workspace' | 'chat'; id: string; ref?: string | undefined }; state: State }) {
  const chat = route.kind === 'chat' ? state.chats[route.id] : undefined;
  const chatTopic = chat ? state.topics[chat.topicId] : undefined;
  const workspace = state.workspaces[chat ? (chatTopic?.workspaceIds[0] ?? '') : route.id];
  const topic = chatTopic ?? Object.values(state.topics).find((t) => workspace && t.workspaceIds.includes(workspace.id));
  const chats = Object.values(state.chats).filter((c) => c.topicId === topic?.id);
  const [choice, setChoice] = useState<DiffChoice>(route.ref ? 'ref' : chat ? 'start' : 'workspace');
  const [refInput, setRefInput] = useState(route.ref ?? '');
  const [ref, setRef] = useState(route.ref ?? '');
  const phone = useMediaQuery(PHONE_QUERY);
  const [split, setSplit] = useState(true);
  const [diff, setDiff] = useState<Diff>();
  const [loadError, setLoadError] = useState<string>();
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [draft, setDraft] = useState<LineRef>();
  const [target, setTarget] = useState(chat?.id ?? chats.at(-1)?.id ?? '');
  const [sentTo, setSentTo] = useState<string>();
  const [pending, setPending] = useState<{ result: DiffActionResult; seq: number }>();
  const onAction = (result: DiffActionResult) => setPending(result.state === 'pending' ? { result, seq: state.lastSeq } : undefined);
  const note = workspace ? state.diffActions[workspace.id] : undefined;
  const worktree = workspace ? state.worktrees[workspace.path] : undefined;
  const version = [note?.seq, worktree?.head, worktree?.dirty, ...chats.map((c) => c.state)].join(':');
  const scope: DiffScope | undefined = !workspace
    ? undefined
    : choice === 'workspace'
      ? { workspaceId: workspace.id }
      : choice === 'ref'
        ? ref
          ? { workspaceId: workspace.id, ref }
          : undefined
        : chat && { chatId: chat.id, since: choice };
  const scopeKey = JSON.stringify(scope);

  useEffect(() => {
    if (!scope) return;
    let live = true;
    client.getDiff(scope).then(
      (d) => live && (setDiff(d), setLoadError(undefined)),
      (e: unknown) => live && setLoadError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [scopeKey, version]);

  const files = useMemo(() => (diff ? parsePatchFiles(diff.patch).flatMap((p) => p.files) : []), [diff]);
  if (!workspace) return <p className="empty">No such workspace or chat.</p>;
  const layout = phone || !split ? 'unified' : 'split';
  const choices: DiffChoice[] = chat ? ['start', 'turn', 'workspace', 'ref'] : ['workspace', 'ref'];
  const addComment = (comment: ReviewComment) => {
    setComments([...comments, comment]);
    setDraft(undefined);
  };
  return (
    <section className="diff-view" aria-label="Diff">
      <header className="view-header diff-header">
        <a className="back" href={chat ? `#/chat/${chat.id}` : '#/'}>
          ‹ {chat ? 'Chat' : 'Chats'}
        </a>
        <div className="title">
          <h1>{topic?.title ?? workspace.name}</h1>
          <code className="branch">{workspace.branch}</code>
        </div>
        {!phone && (
          <div className="header-actions">
            <button className="quiet layout" aria-pressed={split} title="Switch diff layout" onClick={() => setSplit(!split)}>
              {split ? 'Stacked' : 'Split'}
            </button>
          </div>
        )}
      </header>
      <div className="diff-toolbar">
        <div className="segmented" role="group" aria-label="Diff scope">
          {choices.map((c) => (
            <button key={c} aria-pressed={choice === c} onClick={() => setChoice(c)}>
              {CHOICE_LABELS[c]}
            </button>
          ))}
        </div>
        {choice === 'ref' && (
          <form
            className="ref-form"
            onSubmit={(e) => {
              e.preventDefault();
              setRef(refInput.trim());
            }}
          >
            <input aria-label="Ref" value={refInput} onChange={(e) => setRefInput(e.target.value)} placeholder="refs/heads/…" />
            <button title="Show the diff for this ref">Show</button>
          </form>
        )}
      </div>
      <div className="diff-body">
        {loadError && <p className="error">{loadError}</p>}
        {diff && !loadError && (
          <>
            <p className="meta diff-summary" aria-label="Diff summary">
              {diff.files.length} file{diff.files.length === 1 ? '' : 's'} changed · +
              {diff.files.reduce((n, f) => n + f.additions, 0)} −{diff.files.reduce((n, f) => n + f.deletions, 0)}
            </p>
            {files.length > 1 && (
              <ul className="file-index" aria-label="Changed files">
                {files.map((file) => {
                  const info = diff.files.find((f) => f.path === file.name);
                  const count = comments.filter((c) => c.path === file.name).length;
                  return (
                    <li key={file.name}>
                      <button
                        className="quiet"
                        onClick={() => document.getElementById(fileAnchor(file.name))?.scrollIntoView({ block: 'start', behavior: 'smooth' })}
                      >
                        <code>{file.name}</code>
                        {info && (
                          <span className="counts">
                            <span className="add">+{info.additions}</span> <span className="del">−{info.deletions}</span>
                          </span>
                        )}
                        {count > 0 && <span className="count needs">{count}</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {files.map((file) => (
              <DiffFileView
                key={file.name}
                file={file}
                info={diff.files.find((f) => f.path === file.name)}
                workspaceId={workspace.id}
                canDiscard={choice !== 'ref'}
                layout={layout}
                comments={comments.filter((c) => c.path === file.name)}
                draft={draft?.path === file.name ? draft : undefined}
                onLine={setDraft}
                onAdd={addComment}
                onCancel={() => setDraft(undefined)}
                onRemove={(comment) => setComments(comments.filter((c) => c !== comment))}
                onAction={onAction}
              />
            ))}
          </>
        )}
      </div>
      <ReviewBar
        comments={comments}
        chats={chats}
        state={state}
        target={target}
        onTarget={setTarget}
        sentTo={sentTo}
        onSent={(chatId) => {
          setComments([]);
          setSentTo(chatId);
        }}
      />
      <DiffActions workspace={workspace} chat={chat} note={note} pending={pending} onAction={onAction} />
    </section>
  );
}

function DiffFileView(props: {
  file: FileDiffMetadata;
  info: DiffFile | undefined;
  workspaceId: string;
  canDiscard: boolean;
  layout: 'split' | 'unified';
  comments: ReviewComment[];
  draft: LineRef | undefined;
  onLine: (line: LineRef) => void;
  onAdd: (comment: ReviewComment) => void;
  onCancel: () => void;
  onRemove: (comment: ReviewComment) => void;
  onAction: (result: DiffActionResult) => void;
}) {
  const { file, info, layout, comments, draft } = props;
  const { error, busy, run } = useAction();
  const path = file.name;
  const options = useMemo(
    () => ({
      diffStyle: layout,
      themeType: 'system' as const,
      disableFileHeader: true,
      overflow: 'wrap' as const,
      unsafeCSS: DIFF_CSS,
      onLineClick: ({ lineNumber, annotationSide }: { lineNumber: number; annotationSide: 'additions' | 'deletions' }) =>
        props.onLine({ path, line: lineNumber, side: annotationSide }),
    }),
    [layout, path],
  );
  const annotations: DiffLineAnnotation<Note>[] = [
    ...comments.map((comment) => ({ side: comment.side, lineNumber: comment.line, metadata: { comment } })),
    ...(draft ? [{ side: draft.side, lineNumber: draft.line, metadata: { draft } }] : []),
  ];
  const discard = () => {
    if (confirm(`Discard the uncommitted changes to ${path}?`)) void run(async () => props.onAction(await client.discardFile(props.workspaceId, path)));
  };
  return (
    <article className="diff-file" id={fileAnchor(path)} aria-label={`Changes to ${path}`}>
      <header>
        <code title={file.prevName ? `${file.prevName} → ${path}` : path}>{path}</code>
        {info && (
          <small>
            <span className={`status ${info.status}`}>{info.status}</span> <span className="add">+{info.additions}</span>{' '}
            <span className="del">−{info.deletions}</span>
          </small>
        )}
        {comments.length > 0 && (
          <span className="count needs" title={`${comments.length} comment${comments.length === 1 ? '' : 's'} on this file`}>
            {comments.length}
          </span>
        )}
        {props.canDiscard && info?.uncommitted && (
          <button className="quiet danger" disabled={busy} onClick={discard} aria-label={`Discard ${path}`}>
            Discard
          </button>
        )}
      </header>
      {error && <p className="error">{error}</p>}
      <FileDiff<Note>
        fileDiff={file}
        options={options}
        lineAnnotations={annotations}
        renderAnnotation={({ metadata }) =>
          metadata.draft ? (
            <CommentForm line={metadata.draft} onAdd={props.onAdd} onCancel={props.onCancel} />
          ) : (
            <div className="comment">
              <span className="comment-line">Line {metadata.comment!.line}</span>
              <p>{metadata.comment!.text}</p>
              <button className="quiet" onClick={() => props.onRemove(metadata.comment!)}>
                Remove
              </button>
            </div>
          )
        }
      />
    </article>
  );
}

function CommentForm({ line, onAdd, onCancel }: { line: LineRef; onAdd: (c: ReviewComment) => void; onCancel: () => void }) {
  const [text, setText] = useState('');
  return (
    <form
      className="comment-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) onAdd({ ...line, text: text.trim() });
      }}
    >
      <span className="comment-line" aria-hidden="true">
        Comment on line {line.line}
      </span>
      <textarea
        aria-label={`Comment on ${line.path} line ${line.line}`}
        value={text}
        rows={2}
        autoFocus
        onChange={(e) => setText(e.target.value)}
      />
      <div className="actions">
        <button className="primary" disabled={!text.trim()}>
          Add comment
        </button>
        <button type="button" className="quiet" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function ReviewBar(props: {
  comments: ReviewComment[];
  chats: Chat[];
  state: State;
  target: string;
  onTarget: (chatId: string) => void;
  sentTo: string | undefined;
  onSent: (chatId: string) => void;
}) {
  const { comments, chats, state, target } = props;
  const { error, busy, run } = useAction();
  const send = () => run(async () => (await client.sendReview(target, comments), props.onSent(target)));
  const phone = useMediaQuery(PHONE_QUERY);
  if (!comments.length)
    return (
      <section className="review-bar idle" aria-label="Review">
        {props.sentTo ? (
          <a href={`#/chat/${props.sentTo}`}>Sent to {chatLabel(state, props.sentTo)}</a>
        ) : (
          <span className="hint">{phone ? 'Tap' : 'Click'} a line to comment on it.</span>
        )}
        {error && <p className="error">{error}</p>}
      </section>
    );
  return (
    <section className="review-bar" aria-label="Review">
      <span className="review-count">
        {comments.length} comment{comments.length === 1 ? '' : 's'}
      </span>
      <label>
        <span className="field-label">Send to</span>
        <select value={target} onChange={(e) => props.onTarget(e.target.value)}>
          {chats.map((c) => (
            <option key={c.id} value={c.id}>
              {chatLabel(state, c.id)}
            </option>
          ))}
        </select>
      </label>
      <button className="primary" disabled={busy || !comments.length || !target} onClick={send}>
        Send comments
      </button>
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function fileAnchor(path: string): string {
  return `diff-file-${path.replace(/[^\w-]/g, '_')}`;
}

const ACTION_LABELS = { discard: 'Discard', commit: 'Commit', open_pr: 'Open PR', merge: 'Merge', push: 'Push', pull: 'Pull' } as const;

function DiffActions(props: {
  workspace: Workspace;
  chat: Chat | undefined;
  note: DiffActionNote | undefined;
  pending: { result: DiffActionResult; seq: number } | undefined;
  onAction: (result: DiffActionResult) => void;
}) {
  const { workspace, chat, note, pending } = props;
  const [message, setMessage] = useState('');
  const { error, busy, run } = useAction();
  const commit = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(async () => props.onAction(await client.commit(workspace.id, message.trim())))) setMessage('');
  };
  const waiting = pending && (!note || note.seq <= pending.seq);
  const status = waiting
    ? `${ACTION_LABELS[pending.result.action]} is waiting for your approval in the topic’s chat`
    : note && `${ACTION_LABELS[note.action]} ${note.state}: ${note.detail}`;
  return (
    <section className="diff-actions" aria-label="Diff actions">
      <form onSubmit={commit}>
        <input aria-label="Commit message" value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Commit message" required />
        <button disabled={busy}>Commit</button>
      </form>
      <button disabled={busy} onClick={() => run(async () => props.onAction(await client.openPullRequest(workspace.id)))}>
        Open PR
      </button>
      {chat?.worktreePath && (
        <button disabled={busy} onClick={() => run(async () => props.onAction(await client.mergeBack(chat.id)))}>
          Merge into workspace
        </button>
      )}
      {status && (
        <p className={`action-status ${waiting ? 'pending' : note?.state}`} role="status">
          {status}
        </p>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
