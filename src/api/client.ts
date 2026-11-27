import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { Canvas, Draft } from '../canvas/types.js';
import type {
  ActionList,
  ActionRun,
  Approval,
  ApprovalDecision,
  Chat,
  DevServer,
  Diff,
  DiffActionResult,
  DiffScope,
  DoctorReport,
  HandoffTrigger,
  Effort,
  StatusItem,
  GovernorStatus,
  InboxItem,
  KillScope,
  KillSwitch,
  Lock,
  Lineage,
  HosEvent,
  HomeSummary,
  SettingsPage,
  ScheduleInput,
  ScheduleList,
  ScheduleRun,
  CalendarDay,
  NowBlocks,
  SourceResult,
  SourcesInfo,
  TodayList,
  Project,
  CodeViewOpened,
  ConfigApplied,
  ConfigFile,
  ConfigPreview,
  ConfigSave,
  ConfigTree,
  ProjectView,
  PushDevice,
  PushStatus,
  PushTarget,
  PushTestResult,
  Role,
  ReviewComment,
  SearchHit,
  ServersView,
  Surface,
  Task,
  TaskPatch,
  TaskPriority,
  Terminal,
  TranscriptEntry,
  Topic,
  TopicState,
  Workspace,
  WorkspaceKind,
  Worktree,
  PanelWorkspace,
} from './types.js';
import type { SetupLog, TopicHistoryFact } from './types.js';
import type { Snapshot, TimelineItem } from './state.js';

export class HosApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Subscription {
  readonly lastSeq: number;
  resume(): void;
  presence(visible: boolean, focused: boolean): void;
  close(): void;
}

export interface SubscribeOptions {
  since?: number;
  onStatus?: (status: 'live' | 'reconnecting') => void;
}

export const SESSION_PROTOCOL = 'hos-session.';

export interface Authenticator {
  create(options: PublicKeyCredentialCreationOptionsJSON): Promise<RegistrationResponseJSON>;
  get(options: PublicKeyCredentialRequestOptionsJSON): Promise<AuthenticationResponseJSON>;
}

export interface HosClientOptions {
  headers?: Record<string, string>;
  authenticator?: Authenticator;
  sessionToken?: string;
}

export interface SessionState {
  transport: string;
  origin: string;
  registered: boolean;
  signedIn: boolean;
}

export interface AttachOptions {
  cols: number;
  rows: number;
  onData: (data: string) => void;
  onExit?: () => void;
}

export interface TerminalAttachment {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

export class HosClient {
  sessionToken: string | undefined;

  constructor(
    private readonly baseUrl: string,
    private readonly options: HosClientOptions = {},
  ) {
    this.sessionToken = options.sessionToken;
  }

  session(): Promise<SessionState> {
    return this.request('GET', '/api/session');
  }

  async registerPasskey(code?: string): Promise<void> {
    const options = await this.post<PublicKeyCredentialCreationOptionsJSON>('/api/passkeys/register/options', { code });
    const response = await this.authenticator().create(options);
    this.sessionToken = (await this.post<{ token: string }>('/api/passkeys/register', { code, response })).token;
  }

  async signIn(): Promise<void> {
    const options = await this.post<PublicKeyCredentialRequestOptionsJSON>('/api/passkeys/login/options', {});
    const response = await this.authenticator().get(options);
    this.sessionToken = (await this.post<{ token: string }>('/api/passkeys/login', { response })).token;
  }

  doctor(): Promise<DoctorReport> {
    return this.request('GET', '/api/doctor');
  }

  async previewUrl(port: number): Promise<string> {
    return (await this.request<{ url: string }>('GET', `/api/previews/${port}`)).url;
  }

  createProject(path: string): Promise<Project> {
    return this.post('/api/projects', { path });
  }

  listProjects(): Promise<ProjectView[]> {
    return this.request('GET', '/api/projects');
  }

  renameProject(projectId: string, name: string): Promise<Project> {
    return this.post(`/api/projects/${encodeURIComponent(projectId)}/rename`, { name });
  }

  setProjectPinned(projectId: string, pinned: boolean): Promise<Project> {
    return this.post(`/api/projects/${encodeURIComponent(projectId)}/pin`, { pinned });
  }

