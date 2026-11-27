export type ChatState =
  | 'queued'
  | 'starting'
  | 'running'
  | 'idle'
  | 'waiting_input'
  | 'done'
  | 'failed'
  | 'paused'
  | 'killed'
  | 'terminal'
  | 'handing_off'
  | 'handed_off'
  | 'archived';

export const ROLES = ['main', 'worker', 'reviewer', 'scout'] as const;

export type Role = (typeof ROLES)[number];

export type SpawnRole = Extract<Role, 'main' | 'worker' | 'reviewer' | 'scout'>;

export type Creator = 'human' | 'agent' | 'system';

export interface Project {
  id: string;
  name: string;
  path: string;
  key: string | null;
  pinned: boolean;
  hidden: boolean;
  custom: boolean;
  brain: boolean;
  createdBy: Creator;
  createdAt: number;
}

export interface Worktree {
  path: string;
  projectId: string;
  name: string;
  main: boolean;
  branch: string | null;
  head: string | null;
  dirty: boolean;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  unpushed: number;
  port: number;
  chatIds: string[];
  createdBy: Creator;
  createdByChat: string | null;
}

export interface ProjectView extends Project {
  worktrees: Worktree[];
}

export const TOPIC_STATES = ['active', 'blocked', 'review', 'done', 'archived'] as const;

export type TopicState = (typeof TOPIC_STATES)[number];

export interface Topic {
  id: string;
  title: string;
  statusTopic: string;
  workDir: string | null;
  state: TopicState;
  request: string | null;
  workspaceIds: string[];
  lastSeenAt: number | null;
  lastActivityAt: number | null;
  createdBy: Creator;
  createdByChat: string | null;
  createdAt: number;
  naming: boolean;
  tabOrder: string[];
  desk?: boolean;
  home?: string;
}

export interface ComputerTopic {
  id: string;
  title: string;
  state: TopicState;
  lastActivityAt: number | null;
  home: string | null;
  chats: Array<Pick<Chat, 'id' | 'title' | 'state' | 'role'> & { computer: string | null }>;
}

export interface ComputerCaps {
  name: string;
  short?: string;
  apiVersion: number;
  hosVersion: string;
  scheduleHost: string;
  harnesses: Array<HarnessChoice & { loggedIn: boolean }>;
  browser: boolean;
  slots: Record<string, SlotUse>;
  projects: Array<{ key: string; name: string }>;
  brainHead: string | null;
}

export interface Computer {
  name: string;
  direction: 'in' | 'out';
  url: string | null;
  addedAt: number;
  lastSeen: number | null;
  online: boolean;
  connected: boolean;
  error: string | null;
  hosVersion: string | null;
  apiVersion: number | null;
  needsUpdate: boolean;
  caps: ComputerCaps | null;
  topics: ComputerTopic[];
  schedules: ScheduleView[];
}

export interface ComputersView {
  self: { name: string; short: string; apiVersion: number; hosVersion: string };
  computers: Computer[];
}

export interface PairCode {
  code: string;
  expiresAt: number;
}

export interface ComputerHello {
  name: string;
  short: string;
  apiVersion: number;
  hosVersion: string;
  scheduleHost: string;
}

export interface RemoteChatInput {
  topic: { id: string; title: string; statusTopic: string; workDir: string | null };
  brainSha: string;
  workspaces: Array<{ projectKey: string; kind: WorkspaceKind; branch: string | null }>;
  pick: { agent?: string; model?: string; effort?: string; chrome?: boolean; profile?: string };
  spawn?: { parent: Chat; roster: Chat[]; request: Record<string, unknown>; workspace?: number };
}

export interface RemoteChatAnswer {
  chat?: Chat;
  seq: number;
  text?: string;
  outcome?: BusOutcome;
}

export interface ComputerTopicOpen {
  topic: Topic;
  chats: Chat[];
}

export interface ComputerChatPage {
  events: HosEvent[];
  next: number | null;
}

export interface OutboxItem {
  seq: number;
  chatId: string;
  fromChatId: string | null;
  text: string;
}

export interface TopicHistoryFact {
  topicId: string;
  workspaceIds: string[];
  historyEntries: number;
}

