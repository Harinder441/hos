import { join } from 'node:path';
import type { CommentAuthor } from '../snags/types.js';
import type { CaptureSource, PluginDatabase, PluginHost, PluginModule, Priority, SnagRecord, SnagSource, SourceResult, TasksSource } from './types.js';

export const LOCAL_LABEL = 'This computer';
const TITLE_MAX = 500;
const PRIORITIES: Priority[] = ['high', 'normal', 'low'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS user_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  link TEXT,
  state TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE TABLE IF NOT EXISTS snags (
  ref INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  files TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  source_host TEXT,
  resolved_at TEXT,
  resolved_by TEXT,
  note TEXT,
  links TEXT NOT NULL DEFAULT '[]',
  context TEXT
);
CREATE TABLE IF NOT EXISTS snag_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref INTEGER NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

interface SnagRow {
  ref: number;
  kind: SnagRecord['kind'];
  text: string;
  files: string;
  state: SnagRecord['state'];
  created_at: string;
  created_by: string;
  source_host: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  note: string | null;
  links: string;
  context: string | null;
}

interface CommentRow {
  id: number;
  ref: number;
  author: CommentAuthor;
  body: string;
  created_at: string;
}

export const localPlugin: PluginModule = {
  name: 'local',
  apiVersion: 1,
  register(host) {
    let db: PluginDatabase | null = null;
    const open = () => {
      if (!db) {
        db = host.sqlite('local-store.db');
        db.exec(SCHEMA);
      }
      return db;
    };
    const close = () => {
      db?.close();
      db = null;
    };
    host.provide(localTasks(host, open, close));
    host.provide(localCapture(host, open));
    host.provide(localSnags(host, open, close));
  },
};

function localTasks(host: PluginHost, db: () => PluginDatabase, close: () => void): TasksSource {
  const closeTask = (id: string, state: 'done' | 'dropped'): SourceResult => {
    const changed = /^\d{1,12}$/.test(id) ? db().prepare("UPDATE user_tasks SET state = ?, closed_at = ? WHERE id = ? AND state = 'open'").run(state, iso(host), Number(id)).changes : 0;
    return changed ? { available: true, ok: true } : { available: true, ok: false, error: `there is no open task ${id}` };
  };
  return {
    kind: 'tasks',
    version: 1,
    label: LOCAL_LABEL,
    async today() {
      const rows = db()
        .prepare("SELECT id, title, link FROM user_tasks WHERE state = 'open' ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, id")
        .all() as Array<{ id: number; title: string; link: string | null }>;
      return { available: true, tasks: rows.map((row) => ({ id: String(row.id), title: row.title, due: null, link: row.link })) };
    },
    async done(id) {
      return closeTask(id, 'done');
    },
    async drop(id) {
      return closeTask(id, 'dropped');
    },
    async addLinked(title, priority, link) {
      const clean = title.trim().slice(0, TITLE_MAX);
      if (!clean) return { ok: false, reason: 'a task needs a title' };
      const row = db().prepare('INSERT INTO user_tasks (title, priority, link, created_at) VALUES (?, ?, ?, ?)').run(clean, priority, link, iso(host));
      return { ok: true, id: String(row.lastInsertRowid) };
    },
    async setPriority(id, priority) {
      if (!PRIORITIES.includes(priority)) throw host.fail(400, 'priority is high, normal or low');
      const changed = /^\d{1,12}$/.test(id) ? db().prepare('UPDATE user_tasks SET priority = ? WHERE id = ?').run(priority, Number(id)).changes : 0;
      return changed ? { available: true, ok: true } : { available: true, ok: false, error: `there is no task ${id}` };
    },
    close,
  };
}

function localCapture(host: PluginHost, db: () => PluginDatabase): CaptureSource {
  return {
    kind: 'capture',
    version: 1,
    label: LOCAL_LABEL,
    async capture(text) {
      const title = text.trim();
      if (!title) throw host.fail(400, 'text is required');
      if (title.length > TITLE_MAX) throw host.fail(400, `text must be at most ${TITLE_MAX} characters`);
      db().prepare('INSERT INTO user_tasks (title, created_at) VALUES (?, ?)').run(title, iso(host));
      return { available: true, ok: true };
    },
  };
}

function localSnags(host: PluginHost, db: () => PluginDatabase, close: () => void): SnagSource {
  const comments = (ref?: number): Map<number, CommentRow[]> => {
    const rows = (ref === undefined ? db().prepare('SELECT * FROM snag_comments ORDER BY id').all() : db().prepare('SELECT * FROM snag_comments WHERE ref = ? ORDER BY id').all(ref)) as CommentRow[];
    const byRef = new Map<number, CommentRow[]>();
    for (const row of rows) byRef.set(row.ref, [...(byRef.get(row.ref) ?? []), row]);
    return byRef;
  };
  const record = (row: SnagRow, thread: CommentRow[] = []): SnagRecord => ({
    ref: row.ref,
    kind: row.kind,
    text: row.text,
    files: (JSON.parse(row.files) as string[]).map((name) => ({ name })),
    state: row.state,
    created_at: row.created_at,
    created_by: row.created_by,
    source_host: row.source_host,
    resolved_at: row.resolved_at,
    resolved_by: row.resolved_by,
    note: row.note,
    links: JSON.parse(row.links) as SnagRecord['links'],
    context: row.context,
    comments: thread.map((c) => ({ id: String(c.id), author: c.author, body: c.body, created_at: c.created_at })),
    last_comment_author: thread.at(-1)?.author ?? null,
  });
  const get = (ref: number): SnagRecord => {
    const row = ref > 0 ? (db().prepare('SELECT * FROM snags WHERE ref = ?').get(ref) as SnagRow | undefined) : undefined;
    if (!row) throw host.fail(404, `there is no snag S${ref < 0 ? `?${-ref}` : ref}`);
    return record(row, comments(ref).get(ref));
  };
  return {
    kind: 'snags',
    version: 1,
    label: LOCAL_LABEL,
    status: () => ({ offline: false, queued: 0 }),
    async list() {
      const threads = comments();
      return (db().prepare('SELECT * FROM snags ORDER BY ref DESC').all() as SnagRow[]).map((row) => record(row, threads.get(row.ref)));
    },
    async get(ref) {
      return get(ref);
    },
    async find(ref) {
      return get(ref);
    },
    async add(snag, files) {
      if (files.length && !host.brainDir) throw host.fail(400, 'hos has no brain (start it with --brain), so there is nowhere to keep snag files');
      // The row names its files only once they are on disk, so a Snags page loading meanwhile never asks for a missing one.
      const ref = Number(
        db()
          .prepare('INSERT INTO snags (kind, text, files, created_at, created_by, source_host, context) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(snag.kind, snag.text, '[]', iso(host), snag.created_by, snag.source_host, snag.context).lastInsertRowid,
      );
      try {
        await host.snagFiles.save(ref, files);
        db().prepare('UPDATE snags SET files = ? WHERE ref = ?').run(JSON.stringify(files.map((f) => f.name)), ref);
      } catch (error) {
        db().prepare('DELETE FROM snags WHERE ref = ?').run(ref);
        throw error;
      }
      return get(ref);
    },
    async change(ref, change) {
      const row = get(ref);
      const at = iso(host);
      switch (change.type) {
        case 'resolve':
          db().prepare('UPDATE snags SET state = ?, note = ?, resolved_at = ?, resolved_by = ? WHERE ref = ?').run(change.state, change.note, at, change.by, ref);
          break;
        case 'reopen':
          db().prepare("UPDATE snags SET state = 'open', note = NULL, resolved_at = NULL, resolved_by = NULL WHERE ref = ?").run(ref);
          break;
        case 'link':
          db().prepare('UPDATE snags SET links = ? WHERE ref = ?').run(JSON.stringify([...row.links, { topicId: change.topicId, chatId: change.chatId, at }]), ref);
          break;
        case 'update':
          db().prepare('UPDATE snags SET text = ? WHERE ref = ?').run(change.text, ref);
          break;
        case 'delete':
          db().transaction(() => {
            db().prepare('DELETE FROM snag_comments WHERE ref = ?').run(ref);
            db().prepare('DELETE FROM snags WHERE ref = ?').run(ref);
          })();
          await host.snagFiles.remove(ref);
          return null;
      }
      return get(ref);
    },
    async comment(ref, body, author) {
      get(ref);
      db().prepare('INSERT INTO snag_comments (ref, author, body, created_at) VALUES (?, ?, ?, ?)').run(ref, author, body, iso(host));
      return get(ref);
    },
    async localFile(row, name) {
      return join(host.snagFiles.dir(row.ref), name);
    },
    close,
  };
}

function iso(host: PluginHost): string {
  return new Date(host.now()).toISOString();
}
