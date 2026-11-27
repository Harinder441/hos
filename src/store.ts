import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type {
  ActionRun,
  Approval,
  Chat,
  ChatLink,
  ChatResult,
  KillSwitch,
  LinkKind,
  ChatState,
  Creator,
  EventBody,
  Handoff,
  HosEvent,
  InboxItem,
  Lock,
  OutboxItem,
  Project,
  PushDevice,
  PushTarget,
  Task,
  Topic,
  TopicHistoryFact,
  Workspace,
  Worktree,
} from './api/types.js';
import { eventSummary } from './summary.js';
import type { Canvas } from './canvas/types.js';

const TOPICS_TABLE = `CREATE TABLE IF NOT EXISTS topics (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status_topic TEXT,
  state TEXT NOT NULL,
  request TEXT,
  created_by TEXT NOT NULL DEFAULT 'human',
  created_by_chat TEXT,
  created_at INTEGER NOT NULL,
  daily_tokens INTEGER,
  weight INTEGER NOT NULL DEFAULT 1,
  last_seen_at INTEGER,
  last_activity_at INTEGER,
  naming INTEGER NOT NULL DEFAULT 0,
  tab_order TEXT,
  work_dir TEXT,
  home TEXT
);`;

export const DESK_META = 'desk.topic';
export const DESK_TITLE = 'Quick chats';
export const SCHEDULED_META = 'schedule.chat.';
export const LIMIT_RESUME_META = 'limit.resume.';
export const UI_FOLD_META = 'ui.fold';
const DISMISSED_PROJECTS_META = 'projects.dismissed';
const LEGACY_ROLES: Record<string, Chat['role']> = { librarian: 'main', root: 'main', planner: 'main', quarantine: 'scout' };

// SQLite uses the partial index only when a query repeats this exact term.
const HISTORY_EVENTS = "e.type IN ('topic.created', 'topic.updated', 'workspace.picked', 'bus.call')";