  setProjectHidden(projectId: string, hidden: boolean): Promise<Project> {
    return this.post(`/api/projects/${encodeURIComponent(projectId)}/hide`, { hidden });
  }

  removeProject(projectId: string): Promise<{ ok: true }> {
    return this.post(`/api/projects/${encodeURIComponent(projectId)}/remove`, {});
  }

  async refresh(): Promise<void> {
    await this.post('/api/refresh', {});
  }

  createWorktree(projectId: string, request: { branch: string; baseRef: string; byChat?: string }): Promise<Worktree> {
    return this.post(`/api/projects/${encodeURIComponent(projectId)}/worktrees`, {
      branch: request.branch,
      baseRef: request.baseRef,
      chatId: request.byChat,
    });
  }

  removeWorktree(path: string, options: { force?: boolean } = {}): Promise<{ removed: string; warnings: string[] }> {
    return this.post('/api/worktrees/remove', { path, force: options.force ?? false });
  }

  listTopics(): Promise<Topic[]> {
    return this.request('GET', '/api/topics');
  }

  createTopic(request: { title: string; statusTopic?: string; area?: string; workspaceId?: string; chatId?: string }): Promise<Topic> {
    return this.post('/api/topics', request);
  }

  startTopic(request: {
    text: string;
    model?: string;
    effort?: Effort;
    agent?: string;
    chrome?: boolean;
    desk?: boolean;
    files?: Array<{ name: string; data: string }>;
    profile?: string;
    computer?: string;
  }): Promise<{ topicId: string; chatId: string }> {
    return this.post('/api/topics/start', request);
  }

  renameTopic(topicId: string, title: string): Promise<Topic> {
    return this.post(`/api/topics/${encodeURIComponent(topicId)}/rename`, { title });
  }

  setTopicState(topicId: string, state: TopicState): Promise<Topic> {
    return this.post(`/api/topics/${encodeURIComponent(topicId)}/state`, { state });
  }

  archiveTopic(topicId: string): Promise<Topic> {
    return this.post(`/api/topics/${encodeURIComponent(topicId)}/archive`, {});
  }

  markTopicSeen(topicId: string): Promise<Topic> {
    return this.post(`/api/topics/${encodeURIComponent(topicId)}/seen`, {});
  }

  async markAllTopicsSeen(): Promise<void> {
    await this.post('/api/topics/seen', {});
  }

  attachWorkspace(topicId: string, workspaceId: string): Promise<Topic> {
    return this.post(`/api/topics/${encodeURIComponent(topicId)}/workspaces`, { workspaceId });
  }

  detachWorkspace(topicId: string, workspaceId: string): Promise<Topic> {
    return this.post(`/api/topics/${encodeURIComponent(topicId)}/workspaces/${encodeURIComponent(workspaceId)}/detach`, {});
  }

  removeTopicWorkspace(topicId: string, workspaceId: string, options: { force?: boolean } = {}): Promise<Topic> {
    return this.post(`/api/topics/${encodeURIComponent(topicId)}/workspaces/${encodeURIComponent(workspaceId)}/remove`, { force: options.force ?? false });
  }

  listWorkspaces(options: { archived?: boolean } = {}): Promise<Workspace[]> {
    return this.request('GET', options.archived ? '/api/workspaces?archived=1' : '/api/workspaces');
  }

  createWorkspace(request: { projectId: string; kind: WorkspaceKind; branch?: string; baseRef?: string; path?: string; chatId?: string }): Promise<Workspace> {
    return this.post('/api/workspaces', request);
  }

  handOff(chatId: string, mode: 'write' | 'salvage' = 'write'): Promise<HandoffTrigger> {
    return this.post(`/api/chats/${encodeURIComponent(chatId)}/handoff`, { mode });
  }

  createChat(topicId: string, options: { role?: Role; model?: string; effort?: Effort; agent?: string } = {}): Promise<Chat> {
    return this.post('/api/chats', { topicId, role: options.role, model: options.model, effort: options.effort, agent: options.agent });
  }

  getLineage(chatId: string): Promise<Lineage> {
    return this.request('GET', `/api/chats/${encodeURIComponent(chatId)}/lineage`);
  }

  async sendMessage(chatId: string, text: string, attachments?: string[]): Promise<void> {
    await this.post(`/api/chats/${encodeURIComponent(chatId)}/messages`, { text, ...(attachments?.length ? { attachments } : {}) });
  }

