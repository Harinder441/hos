import { useEffect, useState, type FormEvent } from 'react';
import type { Task, TaskPatch, TaskPriority, TaskState } from '../../../src/api/types.js';
import { client, useAction } from '../lib.js';
import { ShapeMark, type SignShape } from '../shell/icons.js';
import { MoreButton, useMenu, type MenuItem } from '../shell/Menu.js';
import type { State } from '../state.js';
import { useOwner } from './catalog.js';

const ACTIVE: TaskState[] = ['open', 'claimed', 'review', 'blocked'];
const SHAPE: Record<TaskState, SignShape> = {
  proposed: 's-queued',
  open: 's-queued',
  claimed: 's-go',
  review: 's-needs',
  blocked: 's-stop',
  done: 's-rest',
  dropped: 's-rest',
};
const LABEL: Record<TaskState, string> = {
  proposed: 'proposed',
  open: 'open',
  claimed: 'claimed',
  review: 'review',
  blocked: 'blocked on you',
  done: 'done',
  dropped: 'dropped',
};
const MIN_EVIDENCE = 4;

const ordered = (tasks: Task[]) => [...tasks].sort((a, b) => a.priority - b.priority || a.rank - b.rank || a.createdAt - b.createdAt);
const when = (yes: boolean, ...items: MenuItem[]) => (yes ? items : []);

export const activeTasks = (tasks: Task[]) => tasks.filter((task) => ACTIVE.includes(task.state));

