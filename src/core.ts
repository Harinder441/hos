import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, unwatchFile, watchFile } from 'node:fs';
import { mkdir, readFile, rename, stat } from 'node:fs/promises';
import { homedir, hostname, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  type AgentEvent,
  type AgentRuntime,
  type AgentSession,
  type ExternalMcpServer,
  type PermissionDecision,
  type PermissionRequest,
} from './adapters/agent-runtime.js';
import type { Clock } from './adapters/clock.js';
import type { Harness, Harnesses } from './harnesses/harness.js';
import { EDIT_TOOL_FIELDS, SHELL_TOOLS } from './harnesses/tools.js';
import { actionCommand, followLog, loadActions, runOnHost, tmuxScript, type Execution } from './actions.js';
import { Changes } from './changes.js';
import { PrReviews } from './pr-reviews.js';
import type {
  HandoffStatus,
  HandoffTrigger,
  PickerOption,
  PickerQuestion,
  ActionDef,
  ActionList,
  ActionRun,
  Approval,
  ApprovalDecision,
  Chat,
  ChatLink,
  ChatState,
  ContextLimits,
  Creator,
  DiagramInfo,
  Diff,
  DiffAction,
  DoctorReport,
  Effort,
  StatusItem,
  ProfileInfo,
  DiffActionResult,
  DiffScope,
  EventBody,
  GovernorStatus,
  Handoff,
  HosEvent,
  MachineReading,
  WindowReadings,
  InboxItem,
  KillScope,
  KillSwitch,
  LinkKind,
  Lock,
  Lineage,
  ComputerTopic,
  ComputerChatPage,
  ComputerTopicOpen,
  Project,
  RemoteChatAnswer,
  RemoteChatInput,
  Task,
  TaskPatch,
  TaskPriority,
  ProjectView,
  ReviewComment,
  SearchHit,
  Terminal,
  TranscriptEntry,
  Question,
  Role,
  SpawnRole,
  Surface,
  Topic,
  TopicState,
  TopicHistoryFact,
  Workspace,
  WorkspaceKind,
  Worktree,
  PanelWorkspace,
  ScheduleInput,
  ScheduleList,
  ScheduleRun,
  ScheduleView,
} from './api/types.js';
import { EFFORTS, noticeHeader, ROLES, TOPIC_STATES, topicUnseen } from './api/types.js';
import { appendHistory, historyBlock, historyPath, historyPaths, relayEntry, replaceSections, type HistoryEntry, type LoggedEntry } from './history.js';
import { searchWork } from './artifacts.js';
import {
  applyProgress,
  META_DIR,
  parseProgress,
  pickArea,
  PROGRESS_FILE,
  PROGRESS_WARN,
  readAreas,
  sectionOf,
  sectionRev,
  workFolder,
  type ProgressApplied,
  type ProgressUpdate,
} from './work.js';
import { Bus, COMPUTER_SHA_META, ftsQuery, searchWords, senderLabel, tokens, type BusLimits, type BusReply } from './bus.js';
import { Tasks, taskRef } from './tasks.js';
import { Canvases, canvasOn } from './canvas/canvases.js';
import { validateCommand } from './cli/common.js';
import type { TasksSource } from './plugins/types.js';
import { checkHandoff, checkHandoffText, handoffStats, salvageHandoff, writeNew } from './handoff.js';
import {
  admit,
  BATCH_PRIORITY,
  BUSY_STATES,
  dispatchOrder,
  effectivePriority,
  holdReason,
  inPeak,
  intentKey,
  LIVE_STATES,
  loadGovernorLimits,
  loadSpawnLimits,
  parentReserve,
  poolLabel,
  PRIORITY_BY_ROLE,
  similarity,
  windowStep,
  type GovernorLimits,
  type SpawnLimits,
} from './governor.js';
import type { Machine } from './adapters/machine.js';
import { ContextPolicySource, resolveLimits } from './context.js';
import { evaluate, FALLBACK_POLICY, inside, insideAny, loadHiddenSkills, loadModels, loadOwnerSettings, loadPolicy, loadRetentionDays, type Policy, type Verdict } from './policy.js';
import { localDate, owner, ownerStart, setOwnerSettings } from './owner.js';
import { allowedSkills, GENERIC, hiddenBuiltIns, loadProfiles, mayStart, profileAppend, profileFor, profileInfo, type Profiles } from './profiles.js';
import { cleanTitle, fixMishears, TITLE_TIMEOUT_MS, type Named } from './naming.js';
import { BrainCommits } from './brain-commits.js';
import type { Computers } from './computers.js';
import { ConfigVault } from './config-vault.js';
import { Diagrams } from './diagrams.js';
import { chatLabel, editsOnlyOwned, Locks, normalizePattern, ownedText, owns, repoPath } from './locks.js';
import { discoverCandidates, locationKeys, type DiscoveryConfig } from './discovery.js';
import { isEditTool, isImplement, resolveProject, type ProjectChoice } from './roles.js';
import {
  addWorktree,
  changedFiles,
  commitAll,
  compareRef,
  currentBranch,
  discardChanges,
  EMPTY_TREE,
  fetchOrigin,
  listWorktrees,
  localAhead,
  mergeBase,
  mergeBranch,
  originDefaultBranch,
  patchBetween,
  pullFastForward,
  pushAndOpenPullRequest,
  pushBranch,
  removeWorktree,
  resolveCommit,
  snapshotTree,
  worktreeStatus,
} from './git.js';
import { DESK_META, DESK_TITLE, eventChatId, LIMIT_RESUME_META, SCHEDULED_META, UI_FOLD_META, type QueuedHandoff, type SpawnMeta, type Store } from './store.js';
import { AIRPLAY_PORTS, Servers } from './servers.js';
import { BATTERY_ALERTS, INFO_ALERT_MS, INFO_ALERTS, Keeper } from './keeper.js';
import { summarize } from './summary.js';
import { branchProblem, branchSlug, loadWorkspaceRules, namedOption, optionState, ruleFor, suggestedValue } from './picker.js';
import { ATTACHMENT_MAX_BYTES, attachmentName, attachmentsDir, saveAttachment, unlinkedPath } from './attachments.js';
import { sessionName, type Tmux } from './tmux.js';
import { UiFold } from './snapshot.js';
import { CODE_VIEW_BASE_PATH, codeViewPrDir } from './code-view-bridge.js';
import { applyEvents, initialState, type Snapshot, type TimelineItem } from './api/state.js';
import { WorkspaceLifecycle } from './workspaces.js';
import { sameHost, sameSchedule, SCHEDULED_RUN_FINISHED, Schedules, type ScheduleRow } from './schedules.js';

const SEARCH_LIMIT = 20;
// A save costs ~0.2 s for a ~76 MB fold; 10k events of tail fold in ~1 s after a crash.
const UI_SAVE_EVERY = 10_000;
const LOGIN_TERMINAL = 'hos-claude-login';
const realOr = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};
const TEMP_ROOTS = [...new Set(['/tmp', '/private/tmp', tmpdir(), realOr(tmpdir())])];

export class HosError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface PortRange {
  from: number;
  to: number;
}

export interface HosOptions {
  discovery: DiscoveryConfig;
  ports: PortRange;
  refreshMs: number;
  statusTopicWaitMs: number;
  policy: Policy;
  mcpServers?: ExternalMcpServer[];
  tempRoots?: string[];
  brainDir?: string;
  busLimits: BusLimits;
  spawnLimits: SpawnLimits;
  governorLimits: GovernorLimits;
  policyFile?: string;
  ghBin: string;
  terminalShell?: string;
  actionsDir: string;
  dataDir: string;
  previewUrl?: (port: number) => Promise<string | null>;
  healthchecksUrl?: string;
  workSuffix?: string;
  webOrigin?: () => Promise<string | null>;
  userTasks?: TasksSource;
  scheduleHost?: string;
}

const MIRROR_PRIORITY = { 1: 'high', 2: 'normal', 3: 'low' } as const;

export interface ActionRequest {
  args?: Record<string, unknown>;
  confirmed?: boolean;
  user: string;
}

export interface SpawnRequest {
  role: SpawnRole;
  intent: string;
  prompt: string;
  files_owned: string[];
  return_contract?: { artifact?: string; summary_tokens: number };
  ttl_minutes?: number;
  client_request_id: string;
  confirm_similar: boolean;
  batch?: boolean;
  agent?: string;
  model?: string;
  workspace?: string;
  own_worktree?: boolean;
  browser?: boolean;
  notify?: boolean;
  effort?: Effort;
  profile?: string;
  computer?: string;
}

export interface SpawnOptions {
  worktreePath?: string | null;
  fromHos?: boolean;
  brainSha?: string;
}

export interface Sensors {
  machine: Machine;
}

type Delivery = { text: string; from?: 'hos' | 'chat'; fromChatId?: string; canvas?: string };

export interface DecisionOrigin {
  via: Surface;
  user: string;
  chatId?: string;
}

export interface TopicInput {
  title: string;
  statusTopic?: string;
  area?: string;
  workspaceId?: string;
  chatId?: string;
  naming?: boolean;
}

export interface WorkspaceInput {
  projectId: string;
  kind: WorkspaceKind;
  branch?: string;
  baseRef?: string;
  path?: string;
  chatId?: string;
}

interface Place {
  path: string;
  branch: string | null;
  projectId: string | null;
  workspace: Workspace | null;
}

export interface WorktreeRequest {
  branch: string;
  baseRef: string;
  chatId?: string;
}

export class Hos {
  readonly bus: Bus;
  readonly servers: Servers;
  private readonly keeper: Keeper;
  readonly diagrams: Diagrams | null;
  readonly config: ConfigVault;
  readonly prReviews: PrReviews;
  private readonly schedules: Schedules | null;
  busUrl?: string;
  computers: Computers | null = null;
  private readonly listeners = new Set<(event: HosEvent) => void>();
  private ui: UiFold | null = null;
  private uiSavedSeq = 0;
  private uiSaveQueued = false;
  private readonly sessions = new Map<string, Promise<AgentSession>>();
  private readonly pending = new Map<string, (decision: PermissionDecision) => void>();
  private readonly lastReplies = new Map<string, string>();
  private readonly remoteLoads = new Map<string, Promise<{ events: number }>>();
  private readonly historyPending = new Set<string>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly inTerminal = new Set<string>();
  private readonly retired = new Set<string>();
  private readonly inTurn = new Set<string>();
  private readonly afterTurn = new Map<string, () => Promise<void>>();
  private readonly stopBlocks = new Map<string, number>();
  private readonly handoffAskedAt = new Map<string, number>();
  private readonly refreshes = new Map<string, { askedAt: number | null; attempts: number; accepted: boolean }>();
  private readonly lifecycleWork = new Set<Promise<void>>();
  private readonly pairs = new Map<string, { last: string; count: number; mark: string }>();
  private readonly executions = new Map<string, Execution>();
  private readonly runWaiters = new Map<string, Array<(run: ActionRun) => void>>();
  private queue: Promise<unknown> = Promise.resolve();
  private cancelRefresh?: () => void;
  private cancelNotices?: () => void;
  private cancelSweep?: () => void;
  private stopped = false;
  private readonly contextPolicy: ContextPolicySource;
  private readonly dispatched = new Set<string>();
  private readonly holds = new Map<string, string>();
  private readonly served = new Map<string, number>();
  private readonly lastActive = new Map<string, number>();
  private windows: WindowReadings = { fiveHour: null, weekly: null };
  private machine: MachineReading | null = null;
  private lastUsagePoll = -Infinity;
  private batchPauseNotified = false;
  private readonly locks: Locks;
  private readonly tasks: Tasks;
  readonly canvases: Canvases;
  private readonly shellTrees = new Map<string, { chatId: string; tree: string; edited: Set<string> }>();
  private readonly editsInFlight = new Map<string, { chatId: string; path: string }>();
  private brainRecords: Promise<unknown> = Promise.resolve();
  private readonly turnListeners = new Set<(chat: Chat) => void>();
  private readonly toolListeners = new Set<(chat: Chat, tool: string, input: unknown) => void>();
  private readonly topicListeners = new Set<(topic: Topic) => void>();

  constructor(
    private readonly store: Store,
    private readonly harnesses: Harnesses,
    private readonly clock: Clock,
    private readonly tmux: Tmux,
    private readonly options: HosOptions,
    private readonly sensors: Sensors,
  ) {
    this.bus = new Bus(
      store,
      (body, write) => this.record(body, write),
      clock,
      options.busLimits,
    );
    this.contextPolicy = new ContextPolicySource(options.policyFile);
    this.locks = new Locks(store, (body, write) => this.record(body, write), clock, (chatId) => {
      const chat = store.getChat(chatId);
      try {
        return chat ? this.chatCwd(chat) : '';
      } catch {
        return '';
      }
    });
    this.tasks = new Tasks(store, (body, write) => this.record(body, write), clock, (before, after) => this.syncMirror(before, after));
    this.canvases = new Canvases(store, (body, write) => this.record(body, write), clock, (chatId, text, canvas) => this.deliverLater(chatId, text, undefined, canvas), () => this.bus.brainDir);
    this.servers = new Servers({
      store,
      tmux,
      clock,
      record: (body) => void this.record(body),
      previewUrl: options.previewUrl ?? (async () => null),
      approve: async (chatId, command, title) =>
        (await this.requestApproval(chatId, { toolUseId: randomUUID(), tool: 'Bash', input: { command }, title })) === 'approve',
    });
    this.keeper = new Keeper({
      store,
      clock,
      machine: sensors.machine,
      tmux,
      dataDir: options.dataDir,
      ...(options.healthchecksUrl ? { healthchecksUrl: options.healthchecksUrl } : {}),
      ...(options.brainDir ? { brainDir: options.brainDir } : {}),
      repoDirs: () => this.listProjects().map((project) => project.path),
      retentionDays: () => loadRetentionDays(options.policyFile),
      alert: (title, detail) => void this.addInbox(null, 'keeper', title, detail),
      pauseRunning: async () => {
        const running = this.store.chatsInState(['starting', 'running']).map((chat) => chat.id);
        await Promise.all(running.map((chatId) => this.halt(chatId, 'paused')));
        return running;
      },
      resume: (chatId, text) => this.deliverLater(chatId, text),
    });
    this.bus.brainDir = options.brainDir;
    this.schedules = options.brainDir
      ? new Schedules({
          brainDir: options.brainDir,
          host: options.scheduleHost ?? hostname(),
          now: () => this.clock.now(),
          meta: (key) => this.store.meta(key),
          setMeta: (key, value) => this.store.setMeta(key, value),
          fire: (row, text) => this.fireSchedule(row, text),
          profileKnown: (id) => this.profileKnown(id),
          alert: (title, detail) => void this.addInbox(null, 'alert', title, detail),
          deskTitle: () => this.deskTitle(),
          commit: (paths, subject) => void this.brainCommits?.commitPaths(paths, subject),
        })
      : null;
    this.brainCommits = options.brainDir
      ? new BrainCommits({
          brainDir: options.brainDir,
          logFile: join(options.dataDir, 'brain-commits.log'),
          host: hostname(),
          record: (body) => void this.record(body),
          busy: () => this.store.chatsInState(['starting', 'running', 'handing_off']).length > 0,
          topicTitle: (chat) => this.store.getTopic(chat.topicId)?.title ?? 'topic',
          cwd: (chat) => this.sessionCwd(chat),
          now: () => this.clock.now(),
          setTimeout: (fn, ms) => this.clock.setTimeout(fn, ms),
          workRoot: () => this.workRoot(),
          ownsWorkDir: (folder, chatId) => {
            const chat = chatId ? this.store.getChat(chatId) : undefined;
            return this.store.workDirTaken(folder) || Boolean(chat && this.store.getTopic(chat.topicId)?.desk);
          },
          awaitsCheckpoint: (path) => this.diagrams?.awaitsCheckpoint(path) ?? false,
          warn: (chatId, text) => {
            if (chatId && this.store.getChat(chatId)) this.store.insertNotice(chatId, `hos brain commit: ${text}`, this.clock.now(), false);
          },
          alert: (title, detail) => void this.addInbox(null, 'keeper', title, detail),
        })
      : null;
    this.config = new ConfigVault(join(options.dataDir, 'config'), () => this.store.listProjects(), () => this.clock.now());
    this.diagrams = options.brainDir
      ? new Diagrams(
          options.brainDir,
          this.clock,
          (id) => {
            if (!this.stopped) this.record({ type: 'diagram.changed', id });
          },
          (paths, subject) => this.brainCommits?.commitPaths(paths, subject),
          {
            chats: (id) => this.store.linkedChats(id),
            add: (id, lineageId) => this.addLink(lineageId, id, 'diagram'),
            firstChat: (topicId) => {
              const topic = this.store.getTopic(topicId);
              return topic && this.firstLineage(topic);
            },
          },
        )
      : null;
    this.bus.diagrams = this.diagrams;
    if (this.brainCommits) {
      const commits = this.brainCommits;
      this.onToolStarted((chat, tool, input) => commits.toolStarted(chat, tool, input));
      this.onTurnEnded((chat) => commits.turnEnded(chat));
    }
    this.onTopicWorkspacesChanged((topic) => this.workspacesChanged(topic));
    this.onTurnEnded((chat) => this.refreshIfStale(chat.id));
    this.onTurnEnded((chat) => {
      this.whenQuiet(chat.id);
      if (chat.parentId) this.whenQuiet(chat.parentId);
    });
    this.lifecycle = new WorkspaceLifecycle({
      store,
      clock,
      dataDir: options.dataDir,
      ...(options.brainDir ? { brainDir: options.brainDir } : {}),
      servers: this.servers,
      record: (body, write) => void this.record(body, write),
      exclusive: (fn) => this.exclusive(fn),
      refreshProject: (project) => this.refreshProject(project),
      topicChanged: (topic) => this.topicWorkspacesChanged(topic),
      creator: (chatId) => this.creator(chatId),
      createWorktree: (projectId, request) => this.createWorktree(projectId, request),
      defaultBase: (project) => this.defaultBase(project),
      freshBaseRef: (project, base) => this.freshBaseRef(project, base),
      registerRepo: (path) =>
        this.exclusive(async () => {
          const project = this.ensureProject(path, 'agent', null, false);
          await this.refreshProject(project);
          return project;
        }),
      worktreePathFor: (project, branch) => this.worktreePathFor(project, branch),
      freeBranch: (project, wanted) => this.freeBranch(project, wanted),
      askOwner: (chatId, command, title) => this.askOwner(chatId, command, title),
      approveBash: async (chatId, command, title) =>
        (await this.requestApproval(chatId, { toolUseId: randomUUID(), tool: 'Bash', input: { command }, title })) === 'approve',
      createTerminal: (path, topicId) => this.createTerminal(path, topicId),
      previewUrl: options.previewUrl ?? (async () => null),
    });
    this.changes = new Changes({ store, clock, brainDir: options.brainDir, ghBin: options.ghBin });
    this.prReviews = new PrReviews({
      store,
      clock,
      brainDir: options.brainDir,
      workDir: (topicId) => this.workDirAbs(this.requireTopic(topicId)),
      topicWorkspaces: (topicId) => this.requireTopic(topicId).workspaceIds.flatMap((id) => this.store.getWorkspace(id) ?? []),
      fallbackDir: codeViewPrDir(options.dataDir),
      checkouts: () => this.store.listProjects().flatMap((project) => [project.path, ...this.store.listWorktrees(project.id).map((w) => w.path)]),
      busy: (chat) => this.isRunning(chat) || chat.state === 'queued',
      startChat: (topicId) => this.addTopicChat(topicId),
      send: (chatId, text) => this.sendMessage(chatId, text),
      commit: (paths, subject) => void this.brainCommits?.commitPaths(paths, subject),
    });
    this.onTurnEnded((chat) => this.prReviews.turnEnded(chat));
    this.onToolStarted((chat, tool, input) => {
      const topic = this.store.getTopic(chat.topicId);
      if (!topic?.workspaceIds.length) return;
      this.changes.touch(topic, chat.id, this.sessionCwd(chat), tool, input);
    });
    this.onTurnEnded((chat) => {
      const workspaceIds = this.store.getTopic(chat.topicId)?.workspaceIds ?? [];
      for (const workspaceId of workspaceIds) this.gitChanged(workspaceId);
      for (const workspaceId of workspaceIds) {
        void this.lifecycle.syncBranch(workspaceId).catch((error) => !this.stopped && console.error('workspace branch sync failed', error));
      }
      const paths = workspaceIds.flatMap((id) => this.store.getWorkspace(id)?.path ?? []);
      void this.refreshWorktrees(paths).catch((error) => console.error('worktree status refresh failed', error));
    });
    this.listeners.add((event) => {
      if (event.type === 'diff.action' && event.state !== 'denied') this.gitChanged(event.workspaceId);
      else if (event.type === 'action.run' && (event.run.state === 'done' || event.run.state === 'failed')) this.gitChanged(event.run.workspaceId);
      else if (event.type === 'brain.committed' && event.files.includes('hos/policy.yaml')) this.reloadPolicy();
      else if (event.type === 'worktree.updated') {
        const workspace = this.store.workspaceByPath(event.worktree.path);
        if (workspace) this.gitChanged(workspace.id);
      }
    });
  }

  start(): void {
    this.store.endNaming();
    void this.refresh().catch((error) => console.error('refresh failed', error));
    const schedule = () => {
      this.cancelRefresh = this.clock.setTimeout(() => {
        void this.refreshWorktrees(this.watchedPaths())
          .catch((error) => console.error('worktree status refresh failed', error))
          .finally(() => this.stopped || schedule());
      }, this.options.refreshMs);
    };
    schedule();
    const sweep = () => {
      this.cancelSweep = this.clock.setTimeout(() => {
        void this.refresh()
          .catch((error) => console.error('refresh failed', error))
          .finally(() => this.stopped || sweep());
      }, SWEEP_MS);
    };
    sweep();
    this.servers.watch();
    this.brainCommits?.start();
    const tick = () => {
      this.cancelNotices = this.clock.setTimeout(() => {
        void this.flushNotices()
          .catch((error) => console.error('notice flush failed', error))
          .then(() => this.governorTick())
          .catch((error) => console.error('governor tick failed', error))
          .finally(() => this.stopped || tick());
      }, NOTICE_INTERVAL_MS);
    };
    tick();
    void this.governorTick().catch((error) => console.error('governor tick failed', error));
    void this.keeper.boot().catch((error) => console.error('keeper boot failed', error));
    if (this.options.policyFile) watchFile(this.options.policyFile, { interval: POLICY_POLL_MS }, this.policyChanged);
  }

  private readonly policyChanged = () => this.reloadPolicy();

  reloadPolicy(): void {
    const file = this.options.policyFile;
    if (!file || this.stopped) return;
    try {
      Object.assign(this.options, { policy: loadPolicy(file) ?? FALLBACK_POLICY, spawnLimits: loadSpawnLimits(file), governorLimits: loadGovernorLimits(file) });
      setOwnerSettings(loadOwnerSettings(file));
    } catch (error) {
      console.error(`ignoring ${file}, keeping the last good policy: ${(error as Error).message}`);
    }
  }

  subscribe(since: number, listener: (event: HosEvent) => void): () => void {
    for (const event of this.store.eventsSince(since)) listener(event);
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  foldUi(): UiFold {
    if (this.ui) return this.ui;
    const saved = this.store.meta(UI_FOLD_META);
    const restored = saved ? UiFold.restore(saved) : null;
    const ui = restored && restored.seq <= this.store.lastEventSeq() ? restored : new UiFold();
    this.store.foldEventsSince(ui.seq, (event) => ui.apply(event));
    this.ui = ui;
    if (ui.restoredAt === null || ui.folded >= UI_SAVE_EVERY) this.saveUi();
    else this.uiSavedSeq = ui.restoredAt;
    return ui;
  }

  saveUi(): void {
    if (!this.ui) return;
    try {
      this.store.setMeta(UI_FOLD_META, this.ui.save());
      this.uiSavedSeq = this.ui.seq;
    } catch (error) {
      console.error('saving the UI fold failed', error);
    }
  }

  uiSnapshot(): Snapshot {
    const snapshot = this.foldUi().snapshot(this.clock.now());
    // Events from before projects had hidden/brain lack those fields; the store has them.
    return { ...snapshot, state: { ...snapshot.state, projects: this.store.listProjects() } };
  }

  refresh(): Promise<void> {
    return this.exclusive(async () => {
      const candidates = await discoverCandidates(this.options.discovery);
      const mains = await mapLimit(candidates, 8, async (c) => (await listWorktrees(c.path))?.[0]?.path);
      const repos = new Map<string, { key: string | null; pinned: boolean }>();
      candidates.forEach((candidate, i) => {
        const main = mains[i];
        if (!main) return;
        const repo = repos.get(main) ?? { key: null, pinned: false };
        repos.set(main, { key: repo.key ?? candidate.key, pinned: repo.pinned || candidate.pinned });
      });
      const dismissed = new Set(this.store.dismissedProjectPaths());
      for (const [path, { key, pinned }] of repos) if (!dismissed.has(path)) this.ensureProject(path, 'system', key, pinned);
      this.pruneGoneProjects();
      await mapLimit(this.store.listProjects(), 4, (project) => this.refreshProject(project));
    });
  }

  listProjects(): ProjectView[] {
    return this.store
      .listProjects()
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.name.localeCompare(b.name))
      .map((project) => ({
        ...project,
        worktrees: this.store
          .listWorktrees(project.id)
          .sort((a, b) => Number(b.main) - Number(a.main) || a.path.localeCompare(b.path)),
      }));
  }

  createProject(path: string): Promise<Project> {
    return this.exclusive(async () => {
      const main = (await listWorktrees(path))?.[0]?.path;
      if (!main) throw new HosError(400, `not a git repository: ${path}`);
      const project = this.ensureProject(main, 'human', null, false);
      await this.refreshProject(project);
      return project;
    });
  }

  renameProject(projectId: string, name: string): Promise<Project> {
    return this.exclusive(async () => {
      if (!name.trim()) throw new HosError(400, 'a project needs a name');
      return this.saveProject({ ...this.requireProject(projectId), name: name.trim(), custom: true });
    });
  }

  setProjectPinned(projectId: string, pinned: boolean): Promise<Project> {
    return this.exclusive(async () => this.saveProject({ ...this.requireProject(projectId), pinned, custom: true }));
  }

  setProjectHidden(projectId: string, hidden: boolean): Promise<Project> {
    return this.exclusive(async () => {
      const project = this.requireProject(projectId);
      if (hidden && project.brain) throw new HosError(400, 'the brain cannot be hidden');
      return this.saveProject({ ...project, hidden });
    });
  }

  removeProject(projectId: string): Promise<{ ok: true }> {
    return this.exclusive(async () => {
      const project = this.requireProject(projectId);
      if (project.brain) throw new HosError(400, 'the brain cannot be removed');
      const own = this.store.listWorkspaces({ archived: true }).filter((w) => w.projectId === project.id);
      const blocking = new Set(
        own
          .filter((w) => w.archivedAt === null)
          .flatMap((w) => this.store.topicsUsing(w.id))
          .filter((topic) => topic.state !== 'archived')
          .map((topic) => topic.title),
      );
      if (blocking.size) throw new HosError(409, `${project.name} is used by ${[...blocking].join(', ')}; archive those topics first`);
      for (const w of own) this.record({ type: 'workspace.deleted', workspaceId: w.id }, () => this.store.deleteWorkspace(w.id));
      this.record({ type: 'project.removed', projectId: project.id }, () => this.store.deleteProject(project.id));
      this.store.setDismissedProjectPaths([...new Set([...this.store.dismissedProjectPaths(), project.path])]);
      return { ok: true };
    });
  }

  async createWorktree(projectId: string, request: WorktreeRequest): Promise<Worktree> {
    const worktree = await this.exclusive(async () => {
      const project = this.requireProject(projectId);
      const creator = this.creator(request.chatId);
      const path = this.worktreePathFor(project, request.branch);
      if (existsSync(path)) throw new HosError(409, `${path} already exists`);
      this.store.claimWorktree(path, project.id, creator.createdBy, creator.createdByChat);
      try {
        await addWorktree(project.path, path, request.branch, request.baseRef);
      } catch (error) {
        this.store.deleteWorktree(path);
        throw new HosError(400, (error as Error).message);
      }
      await this.refreshProject(project);
      const worktree = this.store.getWorktree(path)?.snapshot;
      if (!worktree) throw new HosError(500, `git did not report the new worktree at ${path}`);
      return worktree;
    });
    const project = this.store.getProject(projectId);
    if (project) await this.config.seed(project, worktree.path).catch((error: unknown) => console.error(`hos Config seed of ${worktree.path} failed:`, error));
    return worktree;
  }

  removeWorktree(path: string, force: boolean): Promise<{ removed: string; warnings: string[] }> {
    return this.exclusive(async () => {
      const worktree = this.store.getWorktree(path)?.snapshot;
      if (!worktree) throw new HosError(404, `no worktree ${path}`);
      if (worktree.main) throw new HosError(400, `the main worktree of a project cannot be removed`);
      const project = this.store.getProject(worktree.projectId)!;
      const entry = (await listWorktrees(project.path))?.find((e) => e.path === path);
      const status = await worktreeStatus(path, entry?.branch ?? worktree.branch);
      const warnings = [
        ...(status.dirty ? ['uncommitted changes'] : []),
        ...(status.unpushed ? [`${status.unpushed} unpushed commit${status.unpushed === 1 ? '' : 's'}`] : []),
      ];
      if (warnings.length && !force) {
        throw new HosError(409, `${worktree.name} has ${warnings.join(' and ')}; confirm to remove it anyway`);
      }
      try {
        await removeWorktree(project.path, path, warnings.length > 0);
      } catch (error) {
        throw new HosError(400, (error as Error).message);
      }
      await this.refreshProject(project);
      return { removed: path, warnings };
    });
  }

  listTopics(): Topic[] {
    return this.store.listTopics();
  }

  computerTopics(): ComputerTopic[] {
    return this.store
      .listTopics()
      .filter((topic) => topic.state !== 'archived')
      .map(({ id, title, state, lastActivityAt, home }) => ({
        id,
        title,
        state,
        lastActivityAt,
        home: home ?? null,
        chats: this.store
          .chatsInTopic(id)
          .filter((chat) => isLive(chat.state))
          .map((chat) => ({ id: chat.id, title: chat.title, state: chat.state, role: chat.role, computer: chat.computer ?? null })),
      }));
  }

  async createTopic(input: TopicInput): Promise<Topic> {
    const title = input.title?.trim();
    if (!title) throw new HosError(400, 'a topic needs a title');
    const workspace = input.workspaceId ? this.requireWorkspace(input.workspaceId) : undefined;
    const creator = this.creator(input.chatId);
    const now = this.clock.now();
    const statusTopic = input.statusTopic?.trim() ? slug(input.statusTopic.trim(), 'topic') : this.freeStatusTopic(slug(title, 'topic'));
    const topic: Topic = {
      id: randomUUID(),
      title,
      statusTopic,
      workDir: this.freeWorkDir(workFolder(this.workRoot(), pickArea(this.areas(), input.area), now, this.workName(statusTopic))),
      state: 'active',
      request: null,
      workspaceIds: workspace ? [workspace.id] : [],
      lastSeenAt: null,
      lastActivityAt: null,
      ...creator,
      createdAt: now,
      naming: input.naming ?? false,
      tabOrder: [],
    };
    this.record({ type: 'topic.created', topic }, () => {
      this.store.insertTopic(topic);
      if (workspace) this.store.attachWorkspace(topic.id, workspace.id, now);
    });
    if (workspace) this.topicWorkspacesChanged(topic);
    return topic;
  }

  async startTopic(input: {
    text: string;
    model?: string;
    effort?: Effort;
    agent?: string;
    chrome?: boolean;
    desk?: boolean;
    files?: Array<{ name: string; data: string }>;
    scheduleId?: string;
    profile?: string;
    computer?: string;
  }): Promise<{ topicId: string; chatId: string }> {
    const text = input.text?.trim();
    if (!text) throw new HosError(400, 'a new topic needs a prompt');
    if (!this.options.brainDir) throw new HosError(400, 'hos has no brain (start it with --brain), so a topic with no workspace has nowhere to work');
    const computer = this.elsewhere(input.computer) ? input.computer : undefined;
    if (computer && input.desk) throw new HosError(400, `Quick chats run on this computer; turn Quick off to start a topic on ${computer}`);
    if (computer) this.requireComputers().target(computer);
    const files = (input.files ?? []).map((file) => ({ name: file.name, bytes: this.attachmentBytes(file.name, file.data) }));
    const defaults = this.profileDefaults(input.profile, input.agent);
    const harness = this.harnessFor(defaults.agent);
    const models = harness.models();
    const pick = {
      model: input.model ?? defaults.model ?? models.default,
      effort: input.effort ?? defaults.effort ?? models.effort,
      agent: harness.id,
      chrome: input.chrome,
      notify: !input.scheduleId,
      profile: this.requireProfile(input.profile),
    };
    let topic: Topic;
    let chat: Chat;
    if (input.desk) {
      topic = this.requireDesk();
      chat = await this.addTopicChat(topic.id, pick);
    } else {
      const pasted = files.filter((file) => file.name === 'pasted-text.txt').map((file) => file.bytes.toString('utf8'));
      const nameText = [text, ...pasted].join('\n\n');
      const pending = this.harnesses.primary.runtime.title !== undefined ? this.suggestName(nameText, this.areas()) : null;
      const early = pending ? await settledWithin(pending, this.options.statusTopicWaitMs) : { settled: true as const, value: null };
      const named = early.settled ? early.value : null;
      topic = await this.createTopic({ title: named?.title || topicTitle(text), ...(named?.area ? { area: named.area } : {}), naming: !early.settled });
      chat = computer ? (await this.startOnComputer(topic, pick, computer)).chat! : await this.createChat(topic.id, undefined, pick);
      this.titleChat(chat.id, topic.title);
      if (pending && !early.settled) this.nameTopic(topic.id, pending, chat.id);
    }
    const saved = [];
    for (const file of files) saved.push(await this.writeAttachment(topic, file.name, file.bytes));
    if (input.scheduleId) this.store.setMeta(SCHEDULED_META + chat.id, input.scheduleId);
    await this.sendMessage(chat.id, input.text, saved.map((file) => file.path));
    return { topicId: topic.id, chatId: chat.id };
  }