export type WorkspaceKind = 'root' | 'worktree';
export type SetupState = 'pending' | 'running' | 'ready' | 'failed';

export interface Workspace {
  id: string;
  projectId: string;
  kind: WorkspaceKind;
  name: string;
  path: string;
  branch: string | null;
  base: string | null;
  setup: SetupState;
  setupLog: string | null;
  archivedAt: number | null;
  createdBy: Creator;
  createdByChat: string | null;
  createdAt: number;
}

export interface PickerOption {
  value: string;
  kind: WorkspaceKind | 'new';
  branch: string | null;
  path: string | null;
  state: string;
  warn: boolean;
  usedBy: Array<{ topicId: string; title: string }>;
}

export interface PickerQuestion {
  repo: string;
  projectId: string;
  why: string;
  options: PickerOption[];
  suggested: string;
  suggestedBranch: string | null;
  base: string;
}

export function topicUnseen(topic: Pick<Topic, 'lastSeenAt' | 'lastActivityAt'>): boolean {
  return topic.lastActivityAt !== null && (topic.lastSeenAt === null || topic.lastActivityAt > topic.lastSeenAt);
}

export interface Chat {
  id: string;
  topicId: string;
  agent: string;
  state: ChatState;
  createdBy: Creator;
  createdAt: number;
  parentId: string | null;
  role: Role;
  depth: number;
  intent: string | null;
  ownedFiles: string[];
  worktreePath: string | null;
  predecessorId: string | null;
  lineageId: string;
  generation: number;
  priority: number;
  model: string | null;
  effort: Effort | null;
  suspended: boolean;
  title: string | null;
  naming: boolean;
  tabClosed: boolean;
  chrome: boolean;
  notify: boolean;
  profile: string;
  computer?: string;
}

export type ChatMode = 'build' | 'plan';

export interface ModelChoice {
  id: string;
  label: string;
}

export interface ModelsConfig {
  default: string;
  effort: Effort;
  list: ModelChoice[];
}

export interface ComposerConfig {
  pasteAsFileChars: number;
}

export interface OwnerInfo {
  name: string | null;
  timezone: string;
  timezoneLabel: string;
}

export interface HarnessFeatures {
  takeover: boolean;
  browser: boolean;
  contextRefresh: boolean;
  usageLimits: boolean;
}

export interface HarnessMark {
  text?: string;
  color?: string;
  aliases?: Record<string, string>;
}

export interface HarnessChoice {
  id: string;
  label: string;
  models: ModelsConfig;
  features?: HarnessFeatures;
  aliases?: string[];
  badge?: HarnessMark;
}

export interface SkillInfo {
  name: string;
  description: string;
}

export interface ProfileInfo {
  id: string;
  description: string;
  skills: number | null;
  canStart: 'all' | string[];
  contextRefresh: boolean;
  color: string | null;
  defaults: { harness: string | null; models: Record<string, { model: string | null; effort: Effort | null }> };
  browser: boolean;
  picker: boolean;
}

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

export type HandoffKind = 'agent' | 'salvage';

export interface Handoff {
  id: string;
  lineageId: string;
  chatId: string;
  generation: number;
  successorId: string | null;
  path: string;
  kind: HandoffKind;
  reason: string;
  attempts: number;
  bootTokens: number | null;
  createdAt: number;
}

export interface HandoffStats {
  handoffs: number;
  written: number;
  salvaged: number;
  successRate: number | null;
  bootTokens: number[];
  averageBootTokens: number | null;
}

export interface Lineage {
  id: string;
  chats: Chat[];
  handoffs: Handoff[];
  stats: HandoffStats;
  overall: HandoffStats;
}

export interface Terminal {
  name: string;
  cwd: string;
  createdAt: number;
  attachedClients: number;
  chatId: string | null;
  topicId: string | null;
  busy: boolean;
}

export type ServerState = 'listening' | 'starting' | 'exited';

export interface DevServer {
  name: string;
  app: string | null;
  state: ServerState;
  ports: number[];
  cwd: string;
  worktreePath: string | null;
  projectId: string | null;
  command: string | null;
  previewUrl: string | null;
}

export interface UnmanagedListener {
  pid: number;
  command: string;
  ports: number[];
  previewUrl: string | null;
}

