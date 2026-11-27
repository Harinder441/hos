import type { AgentRuntime } from '../adapters/agent-runtime.js';
import type { CalendarDay, HarnessFeatures, HarnessMark, ModelsConfig, NowBlocks, SourceResult, TodayList } from '../api/types.js';
import type { AcpConfig } from '../harnesses/acp/config.js';
import type { TOOL_NAMES } from '../harnesses/tools.js';
import type { CommentAuthor, SnagKind, SnagState } from '../snags/types.js';

export type { CalendarDay, HarnessFeatures, HarnessMark, ModelsConfig, NowBlocks, SourceResult, TimeBlock, TodayList, TodayTask } from '../api/types.js';
export type { AcpConfig, AcpHooks } from '../harnesses/acp/config.js';

export const PLUGIN_API_VERSION = 2;

export type Priority = 'high' | 'normal' | 'low';

export interface SnagRecord {
  ref: number;
  kind: SnagKind;
  text: string;
  files: Array<{ name: string; path?: string }>;
  state: SnagState;
  created_at: string;
  created_by: string;
  source_host: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  note: string | null;
  links: Array<{ topicId: string; chatId: string; at: string }>;
  context: string | null;
  comments?: SnagCommentRecord[];
  last_comment_author?: CommentAuthor | null;
}

export interface SnagCommentRecord {
  id: string;
  author: CommentAuthor;
  body: string;
  created_at: string;
}

export interface NewSnagRecord {
  kind: SnagKind;
  text: string;
  created_by: string;
  source_host: string;
  context: string | null;
}

export interface SnagUpload {
  name: string;
  bytes: Buffer;
}

export type SnagChange =
  | { type: 'resolve'; state: string; note: string | null; by: string }
  | { type: 'reopen' }
  | { type: 'link'; topicId: string; chatId: string }
  | { type: 'update'; text: string }
  | { type: 'delete' };

export interface DeskChat {
  chat_id: string;
  topic: string;
  title: string | null;
  since: string | null;
}

export interface DeskScreen {
  generated_at: string;
  waiting: Array<DeskChat & { ask: string }>;
  running: DeskChat[];
  open_snags: number;
}

interface SourceBase<K extends string> {
  kind: K;
  version: number;
  label: string;
  close?(): void | Promise<void>;
}

export interface TasksSource extends SourceBase<'tasks'> {
  today(): Promise<TodayList>;
  done(id: string): Promise<SourceResult>;
  addLinked(title: string, priority: Priority, link: string | null): Promise<{ ok: true; id: string } | { ok: false; reason: string }>;
  drop(id: string): Promise<SourceResult>;
  setPriority(id: string, priority: Priority): Promise<SourceResult>;
}

export interface CaptureSource extends SourceBase<'capture'> {
  capture(text: string): Promise<SourceResult>;
}

export interface CalendarSource extends SourceBase<'calendar'> {
  today(): Promise<CalendarDay>;
  now?(): Promise<NowBlocks>;
  link?: string;
}

export interface SnagSource extends SourceBase<'snags'> {
  status(): { offline: boolean; queued: number };
  list(): Promise<SnagRecord[]>;
  get(ref: number): Promise<SnagRecord>;
  find(ref: number): Promise<SnagRecord>;
  add(snag: NewSnagRecord, files: SnagUpload[]): Promise<SnagRecord>;
  change(ref: number, change: SnagChange): Promise<SnagRecord | null>;
  comment(ref: number, body: string, author: CommentAuthor): Promise<SnagRecord>;
  localFile(record: SnagRecord, name: string): Promise<string>;
  authors?: Record<string, string>;
}

export interface NotifierSource extends SourceBase<'notifier'> {
  everyMs?: number;
  push(screen: DeskScreen): Promise<void>;
}

export interface HarnessSource extends SourceBase<'harness'> {
  id: string;
  pool?: string;
  slots?: number;
  aliases?: string[];
  features?: Partial<HarnessFeatures>;
  badge?: HarnessMark;
  models(): ModelsConfig;
  runtime: AgentRuntime;
}

export interface SourceKinds {
  tasks: TasksSource;
  capture: CaptureSource;
  calendar: CalendarSource;
  snags: SnagSource;
  notifier: NotifierSource;
  harness: HarnessSource;
}

export type Source = SourceKinds[keyof SourceKinds] | (SourceBase<string> & Record<string, unknown>);

export interface PluginStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface PluginDatabase {
  exec(sql: string): void;
  prepare(sql: string): PluginStatement;
  transaction<T extends (...args: never[]) => unknown>(fn: T): T;
  close(): void;
}

export interface SnagFiles {
  dir(ref: number): string;
  save(ref: number, files: SnagUpload[]): Promise<void>;
  move(from: number, to: number): Promise<void>;
  remove(ref: number): Promise<void>;
}

export interface PluginHost {
  readonly apiVersion: number;
  readonly hosVersion: string;
  readonly name: string;
  readonly options: Record<string, unknown>;
  readonly dataDir: string;
  readonly brainDir: string | null;
  provide(source: Source): void;
  log(line: string): void;
  now(): number;
  setTimeout(fn: () => void, ms: number): () => void;
  sqlite(file: string): PluginDatabase;
  fail(status: number, message: string): Error;
  snagFiles: SnagFiles;
  snagReached(pendingRef: number, record: SnagRecord): void;
  acp(id: string, config: AcpConfig): AgentRuntime;
  readonly tools: typeof TOOL_NAMES;
}

export interface PluginModule {
  name: string;
  apiVersion: number;
  register(host: PluginHost): void | Promise<void>;
}