  listSchedules(): ScheduleList {
    const list = this.schedules?.list() ?? { file: null, host: this.options.scheduleHost ?? hostname(), problems: [], schedules: [] };
    const computers = this.computers?.view().computers.filter((c) => c.direction === 'out' && c.caps) ?? [];
    return {
      ...list,
      schedules: list.schedules.map((row) => {
        const computer = row.local ? undefined : computers.find((c) => sameHost(c.caps!.scheduleHost, row.host));
        if (!computer) return row;
        const theirs = computer.schedules.find((s) => s.id === row.id);
        const ran = theirs ? { lastRun: theirs.lastRun, result: theirs.result, summary: theirs.summary, chatId: theirs.chatId, topicId: theirs.topicId } : {};
        return { ...row, ...ran, computer: computer.name, applied: !!theirs && sameSchedule(theirs, row) };
      }),
    };
  }

  ownSchedules(): ScheduleView[] {
    return this.schedules?.list().schedules.filter((row) => row.local) ?? [];
  }

  private requireSchedules(): Schedules {
    if (!this.schedules) throw new HosError(400, 'hos has no brain (start it with --brain), so it has no schedules file');
    return this.schedules;
  }

  saveSchedule(row: ScheduleInput, id?: string): Promise<ScheduleList> {
    const was = id === undefined ? undefined : this.scheduleComputer(id);
    this.requireSchedules().save(row, id);
    return this.applySchedules([was, this.scheduleComputer(row.id)]);
  }

  pauseSchedule(id: string, paused: boolean): Promise<ScheduleList> {
    this.requireSchedules().pause(id, paused);
    return this.applySchedules([this.scheduleComputer(id)]);
  }

  deleteSchedule(id: string): Promise<ScheduleList> {
    const was = this.scheduleComputer(id);
    this.requireSchedules().remove(id);
    return this.applySchedules([was]);
  }

  async runSchedule(id: string, forward = true): Promise<ScheduleRun> {
    const computer = forward ? this.scheduleComputer(id) : undefined;
    if (!computer) return this.requireSchedules().runNow(id);
    return { ...(await this.requireComputers().post<ScheduleRun>(computer, `/api/schedules/${encodeURIComponent(id)}/run`, {})), computer };
  }

  private scheduleComputer(id: string): string | undefined {
    return this.listSchedules().schedules.find((row) => row.id === id)?.computer;
  }

  private async applySchedules(names: Array<string | undefined>): Promise<ScheduleList> {
    const errors: string[] = [];
    for (const name of new Set(names.filter((n) => n !== undefined))) {
      try {
        const sha = await this.flushBrain();
        this.requireComputers().cacheSchedules(name, await this.requireComputers().post<ScheduleView[]>(name, '/api/computer/sync', { sha }));
      } catch (error) {
        errors.push(`not applied on ${name}: ${(error as Error).message}`);
      }
    }
    const list = this.listSchedules();
    return errors.length ? { ...list, applyError: errors.join('; ') } : list;
  }

  private async fireSchedule(row: ScheduleRow, text: string): Promise<{ topicId: string; chatId: string }> {
    if (this.stopped) throw new HosError(503, 'hos is stopping');
    const model = {
      ...(row.model ? { model: row.model } : {}),
      ...(row.profile && this.profileKnown(row.profile) ? { profile: row.profile } : {}),
    };
    if (!row.topic) return this.startTopic({ text, desk: row.desk === true, scheduleId: row.id, ...model });
    const topic =
      this.store.listTopics().find((t) => t.state !== 'archived' && t.title === row.topic) ?? (await this.createTopic({ title: row.topic }));
    const chat = await this.addTopicChat(topic.id, { ...model, notify: false });
    this.store.setMeta(SCHEDULED_META + chat.id, row.id);
    await this.sendMessage(chat.id, text);
    return { topicId: topic.id, chatId: chat.id };
  }

  renameTopic(topicId: string, title: string): Topic {
    const topic = this.requireTopic(topicId);
    const next = title.trim();
    if (!next) throw new HosError(400, 'a topic needs a title');
    if (next === topic.title && !topic.naming) return topic;
    const updated = { ...topic, title: next, naming: false };
    this.record({ type: 'topic.updated', topic: updated }, () => this.store.setTopicTitle(topic.id, next));
    this.topicWorkspacesChanged(updated);
    return updated;
  }

  private nameTopic(topicId: string, pending: Promise<Named | null>, firstChatId: string): void {
    void pending.then(async (named) => {
      const topic = this.store.getTopic(topicId);
      if (this.stopped || !topic?.naming) return;
      const title = named?.title ?? null;
      // The slug came from the first-words fallback; the model's name re-slugs it and moves scratch and work folder (H7).
      const statusTopic = title && title !== topic.title ? await this.renameStatusTopic(topic, title) : topic.statusTopic;
      const workDir = named ? await this.moveWorkDir(topic, statusTopic, named.area) : topic.workDir;
      const updated = { ...topic, title: title ?? topic.title, statusTopic, workDir, naming: false };
      this.record({ type: 'topic.updated', topic: updated }, () => {
        this.store.setTopicTitle(topic.id, updated.title);
        if (statusTopic !== topic.statusTopic) this.store.setStatusTopic(topic.id, statusTopic);
        if (workDir && workDir !== topic.workDir) this.store.setWorkDir(topic.id, workDir);
      });
      if (updated.title !== topic.title || workDir !== topic.workDir) this.topicWorkspacesChanged(updated);
      if (this.store.getChat(firstChatId)?.title === topic.title) this.titleChat(firstChatId, updated.title);
    }).catch((error) => console.error('topic naming failed', error));
  }

  private titleChat(chatId: string, title: string): void {
    this.record({ type: 'chat.titled', chatId, title, naming: false }, () => this.store.setChatTitle(chatId, title, false));
  }

  // Already-cut sub-worktree branches keep their old-slug names; chats store their paths, so they are unaffected (H7).
  private async renameStatusTopic(topic: Topic, newTitle: string): Promise<string> {
    const { brainDir } = this.options;
    const next = this.freeStatusTopic(slug(fixMishears(newTitle), 'topic'));
    if (!brainDir || next === topic.statusTopic) return topic.statusTopic;
    const from = join(brainDir, '.context/topics', topic.statusTopic);
    const to = join(brainDir, '.context/topics', next);
    if (existsSync(from) && !existsSync(to)) await rename(from, to).catch((error) => console.error(`scratch rename ${from} failed`, error));
    return next;
  }

  // Only the naming agent's early name moves the folder; later manual renames keep it, so links held in chats stay valid.
  private async moveWorkDir(topic: Topic, name: string, area: string | null): Promise<string | null> {
    if (!topic.workDir) return topic.workDir;
    const parts = topic.workDir.split('/');
    const folderArea = area ? pickArea(this.areas(), area) : parts.at(-2)!;
    const wanted = `${parts.slice(0, -2).join('/')}/${folderArea}/${parts.at(-1)!.slice(0, 10)}-${this.workName(name)}`;
    if (wanted === topic.workDir) return topic.workDir;
    const next = this.freeWorkDir(wanted);
    const root = this.options.brainDir ?? this.options.dataDir;
    if (this.brainCommits) await this.brainCommits.moveFolder(topic.workDir, next, `hos: ${topic.title} · work folder renamed`);
    else if (existsSync(join(root, topic.workDir))) await mkdir(dirname(join(root, next)), { recursive: true }).then(() => rename(join(root, topic.workDir!), join(root, next)));
    return next;
  }

  private nameChat(chatId: string, text: string): void {
    const fallback = topicTitle(text);
    this.record({ type: 'chat.titled', chatId, title: fallback, naming: true }, () => this.store.setChatTitle(chatId, fallback, true));
    void this.suggestTitle(text).then((title) => {
      if (this.stopped || !this.store.getChat(chatId)?.naming) return;
      const next = title ?? fallback;
      this.record({ type: 'chat.titled', chatId, title: next, naming: false }, () => this.store.setChatTitle(chatId, next, false));
    }).catch((error) => console.error('chat naming failed', error));
  }

  private async suggestTitle(text: string): Promise<string | null> {
    return (await this.suggestName(text, []))?.title ?? null;
  }