  async decideApproval(
    approvalId: string,
    decision: ApprovalDecision,
    options: { via?: Surface; byChat?: string } = {},
  ): Promise<void> {
    await this.post(`/api/approvals/${encodeURIComponent(approvalId)}`, { decision, via: options.via, chatId: options.byChat });
  }

  listApprovals(): Promise<Approval[]> {
    return this.request('GET', '/api/approvals');
  }

  listInbox(): Promise<InboxItem[]> {
    return this.request('GET', '/api/inbox');
  }

  async answerQuestion(
    itemId: string,
    answers: Record<string, string>,
    options: { via?: Surface; byChat?: string } = {},
  ): Promise<void> {
    await this.post(`/api/inbox/${encodeURIComponent(itemId)}/answer`, { answers, via: options.via, chatId: options.byChat });
  }

  async dismissInboxItem(itemId: string): Promise<void> {
    await this.post(`/api/inbox/${encodeURIComponent(itemId)}/dismiss`, {});
  }

  pushStatus(): Promise<PushStatus> {
    return this.request('GET', '/api/push');
  }

  subscribePush(subscription: PushTarget, label: string): Promise<PushDevice> {
    return this.post('/api/push/subscriptions', { subscription, label });
  }

  async unsubscribePush(endpoint: string): Promise<void> {
    await this.post('/api/push/subscriptions/remove', { endpoint });
  }

  testPush(): Promise<PushTestResult> {
    return this.post('/api/push/test', {});
  }

  getDiff(scope: DiffScope): Promise<Diff> {
    if ('chatId' in scope) return this.request('GET', `/api/chats/${encodeURIComponent(scope.chatId)}/diff/${scope.since}`);
    const path = `/api/workspaces/${encodeURIComponent(scope.workspaceId)}/diff`;
    return this.request('GET', scope.ref ? `${path}/${encodeURIComponent(scope.ref)}` : path);
  }

  discardFile(workspaceId: string, path: string): Promise<DiffActionResult> {
    return this.post(`/api/workspaces/${encodeURIComponent(workspaceId)}/discard`, { path });
  }

  commit(workspaceId: string, message: string): Promise<DiffActionResult> {
    return this.post(`/api/workspaces/${encodeURIComponent(workspaceId)}/commit`, { message });
  }

  openPullRequest(workspaceId: string): Promise<DiffActionResult> {
    return this.post(`/api/workspaces/${encodeURIComponent(workspaceId)}/pull-request`, {});
  }

  async sendReview(chatId: string, comments: ReviewComment[]): Promise<void> {
    await this.post(`/api/chats/${encodeURIComponent(chatId)}/review`, { comments });
  }

  mergeBack(chatId: string): Promise<DiffActionResult> {
    return this.post(`/api/chats/${encodeURIComponent(chatId)}/merge`, {});
  }

  takeOver(chatId: string): Promise<{ terminal: string }> {
    return this.post(`/api/chats/${encodeURIComponent(chatId)}/takeover`, {});
  }

  async handBack(chatId: string): Promise<void> {
    await this.post(`/api/chats/${encodeURIComponent(chatId)}/handback`, {});
  }

  governor(): Promise<GovernorStatus> {
    return this.request('GET', '/api/governor');
  }

  health(): Promise<StatusItem[]> {
    return this.request('GET', '/api/health');
  }

  doctorChecks(): Promise<StatusItem[]> {
    return this.request('GET', '/api/doctor/checks');
  }

  listKillSwitches(): Promise<KillSwitch[]> {
    return this.request('GET', '/api/kill');
  }

  kill(target: { scope: KillScope | 'subtree'; topicId?: string; chatId?: string }): Promise<{ killed: string[] }> {
    return this.post('/api/kill', target);
  }

  async liftKillSwitch(target: { scope: KillScope; topicId?: string }): Promise<void> {
    await this.post('/api/kill/lift', target);
  }

  search(topicId: string, query: string): Promise<SearchHit[]> {
    return this.request('GET', `/api/topics/${encodeURIComponent(topicId)}/search?q=${encodeURIComponent(query)}`);
  }

  listTasks(topicId: string): Promise<Task[]> {
    return this.request('GET', `/api/topics/${encodeURIComponent(topicId)}/tasks`);
  }