export interface ServersView {
  servers: DevServer[];
  unmanaged: UnmanagedListener[];
}

export type ApprovalDecision = 'approve' | 'deny';

export type ActionClass = 'A0' | 'A1' | 'A2' | 'A3' | 'A4' | 'A5' | 'A5w' | 'A6' | 'A6b' | 'A7' | 'A8';

export type PolicyOutcome = 'auto' | 'ask' | 'ask_every_time' | 'deny';

export type Surface = 'mac' | 'phone';

export interface Approval {
  id: string;
  chatId: string | null;
  topicId: string | null;
  workspaceId?: string | null;
  tool: string;
  input: string;
  actionClass: ActionClass | null;
  outcome: PolicyOutcome;
  reason: string;
  decision: ApprovalDecision | 'cancelled' | null;
  via: Surface | 'policy' | 'system' | null;
  decidedBy: string | null;
  createdAt: number;
  decidedAt: number | null;
}

export interface Question {
  question: string;
  header: string;
  options: Array<{ label: string; description: string; preview?: string }>;
  multiSelect: boolean;
}

export type InboxKind = 'approval' | 'question' | 'completion' | 'failure' | 'alert' | 'keeper' | 'plan';

export interface InboxItem {
  id: string;
  kind: InboxKind;
  chatId: string | null;
  topicId?: string;
  workspaceId?: string;
  title: string;
  detail: string;
  state: 'open' | 'done';
  createdAt: number;
  actionClass?: ActionClass | null;
  questions?: Question[];
  recommendation?: string;
  parked?: boolean;
  picker?: PickerQuestion;
  plan?: { text: string };
  handoff?: { tokens: number; urgent: boolean };
}

export interface ContextSlice {
  name: string;
  tokens: number;
}

export interface HandoffTrigger {
  queued: boolean;
  reason: string | null;
}

export interface HandoffStatus {
  chatId: string;
  state: ChatState;
  stage: 'offered' | 'requested' | 'done' | null;
  queued: 'write' | 'salvage' | null;
  busy: string | null;
  successorId: string | null;
}

export interface ContextLimits {
  mode: 'ladder' | 'single';
  handoff: number;
  backstop: number;
}

export type DiffScope =
  | { workspaceId: string; ref?: string }
  | { chatId: string; since: 'start' | 'turn' };

export interface DiffFile {
  path: string;
  oldPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  uncommitted: boolean;
}

export interface Diff {
  workspaceId: string;
  chatId: string | null;
  files: DiffFile[];
  patch: string;
}

export interface ReviewComment {
  path: string;
  line: number;
  side: 'additions' | 'deletions';
  text: string;
}

export type DiffAction = 'discard' | 'commit' | 'open_pr' | 'merge' | 'push' | 'pull';

export interface DiffActionResult {
  action: DiffAction;
  state: 'done' | 'pending';
  detail: string;
  approvalId?: string;
}

export type ActionWhere = 'host' | 'tmux';

export interface ActionDef {
  name: string;
  run: string;
  args: string[];
  where: ActionWhere;
  cwd: string;
  confirm: boolean;
  source: 'brain' | 'repo';
}

export interface ActionList {
  actions: ActionDef[];
  errors: string[];
}

export type ActionRunState = 'pending' | 'running' | 'done' | 'failed' | 'denied';

export interface ActionRun {
  id: string;
  workspaceId: string;
  name: string;
  command: string;
  where: ActionWhere;
  state: ActionRunState;
  chatId: string | null;
  requestedBy: string;
  approvalId: string | null;
  terminal: string | null;
  exitCode: number | null;
  output: string;
  createdAt: number;
  finishedAt: number | null;
}

export type TranscriptEntry =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool_use'; toolUseId: string; name: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; output: string; isError: boolean };