  private async suggestName(text: string, areas: string[]): Promise<Named | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((done) => (timer = setTimeout(() => done(null), TITLE_TIMEOUT_MS)));
    try {
      const named = await Promise.race([this.harnesses.primary.runtime.title!(text, areas), late]);
      const title = cleanTitle(named?.title);
      return title ? { title, area: named?.area ?? null } : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  markTopicSeen(topicId: string): Topic {
    const topic = this.requireTopic(topicId);
    const updated = { ...topic, lastSeenAt: this.clock.now() };
    this.record({ type: 'topic.updated', topic: updated }, () => this.store.setTopicSeen(topic.id, updated.lastSeenAt));
    return updated;
  }

  markAllTopicsSeen(): void {
    for (const topic of this.store.listTopics()) if (topicUnseen(topic)) this.markTopicSeen(topic.id);
  }

  attachWorkspace(topicId: string, workspaceId: string): Topic {
    return this.lifecycle.attach(topicId, workspaceId);
  }

  detachWorkspace(topicId: string, workspaceId: string): Topic {
    return this.lifecycle.detach(topicId, workspaceId);
  }

  async removeTopicWorkspace(topicId: string, workspaceId: string, force: boolean): Promise<Topic> {
    const topic = this.requireTopic(topicId);
    if (!topic.workspaceIds.includes(workspaceId)) throw new HosError(400, `${topic.title} does not use workspace ${workspaceId}`);
    const workspace = this.requireWorkspace(workspaceId);
    if (workspace.kind === 'root') return this.detachWorkspace(topicId, workspaceId);
    const others = this.store.topicsUsing(workspaceId).filter((t) => t.id !== topicId && t.state !== 'archived');
    if (others.length) throw new HosError(409, `${workspace.name} is also used by ${others.map((t) => t.title).join(', ')}; remove it from this topic instead`);
    await this.workspaces.archive(workspaceId, force);
    return this.requireTopic(topicId);
  }

  listWorkspaces(options: { archived?: boolean } = {}): Workspace[] {
    return this.store.listWorkspaces(options);
  }

  createWorkspace(input: WorkspaceInput): Promise<Workspace> {
    return this.lifecycle.create(input);
  }

  onTurnEnded(listener: (chat: Chat) => void): () => void {
    this.turnListeners.add(listener);
    return () => this.turnListeners.delete(listener);
  }

  onToolStarted(listener: (chat: Chat, tool: string, input: unknown) => void): () => void {
    this.toolListeners.add(listener);
    return () => this.toolListeners.delete(listener);
  }

  onTopicWorkspacesChanged(listener: (topic: Topic) => void): () => void {
    this.topicListeners.add(listener);
    return () => this.topicListeners.delete(listener);
  }

  private topicWorkspacesChanged(topic: Topic): void {
    for (const listener of this.topicListeners) listener(topic);
  }

  private turnFinished(chatId: string): void {
    const chat = this.store.getChat(chatId);
    if (!chat) return;
    for (const listener of this.turnListeners) listener(chat);
  }

  private topicActivity(chatId: string | null): void {
    const chat = chatId ? this.store.getChat(chatId) : undefined;
    const topic = chat && this.store.getTopic(chat.topicId);
    if (!topic) return;
    const updated = { ...topic, lastActivityAt: this.clock.now() };
    this.record({ type: 'topic.updated', topic: updated }, () => this.store.setTopicActivity(topic.id, updated.lastActivityAt));
  }

  private freeStatusTopic(wanted: string): string {
    for (let i = 1; ; i++) {
      const candidate = i === 1 ? wanted : `${wanted}-${i}`;
      if (!this.store.statusTopicTaken(candidate)) return candidate;
    }
  }

  private workRoot(): string {
    return this.contextPolicy.current().workRoot;
  }

  private areas(): string[] {
    return this.options.brainDir ? readAreas(this.options.brainDir, this.workRoot()) : [];
  }

  private workName(name: string): string {
    return this.options.workSuffix ? `${name}-${this.options.workSuffix}` : name;
  }

  private freeWorkDir(wanted: string): string {
    const root = this.options.brainDir ?? this.options.dataDir;
    for (let i = 1; ; i++) {
      const candidate = i === 1 ? wanted : `${wanted}-${i}`;
      if (!this.store.workDirTaken(candidate) && !existsSync(join(root, candidate))) return candidate;
    }
  }

  private workDirAbs(topic: Topic): string | null {
    const current = this.store.getTopic(topic.id)?.workDir ?? topic.workDir;
    return current ? join(this.options.brainDir ?? this.options.dataDir, current) : null;
  }

  private backfillWorkDirs(): void {
    const root = this.options.brainDir ?? this.options.dataDir;
    const tsv = join(root, this.workRoot(), META_DIR, 'topics.tsv');
    const folders = new Map<string, string>();
    try {
      for (const line of readFileSync(tsv, 'utf8').split('\n')) {
        const [statusSlug, workDir] = line.split('\t').map((cell) => cell?.trim());
        if (statusSlug && workDir) folders.set(statusSlug, workDir.replace(/\/+$/, ''));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`reading ${tsv} failed`, error);
    }
    this.store.backfillWorkDirs(folders, (topic) => this.freeWorkDir(workFolder(this.workRoot(), pickArea([], null), topic.createdAt, topic.statusTopic || slug(topic.title, 'topic'))));
  }

  private topicFolders(topic: Topic): Workspace[] {
    return topic.workspaceIds.flatMap((id) => this.store.getWorkspace(id) ?? []);
  }

  private place(topic: Topic): Place {
    const workspace = topic.workspaceIds[0] ? this.store.getWorkspace(topic.workspaceIds[0]) : undefined;
    if (workspace) return { path: workspace.path, branch: workspace.branch, projectId: workspace.projectId, workspace };
    const { brainDir } = this.options;
    if (!brainDir) throw new HosError(400, `topic "${topic.title}" has no workspace, and hos has no brain to work in`);
    return { path: brainDir, branch: null, projectId: this.store.listProjects().find((p) => p.brain)?.id ?? null, workspace: null };
  }

  private newChat(topicId: string, id: string, role: Role, createdBy: Creator, agent: string = this.harnesses.primary.id): Chat {
    return {
      id,
      topicId,
      agent,
      state: 'starting',
      createdBy,
      createdAt: this.clock.now(),
      parentId: null,
      role,
      depth: 0,
      intent: null,
      ownedFiles: [],
      worktreePath: null,
      predecessorId: null,
      lineageId: id,
      generation: 1,
      priority: PRIORITY_BY_ROLE[role],
      model: null,
      effort: null,
      suspended: false,
      title: null,
      naming: false,
      tabClosed: false,
      chrome: false,
      notify: createdBy !== 'agent',
      profile: GENERIC,
    };
  }

  async createChat(topicId: string, requestedRole?: Role, pick: { model?: string; effort?: string; agent?: string; chrome?: boolean; notify?: boolean; profile?: string } = {}): Promise<Chat> {
    const topic = this.store.getTopic(topicId);
    if (!topic) throw new HosError(404, `no topic ${topicId}`);
    if (topic.state === 'archived') throw new HosError(409, `topic ${topic.title} is archived`);
    const role = requestedRole ?? 'main';
    if (!ROLES.includes(role)) throw new HosError(400, `role must be one of ${ROLES.join(', ')}`);
    if (pick.effort !== undefined && !EFFORTS.includes(pick.effort as Effort)) throw new HosError(400, `effort must be one of ${EFFORTS.join(', ')}`);
    if (pick.model !== undefined && !/^[\w.:-]{1,80}$/.test(pick.model)) throw new HosError(400, 'model must be a model name or alias, like sonnet or opus');
    const defaults = this.profileDefaults(pick.profile, pick.agent);
    const harness = this.harnessFor(defaults.agent);
    const chat = {
      ...this.newChat(topicId, randomUUID(), role, 'human', harness.id),
      model: pick.model ?? defaults.model ?? null,
      effort: (pick.effort as Effort | undefined) ?? defaults.effort ?? null,
      chrome: pick.chrome ?? defaults.browser,
      notify: pick.notify ?? true,
      profile: this.requireProfile(pick.profile),
    };
    return this.launchChat(chat, topic);
  }

  private async projectChoices(): Promise<ProjectChoice[]> {
    const { brainDir } = this.options;
    const rows = brainDir ? await locationKeys(join(brainDir, 'shared', 'LOCATIONS.md')) : [];
    return this.listProjects().map((project) => ({ project, about: rows.find((row) => row.key === project.key)?.about ?? '' }));
  }

  private async freeBranch(project: Project, wanted: string): Promise<string> {
    for (let i = 1; ; i++) {
      const branch = i === 1 ? wanted : `${wanted}-${i}`;
      if (existsSync(this.worktreePathFor(project, branch))) continue;
      if (await resolveCommit(project.path, `refs/heads/${branch}`)) continue;
      return branch;
    }
  }

  async setTopicState(topicId: string, state: TopicState): Promise<Topic> {
    const topic = this.requireTopic(topicId);
    if (!TOPIC_STATES.includes(state)) throw new HosError(400, `state must be one of ${TOPIC_STATES.join(', ')}`);
    if (state === 'archived') return this.archiveTopic(topicId);
    if (topic.state === 'archived') throw new HosError(409, `topic ${topic.title} is archived`);
    return topic.state === state ? topic : this.updateTopicState(topic, state);
  }

  private ensureDesk(): void {
    if (this.options.brainDir) this.fixedTopic(DESK_META, DESK_TITLE, 'desk', { desk: true });
  }

  deskTitle(): string {
    const id = this.store.meta(DESK_META);
    return (id && this.store.getTopic(id)?.title) || DESK_TITLE;
  }

  private fixedTopic(meta: string, title: string, slugBase: string, kind: { desk: true }): Topic {
    const id = this.store.meta(meta);
    const existing = id ? this.store.getTopic(id) : undefined;
    if (existing) return existing;
    const topic: Topic = {
      id: randomUUID(),
      title,
      statusTopic: this.freeStatusTopic(slugBase),
      workDir: null,
      state: 'active',
      request: null,
      workspaceIds: [],
      lastSeenAt: null,
      lastActivityAt: null,
      createdBy: 'human',
      createdByChat: null,
      createdAt: this.clock.now(),
      naming: false,
      tabOrder: [],
      ...kind,
    };
    this.record({ type: 'topic.created', topic }, () => {
      this.store.insertTopic(topic);
      this.store.setMeta(meta, topic.id);
    });
    return topic;
  }

  private requireDesk(): Topic {
    const id = this.store.meta(DESK_META);
    const desk = id ? this.store.getTopic(id) : undefined;
    if (!desk) throw new HosError(400, `hos has no ${DESK_TITLE} topic (it needs a brain)`);
    return desk;
  }

  async archiveTopic(topicId: string): Promise<Topic> {
    const topic = this.requireTopic(topicId);
    if (topic.desk) throw new HosError(400, `${topic.title} is permanent, so it cannot be archived`);
    if (topic.state === 'archived') return topic;
    const chats = this.store.chatsInTopic(topic.id);
    const updated = this.updateTopicState(topic, 'archived');
    this.topicWorkspacesChanged(updated);
    await Promise.all(chats.filter((chat) => isLive(chat.state)).map((chat) => this.halt(chat.id, 'archived')));
    await this.clearTopicTerminals(updated).catch((error: Error) => console.error(`clearing the terminals of archived topic ${topic.title} failed: ${error.message}`));
    void this.clearTopicWorktrees(updated).catch((error: Error) => console.error(`clearing the worktrees of archived topic ${topic.title} failed: ${error.message}`));
    if (this.options.brainDir) {
      const progress = this.progressFile(topic);
      const openSection = progress ? sectionOf(parseProgress(await readFile(progress, 'utf8').catch(() => '')), 'Open') : undefined;
      const open = (openSection ?? '')
        .split('\n')
        .map((line) => line.trim().replace(/^[-*]\s+/, ''))
        .filter((line) => line && !/^none$/i.test(line) && !line.startsWith('<!--'));
      const results = chats.flatMap((chat) => {
        const { result } = this.store.spawnMeta(chat.id);
        return result ? [result] : [];
      });
      const roles = [...new Set(chats.map((c) => c.role))].map((role) => `${chats.filter((c) => c.role === role).length} ${role}`).join(', ');
      const written = await this.writeBrainRecord('history', null, topic, {
        title: `Archived topic ${topic.title}`,
        asked: topic.request ?? topic.title,
        did: `${chats.length} chat${chats.length === 1 ? '' : 's'} (${roles || 'none'}), state ${topic.state} before archiving; results: ${results.map((r) => firstLine(r.summary, 160)).join(' | ') || 'none recorded'}.`,
        wrote: [
          ...this.topicFolders(topic).map((w) => `worktree ${w.path} (branch ${w.branch ?? 'none'})`),
          ...results.flatMap((r) => (r.artifact ? [r.artifact] : [])),
        ].join('; '),
        open: open.map((line) => firstLine(line, 120)).join('; ') || 'none',
      });
      if (written.outcome !== 'ok') this.addInbox(null, 'alert', `Couldn’t write the history of ${topic.title}`, written.text, { topicId: topic.id });
    }
    return updated;
  }

  private async clearTopicTerminals(topic: Topic): Promise<void> {
    const shells = (await this.listTerminals(topic.id)).filter((terminal) => !terminal.chatId);
    const busy = shells.filter((terminal) => terminal.busy);
    await Promise.all(shells.filter((terminal) => !terminal.busy).map((terminal) => this.tmux.kill(terminal.name)));
    if (busy.length) {
      this.addInbox(null, 'alert', `Topic "${topic.title}" left ${busy.length} busy terminal${busy.length === 1 ? '' : 's'}`, `Still running, kept after archiving: ${busy.map((t) => t.name).join(', ')}. Kill them from Ops → Terminals when done.`, {
        topicId: topic.id,
      });
    }
  }

  private async clearTopicWorktrees(topic: Topic): Promise<void> {
    for (const { workspace, error } of await this.workspaces.clearArchivedTopic(topic)) {
      this.addInbox(null, 'alert', `Couldn’t clear worktree ${workspace.name}`, `Archived topic "${topic.title}" left ${workspace.path} in place: ${error}`, {
        topicId: topic.id,
        workspaceId: workspace.id,
      });
    }
  }

  // Worktrees archiving cleared stay detached; a chat attaches one again through the workspace picker.
  private reopenTopic(topic: Topic): Topic {
    if (topic.state !== 'archived') return topic;
    const updated = this.updateTopicState(topic, 'active');
    this.topicWorkspacesChanged(updated);
    return updated;
  }

  private updateTopicState(topic: Topic, state: TopicState): Topic {
    const updated = { ...topic, state };
    this.record({ type: 'topic.updated', topic: updated }, () => this.store.setTopicState(topic.id, state));
    return updated;
  }

  async historyAppendForChat(chatId: string, entry: HistoryEntry): Promise<BusReply> {
    const chat = this.requireChat(chatId);
    if (!this.options.brainDir) return { outcome: 'refused', text: 'Refused: hos has no brain, so there is no history to append to.' };
    const relayed = this.relayedEntries(chat, entry);
    const written = relayed.length ? relayEntry(entry, relayed) : entry;
    const at = this.clock.now();
    const reply = await this.writeBrainRecord('history', chat, this.store.getTopic(chat.topicId)!, written);
    if (reply.outcome !== 'ok') return reply;
    const logged: LoggedEntry = { chatId, at, title: written.title, paths: historyPaths(written.wrote) };
    this.store.setMeta(HISTORY_META + chatId, JSON.stringify(logged));
    this.bus.cardFromHistory(chatId, entry);
    if (!relayed.length) return reply;
    const who = relayed.map((l) => `chat ${l.chatId.slice(0, 8)}`).join(' and ');
    return {
      ...reply,
      text: `${reply.text} ${who} already logged this work, so your Did became a reference to that entry and Wrote keeps only the files it did not list. If you did work of your own beyond relaying it, append that as its own entry without naming ${who} or its files.`,
    };
  }

  // A child's entry from the last RELAY_WINDOW_MS that this entry names by chat id or shares a written file with.
  private relayedEntries(chat: Chat, entry: HistoryEntry): LoggedEntry[] {
    const now = this.clock.now();
    const mine = historyPaths(entry.wrote);
    const named = `${entry.asked} ${entry.did}`;
    return this.store
      .chatsInLineage(chat.lineageId)
      .flatMap((c) => this.store.childrenOf(c.id))
      .flatMap((child) => {
        const raw = this.store.meta(HISTORY_META + child.id);
        if (!raw) return [];
        const logged = JSON.parse(raw) as LoggedEntry;
        const tied = named.includes(child.id.slice(0, 8)) || logged.paths.some((p) => mine.includes(p));
        return tied && now - logged.at <= RELAY_WINDOW_MS ? [logged] : [];
      });
  }

  async progressReadForChat(chatId: string, input: { folder?: string }): Promise<BusReply> {
    const chat = this.requireChat(chatId);
    const folder = this.progressFolder(chat, input.folder);
    if ('refused' in folder) return { outcome: 'refused', text: folder.refused };
    const file = join(folder.dir, PROGRESS_FILE);
    const text = await readFile(file, 'utf8').catch(() => null);
    if (text === null) {
      return { outcome: 'ok', text: `No PROGRESS.md yet at ${file}. The first progress_update creates it from the template and must fill Goal, State, Where and Next step.` };
    }
    const progress = parseProgress(text);
    return {
      outcome: 'ok',
      text: [`${file} · ${text.length} characters`, progress.head, ...progress.sections.map((s) => `## ${s.name} (rev ${sectionRev(s.body)})\n\n${s.body}`)].join('\n\n'),
    };
  }

  async progressUpdateForChat(chatId: string, input: ProgressUpdate & { folder?: string }): Promise<BusReply> {
    const chat = this.requireChat(chatId);
    const folder = this.progressFolder(chat, input.folder);
    if ('refused' in folder) return { outcome: 'refused', text: folder.refused };
    const { folder: _folder, ...update } = input;
    return this.writeProgress(folder.dir, this.store.getTopic(chat.topicId)!, chat, update);
  }

  private progressFolder(chat: Chat, folder: string | undefined): { dir: string } | { refused: string } {
    const topic = this.store.getTopic(chat.topicId)!;
    const own = this.workDirAbs(topic);
    if (!folder?.trim()) {
      return own
        ? { dir: own }
        : { refused: `Refused: ${topic.desk ? topic.title : `topic "${topic.title}"`} has no work folder, so pass folder: an existing work/<area>/<YYYY-MM-DD>-<slug>/ folder in the brain.` };
    }
    const { brainDir } = this.options;
    if (!brainDir) return { refused: 'Refused: hos has no brain, so only the topic’s own work folder can be written.' };
    const root = join(brainDir, this.workRoot());
    const dir = resolve(brainDir, folder.trim());
    const parts = relative(root, dir).split(sep);
    if (!inside(root, dir) || parts.length !== 2 || parts[0] === META_DIR || !existsSync(dir)) {
      return { refused: `Refused: ${folder} is not an existing work folder; folder must be ${this.workRoot()}/<area>/<YYYY-MM-DD>-<slug>/ in the brain (create it first).` };
    }
    return { dir };
  }

  private brainWrite<T>(write: () => Promise<T>): Promise<T> {
    const written = this.brainRecords.then(write);
    this.brainRecords = written.then(
      () => undefined,
      () => undefined,
    );
    return written;
  }

  // from is null for hos's own writes (handoff, salvage), which skip the rev and first-write checks.
  private async writeProgress(dir: string, topic: Topic, from: Chat | null, update: ProgressUpdate): Promise<BusReply> {
    const file = join(dir, PROGRESS_FILE);
    const author = { who: from ? from.id.slice(0, 8) : 'hos', at: this.clock.now(), title: topic.title, force: from === null, tasksLine: this.tasks.summary(topic.id) };
    const shared = topic.home !== undefined || this.store.topicShared(topic.id);
    if (shared) await this.brainCommits?.pull();
    let applied: ProgressApplied;
    try {
      applied = await this.brainWrite(async () => {
        const current = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
        const result = applyProgress(current, update, author);
        if (result.ok) await replaceSections(file, result.text, parseProgress(result.text).sections.filter((s) => result.touched.includes(s.name) || s.name === 'Log'));
        return result;
      });
    } catch (error) {
      return { outcome: 'error', text: `hos could not write ${file}: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (!applied.ok) {
      const stale = applied.stale.map((s) => `## ${s.name} (rev ${s.rev})\n\n${s.body}`);
      return {
        outcome: 'refused',
        text: [
          `Refused: ${file} was not changed.`,
          ...applied.problems.map((p) => `- ${p}`),
          ...(stale.length ? ['These sections changed since you read them (or you gave no rev): merge your edit into the current text below and retry once with these revs.', ...stale] : []),
        ].join('\n'),
      };
    }
    const { brainDir } = this.options;
    if (brainDir && inside(brainDir, file)) void this.brainCommits?.commitPaths([relative(brainDir, file)], `hos: ${topic.title} · progress${from ? ` · chat ${from.id.slice(0, 8)}` : ''}`);
    const unpushed = shared && this.brainCommits ? await this.flushBrain().then(() => '', (error: Error) => ` Not pushed yet (${error.message}), so other computers don't see it.`) : '';
    const revs = parseProgress(applied.text).sections.filter((s) => applied.touched.includes(s.name)).map((s) => `${s.name} ${sectionRev(s.body)}`);
    const warn = applied.text.length > PROGRESS_WARN
      ? ` It is ${applied.text.length} characters, past the ${PROGRESS_WARN} warning line (the cap is 20000): move detail into files in the folder and link them under Where.`
      : '';
    return { outcome: 'ok', text: `Written to ${file} (${revs.length ? `new revs: ${revs.join(', ')}` : 'Log only'}).${warn}${unpushed}` };
  }

  private async writeBrainRecord(kind: 'history', from: Chat | null, topic: Topic, entry: HistoryEntry): Promise<BusReply> {
    const brainDir = this.options.brainDir!;
    const now = this.clock.now();
    const place = this.place(topic);
    const branch = await currentBranch(from ? this.chatCwd(from) : place.path).catch(() => place.branch ?? 'HEAD');
    const path = historyPath(brainDir, now);
    try {
      await this.brainWrite(() => appendHistory(path, historyBlock(now, branch, entry), localDate(now)));
    } catch (error) {
      return { outcome: 'error', text: `hos could not write ${path}: ${error instanceof Error ? error.message : String(error)}` };
    }
    void this.brainCommits?.commitPaths([relative(brainDir, path)], `hos: ${topic.title} · ${kind}${from ? ` · chat ${from.id.slice(0, 8)}` : ''}`);
    return { outcome: 'ok', text: `Written to ${path}.` };
  }

  getLineage(chatId: string): Lineage {
    const chat = this.store.getChat(chatId);
    if (!chat) throw new HosError(404, `no chat ${chatId}`);
    const handoffs = this.store.handoffs(chat.lineageId);
    return {
      id: chat.lineageId,
      chats: this.store.chatsInLineage(chat.lineageId),
      handoffs,
      stats: handoffStats(handoffs),
      overall: handoffStats(this.store.handoffs()),
    };
  }

  async sendMessage(chatId: string, text: string, attachments: string[] = []): Promise<void> {
    const chat = this.store.getChat(chatId);
    if (!chat) throw new HosError(404, `no chat ${chatId}`);
    if (chat.computer) return this.forwardMessage(chat, text, attachments);
    const files = await this.attachedFiles(chat, attachments);
    if (this.inTerminal.has(chatId)) throw new HosError(409, `chat ${chatId} is taken over in a terminal; hand it back first`);
    if (chat.state === 'handed_off') {
      const next = this.store.chatsInLineage(chat.lineageId).find((c) => c.predecessorId === chatId);
      throw new HosError(409, `chat ${chatId} has handed off${next ? ` to chat ${next.id}` : ''} and is read-only; message its successor`);
    }
    if (chat.state === 'archived' || this.store.getTopic(chat.topicId)!.state === 'archived') {
      const cwd = this.sessionCwd(chat);
      if (!existsSync(cwd)) throw new HosError(409, `chat ${chatId} worked in ${cwd}, which is gone, so it can be read but not continued; start a new chat`);
    }
    const killSwitch = this.killSwitchFor(chat.topicId);
    if (killSwitch) throw new HosError(409, `the ${killSwitch} kill switch is on; lift it before messaging chat ${chatId}`);
    const topic = this.reopenTopic(this.store.getTopic(chat.topicId)!);
    if (isHalted(chat.state)) {
      this.retired.delete(chatId);
      this.setState(chatId, 'idle');
    }
    if (chat.state === 'queued') this.dispatch(chat);
    else if (!this.isRunning(chat)) this.dispatched.add(chatId);
    let session: AgentSession;
    try {
      session = await (this.sessions.get(chatId) ?? this.resumeSession(chat));
    } catch (error) {
      this.dispatched.delete(chatId);
      throw error;
    }
    await this.lifecycle.syncTopic(topic);
    await this.snapshot(chatId, 'turn', this.chatCwd(chat));
    const message = { type: 'message.user' as const, chatId, messageId: randomUUID(), text, ...(files.length ? { attachments: files } : {}) };
    this.record(message, () => this.store.setProgress(chatId, null, this.clock.now()));
    if (this.harnesses.primary.runtime.title && chat.role === 'main' && chat.generation === 1 && chat.title === null && this.firstLineage(topic) !== chat.lineageId) {
      this.nameChat(chatId, text);
    }
    const drawn = this.harnesses.primary.runtime.title ? this.diagrams?.byChat(chat.lineageId) : undefined;
    if (drawn?.naming) this.nameDiagram(drawn.id, text);
    const sent = files.length ? `${text}\n\nAttached files (in the brain): ${files.map((file) => file.path).join(', ')}` : text;
    let delivered = false;
    const plan = this.store.latestPlan(chatId);
    for (const item of this.store.openInboxItems(chatId)) {
      if (item.kind === 'completion' || item.kind === 'failure') this.saveInbox({ ...item, state: 'done' });
      if (item.kind === 'plan' && !isImplement(text)) this.saveInbox({ ...item, state: 'done', resolution: PLAN_REPLIED });
      if (item.kind !== 'question' || item.picker || item.handoff) continue;
      this.saveInbox({ ...item, state: 'done', resolution: 'Replied in chat' });
      if (!this.pending.has(item.id)) continue;
      this.settle(item.id, { deny: delivered ? questionsSkipped() : repliedInChat(sent) });
      delivered = true;
    }
    if (!delivered) session.send(sent);
    if (plan && awaitsApproval(plan) && isImplement(text)) await this.approvePlan(plan);
  }

  async spawn(parentId: string, request: SpawnRequest, options: SpawnOptions = {}): Promise<BusReply & { chatId?: string }> {
    const parent = this.store.getChat(parentId)!;
    const topic = this.store.getTopic(parent.topicId)!;
    if (topic.state === 'archived') return { outcome: 'refused', text: `Spawn denied: topic "${topic.title}" is archived.` };
    if (this.elsewhere(request.computer)) return this.spawnOnComputer(parent, topic, request.computer, request);
    const defaults = this.profileDefaults(request.profile, request.agent, parent.agent);
    const { agent } = defaults;
    const harness = this.harnesses.get(agent);
    if (!harness) {
      return { outcome: 'refused', text: `Spawn denied: no "${agent}" harness; installed: ${this.harnesses.all().map((h) => h.id).join(', ')}.` };
    }
    if (request.model && !harness.models().list.some((m) => m.id === request.model)) {
      return { outcome: 'refused', text: `Spawn denied: ${agent} has no model "${request.model}"; pick one of ${harness.models().list.map((m) => m.id).join(', ')}.` };
    }
    if (request.browser && !harness.features.browser) {
      return { outcome: 'refused', text: `Spawn denied: browser: true needs a harness with the browser (${this.harnesses.all().filter((h) => h.features.browser).map((h) => h.id).join(', ')}); ${agent} has no browser.` };
    }
    const profile = request.profile ?? GENERIC;
    const profiles = this.profiles();
    if (profile !== GENERIC && !profiles.list.some((p) => p.id === profile)) {
      return { outcome: 'refused', text: `Spawn denied: there is no profile "${profile}"; profiles: ${profiles.list.map((p) => p.id).join(', ')}.` };
    }
    const starter = profileFor(profiles, parent.profile).profile;
    if (!mayStart(starter, profile)) {
      return { outcome: 'refused', text: `Spawn denied: your profile ${starter.id} may start only ${(starter.canStart as string[]).join(', ') || 'no other chats'}, not ${profile}.` };
    }
    const repeat = this.store.findSpawn(parentId, request.client_request_id);
    if (repeat) {
      return {
        outcome: 'ok',
        text: `${repeat.decision === 'spawned' ? 'Spawned' : 'Joined'} chat ${repeat.chatId} earlier for client_request_id "${request.client_request_id}"; nothing new was started.`,
      };
    }
    const limits = this.options.spawnLimits;
    const now = this.clock.now();
    const key = intentKey(request.intent);
    const chats = this.store.chatsInTopic(topic.id);
    const live = chats.filter((c) => (LIVE_STATES as readonly string[]).includes(c.state));
    const similar = live
      .filter((c) => c.intent && c.id !== parentId)
      .map((chat) => ({ chat, score: similarity(chat.intent!, request.intent) }))
      .filter((s) => s.score >= limits.similarityNeedsApproval)
      .sort((a, b) => b.score - a.score)[0];
    const verdict = admit(
      {
        parent,
        role: request.role,
        killSwitch: this.killSwitchFor(topic.id),
        duplicate: this.store.chatByIntent(topic.id, key, now - limits.dedupWindowHours * HOUR, ['killed', 'failed']),
        similar,
        confirmSimilar: request.confirm_similar,
        spawnsLast10Minutes: this.store.spawnsSince(topic.id, now - 10 * MINUTE),
      },
      limits,
    );
    const spawnRecord = (decision: 'spawned' | 'joined', chatId: string) => ({
      id: randomUUID(),
      topicId: topic.id,
      parentChatId: parentId,
      clientRequestId: request.client_request_id,
      decision,
      chatId,
      createdAt: now,
    });
    if (verdict.decision === 'deny') return { outcome: 'refused', text: `Spawn denied: ${verdict.reason}.` };
    const owned = request.files_owned.map(normalizePattern);
    if (owned.includes(null)) {
      return { outcome: 'refused', text: 'Spawn denied: files_owned are paths or globs relative to the worktree, without "..".' };
    }
    const writes = request.role === 'worker' || request.role === 'main';
    const writer = verdict.decision === 'spawn' && writes && owned.length > 0;
    const place = this.place(topic);
    let target: Workspace | undefined;
    if (request.workspace) {
      try {
        target = this.workspaces.workspaceForChat(parentId, request.workspace);
      } catch (error) {
        return { outcome: 'refused', text: `Spawn denied: ${(error as Error).message}` };
      }
      if (!topic.workspaceIds.includes(target.id)) {
        return { outcome: 'refused', text: `Spawn denied: ${target.name} is not one of your topic's workspaces; attach it with workspace_choose first.` };
      }
      if (target.id === place.workspace?.id) target = undefined;
    }
    if (request.own_worktree && target) {
      return { outcome: 'refused', text: `Spawn denied: own_worktree works only in the topic's first workspace (${place.path}), because its work merges back there.` };
    }
    const home = target?.path ?? options.worktreePath ?? place.path;
    const lockConflicts = writer && !request.own_worktree ? this.locks.conflicts(topic.id, owned as string[], home) : [];
    if (lockConflicts.length) {
      return { outcome: 'refused', text: `Spawn denied: ${lockConflicts.join('; ')}. Pick other files, or wait for the owner to unlock.` };
    }
    if (verdict.decision === 'join') {
      this.store.insertSpawn(spawnRecord('joined', verdict.chat.id));
      return {
        outcome: 'ok',
        text: `Joined chat ${verdict.chat.id} (${verdict.chat.role}, ${verdict.chat.state}) instead of spawning: ${verdict.reason}. Message it with send, or wait for it.`,
      };
    }
    const project = place.projectId ? this.store.getProject(place.projectId) : undefined;
    const id = randomUUID();
    const subBranch = project && writes && request.own_worktree ? `hos/${topic.statusTopic}-${id.slice(0, 8)}` : null;
    const chat: Chat = {
      id,
      topicId: topic.id,
      agent,
      state: 'starting',
      createdBy: 'agent',
      createdAt: now,
      parentId,
      role: request.role,
      depth: parent.depth + 1,
      intent: request.intent,
      ownedFiles: owned as string[],
      worktreePath: subBranch && project ? this.worktreePathFor(project, subBranch) : (target?.path ?? options.worktreePath ?? null),
      predecessorId: null,
      lineageId: id,
      generation: 1,
      priority: request.batch || parent.priority === BATCH_PRIORITY ? BATCH_PRIORITY : PRIORITY_BY_ROLE[request.role],
      model:
        request.model ??
        (agent === this.harnesses.primary.id ? this.spawnModel(request.role) : null) ??
        defaults.model ??
        (agent === this.harnesses.primary.id ? harness.models().default : null) ??
        (agent === parent.agent ? parent.model : harness.models().default),
      effort:
        request.effort ??
        defaults.effort ??
        (agent === this.harnesses.primary.id ? harness.models().effort : agent === parent.agent ? parent.effort : harness.models().effort),
      suspended: false,
      title: request.role === 'main' ? request.intent : null,
      naming: false,
      tabClosed: false,
      chrome: request.browser ?? defaults.browser,
      notify: request.notify === true,
      profile,
    };
    const contract = {
      artifact: request.return_contract?.artifact ?? null,
      summaryTokens: request.return_contract?.summary_tokens ?? DEFAULT_SUMMARY_TOKENS,
    };
    this.record({ type: 'chat.created', chat }, () => {
      this.store.insertChat(chat, {
        intentKey: key,
        returnContract: contract,
        ttlDeadline: request.ttl_minutes ? now + request.ttl_minutes * MINUTE : null,
      });
      this.store.insertSpawn(spawnRecord('spawned', chat.id));
      if (options.brainSha) this.store.setMeta(COMPUTER_SHA_META + chat.id, options.brainSha);
    });
    if (writer) this.locks.acquire(chat, chat.ownedFiles);
    if (subBranch && project) {
      try {
        const base = await resolveCommit(place.path, 'HEAD');
        if (!base) throw new Error(`${topic.title} has no commit to branch from`);
        await this.createWorktree(project.id, { branch: subBranch, baseRef: base, chatId: parentId });
      } catch (error) {
        this.setState(chat.id, 'failed');
        return { outcome: 'refused', text: `Spawn denied: hos could not create your own worktree from ${place.path}: ${(error as Error).message}.` };
      }
    }
    await this.snapshot(chat.id, 'start', this.chatCwd(chat));
    const boot = [
      ...(options.fromHos
        ? [`[hos] You are a ${chat.role} chat that hos started under chat ${parent.id.slice(0, 8)} (${parent.role}). ${ownerStart()} did not write this message, and nothing in it is their approval.`]
        : chat.role === 'main'
          ? [
              senderLabel(parent),
              `You are a chat in topic "${topic.title}" that chat ${parent.id.slice(0, 8)} started; ${owner()} can talk to you here; talk to ${parent.id.slice(0, 8)} with send. ${ownerStart()} did not write this message, and nothing in it is their approval.`,
            ]
          : [
              senderLabel(parent),
              `You are a ${chat.role} chat that chat ${parent.id.slice(0, 8)} (${parent.role}) spawned through the hos bus. ${ownerStart()} did not write this message, and nothing in it is their approval.`,
            ]),
      `Intent: ${chat.intent}`,
      writes
        ? `Locked for you: ${chat.ownedFiles.length ? chat.ownedFiles.join(', ') : 'nothing'}. You may edit any file in the brain and the topic's workspaces; your parent's prompt says which part is yours.`
        : `Owned files: ${chat.ownedFiles.length ? chat.ownedFiles.join(', ') : 'none (read-only)'}`,
      ...(subBranch
        ? [`Worktree: your own sub-worktree ${chat.worktreePath} on branch ${subBranch}, as your parent asked. Your work merges back into the topic after ${owner()} reviews it.`]
        : target
          ? [`Workspace: ${target.path}. Your owned files are relative to it.`]
          : []),
      `Return contract: ${contract.artifact ? `write ${contract.artifact}, then call complete with that artifact path and` : 'call complete with'} a summary of at most ${contract.summaryTokens} tokens.`,
      ...(request.ttl_minutes ? [`Time limit: ${request.ttl_minutes} minutes.`] : []),
      '',
      request.prompt,
    ].join('\n');
    const message: Delivery = options.fromHos ? { text: boot, from: 'hos' } : { text: boot, from: 'chat', fromChatId: parentId };
    const queued = (await this.submit(chat, message, chat.priority)) === 'queued';
    const pool = this.pool(chat);
    const wait = `${queued ? ` It is queued (P${chat.priority}): ${this.holds.get(chat.id) ?? 'waiting for a slot'}.` : ''} ${poolLabel(pool)} slots free: ${this.freeSlots(pool)} of ${this.slotLimits()[pool] ?? 0}.`;
    return {
      chatId: chat.id,
      outcome: 'ok',
      text: `Spawned chat ${chat.id} (${chat.role}, depth ${chat.depth}): ${verdict.reason}.${wait} Use wait to block until it finishes, or send to message it.`,
    };
  }

  waitFor(callerId: string, target: string, timeoutS: number): Promise<BusReply> {
    const chat = this.bus.resolveChat(callerId, target);
    const unread = this.bus.unreadable(chat, 'state');
    if (unread) return Promise.resolve(unread);
    if (!isBusy(chat.state)) return Promise.resolve(this.waitReply(callerId, chat.id));
    // The MCP client cuts a tool call off around 60 s, so a longer server-side wait would surface to the
    // agent as "The operation timed out" rather than a normal result. Cap each wait below that and tell the
    // agent to wait again; it loops until the chat finishes (H2).
    const waitS = Math.min(timeoutS, WAIT_CLAMP_S);
    return new Promise((resolve) => {
      const waiters = this.waiters.get(chat.id) ?? new Set();
      this.waiters.set(chat.id, waiters);
      const wake = () => {
        cancel();
        waiters.delete(wake);
        resolve(this.waitReply(callerId, chat.id));
      };
      const cancel = this.clock.setTimeout(() => {
        waiters.delete(wake);
        const { state } = this.store.getChat(chat.id)!;
        resolve({ outcome: 'ok', text: `Chat ${this.bus.chatName(chat)} is still ${state} after ${waitS} s; wait again, or send it a message.` });
      }, waitS * 1000);
      waiters.add(wake);
    });
  }

  complete(chatId: string, input: { artifact?: string; summary?: string }): BusReply {
    const chat = this.store.getChat(chatId)!;
    const contract = this.store.spawnMeta(chatId).returnContract ?? { artifact: null, summaryTokens: DEFAULT_SUMMARY_TOKENS };
    if (!input.summary?.trim()) return { outcome: 'refused', text: 'Refused: give a summary of your result.' };
    if (contract.artifact && !input.artifact?.trim()) {
      return { outcome: 'refused', text: `Refused: your return contract asks for the artifact ${contract.artifact}; pass its path.` };
    }
    const artifact = input.artifact?.trim() || contract.artifact;
    const passed = input.artifact?.trim();
    const tried = [...new Set([...(passed ? this.artifactPaths(chat, passed) : []), ...(contract.artifact ? [this.contractArtifact(chat)!] : [])])];
    if (tried.length && !tried.some((path) => existsSync(path))) {
      return { outcome: 'refused', text: `Refused: the artifact ${artifact} does not exist; tried ${tried.join(', ')}; write it first.` };
    }
    const summary = input.summary!.trim();
    if (tokens(summary) > contract.summaryTokens) {
      return {
        outcome: 'refused',
        text: `Refused: your summary is about ${tokens(summary)} tokens and your return contract allows ${contract.summaryTokens} tokens; move detail into the artifact.`,
      };
    }
    const result = { summary, artifact: artifact ?? null };
    this.record({ type: 'chat.result', chatId, result }, () => this.store.setResult(chatId, result));
    return { outcome: 'ok', text: 'Recorded. End your turn now; you will be marked done and your parent chat is told.' };
  }

  async sendToChat(senderId: string, to: string, text: string): Promise<BusReply> {
    const sender = this.store.getChat(senderId)!;
    const target = this.bus.resolveChat(senderId, to);
    if (target.id === senderId) return { outcome: 'refused', text: 'Refused: you cannot message yourself.' };
    const resumes = target.state === 'paused' && !this.killSwitchFor(target.topicId);
    if ((isHalted(target.state) && !resumes) || this.inTerminal.has(target.id)) {
      return { outcome: 'refused', text: `Refused: chat ${target.id} is ${target.state}, so it gets no messages until ${owner()} resumes it.` };
    }
    if (await this.isPingPong(sender, target)) {
      this.freezePair(sender, target);
      return {
        outcome: 'refused',
        text: `Refused: ping-pong. You and chat ${target.id} traded ${PING_PONG_ROUND_TRIPS} round-trips with no artifact or diff change, so hos paused you both and asked ${owner()}.`,
      };
    }
    if (resumes) {
      this.retired.delete(target.id);
      this.setState(target.id, 'idle');
    }
    const outcome = await this.submit(this.requireChat(target.id), { text: `${senderLabel(sender)}\n${text}`, from: 'chat', fromChatId: senderId }, target.priority);
    const queued = outcome === 'queued' ? ` It is queued until the governor admits it: ${this.holds.get(target.id) ?? 'waiting for a slot'}.` : '';
    return {
      outcome: 'ok',
      text: `Sent to chat ${this.bus.chatName(target)} (${target.role}, ${resumes ? 'paused, so hos resumed it' : target.state}). It arrives between its turns, labelled as from you, not ${owner()}.${queued}`,
    };
  }

  ask(chatId: string, input: { question: string; options: string[]; recommendation: string }): BusReply {
    const question: Question = {
      question: input.question,
      header: 'Question',
      options: input.options.map((label) => ({ label, description: '' })),
      multiSelect: false,
    };
    this.addInbox(chatId, 'question', 'Question', input.question, {
      questions: [question],
      recommendation: input.recommendation,
      parked: true,
    });
    this.setState(chatId, 'waiting_input');
    return {
      outcome: 'ok',
      text: `Parked: your question is in ${owner()}'s Inbox. End your turn now and start nothing new; their answer arrives as your next message.`,
    };
  }

  lockForChat(chatId: string, paths: string[], ttlMinutes?: number): BusReply {
    return this.locks.acquire(this.requireChat(chatId), paths, ttlMinutes);
  }

  unlockForChat(chatId: string, paths?: string[]): BusReply {
    return this.locks.unlock(this.requireChat(chatId), paths);
  }

  locksForChat(chatId: string): BusReply {
    return this.locks.list(this.requireChat(chatId));
  }

  listLocks(topicId: string): Lock[] {
    return this.locks.live(this.requireTopic(topicId).id);
  }

  lockHolders(pattern: string): Array<{ holder: string; root: string }> {
    return this.locks.holders(pattern);
  }

  createTask(
    chatId: string,
    input: { title: string; depends_on?: string[]; limit_minutes?: number; priority?: TaskPriority; criteria?: string[]; found_while?: string; from_snag?: string },
  ): BusReply {
    const chat = this.requireChat(chatId);
    const dependsOn = [...new Set((input.depends_on ?? []).map(taskRef))];
    const missing = this.tasks.missingDependencies(chat.topicId, [...dependsOn, ...(input.found_while ? [taskRef(input.found_while)] : [])]);
    if (missing.length) return { outcome: 'refused', text: `Refused: there is no task ${missing.join(', ')} in your topic.` };
    const task = this.tasks.create(chat.topicId, chat, {
      title: input.title,
      dependsOn,
      ...(input.limit_minutes ? { limitMinutes: input.limit_minutes } : {}),
      ...(input.priority ? { priority: input.priority } : {}),
      ...(input.criteria ? { criteria: input.criteria } : {}),
      ...(input.found_while ? { foundWhile: input.found_while } : {}),
      ...(input.from_snag ? { fromSnag: input.from_snag.trim().toUpperCase() } : {}),
    });
    const after = dependsOn.length ? ` (after ${dependsOn.join(', ')})` : '';
    if (task.state === 'proposed') return { outcome: 'ok', text: `Proposed ${task.ref}${after}, found while doing ${task.discoveredFrom}. ${ownerStart()} or a main chat accepts it before anyone can claim it.` };
    return { outcome: 'ok', text: `Created ${task.ref} (P${task.priority})${after}. Workers claim it with task_claim.` };
  }

  claimTask(chatId: string, ref?: string): BusReply {
    return this.tasks.claim(this.requireChat(chatId), ref);
  }

  completeTask(chatId: string, ref: string, evidence?: string, met?: number[]): BusReply {
    const chat = this.requireChat(chatId);
    return this.tasks.complete(chat.topicId, chat, ref, evidence, met);
  }

  updateTaskForChat(chatId: string, ref: string, patch: TaskPatch): BusReply {
    const chat = this.requireChat(chatId);
    return this.tasks.update(chat.topicId, chat, ref, patch);
  }

  tasksForChat(chatId: string): BusReply {
    return this.tasks.list(this.requireChat(chatId));
  }

  listTasks(topicId: string): Task[] {
    return this.store.tasks(this.requireTopic(topicId).id);
  }

  addTask(topicId: string, input: { title?: string; priority?: TaskPriority; criteria?: string[]; fromSnag?: string }): Task {
    const topic = this.requireTopic(topicId);
    const title = input.title?.trim();
    if (!title) throw new HosError(400, 'a task needs a title');
    if (title.length > 1200) throw new HosError(400, 'a task title is at most 1200 characters');
    if (input.priority !== undefined && ![1, 2, 3].includes(input.priority)) throw new HosError(400, 'priority is 1, 2 or 3');
    return this.tasks.create(topic.id, null, {
      title,
      ...(input.priority ? { priority: input.priority } : {}),
      ...(input.criteria ? { criteria: input.criteria.slice(0, 20).map(String) } : {}),
      ...(input.fromSnag ? { fromSnag: input.fromSnag } : {}),
    });
  }

  patchTask(topicId: string, ref: string, patch: TaskPatch): Task {
    const topic = this.requireTopic(topicId);
    if (patch.priority !== undefined && ![1, 2, 3].includes(patch.priority)) throw new HosError(400, 'priority is 1, 2 or 3');
    const reply = this.tasks.update(topic.id, null, ref, patch);
    if (reply.outcome !== 'ok') throw new HosError(409, reply.text);
    return this.requireTask(topic.id, ref);
  }

  async linkTask(topicId: string, ref: string, link: boolean): Promise<Task> {
    const topic = this.requireTopic(topicId);
    const task = this.requireTask(topic.id, ref);
    const userTasks = this.options.userTasks;
    if (!userTasks) throw new HosError(503, 'hos has no task source');
    if (!link) {
      if (task.mirrorId) {
        const dropped = await userTasks.drop(task.mirrorId);
        if (!dropped.ok) throw new HosError(502, dropped.error ?? `${userTasks.label} did not drop the task`);
        this.tasks.setMirror(topic.id, task.ref, null, false);
      }
      return this.requireTask(topic.id, ref);
    }
    if (task.mirrorId) return task;
    const error = await this.mirrorTask(topic, task, false);
    if (error) throw new HosError(502, error);
    return this.requireTask(topic.id, ref);
  }

  private requireTask(topicId: string, ref: string): Task {
    const task = this.store.tasks(topicId).find((t) => t.ref === taskRef(ref));
    if (!task) throw new HosError(404, `there is no task ${ref} in this topic`);
    return task;
  }

  private async mirrorTask(topic: Topic, task: Task, auto: boolean): Promise<string | null> {
    const origin = this.options.webOrigin ? await this.options.webOrigin().catch(() => null) : null;
    const title = `${task.ref} · ${task.title.split('\n')[0]!.slice(0, 160)} (${topic.title})`;
    const added = await this.options.userTasks!.addLinked(title, MIRROR_PRIORITY[task.priority], origin ? `${origin}/#/topic/${topic.id}` : null);
    if (!added.ok) return added.reason;
    this.tasks.setMirror(topic.id, task.ref, added.id, auto);
    return null;
  }

  // Blocked and review tasks wait on the user, so they get a copy in the user's own task list; it closes when the task moves on.
  private syncMirror(before: Task | null, after: Task): void {
    const userTasks = this.options.userTasks;
    if (!userTasks) return;
    const waits = after.state === 'review' || after.state === 'blocked';
    const failed = (error: unknown) => console.error(`task copy in ${userTasks.label} for ${after.ref} failed`, error);
    if (after.mirrorId) {
      const id = after.mirrorId;
      if (after.state === 'done' || after.state === 'dropped' || (after.mirrorAuto && !waits)) {
        this.tasks.setMirror(after.topicId, after.ref, null, false);
        void (after.state === 'dropped' ? userTasks.drop(id) : userTasks.done(id)).catch(failed);
      } else if (before && before.priority !== after.priority) void userTasks.setPriority(id, MIRROR_PRIORITY[after.priority]).catch(failed);
      return;
    }
    if (!waits || before?.state === 'review' || before?.state === 'blocked') return;
    const topic = this.store.getTopic(after.topicId);
    if (topic) void this.mirrorTask(topic, after, true).then((error) => error && failed(error), failed);
  }

  listKillSwitches(): KillSwitch[] {
    return this.store.killSwitches();
  }

  async kill(scope: KillScope | 'subtree', target: { topicId?: string; chatId?: string }): Promise<{ killed: string[] }> {
    let chats: Chat[];
    if (scope === 'subtree') {
      const root = this.requireChat(target.chatId ?? '');
      chats = this.subtree(root);
    } else if (scope === 'topic') {
      const topic = this.requireTopic(target.topicId ?? '');
      chats = this.store.chatsInTopic(topic.id);
      this.record({ type: 'kill.switch', scope, topicId: topic.id, on: true }, () =>
        this.store.setKillSwitch('topic', topic.id, this.clock.now()),
      );
    } else if (scope === 'global') {
      chats = this.store.chatsInState([...LIVE_STATES]);
      this.record({ type: 'kill.switch', scope, on: true }, () => this.store.setKillSwitch('global', '', this.clock.now()));
    } else {
      throw new HosError(400, 'scope must be global, topic or subtree');
    }
    for (const chat of chats) this.store.deleteMeta(LIMIT_RESUME_META + chat.id);
    const live = chats.filter((chat) => isLive(chat.state));
    await Promise.all(live.map((chat) => this.halt(chat.id, 'killed')));
    return { killed: live.map((chat) => chat.id) };
  }

  liftKillSwitch(scope: KillScope, topicId?: string): void {
    if (scope !== 'global' && scope !== 'topic') throw new HosError(400, 'scope must be global or topic');
    if (scope === 'topic') this.requireTopic(topicId ?? '');
    const key = scope === 'topic' ? topicId! : '';
    this.record({ type: 'kill.switch', scope, ...(scope === 'topic' ? { topicId: key } : {}), on: false }, () =>
      this.store.clearKillSwitch(scope, key),
    );
  }

  async getDiff(scope: DiffScope): Promise<Diff> {
    if ('chatId' in scope) {
      const chat = this.requireChat(scope.chatId);
      const trees = this.store.getChatTrees(chat.id);
      const from = scope.since === 'turn' ? (trees.turn ?? trees.start) : trees.start;
      if (!from) throw new HosError(409, `chat ${chat.id} has no snapshot to diff against`);
      const folder = this.place(this.store.getTopic(chat.topicId)!).workspace;
      return this.diff(folder?.id ?? '', chat.id, from, undefined, this.chatCwd(chat));
    }
    const workspace = this.requireWorkspace(scope.workspaceId);
    const path = workspace.path;
    if (scope.ref) {
      const target = await resolveCommit(path, scope.ref);
      if (!target) throw new HosError(404, `no commit ${scope.ref} in ${workspace.name}`);
      return this.diff(workspace.id, null, (await mergeBase(path, 'HEAD', target)) ?? EMPTY_TREE, target, path);
    }
    const mainBranch = this.store.listWorktrees(workspace.projectId).find((w) => w.main)?.branch;
    const head = (await resolveCommit(path, 'HEAD')) ?? EMPTY_TREE;
    return this.diff(workspace.id, null, (mainBranch && (await mergeBase(path, 'HEAD', mainBranch))) || head, undefined, path);
  }

  async discardFile(workspaceId: string, path: string): Promise<DiffActionResult> {
    const workspace = this.requireWorkspace(workspaceId);
    const cwd = workspace.path;
    const head = (await resolveCommit(cwd, 'HEAD')) ?? EMPTY_TREE;
    const file = (await changedFiles(cwd, head, await snapshotTree(cwd))).find((f) => f.path === path);
    if (!file) throw new HosError(400, `${path} has no uncommitted changes in ${workspace.name}`);
    const command = `git restore --source=HEAD --staged --worktree -- ${JSON.stringify(path)}`;
    return this.humanAction(workspace, 'discard', 'Discard file', command, async () => {
      await discardChanges(cwd, [path, ...(file.oldPath ? [file.oldPath] : [])]);
      return `Discarded the uncommitted changes to ${path}`;
    });
  }

  async commit(workspaceId: string, message: string): Promise<DiffActionResult> {
    const workspace = this.requireWorkspace(workspaceId);
    const cwd = workspace.path;
    if (!message.trim()) throw new HosError(400, 'a commit needs a message');
    if (!(await worktreeStatus(cwd, null)).dirty) throw new HosError(400, `nothing to commit in ${workspace.name}`);
    return this.humanAction(workspace, 'commit', 'Commit', `git add -A && git commit -m ${JSON.stringify(message)}`, async () => {
      if (!(await worktreeStatus(cwd, null)).dirty) throw new Error(`nothing to commit in ${workspace.name}`);
      return `Committed ${await commitAll(cwd, message)}`;
    });
  }

  async openPullRequest(workspaceId: string): Promise<DiffActionResult> {
    const workspace = this.requireWorkspace(workspaceId);
    const cwd = workspace.path;
    const branch = await currentBranch(cwd);
    if (branch === 'HEAD') throw new HosError(400, `${workspace.name} is on a detached HEAD; check out a branch first`);
    const command = `git push -u origin ${branch} && gh pr create --fill --head ${branch}`;
    return this.humanAction(workspace, 'open_pr', 'Open pull request', command, async () => {
      return `Opened ${await pushAndOpenPullRequest(cwd, branch, this.options.ghBin)}`;
    });
  }

  async mergeBack(chatId: string): Promise<DiffActionResult> {
    const chat = this.requireChat(chatId);
    const sub = chat.worktreePath;
    const topic = this.store.getTopic(chat.topicId)!;
    const branch = sub ? await currentBranch(sub).catch(() => null) : null;
    if (!sub || branch !== `hos/${topic.statusTopic}-${chatId.slice(0, 8)}`) {
      throw new HosError(400, `chat ${chatId} is not on a sub-worktree; its work is already in its workspace`);
    }
    const workspace = this.place(topic).workspace;
    if (!workspace) throw new HosError(400, `chat ${chatId}'s topic has no workspace to merge into`);
    const command = `git merge --no-ff --no-edit ${branch}`;
    return this.humanAction(workspace, 'merge', 'Merge sub-worktree', command, async () => {
      if ((await worktreeStatus(sub, null)).dirty) {
        await commitAll(sub, `hos: work of chat ${chatId.slice(0, 8)}${chat.intent ? ` (${chat.intent})` : ''}`);
      }
      return `Merged ${branch} into ${workspace.name}: ${await mergeBranch(workspace.path, branch)}`;
    });
  }

  async sendReview(chatId: string, comments: ReviewComment[]): Promise<void> {
    this.requireChat(chatId);
    if (!comments.length) throw new HosError(400, 'a review needs at least one comment');
    const lines = comments.map(
      (c) => `- ${c.path} line ${c.line}${c.side === 'deletions' ? ' (removed line)' : ''}: ${c.text.trim()}`,
    );
    const intro = `Review comments from ${owner()} on your diff. Address each one, then reply with what you changed.`;
    await this.sendMessage(chatId, [intro, '', ...lines].join('\n'));
  }

  listActions(workspaceId: string): ActionList {
    const workspace = this.requireWorkspace(workspaceId);
    const project = this.store.getProject(workspace.projectId);
    const repos = [project?.key, project?.name].filter((name): name is string => Boolean(name));
    return loadActions(this.options.brainDir, workspace.path, repos);
  }

  async runCustomAction(workspaceId: string, name: string, request: ActionRequest): Promise<ActionRun> {
    const workspace = this.requireWorkspace(workspaceId);
    const action = this.requireAction(workspace, name);
    const command = this.actionCommand(action, request.args ?? {});
    if (action.confirm && !request.confirmed) throw new HosError(409, `${name} needs confirmation`);
    const run = this.newRun(workspace, action, command, null, request.user);
    await this.startRun(run, action, workspace);
    return this.store.getActionRun(run.id)!;
  }

  listActionsForChat(chatId: string): BusReply {
    const { chat, workspaces } = this.chatAndWorkspaces(chatId);
    if (!workspaces.length) return { outcome: 'ok', text: NO_WORKSPACE_ACTIONS };
    const lists = workspaces.map((workspace) => ({ workspace, ...this.listActions(workspace.id) }));
    const byName = new Map<string, { action: ActionDef; homes: Workspace[] }>();
    for (const { workspace, actions } of lists) {
      for (const action of actions) {
        const seen = byName.get(action.name);
        if (seen) seen.homes.push(workspace);
        else byName.set(action.name, { action, homes: [workspace] });
      }
    }
    const lines = [...byName.values()]
      .sort((a, b) => a.action.name.localeCompare(b.action.name))
      .map(({ action, homes }) => {
        const gate = this.actionVerdict(chat, action, action.run);
        const how = gate.outcome === 'auto' ? 'runs at once' : gate.outcome === 'deny' ? 'refused for you' : `needs ${owner()}’s approval`;
        const args = action.args.length ? `; args: ${action.args.join(', ')}` : '';
        const home = homes[0] === workspaces[0] ? '' : `; in ${homes.map((w) => w.name).join(', ')}`;
        return `- ${action.name} (${action.where}, ${how}${args}${action.source === 'repo' ? '; from the repo' : ''}${home}): ${action.run}`;
      });
    const errors = [...new Set(lists.flatMap((list) => list.errors))];
    const text = [...(lines.length ? lines : ['No actions are defined for this workspace.']), ...errors.map((e) => `Skipped ${e}`)];
    return { outcome: 'ok', text: text.join('\n') };
  }

  async runActionForChat(chatId: string, name: string, args: Record<string, unknown>, ref?: string): Promise<BusReply> {
    const { chat, workspaces } = this.chatAndWorkspaces(chatId);
    if (!workspaces.length) return { outcome: 'refused', text: NO_WORKSPACE_ACTIONS };
    const workspace = ref
      ? this.workspaces.workspaceForChat(chatId, ref)
      : (workspaces.find((w) => this.listActions(w.id).actions.some((a) => a.name === name)) ?? workspaces[0]!);
    if (!workspaces.some((w) => w.id === workspace.id)) {
      return { outcome: 'refused', text: `${workspace.name} is not one of your topic's workspaces; attach it with workspace_choose first.` };
    }
    const shown = workspace.id === workspaces[0]!.id ? name : `${name} in ${workspace.name}`;
    const action = this.requireAction(workspace, name);
    const command = this.actionCommand(action, args);
    const verdict = this.actionVerdict(chat, action, command);
    if (verdict.outcome === 'deny') return { outcome: 'refused', text: `Refused: ${verdict.reason}` };
    const approvalId = randomUUID();
    const run = { ...this.newRun(workspace, action, command, chatId, `chat ${chatId.slice(0, 8)}`), approvalId };
    this.store.saveActionRun(run);
    const request = { toolUseId: run.id, tool: `action ${name}`, title: `Run action ${name}`, input: { command } };
    void this.requestApproval(chatId, request, { verdict, id: approvalId }).then(async (answer) => {
      if (this.stopped) return;
      if (answer === 'approve') await this.startRun(this.store.getActionRun(run.id)!, action, workspace);
      else this.saveRun({ ...this.store.getActionRun(run.id)!, state: 'denied', finishedAt: this.clock.now() });
    });
    if (verdict.outcome !== 'auto') {
      return { outcome: 'ok', text: `Run ${run.id} of ${shown} is waiting for ${owner()}’s approval in the Inbox (${verdict.reason}). Check it later with action_run.` };
    }
    return { outcome: 'ok', text: runText(await this.waitForRun(run.id, AGENT_WAIT_MS), shown) };
  }

  actionRunForChat(chatId: string, runId: string): BusReply {
    const { workspaces } = this.chatAndWorkspaces(chatId);
    const run = this.store.getActionRun(runId);
    if (!run || !workspaces.some((w) => w.id === run.workspaceId)) return { outcome: 'error', text: `No action run ${runId} in your workspace.` };
    return { outcome: 'ok', text: runText(run) };
  }

  getActionRun(runId: string): ActionRun {
    const run = this.store.getActionRun(runId);
    if (!run) throw new HosError(404, `no action run ${runId}`);
    return run;
  }

  async getTranscript(chatId: string): Promise<TranscriptEntry[]> {
    const chat = this.store.getChat(chatId);
    if (!chat) throw new HosError(404, `no chat ${chatId}`);
    if (chat.computer) return this.requireComputers().get(chat.computer, `/api/chats/${encodeURIComponent(chatId)}/transcript`);
    const nativeId = this.store.getChatNativeSession(chatId);
    return nativeId ? this.runtimeFor(chat).transcript(nativeId, this.sessionCwd(chat)) : [];
  }

  chatTimeline(chatId: string): TimelineItem[] {
    if (!this.store.getChat(chatId)) throw new HosError(404, `no chat ${chatId}`);
    return applyEvents(initialState, this.store.chatEvents(chatId)).timeline[chatId] ?? [];
  }

  topicHistory(): TopicHistoryFact[] {
    return this.store.topicHistoryFacts();
  }

  async listTerminals(topicId?: string): Promise<Terminal[]> {
    return (await this.tmux.list())
      .filter((session) => topicId === undefined || session.topicId === topicId)
      .map((session) => ({ ...session, chatId: this.store.chatForTerminal(session.name) ?? null }));
  }

  async killTerminal(name: string): Promise<void> {
    const terminal = (await this.listTerminals()).find((t) => t.name === name);
    if (!terminal) throw new HosError(404, `no terminal ${name}`);
    if (terminal.chatId) throw new HosError(409, `${name} is a chat's take-over terminal; hand the chat back instead`);
    if (name === LOGIN_TERMINAL || name.startsWith(`${LOGIN_TERMINAL}-`) || (await this.tmux.panes()).some((pane) => pane.session === name && pane.hosServer)) {
      throw new HosError(409, `${name} is not a plain shell; stop it from where it was started`);
    }
    await this.tmux.kill(name);
  }

  hasTerminal(name: string): Promise<boolean> {
    return this.tmux.has(name);
  }

  async createTerminal(worktreePath: string, topicId?: string): Promise<Terminal> {
    const worktree = this.store.getWorktree(worktreePath)?.snapshot;
    if (!worktree) throw new HosError(404, `no worktree ${worktreePath}`);
    const topic = topicId ? this.requireTopic(topicId) : null;
    const name = await this.freeShellName(topic ? sessionName(topic.title).slice(0, 32).replace(/-+$/, '') || 'topic' : worktree.name, topic ? 't' : 'shell');
    await this.tmux.create({
      name,
      cwd: worktree.path,
      env: { HOS_PORT: String(worktree.port) },
      ...(topic ? { topicId: topic.id } : {}),
      // The tmux server may carry a PORT from whoever started it, so unset it here.
      command: ['env', '-u', 'PORT', ...(this.options.terminalShell ? [this.options.terminalShell] : [process.env.SHELL || '/bin/sh', '-l'])],
    });
    return this.requireTerminal(name);
  }

  async loginTerminal(harnessId?: string): Promise<Terminal> {
    const harness = harnessId ? this.harnessFor(harnessId) : this.harnesses.primary;
    const { id, runtime } = harness;
    const command = runtime.loginCommand?.();
    if (!command) throw new HosError(409, `the ${id} harness has no login command`);
    const name = harness === this.harnesses.primary ? LOGIN_TERMINAL : `${LOGIN_TERMINAL}-${id}`;
    if (!(await this.tmux.has(name))) await this.tmux.create({ name, cwd: homedir(), command });
    return this.requireTerminal(name);
  }

  async takeOver(chatId: string): Promise<{ terminal: string }> {
    const chat = this.store.getChat(chatId);
    if (!chat) throw new HosError(404, `no chat ${chatId}`);
    const nativeId = this.store.getChatNativeSession(chatId);
    if (!nativeId) throw new HosError(409, `chat ${chatId} has no native session yet`);
    const harness = this.harnessFor(chat.agent);
    if (!harness.features.takeover) throw new HosError(409, `chat ${chatId} runs on ${harness.label}, which has no Take over (it names no terminal command)`);
    if (this.inTerminal.has(chatId)) throw new HosError(409, `chat ${chatId} is already in a terminal`);
    this.inTerminal.add(chatId);
    try {
      const session = this.sessions.get(chatId);
      this.sessions.delete(chatId);
      this.endSubagents(chatId);
      await session?.then((s) => s.stop()).catch(() => {});
      this.cancelApprovals(chatId);
      const cwd = this.sessionCwd(chat);
      const worktreeName = basename(this.chatCwd(chat));
      const port = this.portFor(worktreeName);
      const { brainDir } = this.options;
      const command = await this.runtimeFor(chat).terminalCommand({
        chatId,
        cwd,
        extraDirs: this.readyDirs(chat, cwd),
        env: { PORT: String(port), HOS_PORT: String(port) },
        compactAt: this.contextLimits(chatId).backstop,
        ...(brainDir ? { brainDir } : {}),
        ...(chat.model ? { model: chat.model } : {}),
        ...(chat.effort ? { effort: chat.effort } : {}),
        ...(chat.chrome ? { chrome: true } : {}),
        ...this.launchProfile(chat),
        resume: nativeId,
      });
      const terminal = await this.freeTerminalName(worktreeName, `${chat.agent}-${chatId.slice(0, 8)}`, port);
      await this.tmux.create({
        name: terminal,
        cwd,
        env: { PORT: String(port), HOS_PORT: String(port) },
        command,
        topicId: chat.topicId,
      });
      this.record({ type: 'chat.takeover', chatId, terminal }, () => this.store.setChatTerminal(chatId, terminal));
      this.setState(chatId, 'terminal');
      return { terminal };
    } catch (error) {
      if (!this.store.getChatTerminal(chatId)) this.inTerminal.delete(chatId);
      throw error instanceof HosError ? error : new HosError(500, `could not take over chat ${chatId}: ${(error as Error).message}`);
    }
  }

  async handBack(chatId: string): Promise<void> {
    if (!this.store.getChat(chatId)) throw new HosError(404, `no chat ${chatId}`);
    const terminal = this.store.getChatTerminal(chatId);
    if (!terminal) throw new HosError(409, `chat ${chatId} is not taken over`);
    await this.tmux.kill(terminal);
    this.record({ type: 'chat.handback', chatId, terminal }, () => this.store.setChatTerminal(chatId, null));
    this.inTerminal.delete(chatId);
    this.setState(chatId, 'idle');
  }

  async search(topicId: string, query: string): Promise<SearchHit[]> {
    const topic = this.store.getTopic(topicId);
    if (!topic) throw new HosError(404, `no topic ${topicId}`);
    const words = searchWords(query);
    if (!words.length) return [];
    const indexed = this.store
      .search(topicId, ftsQuery(words), { limit: SEARCH_LIMIT })
      .map((row): SearchHit => ({ source: 'event', title: `chat ${row.chatId!.slice(0, 8)} · #${row.key}`, snippet: row.snippet, chatId: row.chatId! }));
    const { brainDir } = this.options;
    const workDir = this.workDirAbs(topic);
    const files = brainDir && workDir ? await searchWork(brainDir, workDir, words, SEARCH_LIMIT) : [];
    return [...indexed, ...files];
  }

  decideApproval(approvalId: string, decision: string, origin: DecisionOrigin): void {
    if (origin.chatId !== undefined) throw new HosError(403, `only ${owner()} can decide an approval; chats cannot`);
    if (!DECISIONS.includes(decision as ApprovalDecision)) {
      throw new HosError(400, `decision must be one of ${DECISIONS.join(', ')}`);
    }
    const approval = this.store.getApproval(approvalId);
    if (!approval) throw new HosError(404, `no approval ${approvalId}`);
    if (approval.decision) throw new HosError(409, `approval ${approvalId} is already ${approval.decision}`);
    this.record({ type: 'approval.resolved', chatId: approval.chatId, approvalId, decision: decision as ApprovalDecision }, () => {
      this.store.decideApproval(approvalId, decision as ApprovalDecision, this.clock.now(), origin.via, origin.user);
    });
    this.settle(approvalId, decision === 'deny' ? 'deny' : 'approve');
  }

  listApprovals(): Approval[] {
    return this.store.listApprovals();
  }

  listInbox(): InboxItem[] {
    const approvals = this.store.openApprovals().map(
      (approval): InboxItem => ({
        id: approval.id,
        kind: 'approval',
        chatId: approval.chatId,
        ...(approval.topicId ? { topicId: approval.topicId } : {}),
        ...(approval.workspaceId ? { workspaceId: approval.workspaceId } : {}),
        title: approval.tool,
        detail: approval.input,
        state: 'open',
        createdAt: approval.createdAt,
        actionClass: approval.actionClass,
      }),
    );
    return [...approvals, ...this.store.openInboxItems()].sort((a, b) => b.createdAt - a.createdAt);
  }

  answerQuestion(itemId: string, answers: Record<string, string>, origin: DecisionOrigin): void {
    if (origin.chatId !== undefined) throw new HosError(403, `only ${owner()} can answer a question; chats cannot`);
    const item = this.openItem(itemId);
    if (item.handoff) return this.answerHandoff(item, Object.values(answers)[0]);
    if (item.kind !== 'question') throw new HosError(400, `inbox item ${itemId} is not a question`);
    if (item.picker) throw new HosError(400, `inbox item ${itemId} is a workspace picker; answer it with POST /api/inbox/${itemId}/pick`);
    const unanswered = (item.questions ?? []).find((q) => !answers[q.question]?.trim());
    if (unanswered) throw new HosError(400, `question "${unanswered.question}" has no answer`);
    const chosen = (item.questions ?? []).map((q) => answers[q.question]);
    this.saveInbox({ ...item, state: 'done', ...(chosen.length ? { resolution: `Answered: ${chosen.join(', ')}` } : {}) });
    this.settle(itemId, { answers });
    if (item.parked && item.chatId) {
      const lines = (item.questions ?? []).map((q) => `${q.question} → ${answers[q.question]}`);
      void this.deliverLater(item.chatId, [`[hos] ${ownerStart()} answered your question:`, ...lines].join('\n'), 0).catch(() => {});
    }
  }

  dismissInboxItem(itemId: string): void {
    const item = this.openItem(itemId);
    if (item.handoff) return this.answerHandoff(item, undefined);
    const question = item.kind === 'question';
    this.saveInbox({ ...item, state: 'done', ...(question ? { resolution: 'Skipped' } : {}) });
    this.settle(itemId, question ? { deny: questionsSkipped() } : 'deny');
    if (item.parked && item.chatId) {
      const text = `[hos] ${ownerStart()} dismissed your question "${item.detail}" without answering. Don't treat that as approval; carry on only with what needs no decision, or stop.`;
      void this.deliverLater(item.chatId, text, 0).catch(() => {});
    }
  }

  recover(): void {
    this.ensureDesk();
    this.backfillWorkDirs();
    for (const chatId of this.store.chatsInTerminals()) this.inTerminal.add(chatId);
    for (const approval of this.store.openApprovals()) {
      this.record({ type: 'approval.resolved', chatId: approval.chatId, approvalId: approval.id, decision: 'cancelled' }, () =>
        this.store.decideApproval(approval.id, 'cancelled', this.clock.now(), 'system', null),
      );
    }
    for (const item of this.store.openInboxItems()) {
      if (item.kind === 'question' && !item.parked && !item.handoff) this.saveInbox({ ...item, state: 'done', resolution: 'Cancelled: hos restarted' });
    }
    this.store.requeueTakenTurns();
    for (const chat of this.store.chatsInState(['starting', 'running'])) {
      this.store.setChatInterrupted(chat.id, true);
      this.setState(chat.id, 'idle');
    }
    for (const [toolUseId, subagent] of Object.entries(this.uiSnapshot().state.subagents)) {
      if (subagent.status === 'running') this.record({ type: 'subagent.finished', chatId: subagent.chatId, toolUseId, status: 'stopped', summary: '' });
    }
    for (const chatId of Object.keys(this.uiSnapshot().state.refreshing)) this.record({ type: 'context.refresh_failed', chatId, problems: ['hos restarted'] });
    this.noticeEndedShells();
    for (const run of this.store.actionRunsIn(['pending', 'running'])) {
      if (run.state === 'running' && run.terminal) {
        const terminal = run.terminal;
        const [log, exit] = this.runFiles(run.id);
        this.saveRun({ ...run, output: '' });
        const execution = followLog(log, exit, () => this.tmux.has(terminal), (text) => this.actionOutput(run.id, text));
        this.executions.set(run.id, execution);
        void execution.done.then((code) => this.finishRun(run.id, code));
        continue;
      }
      const note = run.state === 'pending' ? 'hos restarted before this run was approved' : 'hos restarted while this ran';
      this.saveRun({ ...run, state: 'failed', output: `${run.output}${note}\n`, finishedAt: this.clock.now() });
    }
    for (const chatId of this.store.chatsWithHandoffDue()) this.whenQuiet(chatId);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.saveUi();
    if (this.options.policyFile) unwatchFile(this.options.policyFile, this.policyChanged);
    this.keeper.stop();
    this.cancelRefresh?.();
    this.servers.unwatch();
    this.cancelNotices?.();
    this.cancelSweep?.();
    this.brainCommits?.stop();
    for (const execution of this.executions.values()) execution.stop();
    await Promise.allSettled(this.lifecycleWork);
    await this.queue;
    const sessions = await Promise.allSettled(this.sessions.values());
    await Promise.all(sessions.map((s) => (s.status === 'fulfilled' ? s.value.stop() : undefined)));
    this.sessions.clear();
    for (const harness of this.harnesses.all()) harness.runtime.dispose?.();
    await this.diagrams?.flush();
    await this.brainCommits?.settled();
    this.listeners.clear();
  }

  chatTopic(chatId: string): Topic {
    return this.store.getTopic(this.requireChat(chatId).topicId)!;
  }

  snagContext(topicId: string, chatId?: string): string | null {
    const topic = this.store.getTopic(topicId);
    if (!topic) return null;
    const parts = [`topic "${clipped(topic.title)}" (${topic.id.slice(0, 8)})`];
    const chat = chatId ? this.store.getChat(chatId) : undefined;
    if (chat?.topicId === topic.id) {
      parts.push(`chat ${chat.id.slice(0, 8)}`);
      const card = this.store.chatBusState(chat.id).card;
      if (card) parts.push(`card: ${clipped(card)}`);
      const asks = this.store
        .chatMessages(chat.id, undefined, SNAG_CONTEXT_SCAN)
        .flatMap(({ body }) => (body.type === 'message.user' ? [`"${clipped(body.text)}"`] : []))
        .slice(0, 2)
        .reverse();
      if (asks.length) parts.push(`last asks: ${asks.join(' / ')}`);
    }
    return parts.join(' · ').slice(0, SNAG_CONTEXT_CHARS);
  }

  noteChat(chatId: string, text: string): void {
    if (this.store.getChat(chatId)) this.store.insertNotice(chatId, text, this.clock.now(), false);
  }

  async createDiagram(title?: string, topicId?: string): Promise<DiagramInfo> {
    const diagrams = this.requireDiagrams();
    const given = title?.trim();
    if (topicId) {
      const topic = this.requireTopic(topicId);
      return diagrams.create(given || `${topic.title} · Diagram ${diagrams.linked(topic.id).length + 1}`, topic.id, !given);
    }
    const named = given || `Diagram ${(await diagrams.list()).length + 1}`;
    const topic = await this.createTopic({ title: named });
    return diagrams.create(named, topic.id, !given);
  }

  async renameDiagram(id: string, title: string): Promise<DiagramInfo> {
    const next = title.trim();
    if (!next) throw new HosError(400, 'a diagram needs a title');
    const diagrams = this.requireDiagrams();
    const before = await diagrams.info(id);
    const topic = this.store.getTopic(before.topic);
    const renamed = await diagrams.rename(id, next);
    if (topic && topic.title === before.title && topic.title !== next) this.renameTopic(topic.id, next);
    return renamed;
  }

  private nameDiagram(id: string, text: string): void {
    const diagrams = this.requireDiagrams();
    void diagrams
      .info(id)
      .then(async (before) => {
        await diagrams.stopNaming(id);
        const title = await this.suggestTitle(text.replace(/^\[diagram [^\]]*\]\s*/, ''));
        if (this.stopped || !title || (await diagrams.info(id)).title !== before.title) return;
        await this.renameDiagram(id, title);
      })
      .catch((error) => console.error('diagram naming failed', error));
  }

  private requireDiagrams(): Diagrams {
    if (!this.diagrams) throw new HosError(400, 'hos has no brain (start it with --brain), so there is nowhere to keep diagrams');
    return this.diagrams;
  }

  health(transport: DoctorReport): Promise<StatusItem[]> {
    return this.keeper.health(transport, this.machine, this.windows);
  }

  async doctor(transport: DoctorReport): Promise<StatusItem[]> {
    const validate = validateCommand(this.options.brainDir);
    const profiles = this.profiles().problems.map(
      ({ file, problem }): StatusItem => ({ id: `profile:${file}`, label: `Profile ${file}`, status: 'warn', detail: problem, fix: `fix the brain's ${file}, then run ${validate}` }),
    );
    return [...(await this.keeper.doctor(transport)), ...profiles];
  }

  governorStatus(): GovernorStatus {
    const now = this.clock.now();
    const limits = this.options.governorLimits;
    const since = now - 24 * HOUR;
    const ledger = this.store.ledgerSince(since);
    const sum = <K extends 'topicId' | 'agent'>(key: K) => {
      const totals = new Map<string, number>();
      for (const row of ledger) totals.set(row[key], (totals.get(row[key]) ?? 0) + row.tokens);
      return [...totals].map(([id, tokens]) => ({ id, tokens })).sort((a, b) => b.tokens - a.tokens);
    };
    return {
      slots: Object.fromEntries(Object.entries(this.slotLimits()).map(([pool, max]) => [pool, { running: this.runningIn(pool, ''), max }])),
      queue: dispatchOrder(this.store.queuedChats(), now, (id) => this.served.get(id) ?? 0).map(
        (entry) => ({
          ...entry,
          effectivePriority: effectivePriority(entry.priority, now - entry.since),
          reason: this.holds.get(entry.chatId) ?? 'waiting for a running chat to finish',
        }),
      ),
      windows: { ...this.windows, step: windowStep(this.windows, limits), peak: inPeak(now, limits.peak) },
      machine: this.machine,
      ledger: {
        chats: ledger,
        topics: sum('topicId').map(({ id, tokens }) => ({ topicId: id, tokens })),
        providers: sum('agent').map(({ id, tokens }) => ({ agent: id, tokens })),
      },
    };
  }

  private expireKeeperAlerts(now: number): void {
    const onPower = this.machine !== null && !this.machine.battery?.onBattery;
    for (const item of this.store.openInboxItems()) {
      if (item.kind !== 'keeper') continue;
      const ended = (onPower && BATTERY_ALERTS.includes(item.title)) || (INFO_ALERTS.includes(item.title) && now - item.createdAt >= INFO_ALERT_MS);
      if (ended) this.saveInbox({ ...item, state: 'done' });
    }
  }

  private async governorTick(): Promise<void> {
    const now = this.clock.now();
    this.machine = await this.sensors.machine.sample().catch(() => this.machine);
    await this.keeper.tick(this.machine);
    this.expireKeeperAlerts(now);
    if (now - this.lastUsagePoll >= USAGE_POLL_MS) {
      this.lastUsagePoll = now;
      const usage = await this.harnesses.primary.runtime.usage?.().catch(() => undefined);
      if (usage) this.windows = { fiveHour: usage.fiveHour ?? this.windows.fiveHour, weekly: usage.weekly ?? this.windows.weekly };
    }
    for (const key of ['fiveHour', 'weekly'] as const) {
      const resetsAt = this.windows[key]?.resetsAt;
      if (resetsAt && resetsAt <= now) this.windows = { ...this.windows, [key]: null };
    }
    this.resumeAfterLimit(now);
    this.notifyBatchPause();
    await this.suspendIdle();
    this.pump();
    if (this.options.webOrigin && !this.bus.codeViewBase) {
      const origin = await this.options.webOrigin().catch(() => null);
      if (origin) this.bus.codeViewBase = `${origin}${CODE_VIEW_BASE_PATH}`;
    }
    void this.schedules?.tick().catch((error) => console.error('schedules tick failed', error));
  }

  private onTokensUsed(chatId: string, event: Extract<AgentEvent, { type: 'tokens.used' }>): void {
    const chat = this.store.getChat(chatId)!;
    const tokens = event.input + event.output + event.cacheCreation;
    const entry = { chatId, topicId: chat.topicId, agent: chat.agent, model: event.model, tokens, cacheRead: event.cacheRead };
    this.record({ type: 'tokens.used', ...entry }, () =>
      this.store.insertLedger({ ...entry, input: event.input, output: event.output, cacheCreation: event.cacheCreation, at: this.clock.now() }),
    );
  }

  private onCreditsUsed(chatId: string, credits: number): void {
    const chat = this.store.getChat(chatId)!;
    this.store.insertLedger({ chatId, topicId: chat.topicId, agent: chat.agent, model: chat.model ?? null, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, tokens: 0, credits, at: this.clock.now() });
  }

  private onProviderLimit(window: 'five_hour' | 'seven_day', pct: number, resetsAt: number | null): void {
    const key = window === 'five_hour' ? 'fiveHour' : 'weekly';
    this.windows = { ...this.windows, [key]: { pct, resetsAt } };
    this.notifyBatchPause();
    this.pump();
  }

  private planLimitResume(chatId: string, limit: { resetsAt: number | null } | undefined): boolean {
    const key = LIMIT_RESUME_META + chatId;
    if (!limit) {
      this.store.deleteMeta(key);
      return false;
    }
    const now = this.clock.now();
    const at = limit.resetsAt ?? this.limitedWindowReset();
    this.store.setMeta(key, String(at && at > now ? at : now + LIMIT_RETRY_MS));
    return true;
  }

  private limitedWindowReset(): number | null {
    const resets = [this.windows.fiveHour, this.windows.weekly].flatMap((window) => (window && window.pct >= 100 && window.resetsAt ? [window.resetsAt] : []));
    return resets.length ? Math.max(...resets) : null;
  }

  private resumeAfterLimit(now: number): void {
    for (const { chatId, at } of this.store.limitResumes()) {
      if (at > now) continue;
      this.store.deleteMeta(LIMIT_RESUME_META + chatId);
      const chat = this.store.getChat(chatId);
      if (!chat || chat.state !== 'failed' || this.inTerminal.has(chatId) || this.killSwitchFor(chat.topicId)) continue;
      if (this.store.getTopic(chat.topicId)!.state === 'archived') continue;
      for (const item of this.store.openInboxItems(chatId)) {
        if (item.kind === 'failure') this.saveInbox({ ...item, state: 'done', resolution: 'Resumed after the Claude limit reset' });
      }
      this.background(chatId, () =>
        this.submit(chat, { text: LIMIT_RESUMED, from: 'hos' }, chat.priority).then(
          () => {},
          (error: unknown) => this.salvage(chatId, `the Claude limit reset but the session could not resume: ${error instanceof Error ? error.message : String(error)}`),
        ),
      );
    }
  }

  private notifyBatchPause(): void {
    const limits = this.options.governorLimits;
    if (windowStep(this.windows, limits) !== 'pause_batch') {
      this.batchPauseNotified = false;
      return;
    }
    const batch = this.store.chatsInState([...LIVE_STATES]).find((chat) => chat.priority === BATCH_PRIORITY);
    if (this.batchPauseNotified || !batch) return;
    this.batchPauseNotified = true;
    const resetsAt = this.windows.fiveHour?.resetsAt;
    const zone = limits.peak?.timezone ?? 'UTC';
    const when = resetsAt
      ? new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(new Date(resetsAt))
      : 'the window resets';
    const pct = Math.round(this.windows.fiveHour?.pct ?? 0);
    this.addInbox(batch.id, 'alert', 'Batch work paused', `Claude's 5-hour window is at ${pct}%, so batch work is paused; it resumes after ${when}.`);
  }

  private async suspendIdle(): Promise<void> {
    const now = this.clock.now();
    const minutes = this.options.governorLimits.idleSuspendMinutes;
    const critical = this.machine?.memory === 'critical';
    if (!minutes && !critical) return;
    for (const chatId of [...this.sessions.keys()]) {
      const chat = this.store.getChat(chatId);
      if (!chat || !SUSPENDABLE.has(chat.state) || this.dispatched.has(chatId) || this.inTerminal.has(chatId)) continue;
      if (!critical && (this.liveSubagents.has(chatId) || this.liveShells.has(chatId) || now - (this.lastActive.get(chatId) ?? now) < minutes * MINUTE)) continue;
      const session = this.sessions.get(chatId);
      this.sessions.delete(chatId);
      this.endSubagents(chatId);
      this.record({ type: 'chat.suspended', chatId, suspended: true }, () => this.store.setChatSuspended(chatId, true));
      await session?.then((s) => s.stop()).catch(() => {});
    }
  }

  private killSwitchFor(topicId: string): string | null {
    const switches = this.store.killSwitches();
    if (switches.some((s) => s.scope === 'global')) return 'global';
    if (switches.some((s) => s.scope === 'topic' && s.topicId === topicId)) return 'topic';
    return null;
  }

  private deliver(
    chatId: string,
    session: AgentSession,
    message: Delivery,
    write?: () => void,
  ): void {
    this.record({ type: 'message.user', chatId, messageId: randomUUID(), ...message }, write);
    session.send(message.text);
  }

  private async deliverLater(chatId: string, text: string, priority?: number, canvas?: string): Promise<void> {
    const chat = this.store.getChat(chatId)!;
    await this.submit(chat, { text, from: 'hos', ...(canvas ? { canvas } : {}) }, priority ?? chat.priority);
  }

  private isRunning(chat: Chat): boolean {
    return chat.state === 'running' || chat.state === 'handing_off' || chat.state === 'starting' || this.dispatched.has(chat.id);
  }

  private async submit(chat: Chat, message: Delivery, priority: number, write?: () => void): Promise<'sent' | 'queued'> {
    if (chat.computer) {
      await this.requireComputers().deliver(chat.computer, { chatId: chat.id, text: message.text, ...(message.fromChatId ? { fromChatId: message.fromChatId } : {}) });
      write?.();
      return 'sent';
    }
    const running = this.isRunning(chat) && chat.state !== 'starting';
    if (chat.state !== 'queued' && (running || !this.holdFor(chat, priority))) {
      if (!running) this.markDispatched(chat);
      try {
        const session = await (this.sessions.get(chat.id) ?? this.resumeSession(chat));
        this.deliver(chat.id, session, message, write);
      } catch (error) {
        this.dispatched.delete(chat.id);
        throw error;
      }
      return 'sent';
    }
    this.record({ type: 'message.user', chatId: chat.id, messageId: randomUUID(), ...message }, () => {
      write?.();
      this.store.enqueueTurn(chat.id, message.text, priority, this.clock.now());
    });
    if (chat.state !== 'queued') this.setState(chat.id, 'queued');
    this.pump();
    return this.store.getChat(chat.id)!.state === 'queued' && !this.dispatched.has(chat.id) ? 'queued' : 'sent';
  }

  private pool(chat: Chat): string {
    return this.harnesses.get(chat.agent)?.pool ?? chat.agent;
  }

  private slotLimits(): Record<string, number> {
    const running = { ...this.options.governorLimits.running };
    for (const harness of this.harnesses.all()) running[harness.pool] ??= harness.slots;
    return running;
  }

  private harnessFor(agent: string): Harness {
    const harness = this.harnesses.get(agent);
    if (!harness) throw new HosError(409, `the ${agent} harness is not installed`);
    return harness;
  }

  private runtimeFor(chat: Chat): AgentRuntime {
    return this.harnessFor(chat.agent).runtime;
  }

  private runningIn(pool: string, except: string): number {
    const ids = new Set([...this.store.chatsInState(['starting', 'running', 'handing_off']).map((c) => c.id), ...this.dispatched]);
    ids.delete(except);
    return [...ids].filter((id) => {
      const chat = this.store.getChat(id);
      return chat && this.pool(chat) === pool;
    }).length;
  }

  private parentsIn(pool: string): Chat[] {
    const live = this.store.chatsInState([...LIVE_STATES]);
    const parentIds = new Set(live.map((c) => c.parentId));
    return live.filter((c) => (c.profile === 'lead' || parentIds.has(c.id)) && this.pool(c) === pool);
  }

  private freeSlots(pool: string): number {
    const max = this.slotLimits()[pool] ?? 0;
    const waiting = this.parentsIn(pool).filter((c) => !this.isRunning(c)).length;
    return Math.max(0, max - this.runningIn(pool, '') - parentReserve(waiting, max));
  }

  private holdFor(chat: Chat, priority: number): string | null {
    if (this.killSwitchFor(chat.topicId)) return `the ${this.killSwitchFor(chat.topicId)} kill switch is on`;
    const limits = this.options.governorLimits;
    const pool = this.pool(chat);
    const parents = this.parentsIn(pool);
    return holdReason(
      {
        priority,
        pool,
        running: this.runningIn(pool, chat.id),
        parent: parents.some((c) => c.id === chat.id),
        reserved: parents.filter((c) => c.id !== chat.id && !this.isRunning(c)).length,
        windows: this.windows,
        peak: inPeak(this.clock.now(), limits.peak),
        machine: this.machine,
      },
      { ...limits, running: this.slotLimits() },
    );
  }

  private pump(): void {
    if (this.stopped) return;
    const now = this.clock.now();
    const order = dispatchOrder(this.store.queuedChats(), now, (topicId) => this.served.get(topicId) ?? 0);
    for (const entry of order) {
      const chat = this.store.getChat(entry.chatId)!;
      const reason = this.holdFor(chat, entry.priority);
      if (!reason) {
        this.store.extendTtl(chat.id, now - entry.since);
        this.dispatch(chat);
        continue;
      }
      if (this.holds.get(chat.id) === reason) continue;
      this.holds.set(chat.id, reason);
      this.record({ type: 'chat.queued', chatId: chat.id, priority: effectivePriority(entry.priority, now - entry.since), reason });
    }
  }

  private dispatch(chat: Chat): void {
    const texts = this.store.takeQueuedTurns(chat.id);
    this.holds.delete(chat.id);
    this.markDispatched(chat);
    void (this.sessions.get(chat.id) ?? this.resumeSession(chat)).then(
      (session) => {
        for (const text of texts) session.send(text);
      },
      () => {
        this.dispatched.delete(chat.id);
        this.store.dropQueuedTurns(chat.id, true);
        this.setState(chat.id, 'failed');
      },
    );
  }

  private markDispatched(chat: Chat): void {
    this.dispatched.add(chat.id);
    this.served.set(chat.topicId, (this.served.get(chat.topicId) ?? 0) + 1);
  }

  private spawnModel(role: SpawnRole): string | null {
    const pct = this.windows.fiveHour?.pct ?? 0;
    const cheaper = this.options.governorLimits.fiveHourSteps.some((step) => step.effect === 'cheaper_models' && pct >= step.atPct);
    if (!cheaper || role === 'main') return null;
    return role === 'worker' || role === 'reviewer' ? CHEAPER_WORKER_MODEL : CHEAPER_SCOUT_MODEL;
  }

  private subtree(root: Chat): Chat[] {
    return [root, ...this.store.childrenOf(root.id).flatMap((child) => this.subtree(child))];
  }

  private async halt(chatId: string, state: 'paused' | 'killed' | 'archived'): Promise<void> {
    const computer = this.chatComputer(chatId);
    if (computer && this.computers) {
      void this.computers.post(computer, `/api/chats/${encodeURIComponent(chatId)}/stop`, {}).catch((error: Error) => console.error(`stopping chat ${chatId} on ${computer} failed: ${error.message}`));
      return;
    }
    const session = this.sessions.get(chatId);
    this.sessions.delete(chatId);
    this.endSubagents(chatId);
    this.dispatched.delete(chatId);
    this.holds.delete(chatId);
    this.store.dropQueuedTurns(chatId);
    this.setState(chatId, state);
    this.cancelApprovals(chatId);
    await session?.then((s) => s.stop()).catch(() => {});
  }

  private async isPingPong(sender: Chat, target: Chat): Promise<boolean> {
    const topic = this.store.getTopic(sender.topicId)!;
    const tree = await snapshotTree(this.place(topic).path).catch(() => '');
    const mark = `${this.store.progressMark(topic.id)}:${tree}`;
    const key = [sender.id, target.id].sort().join(':');
    const previous = this.pairs.get(key);
    const count = previous?.mark === mark ? previous.count + (previous.last === sender.id ? 0 : 1) : 1;
    this.pairs.set(key, { last: sender.id, count, mark });
    return count >= PING_PONG_ROUND_TRIPS * 2;
  }

  private freezePair(a: Chat, b: Chat): void {
    this.pairs.delete([a.id, b.id].sort().join(':'));
    void this.halt(a.id, 'paused');
    void this.halt(b.id, 'paused');
    const detail = `Chats ${a.id.slice(0, 8)} (${a.role}) and ${b.id.slice(0, 8)} (${b.role}) traded ${PING_PONG_ROUND_TRIPS} round-trips of messages with no artifact or diff change. Both are paused; message either one to resume it.`;
    this.addInbox(a.id, 'alert', 'Ping-pong frozen', detail);
  }

  private async flushNotices(): Promise<void> {
    await this.expireChats();
    this.expireLocks();
    this.tasks.flagOverdue();
    for (const chatId of this.store.chatsWithWakingNotices()) {
      const chat = this.store.getChat(chatId)!;
      if (!NOTICE_STATES.has(chat.state) || this.inTerminal.has(chatId) || this.killSwitchFor(chat.topicId)) continue;
      const batch = this.store.pendingNotices(chatId).slice(0, NOTICES_PER_TURN);
      const text = [noticeHeader(owner()), ...batch.map((notice) => `- ${notice.text}`)].join('\n');
      await this.submit(chat, { text, from: 'hos' }, chat.priority, () =>
        this.store.markNoticesDelivered(
          batch.map((notice) => notice.id),
          this.clock.now(),
        ),
      ).catch(() => undefined);
    }
  }

  private expireLocks(): void {
    const now = this.clock.now();
    for (const lock of this.locks.expire()) {
      this.store.insertNotice(lock.chatId, `your lock on ${lock.pattern} expired with no tool or bus call from you; lock it again before you edit there`, now, false);
    }
  }

  private async expireChats(): Promise<void> {
    const now = this.clock.now();
    for (const chat of this.store.chatsWithDeadline(now)) {
      if (!isLive(chat.state) || chat.state === 'queued' || this.inTerminal.has(chat.id)) continue;
      const { ttlDeadline, ttlStage } = this.store.spawnMeta(chat.id);
      if (ttlStage === 0) {
        this.store.setTtlStage(chat.id, 1);
        const text = `[hos] Your time limit has passed. Call complete now with what you have; in ${TTL_GRACE_MS / MINUTE} minutes hos stops you.`;
        await this.deliverLater(chat.id, text).catch(() => {});
      } else if (ttlStage === 1 && now >= ttlDeadline! + TTL_GRACE_MS) {
        this.store.setTtlStage(chat.id, 2);
        await this.halt(chat.id, 'killed');
        if (chat.parentId) this.store.insertNotice(chat.parentId, `chat ${chat.id.slice(0, 8)} (${chat.role}) was stopped at its time limit without completing`, now, true, chat.id);
      }
    }
  }

  private async freeTerminalName(worktreeName: string, app: string, port: number): Promise<string> {
    const taken = new Set((await this.tmux.list()).map((session) => session.name));
    for (let i = 1; ; i++) {
      const name = sessionName(`${worktreeName}-${i === 1 ? app : `${app}${i}`}-${port}`);
      if (!taken.has(name)) return name;
    }
  }

  private async freeShellName(prefix: string, kind: 't' | 'shell'): Promise<string> {
    const taken = new Set((await this.tmux.list()).map((session) => session.name));
    for (let i = 1; ; i++) {
      // A bare trailing number would read as a port in servers.ts namePort.
      const name = sessionName(`${prefix}-${kind === 't' ? `t${i}` : i === 1 ? 'shell' : `shell${i}`}`);
      if (!taken.has(name)) return name;
    }
  }

  private async requireTerminal(name: string): Promise<Terminal> {
    const terminal = (await this.listTerminals()).find((t) => t.name === name);
    if (!terminal) throw new HosError(500, `tmux did not report the session ${name}`);
    return terminal;
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => {});
    return result;
  }