  addTask(topicId: string, input: { title: string; priority?: TaskPriority; criteria?: string[] }): Promise<Task> {
    return this.post(`/api/topics/${encodeURIComponent(topicId)}/tasks`, input);
  }

  updateTask(topicId: string, ref: string, patch: TaskPatch): Promise<Task> {
    return this.request('PUT', `/api/topics/${encodeURIComponent(topicId)}/tasks/${encodeURIComponent(ref)}`, patch);
  }

  linkTask(topicId: string, ref: string, link: boolean): Promise<Task> {
    return this.post(`/api/topics/${encodeURIComponent(topicId)}/tasks/${encodeURIComponent(ref)}/mirror`, { link });
  }

  listLocks(topicId: string): Promise<Lock[]> {
    return this.request('GET', `/api/topics/${encodeURIComponent(topicId)}/locks`);
  }

  listActions(workspaceId: string): Promise<ActionList> {
    return this.request('GET', `/api/workspaces/${encodeURIComponent(workspaceId)}/actions`);
  }

  runAction(workspaceId: string, name: string, options: { args?: Record<string, string>; confirmed?: boolean } = {}): Promise<ActionRun> {
    return this.post(`/api/workspaces/${encodeURIComponent(workspaceId)}/actions/${encodeURIComponent(name)}/run`, {
      args: options.args,
      confirmed: options.confirmed,
    });
  }

  getActionRun(runId: string): Promise<ActionRun> {
    return this.request('GET', `/api/action-runs/${encodeURIComponent(runId)}`);
  }

  getTranscript(chatId: string): Promise<TranscriptEntry[]> {
    return this.request('GET', `/api/chats/${encodeURIComponent(chatId)}/transcript`);
  }

  chatTimeline(chatId: string): Promise<TimelineItem[]> {
    return this.request('GET', `/api/chats/${encodeURIComponent(chatId)}/timeline`);
  }

  topicHistory(): Promise<TopicHistoryFact[]> {
    return this.request('GET', '/api/topics/history');
  }

  listServers(): Promise<ServersView> {
    return this.request('GET', '/api/servers');
  }

  async stopServer(name: string): Promise<void> {
    await this.post(`/api/servers/${encodeURIComponent(name)}/stop`, {});
  }

  restartServer(name: string): Promise<DevServer> {
    return this.post(`/api/servers/${encodeURIComponent(name)}/restart`, {});
  }

  async tailServer(name: string, lines?: number): Promise<string> {
    const query = lines === undefined ? '' : `?lines=${lines}`;
    return (await this.request<{ output: string }>('GET', `/api/servers/${encodeURIComponent(name)}/tail${query}`)).output;
  }

  startServer(request: { worktreePath: string; app: string; command: string; port?: number }): Promise<DevServer> {
    return this.post('/api/servers', request);
  }

  listTerminals(topicId?: string): Promise<Terminal[]> {
    return this.request('GET', topicId ? `/api/terminals?topic=${encodeURIComponent(topicId)}` : '/api/terminals');
  }

  createTerminal(request: { worktreePath: string; topicId?: string }): Promise<Terminal> {
    return this.post('/api/terminals', request);
  }

  killTerminal(name: string): Promise<unknown> {
    return this.post(`/api/terminals/${encodeURIComponent(name)}/kill`, {});
  }

  openLoginTerminal(harness?: string): Promise<Terminal> {
    return this.post('/api/login', harness ? { harness } : {});
  }