// The first delta of a thinking/message block places its timeline item; later deltas before the block's last completed only change text that completed replaces.
const SUPERSEDED_DELTAS = `SELECT seq FROM (
  SELECT seq, type LIKE '%.delta' AS delta,
    MIN(CASE WHEN type LIKE '%.delta' THEN seq END) OVER block AS first,
    MAX(CASE WHEN type LIKE '%.completed' THEN seq END) OVER block AS done
  FROM events WHERE seq > ? AND type IN ('message.delta', 'message.completed', 'thinking.delta', 'thinking.completed')
  WINDOW block AS (PARTITION BY chat_id, type LIKE 'message.%', coalesce(json_extract(body, '$.messageId'), json_extract(body, '$.thinkingId')))
) WHERE delta AND seq > first AND seq < done`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
${TOPICS_TABLE}
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  branch TEXT,
  base TEXT,
  setup_state TEXT NOT NULL,
  setup_log TEXT,
  archived_at INTEGER,
  created_by TEXT NOT NULL,
  created_by_chat TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS topic_workspaces (
  topic_id TEXT NOT NULL REFERENCES topics(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  attached_at INTEGER NOT NULL,
  PRIMARY KEY (topic_id, workspace_id)
);
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES topics(id),
  agent TEXT NOT NULL,
  state TEXT NOT NULL,
  native_session_id TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  chat_id TEXT REFERENCES chats(id),
  tool TEXT NOT NULL,
  decision TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  chat_id TEXT,
  body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS inbox (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  chat_id TEXT REFERENCES chats(id),
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  item TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS worktrees (
  path TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  created_by TEXT NOT NULL,
  created_by_chat TEXT,
  snapshot TEXT
);
CREATE TABLE IF NOT EXISTS passkeys (
  id TEXT PRIMARY KEY,
  rp_id TEXT NOT NULL,
  public_key BLOB NOT NULL,
  transports TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  rp_id TEXT NOT NULL,
  passkey_id TEXT NOT NULL REFERENCES passkeys(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_chat ON events(chat_id, seq);
CREATE INDEX IF NOT EXISTS events_topic_history ON events(type) WHERE ${HISTORY_EVENTS.replace('e.type', 'type')};
CREATE TABLE IF NOT EXISTS handoffs (
  id TEXT PRIMARY KEY,
  lineage_id TEXT NOT NULL,
  chat_id TEXT NOT NULL REFERENCES chats(id),
  generation INTEGER NOT NULL,
  successor_id TEXT,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  reason TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  boot_tokens INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS spawns (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES topics(id),
  parent_chat_id TEXT NOT NULL REFERENCES chats(id),
  client_request_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  chat_id TEXT NOT NULL REFERENCES chats(id),
  reserved_tokens INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (parent_chat_id, client_request_id)
);
CREATE TABLE IF NOT EXISTS notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL REFERENCES chats(id),
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER
);
CREATE INDEX IF NOT EXISTS notices_pending ON notices(chat_id, delivered_at);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  keys TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kill_switches (
  scope TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (scope, topic_id)
);
CREATE TABLE IF NOT EXISTS action_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  run TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS turn_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL REFERENCES chats(id),
  text TEXT NOT NULL,
  priority INTEGER NOT NULL,
  enqueued_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL REFERENCES chats(id),
  topic_id TEXT NOT NULL REFERENCES topics(id),
  agent TEXT NOT NULL,
  model TEXT,
  input INTEGER NOT NULL,
  output INTEGER NOT NULL,
  cache_read INTEGER NOT NULL,
  cache_creation INTEGER NOT NULL,
  tokens INTEGER NOT NULL,
  credits REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_time ON ledger(created_at);
CREATE TABLE IF NOT EXISTS locks (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES topics(id),
  chat_id TEXT NOT NULL REFERENCES chats(id),
  pattern TEXT NOT NULL,
  ttl_ms INTEGER NOT NULL,
  acquired_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  UNIQUE (chat_id, pattern)
);
CREATE TABLE IF NOT EXISTS tasks (
  topic_id TEXT NOT NULL REFERENCES topics(id),
  ref TEXT NOT NULL,
  title TEXT NOT NULL,
  depends_on TEXT NOT NULL,
  state TEXT NOT NULL,
  claimed_by TEXT,
  claimed_at INTEGER,
  limit_minutes INTEGER NOT NULL, -- 0 = no limit
  flagged INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_by_chat TEXT,
  created_at INTEGER NOT NULL,
  done_at INTEGER,
  PRIMARY KEY (topic_id, ref)
);
CREATE TABLE IF NOT EXISTS canvases (
  topic_id TEXT NOT NULL REFERENCES topics(id),
  ref TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  spec TEXT NOT NULL,
  layout TEXT NOT NULL,
  draft TEXT NOT NULL,
  open_blocks TEXT NOT NULL,
  feedback TEXT NOT NULL,
  submits TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (topic_id, ref)
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
  text,
  source UNINDEXED,
  key UNINDEXED,
  topic_id UNINDEXED,
  chat_id UNINDEXED
);
CREATE TABLE IF NOT EXISTS touched_files (
  topic_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  path TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  first_at INTEGER NOT NULL,
  PRIMARY KEY (topic_id, workspace_id, path)
);
CREATE TABLE IF NOT EXISTS pr_links (
  url TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES topics(id),
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  port INTEGER,
  review_chat_id TEXT REFERENCES chats(id),
  review_state TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pr_review_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL REFERENCES pr_links(url),
  ref TEXT NOT NULL,
  chat_id TEXT REFERENCES chats(id),
  text TEXT NOT NULL,
  sent_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS links (
  chat TEXT NOT NULL,
  target TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('chat', 'diagram')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (chat, target)
);
CREATE TABLE IF NOT EXISTS computers (
  name TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  url TEXT,
  token_hash TEXT,
  added_at INTEGER NOT NULL,
  last_seen INTEGER,
  hos_version TEXT,
  api_version INTEGER,
  caps TEXT,
  PRIMARY KEY (name, direction)
);
CREATE TABLE IF NOT EXISTS pair_codes (
  code_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE TABLE IF NOT EXISTS computer_topics (
  computer TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (computer, topic_id)
);
CREATE TABLE IF NOT EXISTS computer_outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  computer TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  from_chat_id TEXT,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

export interface ComputerRow {
  name: string;
  direction: 'in' | 'out';
  url: string | null;
  token_hash: string | null;
  added_at: number;
  last_seen: number | null;
  hos_version: string | null;
  api_version: number | null;
  caps: string | null;
}

export interface SearchRow {
  source: 'event';
  key: string;
  chatId: string | null;
  snippet: string;
}

// Older stores named the task-mirror columns after the one task app hos used to talk to.
const RENAMED_COLUMNS: Array<[table: string, from: string, to: string]> = [
  ['tasks', 'lifeos_id', 'mirror_id'],
  ['tasks', 'lifeos_auto', 'mirror_auto'],
];

const ADDED_COLUMNS: Array<[table: string, column: string, definition: string]> = [
  ['tasks', 'priority', 'INTEGER NOT NULL DEFAULT 2'],
  ['tasks', 'rank', 'INTEGER NOT NULL DEFAULT 0'],
  ['tasks', 'criteria', "TEXT NOT NULL DEFAULT '[]'"],
  ['tasks', 'evidence', 'TEXT'],
  ['tasks', 'question', 'TEXT'],
  ['tasks', 'from_snag', 'TEXT'],
  ['tasks', 'discovered_from', 'TEXT'],
  ['tasks', 'closed_by_chat', 'TEXT'],
  ['tasks', 'mirror_id', 'TEXT'],
  ['tasks', 'mirror_auto', 'INTEGER NOT NULL DEFAULT 0'],
  ['projects', 'key', 'TEXT'],
  ['projects', 'pinned', 'INTEGER NOT NULL DEFAULT 0'],
  ['projects', 'created_by', "TEXT NOT NULL DEFAULT 'human'"],
  ['projects', 'hidden', 'INTEGER NOT NULL DEFAULT 0'],
  ['projects', 'custom', 'INTEGER NOT NULL DEFAULT 0'],
  ['approvals', 'input', "TEXT NOT NULL DEFAULT ''"],
  ['approvals', 'action_class', 'TEXT'],
  ['approvals', 'outcome', "TEXT NOT NULL DEFAULT 'ask'"],
  ['approvals', 'reason', "TEXT NOT NULL DEFAULT ''"],
  ['approvals', 'via', 'TEXT'],
  ['approvals', 'decided_by', 'TEXT'],
  ['chats', 'nudged_at', 'INTEGER'],
  ['approvals', 'topic_id', 'TEXT'],
  ['approvals', 'workspace_id', 'TEXT'],
  ['chats', 'start_tree', 'TEXT'],
  ['chats', 'turn_tree', 'TEXT'],
  ['chats', 'turns', 'INTEGER NOT NULL DEFAULT 0'],
  ['chats', 'card', 'TEXT'],
  ['chats', 'card_turn', 'INTEGER'],
  ['chats', 'cross_chat_tokens', 'INTEGER NOT NULL DEFAULT 0'],
  ['chats', 'parent_id', 'TEXT'],
  ['chats', 'role', "TEXT NOT NULL DEFAULT 'main'"],
  ['chats', 'depth', 'INTEGER NOT NULL DEFAULT 0'],
  ['chats', 'intent', 'TEXT'],
  ['chats', 'intent_key', 'TEXT'],
  ['chats', 'owned_files', "TEXT NOT NULL DEFAULT '[]'"],
  ['chats', 'return_contract', 'TEXT'],
  ['chats', 'budget_tokens', 'INTEGER'],
  ['chats', 'ttl_deadline', 'INTEGER'],
  ['chats', 'ttl_stage', 'INTEGER NOT NULL DEFAULT 0'],
  ['chats', 'result', 'TEXT'],
  ['chats', 'terminal', 'TEXT'],
  ['chats', 'worktree_path', 'TEXT'],
  ['chats', 'predecessor_id', 'TEXT'],
  ['chats', 'lineage_id', 'TEXT'],
  ['chats', 'generation', 'INTEGER NOT NULL DEFAULT 1'],
  ['chats', 'handoff_stage', 'TEXT'],
  ['chats', 'handoff_attempts', 'INTEGER NOT NULL DEFAULT 0'],
  ['chats', 'compactions', 'INTEGER NOT NULL DEFAULT 0'],
  ['chats', 'priority', 'INTEGER NOT NULL DEFAULT 1'],
  ['chats', 'model', 'TEXT'],
  ['chats', 'suspended', 'INTEGER NOT NULL DEFAULT 0'],
  ['chats', 'progress_mark', 'TEXT'],
  ['chats', 'progress_at', 'INTEGER'],
  ['chats', 'interrupted', 'INTEGER NOT NULL DEFAULT 0'],
  ['chats', 'effort', 'TEXT'],
  ['chats', 'session_cwd', 'TEXT'],
  ['chats', 'title', 'TEXT'],
  ['chats', 'naming', 'INTEGER NOT NULL DEFAULT 0'],
  ['topics', 'naming', 'INTEGER NOT NULL DEFAULT 0'],
  ['ledger', 'credits', 'REAL NOT NULL DEFAULT 0'],
  ['notices', 'wake', 'INTEGER NOT NULL DEFAULT 1'],
  ['notices', 'about_chat_id', 'TEXT'],
  ['chats', 'tab_closed', 'INTEGER NOT NULL DEFAULT 0'],
  ['topics', 'tab_order', 'TEXT'],
  ['chats', 'handoff_queued', 'TEXT'],
  ['chats', 'handoff_asked', 'INTEGER'],
  ['chats', 'chrome', 'INTEGER NOT NULL DEFAULT 0'],
  ['topics', 'work_dir', 'TEXT'],
  ['chats', 'notify', 'INTEGER'],
  ['chats', 'profile', "TEXT NOT NULL DEFAULT 'generic'"],
  ['chats', 'computer', 'TEXT'],
  ['chats', 'remote_seq', 'INTEGER NOT NULL DEFAULT 0'],
  ['topics', 'home', 'TEXT'],
  ['turn_queue', 'taken', 'INTEGER NOT NULL DEFAULT 0'],
];

const V1_WORKSPACE_COLUMNS: Array<[column: string, definition: string]> = [
  ['worktree_path', 'TEXT'],
  ['status_topic', 'TEXT'],
  ['created_by', "TEXT NOT NULL DEFAULT 'human'"],
  ['created_by_chat', 'TEXT'],
  ['request', 'TEXT'],
];

const TOPIC_TABLES = ['chats', 'spawns', 'locks', 'tasks', 'ledger', 'kill_switches', 'approvals'];

const SCHEMA_VERSION = createHash('sha256').update(SCHEMA).update(JSON.stringify(ADDED_COLUMNS)).digest().readUInt32BE(0) & 0x7fffffff;
const BACKUPS_KEPT = 14;

export type BackupLabel = 'upgrade' | 'daily' | 'battery';

export interface Backup {
  file: string;
  at: number;
  label: BackupLabel;
  bytes: number;
}

export interface PrLink {
  url: string;
  topicId: string;
  repo: string;
  number: number;
  port: number | null;
  reviewChatId: string | null;
  reviewState: 'open' | 'ending' | null;
}

export type HandoffStage = 'offered' | 'requested' | 'done';

export interface QueuedHandoff {
  kind: 'write' | 'salvage';
  reason: string;
  auto?: boolean;
}

export interface ChatLifecycle {
  stage: HandoffStage | null;
  attempts: number;
  compactions: number;
  queued: QueuedHandoff | null;
}

export interface ReturnContract {
  artifact: string | null;
  summaryTokens: number;
}

export interface SpawnMeta {
  intentKey: string | null;
  returnContract: ReturnContract | null;
  ttlDeadline: number | null;
  ttlStage: number;
  result: ChatResult | null;
}

export interface SpawnRecord {
  id: string;
  topicId: string;
  parentChatId: string;
  clientRequestId: string;
  decision: 'spawned' | 'joined';
  chatId: string;
  createdAt: number;
}

export interface ChatBusState {
  turns: number;
  card: string | null;
  cardTurn: number | null;
  crossChatTokens: number;
}

interface ProjectRow {
  id: string;
  name: string;
  path: string;
  key: string | null;
  pinned: number;
  hidden: number;
  custom: number;
  created_by: Creator;
  created_at: number;
}

interface TopicRow {
  id: string;
  title: string;
  status_topic: string | null;
  state: Topic['state'] | 'planning';
  request: string | null;
  created_by: Creator;
  created_by_chat: string | null;
  created_at: number;
  last_seen_at: number | null;
  last_activity_at: number | null;
  naming: number;
  tab_order: string | null;
  work_dir: string | null;
  home: string | null;
}

interface WorkspaceRow {
  id: string;
  project_id: string;
  kind: Workspace['kind'];
  name: string;
  path: string;
  branch: string | null;
  base: string | null;
  setup_state: Workspace['setup'];
  setup_log: string | null;
  archived_at: number | null;
  created_by: Creator;
  created_by_chat: string | null;
  created_at: number;
}

interface ApprovalRow {
  id: string;
  chat_id: string | null;
  topic_id: string | null;
  workspace_id: string | null;
  tool: string;
  input: string;
  action_class: Approval['actionClass'];
  outcome: Approval['outcome'];
  reason: string;
  decision: Approval['decision'];
  via: Approval['via'];
  decided_by: string | null;
  created_at: number;
  decided_at: number | null;
}

interface ChatRow {
  id: string;
  topic_id: string;
  agent: string;
  state: ChatState;
  created_by: Chat['createdBy'];
  created_at: number;
  parent_id: string | null;
  role: Chat['role'];
  depth: number;
  intent: string | null;
  owned_files: string;
  priority: number;
  model: string | null;
  effort: Chat['effort'];
  suspended: number;
  worktree_path: string | null;
  predecessor_id: string | null;
  lineage_id: string | null;
  generation: number;
  title: string | null;
  naming: number;
  tab_closed: number;
  chrome: number;
  notify: number | null;
  profile: string;
  computer: string | null;
}

interface HandoffRow {
  id: string;
  lineage_id: string;
  chat_id: string;
  generation: number;
  successor_id: string | null;
  path: string;
  kind: Handoff['kind'];
  reason: string;
  attempts: number;
  boot_tokens: number | null;
  created_at: number;
}

export interface WorktreeRecord {
  path: string;
  projectId: string;
  createdBy: Creator;
  createdByChat: string | null;
  snapshot: Worktree | null;
}

export class Store {
  private readonly db: Database.Database;
  private readonly lockFile: string;

  readonly crashed: boolean;
  readonly upgradeBackup: string | null;
  private readonly backupDir: string;
  private readonly brainReal: string | null;

  constructor(
    dataDir: string,
    now: number = Date.now(),
    private readonly brainDir: string | null = null,
  ) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    chmodSync(dataDir, 0o700);
    this.brainReal = brainDir && existsSync(brainDir) ? realpathSync(brainDir) : brainDir;
    this.lockFile = join(dataDir, 'hos.lock');
    this.backupDir = join(dataDir, 'backups');
    this.crashed = acquireLock(this.lockFile);
    this.db = new Database(join(dataDir, 'hos.db'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    const version = this.db.pragma('user_version', { simple: true }) as number;
    const empty = !this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chats'").get();
    this.upgradeBackup = !empty && version !== SCHEMA_VERSION ? this.backup('upgrade', now).file : null;
    const fromV1 = this.renameV1Workspaces();
    this.db.exec(SCHEMA);
    for (const [table, from, to] of RENAMED_COLUMNS) {
      const columns = this.columns(table);
      if (columns.includes(from) && !columns.includes(to)) this.db.exec(`ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to}`);
    }
    for (const [table, column, definition] of ADDED_COLUMNS) {
      if (!this.columns(table).includes(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
    this.allowRowsWithoutChat('approvals');
    this.allowRowsWithoutChat('inbox');
    if (fromV1) this.migrateV1Workspaces();
    this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }

  private columns(table: string): string[] {
    return (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
  }

  private renameV1Workspaces(): boolean {
    const v1 = this.columns('workspaces');
    if (!v1.includes('state')) return false;
    for (const [column, definition] of V1_WORKSPACE_COLUMNS) {
      if (!v1.includes(column)) this.db.exec(`ALTER TABLE workspaces ADD COLUMN ${column} ${definition}`);
    }
    this.db.pragma('foreign_keys = OFF');
    this.transaction(() => {
      this.db.exec('ALTER TABLE workspaces RENAME TO topics; ALTER TABLE topics RENAME COLUMN name TO title;');
      for (const table of TOPIC_TABLES) {
        if (this.columns(table).includes('workspace_id')) this.db.exec(`ALTER TABLE ${table} RENAME COLUMN workspace_id TO topic_id`);
      }
      if (this.columns('search_index').includes('workspace_id')) this.db.exec('ALTER TABLE search_index RENAME TO search_index_v1');
      if (this.columns('action_runs').length) this.db.exec('ALTER TABLE action_runs RENAME TO action_runs_v1');
    });
    return true;
  }

  private migrateV1Workspaces(): void {
    this.transaction(() => {
      const topics = this.db.prepare('SELECT * FROM topics ORDER BY created_at, rowid').all() as Array<
        TopicRow & { project_id: string; branch: string; worktree_path: string | null }
      >;
      const folderOf = new Map<string, string>();
      const brainTopic = this.meta('brain.workspace');
      for (const topic of topics) {
        const project = this.getProject(topic.project_id);
        const path = topic.worktree_path ?? project?.path;
        if (!project || !path || topic.id === brainTopic || path === this.brainDir || project.path === this.brainDir) continue;
        let workspace = this.workspaceByPath(path);
        if (!workspace) {
          const root = path === project.path;
          const main = this.listWorktrees(project.id).find((w) => w.main);
          workspace = {
            id: randomUUID(),
            projectId: project.id,
            kind: root ? 'root' : 'worktree',
            name: root ? basename(project.path) : workspaceName(topic.branch),
            path,
            branch: topic.branch,
            base: root ? topic.branch : (main?.branch ?? null),
            setup: 'ready',
            setupLog: null,
            archivedAt: null,
            createdBy: topic.created_by,
            createdByChat: topic.created_by_chat,
            createdAt: topic.created_at,
          };
          this.insertWorkspace(workspace);
        }
        this.attachWorkspace(topic.id, workspace.id, topic.created_at);
        folderOf.set(topic.id, workspace.id);
      }
      const kept = 'id, title, status_topic, state, request, created_by, created_by_chat, created_at';
      this.db.exec(TOPICS_TABLE.replace('CREATE TABLE IF NOT EXISTS topics', 'CREATE TABLE topics_new'));
      this.db.exec(`INSERT INTO topics_new (${kept}) SELECT ${kept} FROM topics; DROP TABLE topics; ALTER TABLE topics_new RENAME TO topics;`);
      if (this.columns('search_index_v1').length) {
        this.db.exec(
          'INSERT INTO search_index (text, source, key, topic_id, chat_id) SELECT text, source, key, workspace_id, chat_id FROM search_index_v1; DROP TABLE search_index_v1;',
        );
      }
      if (this.columns('action_runs_v1').length) {
        const runs = this.db.prepare('SELECT * FROM action_runs_v1').all() as Array<{ id: string; topic_id: string; state: string; created_at: number; run: string }>;
        const insert = this.db.prepare('INSERT INTO action_runs (id, workspace_id, state, created_at, run) VALUES (?, ?, ?, ?, ?)');
        for (const row of runs) {
          const workspaceId = folderOf.get(row.topic_id);
          if (workspaceId) insert.run(row.id, workspaceId, row.state, row.created_at, JSON.stringify({ ...JSON.parse(row.run), workspaceId }));
        }
        this.db.exec('DROP TABLE action_runs_v1');
      }
      this.db.exec("UPDATE kill_switches SET scope = 'topic' WHERE scope = 'workspace'");
      this.db.exec("UPDATE meta SET key = 'brain.topic' WHERE key = 'brain.workspace'");
      const items = this.db.prepare('SELECT id, item FROM inbox').all() as Array<{ id: string; item: string }>;
      const saveItem = this.db.prepare('UPDATE inbox SET item = ? WHERE id = ?');
      for (const row of items) {
        const item = JSON.parse(row.item) as Record<string, unknown>;
        if (!('workspaceId' in item)) continue;
        const { workspaceId, ...rest } = item;
        saveItem.run(JSON.stringify({ ...rest, topicId: workspaceId }), row.id);
      }
      const events = this.db.prepare("SELECT seq, body FROM events WHERE body LIKE '%workspace%'").all() as Array<{ seq: number; body: string }>;
      const saveEvent = this.db.prepare('UPDATE events SET type = ?, body = ? WHERE seq = ?');
      for (const row of events) {
        const body = v1Event(JSON.parse(row.body) as Record<string, unknown>, folderOf);
        saveEvent.run(body.type, JSON.stringify(body), row.seq);
      }
    });
    this.db.pragma('foreign_keys = ON');
  }

  private allowRowsWithoutChat(table: 'approvals' | 'inbox'): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number }>;
    if (!columns.find((c) => c.name === 'chat_id')?.notnull) return;
    const { sql } = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string };
    this.transaction(() => {
      this.db.exec(sql.replace(new RegExp(`^CREATE TABLE "?${table}"?`), `CREATE TABLE ${table}_new`).replace(/chat_id TEXT NOT NULL/, 'chat_id TEXT'));
      this.db.exec(`INSERT INTO ${table}_new SELECT * FROM ${table}; DROP TABLE ${table}; ALTER TABLE ${table}_new RENAME TO ${table};`);
    });
  }

  backup(label: BackupLabel, now: number): Backup {
    mkdirSync(this.backupDir, { recursive: true });
    const file = join(this.backupDir, `hos-${now}-${label}.db`);
    rmSync(file, { force: true });
    this.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    const backups = this.backups();
    for (const old of backups.slice(BACKUPS_KEPT)) rmSync(old.file, { force: true });
    return backups.find((b) => b.file === file)!;
  }

  backups(): Backup[] {
    let names: string[];
    try {
      names = readdirSync(this.backupDir);
    } catch {
      return [];
    }
    return names
      .flatMap((name) => {
        const match = /^hos-(\d+)-(\w+)\.db$/.exec(name);
        const file = join(this.backupDir, name);
        return match ? [{ file, at: Number(match[1]), label: match[2] as BackupLabel, bytes: statSync(file).size }] : [];
      })
      .sort((a, b) => b.at - a.at);
  }

  setChatInterrupted(id: string, interrupted: boolean): void {
    this.db.prepare('UPDATE chats SET interrupted = ? WHERE id = ?').run(Number(interrupted), id);
  }

  interruptedChats(): Chat[] {
    const rows = this.db.prepare('SELECT * FROM chats WHERE interrupted = 1 ORDER BY created_at').all() as ChatRow[];
    return rows.map((row) => toChat(row)!);
  }

  close(): void {
    this.db.close();
    rmSync(this.lockFile, { force: true });
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  appendEvent(body: EventBody, ts: number): HosEvent {
    const chatId = eventChatId(body);
    const { lastInsertRowid } = this.db
      .prepare('INSERT INTO events (ts, type, chat_id, body) VALUES (?, ?, ?, ?)')
      .run(ts, body.type, chatId, JSON.stringify(body));
    const summary = chatId ? eventSummary(body) : undefined;
    if (summary) {
      this.db
        .prepare(
          "INSERT INTO search_index (text, source, key, topic_id, chat_id) SELECT ?, 'event', ?, topic_id, id FROM chats WHERE id = ?",
        )
        .run(summary, String(lastInsertRowid), chatId);
    }
    return { ...body, seq: Number(lastInsertRowid), ts };
  }

  progressMark(topicId: string): string {
    const row = this.db.prepare('SELECT COUNT(*) AS results FROM chats WHERE topic_id = ? AND result IS NOT NULL').get(topicId) as { results: number };
    return String(row.results);
  }

  chatSummaries(chatId: string, limit: number): Array<{ seq: number; summary: string }> {
    const rows = this.db
      .prepare('SELECT seq, body FROM events WHERE chat_id = ? ORDER BY seq DESC')
      .iterate(chatId) as IterableIterator<{ seq: number; body: string }>;
    const found: Array<{ seq: number; summary: string }> = [];
    for (const row of rows) {
      const summary = eventSummary(JSON.parse(row.body) as EventBody);
      if (summary) found.push({ seq: row.seq, summary });
      if (found.length === limit) break;
    }
    return found.reverse();
  }

  chatMessages(chatId: string, before: number | undefined, limit: number): Array<{ seq: number; ts: number; body: EventBody }> {
    const rows = this.db
      .prepare(
        `SELECT seq, ts, body FROM events WHERE chat_id = ? AND type IN ('message.user', 'message.completed') AND seq < ?
         ORDER BY seq DESC LIMIT ?`,
      )
      .all(chatId, before ?? Number.MAX_SAFE_INTEGER, limit) as Array<{ seq: number; ts: number; body: string }>;
    return rows.map((row) => ({ seq: row.seq, ts: row.ts, body: JSON.parse(row.body) as EventBody }));
  }

  search(topicId: string, match: string, options: { excludeChat?: string; limit: number }): SearchRow[] {
    return this.db
      .prepare(
        `SELECT source, key, chat_id AS chatId, snippet(search_index, 0, '«', '»', '…', 16) AS snippet
         FROM search_index WHERE search_index MATCH ? AND topic_id = ?
         AND source = 'event' AND (? IS NULL OR chat_id IS NULL OR chat_id != ?)
         ORDER BY rank LIMIT ?`,
      )
      .all(match, topicId, options.excludeChat ?? null, options.excludeChat ?? null, options.limit) as SearchRow[];
  }

  eventsSince(seq: number): HosEvent[] {
    const rows = this.db
      .prepare('SELECT seq, ts, body FROM events WHERE seq > ? ORDER BY seq')
      .all(seq) as Array<{ seq: number; ts: number; body: string }>;
    return rows.map((row) => ({ ...(JSON.parse(row.body) as EventBody), seq: row.seq, ts: row.ts }));
  }

  foldEventsSince(seq: number, apply: (event: HosEvent) => void): void {
    const rows = this.db
      .prepare(`SELECT seq, ts, body FROM events WHERE seq > ? AND seq NOT IN (${SUPERSEDED_DELTAS}) ORDER BY seq`)
      .iterate(seq, seq) as IterableIterator<{ seq: number; ts: number; body: string }>;
    for (const row of rows) apply({ ...(JSON.parse(row.body) as EventBody), seq: row.seq, ts: row.ts });
  }

  supersededDeltas(after: number): number[] {
    return this.db.prepare(`${SUPERSEDED_DELTAS} ORDER BY seq`).pluck().all(after) as number[];
  }

  deleteDeltas(seqs: number[]): number {
    return this.db
      .prepare(`DELETE FROM events WHERE seq IN (SELECT value FROM json_each(?)) AND type IN ('message.delta', 'thinking.delta')`)
      .run(JSON.stringify(seqs)).changes;
  }

  pruneArchivedDetail(before: number): number {
    return this.db
      .prepare(
        `DELETE FROM events WHERE type IN ('thinking.delta', 'thinking.completed', 'subagent.progress', 'approval.policy')
         AND chat_id IN (SELECT c.id FROM chats c JOIN topics t ON t.id = c.topic_id WHERE t.state = 'archived' AND COALESCE(t.last_activity_at, t.created_at) < ?)`,
      )
      .run(before).changes;
  }

  chatHistoryPage(chatId: string, after: number, limit: number): { events: HosEvent[]; next: number | null } {
    const rows = this.db
      .prepare(
        `SELECT seq, ts, body FROM events WHERE chat_id = ? AND seq > ?
         AND type NOT LIKE '%.delta' AND type NOT IN ('subagent.progress', 'approval.policy') ORDER BY seq LIMIT ?`,
      )
      .all(chatId, after, limit) as Array<{ seq: number; ts: number; body: string }>;
    return {
      events: rows.map((row) => ({ ...(JSON.parse(row.body) as EventBody), seq: row.seq, ts: row.ts })),
      next: rows.length === limit ? rows.at(-1)!.seq : null,
    };
  }

  liveShells(): Array<{ chatId: string; taskId: string; description: string }> {
    return this.db
      .prepare(
        `SELECT s.chat_id AS chatId, json_extract(s.body, '$.taskId') AS taskId, json_extract(s.body, '$.description') AS description
         FROM events s WHERE s.type = 'shell.started' AND NOT EXISTS (
           SELECT 1 FROM events f WHERE f.chat_id = s.chat_id AND f.seq > s.seq AND f.type = 'shell.finished'
           AND json_extract(f.body, '$.taskId') = json_extract(s.body, '$.taskId')
         ) ORDER BY s.seq`,
      )
      .all() as Array<{ chatId: string; taskId: string; description: string }>;
  }

  chatEvents(chatId: string): HosEvent[] {
    const rows = this.db
      .prepare('SELECT seq, ts, body FROM events WHERE chat_id = ? ORDER BY seq')
      .all(chatId) as Array<{ seq: number; ts: number; body: string }>;
    return rows.map((row) => ({ ...(JSON.parse(row.body) as EventBody), seq: row.seq, ts: row.ts }));
  }

  topicHistoryFacts(): TopicHistoryFact[] {
    const used = this.db
      .prepare(
        `SELECT json_extract(e.body, '$.topic.id') AS topicId, j.value AS workspaceId, MIN(e.seq) AS seq
         FROM events e, json_each(json_extract(e.body, '$.topic.workspaceIds')) j
         WHERE ${HISTORY_EVENTS} AND e.type != 'workspace.picked' AND e.type != 'bus.call' GROUP BY topicId, workspaceId
         UNION ALL
         SELECT json_extract(e.body, '$.topicId'), json_extract(e.body, '$.workspaceId'), e.seq FROM events e WHERE ${HISTORY_EVENTS} AND e.type = 'workspace.picked'
         ORDER BY seq`,
      )
      .all() as Array<{ topicId: string; workspaceId: string }>;
    const history = this.db
      .prepare(
        `SELECT c.topic_id AS topicId, COUNT(*) AS n FROM events e JOIN chats c ON c.id = e.chat_id
         WHERE ${HISTORY_EVENTS} AND e.type = 'bus.call' AND json_extract(e.body, '$.tool') = 'history_append' GROUP BY c.topic_id`,
      )
      .all() as Array<{ topicId: string; n: number }>;
    const facts = new Map<string, TopicHistoryFact>();
    const fact = (topicId: string) => facts.get(topicId) ?? facts.set(topicId, { topicId, workspaceIds: [], historyEntries: 0 }).get(topicId)!;
    for (const row of used) {
      const ids = fact(row.topicId).workspaceIds;
      if (!ids.includes(row.workspaceId)) ids.push(row.workspaceId);
    }
    for (const row of history) fact(row.topicId).historyEntries = row.n;
    return [...facts.values()];
  }

  insertProject(project: Project): void {
    this.db
      .prepare('INSERT INTO projects (id, name, path, key, pinned, hidden, custom, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(project.id, project.name, project.path, project.key, Number(project.pinned), Number(project.hidden), Number(project.custom), project.createdBy, project.createdAt);
  }

  updateProject(project: Project): void {
    this.db
      .prepare('UPDATE projects SET name = ?, key = ?, pinned = ?, hidden = ?, custom = ? WHERE id = ?')
      .run(project.name, project.key, Number(project.pinned), Number(project.hidden), Number(project.custom), project.id);
  }

  dismissedProjectPaths(): string[] {
    return JSON.parse(this.meta(DISMISSED_PROJECTS_META) ?? '[]') as string[];
  }

  setDismissedProjectPaths(paths: string[]): void {
    this.setMeta(DISMISSED_PROJECTS_META, JSON.stringify(paths));
  }

  deleteProject(id: string): void {
    this.db.prepare('DELETE FROM worktrees WHERE project_id = ?').run(id);
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }

  getProject(id: string): Project | undefined {
    return toProject(this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined, this.brainReal);
  }

  findProjectByPath(path: string): Project | undefined {
    return toProject(this.db.prepare('SELECT * FROM projects WHERE path = ?').get(path) as ProjectRow | undefined, this.brainReal);
  }

  listProjects(): Project[] {
    return (this.db.prepare('SELECT * FROM projects').all() as ProjectRow[]).map((row) => toProject(row, this.brainReal)!);
  }

  getWorktree(path: string): WorktreeRecord | undefined {
    const row = this.db.prepare('SELECT * FROM worktrees WHERE path = ?').get(path) as
      | { path: string; project_id: string; created_by: Creator; created_by_chat: string | null; snapshot: string | null }
      | undefined;
    return (
      row && {
        path: row.path,
        projectId: row.project_id,
        createdBy: row.created_by,
        createdByChat: row.created_by_chat,
        snapshot: row.snapshot ? (JSON.parse(row.snapshot) as Worktree) : null,
      }
    );
  }

  listWorktrees(projectId: string): Worktree[] {
    const rows = this.db
      .prepare('SELECT snapshot FROM worktrees WHERE project_id = ? AND snapshot IS NOT NULL')
      .all(projectId) as Array<{ snapshot: string }>;
    return rows.map((row) => JSON.parse(row.snapshot) as Worktree);
  }

  claimWorktree(path: string, projectId: string, createdBy: Creator, createdByChat: string | null): void {
    this.db
      .prepare(
        'INSERT INTO worktrees (path, project_id, created_by, created_by_chat) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET project_id = excluded.project_id, created_by = excluded.created_by, created_by_chat = excluded.created_by_chat, snapshot = NULL',
      )
      .run(path, projectId, createdBy, createdByChat);
  }

  saveWorktree(worktree: Worktree): void {
    this.db
      .prepare(
        'INSERT INTO worktrees (path, project_id, created_by, created_by_chat, snapshot) VALUES (?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET snapshot = excluded.snapshot',
      )
      .run(worktree.path, worktree.projectId, worktree.createdBy, worktree.createdByChat, JSON.stringify(worktree));
  }

  deleteWorktree(path: string): void {
    this.db.prepare('DELETE FROM worktrees WHERE path = ?').run(path);
  }

  chatIdsInWorktree(path: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT c.id FROM chats c WHERE COALESCE(c.worktree_path, (SELECT w.path FROM topic_workspaces tw JOIN workspaces w ON w.id = tw.workspace_id
           WHERE tw.topic_id = c.topic_id ORDER BY tw.attached_at, tw.rowid LIMIT 1), ?) = ? ORDER BY c.created_at, c.rowid`,
      )
      .all(this.brainDir, path) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  insertTopic(topic: Topic): void {
    this.db
      .prepare(
        'INSERT INTO topics (id, title, status_topic, state, request, created_by, created_by_chat, created_at, last_seen_at, last_activity_at, naming, work_dir, home) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        topic.id,
        topic.title,
        topic.statusTopic,
        topic.state,
        topic.request,
        topic.createdBy,
        topic.createdByChat,
        topic.createdAt,
        topic.lastSeenAt,
        topic.lastActivityAt,
        Number(topic.naming),
        topic.workDir,
        topic.home ?? null,
      );
  }

  setTopicState(id: string, state: Topic['state']): void {
    this.db.prepare('UPDATE topics SET state = ? WHERE id = ?').run(state, id);
  }

  setTopicTitle(id: string, title: string, naming = false): void {
    this.db.prepare('UPDATE topics SET title = ?, naming = ? WHERE id = ?').run(title, Number(naming), id);
  }

  setStatusTopic(id: string, statusTopic: string): void {
    this.db.prepare('UPDATE topics SET status_topic = ? WHERE id = ?').run(statusTopic, id);
  }

  endNaming(): void {
    this.db.exec('UPDATE topics SET naming = 0 WHERE naming = 1; UPDATE chats SET naming = 0 WHERE naming = 1');
  }

  setTopicSeen(id: string, at: number): void {
    this.db.prepare('UPDATE topics SET last_seen_at = ? WHERE id = ?').run(at, id);
  }

  setTopicActivity(id: string, at: number): void {
    this.db.prepare('UPDATE topics SET last_activity_at = ? WHERE id = ?').run(at, id);
  }

  setTopicTabOrder(id: string, order: string[]): void {
    this.db.prepare('UPDATE topics SET tab_order = ? WHERE id = ?').run(JSON.stringify(order), id);
  }

  addLink(chat: string, target: string, kind: LinkKind, at: number): void {
    this.db.prepare('INSERT OR IGNORE INTO links (chat, target, kind, created_at) VALUES (?, ?, ?, ?)').run(chat, target, kind, at);
  }

  removeLink(chat: string, target: string): void {
    this.db.prepare('DELETE FROM links WHERE chat = ? AND target = ?').run(chat, target);
  }

  linksOf(chat: string): ChatLink[] {
    const rows = this.db.prepare('SELECT target, kind, created_at FROM links WHERE chat = ? ORDER BY created_at, rowid').all(chat) as Array<{ target: string; kind: LinkKind; created_at: number }>;
    return rows.map((row) => ({ target: row.target, kind: row.kind, createdAt: row.created_at }));
  }

  linkedChats(target: string): string[] {
    return (this.db.prepare('SELECT chat FROM links WHERE target = ? ORDER BY created_at, rowid').all(target) as Array<{ chat: string }>).map((row) => row.chat);
  }

  setWorkDir(id: string, workDir: string): void {
    this.db.prepare('UPDATE topics SET work_dir = ? WHERE id = ?').run(workDir, id);
  }

  workDirTaken(workDir: string): boolean {
    return this.db.prepare('SELECT 1 FROM topics WHERE work_dir = ?').get(workDir) !== undefined;
  }

  topicByWorkDir(workDir: string): Topic | undefined {
    const row = this.db.prepare('SELECT id FROM topics WHERE work_dir = ?').get(workDir) as { id: string } | undefined;
    return row ? this.getTopic(row.id) : undefined;
  }

  // Each status slug in the map gets its work folder once; a topic that already has one keeps it.
  backfillWorkDirs(folders: Map<string, string>, fallback: (topic: Topic) => string): number {
    let filled = 0;
    this.transaction(() => {
      const rows = this.db.prepare('SELECT id, status_topic FROM topics WHERE work_dir IS NULL ORDER BY created_at, rowid').all() as Array<{ id: string; status_topic: string | null }>;
      for (const row of rows) {
        if (row.id === this.meta(DESK_META)) continue;
        const mapped = row.status_topic ? folders.get(row.status_topic) : undefined;
        this.setWorkDir(row.id, mapped && !this.workDirTaken(mapped) ? mapped : fallback(this.getTopic(row.id)!));
        filled++;
      }
    });
    return filled;
  }

  statusTopicTaken(statusTopic: string): boolean {
    return this.db.prepare('SELECT 1 FROM topics WHERE status_topic = ?').get(statusTopic) !== undefined;
  }

  listTopics(): Topic[] {
    const rows = this.db.prepare('SELECT id FROM topics ORDER BY created_at, rowid').all() as Array<{ id: string }>;
    return rows.map((row) => this.getTopic(row.id)!);
  }

  getTopic(id: string): Topic | undefined {
    const row = this.db.prepare('SELECT * FROM topics WHERE id = ?').get(id) as TopicRow | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      title: row.title,
      statusTopic: row.status_topic ?? '',
      state: row.state === 'planning' ? 'active' : row.state,
      request: row.request,
      workspaceIds: this.topicWorkspaceIds(row.id),
      lastSeenAt: row.last_seen_at,
      lastActivityAt: row.last_activity_at,
      createdBy: row.created_by,
      createdByChat: row.created_by_chat,
      createdAt: row.created_at,
      naming: row.naming === 1,
      tabOrder: row.tab_order ? (JSON.parse(row.tab_order) as string[]) : [],
      workDir: row.work_dir,
      ...(row.home ? { home: row.home } : {}),
      ...(row.id === this.meta(DESK_META) ? { desk: true } : {}),
    };
  }

  topicWorkspaceIds(topicId: string): string[] {
    const rows = this.db
      .prepare('SELECT workspace_id FROM topic_workspaces WHERE topic_id = ? ORDER BY attached_at, rowid')
      .all(topicId) as Array<{ workspace_id: string }>;
    return rows.map((row) => row.workspace_id);
  }

  topicFolder(topicId: string): string | null {
    const [first] = this.topicWorkspaceIds(topicId);
    return (first ? this.getWorkspace(first)?.path : undefined) ?? this.brainDir;
  }

  topicsUsing(workspaceId: string): Topic[] {
    const rows = this.db
      .prepare('SELECT topic_id FROM topic_workspaces WHERE workspace_id = ? ORDER BY attached_at, rowid')
      .all(workspaceId) as Array<{ topic_id: string }>;
    return rows.map((row) => this.getTopic(row.topic_id)!);
  }

  attachWorkspace(topicId: string, workspaceId: string, at: number): boolean {
    return this.db.prepare('INSERT OR IGNORE INTO topic_workspaces (topic_id, workspace_id, attached_at) VALUES (?, ?, ?)').run(topicId, workspaceId, at).changes > 0;
  }

  detachWorkspace(topicId: string, workspaceId: string): boolean {
    return this.db.prepare('DELETE FROM topic_workspaces WHERE topic_id = ? AND workspace_id = ?').run(topicId, workspaceId).changes > 0;
  }

  insertWorkspace(workspace: Workspace): void {
    this.db
      .prepare(
        `INSERT INTO workspaces (id, project_id, kind, name, path, branch, base, setup_state, setup_log, archived_at, created_by, created_by_chat, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        workspace.id,
        workspace.projectId,
        workspace.kind,
        workspace.name,
        workspace.path,
        workspace.branch,
        workspace.base,
        workspace.setup,
        workspace.setupLog,
        workspace.archivedAt,
        workspace.createdBy,
        workspace.createdByChat,
        workspace.createdAt,
      );
  }

  getWorkspace(id: string): Workspace | undefined {
    return toWorkspace(this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WorkspaceRow | undefined);
  }

  workspaceByPath(path: string): Workspace | undefined {
    return toWorkspace(this.db.prepare('SELECT * FROM workspaces WHERE path = ?').get(path) as WorkspaceRow | undefined);
  }

  listWorkspaces(options: { archived?: boolean } = {}): Workspace[] {
    const rows = this.db
      .prepare(`SELECT * FROM workspaces${options.archived ? '' : ' WHERE archived_at IS NULL'} ORDER BY created_at, rowid`)
      .all() as WorkspaceRow[];
    return rows.map((row) => toWorkspace(row)!);
  }

  meta(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  deleteMeta(key: string): void {
    this.db.prepare('DELETE FROM meta WHERE key = ?').run(key);
  }

  listComputers(): ComputerRow[] {
    return this.db.prepare('SELECT * FROM computers ORDER BY direction DESC, name').all() as ComputerRow[];
  }

  upsertComputer(row: Pick<ComputerRow, 'name' | 'direction' | 'added_at'> & Partial<ComputerRow>): void {
    this.db
      .prepare(
        `INSERT INTO computers (name, direction, url, token_hash, added_at, last_seen, hos_version, api_version, caps)
         VALUES (@name, @direction, @url, @token_hash, @added_at, @last_seen, @hos_version, @api_version, @caps)
         ON CONFLICT (name, direction) DO UPDATE SET url = excluded.url, token_hash = excluded.token_hash, added_at = excluded.added_at,
           last_seen = excluded.last_seen, hos_version = excluded.hos_version, api_version = excluded.api_version, caps = excluded.caps`,
      )
      .run({ url: null, token_hash: null, last_seen: null, hos_version: null, api_version: null, caps: null, ...row });
  }

  computerSeen(name: string, direction: ComputerRow['direction'], at: number, found?: Pick<ComputerRow, 'hos_version' | 'api_version' | 'caps'>): void {
    if (!found) return void this.db.prepare('UPDATE computers SET last_seen = ? WHERE name = ? AND direction = ?').run(at, name, direction);
    this.db
      .prepare('UPDATE computers SET last_seen = ?, hos_version = ?, api_version = ?, caps = ? WHERE name = ? AND direction = ?')
      .run(at, found.hos_version, found.api_version, found.caps, name, direction);
  }

  deleteComputer(name: string): boolean {
    return this.db.prepare('DELETE FROM computers WHERE name = ?').run(name).changes > 0;
  }

  computerByToken(tokenHash: string): string | undefined {
    return (this.db.prepare("SELECT name FROM computers WHERE direction = 'in' AND token_hash = ?").get(tokenHash) as { name: string } | undefined)?.name;
  }

  addComputerTopic(computer: string, topicId: string, at: number): void {
    this.db.prepare('INSERT OR IGNORE INTO computer_topics (computer, topic_id, added_at) VALUES (?, ?, ?)').run(computer, topicId, at);
  }

  topicShared(topicId: string): boolean {
    return (
      this.db.prepare('SELECT 1 FROM computer_topics WHERE topic_id = ?').get(topicId) !== undefined ||
      this.db.prepare('SELECT 1 FROM chats WHERE topic_id = ? AND computer IS NOT NULL').get(topicId) !== undefined
    );
  }

  sharedWith(computer: string, topicId: string): boolean {
    return (
      this.db.prepare('SELECT 1 FROM computer_topics WHERE computer = ? AND topic_id = ?').get(computer, topicId) !== undefined ||
      this.db.prepare('SELECT 1 FROM chats WHERE topic_id = ? AND computer = ?').get(topicId, computer) !== undefined
    );
  }

  addOutbox(computer: string, chatId: string, fromChatId: string | null, text: string, at: number): void {
    this.db.prepare('INSERT INTO computer_outbox (computer, chat_id, from_chat_id, text, created_at) VALUES (?, ?, ?, ?, ?)').run(computer, chatId, fromChatId, text, at);
  }

  outbox(computer: string, after: number): OutboxItem[] {
    return this.db
      .prepare('SELECT seq, chat_id AS chatId, from_chat_id AS fromChatId, text FROM computer_outbox WHERE computer = ? AND seq > ? ORDER BY seq')
      .all(computer, after) as OutboxItem[];
  }

  ackOutbox(computer: string, seq: number): void {
    this.db.prepare('DELETE FROM computer_outbox WHERE computer = ? AND seq <= ?').run(computer, seq);
  }

  relayedTo(computer: string, chatId: string): boolean {
    return (
      this.db
        .prepare('SELECT 1 FROM chats c JOIN computer_topics t ON t.topic_id = c.topic_id WHERE c.id = ? AND c.computer IS NULL AND t.computer = ?')
        .get(chatId, computer) !== undefined
    );
  }

  remoteSeq(chatId: string): number {
    return (this.db.prepare('SELECT remote_seq FROM chats WHERE id = ?').get(chatId) as { remote_seq: number } | undefined)?.remote_seq ?? 0;
  }

  setRemoteSeq(chatId: string, seq: number): void {
    this.db.prepare('UPDATE chats SET remote_seq = ? WHERE id = ?').run(seq, chatId);
  }

  maxRemoteSeq(computer: string): number {
    return (this.db.prepare('SELECT MAX(remote_seq) AS seq FROM chats WHERE computer = ?').get(computer) as { seq: number | null }).seq ?? 0;
  }

  eventOwner(kind: 'approval' | 'inbox', id: string): string | undefined {
    const row = this.db
      .prepare(
        kind === 'approval'
          ? "SELECT chat_id FROM events WHERE type = 'approval.requested' AND json_extract(body, '$.approvalId') = ? LIMIT 1"
          : "SELECT chat_id FROM events WHERE type = 'inbox.added' AND json_extract(body, '$.item.id') = ? LIMIT 1",
      )
      .get(id) as { chat_id: string | null } | undefined;
    return row?.chat_id ?? undefined;
  }

  addPairCode(codeHash: string, expiresAt: number, now: number): void {
    this.db.prepare('DELETE FROM pair_codes WHERE expires_at < ?').run(now);
    this.db.prepare('INSERT OR REPLACE INTO pair_codes (code_hash, expires_at) VALUES (?, ?)').run(codeHash, expiresAt);
  }

  pairCodeValid(codeHash: string, now: number): boolean {
    return this.db.prepare('SELECT 1 FROM pair_codes WHERE code_hash = ? AND used_at IS NULL AND expires_at >= ?').get(codeHash, now) !== undefined;
  }

  usePairCode(codeHash: string, now: number): void {
    this.db.prepare('UPDATE pair_codes SET used_at = ? WHERE code_hash = ?').run(now, codeHash);
  }


  insertChat(chat: Chat, meta: Partial<SpawnMeta> = {}): void {
    this.db
      .prepare(
        `INSERT INTO chats (id, topic_id, agent, state, created_by, created_at, parent_id, role, depth, intent, owned_files,
         intent_key, return_contract, ttl_deadline, predecessor_id, lineage_id, generation, worktree_path, priority, model, effort, title, naming, chrome, notify, profile, computer)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        chat.id,
        chat.topicId,
        chat.agent,
        chat.state,
        chat.createdBy,
        chat.createdAt,
        chat.parentId,
        chat.role,
        chat.depth,
        chat.intent,
        JSON.stringify(chat.ownedFiles),
        meta.intentKey ?? null,
        meta.returnContract ? JSON.stringify(meta.returnContract) : null,
        meta.ttlDeadline ?? null,
        chat.predecessorId,
        chat.lineageId,
        chat.generation,
        chat.worktreePath,
        chat.priority,
        chat.model,
        chat.effort,
        chat.title,
        Number(chat.naming),
        Number(chat.chrome),
        Number(chat.notify),
        chat.profile,
        chat.computer ?? null,
      );
  }

  refreshStub(chat: Chat, computer: string): void {
    this.db
      .prepare('UPDATE chats SET role = ?, depth = ? WHERE id = ? AND computer = ?')
      .run(chat.role, chat.depth, chat.id, computer);
  }

  setChatSuspended(id: string, suspended: boolean): void {
    this.db.prepare('UPDATE chats SET suspended = ? WHERE id = ?').run(Number(suspended), id);
  }

  enqueueTurn(chatId: string, text: string, priority: number, at: number): void {
    this.db.prepare('INSERT INTO turn_queue (chat_id, text, priority, enqueued_at) VALUES (?, ?, ?, ?)').run(chatId, text, priority, at);
  }

  takeQueuedTurns(chatId: string): string[] {
    const rows = this.db.prepare('SELECT text FROM turn_queue WHERE chat_id = ? AND taken = 0 ORDER BY id').all(chatId) as Array<{ text: string }>;
    this.db.prepare('UPDATE turn_queue SET taken = 1 WHERE chat_id = ?').run(chatId);
    return rows.map((row) => row.text);
  }

  dropQueuedTurns(chatId: string, takenOnly = false): void {
    this.db.prepare(`DELETE FROM turn_queue WHERE chat_id = ?${takenOnly ? ' AND taken = 1' : ''}`).run(chatId);
  }

  requeueTakenTurns(): void {
    const live = "chat_id IN (SELECT id FROM chats WHERE state IN ('queued', 'starting'))";
    this.db.prepare(`UPDATE turn_queue SET taken = 0 WHERE taken = 1 AND ${live}`).run();
    this.db.prepare('DELETE FROM turn_queue WHERE taken = 1').run();
  }

  queuedChats(): Array<{ chatId: string; topicId: string; priority: number; since: number }> {
    return this.db
      .prepare(
        `SELECT q.chat_id AS chatId, c.topic_id AS topicId, MIN(q.priority) AS priority, MIN(q.enqueued_at) AS since
         FROM turn_queue q JOIN chats c ON c.id = q.chat_id WHERE q.taken = 0 GROUP BY q.chat_id ORDER BY since, MIN(q.id)`,
      )
      .all() as Array<{ chatId: string; topicId: string; priority: number; since: number }>;
  }

  linkPr(link: { url: string; topicId: string; repo: string; number: number }, at: number): PrLink {
    this.db
      .prepare('INSERT OR IGNORE INTO pr_links (url, topic_id, repo, number, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(link.url, link.topicId, link.repo, link.number, at);
    return this.prLink(link.url)!;
  }

  prLink(url: string): PrLink | undefined {
    return this.db
      .prepare(
        `SELECT url, topic_id AS topicId, repo, number, port, review_chat_id AS reviewChatId, review_state AS reviewState
         FROM pr_links WHERE url = ?`,
      )
      .get(url) as PrLink | undefined;
  }

  prLinksReviewedBy(chatId: string): PrLink[] {
    return (this.db.prepare("SELECT url FROM pr_links WHERE review_chat_id = ? AND review_state IS NOT NULL").all(chatId) as Array<{ url: string }>).map(
      (row) => this.prLink(row.url)!,
    );
  }

  setPrPort(url: string, port: number): void {
    this.db.prepare('UPDATE pr_links SET port = ? WHERE url = ?').run(port, url);
  }

  setPrReview(url: string, chatId: string | null, state: 'open' | 'ending' | null): void {
    this.db.prepare('UPDATE pr_links SET review_chat_id = ?, review_state = ? WHERE url = ?').run(chatId, state, url);
  }

  addPrComment(url: string, chatId: string | null, text: string, at: number): string {
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM pr_review_comments WHERE url = ?').get(url) as { n: number }).n;
    const ref = `C${count + 1}`;
    this.db.prepare('INSERT INTO pr_review_comments (url, ref, chat_id, text, created_at) VALUES (?, ?, ?, ?, ?)').run(url, ref, chatId, text, at);
    return ref;
  }

  unsentPrComments(url: string, chatId: string): Array<{ id: number; ref: string; text: string }> {
    return this.db
      .prepare('SELECT id, ref, text FROM pr_review_comments WHERE url = ? AND chat_id = ? AND sent_at IS NULL ORDER BY id')
      .all(url, chatId) as Array<{ id: number; ref: string; text: string }>;
  }

  markPrCommentsSent(ids: number[], at: number): void {
    const mark = this.db.prepare('UPDATE pr_review_comments SET sent_at = ? WHERE id = ?');
    this.db.transaction(() => ids.forEach((id) => mark.run(at, id)))();
  }

  insertLedger(entry: {
    chatId: string;
    topicId: string;
    agent: string;
    model: string | null;
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
    tokens: number;
    credits?: number;
    at: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO ledger (chat_id, topic_id, agent, model, input, output, cache_read, cache_creation, tokens, credits, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.chatId,
        entry.topicId,
        entry.agent,
        entry.model,
        entry.input,
        entry.output,
        entry.cacheRead,
        entry.cacheCreation,
        entry.tokens,
        entry.credits ?? 0,
        entry.at,
      );
  }

  ledgerSince(since: number): Array<{ chatId: string; topicId: string; agent: string; tokens: number; cacheRead: number; credits: number }> {
    return this.db
      .prepare(
        `SELECT chat_id AS chatId, topic_id AS topicId, agent, SUM(tokens) AS tokens, SUM(cache_read) AS cacheRead, SUM(credits) AS credits
         FROM ledger WHERE created_at > ? GROUP BY chat_id ORDER BY tokens DESC`,
      )
      .all(since) as Array<{ chatId: string; topicId: string; agent: string; tokens: number; cacheRead: number; credits: number }>;
  }

  progress(chatId: string): { mark: string | null; at: number | null } {
    const row = this.db.prepare('SELECT progress_mark, progress_at FROM chats WHERE id = ?').get(chatId) as {
      progress_mark: string | null;
      progress_at: number | null;
    };
    return { mark: row.progress_mark, at: row.progress_at };
  }

  setProgress(chatId: string, mark: string | null, at: number): void {
    this.db.prepare('UPDATE chats SET progress_mark = COALESCE(?, progress_mark), progress_at = ? WHERE id = ?').run(mark, at, chatId);
  }

  chatsInLineage(lineageId: string): Chat[] {
    const rows = this.db
      .prepare('SELECT * FROM chats WHERE COALESCE(lineage_id, id) = ? ORDER BY generation, rowid')
      .all(lineageId) as ChatRow[];
    return rows.map((row) => toChat(row)!);
  }

  lifecycle(id: string): ChatLifecycle {
    const row = this.db.prepare('SELECT handoff_stage, handoff_attempts, compactions, handoff_queued FROM chats WHERE id = ?').get(id) as {
      handoff_stage: HandoffStage | null;
      handoff_attempts: number;
      compactions: number;
      handoff_queued: string | null;
    };
    const queued = row.handoff_queued ? (JSON.parse(row.handoff_queued) as QueuedHandoff | { kind: 'rotate' }) : null;
    return {
      stage: row.handoff_stage,
      attempts: row.handoff_attempts,
      compactions: row.compactions,
      queued: queued?.kind === 'rotate' ? null : queued,
    };
  }

  setHandoffQueued(id: string, queued: QueuedHandoff | null): void {
    this.db.prepare('UPDATE chats SET handoff_queued = ? WHERE id = ?').run(queued && JSON.stringify(queued), id);
  }

  chatsWithHandoffDue(): string[] {
    const rows = this.db.prepare("SELECT id FROM chats WHERE handoff_queued IS NOT NULL").all() as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  setHandoffStage(id: string, stage: HandoffStage | null): void {
    this.db.prepare('UPDATE chats SET handoff_stage = ? WHERE id = ?').run(stage, id);
  }

  countHandoffAttempt(id: string): void {
    this.db.prepare('UPDATE chats SET handoff_attempts = handoff_attempts + 1 WHERE id = ?').run(id);
  }

  countCompaction(id: string): void {
    this.db.prepare('UPDATE chats SET compactions = compactions + 1 WHERE id = ?').run(id);
  }

  insertHandoff(handoff: Handoff): void {
    this.db
      .prepare(
        'INSERT INTO handoffs (id, lineage_id, chat_id, generation, successor_id, path, kind, reason, attempts, boot_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        handoff.id,
        handoff.lineageId,
        handoff.chatId,
        handoff.generation,
        handoff.successorId,
        handoff.path,
        handoff.kind,
        handoff.reason,
        handoff.attempts,
        handoff.bootTokens,
        handoff.createdAt,
      );
  }

  setHandoffBoot(id: string, tokens: number): void {
    this.db.prepare('UPDATE handoffs SET boot_tokens = ? WHERE id = ?').run(tokens, id);
  }

  handoffInto(successorId: string): Handoff | undefined {
    const row = this.db.prepare('SELECT * FROM handoffs WHERE successor_id = ?').get(successorId) as HandoffRow | undefined;
    return row && toHandoff(row);
  }

  handoffs(lineageId?: string): Handoff[] {
    const rows = this.db
      .prepare(`SELECT * FROM handoffs${lineageId ? ' WHERE lineage_id = ?' : ''} ORDER BY generation, created_at, rowid`)
      .all(...(lineageId ? [lineageId] : [])) as HandoffRow[];
    return rows.map(toHandoff);
  }

  spawnMeta(id: string): SpawnMeta {
    const row = this.db
      .prepare('SELECT intent_key, return_contract, ttl_deadline, ttl_stage, result FROM chats WHERE id = ?')
      .get(id) as {
      intent_key: string | null;
      return_contract: string | null;
      ttl_deadline: number | null;
      ttl_stage: number;
      result: string | null;
    };
    return {
      intentKey: row.intent_key,
      returnContract: row.return_contract ? (JSON.parse(row.return_contract) as ReturnContract) : null,
      ttlDeadline: row.ttl_deadline,
      ttlStage: row.ttl_stage,
      result: row.result ? (JSON.parse(row.result) as ChatResult) : null,
    };
  }

  setResult(id: string, result: ChatResult): void {
    this.db.prepare('UPDATE chats SET result = ? WHERE id = ?').run(JSON.stringify(result), id);
  }

  clearResult(id: string): void {
    this.db.prepare('UPDATE chats SET result = NULL WHERE id = ?').run(id);
  }

  extendTtl(id: string, ms: number): void {
    this.db.prepare('UPDATE chats SET ttl_deadline = ttl_deadline + ? WHERE id = ? AND ttl_deadline IS NOT NULL AND ttl_stage = 0').run(ms, id);
  }

  setTtlStage(id: string, stage: number): void {
    this.db.prepare('UPDATE chats SET ttl_stage = ? WHERE id = ?').run(stage, id);
  }

  chatsWithDeadline(before: number): Chat[] {
    const rows = this.db
      .prepare('SELECT * FROM chats WHERE ttl_deadline IS NOT NULL AND ttl_deadline <= ? ORDER BY created_at, rowid')
      .all(before) as ChatRow[];
    return rows.map((row) => toChat(row)!);
  }

  childrenOf(parentId: string): Chat[] {
    const rows = this.db.prepare('SELECT * FROM chats WHERE parent_id = ? ORDER BY created_at, rowid').all(parentId) as ChatRow[];
    return rows.map((row) => toChat(row)!);
  }

  chatByIntent(topicId: string, intentKey: string, since: number, excludeStates: ChatState[]): Chat | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM chats WHERE topic_id = ? AND intent_key = ? AND created_at >= ?
         AND state NOT IN (${excludeStates.map(() => '?').join(', ')}) ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(topicId, intentKey, since, ...excludeStates) as ChatRow | undefined;
    return toChat(row);
  }

  findSpawn(parentChatId: string, clientRequestId: string): SpawnRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM spawns WHERE parent_chat_id = ? AND client_request_id = ?')
      .get(parentChatId, clientRequestId) as
      | {
          id: string;
          topic_id: string;
          parent_chat_id: string;
          client_request_id: string;
          decision: SpawnRecord['decision'];
          chat_id: string;
          created_at: number;
        }
      | undefined;
    return (
      row && {
        id: row.id,
        topicId: row.topic_id,
        parentChatId: row.parent_chat_id,
        clientRequestId: row.client_request_id,
        decision: row.decision,
        chatId: row.chat_id,
        createdAt: row.created_at,
      }
    );
  }

  insertSpawn(spawn: SpawnRecord): void {
    this.db
      .prepare(
        'INSERT INTO spawns (id, topic_id, parent_chat_id, client_request_id, decision, chat_id, reserved_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)',
      )
      .run(
        spawn.id,
        spawn.topicId,
        spawn.parentChatId,
        spawn.clientRequestId,
        spawn.decision,
        spawn.chatId,
        spawn.createdAt,
      );
  }

  spawnsSince(topicId: string, since: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM spawns WHERE topic_id = ? AND decision = 'spawned' AND created_at > ?")
      .get(topicId, since) as { count: number };
    return row.count;
  }

  insertNotice(chatId: string, text: string, at: number, wake = true, aboutChatId: string | null = null): void {
    this.db
      .prepare('INSERT INTO notices (chat_id, text, created_at, wake, about_chat_id) VALUES (?, ?, ?, ?, ?)')
      .run(chatId, text, at, wake ? 1 : 0, aboutChatId);
  }

  dropNoticesAbout(chatId: string, aboutChatId: string, at: number): void {
    this.db.prepare('UPDATE notices SET delivered_at = ? WHERE chat_id = ? AND about_chat_id = ? AND delivered_at IS NULL').run(at, chatId, aboutChatId);
  }

  pendingNotices(chatId: string): Array<{ id: number; text: string }> {
    return this.db
      .prepare('SELECT id, text FROM notices WHERE chat_id = ? AND delivered_at IS NULL ORDER BY wake DESC, id')
      .all(chatId) as Array<{ id: number; text: string }>;
  }

  quietNotices(chatId: string): Array<{ id: number; text: string }> {
    return this.db
      .prepare('SELECT id, text FROM notices WHERE chat_id = ? AND delivered_at IS NULL AND wake = 0 ORDER BY id')
      .all(chatId) as Array<{ id: number; text: string }>;
  }

  chatsWithWakingNotices(): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT chat_id FROM notices WHERE delivered_at IS NULL AND wake = 1 ORDER BY chat_id')
      .all() as Array<{ chat_id: string }>;
    return rows.map((row) => row.chat_id);
  }

  markNoticesDelivered(ids: number[], at: number): void {
    const mark = this.db.prepare('UPDATE notices SET delivered_at = ? WHERE id = ?');
    for (const id of ids) mark.run(at, id);
  }

  killSwitches(): KillSwitch[] {
    const rows = this.db.prepare('SELECT scope, topic_id, at FROM kill_switches ORDER BY at').all() as Array<{
      scope: KillSwitch['scope'];
      topic_id: string;
      at: number;
    }>;
    return rows.map((row) => ({ scope: row.scope, ...(row.topic_id ? { topicId: row.topic_id } : {}), at: row.at }));
  }

  setKillSwitch(scope: KillSwitch['scope'], topicId: string, at: number): void {
    this.db.prepare('INSERT OR IGNORE INTO kill_switches (scope, topic_id, at) VALUES (?, ?, ?)').run(scope, topicId, at);
  }

  clearKillSwitch(scope: KillSwitch['scope'], topicId: string): void {
    this.db.prepare('DELETE FROM kill_switches WHERE scope = ? AND topic_id = ?').run(scope, topicId);
  }

  getChat(id: string): Chat | undefined {
    return toChat(this.db.prepare('SELECT * FROM chats WHERE id = ?').get(id) as ChatRow | undefined);
  }

  setChatState(id: string, state: ChatState): void {
    this.db.prepare('UPDATE chats SET state = ? WHERE id = ?').run(state, id);
  }

  getChatNativeSession(id: string): string | undefined {
    const row = this.db.prepare('SELECT native_session_id FROM chats WHERE id = ?').get(id) as
      | { native_session_id: string | null }
      | undefined;
    return row?.native_session_id ?? undefined;
  }

  getChatTrees(id: string): { start: string | null; turn: string | null } {
    const row = this.db.prepare('SELECT start_tree, turn_tree FROM chats WHERE id = ?').get(id) as
      | { start_tree: string | null; turn_tree: string | null }
      | undefined;
    return { start: row?.start_tree ?? null, turn: row?.turn_tree ?? null };
  }

  setChatTree(id: string, which: 'start' | 'turn', tree: string): void {
    this.db.prepare(`UPDATE chats SET ${which}_tree = ? WHERE id = ?`).run(tree, id);
  }

  chatsByPrefix(prefix: string): Chat[] {
    const rows = this.db.prepare("SELECT * FROM chats WHERE id LIKE ? || '%' ESCAPE '\\' ORDER BY created_at").all(prefix.replace(/[\\%_]/g, '\\$&')) as ChatRow[];
    return rows.map((row) => toChat(row)!);
  }

  chatsInState(states: ChatState[]): Chat[] {
    const rows = this.db
      .prepare(`SELECT * FROM chats WHERE state IN (${states.map(() => '?').join(', ')}) AND computer IS NULL ORDER BY created_at`)
      .all(...states) as ChatRow[];
    return rows.map((row) => toChat(row)!);
  }

  chatStateSince(chatId: string): number | null {
    const row = this.db.prepare("SELECT ts FROM events WHERE chat_id = ? AND type = 'chat.state' ORDER BY seq DESC LIMIT 1").get(chatId) as { ts: number } | undefined;
    return row?.ts ?? null;
  }

  setChatTerminal(id: string, terminal: string | null): void {
    this.db.prepare('UPDATE chats SET terminal = ? WHERE id = ?').run(terminal, id);
  }

  getChatTerminal(id: string): string | undefined {
    const row = this.db.prepare('SELECT terminal FROM chats WHERE id = ?').get(id) as { terminal: string | null } | undefined;
    return row?.terminal ?? undefined;
  }

  chatsInTerminals(): string[] {
    return (this.db.prepare('SELECT id FROM chats WHERE terminal IS NOT NULL').all() as Array<{ id: string }>).map((r) => r.id);
  }

  savePushSubscription(target: PushTarget, label: string, at: number): void {
    this.db
      .prepare(
        'INSERT INTO push_subscriptions (endpoint, keys, label, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET keys = excluded.keys, label = excluded.label',
      )
      .run(target.endpoint, JSON.stringify(target.keys), label, at);
  }

  deletePushSubscription(endpoint: string): void {
    this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  }

  pushSubscriptions(): Array<PushTarget & PushDevice> {
    const rows = this.db.prepare('SELECT * FROM push_subscriptions ORDER BY created_at, rowid').all() as Array<{
      endpoint: string;
      keys: string;
      label: string;
      created_at: number;
    }>;
    return rows.map((row) => ({ endpoint: row.endpoint, keys: JSON.parse(row.keys), label: row.label, createdAt: row.created_at }));
  }

  lastEventSeq(): number {
    return (this.db.prepare('SELECT MAX(seq) AS seq FROM events').get() as { seq: number | null }).seq ?? 0;
  }

  chatForTerminal(terminal: string): string | undefined {
    const row = this.db.prepare('SELECT id FROM chats WHERE terminal = ?').get(terminal) as { id: string } | undefined;
    return row?.id;
  }

  chatsWithIdPrefix(prefix: string): Chat[] {
    const rows = this.db.prepare('SELECT * FROM chats WHERE substr(id, 1, ?) = ?').all(prefix.length, prefix) as ChatRow[];
    return rows.map((row) => toChat(row)!);
  }

  chatsInTopic(topicId: string): Chat[] {
    const rows = this.db
      .prepare('SELECT * FROM chats WHERE topic_id = ? ORDER BY created_at, rowid')
      .all(topicId) as ChatRow[];
    return rows.map((row) => toChat(row)!);
  }

  insertLock(lock: Lock, ttlMs: number): void {
    this.db
      .prepare('INSERT INTO locks (id, topic_id, chat_id, pattern, ttl_ms, acquired_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(lock.id, lock.topicId, lock.chatId, lock.pattern, ttlMs, lock.acquiredAt, lock.expiresAt);
  }

  setLockTtl(id: string, ttlMs: number, expiresAt: number): void {
    this.db.prepare('UPDATE locks SET ttl_ms = ?, expires_at = ? WHERE id = ?').run(ttlMs, expiresAt, id);
  }

  renewLocks(chatId: string, now: number): void {
    this.db.prepare('UPDATE locks SET expires_at = ? + ttl_ms WHERE chat_id = ? AND expires_at > ?').run(now, chatId, now);
  }

  moveLock(id: string, chatId: string): void {
    this.db.prepare('UPDATE locks SET chat_id = ? WHERE id = ?').run(chatId, id);
  }

  deleteLock(id: string): void {
    this.db.prepare('DELETE FROM locks WHERE id = ?').run(id);
  }

  topicLocks(topicId: string): Lock[] {
    const rows = this.db.prepare('SELECT * FROM locks WHERE topic_id = ? ORDER BY acquired_at, rowid').all(topicId) as LockRow[];
    return rows.map(toLock);
  }

  chatLocks(chatId: string): Lock[] {
    const rows = this.db.prepare('SELECT * FROM locks WHERE chat_id = ? ORDER BY acquired_at, rowid').all(chatId) as LockRow[];
    return rows.map(toLock);
  }

  liveLocksOn(pattern: string, now: number): Lock[] {
    const rows = this.db.prepare('SELECT * FROM locks WHERE pattern = ? AND expires_at > ? ORDER BY acquired_at, rowid').all(pattern, now) as LockRow[];
    return rows.map(toLock);
  }

  expiredLocks(now: number): Lock[] {
    const rows = this.db.prepare('SELECT * FROM locks WHERE expires_at <= ? ORDER BY expires_at, rowid').all(now) as LockRow[];
    return rows.map(toLock);
  }

  saveTask(task: Task): void {
    this.db
      .prepare(
        `INSERT INTO tasks (topic_id, ref, title, depends_on, state, claimed_by, claimed_at, limit_minutes, flagged, note, created_by_chat, created_at, done_at,
           priority, rank, criteria, evidence, question, from_snag, discovered_from, closed_by_chat, mirror_id, mirror_auto)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (topic_id, ref) DO UPDATE SET state = excluded.state, claimed_by = excluded.claimed_by, claimed_at = excluded.claimed_at,
         flagged = excluded.flagged, note = excluded.note, done_at = excluded.done_at, priority = excluded.priority, rank = excluded.rank,
         criteria = excluded.criteria, evidence = excluded.evidence, question = excluded.question, closed_by_chat = excluded.closed_by_chat,
         mirror_id = excluded.mirror_id, mirror_auto = excluded.mirror_auto`,
      )
      .run(
        task.topicId,
        task.ref,
        task.title,
        JSON.stringify(task.dependsOn),
        task.state,
        task.claimedBy,
        task.claimedAt,
        task.limitMinutes ?? 0,
        Number(task.flagged),
        task.note,
        task.createdByChat,
        task.createdAt,
        task.doneAt,
        task.priority,
        task.rank,
        JSON.stringify(task.criteria),
        task.evidence,
        task.question,
        task.fromSnag,
        task.discoveredFrom,
        task.closedByChat,
        task.mirrorId,
        Number(task.mirrorAuto),
      );
  }

  saveCanvas(c: Canvas): void {
    this.db
      .prepare(
        `INSERT INTO canvases (topic_id, ref, chat_id, version, spec, layout, draft, open_blocks, feedback, submits, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (topic_id, ref) DO UPDATE SET chat_id = excluded.chat_id, version = excluded.version, spec = excluded.spec, layout = excluded.layout,
         draft = excluded.draft, open_blocks = excluded.open_blocks, feedback = excluded.feedback, submits = excluded.submits, state = excluded.state,
         updated_at = excluded.updated_at`,
      )
      .run(c.topicId, c.ref, c.chatId, c.version, JSON.stringify(c.spec), JSON.stringify(c.layout), JSON.stringify(c.draft), JSON.stringify(c.open), JSON.stringify(c.fb), JSON.stringify(c.submits), c.state, c.createdAt, c.updatedAt);
  }

  saveCanvasDraft(topicId: string, ref: string, draft: Canvas['draft']): boolean {
    return this.db.prepare('UPDATE canvases SET draft = ? WHERE topic_id = ? AND ref = ?').run(JSON.stringify(draft), topicId, ref).changes > 0;
  }

  canvas(topicId: string, ref: string): Canvas | undefined {
    const row = this.db.prepare('SELECT * FROM canvases WHERE topic_id = ? AND ref = ?').get(topicId, ref) as CanvasRow | undefined;
    return row && toCanvas(row);
  }

  canvases(topicId: string): Canvas[] {
    return (this.db.prepare('SELECT * FROM canvases WHERE topic_id = ? ORDER BY created_at, rowid').all(topicId) as CanvasRow[]).map(toCanvas);
  }

  nextCanvasNumber(topicId: string): number {
    const refs = this.db.prepare('SELECT ref FROM canvases WHERE topic_id = ?').all(topicId) as Array<{ ref: string }>;
    return Math.max(0, ...refs.map((r) => Number(/^C(\d+)$/.exec(r.ref)?.[1] ?? 0))) + 1;
  }

  nextTaskNumber(topicId: string): number {
    const refs = this.db.prepare('SELECT ref FROM tasks WHERE topic_id = ?').all(topicId) as Array<{ ref: string }>;
    return Math.max(0, ...refs.map((r) => Number(/^T(\d+)$/.exec(r.ref)?.[1] ?? 0))) + 1;
  }

  tasks(topicId: string): Task[] {
    const rows = this.db.prepare('SELECT * FROM tasks WHERE topic_id = ? ORDER BY created_at, rowid').all(topicId) as TaskRow[];
    return rows.map(toTask);
  }

  overdueTasks(now: number): Task[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE state = 'claimed' AND flagged = 0 AND limit_minutes > 0 AND claimed_at + limit_minutes * 60000 <= ? ORDER BY claimed_at, rowid")
      .all(now) as TaskRow[];
    return rows.map(toTask);
  }

  chatBusState(id: string): ChatBusState {
    const row = this.db
      .prepare('SELECT turns, card, card_turn, cross_chat_tokens FROM chats WHERE id = ?')
      .get(id) as { turns: number; card: string | null; card_turn: number | null; cross_chat_tokens: number };
    return { turns: row.turns, card: row.card, cardTurn: row.card_turn, crossChatTokens: row.cross_chat_tokens };
  }

  countTurn(id: string): void {
    this.db.prepare('UPDATE chats SET turns = turns + 1 WHERE id = ?').run(id);
  }

  setCard(id: string, card: string): void {
    this.db.prepare('UPDATE chats SET card = ?, card_turn = turns WHERE id = ?').run(card, id);
  }

  addCrossChatTokens(id: string, tokens: number): void {
    this.db.prepare('UPDATE chats SET cross_chat_tokens = cross_chat_tokens + ? WHERE id = ?').run(tokens, id);
  }

  setChatNativeSession(id: string, nativeSessionId: string | null): void {
    this.db.prepare('UPDATE chats SET native_session_id = ? WHERE id = ?').run(nativeSessionId, id);
  }

  insertApproval(approval: Approval): void {
    this.db
      .prepare(
        'INSERT INTO approvals (id, chat_id, topic_id, workspace_id, tool, input, action_class, outcome, reason, decision, via, decided_by, created_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        approval.id,
        approval.chatId,
        approval.topicId,
        approval.workspaceId ?? null,
        approval.tool,
        approval.input,
        approval.actionClass,
        approval.outcome,
        approval.reason,
        approval.decision,
        approval.via,
        approval.decidedBy,
        approval.createdAt,
        approval.decidedAt,
      );
  }

  listApprovals(): Approval[] {
    const rows = this.db.prepare('SELECT * FROM approvals ORDER BY created_at DESC, rowid DESC').all() as ApprovalRow[];
    return rows.map((row) => toApproval(row)!);
  }

  getApproval(id: string): Approval | undefined {
    return toApproval(this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as ApprovalRow | undefined);
  }

  openApprovals(): Approval[] {
    const rows = this.db.prepare('SELECT * FROM approvals WHERE decision IS NULL ORDER BY created_at').all() as ApprovalRow[];
    return rows.map((row) => toApproval(row)!);
  }

  decideApproval(
    id: string,
    decision: NonNullable<Approval['decision']>,
    at: number,
    via: NonNullable<Approval['via']>,
    decidedBy: string | null,
  ): void {
    this.db
      .prepare('UPDATE approvals SET decision = ?, decided_at = ?, via = ?, decided_by = ? WHERE id = ?')
      .run(decision, at, via, decidedBy, id);
  }

  saveInboxItem(item: InboxItem): void {
    this.db
      .prepare(
        'INSERT INTO inbox (id, kind, chat_id, state, created_at, item) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, item = excluded.item',
      )
      .run(item.id, item.kind, item.chatId, item.state, item.createdAt, JSON.stringify(item));
  }

  getInboxItem(id: string): InboxItem | undefined {
    const row = this.db.prepare('SELECT item FROM inbox WHERE id = ?').get(id) as { item: string } | undefined;
    return row && (JSON.parse(row.item) as InboxItem);
  }

  openInboxItems(chatId?: string): InboxItem[] {
    const rows = this.db
      .prepare(`SELECT item FROM inbox WHERE state = 'open'${chatId ? ' AND chat_id = ?' : ''} ORDER BY created_at, rowid`)
      .all(...(chatId ? [chatId] : [])) as Array<{ item: string }>;
    return rows.map((row) => JSON.parse(row.item) as InboxItem);
  }

  latestPlan(chatId: string): InboxItem | undefined {
    const row = this.db.prepare(`SELECT item FROM inbox WHERE kind = 'plan' AND chat_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(chatId) as { item: string } | undefined;
    return row && (JSON.parse(row.item) as InboxItem);
  }

  inboxAddedSeq(itemId: string): number | undefined {
    const row = this.db.prepare(`SELECT seq FROM events WHERE type = 'inbox.added' AND json_extract(body, '$.item.id') = ?`).get(itemId) as { seq: number } | undefined;
    return row?.seq;
  }

  // Only the user's own sends through the API carry no `from`; hos notices, chat sends and spawn prompts all set it.
  latestHumanMessage(chatId: string): { seq: number; body: Extract<EventBody, { type: 'message.user' }> } | undefined {
    const row = this.db
      .prepare(`SELECT seq, body FROM events WHERE chat_id = ? AND type = 'message.user' AND json_extract(body, '$.from') IS NULL ORDER BY seq DESC LIMIT 1`)
      .get(chatId) as { seq: number; body: string } | undefined;
    return row && { seq: row.seq, body: JSON.parse(row.body) };
  }

  humanMessages(chatId: string): string[] {
    const rows = this.db
      .prepare(`SELECT json_extract(body, '$.text') AS text FROM events WHERE chat_id = ? AND type = 'message.user' AND json_extract(body, '$.from') IS NULL`)
      .all(chatId) as Array<{ text: string }>;
    return rows.map((row) => row.text);
  }

  saveActionRun(run: ActionRun): void {
    this.db
      .prepare(
        'INSERT INTO action_runs (id, workspace_id, state, created_at, run) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, run = excluded.run',
      )
      .run(run.id, run.workspaceId, run.state, run.createdAt, JSON.stringify(run));
  }

  getActionRun(id: string): ActionRun | undefined {
    const row = this.db.prepare('SELECT run FROM action_runs WHERE id = ?').get(id) as { run: string } | undefined;
    return row && (JSON.parse(row.run) as ActionRun);
  }

  actionRunsIn(states: ActionRun['state'][]): ActionRun[] {
    const rows = this.db
      .prepare(`SELECT run FROM action_runs WHERE state IN (${states.map(() => '?').join(', ')}) ORDER BY created_at, rowid`)
      .all(...states) as Array<{ run: string }>;
    return rows.map((row) => JSON.parse(row.run) as ActionRun);
  }

  insertPasskey(passkey: PasskeyRecord): void {
    this.db
      .prepare('INSERT INTO passkeys (id, rp_id, public_key, transports, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(passkey.id, passkey.rpId, Buffer.from(passkey.publicKey), JSON.stringify(passkey.transports), passkey.createdAt);
  }

  passkeyRpIds(): string[] {
    const rows = this.db.prepare('SELECT rp_id FROM passkeys GROUP BY rp_id ORDER BY MIN(created_at)').all() as Array<{ rp_id: string }>;
    return rows.map((row) => row.rp_id);
  }

  passkeys(rpId: string): PasskeyRecord[] {
    const rows = this.db.prepare('SELECT * FROM passkeys WHERE rp_id = ? ORDER BY created_at').all(rpId) as Array<{
      id: string;
      rp_id: string;
      public_key: Buffer;
      transports: string;
      created_at: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      rpId: row.rp_id,
      publicKey: new Uint8Array(row.public_key),
      transports: JSON.parse(row.transports) as string[],
      createdAt: row.created_at,
    }));
  }

  insertSession(tokenHash: string, session: SessionRecord, createdAt: number): void {
    this.db
      .prepare('INSERT INTO sessions (token_hash, rp_id, passkey_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(tokenHash, session.rpId, session.passkeyId, createdAt, session.expiresAt);
  }

  getSession(tokenHash: string): SessionRecord | undefined {
    const row = this.db.prepare('SELECT rp_id, passkey_id, expires_at FROM sessions WHERE token_hash = ?').get(tokenHash) as
      | { rp_id: string; passkey_id: string; expires_at: number }
      | undefined;
    return row && { rpId: row.rp_id, passkeyId: row.passkey_id, expiresAt: row.expires_at };
  }

  chatSessionCwd(id: string): string | null {
    return (this.db.prepare('SELECT session_cwd FROM chats WHERE id = ?').get(id) as { session_cwd: string | null } | undefined)?.session_cwd ?? null;
  }

  setChatSessionCwd(id: string, cwd: string | null): void {
    this.db.prepare('UPDATE chats SET session_cwd = ? WHERE id = ?').run(cwd, id);
  }
  updateWorkspace(workspace: Workspace): void {
    this.db
      .prepare('UPDATE workspaces SET name = ?, path = ?, branch = ?, base = ?, setup_state = ?, setup_log = ?, archived_at = ? WHERE id = ?')
      .run(workspace.name, workspace.path, workspace.branch, workspace.base, workspace.setup, workspace.setupLog, workspace.archivedAt, workspace.id);
  }

  deleteWorkspace(id: string): void {
    this.db.prepare('DELETE FROM topic_workspaces WHERE workspace_id = ?').run(id);
    this.db.prepare('DELETE FROM action_runs WHERE workspace_id = ?').run(id);
    this.db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
  }

  workspacesInSetup(): Workspace[] {
    const rows = this.db.prepare("SELECT * FROM workspaces WHERE setup_state IN ('pending', 'running')").all() as WorkspaceRow[];
    return rows.map((row) => toWorkspace(row)!);
  }
  touchFile(row: { topicId: string; workspaceId: string; path: string; chatId: string; firstAt: number }): void {
    this.db
      .prepare('INSERT OR IGNORE INTO touched_files (topic_id, workspace_id, path, chat_id, first_at) VALUES (?, ?, ?, ?, ?)')
      .run(row.topicId, row.workspaceId, row.path, row.chatId, row.firstAt);
  }

  touchedFiles(topicId: string, workspaceId: string): Array<{ path: string; chatId: string; firstAt: number }> {
    const rows = this.db
      .prepare('SELECT path, chat_id, first_at FROM touched_files WHERE topic_id = ? AND workspace_id = ? ORDER BY first_at, rowid')
      .all(topicId, workspaceId) as Array<{ path: string; chat_id: string; first_at: number }>;
    return rows.map((row) => ({ path: row.path, chatId: row.chat_id, firstAt: row.first_at }));
  }
  setChatPick(id: string, model: string | null, effort: Chat['effort']): void {
    this.db.prepare('UPDATE chats SET model = ?, effort = ? WHERE id = ?').run(model, effort, id);
  }

  setChatTitle(id: string, title: string, naming: boolean): void {
    this.db.prepare('UPDATE chats SET title = ?, naming = ? WHERE id = ?').run(title, Number(naming), id);
  }

  setChatTabClosed(id: string, closed: boolean): void {
    this.db.prepare('UPDATE chats SET tab_closed = ? WHERE id = ?').run(Number(closed), id);
  }

  limitResumes(): Array<{ chatId: string; at: number }> {
    const rows = this.db.prepare('SELECT key, value FROM meta WHERE key LIKE ?').all(`${LIMIT_RESUME_META}%`) as Array<{ key: string; value: string }>;
    return rows.map((row) => ({ chatId: row.key.slice(LIMIT_RESUME_META.length), at: Number(row.value) }));
  }

  setChatNotify(id: string, notify: boolean): void {
    this.db.prepare('UPDATE chats SET notify = ? WHERE id = ?').run(Number(notify), id);
  }
}

export interface PasskeyRecord {
  id: string;
  rpId: string;
  publicKey: Uint8Array<ArrayBuffer>;
  transports: string[];
  createdAt: number;
}

export interface SessionRecord {
  rpId: string;
  passkeyId: string;
  expiresAt: number;
}

function toChat(row: ChatRow | undefined): Chat | undefined {
  return (
    row && {
      id: row.id,
      topicId: row.topic_id,
      agent: row.agent,
      state: row.state,
      createdBy: row.created_by,
      createdAt: row.created_at,
      parentId: row.parent_id,
      role: LEGACY_ROLES[row.role] ?? row.role,
      depth: row.depth,
      intent: row.intent,
      ownedFiles: JSON.parse(row.owned_files) as string[],
      worktreePath: row.worktree_path,
      predecessorId: row.predecessor_id,
      lineageId: row.lineage_id ?? row.id,
      generation: row.generation,
      priority: row.priority,
      model: row.model,
      effort: row.effort ?? null,
      suspended: row.suspended === 1,
      title: row.title ?? null,
      naming: row.naming === 1,
      tabClosed: row.tab_closed === 1,
      chrome: row.chrome === 1,
      // Chats from before the bell existed: on for the ones the user started.
      notify: row.notify === null ? row.created_by !== 'agent' : row.notify === 1,
      profile: row.profile,
      ...(row.computer ? { computer: row.computer } : {}),
    }
  );
}

interface LockRow {
  id: string;
  topic_id: string;
  chat_id: string;
  pattern: string;
  acquired_at: number;
  expires_at: number;
}

function toLock(row: LockRow): Lock {
  return {
    id: row.id,
    topicId: row.topic_id,
    chatId: row.chat_id,
    pattern: row.pattern,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
  };
}

interface TaskRow {
  topic_id: string;
  ref: string;
  title: string;
  depends_on: string;
  state: Task['state'];
  claimed_by: string | null;
  claimed_at: number | null;
  limit_minutes: number;
  flagged: number;
  note: string | null;
  created_by_chat: string | null;
  created_at: number;
  done_at: number | null;
  priority: number;
  rank: number;
  criteria: string;
  evidence: string | null;
  question: string | null;
  from_snag: string | null;
  discovered_from: string | null;
  closed_by_chat: string | null;
  mirror_id: string | null;
  mirror_auto: number;
}

interface CanvasRow {
  topic_id: string;
  ref: string;
  chat_id: string;
  version: number;
  spec: string;
  layout: string;
  draft: string;
  open_blocks: string;
  feedback: string;
  submits: string;
  state: Canvas['state'];
  created_at: number;
  updated_at: number;
}

function toCanvas(row: CanvasRow): Canvas {
  return {
    topicId: row.topic_id,
    ref: row.ref,
    chatId: row.chat_id,
    version: row.version,
    spec: JSON.parse(row.spec),
    layout: JSON.parse(row.layout),
    draft: JSON.parse(row.draft),
    open: JSON.parse(row.open_blocks),
    fb: JSON.parse(row.feedback),
    submits: JSON.parse(row.submits),
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toTask(row: TaskRow): Task {
  return {
    topicId: row.topic_id,
    ref: row.ref,
    title: row.title,
    dependsOn: JSON.parse(row.depends_on) as string[],
    state: row.state,
    claimedBy: row.claimed_by,
    claimedAt: row.claimed_at,
    limitMinutes: row.limit_minutes || null,
    flagged: row.flagged === 1,
    note: row.note,
    createdByChat: row.created_by_chat,
    createdAt: row.created_at,
    doneAt: row.done_at,
    priority: (row.priority === 1 || row.priority === 3 ? row.priority : 2) as Task['priority'],
    rank: row.rank,
    criteria: JSON.parse(row.criteria) as Task['criteria'],
    evidence: row.evidence,
    question: row.question,
    fromSnag: row.from_snag,
    discoveredFrom: row.discovered_from,
    closedByChat: row.closed_by_chat,
    mirrorId: row.mirror_id,
    mirrorAuto: row.mirror_auto === 1,
  };
}

function toHandoff(row: HandoffRow): Handoff {
  return {
    id: row.id,
    lineageId: row.lineage_id,
    chatId: row.chat_id,
    generation: row.generation,
    successorId: row.successor_id,
    path: row.path,
    kind: row.kind,
    reason: row.reason,
    attempts: row.attempts,
    bootTokens: row.boot_tokens,
    createdAt: row.created_at,
  };
}

function toApproval(row: ApprovalRow | undefined): Approval | undefined {
  return (
    row && {
      id: row.id,
      chatId: row.chat_id,
      topicId: row.topic_id,
      ...(row.workspace_id ? { workspaceId: row.workspace_id } : {}),
      tool: row.tool,
      input: row.input,
      actionClass: row.action_class,
      outcome: row.outcome,
      reason: row.reason,
      decision: row.decision,
      via: row.via,
      decidedBy: row.decided_by,
      createdAt: row.created_at,
      decidedAt: row.decided_at,
    }
  );
}

function toWorkspace(row: WorkspaceRow | undefined): Workspace | undefined {
  return (
    row && {
      id: row.id,
      projectId: row.project_id,
      kind: row.kind,
      name: row.name,
      path: row.path,
      branch: row.branch,
      base: row.base,
      setup: row.setup_state,
      setupLog: row.setup_log,
      archivedAt: row.archived_at,
      createdBy: row.created_by,
      createdByChat: row.created_by_chat,
      createdAt: row.created_at,
    }
  );
}

export function eventChatId(body: EventBody): string | null {
  return 'chatId' in body ? (body.chatId ?? null) : body.type === 'chat.created' ? body.chat.id : 'item' in body ? body.item.chatId : null;
}

export function workspaceName(branch: string | null): string {
  return (branch ?? 'worktree').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'worktree';
}

const FOLDER_EVENTS = new Set(['diff.action', 'action.output']);
const RENAMED_FIELDS = ['chat', 'entry', 'lock', 'task', 'cell', 'item'];

function v1Event(body: Record<string, unknown>, folderOf: Map<string, string>): Record<string, unknown> & { type: string } {
  const type = String(body.type);
  if (type === 'workspace.created' || type === 'workspace.updated') {
    const w = body.workspace as Record<string, unknown>;
    const folder = folderOf.get(String(w.id));
    const topic = {
      id: w.id,
      title: w.name,
      statusTopic: w.statusTopic ?? '',
      workDir: null,
      state: w.state,
      request: w.request ?? null,
      workspaceIds: folder ? [folder] : [],
      lastSeenAt: null,
      lastActivityAt: null,
      createdBy: w.createdBy ?? 'human',
      createdByChat: w.createdByChat ?? null,
      createdAt: w.createdAt,
    };
    return { type: type === 'workspace.created' ? 'topic.created' : 'topic.updated', topic };
  }
  const next: Record<string, unknown> = { ...body };
  if (type === 'kill.switch' && next.scope === 'workspace') next.scope = 'topic';
  if (type === 'action.run') {
    const run = next.run as Record<string, unknown>;
    next.run = { ...run, workspaceId: folderOf.get(String(run.workspaceId)) ?? run.workspaceId };
  } else if ('workspaceId' in next) {
    const { workspaceId, ...rest } = next;
    if (FOLDER_EVENTS.has(type)) return { ...next, type, workspaceId: folderOf.get(String(workspaceId)) ?? workspaceId };
    const folder = type.startsWith('approval.') && rest.chatId === null ? folderOf.get(String(workspaceId)) : undefined;
    return { ...rest, type: String(next.type), topicId: workspaceId, ...(folder ? { workspaceId: folder } : {}) };
  }
  for (const field of RENAMED_FIELDS) {
    const value = next[field] as Record<string, unknown> | undefined;
    if (value && typeof value === 'object' && 'workspaceId' in value) {
      const { workspaceId, ...rest } = value;
      next[field] = { ...rest, topicId: workspaceId };
    }
  }
  return next as Record<string, unknown> & { type: string };
}

function toProject(row: ProjectRow | undefined, brainDir: string | null): Project | undefined {
  return (
    row && {
      id: row.id,
      name: row.name,
      path: row.path,
      key: row.key,
      pinned: Boolean(row.pinned),
      hidden: Boolean(row.hidden),
      custom: Boolean(row.custom),
      brain: row.path === brainDir,
      createdBy: row.created_by,
      createdAt: row.created_at,
    }
  );
}

function acquireLock(lockFile: string): boolean {
  try {
    writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const holder = Number(readFileSync(lockFile, 'utf8'));
    if (isAlive(holder)) throw new Error(`another hos daemon (pid ${holder}) holds ${lockFile}`);
    writeFileSync(lockFile, String(process.pid));
    return true;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