  private ensureProject(path: string, createdBy: Creator, key: string | null, pinned: boolean): Project {
    const existing = this.store.findProjectByPath(path);
    const name = key ?? basename(path);
    if (createdBy !== 'system') this.store.setDismissedProjectPaths(this.store.dismissedProjectPaths().filter((p) => p !== path));
    if (!existing) {
      const project: Project = {
        id: randomUUID(),
        name,
        path,
        key,
        pinned,
        hidden: false,
        custom: false,
        brain: !!this.options.brainDir && path === realOr(this.options.brainDir),
        createdBy,
        createdAt: this.clock.now(),
      };
      this.record({ type: 'project.created', project }, () => this.store.insertProject(project));
      return project;
    }
    if (createdBy === 'human') return existing.hidden ? this.saveProject({ ...existing, hidden: false }) : existing;
    if (existing.key === key && (existing.custom || existing.pinned === pinned)) return existing;
    return this.saveProject(existing.custom ? { ...existing, key } : { ...existing, name, key, pinned });
  }

  private saveProject(project: Project): Project {
    this.record({ type: 'project.updated', project }, () => this.store.updateProject(project));
    return project;
  }

  private pruneGoneProjects(): void {
    const workspaces = this.store.listWorkspaces({ archived: true });
    for (const project of this.store.listProjects()) {
      if (project.pinned || existsSync(project.path)) continue;
      const own = workspaces.filter((w) => w.projectId === project.id);
      if (own.some((w) => this.store.topicsUsing(w.id).length > 0)) continue;
      for (const w of own) this.record({ type: 'workspace.deleted', workspaceId: w.id }, () => this.store.deleteWorkspace(w.id));
      this.record({ type: 'project.removed', projectId: project.id }, () => this.store.deleteProject(project.id));
    }
  }