  attachTerminal(name: string, options: AttachOptions): TerminalAttachment {
    const url = new URL(`/api/terminals/${encodeURIComponent(name)}/attach`, this.baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('cols', String(options.cols));
    url.searchParams.set('rows', String(options.rows));
    let socket: WebSocket | undefined;
    let closed = false;
    const pending: string[] = [];
    const send = (message: unknown) => {
      const frame = JSON.stringify(message);
      if (socket?.readyState === WebSocket.OPEN) socket.send(frame);
      else pending.push(frame);
    };
    let exited = false;
    const exit = () => {
      if (exited) return;
      exited = true;
      options.onExit?.();
    };
    const open = async () => {
      if (closed) return;
      socket = this.webSocket(url);
      socket.onopen = () => {
        for (const frame of pending.splice(0)) socket!.send(frame);
      };
      socket.onmessage = (message) => options.onData(String(message.data));
      socket.onclose = socket.onerror = exit;
    };
    open().catch(exit);
    return {
      write: (data) => send({ type: 'input', data }),
      resize: (cols, rows) => send({ type: 'resize', cols, rows }),
      close: () => {
        closed = true;
        socket?.close();
      },
    };
  }

  openCodeView(path: string, file?: string): Promise<CodeViewOpened> {
    return this.request('POST', '/api/code', { path, ...(file === undefined ? {} : { file }) });
  }

  openPrLink(url: string, topic: string): Promise<{ url: string }> {
    return this.request('POST', '/api/code/pr', { url, topic });
  }

  openFile(path: string): Promise<{ url: string }> {
    return this.request('POST', '/api/files/open', { path });
  }

  canvas(topicId: string, ref: string): Promise<Canvas> {
    return this.request('GET', `/api/topics/${encodeURIComponent(topicId)}/canvases/${encodeURIComponent(ref)}`);
  }

  saveCanvasDraft(topicId: string, ref: string, draft: Draft): Promise<{ ok: true }> {
    return this.request('PUT', `/api/topics/${encodeURIComponent(topicId)}/canvases/${encodeURIComponent(ref)}/draft`, draft);
  }

  submitCanvas(topicId: string, ref: string, draft: Draft): Promise<{ text: string }> {
    return this.request('POST', `/api/topics/${encodeURIComponent(topicId)}/canvases/${encodeURIComponent(ref)}/submit`, draft);
  }

  canvasPage(topicId: string, ref: string, block: string): Promise<{ url: string }> {
    return this.request('POST', `/api/topics/${encodeURIComponent(topicId)}/canvases/${encodeURIComponent(ref)}/html`, { block });
  }

  showCanvas(topicId: string, ref: string): Promise<{ ok: true }> {
    return this.request('POST', `/api/topics/${encodeURIComponent(topicId)}/canvases/${encodeURIComponent(ref)}/show`);
  }

  sources(): Promise<SourcesInfo> {
    return this.request('GET', '/api/sources');
  }

  myToday(): Promise<TodayList> {
    return this.request('GET', '/api/me/today');
  }

  myTaskDone(taskId: string): Promise<SourceResult> {
    return this.request('POST', `/api/me/tasks/${encodeURIComponent(taskId)}/done`);
  }

  capture(text: string): Promise<SourceResult> {
    return this.request('POST', '/api/me/capture', { text });
  }

  myCalendar(): Promise<CalendarDay> {
    return this.request('GET', '/api/me/calendar');
  }

  myNow(): Promise<NowBlocks> {
    return this.request('GET', '/api/me/now');
  }

  configTree(): Promise<ConfigTree> {
    return this.request('GET', '/api/config');
  }

  configFile(repo: string, path: string): Promise<ConfigFile> {
    return this.request('GET', `/api/config/file?${new URLSearchParams({ repo, path })}`);
  }

  configReveal(repo: string, path: string, key: string): Promise<{ value: string }> {
    return this.post('/api/config/reveal', { repo, path, key });
  }

  configSave(input: ConfigSave): Promise<ConfigFile> {
    return this.post('/api/config/save', input);
  }

  configRemove(repo: string, path: string): Promise<{ ok: true }> {
    return this.post('/api/config/remove', { repo, path });
  }

  configPreview(repo: string, path: string, targets: string[]): Promise<ConfigPreview[]> {
    return this.post('/api/config/preview', { repo, path, targets });
  }

  configApply(repo: string, path: string, targets: string[]): Promise<ConfigApplied> {
    return this.post('/api/config/apply', { repo, path, targets });
  }

  configRestore(repo: string, path: string, target: string): Promise<{ restored: string; backup: string | null }> {
    return this.post('/api/config/restore', { repo, path, target });
  }

  configImport(repo: string): Promise<{ imported: string[] }> {
    return this.post('/api/config/import', { repo });
  }

  home(): Promise<HomeSummary> {
    return this.request('GET', '/api/home');
  }

  settings(): Promise<SettingsPage> {
    return this.request('GET', '/api/settings');
  }

  setup(): Promise<import('./types.js').FirstRunState> {
    return this.request('GET', '/api/setup');
  }

  createBrain(request: import('./types.js').BrainRequest): Promise<{ brain: string; lines: string[] }> {
    return this.post('/api/setup/brain', request);
  }

  schedules(): Promise<ScheduleList> {
    return this.request('GET', '/api/schedules');
  }

  saveSchedule(row: ScheduleInput, id?: string): Promise<ScheduleList> {
    return this.post(id === undefined ? '/api/schedules' : `/api/schedules/${encodeURIComponent(id)}`, row);
  }

  pauseSchedule(id: string, paused: boolean): Promise<ScheduleList> {
    return this.post(`/api/schedules/${encodeURIComponent(id)}/pause`, { paused });
  }

  deleteSchedule(id: string): Promise<ScheduleList> {
    return this.post(`/api/schedules/${encodeURIComponent(id)}/delete`, {});
  }

  runSchedule(id: string): Promise<ScheduleRun> {
    return this.post(`/api/schedules/${encodeURIComponent(id)}/run`, {});
  }

  async dismissHomeAlert(alertId: string): Promise<void> {
    await this.post(`/api/home/alerts/${encodeURIComponent(alertId)}/dismiss`, {});
  }

  workspaceSetupLog(workspaceId: string): Promise<SetupLog> {
    return this.request('GET', `/api/workspaces/${encodeURIComponent(workspaceId)}/setup-log`);
  }

  rerunSetup(workspaceId: string): Promise<Workspace> {
    return this.post(`/api/workspaces/${encodeURIComponent(workspaceId)}/setup`, {});
  }

  renameWorkspace(workspaceId: string, branch: string): Promise<Workspace> {
    return this.post(`/api/workspaces/${encodeURIComponent(workspaceId)}/rename`, { branch });
  }

  archiveWorkspace(workspaceId: string, options: { force?: boolean } = {}): Promise<Workspace> {
    return this.post(`/api/workspaces/${encodeURIComponent(workspaceId)}/archive`, { force: options.force ?? false });
  }

  deleteWorkspace(workspaceId: string): Promise<{ deleted: string }> {
    return this.post(`/api/workspaces/${encodeURIComponent(workspaceId)}/delete`, {});
  }

  openWorkspaceTerminal(workspaceId: string, topicId?: string): Promise<{ name: string }> {
    return this.post(`/api/workspaces/${encodeURIComponent(workspaceId)}/terminal`, topicId ? { topicId } : {});
  }
  pickWorkspace(itemId: string, choice: string, branch?: string, options: { via?: Surface; byChat?: string } = {}): Promise<{ workspace: Workspace; created: boolean }> {
    return this.post(`/api/inbox/${encodeURIComponent(itemId)}/pick`, { choice, ...(branch !== undefined ? { branch } : {}), via: options.via, chatId: options.byChat });
  }
  removePickerWorktree(itemId: string, choice: string, options: { force?: boolean; byChat?: string } = {}): Promise<InboxItem> {
    return this.post(`/api/inbox/${encodeURIComponent(itemId)}/pick-remove`, { choice, force: options.force ?? false, chatId: options.byChat });
  }
  topicPanel(topicId: string): Promise<PanelWorkspace[]> {
    return this.request('GET', `/api/topics/${encodeURIComponent(topicId)}/panel`);
  }

  pushWorkspace(workspaceId: string): Promise<DiffActionResult> {
    return this.post(`/api/workspaces/${encodeURIComponent(workspaceId)}/push`, {});
  }

  pullWorkspace(workspaceId: string): Promise<DiffActionResult> {
    return this.post(`/api/workspaces/${encodeURIComponent(workspaceId)}/pull`, {});
  }

  fetchWorkspace(workspaceId: string): Promise<{ detail: string }> {
    return this.post(`/api/workspaces/${encodeURIComponent(workspaceId)}/fetch`, {});
  }

  reviewWorkspace(workspaceId: string): Promise<{ reviewerId: string | null; detail: string }> {
    return this.post(`/api/workspaces/${encodeURIComponent(workspaceId)}/review`, {});
  }
  async decidePlan(itemId: string, decision: import('./types.js').PlanDecision, options: { text?: string; via?: Surface; byChat?: string } = {}): Promise<void> {
    await this.post(`/api/inbox/${encodeURIComponent(itemId)}/plan`, { decision, text: options.text, via: options.via, chatId: options.byChat });
  }

  stopChat(chatId: string): Promise<Chat> {
    return this.post(`/api/chats/${encodeURIComponent(chatId)}/stop`, {});
  }

  refreshContext(chatId: string): Promise<{ queued: boolean }> {
    return this.post(`/api/chats/${encodeURIComponent(chatId)}/context-refresh`, {});
  }

  restartChat(chatId: string): Promise<Chat> {
    return this.post(`/api/chats/${encodeURIComponent(chatId)}/restart`, {});
  }

  setChatPick(chatId: string, pick: { model?: string; effort?: Effort }): Promise<Chat> {
    return this.post(`/api/chats/${encodeURIComponent(chatId)}/pick`, pick);
  }

  setChatTabClosed(chatId: string, closed: boolean): Promise<Chat> {
    return this.post(`/api/chats/${encodeURIComponent(chatId)}/tab`, { closed });
  }

  setChatNotify(chatId: string, notify: boolean): Promise<Chat> {
    return this.post(`/api/chats/${encodeURIComponent(chatId)}/notify`, { notify });
  }

  setTabOrder(topicId: string, order: string[]): Promise<Topic> {
    return this.post(`/api/topics/${encodeURIComponent(topicId)}/tabs`, { order });
  }

  linkChat(chatId: string, to: { chatId: string } | { diagramId: string }): Promise<import('./types.js').ChatLink[]> {
    return this.post(`/api/chats/${encodeURIComponent(chatId)}/links`, to);
  }

  unlinkChat(chatId: string, target: string): Promise<import('./types.js').ChatLink[]> {
    return this.request('DELETE', `/api/chats/${encodeURIComponent(chatId)}/links/${encodeURIComponent(target)}`);
  }

  addTopicChat(topicId: string, pick: { model?: string; effort?: Effort; agent?: string; chrome?: boolean; diagramId?: string; profile?: string; computer?: string } = {}): Promise<Chat> {
    return this.post(`/api/topics/${encodeURIComponent(topicId)}/chats`, pick);
  }

  models(): Promise<import('./types.js').ModelsConfig> {
    return this.request('GET', '/api/models');
  }

  composer(): Promise<import('./types.js').ComposerConfig> {
    return this.request('GET', '/api/composer');
  }

  owner(): Promise<import('./types.js').OwnerInfo> {
    return this.request('GET', '/api/owner');
  }

  harnesses(): Promise<import('./types.js').HarnessChoice[]> {
    return this.request('GET', '/api/harnesses');
  }

  profiles(): Promise<import('./types.js').ProfileInfo[]> {
    return this.request('GET', '/api/profiles');
  }

  skills(profile?: string): Promise<import('./types.js').SkillInfo[]> {
    return this.request('GET', `/api/skills${profile ? `?profile=${encodeURIComponent(profile)}` : ''}`);
  }

  computers(poll = false): Promise<import('./types.js').ComputersView> {
    return this.request('GET', `/api/computers${poll ? '?poll=1' : ''}`);
  }

  pairCode(): Promise<import('./types.js').PairCode> {
    return this.post('/api/computer/pair-code', {});
  }

  addComputer(input: { url: string; code: string }): Promise<import('./types.js').Computer> {
    return this.post('/api/computers', input);
  }

  removeComputer(name: string): Promise<{ ok: true }> {
    return this.request('DELETE', `/api/computers/${encodeURIComponent(name)}`);
  }

  openComputerTopic(name: string, topicId: string): Promise<import('./types.js').Topic> {
    return this.post(`/api/computers/${encodeURIComponent(name)}/topics/${encodeURIComponent(topicId)}/open`, {});
  }

  loadChat(chatId: string): Promise<{ events: number }> {
    return this.post(`/api/chats/${encodeURIComponent(chatId)}/load`, {});
  }

  uploadAttachment(topicId: string, name: string, data: string): Promise<import('./types.js').Attachment> {
    return this.post(`/api/topics/${encodeURIComponent(topicId)}/attachments`, { name, data });
  }

  listDiagrams(topicId: string): Promise<import('./types.js').DiagramInfo[]> {
    return this.request('GET', `/api/topics/${encodeURIComponent(topicId)}/diagrams`);
  }

  createDiagram(topicId: string, title?: string): Promise<import('./types.js').DiagramInfo> {
    return this.post(`/api/topics/${encodeURIComponent(topicId)}/diagrams`, title ? { title } : {});
  }

  searchDiagrams(query?: string): Promise<import('./types.js').DiagramInfo[]> {
    return this.request('GET', `/api/diagrams${query ? `?query=${encodeURIComponent(query)}` : ''}`);
  }

  newDiagram(title?: string): Promise<import('./types.js').DiagramInfo> {
    return this.post('/api/diagrams', title ? { title } : {});
  }

  renameDiagram(id: string, title: string): Promise<import('./types.js').DiagramInfo> {
    return this.post(`/api/diagrams/${encodeURIComponent(id)}/rename`, { title });
  }

  diagramScene(id: string): Promise<import('./types.js').DiagramScene> {
    return this.request('GET', `/api/diagrams/${encodeURIComponent(id)}/scene`);
  }

  diagram(id: string): Promise<import('./types.js').DiagramInfo> {
    return this.request('GET', `/api/diagrams/${encodeURIComponent(id)}`);
  }

  diagramVersions(id: string): Promise<import('./types.js').DiagramVersion[]> {
    return this.request('GET', `/api/diagrams/${encodeURIComponent(id)}/versions`);
  }

  restoreDiagram(id: string, sha: string): Promise<import('./types.js').DiagramChange> {
    return this.post(`/api/diagrams/${encodeURIComponent(id)}/restore`, { sha });
  }

  undoDiagramApply(id: string, applyId: string): Promise<import('./types.js').DiagramChange> {
    return this.post(`/api/diagrams/${encodeURIComponent(id)}/applies/${encodeURIComponent(applyId)}/undo`, {});
  }

  diagramSocket(id: string): WebSocket {
    const url = new URL(`/api/diagrams/${encodeURIComponent(id)}/live`, this.baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return this.webSocket(url);
  }

  snapshot(): Promise<Snapshot> {
    return this.request('GET', '/api/snapshot');
  }

  subscribe(onEvent: (event: HosEvent) => void, options: SubscribeOptions = {}): Subscription {
    let lastSeq = options.since ?? 0;
    let closed = false;
    let socket: WebSocket | undefined;
    let retryMs = 100;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let presence: string | undefined;
    const connect = () => {
      const url = new URL(`/api/events?since=${lastSeq}`, this.baseUrl);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const current = this.webSocket(url);
      socket = current;
      current.onopen = () => {
        retryMs = 100;
        options.onStatus?.('live');
        if (presence) current.send(presence);
      };
      current.onmessage = (message) => {
        const frame = JSON.parse(String(message.data)) as HosEvent | HosEvent[];
        for (const event of Array.isArray(frame) ? frame : [frame]) {
          if (event.seq <= lastSeq) continue;
          lastSeq = event.seq;
          onEvent(event);
        }
      };
      current.onclose = () => {
        if (closed || current !== socket) return;
        options.onStatus?.('reconnecting');
        retry = setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, 2000);
      };
    };
    connect();
    return {
      get lastSeq() {
        return lastSeq;
      },
      resume() {
        if (closed) return;
        clearTimeout(retry);
        const stale = socket;
        connect();
        stale?.close();
      },
      presence(visible, focused) {
        presence = JSON.stringify({ type: 'presence', visible, focused });
        if (socket?.readyState === WebSocket.OPEN) socket.send(presence);
      },
      close() {
        closed = true;
        clearTimeout(retry);
        socket?.close();
      },
    };
  }

  private webSocket(url: URL): WebSocket {
    const protocols = this.sessionToken ? ['hos', SESSION_PROTOCOL + this.sessionToken] : [];
    return this.options.headers ? new WebSocket(url, { protocols, headers: this.options.headers } as never) : new WebSocket(url, protocols);
  }

  private authenticator(): Authenticator {
    if (!this.options.authenticator) throw new Error('this client has no passkey authenticator');
    return this.options.authenticator;
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return this.request('POST', path, body);
  }

  async request<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const response = await fetch(new URL(path, this.baseUrl), {
      method,
      headers: {
        ...this.options.headers,
        ...(this.sessionToken ? { authorization: `Bearer ${this.sessionToken}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = (await response.json()) as T & { error?: string };
    if (!response.ok) throw new HosApiError(response.status, payload.error ?? response.statusText);
    return payload;
  }
}
