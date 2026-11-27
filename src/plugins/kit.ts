import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { systemClock } from '../adapters/clock.js';
import { SNAG_KINDS, RESOLVED_STATES } from '../snags/types.js';
import type { AgentSession, AgentSink } from '../adapters/agent-runtime.js';
import { fromPlugin } from '../harnesses/setup.js';
import { loadSources, type PluginReport } from './loader.js';
import { harnessProblem } from './registry.js';
import type { CalendarSource, CaptureSource, HarnessSource, NotifierSource, PluginModule, SnagRecord, SnagSource, Source, TasksSource } from './types.js';

export interface KitCheck {
  kind: string;
  label: string;
  check: string;
  ok: boolean;
  detail?: string;
}

export interface KitResult {
  ok: boolean;
  plugin: PluginReport | null;
  checks: KitCheck[];
}

export interface KitOptions {
  options?: Record<string, unknown>;
  write?: boolean;
  dataDir?: string;
  brainDir?: string;
  timeoutMs?: number;
}

export async function runKit(target: string | PluginModule, opts: KitOptions = {}): Promise<KitResult> {
  const scratch = mkdtempSync(join(tmpdir(), 'hos-plugin-kit-'));
  const dataDir = opts.dataDir ?? join(scratch, 'data');
  const brainDir = opts.brainDir ?? join(scratch, 'brain');
  const loaded =
    typeof target === 'string'
      ? await loadSources([{ file: target, options: opts.options ?? {} }], { dataDir, brainDir, clock: systemClock, pluginsDir: dirname(target), timeoutMs: opts.timeoutMs, log: () => {} })
      : await loadSources([], { dataDir, brainDir, clock: systemClock, timeoutMs: opts.timeoutMs, log: () => {} }, [{ ...target, register: (host) => target.register({ ...host, options: opts.options ?? {} }) }]);
  const plugin = loaded.reports[0] ?? null;
  const checks: KitCheck[] = [];
  try {
    if (!plugin || plugin.problem) return { ok: false, plugin, checks };
    for (const { source } of loaded.sources.all()) checks.push(...(await checkSource(source, !!opts.write)));
    if (!checks.length) checks.push({ kind: '-', label: plugin.name ?? '-', check: 'provides at least one source', ok: false });
  } finally {
    for (const { source } of loaded.sources.harnesses) source.runtime.dispose?.();
    await loaded.close();
    rmSync(scratch, { recursive: true, force: true });
  }
  return { ok: checks.every((c) => c.ok), plugin, checks };
}

export async function checkSource(source: Source, write: boolean): Promise<KitCheck[]> {
  const checks: KitCheck[] = [];
  const check = async (name: string, run: () => Promise<string | void> | string | void) => {
    try {
      const detail = await run();
      checks.push({ kind: source.kind, label: source.label, check: name, ok: true, ...(detail ? { detail } : {}) });
    } catch (error) {
      checks.push({ kind: source.kind, label: source.label, check: name, ok: false, detail: (error as Error).message });
    }
  };
  switch (source.kind) {
    case 'tasks':
      await tasksChecks(source as TasksSource, write, check);
      break;
    case 'capture':
      if (write) await check('capture() takes a line', async () => result(await (source as CaptureSource).capture('hos plug-in kit: capture check')));
      else await check('capture() exists (run with --write to call it)', () => {});
      break;
    case 'calendar':
      await calendarChecks(source as CalendarSource, check);
      break;
    case 'snags':
      await snagChecks(source as SnagSource, write, check);
      break;
    case 'notifier':
      if (write) await check('push() takes a desk screen', () => (source as NotifierSource).push({ generated_at: new Date().toISOString(), waiting: [], running: [], open_snags: 0 }));
      else await check('push() exists (run with --write to call it)', () => {});
      break;
    case 'harness':
      await harnessChecks(source as HarnessSource, write, check);
      break;
    default:
      await check('kind is known to this kit', () => {
        throw new Error(`the kit has no checks for ${source.kind}`);
      });
  }
  return checks;
}

type Check = (name: string, run: () => Promise<string | void> | string | void) => Promise<void>;