  private async refreshProject(project: Project): Promise<void> {
    const entries = await listWorktrees(project.path);
    if (!entries) return;
    const watched = this.watchedPaths();
    const worktrees = await mapLimit(entries, 4, async (entry, i): Promise<Worktree> => {
      const record = this.store.getWorktree(entry.path);
      const previous = record?.snapshot;
      const name = basename(entry.path);
      const status =
        previous && !watched.has(entry.path)
          ? { dirty: previous.dirty, upstream: previous.upstream, ahead: previous.ahead, behind: previous.behind, unpushed: previous.unpushed }
          : await worktreeStatus(entry.path, entry.branch);
      return {
        path: entry.path,
        projectId: project.id,
        name,
        main: i === 0,
        branch: entry.branch,
        head: entry.head,
        ...status,
        port: this.portFor(name),
        chatIds: this.store.chatIdsInWorktree(entry.path),
        createdBy: record?.createdBy ?? 'system',
        createdByChat: record?.createdByChat ?? null,
      };
    });
    for (const worktree of worktrees) this.saveSnapshot(worktree);
    const live = new Set(entries.map((e) => e.path));
    for (const gone of this.store.listWorktrees(project.id).filter((w) => !live.has(w.path))) {
      this.record({ type: 'worktree.removed', projectId: project.id, path: gone.path }, () =>
        this.store.deleteWorktree(gone.path),
      );
    }
  }

  private refreshWorktrees(paths: Iterable<string>): Promise<void> {
    return this.exclusive(async () => {
      await mapLimit([...new Set(paths)], 4, async (path) => {
        const previous = this.store.getWorktree(path)?.snapshot;
        if (!previous || !existsSync(path)) return;
        const state = await worktreeStatus(path, previous.branch);
        this.saveSnapshot({ ...previous, ...state, chatIds: this.store.chatIdsInWorktree(path) });
      });
    });
  }

  private watchedPaths(): Set<string> {
    const paths = new Set<string>();
    for (const topic of this.store.listTopics()) {
      if (topic.state === 'archived' || topic.state === 'done') continue;
      for (const id of topic.workspaceIds) {
        const workspace = this.store.getWorkspace(id);
        if (workspace && workspace.archivedAt === null) paths.add(workspace.path);
      }
    }
    return paths;
  }

  private saveSnapshot(worktree: Worktree): void {
    if (JSON.stringify(worktree) === JSON.stringify(this.store.getWorktree(worktree.path)?.snapshot)) return;
    this.record({ type: 'worktree.updated', worktree }, () => this.store.saveWorktree(worktree));
  }

  private portFor(worktreeName: string): number {
    const { from, to } = this.options.ports;
    let hash = 0x811c9dc5;
    for (const byte of Buffer.from(worktreeName)) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
    const size = to - from + 1;
    for (let step = 0; step < size; step++) {
      const port = from + ((hash + step) % size);
      if (!AIRPLAY_PORTS.has(port)) return port;
    }
    return from + (hash % size);
  }

  private async diff(workspaceId: string, chatId: string | null, from: string, to: string | undefined, path: string): Promise<Diff> {
    const now = to ?? (await snapshotTree(path));
    const head = (await resolveCommit(path, 'HEAD')) ?? EMPTY_TREE;
    const [files, patch, local] = await Promise.all([
      changedFiles(path, from, now),
      patchBetween(path, from, now),
      to ? [] : changedFiles(path, head, now),
    ]);
    const uncommitted = new Set(local.map((file) => file.path));
    return {
      workspaceId,
      chatId,
      files: files.map((file) => ({ ...file, uncommitted: uncommitted.has(file.path) })),
      patch,
    };
  }

  private async humanAction(
    workspace: Workspace,
    action: DiffAction,
    label: string,
    command: string,
    run: () => Promise<string>,
  ): Promise<DiffActionResult> {
    this.requireSetupReady(workspace);
    const { brainDir, policy } = this.options;
    const verdict = evaluate(policy, 'Bash', { command }, {
      cwd: workspace.path,
      roots: [workspace.path],
      ...(brainDir ? { brainDir } : {}),
    });
    const topicId = this.store.topicsUsing(workspace.id).find((t) => t.state !== 'archived')?.id;
    const approval: Approval = {
      id: randomUUID(),
      chatId: null,
      topicId: topicId ?? null,
      workspaceId: workspace.id,
      tool: label,
      input: summarize(command),
      actionClass: verdict.actionClass,
      outcome: verdict.outcome,
      reason: verdict.reason,
      decision: null,
      via: null,
      decidedBy: null,
      createdAt: this.clock.now(),
      decidedAt: null,
    };
    if (verdict.outcome === 'auto' || verdict.outcome === 'deny') {
      const decision = verdict.outcome === 'auto' ? 'approve' : 'deny';
      this.record(
        { type: 'approval.policy', chatId: null, ...(topicId ? { topicId } : {}), workspaceId: workspace.id, approvalId: approval.id, tool: label, actionClass: verdict.actionClass, decision, reason: verdict.reason },
        () => this.store.insertApproval({ ...approval, decision, via: 'policy', decidedAt: approval.createdAt }),
      );
      if (decision === 'deny') throw new HosError(403, verdict.reason);
      return { action, state: 'done', detail: await this.runAction(workspace, action, run) };
    }
    this.pending.set(approval.id, (decision) => {
      if (decision === 'deny') {
        this.record({ type: 'diff.action', workspaceId: workspace.id, action, state: 'denied', detail: `${label} was denied`, approvalId: approval.id });
      } else {
        this.runAction(workspace, action, run, approval.id).catch(() => {});
      }
    });
    this.record(
      {
        type: 'approval.requested',
        chatId: null,
        ...(topicId ? { topicId } : {}),
        workspaceId: workspace.id,
        approvalId: approval.id,
        tool: label,
        title: `${label} in ${workspace.name}`,
        input: approval.input,
        actionClass: verdict.actionClass,
        reason: verdict.reason,
        outcome: verdict.outcome,
      },
      () => this.store.insertApproval(approval),
    );
    return { action, state: 'pending', detail: verdict.reason, approvalId: approval.id };
  }

  private runAction(workspace: Workspace, action: DiffAction, run: () => Promise<string>, approvalId?: string): Promise<string> {
    const project = this.store.getProject(workspace.projectId)!;
    const base = { type: 'diff.action' as const, workspaceId: workspace.id, action, ...(approvalId ? { approvalId } : {}) };
    return this.exclusive(async () => {
      try {
        const detail = await run();
        this.record({ ...base, state: 'done', detail });
        return detail;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.record({ ...base, state: 'failed', detail });
        throw new HosError(400, detail);
      } finally {
        await this.refreshProject(project);
      }
    });
  }

  private chatAndWorkspaces(chatId: string): { chat: Chat; workspaces: Workspace[] } {
    const chat = this.requireChat(chatId);
    const ids = this.store.getTopic(chat.topicId)!.workspaceIds;
    return { chat, workspaces: ids.map((id) => this.store.getWorkspace(id)).filter((w): w is Workspace => !!w) };
  }

  private actionVerdict(chat: Chat, action: ActionDef, command: string): Verdict {
    const policy = this.verdict(chat, 'Bash', { command });
    const fromPolicy = action.source === 'repo' || action.confirm || policy.outcome === 'deny' ? policy.outcome : 'auto';
    const outcome = fromPolicy === 'deny' || fromPolicy === 'auto' ? fromPolicy : 'ask_every_time';
    const reason = outcome !== 'auto' ? policy.reason : `action ${action.name} runs at once`;
    return { actionClass: policy.actionClass, outcome, reason };
  }

  private async waitForRun(runId: string, ms: number): Promise<ActionRun> {
    const run = this.store.getActionRun(runId)!;
    if (run.state !== 'pending' && run.state !== 'running') return run;
    const finished = new Promise<ActionRun>((resolve) => this.runWaiters.set(runId, [...(this.runWaiters.get(runId) ?? []), resolve]));
    let cancel = () => {};
    const timedOut = new Promise<ActionRun>((resolve) => {
      cancel = this.clock.setTimeout(() => resolve(this.store.getActionRun(runId)!), ms);
    });
    return Promise.race([finished, timedOut]).finally(cancel);
  }

  private requireAction(workspace: Workspace, name: string): ActionDef {
    const action = this.listActions(workspace.id).actions.find((a) => a.name === name);
    if (!action) throw new HosError(404, `no action ${name} in ${workspace.name}`);
    this.requireSetupReady(workspace);
    return action;
  }

  private requireSetupReady(workspace: Workspace): void {
    if (workspace.setup === 'ready') return;
    throw new HosError(
      409,
      workspace.setup === 'failed'
        ? `setup of ${workspace.name} failed; re-run it before using the workspace`
        : `${workspace.name} is still setting up (${workspace.setup}); wait until it is ready`,
    );
  }

  requireReadyAt(path: string): void {
    const target = resolve(path);
    const holder = this.store
      .listWorkspaces()
      .filter((w) => target === w.path || target.startsWith(`${w.path}${sep}`))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (holder) this.requireSetupReady(holder);
  }

  private actionCommand(action: ActionDef, args: Record<string, unknown>): string {
    if (action.cwd === 'brain' && !this.options.brainDir) throw new HosError(400, `${action.name} runs in the brain, and hos has no brain`);
    try {
      return actionCommand(action, args);
    } catch (error) {
      throw new HosError(400, (error as Error).message);
    }
  }

  private newRun(workspace: Workspace, action: ActionDef, command: string, chatId: string | null, requestedBy: string): ActionRun {
    const run: ActionRun = {
      id: randomUUID(),
      workspaceId: workspace.id,
      name: action.name,
      command,
      where: action.where,
      state: 'pending',
      chatId,
      requestedBy,
      approvalId: null,
      terminal: null,
      exitCode: null,
      output: '',
      createdAt: this.clock.now(),
      finishedAt: null,
    };
    this.saveRun(run);
    return run;
  }

  private saveRun(run: ActionRun): void {
    this.record({ type: 'action.run', run }, () => this.store.saveActionRun(run));
    if (run.state !== 'pending' && run.state !== 'running') {
      for (const resolve of this.runWaiters.get(run.id) ?? []) resolve(run);
      this.runWaiters.delete(run.id);
    }
  }

  private async startRun(run: ActionRun, action: ActionDef, workspace: Workspace): Promise<void> {
    try {
      const cwd = action.cwd === 'worktree' ? workspace.path : action.cwd === 'brain' ? this.options.brainDir! : action.cwd;
      const worktreeName = basename(workspace.path);
      const port = this.portFor(worktreeName);
      const server = await this.serverSession(worktreeName, port, workspace.id);
      const { brainDir } = this.options;
      const env: Record<string, string> = {
        HOS_WORKTREE: workspace.path,
        PORT: String(port),
        HOS_PORT: String(port),
        ...(brainDir ? { HOS_BRAIN: brainDir } : {}),
        ...(server ? { HOS_SERVER: server } : {}),
      };
      const onOutput = (text: string) => this.actionOutput(run.id, text);
      let execution: Execution;
      if (action.where === 'host') {
        const hostEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
        delete hostEnv.TMUX;
        if (this.tmux.socketPath) hostEnv.TMUX = `${this.tmux.socketPath},0,0`;
        this.saveRun({ ...run, state: 'running' });
        execution = runOnHost(run.command, cwd, hostEnv, onOutput);
      } else {
        await mkdir(this.options.actionsDir, { recursive: true });
        const terminal = await this.freeTerminalName(worktreeName, action.name, port);
        const [log, exit] = this.runFiles(run.id);
        await this.tmux.create({ name: terminal, cwd, env, command: ['/bin/sh', '-c', tmuxScript(run.command, log, exit)] });
        this.saveRun({ ...run, state: 'running', terminal });
        execution = followLog(log, exit, () => this.tmux.has(terminal), onOutput);
      }
      this.executions.set(run.id, execution);
      void execution.done.then((code) => this.finishRun(run.id, code));
    } catch (error) {
      this.actionOutput(run.id, `${(error as Error).message}\n`);
      this.finishRun(run.id, null);
    }
  }

  private runFiles(runId: string): [log: string, exit: string] {
    return [join(this.options.actionsDir, `${runId}.log`), join(this.options.actionsDir, `${runId}.exit`)];
  }

  private actionOutput(runId: string, text: string): void {
    if (this.stopped) return;
    const run = this.store.getActionRun(runId)!;
    const output = (run.output + text).slice(-ACTION_OUTPUT_CHARS);
    this.record({ type: 'action.output', runId, workspaceId: run.workspaceId, text }, () =>
      this.store.saveActionRun({ ...run, output }),
    );
  }

  private finishRun(runId: string, exitCode: number | null): void {
    this.executions.delete(runId);
    if (this.stopped) return;
    const run = this.store.getActionRun(runId)!;
    this.saveRun({ ...run, state: exitCode === 0 ? 'done' : 'failed', exitCode, finishedAt: this.clock.now() });
  }

  private async serverSession(worktreeName: string, port: number, topicId: string): Promise<string | undefined> {
    const actions = this.listActions(topicId).actions.map((a) => a.name);
    const prefix = `${sessionName(worktreeName)}-`;
    const suffix = `-${port}`;
    return (await this.listTerminals()).find((t) => {
      if (t.chatId || !t.name.startsWith(prefix) || !t.name.endsWith(suffix)) return false;
      const app = t.name.slice(prefix.length, -suffix.length).replace(/\d+$/, '');
      return app !== 'shell' && !actions.includes(app);
    })?.name;
  }

  private requireWorkspace(workspaceId: string): Workspace {
    const workspace = this.store.getWorkspace(workspaceId);
    if (!workspace) throw new HosError(404, `no workspace ${workspaceId}`);
    return workspace;
  }

  private requireTopic(topicId: string): Topic {
    const topic = this.store.getTopic(topicId);
    if (!topic) throw new HosError(404, `no topic ${topicId}`);
    return topic;
  }

  private async snapshot(chatId: string, which: 'start' | 'turn', worktree: string): Promise<string> {
    try {
      const tree = await snapshotTree(worktree);
      this.store.setChatTree(chatId, which, tree);
      return tree;
    } catch (error) {
      console.error(`snapshot of ${worktree} failed`, error);
      return '';
    }
  }

  private requireChat(chatId: string): Chat {
    const chat = this.store.getChat(chatId);
    if (!chat) throw new HosError(404, `no chat ${chatId}`);
    return chat;
  }

  private requireProject(projectId: string): Project {
    const project = this.store.getProject(projectId);
    if (!project) throw new HosError(404, `no project ${projectId}`);
    return project;
  }

  private creator(chatId: string | undefined): { createdBy: Creator; createdByChat: string | null } {
    if (chatId === undefined) return { createdBy: 'human', createdByChat: null };
    if (!this.store.getChat(chatId)) throw new HosError(404, `no chat ${chatId}`);
    return { createdBy: 'agent', createdByChat: chatId };
  }

  private cancelApprovals(chatId: string): void {
    for (const approval of this.store.openApprovals().filter((a) => a.chatId === chatId)) {
      this.record({ type: 'approval.resolved', chatId, approvalId: approval.id, decision: 'cancelled' }, () =>
        this.store.decideApproval(approval.id, 'cancelled', this.clock.now(), 'system', null),
      );
      this.settle(approval.id, 'deny');
    }
    for (const item of this.store.openInboxItems(chatId)) {
      if (item.kind !== 'question') continue;
      this.saveInbox({ ...item, state: 'done' });
      this.settle(item.id, 'deny');
    }
  }

  private onAgentEvent(chatId: string, event: AgentEvent): void {
    if (event.type === 'provider.limit') {
      if (!this.harnesses.get(this.store.getChat(chatId)?.agent ?? '')?.features.usageLimits) return;
      return this.onProviderLimit(event.window, event.pct, event.resetsAt);
    }
    if (event.type === 'tokens.used') return this.onTokensUsed(chatId, event);
    if (event.type === 'credits.used') return this.onCreditsUsed(chatId, event.credits);
    if (this.inTerminal.has(chatId) || this.retired.has(chatId) || isHalted(this.store.getChat(chatId)!.state)) return;
    this.lastActive.set(chatId, this.clock.now());
    switch (event.type) {
      case 'context.loaded':
        return void this.record({ type: 'context.loaded', chatId, memoryFiles: event.memoryFiles, skills: event.skills });
      case 'context.usage':
        return this.onContextUsage(chatId, event.tokens, event.compactAt);
      case 'context.breakdown':
        return void this.record({ type: 'context.breakdown', chatId, categories: event.categories });
      case 'context.compacted':
        return void this.record({ type: 'context.compacted', chatId, blocked: false }, () => this.store.countCompaction(chatId));
      case 'turn.started': {
        this.dispatched.delete(chatId);
        this.store.dropQueuedTurns(chatId, true);
        this.inTurn.add(chatId);
        const unstarted = (this.unstarted.get(chatId) ?? 1) - 1;
        if (unstarted > 0) this.unstarted.set(chatId, unstarted);
        else this.unstarted.delete(chatId);
        return this.setState(chatId, this.handingOff(chatId) ? 'handing_off' : 'running');
      }
      case 'turn.completed': {
        try {
          this.dispatched.delete(chatId);
          for (const [id, shell] of this.shellTrees) if (shell.chatId === chatId) this.shellTrees.delete(id);
          for (const [id, edit] of this.editsInFlight) if (edit.chatId === chatId) this.editsInFlight.delete(id);
          const chat = this.store.getChat(chatId)!;
          this.topicActivity(chatId);
          if (this.endTurn(chatId)) return;
          const { result } = this.store.spawnMeta(chatId);
          const parked = this.store.openInboxItems(chatId).some((item) => item.parked);
          const scheduled = this.store.meta(SCHEDULED_META + chatId);
          if (scheduled) {
            this.store.deleteMeta(SCHEDULED_META + chatId);
            this.schedules?.finished(scheduled, chatId, 'done', firstLine(this.lastReplies.get(chatId) ?? '', NOTICE_CHARS));
          }
          if ((chat.createdBy !== 'agent' || chat.notify) && !parked) this.addInbox(chatId, 'completion', scheduled ? SCHEDULED_RUN_FINISHED : 'Turn finished', this.lastReplies.get(chatId) ?? '');
          // A parent on another computer hears it from the relayed chat.result there.
          if (result && chat.state !== 'done' && chat.parentId && !this.chatComputer(chat.parentId)) {
            const artifact = result.artifact ? ` (artifact ${result.artifact})` : '';
            const line = `chat ${chatId.slice(0, 8)} (${chat.role}) is done: ${firstLine(result.summary, NOTICE_CHARS)}${artifact}; wait on it for the full result`;
            this.store.insertNotice(chat.parentId, line, this.clock.now(), true, chatId);
          }
          return this.setState(chatId, result ? 'done' : parked ? 'waiting_input' : this.handingOff(chatId) ? 'handing_off' : 'idle');
        } finally {
          this.turnFinished(chatId);
        }
      }
      case 'message.delta':
        return void this.record({ type: event.type, chatId, messageId: event.messageId, text: event.text });
      case 'message.completed':
        this.lastReplies.set(chatId, event.text);
        return void this.record({ type: event.type, chatId, messageId: event.messageId, text: event.text });
      case 'thinking.delta':
      case 'thinking.completed':
        return void this.record({ type: event.type, chatId, thinkingId: event.thinkingId, text: event.text });
      case 'tool.started': {
        const chat = this.store.getChat(chatId)!;
        const edited = isEditTool(event.name) ? this.editTarget(chat, { toolUseId: event.toolUseId, tool: event.name, input: event.input }) : undefined;
        if (edited) {
          this.editsInFlight.set(event.toolUseId, { chatId, path: edited });
          for (const shell of this.shellTrees.values()) if (shell.chatId !== chatId) shell.edited.add(edited);
        }
        for (const listener of this.toolListeners) listener(chat, event.name, event.input);
        return void this.record({
          type: 'tool.started',
          chatId,
          toolUseId: event.toolUseId,
          name: event.name,
          input: summarize(JSON.stringify(event.input)),
          ...(event.parentToolUseId ? { parentToolUseId: event.parentToolUseId } : {}),
        });
      }
      case 'tool.completed': {
        const shell = this.shellTrees.get(event.toolUseId);
        this.shellTrees.delete(event.toolUseId);
        this.editsInFlight.delete(event.toolUseId);
        if (shell?.tree && !event.parentToolUseId) void this.checkShellWrites(chatId, shell.tree, shell.edited).catch((error) => console.error('shell write check failed', error));
        return void this.record({
          type: 'tool.completed',
          chatId,
          toolUseId: event.toolUseId,
          output: summarize(event.output),
          isError: event.isError,
          ...(event.parentToolUseId ? { parentToolUseId: event.parentToolUseId } : {}),
        });
      }
      case 'subagent.started':
      case 'subagent.progress':
      case 'subagent.finished':
        this.record({ ...event, chatId });
        return this.trackSubagent(chatId, event);
      case 'shell.started':
      case 'shell.finished':
        this.record({ ...event, chatId });
        return this.trackShell(chatId, event);
      case 'warning':
        this.record({ type: 'chat.error', chatId, message: event.message });
        return;
      case 'error':
        try {
          this.dispatched.delete(chatId);
          this.record({ type: 'chat.error', chatId, message: event.message });
          const resumes = this.planLimitResume(chatId, event.limit);
          this.topicActivity(chatId);
          if (this.endTurn(chatId)) return;
          const scheduled = this.store.meta(SCHEDULED_META + chatId);
          if (scheduled) {
            this.store.deleteMeta(SCHEDULED_META + chatId);
            this.schedules?.finished(scheduled, chatId, 'failed', firstLine(event.message, NOTICE_CHARS));
          }
          this.addInbox(chatId, 'failure', 'Chat failed', resumes ? `${event.message}\n\n${LIMIT_RESUME_NOTE}` : event.message);
          return this.setState(chatId, 'failed');
        } finally {
          this.turnFinished(chatId);
        }
    }
  }

  private contextLimits(chatId: string): ContextLimits {
    const chat = this.store.getChat(chatId)!;
    const topic = this.store.getTopic(chat.topicId)!;
    return resolveLimits(this.contextPolicy.current(), chat.agent, [topic.title, topic.statusTopic]);
  }

  private onContextUsage(chatId: string, tokens: number, compactAt: number | undefined): void {
    const limits = this.contextLimits(chatId);
    this.lastTokens.set(chatId, tokens);
    this.record({ type: 'context.usage', chatId, tokens, limits, ...(compactAt ? { compactAt } : {}) });
    const boot = this.store.handoffInto(chatId);
    if (boot && boot.bootTokens === null) {
      this.record({ type: 'handoff.boot', chatId, handoffId: boot.id, tokens }, () => this.store.setHandoffBoot(boot.id, tokens));
    }
    const { profile } = profileFor(this.profiles(), this.store.getChat(chatId)!.profile);
    if (profile.handoffAt !== null && !profile.contextRefresh && tokens >= profile.handoffAt * limits.handoff && !this.store.lifecycle(chatId).queued) {
      const share = Math.round(profile.handoffAt * 100);
      this.queueHandoff(chatId, { kind: 'write', reason: `The ${profile.id} profile refreshes at ${share}% of the ${kilo(limits.handoff)} handoff line`, auto: true });
    }
  }

  private quietBlocker(chatId: string): string | null {
    const chat = this.store.getChat(chatId);
    if (!chat || this.retired.has(chatId) || !isLive(chat.state)) return 'it is not live';
    if (this.inTerminal.has(chatId)) return 'it is taken over in a terminal';
    if (this.inTurn.has(chatId) || this.dispatched.has(chatId) || this.unstarted.has(chatId) || chat.state !== 'idle') {
      return chat.state === 'waiting_input' ? 'it waits for your answer' : 'its turn is running';
    }
    const subagents = this.liveSubagents.get(chatId)?.size ?? 0;
    if (subagents) return `${subagents} subagent${subagents === 1 ? ' is' : 's are'} running`;
    const children = this.store.childrenOf(chatId).filter((c) => isBusy(c.state) || c.state === 'waiting_input').length;
    if (children) return `${children} child chat${children === 1 ? ' is' : 's are'} busy`;
    return null;
  }

  private whenQuiet(chatId: string): void {
    if (this.stopped || this.quietBlocker(chatId)) return;
    const { stage, queued } = this.store.lifecycle(chatId);
    if (stage === 'done' || stage === 'requested' || !queued) return;
    const tokens = this.lastTokens.get(chatId) ?? this.uiSnapshot().state.context[chatId]?.tokens ?? 0;
    this.store.setHandoffQueued(chatId, null);
    this.closeHandoffCard(chatId, queued.kind === 'salvage' ? 'Salvaged' : 'Handed off');
    if (queued.kind === 'salvage') return this.background(chatId, () => this.salvage(chatId, queued.reason));
    return this.background(chatId, () => this.requestHandoff(chatId, tokens, this.contextLimits(chatId).handoff, queued.auto ? queued.reason : undefined));
  }

  private handoffCard(chatId: string): InboxItem | undefined {
    return this.store.openInboxItems(chatId).find((item) => item.handoff);
  }

  private closeHandoffCard(chatId: string, resolution: string): void {
    const open = this.handoffCard(chatId);
    if (open) this.saveInbox({ ...open, state: 'done', resolution });
  }

  private answerHandoff(item: InboxItem, choice: string | undefined): void {
    const chatId = item.chatId!;
    this.saveInbox({ ...item, state: 'done', resolution: choice ? `Answered: ${choice}` : 'Skipped' });
    if (choice === HANDOFF_RUN) this.queueHandoff(chatId, { kind: 'write', reason: `${ownerStart()} ran the handoff` });
    if (choice === HANDOFF_SALVAGE) this.queueHandoff(chatId, { kind: 'salvage', reason: `${ownerStart()} chose to salvage at ${kilo(item.handoff!.tokens)} tokens` });
  }

  private queueHandoff(chatId: string, queued: QueuedHandoff): void {
    const { stage } = this.store.lifecycle(chatId);
    if (stage === 'requested' || stage === 'done') return;
    this.store.setHandoffQueued(chatId, queued);
    this.whenQuiet(chatId);
  }

  triggerHandoff(ref: string, mode: 'write' | 'salvage' = 'write'): HandoffTrigger {
    const chat = this.resolveChat(ref);
    const { stage } = this.store.lifecycle(chat.id);
    if (stage === 'requested' || stage === 'done') throw new HosError(409, `chat ${chat.id} is already handing off`);
    if (this.refreshes.has(chat.id)) throw new HosError(409, `chat ${chat.id} is refreshing its context`);
    if (!isLive(chat.state)) throw new HosError(409, `chat ${chat.id} is ${chat.state}, not live`);
    const reason = mode === 'salvage' ? `${ownerStart()} asked for a salvage handoff` : `${ownerStart()} asked for a handoff`;
    const busy = this.quietBlocker(chat.id);
    this.queueHandoff(chat.id, { kind: mode, reason });
    return { queued: busy !== null, reason: busy };
  }

  handoffStatus(ref: string): HandoffStatus {
    const chat = this.resolveChat(ref);
    const { stage, queued } = this.store.lifecycle(chat.id);
    const successor = this.store.chatsInLineage(chat.lineageId).find((c) => c.predecessorId === chat.id);
    return { chatId: chat.id, state: chat.state, stage, queued: queued?.kind ?? null, busy: this.quietBlocker(chat.id), successorId: successor?.id ?? null };
  }

  refreshContext(ref: string): { queued: boolean } {
    const chat = this.resolveChat(ref);
    const { profile } = profileFor(this.profiles(), chat.profile);
    if (!profile.contextRefresh) throw new HosError(400, `chat ${chat.id} runs the ${profile.id} profile, which has no context_refresh`);
    if (chat.computer) throw new HosError(400, `chat ${chat.id} runs on ${chat.computer}; refresh it there`);
    if (!this.harnesses.get(chat.agent)?.features.contextRefresh) throw new HosError(400, `chat ${chat.id} runs on ${chat.agent}, which has no context refresh`);
    if (!isLive(chat.state) || this.inTerminal.has(chat.id)) throw new HosError(400, `chat ${chat.id} is ${chat.state}, not live`);
    if (this.refreshes.has(chat.id) || this.store.lifecycle(chat.id).stage === 'requested') throw new HosError(409, `chat ${chat.id} is already refreshing or handing off`);
    return { queued: this.startRefresh(chat) };
  }