export type EventBody =
  | { type: 'project.created'; project: Project }
  | { type: 'project.updated'; project: Project }
  | { type: 'project.removed'; projectId: string }
  | { type: 'worktree.updated'; worktree: Worktree }
  | { type: 'worktree.removed'; projectId: string; path: string }
  | { type: 'topic.created'; topic: Topic }
  | { type: 'topic.updated'; topic: Topic }
  | { type: 'workspace.created'; workspace: Workspace }
  | { type: 'workspace.updated'; workspace: Workspace }
  | { type: 'chat.created'; chat: Chat }
  | { type: 'chat.state'; chatId: string; state: ChatState }
  | { type: 'chat.error'; chatId: string; message: string }
  | { type: 'chat.takeover'; chatId: string; terminal: string }
  | { type: 'chat.handback'; chatId: string; terminal: string }
  | { type: 'context.loaded'; chatId: string; memoryFiles: string[]; skills: string[] }
  | { type: 'context.usage'; chatId: string; tokens: number; limits: ContextLimits; compactAt?: number }
  | { type: 'context.breakdown'; chatId: string; categories: ContextSlice[] }
  | {
      type: 'message.user';
      chatId: string;
      messageId: string;
      text: string;
      from?: 'hos' | 'chat';
      fromChatId?: string;
      attachments?: Array<{ name: string; path: string }>;
      canvas?: string;
    }
  | { type: 'message.delta'; chatId: string; messageId: string; text: string }
  | { type: 'message.completed'; chatId: string; messageId: string; text: string }
  | { type: 'thinking.delta'; chatId: string; thinkingId: string; text: string }
  | { type: 'thinking.completed'; chatId: string; thinkingId: string; text: string }
  | { type: 'tool.started'; chatId: string; toolUseId: string; name: string; input: string; parentToolUseId?: string }
  | { type: 'tool.completed'; chatId: string; toolUseId: string; output: string; isError: boolean; parentToolUseId?: string }
  | { type: 'subagent.started'; chatId: string; toolUseId: string; description: string; agentType: string | null; depth: number; prompt: string }
  | { type: 'subagent.progress'; chatId: string; toolUseId: string; tokens: number; tools: number; durationMs: number; lastTool: string | null }
  | {
      type: 'subagent.finished';
      chatId: string;
      toolUseId: string;
      status: SubagentEnd;
      summary: string;
      tokens?: number;
      tools?: number;
      durationMs?: number;
    }
  | { type: 'shell.started'; chatId: string; taskId: string; description: string }
  | { type: 'shell.finished'; chatId: string; taskId: string }
  | {
      type: 'approval.requested';
      chatId: string | null;
      topicId?: string;
      workspaceId?: string;
      approvalId: string;
      toolUseId?: string;
      tool: string;
      title?: string;
      input: string;
      actionClass: ActionClass | null;
      reason: string;
      outcome: PolicyOutcome;
    }
  | { type: 'approval.resolved'; chatId: string | null; approvalId: string; decision: ApprovalDecision | 'cancelled' }
  | {
      type: 'approval.policy';
      chatId: string | null;
      topicId?: string;
      workspaceId?: string;
      approvalId: string;
      tool: string;
      actionClass: ActionClass | null;
      decision: 'approve' | 'deny';
      reason: string;
    }
  | {
      type: 'diff.action';
      workspaceId: string;
      action: DiffAction;
      state: 'done' | 'failed' | 'denied';
      detail: string;
      approvalId?: string;
    }
  | { type: 'action.run'; run: ActionRun }
  | { type: 'action.output'; runId: string; workspaceId: string; text: string }
  | { type: 'inbox.added'; item: InboxItem }
  | { type: 'inbox.updated'; item: InboxItem }
  | {
      type: 'bus.call';
      chatId: string;
      tool: string;
      input: string;
      outcome: BusOutcome;
      tokens: number;
      message?: string;
    }
  | { type: 'card.updated'; chatId: string; card: string }
  | { type: 'servers.updated'; servers: DevServer[] }
  | { type: 'chat.result'; chatId: string; result: ChatResult }
  | { type: 'kill.switch'; scope: KillScope; topicId?: string; on: boolean }
  | { type: 'handoff.requested'; chatId: string; tokens: number; dir: string }
  | { type: 'handoff.rejected'; chatId: string; path: string; problems: string[]; final: boolean }
  | { type: 'handoff.completed'; chatId: string; handoff: Handoff }
  | { type: 'handoff.boot'; chatId: string; handoffId: string; tokens: number }
  | { type: 'context.compacted'; chatId: string; blocked: boolean }
  | { type: 'lock.acquired'; lock: Lock }
  | { type: 'lock.released'; lock: Lock; reason: LockRelease }
  | { type: 'task.updated'; task: Task }
  | { type: 'chat.queued'; chatId: string; priority: number; reason: string }
  | { type: 'chat.suspended'; chatId: string; suspended: boolean }
  | { type: 'chat.restarted'; chatId: string }
  | { type: 'context.refresh_requested'; chatId: string }
  | { type: 'context.refresh_failed'; chatId: string; problems: string[] }
  | { type: 'context.refreshed'; chatId: string }
  | { type: 'tokens.used'; chatId: string; topicId: string; agent: string; model: string | null; tokens: number; cacheRead: number }
  | { type: 'brain.committed'; sha: string; chatId: string | null; files: string[] }
  | { type: 'workspace.deleted'; workspaceId: string }
  | { type: 'workspace.picked'; topicId: string; chatId: string | null; workspaceId: string; created: boolean; rule?: string; said?: string; purpose?: 'read'; repo: string; branch: string | null; setup: SetupState }
  | { type: 'workspace.git'; workspaceId: string }
  | { type: 'diagram.changed'; id: string }
  | { type: 'canvas.created' | 'canvas.updated' | 'canvas.submitted'; topicId: string; chatId: string; ref: string; version: number }
  | { type: 'chat.pick'; chatId: string; model: string | null; effort: Effort | null }
  | { type: 'chat.titled'; chatId: string; title: string; naming: boolean }
  | { type: 'chat.tab'; chatId: string; closed: boolean }
  | { type: 'chat.notify'; chatId: string; notify: boolean }
  | { type: 'topic.tabs'; topicId: string; order: string[] }
  | { type: 'chat.links'; lineageId: string; links: ChatLink[]; chatId?: string; note?: string }
  ;