export function useTopicTasks(topicId: string, state: State): Task[] {
  const [fetched, setFetched] = useState<Task[]>([]);
  useEffect(() => {
    let live = true;
    client.listTasks(topicId).then(
      (list) => live && setFetched(list),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [topicId]);
  const byRef = new Map(fetched.map((task) => [task.ref, task]));
  for (const task of Object.values(state.tasks)) if (task.topicId === topicId) byRef.set(task.ref, task);
  return [...byRef.values()];
}

export function TasksPanel({ topicId, tasks, adding, onAdded }: { topicId: string; tasks: Task[]; adding: boolean; onAdded: () => void }) {
  const [openRef, setOpenRef] = useState<string>();
  const active = ordered(activeTasks(tasks));
  const proposed = ordered(tasks.filter((task) => task.state === 'proposed'));
  const done = ordered(tasks.filter((task) => task.state === 'done'));
  const counted = tasks.filter((task) => task.state !== 'proposed' && task.state !== 'dropped').length;
  const row = (task: Task) => (
    <TaskRow
      key={task.ref}
      topicId={topicId}
      task={task}
      open={openRef === task.ref}
      onToggle={() => setOpenRef(openRef === task.ref ? undefined : task.ref)}
      onDone={() => setOpenRef(undefined)}
    />
  );
  return (
    <div className="panel-body tasks">
      {adding && (
        <AddTask
          topicId={topicId}
          onAdded={(ref) => {
            setOpenRef(ref);
            onAdded();
          }}
          onCancel={onAdded}
        />
      )}
      {tasks.length === 0 ? (
        <p className="panel-none">No tasks yet. Add one with +, or a chat adds them as it plans.</p>
      ) : (
        <>
          <div className="tasks-sum">
            <span>
              {done.length}/{counted} done
            </span>
            <span className="tasks-bar" aria-hidden="true">
              <i style={{ width: `${counted ? (done.length / counted) * 100 : 0}%` }} />
            </span>
          </div>
          {active.length > 0 && (
            <ul className="tasks-list" aria-label="Active tasks">
              {active.map(row)}
            </ul>
          )}
          <details className="tasks-fold">
            <summary>Proposed {proposed.length}</summary>
            <ul aria-label="Proposed tasks">{proposed.map(row)}</ul>
          </details>
          <details className="tasks-fold done">
            <summary>Done {done.length}</summary>
            <ul aria-label="Done tasks">{done.map(row)}</ul>
          </details>
        </>
      )}
    </div>
  );
}

function AddTask({ topicId, onAdded, onCancel }: { topicId: string; onAdded: (ref: string) => void; onCancel: () => void }) {
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState<TaskPriority>(2);
  const [hint, setHint] = useState<string>();
  const { error, busy, run } = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const text = title.trim();
    if (text.split(/\s+/).length < 4) return setHint('Looks like a step, not a task: write the outcome');
    setHint(undefined);
    void run(async () => onAdded((await client.addTask(topicId, { title: text, priority })).ref));
  };
  return (
    <form className="tasks-add" aria-label="Add a task" onSubmit={submit} onKeyDown={(e) => e.key === 'Escape' && onCancel()}>
      <div className="tasks-add-row">
        <input aria-label="Task title" autoFocus value={title} placeholder="Outcome, e.g. Usage limits enforced per shop" onChange={(e) => setTitle(e.target.value)} />
        <select aria-label="Priority" title="Task priority, P1 is highest" value={priority} onChange={(e) => setPriority(Number(e.target.value) as TaskPriority)}>
          {[1, 2, 3].map((p) => (
            <option key={p} value={p}>
              P{p}
            </option>
          ))}
        </select>
        <button className="btn go" disabled={busy}>
          Add
        </button>
      </div>
      {(hint ?? error) && (
        <p className={hint ? 'tasks-hint' : 'error'} role="alert">
          {hint ?? error}
        </p>
      )}
    </form>
  );
}

function TaskRow({ topicId, task, open, onToggle, onDone }: { topicId: string; task: Task; open: boolean; onToggle: () => void; onDone: () => void }) {
  const { error, busy, run } = useAction();
  const name = useOwner()?.name;
  const patch = (body: TaskPatch) => run(() => client.updateTask(topicId, task.ref, body));
  const link = (on: boolean) => void run(() => client.linkTask(topicId, task.ref, on));
  const drop = () => {
    const reason = window.prompt(`Why drop ${task.ref}?`);
    if (reason !== null) void patch({ state: 'dropped', ...(reason.trim() ? { reason: reason.trim() } : {}) });
  };
  const block = () => {
    const question = window.prompt(`What does ${task.ref} need from ${name ?? 'you'}?`)?.trim();
    if (question) void patch({ state: 'blocked', question });
  };
  const live = ACTIVE.includes(task.state);
  const settled = task.state === 'done' || task.state === 'dropped';
  const menu = useMenu(`Task ${task.ref}`, [
    { label: 'Priority', choices: ([1, 2, 3] as const).map((p) => ({ label: `P${p}`, on: task.priority === p, onSelect: () => void patch({ priority: p }) })) },
    ...when(live, { label: 'Move up', onSelect: () => void patch({ move: 'up' }) }, { label: 'Move down', onSelect: () => void patch({ move: 'down' }) }),
    'separator',
    task.mirrorId ? { label: 'Remove from my tasks', onSelect: () => link(false) } : { label: 'Add to my tasks', onSelect: () => link(true) },
    'separator',
    ...when(task.state === 'proposed', { label: 'Accept', onSelect: () => void patch({ state: 'open' }) }),
    ...when(task.state === 'claimed', { label: 'Send to review', onSelect: () => void patch({ state: 'review' }) }),
    ...when(task.state === 'open' || task.state === 'claimed', { label: name ? `Ask ${name} (blocked)` : 'Blocked on you', onSelect: block }),
    { label: `Copy ${task.ref}`, onSelect: () => void navigator.clipboard.writeText(task.ref).catch(() => {}) },
    ...when(!settled, 'separator', { label: 'Drop task…', danger: true, onSelect: drop }),
  ]);
  return (
    <li className={`task${open ? ' open' : ''}`} aria-label={`${task.ref} ${task.title}`}>
      <div className="task-row">
        <button type="button" className="task-main" aria-expanded={open} title={`${LABEL[task.state].charAt(0).toUpperCase()}${LABEL[task.state].slice(1)}: ${task.title.split('\n')[0]}`} onClick={onToggle}>
          <span className={`task-pri mono${task.priority === 1 ? ' p1' : ''}`}>P{task.priority}</span>
          <ShapeMark shape={SHAPE[task.state]} />
          <span className="sr">{LABEL[task.state]}</span>
          <span className="task-title">{task.title.split('\n')[0]}</span>
          {task.mirrorId && (
            <span className="task-lo mono" title="In my tasks">
              M
            </span>
          )}
          <span className="task-ref mono">{task.ref}</span>
        </button>
        <MoreButton label={`More for ${task.ref}`} tip="More actions for this task" menu={menu} />
      </div>
      {menu.element}
      {error && <p className="error task-error">{error}</p>}
      {open && <TaskDetail task={task} busy={busy} patch={patch} drop={drop} onDone={onDone} />}
    </li>
  );
}

function TaskDetail(props: { task: Task; busy: boolean; patch: (body: TaskPatch) => Promise<boolean>; drop: () => void; onDone: () => void }) {
  const { task, busy, patch } = props;
  const [evidence, setEvidence] = useState(task.evidence ?? '');
  const live = task.state === 'claimed' || task.state === 'review';
  const ready = task.criteria.every((c) => c.met) && evidence.trim().length >= MIN_EVIDENCE;
  const facts = [
    LABEL[task.state],
    task.claimedBy && `claimed by chat ${task.claimedBy.slice(0, 8)}`,
    task.dependsOn.length > 0 && `after ${task.dependsOn.join(', ')}`,
    task.fromSnag && `from snag ${task.fromSnag}`,
    task.discoveredFrom && `found while doing ${task.discoveredFrom}`,
  ].filter(Boolean);
  const finish = async () => {
    if (await patch({ state: 'done', evidence: evidence.trim() })) props.onDone();
  };
  return (
    <div className="task-detail" role="group" aria-label={`${task.ref} details`}>
      <p className="muted">{facts.join(' · ')}</p>
      {task.state === 'blocked' && task.question && (
        <>
          <p className="task-l">Question for you</p>
          <p>{task.question}</p>
        </>
      )}
      {task.criteria.length > 0 && <p className="task-l">Done when</p>}
      {task.criteria.map((criterion, index) => (
        <label key={index} className="task-check">
          <input type="checkbox" checked={criterion.met} disabled={!live || busy} onChange={(e) => void patch({ check: { index, met: e.target.checked } })} />
          {criterion.text}
        </label>
      ))}
      {task.state === 'done' && task.evidence && (
        <>
          <p className="task-l">Evidence</p>
          <p className="mono">{task.evidence}</p>
        </>
      )}
      {live && (
        <label className="task-evidence">
          <span className="task-l">Evidence</span>
          <input value={evidence} placeholder="commit sha, test run or file path" onChange={(e) => setEvidence(e.target.value)} />
        </label>
      )}
      <div className="task-acts">
        {task.state === 'proposed' && (
          <>
            <button type="button" className="btn go" disabled={busy} onClick={() => void patch({ state: 'open' })}>
              Accept
            </button>
            <button type="button" className="btn" title="Reject this proposed task" disabled={busy} onClick={props.drop}>
              Drop
            </button>
          </>
        )}
        {task.state === 'blocked' && (
          <button type="button" className="btn go" title="Mark answered; the task resumes" disabled={busy} onClick={() => void patch({ state: task.claimedBy ? 'claimed' : 'open' })}>
            Answered → back to work
          </button>
        )}
        {live && (
          <button type="button" className="btn go" disabled={!ready || busy} onClick={() => void finish()}>
            Done
          </button>
        )}
      </div>
    </div>
  );
}