  private startRefresh(chat: Chat): boolean {
    this.refreshes.set(chat.id, { askedAt: null, attempts: 0, accepted: false });
    this.record({ type: 'context.refresh_requested', chatId: chat.id });
    const queued = this.inTurn.has(chat.id);
    this.atTurnEnd(chat.id, () => this.askRefresh(chat.id));
    return queued;
  }

  private async askRefresh(chatId: string): Promise<void> {
    const refresh = this.refreshes.get(chatId);
    if (!refresh) return;
    refresh.askedAt = this.clock.now();
    if (!this.sessions.has(chatId)) await this.resumeSession(this.store.getChat(chatId)!);
    this.tell(chatId, refreshAsk());
  }

  async refreshReady(chatId: string): Promise<BusReply> {
    const refresh = this.refreshes.get(chatId);
    if (!refresh?.askedAt) return { outcome: 'refused', text: 'Refused: hos has not asked this chat for a context refresh.' };
    if (refresh.accepted) return { outcome: 'refused', text: 'The refresh is already accepted; stop now.' };
    const chat = this.store.getChat(chatId)!;
    const topic = this.store.getTopic(chat.topicId)!;
    const file = this.progressFile(topic);
    const target = (path: string) => resolve(this.options.brainDir ?? this.options.dataDir, path);
    const problems = file
      ? await this.brainWrite(() => checkHandoff(file, { chat: chatId.slice(0, 8), since: refresh.askedAt }, target, this.workspacePaths(topic)))
      : ['Desk has no work folder, so there is no PROGRESS.md to refresh from'];
    if (!problems.length) {
      refresh.accepted = true;
      this.atTurnEnd(chatId, () => this.finishRefresh(chatId));
      return { outcome: 'ok', text: 'Refresh accepted. hos clears your context when this turn ends; stop now.' };
    }
    refresh.attempts += 1;
    const list = problems.map((p) => `- ${p}`).join('\n');
    if (refresh.attempts < MAX_HANDOFF_ATTEMPTS) {
      return { outcome: 'refused', text: `Refresh rejected:\n${list}\nFix PROGRESS.md with progress_update and call refresh_ready again; this is your one correction round.` };
    }
    this.failRefresh(chatId, problems);
    return { outcome: 'refused', text: `Refresh rejected again:\n${list}\nhos cancelled the refresh; your context stays as it is. Carry on.` };
  }

  private failRefresh(chatId: string, problems: string[]): void {
    this.refreshes.delete(chatId);
    this.stopBlocks.delete(chatId);
    this.record({ type: 'context.refresh_failed', chatId, problems });
  }

  private async finishRefresh(chatId: string): Promise<void> {
    if (!this.refreshes.delete(chatId)) return;
    this.stopBlocks.delete(chatId);
    const session = this.sessions.get(chatId);
    this.sessions.delete(chatId);
    this.dispatched.delete(chatId);
    this.endSubagents(chatId);
    await session?.then((s) => s.stop()).catch(() => {});
    this.store.setChatNativeSession(chatId, null);
    this.lastTokens.delete(chatId);
    this.record({ type: 'context.refreshed', chatId });
    await this.startSession(chatId);
    this.tell(chatId, refreshBoot());
  }

  private resolveChat(ref: string): Chat {
    const exact = this.store.getChat(ref);
    if (exact) return exact;
    const matches = ref.length >= 8 ? this.store.chatsByPrefix(ref) : [];
    if (matches.length === 1) return matches[0]!;
    throw new HosError(matches.length ? 409 : 404, matches.length ? `chat ${ref} is ambiguous` : `no chat ${ref}`);
  }

  private tell(chatId: string, text: string, write?: () => void): void {
    this.record({ type: 'message.user', chatId, messageId: randomUUID(), text, from: 'hos' }, write);
    void this.sessions.get(chatId)?.then((session) => session.send(text));
  }

  private handingOff(chatId: string): boolean {
    return this.store.lifecycle(chatId).stage === 'requested';
  }

  private endTurn(chatId: string): boolean {
    this.inTurn.delete(chatId);
    const next = this.afterTurn.get(chatId);
    if (!next) return false;
    this.afterTurn.delete(chatId);
    this.background(chatId, next);
    return true;
  }

  private atTurnEnd(chatId: string, fn: () => Promise<void>): void {
    if (this.inTurn.has(chatId)) this.afterTurn.set(chatId, fn);
    else this.background(chatId, fn);
  }

  private background(chatId: string, fn: () => Promise<void>): void {
    if (this.stopped) return;
    const work = fn().catch((error) => console.error(`handoff of chat ${chatId} failed`, error));
    this.lifecycleWork.add(work);
    void work.finally(() => this.lifecycleWork.delete(work));
  }

  private progressFile(topic: Topic): string | null {
    const dir = this.workDirAbs(topic);
    return dir ? join(dir, PROGRESS_FILE) : null;
  }

  private chatHandoffRoot(chatId: string): string {
    const topic = this.store.getTopic(this.requireChat(chatId).topicId)!;
    return this.workDirAbs(topic) ?? join(this.options.brainDir ?? this.options.dataDir, this.workRoot());
  }

  private async requestHandoff(chatId: string, tokens: number, line: number, reason = `${ownerStart()} asked for a handoff`): Promise<void> {
    const dir = this.chatHandoffRoot(chatId);
    const chat = this.store.getChat(chatId)!;
    const topic = this.store.getTopic(chat.topicId)!;
    const workDir = this.workDirAbs(topic);
    const progress = this.progressFile(topic);
    const target = this.chatCwd(chat);
    const branch = await currentBranch(target).catch(() => this.place(topic).branch ?? 'HEAD');
    this.handoffAskedAt.set(chatId, this.clock.now());
    this.record({ type: 'handoff.requested', chatId, tokens, dir }, () => this.store.setHandoffStage(chatId, 'requested'));
    if (!this.sessions.has(chatId)) await this.resumeSession(chat);
    const where = tokens >= line ? `past the ${kilo(line)} handoff line` : `below the ${kilo(line)} handoff line`;
    const skill = this.handoffSkill(chat);
    const how = progress
      ? `Update ${progress} with progress_update: State, Open and Next step (Tried if anything failed). Where keeps "- Path:" and "- Branch:" lines with the TARGET and BRANCH above, so do not ask for them. Then write ${join(workDir!, `handoff-gen${chat.generation}.md`)} with the ${skill} skill, with the same "- Path:" and "- Branch:" lines, and call the hos bus tool handoff_ready with that file's absolute path.`
      : `Desk has no work folder: update the PROGRESS.md of the work folder you used (progress_update with folder) the same way, with "- Path:" and "- Branch:" lines for the TARGET and BRANCH above, write handoff-gen${chat.generation}.md beside it with the ${skill} skill (same lines), then call handoff_ready with that handoff file's absolute path.`;
    this.tell(
      chatId,
      [
        `[hos] ${reason}. Context is at ${kilo(tokens)} tokens, ${where}. Run the ${skill} skill${skill === 'handoff' ? ' in continue mode' : ''} now so a fresh successor chat can take over this task.`,
        `WORK_DIR=${workDir ?? 'none (Desk)'}`,
        `HANDOFF_DIR=${workDir ?? dir}`,
        `TARGET=${target}`,
        `BRANCH=${branch}`,
        how,
        `Until hos accepts the handoff, only the ${skill} skill, files in WORK_DIR and the hos bus are allowed; other tools are refused and your turn cannot end.`,
      ].join('\n'),
    );
  }

  private handoffSkill(chat: Chat): string {
    return profileFor(this.profiles(), chat.profile).profile.handoffSkill;
  }

  private refuse(chatId: string, request: PermissionRequest): string | undefined {
    // ToolSearch stays allowed during handoff: a deferred hos bus tool the handoff needs (e.g. handoff_ready if it was
    // not preloaded) is found through it, and it reads nothing and edits nothing (H5).
    if (!this.handingOff(chatId) || request.tool === 'Skill' || request.tool === 'ToolSearch' || request.tool.startsWith('mcp__hos__')) return undefined;
    if (this.isHandoffFile(chatId, request.tool, request.input, true)) return undefined;
    return `[hos] Refused: you are handing off. Only the ${this.handoffSkill(this.store.getChat(chatId)!)} skill, files in ${this.chatHandoffRoot(chatId)} and the hos bus are allowed until hos accepts your handoff.`;
  }

  private isHandoffFile(chatId: string, tool: string, input: unknown, allowSkillReads = false): boolean {
    const field = FILE_TOOLS[tool];
    const path = field ? (input as Record<string, unknown> | undefined)?.[field] : undefined;
    if (typeof path !== 'string' || !path.startsWith('/')) return false;
    const file = resolve(path);
    return inside(this.chatHandoffRoot(chatId), file) || (allowSkillReads && tool === 'Read' && file.includes(`/skills/${this.handoffSkill(this.store.getChat(chatId)!)}/`));
  }

  private beforeStop(chatId: string): string | undefined {
    const refresh = this.refreshes.get(chatId);
    if (refresh?.askedAt) return refresh.accepted ? undefined : this.refreshStop(chatId);
    if (!this.handingOff(chatId)) return undefined;
    const blocks = (this.stopBlocks.get(chatId) ?? 0) + 1;
    this.stopBlocks.set(chatId, blocks);
    if (blocks > MAX_STOP_BLOCKS) {
      this.stopBlocks.delete(chatId);
      this.atTurnEnd(chatId, () => this.salvage(chatId, `it ended its turn ${blocks} times without reporting a handoff`));
      return undefined;
    }
    const skill = this.handoffSkill(this.store.getChat(chatId)!);
    return `[hos] You cannot stop yet: update PROGRESS.md with progress_update, write handoff-gen<N>.md beside it (the ${skill} skill${skill === 'handoff' ? ' in continue mode' : ''}) and call the hos bus tool handoff_ready with that file's path (stop ${blocks} of ${MAX_STOP_BLOCKS} refused; after that hos writes a salvage handoff).`;
  }

  private refreshStop(chatId: string): string | undefined {
    const blocks = (this.stopBlocks.get(chatId) ?? 0) + 1;
    this.stopBlocks.set(chatId, blocks);
    if (blocks > MAX_STOP_BLOCKS) {
      this.failRefresh(chatId, [`it ended its turn ${blocks} times without calling refresh_ready`]);
      return undefined;
    }
    return `[hos] You cannot stop yet: update PROGRESS.md with progress_update and call the hos bus tool refresh_ready (stop ${blocks} of ${MAX_STOP_BLOCKS} refused; after that hos cancels the refresh).`;
  }

  private beforeCompact(chatId: string): string | undefined {
    if (this.store.lifecycle(chatId).stage !== 'requested') return undefined;
    this.record({ type: 'context.compacted', chatId, blocked: true });
    return 'hos blocks compaction while this chat writes its handoff';
  }

  async handoffReady(chatId: string, path?: string): Promise<BusReply> {
    const chat = this.store.getChat(chatId)!;
    const { stage, attempts } = this.store.lifecycle(chatId);
    if (stage === 'done') return { outcome: 'refused', text: 'This chat has already handed off; stop now.' };
    const topic = this.store.getTopic(chat.topicId)!;
    const expected = this.progressFile(topic);
    const given = path?.trim() ? resolve(path.trim()) : null;
    const handoffFile = given && HANDOFF_FILE.test(basename(given)) ? given : null;
    const file = handoffFile ? join(dirname(handoffFile), PROGRESS_FILE) : (given ?? expected);
    if (!file) {
      return { outcome: 'refused', text: 'Refused: Desk has no work folder, so give path: the absolute path of the handoff-gen<N>.md you wrote beside the PROGRESS.md you updated.' };
    }
    const problems = [...(await this.checkProgressHandoff(chat, file, expected)),...(handoffFile ? await this.checkHandoffFile(handoffFile) : [])];
    if (!problems.length) {
      this.store.setHandoffStage(chatId, 'done');
      const reason = stage === 'requested' ? `asked by ${owner()}` : 'voluntary';
      this.atTurnEnd(chatId, () => this.continueLineage(chatId, handoffFile ?? file, 'agent', reason, attempts + 1, file));
      return { outcome: 'ok', text: `Handoff accepted. hos starts generation ${chat.generation + 1} from ${handoffFile ? `${file} and ${handoffFile}` : file} when this turn ends; stop now.` };
    }
    const final = attempts + 1 >= MAX_HANDOFF_ATTEMPTS;
    this.record({ type: 'handoff.rejected', chatId, path: file, problems, final }, () => {
      this.store.countHandoffAttempt(chatId);
      if (final) this.store.setHandoffStage(chatId, 'done');
    });
    const list = problems.map((p) => `- ${p}`).join('\n');
    if (!final) {
      return { outcome: 'refused', text: `Handoff rejected:\n${list}\nFix PROGRESS.md with progress_update (and the handoff-gen<N>.md file if you wrote one) and call handoff_ready again; this is your one correction round.` };
    }
    this.atTurnEnd(chatId, () => this.salvage(chatId, 'its handoff failed validation twice'));
    return { outcome: 'refused', text: `Handoff rejected again:\n${list}\nhos writes a salvage handoff instead; stop now.` };
  }