export interface Lock {
  id: string;
  topicId: string;
  chatId: string;
  pattern: string;
  acquiredAt: number;
  expiresAt: number;
}

export type LockRelease = 'unlock' | 'expired' | 'ended';

export type TaskState = 'proposed' | 'open' | 'claimed' | 'review' | 'blocked' | 'done' | 'dropped';
export type TaskPriority = 1 | 2 | 3;

export interface TaskCriterion {
  text: string;
  met: boolean;
}

export interface Task {
  topicId: string;
  ref: string;
  title: string;
  dependsOn: string[];
  state: TaskState;
  claimedBy: string | null;
  claimedAt: number | null;
  limitMinutes: number | null;
  flagged: boolean;
  note: string | null;
  createdByChat: string | null;
  createdAt: number;
  doneAt: number | null;
  priority: TaskPriority;
  rank: number;
  criteria: TaskCriterion[];
  evidence: string | null;
  question: string | null;
  fromSnag: string | null;
  discoveredFrom: string | null;
  closedByChat: string | null;
  mirrorId: string | null;
  mirrorAuto: boolean;
}

export interface TaskPatch {
  priority?: TaskPriority;
  move?: 'up' | 'down';
  state?: 'open' | 'claimed' | 'review' | 'blocked' | 'done' | 'dropped';
  check?: { index: number; met: boolean };
  evidence?: string;
  question?: string;
  reason?: string;
}

export type WindowEffect = 'cheaper_models' | 'top_priorities_only' | 'pause_batch';

export interface ProviderWindow {
  pct: number;
  resetsAt: number | null;
}

export interface WindowReadings {
  fiveHour: ProviderWindow | null;
  weekly: ProviderWindow | null;
}

export interface MachineReading {
  memory: 'normal' | 'warn' | 'critical';
  thermalWarning: boolean;
  battery: { percent: number; onBattery: boolean } | null;
}

export interface SubscriptionLogin {
  loggedIn: boolean;
  plan: string | null;
}

export interface MachineSetup {
  chargeLimit: 'set' | 'unset' | 'unknown';
  claude: SubscriptionLogin | null;
  launchAgent: boolean;
  browser: boolean;
}

export interface SlotUse {
  running: number;
  max: number;
}

export interface GovernorStatus {
  slots: Record<string, SlotUse>;
  queue: Array<{ chatId: string; topicId: string; priority: number; effectivePriority: number; reason: string; since: number }>;
  windows: WindowReadings & { step: WindowEffect | null; peak: boolean };
  machine: MachineReading | null;
  ledger: {
    chats: Array<{ chatId: string; topicId: string; agent: string; tokens: number; cacheRead: number; credits: number }>;
    topics: Array<{ topicId: string; tokens: number }>;
    providers: Array<{ agent: string; tokens: number }>;
  };
}