async function tasksChecks(source: TasksSource, write: boolean, check: Check): Promise<void> {
  let ids: string[] = [];
  await check('today() returns a task list', async () => {
    const today = await source.today();
    assert(typeof today.available === 'boolean', 'available is not a boolean');
    assert(Array.isArray(today.tasks), 'tasks is not a list');
    for (const task of today.tasks) {
      assert(typeof task.id === 'string' && !!task.id, 'a task has no string id');
      assert(typeof task.title === 'string', `task ${task.id} has no string title`);
      assert(task.due === null || (typeof task.due === 'string' && /^\d{2}:\d{2}$/.test(task.due)), `task ${task.id} due is not null or HH:MM`);
    }
    ids = today.tasks.map((t) => t.id);
    return today.available ? `${today.tasks.length} open` : `unavailable: ${today.error ?? 'no reason'}`;
  });
  if (!write) return;
  let id = '';
  await check('addLinked() returns an id that today() lists', async () => {
    const added = await source.addLinked('hos plug-in kit: linked task', 'normal', 'http://127.0.0.1/#/topic/kit');
    assert(added.ok, `addLinked failed: ${added.ok ? '' : added.reason}`);
    id = (added as { id: string }).id;
    assert(typeof id === 'string' && !!id && !ids.includes(id), 'addLinked returned no new string id');
    assert((await source.today()).tasks.some((t) => t.id === id), `today() does not list ${id}`);
  });
  await check('setPriority() changes it', async () => result(await source.setPriority(id, 'high')));
  await check('done() closes it', async () => {
    result(await source.done(id));
    assert(!(await source.today()).tasks.some((t) => t.id === id), `today() still lists ${id} after done()`);
  });
  await check('drop() closes another one', async () => {
    const added = await source.addLinked('hos plug-in kit: dropped task', 'low', null);
    assert(added.ok, 'addLinked failed');
    const other = (added as { id: string }).id;
    result(await source.drop(other));
    assert(!(await source.today()).tasks.some((t) => t.id === other), `today() still lists ${other} after drop()`);
  });
}