  private async checkProgressHandoff(chat: Chat, file: string, expected: string | null): Promise<string[]> {
    const root = join(this.options.brainDir ?? this.options.dataDir, this.workRoot());
    if (expected ? file !== expected : !(inside(root, file) && basename(file) === PROGRESS_FILE)) {
      return [`the handoff is ${expected ? `this topic's PROGRESS.md (${expected})` : `a PROGRESS.md under ${root}`}, not ${file}; update it with progress_update and call handoff_ready${expected ? ' with no path' : ''}`];
    }
    const handoff = { chat: chat.id.slice(0, 8), since: this.handoffAskedAt.get(chat.id) ?? null };
    return checkHandoff(file, handoff, undefined, this.workspacePaths(this.store.getTopic(chat.topicId)!));
  }

  private workspacePaths(topic: Topic): string[] {
    return topic.workspaceIds.flatMap((id) => this.store.getWorkspace(id)?.path ?? []);
  }

  private async checkHandoffFile(file: string): Promise<string[]> {
    const text = await readFile(file, 'utf8').catch(() => undefined);
    if (text === undefined) return [`${basename(file)}: there is no file at ${file}`];
    return (await checkHandoffText(text)).map((problem) => `${basename(file)}: ${problem}`);
  }

  private async salvage(chatId: string, reason: string): Promise<void> {
    if (this.retired.has(chatId)) return;
    const chat = this.store.getChat(chatId)!;
    const topic = this.store.getTopic(chat.topicId)!;
    this.store.setHandoffStage(chatId, 'done');
    await this.retire(chatId, 'paused');
    const target = this.chatCwd(chat);
    const branch = await currentBranch(target).catch(() => this.place(topic).branch ?? 'HEAD');
    const text = salvageHandoff({
      topic: topic.title,
      chatId,
      generation: chat.generation,
      reason,
      target,
      branch,
      card: this.store.chatBusState(chatId).card,
      recent: this.store.chatSummaries(chatId, SALVAGE_EVENTS).map((line) => line.summary),
      date: this.today(),
    });
    const workDir = this.workDirAbs(topic);
    const file = workDir
      ? await writeNew(workDir, `handoff-gen${chat.generation}-salvage`, text)
      : await writeNew(join(this.options.dataDir, 'handoffs'), `${this.today()}-${topic.statusTopic}-gen${chat.generation}-salvage`, text);
    const { brainDir } = this.options;
    if (brainDir && inside(brainDir, file)) void this.brainCommits?.commitPaths([relative(brainDir, file)], `hos: ${topic.title} · salvage handoff`);
    const next = `Read ${basename(file)} beside this file (${file}), check the worktree with git status and git diff, then continue from it.`;
    const progress = await this.lineageProgress(chat, topic, `salvaged generation ${chat.generation}: ${reason}`, next);
    await this.continueLineage(chatId, file, 'salvage', reason, this.store.lifecycle(chatId).attempts, progress ?? file);
  }

  // Writes hos's own PROGRESS.md update at a handoff; a topic with no PROGRESS.md yet gets one seeded from what hos knows.
  private async lineageProgress(chat: Chat, topic: Topic, note: string, next?: string): Promise<string | null> {
    const dir = this.workDirAbs(topic);
    if (!dir) return null;
    const file = join(dir, PROGRESS_FILE);
    const sections: Record<string, string> = next ? { 'Next step': next } : {};
    if (!existsSync(file)) {
      const place = this.place(topic);
      const branch = await currentBranch(place.path).catch(() => place.branch ?? 'HEAD');
      Object.assign(sections, {
        Goal: topic.request ?? topic.title,
        State: `hos started this file when chat ${chat.id.slice(0, 8)} (generation ${chat.generation}) handed off; no chat had written it before.`,
        Where: `- Path: \`${place.path}\`\n- Branch: \`${branch}\``,
        'Next step': next ?? 'Read the roster and the tasks, then carry on from them.',
      });
    }
    const written = await this.writeProgress(dir, topic, null, { sections, note });
    if (written.outcome !== 'ok') console.error(`hos could not update ${file} at the handoff of chat ${chat.id}: ${written.text}`);
    return file;
  }

  private async retire(chatId: string, state?: ChatState): Promise<void> {
    this.retired.add(chatId);
    this.afterTurn.delete(chatId);
    this.inTurn.delete(chatId);
    this.cancelApprovals(chatId);
    if (state) this.setState(chatId, state);
    const session = this.sessions.get(chatId);
    this.sessions.delete(chatId);
    this.endSubagents(chatId);
    await session?.then((s) => s.stop()).catch(() => {});
  }

  private async continueLineage(
    chatId: string,
    file: string,
    kind: Handoff['kind'],
    reason: string,
    attempts: number,
    bootFile = file,
    brief?: string,
  ): Promise<void> {
    if (!this.retired.has(chatId)) await this.retire(chatId);
    this.handoffAskedAt.delete(chatId);
    const chat = this.store.getChat(chatId)!;
    const topic = this.store.getTopic(chat.topicId)!;
    const successorId = randomUUID();
    const handoff: Handoff = {
      id: randomUUID(),
      lineageId: chat.lineageId,
      chatId,
      generation: chat.generation,
      successorId,
      path: file,
      kind,
      reason,
      attempts,
      bootTokens: null,
      createdAt: this.clock.now(),
    };
    if (kind === 'agent' && bootFile === this.progressFile(topic)) await this.lineageProgress(chat, topic, `handoff gen ${chat.generation} → gen ${chat.generation + 1} (written by the chat)`);
    this.record({ type: 'handoff.completed', chatId, handoff }, () => this.store.insertHandoff(handoff));
    this.setState(chatId, 'handed_off');
    await this.launchChat(
      {
        id: successorId,
        topicId: chat.topicId,
        agent: chat.agent,
        state: 'starting',
        createdBy: 'system',
        createdAt: this.clock.now(),
        parentId: chat.parentId,
        role: chat.role,
        depth: chat.depth,
        intent: chat.intent,
        ownedFiles: chat.ownedFiles,
        worktreePath: chat.worktreePath,
        predecessorId: chatId,
        lineageId: chat.lineageId,
        generation: chat.generation + 1,
        priority: chat.priority,
        model: chat.model,
        effort: chat.effort,
        suspended: false,
        title: chat.title,
        naming: false,
        tabClosed: false,
        chrome: chat.chrome,
        notify: chat.notify,
        profile: chat.profile,
      },
      topic,
      this.store.spawnMeta(chatId),
    );
    this.locks.transfer(chatId, successorId);
    this.tasks.transfer(chat.topicId, chatId, successorId);
    const read = !bootFile
      ? ''
      : kind === 'agent' && file !== bootFile
        ? ` Read ${bootFile} and the handoff ${file}: run its Checks, then do its Next step.`
        : ` Read ${bootFile}: run its Checks, then do its Next step.`;
    this.tell(
      successorId,
      [`[hos] You are generation ${chat.generation + 1} of lineage ${chat.lineageId.slice(0, 8)}, continuing chat ${chatId.slice(0, 8)}.${read}`, ...(brief ? ['', brief] : [])].join('\n'),
    );
  }

  private async launchChat(chat: Chat, topic: Topic, meta: Partial<SpawnMeta> = {}): Promise<Chat> {
    const { projectId } = this.place(topic);
    const project = projectId ? this.store.getProject(projectId) : undefined;
    this.record({ type: 'chat.created', chat }, () => this.store.insertChat(chat, meta));
    await this.snapshot(chat.id, 'start', this.chatCwd(chat));
    const session = await this.startSession(chat.id);
    this.store.setChatNativeSession(chat.id, session.nativeId);
    this.setState(chat.id, 'idle');
    if (project) await this.exclusive(() => this.refreshProject(project));
    return { ...chat, state: 'idle' };
  }

  private today(): string {
    return new Date(this.clock.now()).toISOString().slice(0, 10);
  }

  private startSession(chatId: string, resume?: string): Promise<AgentSession> {
    const chat = this.store.getChat(chatId)!;
    this.unstarted.delete(chatId);
    this.endSubagents(chatId);
    const started = this.hostSession(chat, resume).then(
      (session): AgentSession => ({
        ...session,
        send: (text) => {
          this.unstarted.set(chatId, (this.unstarted.get(chatId) ?? 0) + 1);
          session.send(text);
        },
      }),
    );
    this.sessions.set(chatId, started);
    this.lastActive.set(chatId, this.clock.now());
    started.then(
      (session) => {
        this.store.setChatNativeSession(chatId, session.nativeId);
        if (this.store.getChat(chatId)?.suspended) {
          this.record({ type: 'chat.suspended', chatId, suspended: false }, () => this.store.setChatSuspended(chatId, false));
        }
      },
      () => this.sessions.delete(chatId),
    );
    return started;
  }

  private async hostSession(chat: Chat, resume?: string): Promise<AgentSession> {
    const cwd = this.sessionCwd(chat);
    if (!this.store.chatSessionCwd(chat.id)) this.store.setChatSessionCwd(chat.id, cwd);
    const port = String(this.portFor(basename(this.chatCwd(chat))));
    await this.topicScratch(chat.topicId);
    const extraDirs = this.readyDirs(chat, cwd);
    this.sessionDirs.set(chat.id, extraDirs.join('\n'));
    const workDir = this.workDirAbs(this.store.getTopic(chat.topicId)!);
    const brain: Record<string, string> = this.options.brainDir ? { HOS_BRAIN: this.options.brainDir } : {};
    return this.runtimeSession(chat, cwd, { PORT: port, HOS_PORT: port, ...brain, ...(workDir ? { WORK_DIR: workDir } : {}) }, extraDirs, resume);
  }

  private hiddenSkills(): { hideSkills?: string[] } {
    try {
      const hide = loadHiddenSkills(this.options.policyFile);
      return hide.length ? { hideSkills: hide } : {};
    } catch (error) {
      console.error((error as Error).message);
      return {};
    }
  }

  private profiles(): Profiles {
    return loadProfiles(this.options.brainDir);
  }

  listProfiles(): ProfileInfo[] {
    return this.profiles().list.map(profileInfo);
  }

  profileSkills(id: string): string[] | undefined {
    return allowedSkills(profileFor(this.profiles(), id).profile);
  }

  private requireProfile(id: string | undefined): string {
    const wanted = id ?? GENERIC;
    const profiles = this.profiles();
    if (wanted === GENERIC || profiles.list.some((p) => p.id === wanted)) return wanted;
    throw new HosError(400, `there is no profile "${wanted}"; profiles: ${profiles.list.map((p) => p.id).join(', ')}`);
  }

  private profileKnown(id: string): boolean {
    return id === GENERIC || this.profiles().list.some((p) => p.id === id);
  }

  private profileDefaults(
    profileId: string | undefined,
    agent: string | undefined,
    fallback = this.harnesses.primary.id,
  ): { agent: string; model?: string; effort?: Effort; browser: boolean } {
    const { profile } = profileFor(this.profiles(), profileId ?? GENERIC);
    const id = agent ?? (profile.harness && this.harnesses.get(profile.harness) ? profile.harness : fallback);
    const own = profile.models[id];
    const model = own?.model && this.harnesses.get(id)?.models().list.some((m) => m.id === own.model) ? own.model : undefined;
    return { agent: id, ...(model ? { model } : {}), ...(own?.effort ? { effort: own.effort } : {}), browser: profile.browser && !!this.harnesses.get(id)?.features.browser };
  }

  hiddenBusTools(chatId: string): string[] {
    const chat = this.store.getChat(chatId);
    return chat ? profileFor(this.profiles(), chat.profile).profile.hideTools : [];
  }

  canvasTools(chatId: string): boolean {
    const chat = this.store.getChat(chatId);
    return !!chat && canvasOn(profileFor(this.profiles(), chat.profile).profile);
  }

  private launchProfile(chat: Chat): { allowSkills?: string[]; profileAppend?: string; hideTools?: string[] } {
    const profiles = this.profiles();
    const { profile, notice } = profileFor(profiles, chat.profile);
    if (notice) this.record({ type: 'chat.error', chatId: chat.id, message: `Profile: ${notice}.` });
    const allowSkills = allowedSkills(profile);
    const append = profileAppend(profiles, profile);
    const hideTools = hiddenBuiltIns(profile);
    return { ...(allowSkills ? { allowSkills } : {}), ...(append ? { profileAppend: append } : {}), ...(hideTools ? { hideTools } : {}) };
  }

  private runtimeSession(chat: Chat, cwd: string, env: Record<string, string>, extraDirs: string[], resume?: string): Promise<AgentSession> {
    const chatId = chat.id;
    const { brainDir } = this.options;
    const { model, effort, chrome } = chat;
    return this.runtimeFor(chat).start(
      {
        chatId,
        cwd,
        env,
        extraDirs,
        compactAt: this.contextLimits(chatId).backstop,
        ...(brainDir ? { brainDir } : {}),
        ...(resume ? { resume } : {}),
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...(chrome ? { chrome } : {}),
        ...(this.busUrl ? { bus: { url: this.busUrl, token: this.bus.mintToken(chatId) } } : {}),
        ...(this.options.mcpServers?.length ? { mcpServers: this.options.mcpServers } : {}),
        ...this.hiddenSkills(),
        ...this.launchProfile(chat),
      },
      {
        event: (event) => this.onAgentEvent(chatId, event),
        permission: (request) => this.requestApproval(chatId, request),
        beforeTurn: () => this.bus.turnContext(chatId),
        needsDecision: (request) => this.needsDecision(chatId, request),
        beforeTool: (request) => this.beforeTool(chatId, request),
        refuse: (request) => this.refuse(chatId, request),
        beforeStop: () => this.beforeStop(chatId),
        beforeCompact: () => this.beforeCompact(chatId),
      },
    );
  }

  private chatCwd(chat: Chat): string {
    return chat.worktreePath ?? this.place(this.store.getTopic(chat.topicId)!).path;
  }

  // Absolute path of a chat's return-contract artifact. A relative path under the brain's artifacts/, .context/ or
  // plans/ resolves against the brain (so a scout working in a code repo can still return a brain artifact), anything
  // else against the dir the chat runs in. complete and the edit allowance both use this, so a child may write exactly
  // its contracted artifact even when it owns no files (H4).
  private contractArtifact(chat: Chat): string | null {
    const artifact = this.store.spawnMeta(chat.id).returnContract?.artifact;
    if (!artifact?.trim()) return null;
    const raw = artifact.trim();
    if (isAbsolute(raw)) return resolve(raw);
    const { brainDir } = this.options;
    const brainRooted = /^(artifacts|\.context|plans)(\/|$)/.test(raw.replace(/^(\.\/)+/, ''));
    return resolve(brainDir && brainRooted ? brainDir : this.sessionCwd(chat), raw);
  }

  private artifactPaths(chat: Chat, raw: string): string[] {
    if (isAbsolute(raw)) return [resolve(raw)];
    const workDir = raw.includes('/') ? null : this.workDirAbs(this.store.getTopic(chat.topicId)!);
    const bases = [this.sessionCwd(chat), this.options.brainDir, workDir, this.chatCwd(chat)];
    return bases.filter((base): base is string => Boolean(base)).map((base) => resolve(base, raw));
  }

  private worktreePathFor(project: Project, branch: string): string {
    return join(dirname(project.path), `${basename(project.path)}-worktrees`, slug(branch, 'worktree'));
  }

  private async resumeSession(chat: Chat): Promise<AgentSession> {
    try {
      return await this.startSession(chat.id, this.store.getChatNativeSession(chat.id));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.record({ type: 'chat.error', chatId: chat.id, message: `could not resume: ${message}` });
      if (error instanceof HosError) throw error;
      throw new HosError(502, `could not resume chat ${chat.id}: ${message}`);
    }
  }

  private async beforeTool(chatId: string, request: PermissionRequest): Promise<string | undefined> {
    const chat = this.store.getChat(chatId);
    if (!chat) return undefined;
    const tokens = join(this.options.dataDir, 'computers');
    if (JSON.stringify(request.input ?? {}).includes(tokens)) return `Denied by hos: ${tokens} holds the tokens of paired computers, and no chat reads or touches it.`;
    this.store.renewLocks(chatId, this.clock.now());
    const roleRefusal = this.roleRefusal(chat, request) ?? this.writeScopeRefusal(chat, request);
    if (roleRefusal) return roleRefusal;
    const cwd = this.chatCwd(chat);
    const field = EDIT_FIELDS[request.tool];
    if (field) {
      const raw = String(((request.input ?? {}) as Record<string, unknown>)[field] ?? '');
      // contractArtifact resolves the chat's return artifact to an absolute path, so a child may write exactly that
      // file even when it is outside its worktree and it owns no files — e.g. a scout returning a brain artifact (H4).
      const artifact = this.contractArtifact(chat);
      const absolute = raw ? resolve(this.sessionCwd(chat), raw) : null;
      const isArtifact = artifact !== null && absolute === artifact;
      const path = repoPath(cwd, this.sessionCwd(chat), raw);
      if (!path) {
        if (!raw || isArtifact || !editsOnlyOwned(chat) || this.isHandoffFile(chat.id, request.tool, request.input)) return undefined;
        return `Denied by hos: ${resolve(this.sessionCwd(chat), raw)} is outside your worktree ${cwd}, and a spawned chat edits only its owned files (${ownedText(chat)}). Ask chat ${chat.parentId.slice(0, 8)}, which spawned you, if you need it.`;
      }
      const lock = this.locks.holder(chat, path);
      if (editsOnlyOwned(chat) && !owns(chat, path) && !isArtifact) {
        const owner = lock ? ` It is inside ${this.locks.describe(lock)}; message that chat with send.` : '';
        return `Denied by hos: ${path} is outside your owned files (${ownedText(chat)}).${owner} Ask chat ${chat.parentId.slice(0, 8)}, which spawned you, if you need it.`;
      }
      if (lock) return `Denied by hos: ${path} is inside ${this.locks.describe(lock)}. Message that chat with send, or wait for it to unlock.`;
      return undefined;
    }
    const watched = chat.parentId !== null || this.locks.live(chat.topicId).some((lock) => lock.chatId !== chatId);
    if (SHELL_TOOLS.includes(request.tool) && watched) {
      const edited = new Set([...this.editsInFlight.values()].filter((edit) => edit.chatId !== chatId).map((edit) => edit.path));
      const shell = { chatId, tree: '', edited };
      this.shellTrees.set(request.toolUseId, shell);
      const tree = await snapshotTree(cwd).catch(() => null);
      if (tree && this.shellTrees.get(request.toolUseId) === shell) shell.tree = tree;
      else this.shellTrees.delete(request.toolUseId);
    }
    return undefined;
  }

  private roleRefusal(chat: Chat, request: PermissionRequest): string | undefined {
    const file = this.editTarget(chat, request);
    if (file === undefined || !this.isBrainRecord(file)) return undefined;
    return 'Refused by hos: hos itself writes history and every PROGRESS.md in the brain, so two chats never clash on one file. Call the hos bus tool history_append or progress_update instead.';
  }

  private writeScopeRefusal(chat: Chat, request: PermissionRequest): string | undefined {
    const file = this.editTarget(chat, request);
    if (file === undefined || this.isHandoffFile(chat.id, request.tool, request.input)) return undefined;
    const { profile } = profileFor(this.profiles(), chat.profile);
    if (profile.writeScope !== 'work_dir') return undefined;
    const topic = this.store.getTopic(chat.topicId)!;
    const { brainDir } = this.options;
    const workDir = this.workDirAbs(topic) ?? (brainDir ? join(brainDir, this.workRoot()) : null);
    const roots = [workDir, brainDir ? join(brainDir, '.context', 'topics', topic.statusTopic) : null].filter((root): root is string => root !== null);
    if (insideAny(roots, file)) return undefined;
    return `Refused by hos: ${profile.id} profile: hand edits to an engineer chat. This chat writes only inside ${roots.join(' and ') || 'no folder (its topic has no work folder)'}, and ${file} is outside.`;
  }

  private editTarget(chat: Chat, request: PermissionRequest): string | undefined {
    const field = EDIT_FIELDS[request.tool];
    const path = field ? ((request.input ?? {}) as Record<string, unknown>)[field] : undefined;
    return typeof path === 'string' && path ? resolve(this.sessionCwd(chat), path) : undefined;
  }

  private isBrainRecord(file: string): boolean {
    const { brainDir } = this.options;
    if (!brainDir) return false;
    return inside(join(brainDir, 'history'), file) || (inside(join(brainDir, this.workRoot()), file) && basename(file) === PROGRESS_FILE);
  }

  private async checkShellWrites(chatId: string, before: string, editedByOthers: Set<string>): Promise<void> {
    const chat = this.store.getChat(chatId)!;
    const cwd = this.chatCwd(chat);
    const after = await snapshotTree(cwd);
    const artifact = this.store.spawnMeta(chatId).returnContract?.artifact;
    const owners = new Map<string, string[]>();
    const problems = (await changedFiles(cwd, before, after)).flatMap(({ path }) => {
      if (editedByOthers.has(resolve(cwd, path))) return [];
      const lock = this.locks.holder(chat, path);
      if (lock) {
        owners.set(lock.chatId, [...(owners.get(lock.chatId) ?? []), path]);
        return [`${path} (inside ${this.locks.describe(lock)})`];
      }
      if (editsOnlyOwned(chat) && !owns(chat, path) && path !== artifact) return [`${path} (outside its owned files ${ownedText(chat)})`];
      return [];
    });
    if (!problems.length) return;
    this.addInbox(
      chatId,
      'alert',
      'Shell edit outside its files',
      `${chatLabel(chat)} changed files through the shell that were not its to change: ${problems.join('; ')}. hos found this after the command ran; review these files before merging (git diff ${before.slice(0, 12)} ${after.slice(0, 12)} in ${cwd}).`,
    );
    const now = this.clock.now();
    for (const [owner, paths] of owners) {
      this.store.insertNotice(owner, `chat ${chatId.slice(0, 8)} (${chat.role}) changed files inside your lock through the shell: ${paths.join(', ')}; check them`, now);
    }
  }

  private needsDecision(chatId: string, request: PermissionRequest): boolean {
    if (request.tool === QUESTION_TOOL) return true;
    const chat = this.store.getChat(chatId)!;
    return this.verdict(chat, request.tool, request.input).outcome !== 'auto';
  }

  private requestApproval(chatId: string, request: PermissionRequest, given?: { verdict: Verdict; id: string }): Promise<PermissionDecision> {
    if (request.tool === QUESTION_TOOL) return this.askQuestion(chatId, request);
    const chat = this.store.getChat(chatId)!;
    const verdict = given?.verdict ?? this.verdict(chat, request.tool, request.input);
    const approval: Approval = {
      id: given?.id ?? randomUUID(),
      chatId,
      topicId: chat.topicId,
      tool: request.tool,
      input: summarize(JSON.stringify(request.input)),
      actionClass: verdict.actionClass,
      outcome: verdict.outcome,
      reason: verdict.reason,
      decision: null,
      via: null,
      decidedBy: null,
      createdAt: this.clock.now(),
      decidedAt: null,
    };
    if (verdict.outcome === 'auto' || verdict.outcome === 'deny') {
      const decision = verdict.outcome === 'auto' ? 'approve' : 'deny';
      this.record(
        { type: 'approval.policy', chatId, approvalId: approval.id, tool: request.tool, actionClass: verdict.actionClass, decision, reason: verdict.reason },
        () => this.store.insertApproval({ ...approval, decision, via: 'policy', decidedAt: approval.createdAt }),
      );
      return Promise.resolve(decision === 'deny' ? { deny: `Denied by hos policy: ${verdict.reason}.` } : decision);
    }
    return new Promise((resolve) => {
      this.pending.set(approval.id, resolve);
      this.topicActivity(chatId);
      this.record(
        {
          type: 'approval.requested',
          chatId,
          topicId: chat.topicId,
          approvalId: approval.id,
          toolUseId: request.toolUseId,
          tool: request.tool,
          ...(request.title ? { title: request.title } : {}),
          input: approval.input,
          actionClass: verdict.actionClass,
          reason: verdict.reason,
          outcome: verdict.outcome,
        },
        () => this.store.insertApproval(approval),
      );
    });
  }

  private askQuestion(chatId: string, request: PermissionRequest): Promise<PermissionDecision> {
    const questions = ((request.input ?? {}) as { questions?: Question[] }).questions ?? [];
    return new Promise((resolve) => {
      const item = this.addInbox(chatId, 'question', 'Question', questions.map((q) => q.question).join('\n'), { questions });
      this.pending.set(item.id, resolve);
    });
  }

  private verdict(chat: Chat, tool: string, input: unknown): Verdict {
    const { brainDir, policy } = this.options;
    if (tool !== 'Read' && this.isHandoffFile(chat.id, tool, input)) {
      return { actionClass: 'A3', outcome: 'auto', reason: 'A3 local_write: the chat’s own handoff file' };
    }
    return evaluate(policy, tool, input, {
      cwd: this.sessionCwd(chat),
      roots: this.chatRoots(chat),
      ...(brainDir ? { brainDir } : {}),
      configDir: this.config.dir,
    });
  }

  private settle(id: string, decision: PermissionDecision): void {
    this.pending.get(id)?.(decision);
    this.pending.delete(id);
  }

  private openItem(itemId: string): InboxItem {
    const item = this.store.getInboxItem(itemId);
    if (!item) throw new HosError(404, `no inbox item ${itemId}`);
    if (item.state !== 'open') throw new HosError(409, `inbox item ${itemId} is already done`);
    return item;
  }

  private addInbox(chatId: string | null, kind: InboxItem['kind'], title: string, detail: string, extra: Partial<InboxItem> = {}): InboxItem {
    const item: InboxItem = {
      id: randomUUID(),
      kind,
      chatId,
      title,
      detail: summarize(detail),
      state: 'open',
      createdAt: this.clock.now(),
      ...extra,
    };
    if (ASKING_KINDS.has(kind)) this.topicActivity(chatId);
    this.record({ type: 'inbox.added', item }, () => this.store.saveInboxItem(item));
    return item;
  }

  private saveInbox(item: InboxItem): void {
    this.record({ type: 'inbox.updated', item }, () => this.store.saveInboxItem(item));
  }

  private setState(chatId: string, state: ChatState, write?: () => void): void {
    this.record({ type: 'chat.state', chatId, state }, () => {
      if (isBusy(state) && this.store.getChat(chatId)?.state === 'done') this.store.clearResult(chatId);
      this.store.setChatState(chatId, state);
      write?.();
    });
    if (ENDED_STATES.has(state)) this.locks.releaseChat(chatId, 'ended');
    if (!isBusy(state)) for (const wake of [...(this.waiters.get(chatId) ?? [])]) wake();
    if (!isBusy(state)) this.pump();
  }

  private waitReply(callerId: string, chatId: string): BusReply {
    this.store.dropNoticesAbout(callerId, chatId, this.clock.now());
    const chat = this.store.getChat(chatId)!;
    const { result } = this.store.spawnMeta(chatId);
    const line = (result?.summary ?? this.lastReplies.get(chatId) ?? '').split('\n').find((l) => l.trim()) ?? '(no reply yet)';
    return {
      outcome: 'ok',
      text: [
        senderLabel(chat),
        `Chat ${this.bus.chatName(chat)} (${chat.role}) is ${chat.state}.`,
        `Result: ${line.trim().slice(0, ONE_LINE_CHARS)}`,
        ...(result?.artifact ? [`Artifact: ${result.artifact}`] : []),
        ...(result ? ['Summary:', result.summary] : []),
      ].join('\n'),
    };
  }

  private record(body: EventBody, write?: () => void): HosEvent {
    const event = this.store.transaction(() => {
      write?.();
      return this.store.appendEvent(body, this.clock.now());
    });
    // Folded before the listeners, since a listener can record a newer event synchronously.
    this.ui?.apply(event);
    if (this.ui && !this.uiSaveQueued && this.ui.seq - this.uiSavedSeq >= UI_SAVE_EVERY) {
      this.uiSaveQueued = true;
      setImmediate(() => {
        this.uiSaveQueued = false;
        if (!this.stopped) this.saveUi();
      });
    }
    for (const listener of this.listeners) listener(event);
    return event;
  }
  private brainCommits: BrainCommits | null = null;
  private readonly sessionDirs = new Map<string, string>();
  private readonly staleSessions = new Set<string>();
  private readonly liveSubagents = new Map<string, Set<string>>();
  private readonly liveShells = new Map<string, Set<string>>();
  private readonly lastTokens = new Map<string, number>();
  private readonly unstarted = new Map<string, number>();

  private sessionCwd(chat: Chat): string {
    const stored = this.store.chatSessionCwd(chat.id);
    if (stored) return stored;
    const { brainDir } = this.options;
    if (chat.worktreePath || !brainDir || this.store.getChatNativeSession(chat.id)) return this.chatCwd(chat);
    return brainDir;
  }

  private chatRoots(chat: Chat): string[] {
    const topic = this.store.getTopic(chat.topicId);
    const folders = topic ? this.topicFolders(topic).filter((w) => w.archivedAt === null).map((w) => w.path) : [];
    const roots = [this.options.brainDir, ...folders, chat.worktreePath, ...(this.options.tempRoots ?? TEMP_ROOTS)];
    const known = roots.filter((root): root is string => Boolean(root));
    return [...new Set(known.length ? known : [this.chatCwd(chat)])];
  }

  private readyDirs(chat: Chat, cwd: string): string[] {
    const topic = this.store.getTopic(chat.topicId);
    if (!topic) return [];
    return this.topicFolders(topic)
      .filter((w) => w.archivedAt === null && w.setup === 'ready' && w.path !== cwd && existsSync(w.path))
      .map((w) => w.path);
  }

  private async topicScratch(topicId: string): Promise<void> {
    const { brainDir } = this.options;
    const topic = this.store.getTopic(topicId);
    if (!brainDir || !topic) return;
    const root = join(brainDir, '.context', 'topics', topic.statusTopic);
    const workDir = this.workDirAbs(topic);
    await Promise.all([...['scratch', 'attachments', 'raw'].map((dir) => join(root, dir)), ...(workDir ? [workDir] : [])].map((dir) => mkdir(dir, { recursive: true }))).catch(() => {});
  }

  private policyContextVerdict(chat: Chat, tool: string, input: unknown, roots?: string[]): Verdict {
    const { policy, brainDir } = this.options;
    return evaluate(policy, tool, input, {
      cwd: this.sessionCwd(chat),
      roots: roots ?? this.chatRoots(chat),
      ...(brainDir ? { brainDir } : {}),
    });
  }

  private workspacesChanged(topic: Topic): void {
    for (const chat of this.store.chatsInTopic(topic.id)) {
      if (!this.sessions.has(chat.id)) continue;
      if (this.readyDirs(chat, this.sessionCwd(chat)).join('\n') === this.sessionDirs.get(chat.id)) continue;
      this.staleSessions.add(chat.id);
      this.refreshIfStale(chat.id);
    }
  }

  private trackSubagent(chatId: string, event: Extract<AgentEvent, { type: `subagent.${string}` }>): void {
    if (event.type === 'subagent.progress') return;
    const live = this.liveSubagents.get(chatId) ?? new Set<string>();
    if (event.type === 'subagent.started') live.add(event.toolUseId);
    else live.delete(event.toolUseId);
    if (live.size) return void this.liveSubagents.set(chatId, live);
    this.liveSubagents.delete(chatId);
    // Claude may start a turn to read the finished result; let it begin before a stale session is stopped.
    if (event.type === 'subagent.finished') {
      this.clock.setTimeout(() => {
        this.refreshIfStale(chatId);
        this.whenQuiet(chatId);
      }, SUBAGENT_SETTLE_MS);
    }
  }

  private trackShell(chatId: string, event: Extract<AgentEvent, { type: `shell.${string}` }>): void {
    const live = this.liveShells.get(chatId) ?? new Set<string>();
    if (event.type === 'shell.started') live.add(event.taskId);
    else live.delete(event.taskId);
    if (live.size) this.liveShells.set(chatId, live);
    else this.liveShells.delete(chatId);
  }

  private noticeEndedShells(): void {
    const now = this.clock.now();
    const at = new Date(now).toTimeString().slice(0, 5);
    const byChat = new Map<string, Array<{ taskId: string; description: string }>>();
    for (const shell of this.store.liveShells()) {
      this.record({ type: 'shell.finished', chatId: shell.chatId, taskId: shell.taskId });
      if (!this.chatComputer(shell.chatId)) byChat.set(shell.chatId, [...(byChat.get(shell.chatId) ?? []), shell]);
    }
    for (const [chatId, shells] of byChat) {
      const names = shells.map((shell) => `"${firstLine(shell.description, NOTICE_CHARS)}" (${shell.taskId})`).join(', ');
      const text = `hos restarted at ${at}; your background command(s) ${names} ended with it and won't notify you. Check their output files and rerun what you still need.`;
      this.store.insertNotice(chatId, text, now);
    }
  }

  private endSubagents(chatId: string): void {
    const live = this.liveSubagents.get(chatId);
    this.liveSubagents.delete(chatId);
    this.liveShells.delete(chatId);
    for (const toolUseId of live ?? []) this.record({ type: 'subagent.finished', chatId, toolUseId, status: 'stopped', summary: '' });
  }

  private refreshIfStale(chatId: string): void {
    if (!this.staleSessions.has(chatId)) return;
    const chat = this.store.getChat(chatId);
    if (!chat || isBusy(chat.state) || this.dispatched.has(chatId) || this.inTurn.has(chatId) || this.inTerminal.has(chatId) || this.unstarted.has(chatId)) return;
    if (this.liveSubagents.has(chatId) || this.liveShells.has(chatId)) return;
    this.staleSessions.delete(chatId);
    const session = this.sessions.get(chatId);
    this.sessions.delete(chatId);
    void session?.then((s) => s.stop()).catch(() => {});
  }
  private lifecycle!: WorkspaceLifecycle;

  get workspaces(): WorkspaceLifecycle {
    return this.lifecycle;
  }

  private askOwner(chatId: string, command: string, title: string): Promise<boolean> {
    const verdict: Verdict =
      this.options.policy.A3.lane_t === 'auto'
        ? { actionClass: 'A3', outcome: 'auto', reason: 'A3 local_write: auto' }
        : { actionClass: 'A3', outcome: 'ask_every_time', reason: `A3 local_write: removing a workspace folder with work in it asks ${owner()} every time` };
    return this.requestApproval(chatId, { toolUseId: randomUUID(), tool: 'Bash', input: { command }, title }, { verdict, id: randomUUID() }).then((d) => d === 'approve');
  }
  async chooseWorkspace(chatId: string, input: { repo: string; why: string; suggest?: string; said?: string; branch?: string; purpose?: 'read' | 'edit' }): Promise<BusReply> {
    const chat = this.requireChat(chatId);
    const topic = this.requireTopic(chat.topicId);
    const why = input.why.trim();
    const choices = await this.projectChoices();
    const resolution = resolveProject(input.repo, choices);
    if (!('project' in resolution)) {
      const options = resolution.candidates.filter(({ project }) => !project.hidden).slice(0, 3).map(({ project }) => ({ label: project.key ?? project.name, description: project.path }));
      options.push({ label: 'None of these', description: 'Reply with the path or LOCATIONS key' });
      const matches = resolution.candidates.length ? `matches ${resolution.candidates.length} repos` : 'matches no repo hos knows';
      const question: Question = { question: `Which repo did you mean by "${input.repo}"? (${why})`, header: 'Repo', options, multiSelect: false };
      this.addInbox(chatId, 'question', 'Which repo?', `"${input.repo}" ${matches}. ${why}`, { questions: [question], parked: true });
      this.setState(chatId, 'waiting_input');
      return {
        outcome: 'ok',
        text: `"${input.repo}" ${matches}, and hos never guesses. Asked ${owner()} which repo you meant; end your turn, their answer arrives as your next message. Then call workspace_choose again with the key they picked.`,
      };
    }
    const { project } = resolution;
    const repo = project.key ?? project.name;
    if (input.purpose === 'read') {
      const workspace = await this.createWorkspace({ projectId: project.id, kind: 'root' });
      this.attachWorkspace(topic.id, workspace.id);
      this.record({ type: 'workspace.picked', topicId: topic.id, chatId, workspaceId: workspace.id, created: false, purpose: 'read', repo, branch: workspace.branch, setup: workspace.setup });
      return {
        outcome: 'ok',
        text: `Reading ${repo} in its root checkout ${workspace.path} (branch ${workspace.branch ?? 'detached'}); it is now in this topic's workspaces. If the work turns into edits, edit there, or call workspace_choose with purpose edit for a worktree.`,
      };
    }
    const said = input.said?.trim();
    const flat = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();
    if (said && this.store.humanMessages(chatId).some((text) => flat(text).includes(flat(said)))) {
      const picker = await this.pickerQuestion(project, repo, topic.id, why, input.suggest, input.branch);
      const option = namedOption(picker.options, input.suggest);
      if (option) {
        const { workspace: opened, created } = await this.optionWorkspace(project, picker, option.value, picker.suggestedBranch ?? undefined);
        this.attachWorkspace(topic.id, opened.id);
        const workspace = this.store.getWorkspace(opened.id) ?? opened;
        this.record({ type: 'workspace.picked', topicId: topic.id, chatId, workspaceId: workspace.id, created, said, repo, branch: workspace.branch, setup: workspace.setup });
        const kind = workspace.kind === 'root' ? 'root checkout' : created ? `new worktree from ${picker.base}` : 'worktree';
        return { outcome: 'ok', text: `${ownerStart()} said "${said}", so no picker: working in ${repo} · ${workspace.branch ?? workspace.name} at ${workspace.path} (${kind}, setup ${workspace.setup})` };
      }
    }
    const rule = ruleFor(await loadWorkspaceRules(this.options.brainDir), project);
    if (rule?.use) {
      const { workspace, created } = await this.ruleWorkspace(project, rule.use);
      this.attachWorkspace(topic.id, workspace.id);
      this.record({ type: 'workspace.picked', topicId: topic.id, chatId, workspaceId: workspace.id, created, rule: rule.reason, repo, branch: workspace.branch, setup: workspace.setup });
      return { outcome: 'ok', text: `Working in ${repo} · ${workspace.branch ?? workspace.name} at ${workspace.path} (brain rule: ${rule.reason})` };
    }
    const picker = await this.pickerQuestion(project, repo, topic.id, why, input.suggest, input.branch);
    this.addInbox(chatId, 'question', `Which ${repo} checkout? (${project.path})`, why, { picker, parked: true, topicId: topic.id });
    this.setState(chatId, 'waiting_input');
    return { outcome: 'ok', text: `Asked ${owner()} which ${repo} checkout to use; end your turn, their pick arrives as your next message` };
  }

  async pickWorkspace(itemId: string, choice: string, branch: string | undefined, origin: DecisionOrigin): Promise<{ workspace: Workspace; created: boolean }> {
    if (origin.chatId !== undefined) throw new HosError(403, `only ${owner()} can pick a workspace; chats cannot`);
    const item = this.openItem(itemId);
    const picker = item.picker;
    if (!picker) throw new HosError(400, `inbox item ${itemId} is not a workspace picker`);
    const project = this.requireProject(picker.projectId);
    const opened = await this.optionWorkspace(project, picker, choice, branch);
    const created = opened.created;
    let workspace = opened.workspace;
    const chat = item.chatId ? this.store.getChat(item.chatId) : undefined;
    const topicId = item.topicId ?? chat?.topicId;
    if (!topicId) throw new HosError(400, `inbox item ${itemId} belongs to no topic`);
    this.attachWorkspace(topicId, workspace.id);
    workspace = this.store.getWorkspace(workspace.id) ?? workspace;
    this.saveInbox({ ...item, state: 'done' });
    this.settle(itemId, { answers: { [picker.repo]: choice } });
    this.record({ type: 'workspace.picked', topicId, chatId: item.chatId, workspaceId: workspace.id, created, repo: picker.repo, branch: workspace.branch, setup: workspace.setup });
    if (item.parked && chat) {
      const kind = workspace.kind === 'root' ? 'root checkout' : created ? `new worktree from ${picker.base}` : 'worktree';
      const text = `[hos] ${ownerStart()} picked ${picker.repo} · ${workspace.branch ?? workspace.name} at ${workspace.path} (${kind}, setup ${workspace.setup})`;
      void this.deliverLater(chat.id, text, 0).catch(() => {});
    }
    return { workspace, created };
  }

  private async optionWorkspace(project: Project, picker: PickerQuestion, choice: string, branch: string | undefined): Promise<{ workspace: Workspace; created: boolean }> {
    const option = picker.options.find((o) => o.value === choice);
    if (!option) throw new HosError(400, `${choice} is not an option of this picker`);
    if (option.kind === 'new') {
      const name = branch?.trim() ?? '';
      const problem = branchProblem(name);
      if (problem) throw new HosError(400, problem);
      if (existsSync(this.worktreePathFor(project, name)) || (await resolveCommit(project.path, `refs/heads/${name}`))) {
        throw new HosError(409, `A worktree on ${name} already exists`);
      }
      return { workspace: await this.createWorkspace({ projectId: project.id, kind: 'worktree', branch: name, baseRef: picker.base }), created: true };
    }
    if (choice.startsWith('path:')) {
      const path = choice.slice('path:'.length);
      return { workspace: await this.createWorkspace({ projectId: project.id, kind: path === project.path ? 'root' : 'worktree', path }), created: false };
    }
    return { workspace: this.requireWorkspace(choice), created: false };
  }

  async removePickerWorktree(itemId: string, choice: string, force: boolean, origin: DecisionOrigin): Promise<InboxItem> {
    if (origin.chatId !== undefined) throw new HosError(403, `only ${owner()} can remove a worktree; chats cannot`);
    const item = this.openItem(itemId);
    const picker = item.picker;
    if (!picker) throw new HosError(400, `inbox item ${itemId} is not a workspace picker`);
    const option = picker.options.find((o) => o.value === choice);
    if (!option) throw new HosError(400, `${choice} is not an option of this picker`);
    if (option.kind !== 'worktree' || !option.path) throw new HosError(400, 'only a worktree can be removed; the root checkout stays');
    const topicId = item.topicId ?? (item.chatId ? this.store.getChat(item.chatId)?.topicId : undefined);
    if (!topicId) throw new HosError(400, `inbox item ${itemId} belongs to no topic`);
    const project = this.requireProject(picker.projectId);
    const workspace = this.store.workspaceByPath(option.path);
    if (workspace && workspace.archivedAt === null) {
      const others = this.store.listTopics().filter((t) => t.state !== 'archived' && t.id !== topicId && t.workspaceIds.includes(workspace.id));
      if (others.length) throw new HosError(409, `${workspace.name} is used by ${others.map((t) => t.title).join(', ')}; archive it from there`);
      await this.workspaces.archive(workspace.id, force);
    } else {
      await this.exclusive(() => this.refreshProject(project));
      await this.removeWorktree(option.path, force);
    }
    const fresh = await this.pickerQuestion(project, picker.repo, topicId, picker.why, picker.suggested, picker.suggestedBranch ?? undefined);
    const updated = { ...item, picker: fresh };
    this.saveInbox(updated);
    return updated;
  }

  async fetchWorkspace(workspaceId: string): Promise<{ detail: string }> {
    const workspace = this.requireWorkspace(workspaceId);
    const branch = workspace.kind === 'worktree' && workspace.base ? workspace.base.replace(/^origin\//, '') : undefined;
    const fetched = await fetchOrigin(workspace.path, FETCH_TIMEOUT_MS, branch).catch((error: Error) => {
      throw new HosError(400, `fetch of origin failed: ${error.message}`);
    });
    if (!fetched) throw new HosError(400, `${workspace.name} has no origin remote to fetch from`);
    for (const other of this.store.listWorkspaces()) if (other.projectId === workspace.projectId) this.gitChanged(other.id);
    return { detail: `Fetched origin${branch ? `/${branch}` : ''}` };
  }

  async defaultBase(project: Project): Promise<string> {
    const rule = ruleFor(await loadWorkspaceRules(this.options.brainDir), project);
    return rule?.base ?? (await originDefaultBranch(project.path)) ?? (await currentBranch(project.path).catch(() => null)) ?? 'HEAD';
  }

  async freshBaseRef(project: Project, base: string): Promise<string> {
    const branch = base.replace(/^origin\//, '');
    await fetchOrigin(project.path, CREATE_FETCH_TIMEOUT_MS, branch).catch((error: Error) => console.warn(`fetch of origin ${branch} in ${project.path} failed, cutting from the last fetched copy: ${error.message}`));
    const remote = await compareRef(project.path, branch);
    return base === branch && (await localAhead(project.path, branch, remote)) ? branch : remote;
  }

  private async ruleWorkspace(project: Project, use: { kind: 'root' } | { kind: 'branch'; branch: string }): Promise<{ workspace: Workspace; created: boolean }> {
    if (use.kind === 'root') return { workspace: await this.createWorkspace({ projectId: project.id, kind: 'root' }), created: false };
    const entries = (await listWorktrees(project.path)) ?? [];
    const found = entries.find((e) => e.branch === use.branch);
    if (found) return { workspace: await this.createWorkspace({ projectId: project.id, kind: found.path === project.path ? 'root' : 'worktree', path: found.path }), created: false };
    return { workspace: await this.createWorkspace({ projectId: project.id, kind: 'worktree', branch: use.branch }), created: true };
  }

  private async pickerQuestion(project: Project, repo: string, topicId: string, why: string, suggest: string | undefined, branch: string | undefined): Promise<PickerQuestion> {
    const entries = (await listWorktrees(project.path)) ?? [];
    const base = await this.defaultBase(project);
    const topics = this.store.listTopics().filter((t) => t.state !== 'archived');
    const options: PickerOption[] = await Promise.all(
      entries.map(async (entry, index): Promise<PickerOption> => {
        const root = index === 0;
        const workspace = this.store.workspaceByPath(entry.path);
        const usedBy = workspace ? topics.filter((t) => t.workspaceIds.includes(workspace.id)).map((t) => ({ topicId: t.id, title: t.title })) : [];
        const { state, warn } = await optionState(entry.path, entry.branch, root ? entry.branch : (workspace?.base ?? base), root, workspace);
        return {
          value: workspace?.id ?? `path:${entry.path}`,
          kind: root ? 'root' : 'worktree',
          branch: entry.branch,
          path: entry.path,
          state,
          warn,
          usedBy,
        };
      }),
    );
    options.push({ value: 'new', kind: 'new', branch: null, path: null, state: 'new branch, nobody else on it', warn: false, usedBy: [] });
    const taken = new Set(entries.flatMap((e) => (e.branch ? [e.branch] : [])));
    let suggestedBranch = branch?.trim() || `hos/${branchSlug(why)}`;
    if (taken.has(suggestedBranch) || (await resolveCommit(project.path, `refs/heads/${suggestedBranch}`))) {
      const wanted = suggestedBranch;
      for (let i = 2; ; i++) {
        suggestedBranch = `${wanted}-${i}`;
        if (!taken.has(suggestedBranch) && !(await resolveCommit(project.path, `refs/heads/${suggestedBranch}`)) && !existsSync(this.worktreePathFor(project, suggestedBranch))) break;
      }
    }
    return { repo, projectId: project.id, why, options, suggested: suggestedValue(options, suggest, topicId), suggestedBranch, base };
  }
  private readonly changes: Changes;
  private readonly gitPending = new Set<string>();

  async topicPanel(topicId: string): Promise<PanelWorkspace[]> {
    await this.lifecycle.syncTopic(this.requireTopic(topicId));
    return this.changes.panel(this.requireTopic(topicId));
  }

  async pushWorkspace(workspaceId: string): Promise<DiffActionResult> {
    const workspace = this.requireWorkspace(workspaceId);
    const branch = await currentBranch(workspace.path);
    if (branch === 'HEAD') throw new HosError(400, `${workspace.name} is on a detached HEAD; check out a branch first`);
    return this.humanAction(workspace, 'push', 'Push', `git push -u origin ${branch}`, () => pushBranch(workspace.path, branch));
  }

  async pullWorkspace(workspaceId: string): Promise<DiffActionResult> {
    const workspace = this.requireWorkspace(workspaceId);
    return this.humanAction(workspace, 'pull', 'Pull', 'git pull --ff-only', () => pullFastForward(workspace.path));
  }

  async reviewWorkspace(workspaceId: string): Promise<{ reviewerId: string | null; detail: string }> {
    const workspace = this.requireWorkspace(workspaceId);
    this.requireSetupReady(workspace);
    const topic = this.store.topicsUsing(workspaceId).find((t) => t.state !== 'archived');
    if (!topic) throw new HosError(400, `${workspace.name} is not used by any topic, so there is nobody to review for`);
    const parent = this.recentChat(topic);
    if (!parent) throw new HosError(400, `topic "${topic.title}" has no chat that could own a review`);
    const base = workspace.base ?? 'its base';
    const { from, changed } = await this.changes.diffAgainstBase(workspace);
    if (!changed.files.length) throw new HosError(400, `${workspace.name} has no changes against ${base} to review`);
    const prompt = [
      `Review the changes in workspace ${workspace.name} (${workspace.path}, branch ${workspace.branch ?? 'HEAD'}) against ${base}. ${ownerStart()} asked for this review in the Workspaces panel.`,
      `Changed files: ${changed.files.map((f) => `${f.path} (${f.status}, +${f.additions} −${f.deletions})`).join(', ')}.`,
      `Read the whole diff with: git -C ${workspace.path} diff ${from}`,
      `List each problem with its file:line in your complete summary (or an artifact), with a short verdict. You only read; you never edit.`,
    ].join('\n');
    const reply = await this.spawn(
      parent.id,
      {
        role: 'reviewer',
        intent: `Review the changes in ${workspace.name} against ${base}`,
        prompt,
        files_owned: [],
        return_contract: { summary_tokens: 800 },
        client_request_id: `panel-review-${workspace.id}-${from.slice(0, 8)}`,
        confirm_similar: true,
      },
      { worktreePath: workspace.path, fromHos: true },
    );
    if (!reply.chatId) return { reviewerId: null, detail: reply.text };
    this.gitChanged(workspace.id);
    return { reviewerId: reply.chatId, detail: reply.text };
  }

  private firstLineage(topic: Topic): string | undefined {
    if (topic.desk) return undefined;
    const heads = this.store
      .chatsInTopic(topic.id)
      .filter((chat) => chat.generation === 1)
      .sort((a, b) => a.createdAt - b.createdAt);
    return (heads.find((chat) => !chat.parentId) ?? heads[0])?.lineageId;
  }

  private recentChat(topic: Topic): Chat | undefined {
    if (topic.desk) return undefined;
    const activeAt = (chat: Chat) => this.store.progress(chat.id).at ?? chat.createdAt;
    return this.store
      .chatsInTopic(topic.id)
      .filter((chat) => chat.role === 'main' && isLive(chat.state))
      .sort((a, b) => activeAt(b) - activeAt(a))[0];
  }

  // Coalesced per tick: one turn end can trigger this from several places, and the panel only needs one refetch.
  private gitChanged(workspaceId: string): void {
    if (this.stopped || this.gitPending.has(workspaceId)) return;
    this.gitPending.add(workspaceId);
    void Promise.resolve().then(() => {
      this.gitPending.delete(workspaceId);
      if (!this.stopped && this.store.getWorkspace(workspaceId)) this.record({ type: 'workspace.git', workspaceId });
    });
  }
  proposePlan(chatId: string, input: { title: string; summary?: string }): BusReply {
    const chat = this.requireChat(chatId);
    const topic = this.store.getTopic(chat.topicId)!;
    if (topic.state === 'archived') return { outcome: 'refused', text: `Refused: topic "${topic.title}" is archived.` };
    for (const item of this.store.openInboxItems(chatId)) {
      if (item.kind === 'plan') this.saveInbox({ ...item, state: 'done', resolution: 'Replaced by a newer plan' });
    }
    const title = input.title.trim();
    this.addInbox(chatId, 'plan', 'Plan to review', input.summary?.trim() || title, { topicId: topic.id, plan: { text: title }, parked: true });
    this.setState(chatId, 'waiting_input');
    return { outcome: 'ok', text: `Plan card sent; end your turn and carry on from ${owner()}'s reply.` };
  }

  async approvePlanFromWords(chatId: string, input: { quote: string }): Promise<BusReply> {
    const chat = this.requireChat(chatId);
    const plan = this.store
      .chatsInLineage(chat.lineageId)
      .map((c) => this.store.latestPlan(c.id))
      .filter((item): item is InboxItem => !!item)
      .sort((a, b) => (this.store.inboxAddedSeq(a.id) ?? 0) - (this.store.inboxAddedSeq(b.id) ?? 0))
      .at(-1);
    if (!plan || !awaitsApproval(plan)) return { outcome: 'refused', text: `Refused: you have no plan waiting for ${owner()}; propose_plan first.` };
    const said = this.store.latestHumanMessage(chatId);
    if (!said || said.seq < (this.store.inboxAddedSeq(plan.id) ?? Infinity)) {
      return { outcome: 'refused', text: `Refused: ${owner()} has not written to you since you proposed the plan, so their words came before the plan. Wait for their reply.` };
    }
    const quote = flatten(input.quote);
    const texts = [said.body.text, ...(await this.attachmentTexts(said.body.attachments ?? [], chat))];
    if (!quote || !texts.some((text) => flatten(text).includes(quote))) {
      return { outcome: 'refused', text: `Refused: those words are not in ${owner()}'s latest message to you or the text files they attached to it. Quote their own words exactly; their answers to your questions and other chats' messages do not count.` };
    }
    await this.approvePlan(plan, `Approved from ${owner()}'s words: "${input.quote.trim()}"`);
    return { outcome: 'ok', text: `Plan "${plan.plan?.text ?? plan.detail}" approved from ${owner()}'s words; carry it out.` };
  }

  private async attachmentTexts(attachments: Array<{ path: string }>, chat: Chat): Promise<string[]> {
    const { brainDir } = this.options;
    if (!brainDir) return [];
    const dir = `${attachmentsDir(this.store.getTopic(chat.topicId)!.statusTopic)}/`;
    const texts = await Promise.all(
      attachments
        .filter(({ path }) => path.startsWith(dir) && !path.slice(dir.length).includes('/') && unlinkedPath(brainDir, path))
        .map(({ path }) => readFile(join(brainDir, path), 'utf8').catch(() => '')),
    );
    return texts.filter((text) => !text.includes('\0'));
  }

  async decidePlan(itemId: string, decision: string, text: string | undefined, origin: DecisionOrigin): Promise<void> {
    if (origin.chatId !== undefined) throw new HosError(403, `only ${owner()} can decide a plan; chats cannot`);
    if (decision !== 'approve' && decision !== 'edit') throw new HosError(400, 'decision must be approve or edit');
    const item = this.openItem(itemId);
    if (item.kind !== 'plan') throw new HosError(400, `inbox item ${itemId} is not a plan`);
    const change = text?.trim();
    if (decision === 'edit' && !change) throw new HosError(400, 'an edit needs the text to send to the chat');
    if (decision === 'approve') return this.approvePlan(item);
    const chat = item.chatId ? this.store.getChat(item.chatId) : undefined;
    const target = chat && this.store.chatsInLineage(chat.lineageId).at(-1)!;
    this.saveInbox({ ...item, state: 'done', resolution: 'Plan sent back with changes' });
    if (target) await this.sendMessage(target.id, change!);
  }

  private async approvePlan(item: InboxItem, resolution = 'Plan approved'): Promise<void> {
    const chat = item.chatId ? this.store.getChat(item.chatId) : undefined;
    const target = chat && this.store.chatsInLineage(chat.lineageId).at(-1)!;
    this.saveInbox({ ...item, state: 'done', resolution });
    if (!target) return;
    await this.deliverLater(target.id, `[hos] ${ownerStart()} approved the plan "${item.plan?.text ?? item.detail}". Carry it out.`, 0);
  }

  async stopChat(chatId: string): Promise<Chat> {
    const chat = this.requireChat(chatId);
    if (this.inTerminal.has(chatId)) throw new HosError(409, `chat ${chatId} is taken over in a terminal; hand it back first`);
    if (isHalted(chat.state) || ENDED_STATES.has(chat.state) || chat.state === 'handed_off') return chat;
    await this.halt(chatId, 'paused');
    return this.requireChat(chatId);
  }

  async restartChat(chatId: string): Promise<Chat> {
    const chat = this.requireChat(chatId);
    if (this.inTerminal.has(chatId)) throw new HosError(409, `chat ${chatId} is taken over in a terminal; hand it back first`);
    if (chat.state === 'handed_off' || chat.state === 'archived') throw new HosError(409, `chat ${chatId} is ${chat.state}, so there is nothing to restart`);
    const session = this.sessions.get(chatId);
    this.sessions.delete(chatId);
    this.dispatched.delete(chatId);
    this.inTurn.delete(chatId);
    this.retired.delete(chatId);
    this.cancelApprovals(chatId);
    await session?.then((s) => s.stop()).catch(() => {});
    this.record({ type: 'chat.restarted', chatId });
    this.setState(chatId, 'idle');
    await this.resumeSession(this.requireChat(chatId)).catch(() => {});
    this.pump();
    return this.requireChat(chatId);
  }

  setChatPick(chatId: string, pick: { model?: string; effort?: string }): Chat {
    const chat = this.requireChat(chatId);
    if (pick.effort !== undefined && !EFFORTS.includes(pick.effort as Effort)) throw new HosError(400, `effort must be one of ${EFFORTS.join(', ')}`);
    if (pick.model !== undefined && !/^[\w.:-]{1,80}$/.test(pick.model)) throw new HosError(400, 'model must be a model name or alias, like sonnet or opus');
    const model = pick.model ?? chat.model;
    const effort = (pick.effort as Effort | undefined) ?? chat.effort;
    this.record({ type: 'chat.pick', chatId, model, effort }, () => this.store.setChatPick(chatId, model, effort));
    return { ...chat, model, effort };
  }

  setChatTabClosed(chatId: string, closed: boolean): Chat {
    const chat = this.requireChat(chatId);
    // The tab is keyed by lineage, so the flag lives on the lineage head the web closes and reopens.
    const head = this.requireChat(chat.lineageId);
    if (head.tabClosed === closed) return head;
    this.record({ type: 'chat.tab', chatId: head.id, closed }, () => this.store.setChatTabClosed(head.id, closed));
    return { ...head, tabClosed: closed };
  }

  setChatNotify(chatId: string, notify: unknown): Chat {
    const chat = this.requireChat(chatId);
    if (typeof notify !== 'boolean') throw new HosError(400, 'notify must be true or false');
    if (chat.notify === notify) return chat;
    this.record({ type: 'chat.notify', chatId, notify }, () => this.store.setChatNotify(chatId, notify));
    return { ...chat, notify };
  }

  setTabOrder(topicId: string, order: unknown): Topic {
    const topic = this.requireTopic(topicId);
    if (!Array.isArray(order) || !order.every((key) => typeof key === 'string')) throw new HosError(400, 'order must be a list of tab keys');
    const keys = [...new Set(order as string[])];
    this.record({ type: 'topic.tabs', topicId: topic.id, order: keys }, () => this.store.setTopicTabOrder(topic.id, keys));
    return { ...topic, tabOrder: keys };
  }

  async linkChat(chatId: string, to: { chatId?: string; diagramId?: string }): Promise<ChatLink[]> {
    const { lineageId } = this.requireChat(chatId);
    if (to.diagramId) {
      const diagram = await this.requireDiagrams().info(to.diagramId);
      this.addLink(lineageId, diagram.id, 'diagram', `${ownerStart()} linked diagram "${diagram.title}" to this chat`);
      return this.store.linksOf(lineageId);
    }
    if (!to.chatId) throw new HosError(400, 'give chatId or diagramId to link');
    const other = this.requireChat(to.chatId);
    if (other.lineageId === lineageId) throw new HosError(400, 'a chat cannot be linked with itself');
    if (this.store.linksOf(lineageId).some((link) => link.target === other.lineageId)) return this.store.linksOf(lineageId);
    for (const [from, peer] of [
      [lineageId, other.lineageId],
      [other.lineageId, lineageId],
    ] as const) {
      const latest = this.store.chatsInLineage(peer).at(-1)!;
      const where = this.store.getTopic(latest.topicId)?.title ?? latest.topicId;
      const told = this.store.chatsInLineage(from).at(-1)!;
      this.store.insertNotice(told.id, `${ownerStart()} linked you with chat ${latest.id.slice(0, 8)} (topic "${where}"): read it with chat_history, message it with send.`, this.clock.now(), false);
      this.addLink(from, peer, 'chat', `${ownerStart()} linked this chat with chat ${latest.id.slice(0, 8)} (topic "${where}")`);
    }
    return this.store.linksOf(lineageId);
  }

  unlinkChat(chatId: string, target: string): ChatLink[] {
    const { lineageId } = this.requireChat(chatId);
    const key = this.store.getChat(target)?.lineageId ?? target;
    const link = this.store.linksOf(lineageId).find((l) => l.target === key);
    if (!link) throw new HosError(404, `chat ${chatId} has no link to ${target}`);
    const ends = link.kind === 'chat' ? ([[lineageId, key], [key, lineageId]] as const) : ([[lineageId, key]] as const);
    for (const [from, to] of ends) {
      this.store.removeLink(from, to);
      this.record({ type: 'chat.links', lineageId: from, links: this.store.linksOf(from), chatId: this.store.chatsInLineage(from).at(-1)!.id, note: `${ownerStart()} unlinked this chat from ${link.kind === 'chat' ? `chat ${to.slice(0, 8)}` : `diagram ${to}`}` });
    }
    if (link.kind === 'diagram') this.record({ type: 'diagram.changed', id: key });
    return this.store.linksOf(lineageId);
  }

  private addLink(lineageId: string, target: string, kind: LinkKind, note?: string): void {
    if (this.store.linksOf(lineageId).some((link) => link.target === target)) return;
    this.store.addLink(lineageId, target, kind, this.clock.now());
    const latest = this.store.chatsInLineage(lineageId).at(-1);
    this.record({ type: 'chat.links', lineageId, links: this.store.linksOf(lineageId), ...(latest && note ? { chatId: latest.id, note } : {}) });
    if (kind === 'diagram' && !this.stopped) this.record({ type: 'diagram.changed', id: target });
  }

  async addTopicChat(
    topicId: string,
    pick: { model?: string; effort?: string; agent?: string; chrome?: boolean; notify?: boolean; profile?: string; computer?: string } = {},
    diagramId?: string,
  ): Promise<Chat> {
    const topic = this.reopenTopic(this.requireTopic(topicId));
    if (!this.options.brainDir) throw new HosError(400, 'hos has no brain (start it with --brain), so a new chat has nowhere to work');
    if (diagramId) await this.requireDiagrams().info(diagramId);
    const chat = this.elsewhere(pick.computer) ? (await this.startOnComputer(topic, pick, pick.computer)).chat! : await this.launchTopicChat(topic, pick);
    if (diagramId) await this.linkChat(chat.id, { diagramId });
    return chat;
  }

  private launchTopicChat(topic: Topic, pick: { model?: string; effort?: string; agent?: string; chrome?: boolean; notify?: boolean; profile?: string }): Promise<Chat> {
    const defaults = this.profileDefaults(pick.profile, pick.agent);
    const harness = this.harnessFor(defaults.agent);
    const models = harness.models();
    const model = pick.model ?? defaults.model ?? models.default;
    const effort = pick.effort ?? defaults.effort ?? models.effort;
    if (!EFFORTS.includes(effort as Effort)) throw new HosError(400, `effort must be one of ${EFFORTS.join(', ')}`);
    if (!/^[\w.:-]{1,80}$/.test(model)) throw new HosError(400, 'model must be a model id, like claude-opus-5-5');
    return this.launchChat(
      {
        ...this.newChat(topic.id, randomUUID(), 'main', 'human', harness.id),
        model,
        effort: effort as Effort,
        chrome: pick.chrome ?? defaults.browser,
        notify: pick.notify ?? true,
        profile: this.requireProfile(pick.profile),
      },
      topic,
    );
  }

  chatComputer(chatId: string): string | undefined {
    return this.store.getChat(chatId)?.computer;
  }

  async flushBrain(): Promise<string> {
    if (!this.brainCommits) throw new HosError(400, 'hos has no brain (start it with --brain), so it has nothing to share with another computer');
    return this.brainCommits.flush().catch((error: Error) => Promise.reject(new HosError(409, `brain not pushed: ${error.message}`)));
  }

  async syncBrainTo(sha: string): Promise<void> {
    if (!this.brainCommits) throw new HosError(400, 'hos has no brain (start it with --brain), so it can’t take chats from another computer');
    await this.brainCommits.syncTo(sha).catch((error: Error) => Promise.reject(new HosError(409, `brain behind: ${error.message}`)));
  }

  computersForChat(): BusReply {
    const { self, computers } = this.requireComputers().view();
    const rows = computers
      .filter((c) => c.direction === 'out')
      .map((c) => {
        const free = c.caps ? Object.entries(c.caps.slots).map(([pool, use]) => `${pool} ${Math.max(0, use.max - use.running)}`).join(', ') : 'unknown';
        return `- ${c.name} · ${c.online ? 'online' : 'offline'} · free slots: ${free} · ${c.caps?.browser ? 'Chrome' : 'no Chrome'}`;
      });
    return {
      outcome: 'ok',
      text: [`You run on ${self.name}. To run a chat on another computer, spawn it with computer: <name>.`, ...(rows.length ? rows : [`No computers are added here; ${owner()} adds them under Settings → Computers.`])].join('\n'),
    };
  }

  private async spawnOnComputer(parent: Chat, topic: Topic, name: string, request: SpawnRequest): Promise<BusReply & { chatId?: string }> {
    if (request.browser && this.requireComputers().target(name).caps?.browser === false) {
      return { outcome: 'refused', text: `Spawn denied: ${name} has no Chrome, so browser: true can’t run there.` };
    }
    const { agent, model, effort, browser } = request;
    const answer = await this.startOnComputer(topic, { agent, model, effort, chrome: browser }, name, { parent, request });
    return { outcome: answer.outcome ?? 'ok', text: answer.text ?? '', ...(answer.chat ? { chatId: answer.chat.id } : {}) };
  }

  async startOnComputer(
    topic: Topic,
    pick: { model?: string; effort?: string; agent?: string; chrome?: boolean; profile?: string },
    name: string,
    spawn?: { parent: Chat; request: SpawnRequest },
  ): Promise<RemoteChatAnswer> {
    const computers = this.requireComputers();
    computers.target(name);
    const workspaces: RemoteChatInput['workspaces'] = [];
    const local = topic.workspaceIds.flatMap((id) => this.store.getWorkspace(id) ?? []).filter((w) => w.archivedAt === null);
    const at = spawn?.request.workspace ? local.findIndex((w) => w.id === this.workspaces.workspaceForChat(spawn.parent.id, spawn.request.workspace!).id) : -1;
    for (const workspace of local) {
      const project = this.requireProject(workspace.projectId);
      if (!project.key) throw new HosError(422, `${project.name} has no LOCATIONS key, so ${name} can’t find its copy; add it to shared/LOCATIONS.md or detach it from this topic`);
      if (workspace.kind === 'worktree') {
        const status = await worktreeStatus(workspace.path, workspace.branch);
        if (!status.branch || !status.upstream || status.unpushed) {
          throw new HosError(409, `${workspace.name} ${status.upstream ? `has ${status.unpushed} unpushed commit(s)` : 'isn’t pushed'}; push its branch so ${name} can check it out`);
        }
      }
      workspaces.push({ projectKey: project.key, kind: workspace.kind, branch: workspace.kind === 'worktree' ? workspace.branch : null });
    }
    const brainSha = await this.flushBrain();
    const { model, effort, agent, chrome, profile } = pick;
    const input: RemoteChatInput = { topic: { id: topic.id, title: topic.title, statusTopic: topic.statusTopic, workDir: topic.workDir }, brainSha, workspaces, pick: { model, effort, agent, chrome, profile } };
    if (spawn) {
      const roster = this.store.chatsInTopic(topic.id).filter((c) => c.id !== spawn.parent.id && (LIVE_STATES as readonly string[]).includes(c.state));
      input.spawn = { parent: spawn.parent, roster, request: { ...spawn.request, computer: undefined, workspace: undefined }, ...(at >= 0 ? { workspace: at } : {}) };
    }
    await computers.listen(name);
    const answer = await computers.post<RemoteChatAnswer>(name, '/api/computer/chats', input);
    if (!answer.chat) return answer;
    const stub: Chat = { ...answer.chat, computer: name };
    if (!this.store.getChat(stub.id)) this.record({ type: 'chat.created', chat: stub }, () => (this.store.insertChat(stub), this.store.setRemoteSeq(stub.id, answer.seq)));
    return { ...answer, chat: stub };
  }

  async acceptRemoteChat(input: RemoteChatInput, caller: string): Promise<RemoteChatAnswer> {
    if (!this.options.brainDir) throw new HosError(400, 'hos has no brain (start it with --brain), so it can’t take chats from another computer');
    const projects = this.store.listProjects();
    const keys = projects.flatMap((project) => (project.key ? [project.key] : []));
    const missing = input.workspaces.map((w) => w.projectKey).filter((key) => !keys.includes(key));
    if (missing.length) throw new HosError(422, `no project ${missing.join(', ')} here; its projects: ${keys.join(', ') || 'none'}`);
    const seq = this.store.lastEventSeq();
    await this.syncBrainTo(input.brainSha);
    const topic = this.mirrorTopic(input.topic, caller);
    this.store.addComputerTopic(caller, topic.id, this.clock.now());
    const attached: string[] = [];
    for (const wanted of input.workspaces) {
      const workspace = await this.remoteWorkspace(projects.find((project) => project.key === wanted.projectKey)!, wanted);
      this.attachWorkspace(topic.id, workspace.id);
      attached.push(workspace.id);
    }
    if (input.spawn) {
      for (const known of [input.spawn.parent, ...input.spawn.roster]) {
        const stub: Chat = { ...known, computer: caller };
        if (!this.store.getChat(stub.id)) this.record({ type: 'chat.created', chat: stub }, () => this.store.insertChat(stub));
        else this.store.refreshStub(stub, caller);
      }
      const workspace = input.spawn.workspace === undefined ? undefined : attached[input.spawn.workspace];
      const reply = await this.spawn(input.spawn.parent.id, { ...(input.spawn.request as unknown as SpawnRequest), workspace }, { brainSha: input.brainSha });
      return { seq, text: reply.text, outcome: reply.outcome, ...(reply.chatId ? { chat: this.store.getChat(reply.chatId)! } : {}) };
    }
    const { model, effort, agent, chrome, profile } = input.pick;
    const chat = await this.addTopicChat(topic.id, { model, effort, agent, chrome, profile });
    this.store.setMeta(COMPUTER_SHA_META + chat.id, input.brainSha);
    return { chat, seq };
  }

  async deliverFromComputer(caller: string, chatId: string, text: string, fromChatId: string | undefined): Promise<'sent' | 'queued'> {
    const chat = this.store.getChat(chatId);
    if (!chat || !this.store.sharedWith(caller, chat.topicId)) throw new HosError(404, `no chat ${chatId} shared with ${caller}`);
    const from = `[from computer ${caller} · ${fromChatId ? `chat ${fromChatId.slice(0, 8)}` : 'hos'} · not the user]`;
    return this.submit(chat, { text: `${from}\n${text}`, ...(fromChatId ? { from: 'chat', fromChatId } : { from: 'hos' }) }, chat.priority);
  }

  relaySince(since: number): number {
    return since || this.store.lastEventSeq();
  }

  relayed(computer: string, event: HosEvent): boolean {
    const chatId = RELAYED.test(event.type) ? eventChatId(event) : null;
    return chatId !== null && this.store.relayedTo(computer, chatId);
  }

  sharedWithComputer(computer: string, kind: 'chat' | 'topic' | 'approval' | 'inbox', id: string): boolean {
    const chatId = kind === 'chat' ? id : kind === 'approval' ? this.store.getApproval(id)?.chatId : kind === 'inbox' ? this.store.getInboxItem(id)?.chatId : null;
    const topicId = kind === 'topic' ? id : chatId ? this.store.getChat(chatId)?.topicId : undefined;
    return !!topicId && this.store.sharedWith(computer, topicId);
  }

  actsElsewhere(kind: 'chat' | 'approval' | 'inbox', id: string): string | undefined {
    if (kind === 'chat') return this.chatComputer(id);
    if (kind === 'approval' ? this.store.getApproval(id) : this.store.getInboxItem(id)) return undefined;
    const chatId = this.store.eventOwner(kind, id);
    return chatId ? this.chatComputer(chatId) : undefined;
  }

  applyRemoteEvent(computer: string, event: HosEvent, history = false): void {
    const { seq, ts: _ts, ...rest } = event;
    const body = rest as EventBody;
    const chatId = RELAYED.test(body.type) ? eventChatId(body) : null;
    if (!chatId) return;
    const chat = this.store.getChat(chatId);
    if (!chat) {
      if (body.type !== 'chat.created' || !this.store.getTopic(body.chat.topicId)) return;
      const stub: Chat = { ...body.chat, computer };
      return void this.record({ type: 'chat.created', chat: stub }, () => (this.store.insertChat(stub), this.store.setRemoteSeq(chatId, seq)));
    }
    if (chat.computer !== computer || seq <= this.store.remoteSeq(chatId)) return;
    // Live events for a chat whose history isn't in yet would move remote_seq past it; the load fetches them instead.
    if (!history && (this.historyPending.has(chatId) || this.store.remoteSeq(chatId) === 0)) {
      if (!this.remoteLoads.has(chatId)) void this.loadRemoteChat(chatId).catch(() => {});
      return;
    }
    const seen = () => this.store.setRemoteSeq(chatId, seq);
    switch (body.type) {
      case 'chat.created':
        return seen();
      case 'chat.state':
        return this.setState(chatId, body.state, seen);
      case 'chat.titled':
        return void this.record(body, () => (this.store.setChatTitle(chatId, body.title, body.naming), seen()));
      case 'card.updated':
        return void this.record(body, () => (this.store.setCard(chatId, body.card), seen()));
      case 'chat.result': {
        this.record(body, () => (this.store.setResult(chatId, body.result), seen()));
        const parent = chat.parentId ? this.store.getChat(chat.parentId) : undefined;
        if (!parent || parent.computer) return;
        const artifact = body.result.artifact ? ` (artifact ${body.result.artifact})` : '';
        return this.store.insertNotice(parent.id, `chat ${chatId.slice(0, 8)} (${chat.role}) is done: ${firstLine(body.result.summary, NOTICE_CHARS)}${artifact}; wait on it for the full result`, this.clock.now(), true, chatId);
      }
      case 'message.completed':
        this.lastReplies.set(chatId, body.text);
        return void this.record(body, seen);
      default:
        return void this.record(body, seen);
    }
  }

  async openComputerTopic(name: string, topicId: string): Promise<Topic> {
    const known = this.store.getTopic(topicId);
    if (known) return known;
    const computers = this.requireComputers();
    computers.target(name);
    await computers.listen(name);
    return computers.run(name, () => this.mirrorComputerTopic(name, topicId));
  }

  private async mirrorComputerTopic(name: string, topicId: string): Promise<Topic> {
    const known = this.store.getTopic(topicId);
    if (known) return known;
    const { topic, chats } = await this.requireComputers().post<ComputerTopicOpen>(name, `/api/computer/topics/${encodeURIComponent(topicId)}/open`, {});
    const mirror = this.mirrorTopic(topic, name);
    for (const chat of chats) {
      const stub: Chat = { ...chat, computer: name };
      if (!this.store.getChat(stub.id)) this.record({ type: 'chat.created', chat: stub }, () => this.store.insertChat(stub));
    }
    return mirror;
  }

  openForComputer(caller: string, topicId: string): ComputerTopicOpen {
    const topic = this.requireTopic(topicId);
    this.store.addComputerTopic(caller, topic.id, this.clock.now());
    return { topic, chats: this.store.chatsInTopic(topic.id).filter((chat) => !chat.computer) };
  }

  chatHistoryForComputer(caller: string, chatId: string, after: number, limit: number): ComputerChatPage {
    if (!this.store.relayedTo(caller, chatId)) throw new HosError(404, `no chat ${chatId} shared with ${caller}`);
    const page = this.store.chatHistoryPage(chatId, Math.max(0, after || 0), Math.min(Math.max(1, limit || HISTORY_PAGE), HISTORY_PAGE));
    return { events: page.events.filter((event) => RELAYED.test(event.type)), next: page.next };
  }

  loadRemoteChat(chatId: string): Promise<{ events: number }> {
    const chat = this.store.getChat(chatId);
    if (!chat) throw new HosError(404, `no chat ${chatId}`);
    if (!chat.computer) throw new HosError(400, `chat ${chatId} runs here, so it has no history to load`);
    const running = this.remoteLoads.get(chatId);
    if (running) return running;
    const load = this.pullRemoteChat(chat.computer, chatId).finally(() => this.remoteLoads.delete(chatId));
    this.remoteLoads.set(chatId, load);
    return load;
  }

  private async pullRemoteChat(name: string, chatId: string): Promise<{ events: number }> {
    const computers = this.requireComputers();
    computers.target(name);
    this.historyPending.add(chatId);
    let after = this.store.remoteSeq(chatId);
    let events = 0;
    for (;;) {
      const done = await computers.run(name, async () => {
        const page = await computers.get<ComputerChatPage>(name, `/api/computer/chats/${encodeURIComponent(chatId)}/events?after=${after}&limit=${HISTORY_PAGE}`, HISTORY_PAGE_TIMEOUT_MS);
        for (const event of page.events) this.applyRemoteEvent(name, event, true);
        events += page.events.length;
        if (page.next === null) this.historyPending.delete(chatId);
        else after = page.next;
        return page.next === null;
      });
      if (done) return { events };
    }
  }

  private elsewhere(computer: string | undefined): computer is string {
    return !!computer && computer !== this.computers?.self.name;
  }

  private requireComputers(): Computers {
    if (!this.computers) throw new HosError(400, 'this hos has no computers');
    return this.computers;
  }

  private mirrorTopic(input: RemoteChatInput['topic'], home: string): Topic {
    const known = this.store.getTopic(input.id);
    if (known) return known;
    const mirror: Topic = {
      id: input.id,
      title: input.title,
      statusTopic: this.freeStatusTopic(input.statusTopic),
      workDir: input.workDir,
      state: 'active',
      request: null,
      workspaceIds: [],
      lastSeenAt: null,
      lastActivityAt: null,
      ...this.creator(undefined),
      createdAt: this.clock.now(),
      naming: false,
      tabOrder: [],
      home,
    };
    this.record({ type: 'topic.created', topic: mirror }, () => this.store.insertTopic(mirror));
    return mirror;
  }

  private async remoteWorkspace(project: Project, wanted: RemoteChatInput['workspaces'][number]): Promise<Workspace> {
    if (wanted.kind === 'root' || !wanted.branch) return this.createWorkspace({ projectId: project.id, kind: 'root' });
    const found = (await listWorktrees(project.path))?.find((entry) => entry.branch === wanted.branch);
    if (found) return this.createWorkspace({ projectId: project.id, kind: found.path === project.path ? 'root' : 'worktree', path: found.path });
    return this.createWorkspace({ projectId: project.id, kind: 'worktree', branch: wanted.branch, baseRef: `origin/${wanted.branch}` });
  }

  private async forwardMessage(chat: Chat, text: string, attachments: string[]): Promise<void> {
    const computers = this.requireComputers();
    const sent: string[] = [];
    for (const file of await this.attachedFiles(chat, attachments)) {
      const data = (await readFile(join(this.options.brainDir!, file.path))).toString('base64');
      sent.push((await computers.post<import('./api/types.js').Attachment>(chat.computer!, `/api/topics/${encodeURIComponent(chat.topicId)}/attachments`, { name: file.name, data })).path);
    }
    await computers.post(chat.computer!, `/api/chats/${encodeURIComponent(chat.id)}/messages`, { text, attachments: sent });
  }

  async saveTopicAttachment(topicId: string, name: string, data: string): Promise<import('./api/types.js').Attachment> {
    const topic = this.requireTopic(topicId);
    return this.writeAttachment(topic, name, this.attachmentBytes(name, data));
  }

  private attachmentBytes(name: string, data: string): Buffer {
    if (!this.options.brainDir) throw new HosError(400, 'hos has no brain (start it with --brain), so there is nowhere to keep attachments');
    if (!name.trim()) throw new HosError(400, 'an attachment needs a file name');
    if (Math.floor((data.length * 3) / 4) > ATTACHMENT_MAX_BYTES + 2) throw new HosError(413, 'attachments are at most 25 MB');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new HosError(400, 'data must be the file in base64');
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length > ATTACHMENT_MAX_BYTES) throw new HosError(413, 'attachments are at most 25 MB');
    return bytes;
  }

  private async writeAttachment(topic: Topic, name: string, bytes: Buffer): Promise<import('./api/types.js').Attachment> {
    const brainDir = this.options.brainDir!;
    if (!unlinkedPath(brainDir, attachmentsDir(topic.statusTopic))) {
      throw new HosError(400, `${attachmentsDir(topic.statusTopic)} in the brain goes through a link; hos keeps attachments only in a real folder`);
    }
    return saveAttachment(brainDir, topic.statusTopic, name, bytes, this.clock.now());
  }

  private async attachedFiles(chat: Chat, paths: string[]): Promise<Array<import('./api/types.js').Attachment>> {
    if (!paths.length) return [];
    const { brainDir } = this.options;
    if (!brainDir) throw new HosError(400, 'hos has no brain, so a message cannot carry attachments');
    const dir = `${attachmentsDir(this.store.getTopic(chat.topicId)!.statusTopic)}/`;
    return Promise.all(
      paths.map(async (path) => {
        const clean = typeof path === 'string' ? path.replace(/^\.\//, '') : '';
        if (!clean.startsWith(dir) || clean.slice(dir.length).includes('/') || clean.includes('..')) {
          throw new HosError(400, `attachments must be files under ${dir} of this chat's topic`);
        }
        const exists = await stat(join(brainDir, clean)).then((s) => s.isFile(), () => false);
        if (!exists) throw new HosError(400, `no attachment ${clean} in the brain`);
        if (!unlinkedPath(brainDir, clean)) throw new HosError(400, `attachment ${clean} is a link; hos sends only files kept in the topic's attachments`);
        return { name: attachmentName(clean), path: clean };
      }),
    );
  }
}

const QUESTION_TOOL = 'AskUserQuestion';
const questionsSkipped = () => `${ownerStart()} skipped these questions without answering; they'll reply in chat. Don't treat that as approval.`;
const repliedInChat = (text: string) =>
  `${ownerStart()} replied in chat instead of using the question form. Their message:\n\n${text}\n\nUse it as their answer if it answers the questions; ask again only if you still need a decision.`;
const PLAN_REPLIED = 'Replied in chat';
// A reply only hides the plan card; the plan still waits for "implement" or Approve.
const awaitsApproval = (plan: InboxItem) => plan.state === 'open' || plan.resolution === PLAN_REPLIED;
const flatten = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();
const ASKING_KINDS = new Set<InboxItem['kind']>(['question', 'approval', 'plan']);
const MAX_STOP_BLOCKS = 3;
const HANDOFF_FILE = /^handoff-gen\d+\.md$/;
const MAX_HANDOFF_ATTEMPTS = 2;
const refreshAsk = () =>
  `[hos] Context refresh: ${ownerStart()} pressed Refresh context. Run the lead-refresh skill now. Update PROGRESS.md with progress_update so every section is true now, then call refresh_ready. hos then clears this chat's context and you start again from PROGRESS.md.`;
const refreshBoot = () => `[hos] Your context was refreshed. Read PROGRESS.md (progress_read), then tasks and roster. If something is pending, continue it, but do not wait on chats that are still working: a done notice from each one wakes you. Otherwise greet ${owner()} in one line.`;
const SALVAGE_EVENTS = 30;
const FILE_TOOLS: Record<string, string> = { Read: 'file_path', Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path' };
const MINUTE = 60_000;
// The MCP client aborts a tool call around 60 s, so wait and workspace_wait cap each blocking call below that
// and return a "still running, wait again" result instead of surfacing a client-side timeout (H2).
export const WAIT_CLAMP_S = 50;
const DEFAULT_SUMMARY_TOKENS = 1500;
const ONE_LINE_CHARS = 200;

const HOUR = 60 * MINUTE;
const HISTORY_META = 'history.last.';
const RELAY_WINDOW_MS = 2 * HOUR;
const NOTICE_INTERVAL_MS = MINUTE;
const POLICY_POLL_MS = 1_000;
const NOTICES_PER_TURN = 5;
const NOTICE_CHARS = 120;
const HISTORY_PAGE = 2_000;
const HISTORY_PAGE_TIMEOUT_MS = 60_000;
const RELAYED = /^(chat\.(created|state|error|titled|result|queued|restarted|pick)|(message|thinking|tool|subagent|context|approval|handoff)\..+|inbox\.(added|updated)|card\.updated|bus\.call)$/;
const NOTICE_STATES = new Set<ChatState>(['starting', 'running', 'idle']);
const PING_PONG_ROUND_TRIPS = 3;
const ENDED_STATES = new Set<ChatState>(['done', 'failed', 'killed', 'archived']);
const EDIT_FIELDS = EDIT_TOOL_FIELDS;
const TTL_GRACE_MS = 10 * MINUTE;
const USAGE_POLL_MS = 5 * MINUTE;
const LIMIT_RETRY_MS = 30 * MINUTE;
const LIMIT_RESUMED = '[hos] the Claude limit reset; carry on where you left off';
const LIMIT_RESUME_NOTE = 'hos resumes this chat when the limit resets.';
const SWEEP_MS = 5 * MINUTE;
const CREATE_FETCH_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 60_000;
const SUBAGENT_SETTLE_MS = 5_000;
const HANDOFF_RUN = 'Run handoff';
const HANDOFF_SALVAGE = 'Salvage now';
const CHEAPER_WORKER_MODEL = 'sonnet';
const CHEAPER_SCOUT_MODEL = 'haiku';
const SUSPENDABLE = new Set<ChatState>(['idle', 'waiting_input', 'done', 'failed']);

function isBusy(state: ChatState): boolean {
  return (BUSY_STATES as readonly string[]).includes(state);
}

function isLive(state: ChatState): boolean {
  return (LIVE_STATES as readonly string[]).includes(state);
}

function isHalted(state: ChatState): boolean {
  return state === 'paused' || state === 'killed' || state === 'archived';
}

function firstLine(text: string, max: number): string {
  const line = text.split('\n').find((l) => l.trim())?.trim() ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const SNAG_CONTEXT_CHARS = 600;
const SNAG_CONTEXT_PART_CHARS = 150;
const SNAG_CONTEXT_SCAN = 20;


function clipped(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > SNAG_CONTEXT_PART_CHARS ? `${flat.slice(0, SNAG_CONTEXT_PART_CHARS - 1)}…` : flat;
}

const ACTION_OUTPUT_CHARS = 64_000;
const AGENT_OUTPUT_CHARS = 4_000;
const AGENT_WAIT_MS = 30_000;
const NO_WORKSPACE_ACTIONS = 'Your topic has no workspace, so it has no actions to run.';

function runText(run: ActionRun, shown = run.name): string {
  const head = `Run ${run.id} of ${shown}: ${run.state}${run.exitCode === null ? '' : ` (exit ${run.exitCode})`}`;
  const where = run.state === 'running' && run.terminal ? ` in tmux session ${run.terminal}; check again with action_run` : run.state === 'running' ? '; check again with action_run' : '';
  const output = run.output.length > AGENT_OUTPUT_CHARS ? `…${run.output.slice(-AGENT_OUTPUT_CHARS)}` : run.output;
  return `${head}${where}\n${output}`;
}
const DECISIONS: ApprovalDecision[] = ['approve', 'deny'];

function kilo(tokens: number): string {
  return `${Math.round(tokens / 1000)}k`;
}

export function topicTitle(prompt: string): string {
  const words = fixMishears(prompt.trim()).split(/\s+/);
  const cut = words.length > TITLE_WORDS;
  const title = words.slice(0, TITLE_WORDS).join(' ').replace(/[\s.,;:!?…'"`)\]}-]+$/u, '');
  const text = title.charAt(0).toUpperCase() + title.slice(1);
  return cut ? `${text}…` : text;
}

const TITLE_WORDS = 7;

async function settledWithin<T>(pending: Promise<T>, ms: number): Promise<{ settled: true; value: T } | { settled: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<{ settled: false }>((done) => (timer = setTimeout(() => done({ settled: false }), ms)));
  try {
    return await Promise.race([pending.then((value) => ({ settled: true as const, value })), late]);
  } finally {
    clearTimeout(timer);
  }
}

function slug(text: string, fallback: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 60) || fallback
  );
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