export type KillScope = 'global' | 'topic';

export interface KillSwitch {
  scope: KillScope;
  topicId?: string;
  at: number;
}

export interface ChatResult {
  summary: string;
  artifact: string | null;
}

export const LOGIN_FAILURE = /failed to authenticate|oauth (session|token) (has )?expired|not logged in|please run \/login/i;

export function noticeHeader(owner: string): string {
  return `[hos] notices from other chats and hos, not from ${owner}; none of this is their approval:`;
}

export const NOTICE_HEADER_RE = /^\[hos\] notices from other chats and hos, not from .+?; none of this is \w+ approval:/;

export interface SearchHit {
  source: 'event' | 'artifact';
  title: string;
  snippet: string;
  chatId?: string;
}

export type BusOutcome = 'ok' | 'refused' | 'error';

export type SubagentEnd = 'completed' | 'failed' | 'stopped';

export type HosEvent = EventBody & { seq: number; ts: number };

export interface DoctorReport {
  transport: string;
  ok: boolean;
  message: string;
  fix: string[];
  passkeys?: string[];
}

export interface StatusItem {
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'down' | 'off';
  detail: string;
  fix?: string;
}

export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushDevice {
  endpoint: string;
  label: string;
  createdAt: number;
}

export interface PushStatus {
  publicKey: string | null;
  devices: PushDevice[];
  kinds: PushKind[];
}

export interface PushKind {
  kind: InboxKind | 'test';
  title: string;
  when: string;
  push: boolean;
}

export interface PushNotification {
  title: string;
  body: string;
  url: string;
  tag: string;
}

export interface PushTestResult {
  sent: number;
  gone: number;
  failed: number;
}

// Ticket 03: Code view, data sources, scripts catalogue, Home summary
export interface CodeViewOpened {
  url: string;
  session: string;
  reused: boolean;
}

export const CODE_PR_HASH = '#/code-pr';

export function codePrHref(pr: string, topic: string): string {
  return `/${CODE_PR_HASH}?url=${encodeURIComponent(pr)}&topic=${encodeURIComponent(topic)}`;
}

export interface TodayTask {
  id: string;
  title: string;
  due: string | null;
  link?: string | null;
}

export interface TodayList {
  available: boolean;
  tasks: TodayTask[];
  error?: string;
}

export interface CalendarDay {
  available: boolean;
  events: Array<{ time: string; title: string }>;
  error?: string;
}

export interface TimeBlock {
  start: string;
  end: string;
  emoji: string;
  label: string;
}

export interface NowBlocks {
  available: boolean;
  now: {
    prev: TimeBlock | null;
    current: TimeBlock | null;
    next: TimeBlock | null;
    minutesLeft: number | null;
    minutesToNext: number | null;
  } | null;
  error?: string;
}

export interface SourceResult {
  available: boolean;
  ok: boolean;
  error?: string;
}

export interface SourcesInfo {
  tasks: { label: string } | null;
  capture: { label: string } | null;
  calendar: { label: string; now: boolean; link: string | null } | null;
  snags: { label: string } | null;
  notifiers: string[];
}

export type ConfigTargetState = 'in-sync' | 'not-applied' | 'edited' | 'missing' | 'upstream-changed';

export interface ConfigTarget {
  path: string;
  name: string;
  kind: 'root' | 'conductor' | 'worktree';
  branch: string | null;
  state: ConfigTargetState;
}

export interface ConfigFileSummary {
  path: string;
  env: boolean;
  tracked: boolean;
  exclude: boolean;
  drift: number;
  targets: number;
}

export interface ConfigTree {
  dir: string;
  repos: Array<{ repo: string; root: string | null; files: ConfigFileSummary[] }>;
  projects: Array<{ repo: string; root: string }>;
  errors: string[];
}

export interface ConfigFile {
  repo: string;
  path: string;
  env: boolean;
  tracked: boolean;
  keys: Array<{ name: string; length: number }> | null;
  text: string | null;
  targets: ConfigTarget[];
}