async function calendarChecks(source: CalendarSource, check: Check): Promise<void> {
  await check('today() returns events', async () => {
    const day = await source.today();
    assert(typeof day.available === 'boolean', 'available is not a boolean');
    assert(Array.isArray(day.events), 'events is not a list');
    for (const event of day.events) assert(typeof event.time === 'string' && typeof event.title === 'string', 'an event needs a string time and title');
    return day.available ? `${day.events.length} events` : `unavailable: ${day.error ?? 'no reason'}`;
  });
  if (source.link !== undefined) await check('link is an http(s) URL', () => assert(/^https?:\/\//.test(source.link!), `${source.link} is not an http(s) URL`));
  if (!source.now) return;
  await check('now() returns time blocks', async () => {
    const now = await source.now!();
    assert(typeof now.available === 'boolean', 'available is not a boolean');
    if (!now.now) return now.available ? 'no block now' : `unavailable: ${now.error ?? 'no reason'}`;
    for (const block of [now.now.prev, now.now.current, now.now.next]) {
      if (block) assert(/^\d{2}:\d{2}$/.test(block.start) && /^\d{2}:\d{2}$/.test(block.end) && typeof block.label === 'string', 'a block needs HH:MM start and end and a label');
    }
    return now.now.current ? `now: ${now.now.current.label}` : 'free time';
  });
}

async function snagChecks(source: SnagSource, write: boolean, check: Check): Promise<void> {
  await check('status() reports offline and queued', () => {
    const status = source.status();
    assert(typeof status.offline === 'boolean' && Number.isInteger(status.queued), 'status() needs {offline: boolean, queued: integer}');
  });
  await check('list() returns snag records', async () => {
    const rows = await source.list();
    assert(Array.isArray(rows), 'list() did not return a list');
    rows.forEach(snagShape);
    return `${rows.length} snags`;
  });
  if (!write) return;
  let ref = 0;
  await check('add() returns a record get() finds', async () => {
    const row = await source.add({ kind: 'fix', text: 'hos plug-in kit: snag check', created_by: 'you', source_host: 'kit', context: null }, []);
    snagShape(row);
    ref = row.ref;
    assert((await source.get(ref)).text === 'hos plug-in kit: snag check', 'get() returned other text');
  });
  await check('change(update) edits the text', async () => assert((await source.change(ref, { type: 'update', text: 'hos plug-in kit: edited' }))?.text === 'hos plug-in kit: edited', 'text not changed'));
  await check('comment() adds to the thread', async () => assert(!!(await source.comment(ref, 'kit comment', 'claude')).comments?.some((c) => c.body === 'kit comment'), 'comment not in the thread'));
  await check('change(resolve) and change(reopen)', async () => {
    assert((await source.change(ref, { type: 'resolve', state: 'wontfix', note: 'kit', by: 'you' }))?.state === 'wontfix', 'not resolved');
    assert((await source.change(ref, { type: 'reopen' }))?.state === 'open', 'not reopened');
  });
  await check('change(delete) removes it', async () => {
    assert((await source.change(ref, { type: 'delete' })) === null, 'delete should return null');
    const gone = await source.get(ref).then(
      () => false,
      () => true,
    );
    assert(gone, `get(${ref}) still finds it after delete`);
  });
}

export const HARNESS_TURN_MS = 120_000;
const KIT_PROMPT = 'This is the hos plug-in kit checking that you answer. Reply with the single word OK and use no tools.';

async function harnessChecks(source: HarnessSource, write: boolean, check: Check): Promise<void> {
  await check('id, models and runtime have the harness shape', () => {
    const problem = harnessProblem(source as unknown as Record<string, unknown>);
    if (problem) throw new Error(problem);
    return `${source.id} · ${source.models().list.length} models · default ${source.models().default}`;
  });
  await check('features it declares', () => {
    const on = Object.entries(fromPlugin(source).features).filter(([, v]) => v).map(([k]) => k);
    const extra = [source.runtime.loginCommand ? 'login' : '', source.runtime.signedIn ? 'sign-in check' : ''].filter(Boolean);
    return [...on, ...extra].join(', ') || 'none (hos hides Take over, browser, context refresh and usage limits for it)';
  });
  if (source.runtime.signedIn) await check('signedIn() answers', async () => ((await source.runtime.signedIn!()) ? 'signed in' : 'not signed in'));
  if (!write) {
    await check('one chat turn (run with --write to start the agent for real)', () => {});
    return;
  }
  await check('one chat turn emits the events hos needs', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'hos-harness-kit-'));
    const seen: string[] = [];
    let session: AgentSession | undefined;
    try {
      const done = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no turn.completed within ${HARNESS_TURN_MS / 1000} s; saw ${seen.join(' ') || 'nothing'}`)), HARNESS_TURN_MS);
        const sink: AgentSink = {
          event(event) {
            seen.push(event.type);
            if (event.type === 'error') {
              clearTimeout(timer);
              reject(new Error(`error event: ${event.message}`));
            }
            if (event.type === 'turn.completed') {
              clearTimeout(timer);
              resolve();
            }
          },
          beforeTool: async () => undefined,
          permission: async () => 'deny',
          needsDecision: () => true,
          beforeTurn: () => undefined,
          refuse: () => undefined,
          beforeStop: () => undefined,
          beforeCompact: () => undefined,
        };
        void source.runtime
          .start({ chatId: 'kit', cwd, extraDirs: [], env: {}, compactAt: 0 }, sink)
          .then((started) => {
            session = started;
            started.send(KIT_PROMPT);
          }, reject);
      });
      await done;
      for (const needed of ['context.loaded', 'turn.started', 'message.completed', 'turn.completed']) assert(seen.includes(needed), `no ${needed} event; saw ${seen.join(' ')}`);
      return `${seen.length} events, session ${session?.nativeId ?? '?'}`;
    } finally {
      await session?.stop().catch(() => {});
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}

function snagShape(row: SnagRecord): void {
  assert(Number.isInteger(row.ref) && row.ref !== 0, 'a snag needs a non-zero integer ref');
  assert(SNAG_KINDS.includes(row.kind), `S${row.ref} kind ${String(row.kind)} is not ${SNAG_KINDS.join(', ')}`);
  assert(row.state === 'open' || RESOLVED_STATES.includes(row.state as never), `S${row.ref} state ${String(row.state)} is not known`);
  assert(typeof row.text === 'string' && Array.isArray(row.files) && Array.isArray(row.links), `S${row.ref} needs text, files and links`);
  assert(!Number.isNaN(Date.parse(row.created_at)), `S${row.ref} created_at is not a date`);
}

function result(value: { ok: boolean; error?: string }): void {
  assert(value.ok, value.error ?? 'returned ok: false');
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function kitReport(file: string, result: KitResult): string {
  const lines = [`plug-in ${basename(file)}: ${result.plugin?.name ?? 'did not load'}`];
  if (result.plugin?.problem) lines.push(`FAIL load: ${result.plugin.problem}`);
  for (const c of result.checks) lines.push(`${c.ok ? 'PASS' : 'FAIL'} ${c.kind} "${c.label}" · ${c.check}${c.detail ? ` · ${c.detail}` : ''}`);
  lines.push(result.ok ? 'all checks passed' : 'some checks failed');
  return lines.join('\n');
}