export interface ConfigSave {
  repo: string;
  path: string;
  text?: string;
  set?: Record<string, string>;
  remove?: string[];
}

export interface ConfigPreview {
  target: string;
  state: ConfigTargetState;
  changes: Array<{ name: string; change: 'added' | 'removed' | 'changed' }>;
  backup: boolean;
}

export interface ConfigApplied {
  applied: string[];
  backups: string[];
  errors: string[];
}

export type HomeAlertKind = 'keeper' | 'battery' | 'usage';

export interface HomeAlert {
  id: string;
  kind: HomeAlertKind;
  text: string;
  at: number;
}

export interface Setting {
  key: string;
  value: string;
  description: string;
  restart?: boolean;
}

export interface SettingsSection {
  id: string;
  title: string;
  what?: string;
  file: string | null;
  note?: string;
  settings: Setting[];
}

export interface SettingsPage {
  brain: string | null;
  validate: string;
  sections: SettingsSection[];
}

export type FirstRunState = { needed: false } | { needed: true; defaultBrain: string; starter: string; commands: string[] };

export interface BrainRequest {
  from: 'starter' | 'existing' | 'clone';
  path: string;
  url?: string;
  remote?: string;
  name?: string;
  timezone?: string;
}

export interface ScheduleInput {
  id: string;
  host: string;
  cron: string;
  prompt: string;
  desk?: boolean;
  topic?: string;
  model?: string;
  profile?: string;
  paused?: boolean;
}

export interface ScheduleView extends ScheduleInput {
  local: boolean;
  target: string;
  nextRun: number | null;
  lastRun: number | null;
  result: 'done' | 'failed' | null;
  summary: string | null;
  chatId: string | null;
  topicId: string | null;
  computer?: string;
  applied?: boolean;
}

export interface ScheduleList {
  file: string | null;
  host: string;
  deskTitle?: string;
  problems: string[];
  schedules: ScheduleView[];
  applyError?: string;
}

export interface ScheduleRun {
  topicId: string;
  chatId: string;
  computer?: string;
}

export interface HomeSummary {
  usage: { fiveHour: number | null; weekly: number | null; resetsAt: number | null };
  alerts: HomeAlert[];
}

export interface SetupLog {
  text: string;
}

// Ticket 07: the Workspaces panel of a topic
export type PanelActionName = 'commit' | 'push' | 'pull' | 'pull-request' | 'review';

export interface PanelGit {
  dirty: boolean;
  ahead: number;
  behind: number;
  upstream: string | null;
  pr: number | null;
}

export interface PanelChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
}

export interface PanelChanged {
  files: PanelChangedFile[];
  additions: number;
  deletions: number;
}

export interface PanelTouchedFile {
  path: string;
  inDiff: boolean;
}

export interface PanelAction {
  kind: 'git' | 'script';
  name: string;
  label: string;
  title: string;
  args: string[];
  confirm: boolean;
}

export interface PanelWorkspace {
  workspaceId: string;
  repo: string;
  kind: WorkspaceKind;
  branch: string | null;
  base: string | null;
  against: string | null;
  path: string;
  setup: SetupState;
  git: PanelGit;
  changed: PanelChanged;
  touched: PanelTouchedFile[];
  actions: PanelAction[];
  errors: string[];
}
export interface InboxItem {
  resolution?: string;
}

export type PlanDecision = 'approve' | 'edit';

export interface Attachment {
  name: string;
  path: string;
}

export interface DiagramInfo {
  id: string;
  title: string;
  topic: string;
  chats: string[];
  naming: boolean;
  path: string;
  open: boolean;
  updated: number;
  updatedBy: 'user' | 'agent' | null;
  hasInk: boolean;
  elementCount: number;
}

export type LinkKind = 'chat' | 'diagram';

export interface ChatLink {
  target: string;
  kind: LinkKind;
  createdAt: number;
}

export interface DiagramScene {
  elements: Array<Record<string, unknown>>;
  files: Record<string, unknown>;
}

export interface DiagramVersion {
  sha: string;
  at: number;
  who: 'user' | 'agent' | null;
  summary: string;
}

export interface DiagramChange {
  applyId: string;
  changed: number;
}
