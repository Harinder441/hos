import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { hostname } from 'node:os';
import type { Duplex } from 'node:stream';
import { extname, join, normalize, sep } from 'node:path';
import { WebSocketServer } from 'ws';
import { fromLoopback, type Identity, type Transport } from './adapters/transport.js';
import { SESSION_PROTOCOL } from './api/client.js';
import type { Effort, HomeSummary, KillScope, PushTarget, ReviewComment, Role, SettingsPage, Surface, TaskPatch, TaskPriority, TopicState, WorkspaceKind } from './api/types.js';
import type { ComposerConfig, ConfigSave, HarnessChoice, HosEvent, ModelsConfig, OwnerInfo, RemoteChatInput, ScheduleInput, SkillInfo, SourcesInfo, StatusItem } from './api/types.js';
import { codePrHref } from './api/types.js';
import { handleBusRequest } from './bus-http.js';
import { CANVAS_CSP, withBridge } from './canvas/bridge.js';
import { HosError, type Hos } from './core.js';
import { ATTACHMENT_MAX_BYTES } from './attachments.js';
import type { Computers } from './computers.js';
import { DESK_PATH, deskCors, type DeskScreen } from './desk-screen.js';
import { FILE_TYPES, type HtmlFiles } from './files.js';
import type { Passkeys } from './passkeys.js';
import type { Sources } from './plugins/registry.js';
import type { CodeView } from './code-view.js';
import { CODE_VIEW_PR_PATHS, CODE_VIEW_REVIEW_PATHS, CODE_VIEW_SNAGS_PATHS } from './code-view-bridge.js';
import type { Push } from './push.js';
import { createBrain, setupInfo, type BrainSource, type SetupOptions } from './setup.js';
import { snagRoutes } from './snags/routes.js';
import type { Snags } from './snags/snags.js';
import type { NewSnag } from './snags/types.js';
import type { TerminalAttachments } from './terminals.js';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

export const BUS_PATH = '/bus';

const CATCH_UP_FRAME = 500;

const COMPUTER_ROUTES: Array<[string, RegExp]> = [
  ['GET', /^\/api\/computer\/topics$/],
  ['GET', /^\/api\/computer\/caps$/],
  ['GET', /^\/api\/computer\/schedules$/],
  ['GET', /^\/api\/computer\/chats\/[^/]+\/events$/],
  ['GET', /^\/api\/chats\/[^/]+\/(transcript|timeline)$/],
  ['POST', /^\/api\/computer\/(chats|deliver|outbox\/ack|sync)$/],
  ['POST', /^\/api\/schedules\/[^/]+\/run$/],
  ['POST', /^\/api\/computer\/topics\/[^/]+\/open$/],
  ['POST', /^\/api\/chats\/[^/]+\/(messages|stop|restart)$/],
  ['POST', /^\/api\/topics\/[^/]+\/attachments$/],
  ['POST', /^\/api\/approvals\/[^/]+$/],
  ['POST', /^\/api\/inbox\/[^/]+\/(answer|dismiss|plan|pick)$/],
];

const COMPUTER_SCOPES: Array<[RegExp, 'chat' | 'topic' | 'approval' | 'inbox']> = [
  [/^\/api\/chats\/([^/]+)\//, 'chat'],
  [/^\/api\/computer\/chats\/([^/]+)\/events$/, 'chat'],
  [/^\/api\/topics\/([^/]+)\//, 'topic'],
  [/^\/api\/approvals\/([^/]+)$/, 'approval'],
  [/^\/api\/inbox\/([^/]+)\//, 'inbox'],
];

const STUB_ACTS = new Set(['messages', 'tab', 'load']);

const FORWARDED: Array<[RegExp, 'chat' | 'approval' | 'inbox']> = [
  [/^\/api\/chats\/([^/]+)\/(?:stop|restart)$/, 'chat'],
  [/^\/api\/approvals\/([^/]+)$/, 'approval'],
  [/^\/api\/inbox\/([^/]+)\/(?:answer|dismiss|plan|pick)$/, 'inbox'],
];

interface Access {
  origin: string;
  token: string | undefined;
  query: URLSearchParams;
}

export class RawBody {
  constructor(
    readonly type: string,
    readonly data: Buffer,
  ) {}
}

export interface Services {
  codeView: CodeView;
  sources: Sources;
  sourcesInfo(): SourcesInfo;
  pluginChecks?(): StatusItem[];
  harnessChecks?(): Promise<StatusItem[]>;
  home(): HomeSummary;
  dismissAlert(id: string): void;
  settings(): Promise<SettingsPage>;
  models(): ModelsConfig;
  composer(): ComposerConfig;
  owner(): OwnerInfo;
  harnesses(): HarnessChoice[];
  skills(profile?: string): SkillInfo[];
  files: HtmlFiles;
  snags?: Snags;
  codeViewToken?: string;
  desk?(): Promise<DeskScreen>;
  deskOrigins?: string[];
  deskToken?: string;
  localOpsToken?: string;
  webHost?: string;
  computers?: Computers;
  setup?: SetupOptions;
}

export type Handler = (body: Record<string, unknown>, params: string[], identity: Identity, access: Access) => Promise<unknown>;

export function createHttpServer(
  hos: Hos,
  terminals: TerminalAttachments,
  transport: Transport,
  passkeys: Passkeys,
  push: Push,
  webRoot: string | undefined,
  services?: Services,
): { server: Server; close(): Promise<void> } {
  let settingUp = false;
  const fromComputer = (req: IncomingMessage) => (services?.computers && cameThroughTransport(req) ? services.computers.inbound(bearer(req.headers.authorization)) : null);

  const signInRoutes: Array<[string, RegExp, Handler]> = [
    [
      'GET',
      /^\/api\/session$/,
      async (_, __, ___, { origin, token }) => ({ transport: transport.name, origin, ...passkeys.status(origin, token) }),
    ],
    ['POST', /^\/api\/passkeys\/register\/options$/, (body, __, ___, { origin }) => passkeys.registrationOptions(origin, optionalText(body, 'code'))],
    [
      'POST',
      /^\/api\/passkeys\/register$/,
      async (body, _, __, { origin }) => ({ token: await passkeys.register(origin, optionalText(body, 'code'), credential(body) as never) }),
    ],
    ['POST', /^\/api\/passkeys\/login\/options$/, (_, __, ___, { origin }) => passkeys.loginOptions(origin)],
    [
      'POST',
      /^\/api\/passkeys\/login$/,
      async (body, _, __, { origin }) => ({ token: await passkeys.login(origin, credential(body) as never) }),
    ],
    ['GET', /^\/api\/setup$/, async () => setupInfo(services?.setup)],
  ];
  const computers = services?.computers;
  const computerOpenRoutes: Array<[string, RegExp, Handler]> = computers
    ? [
        ['GET', /^\/api\/computer\/hello$/, async () => computers.self],
        ['POST', /^\/api\/computer\/pair$/, (body) => computers.pair(text(body, 'code'), text(body, 'name'), Number(body.apiVersion))],
      ]
    : [];
  const routes: Array<[string, RegExp, Handler]> = [
    [
      'GET',
      /^\/api\/previews\/(\d+)$/,
      async (_, [port]) => {
        const number = Number(port);
        if (number < 1 || number > 65535) throw new HosError(400, 'port must be between 1 and 65535');
        const url = await transport.previewUrl(number);
        if (!url) throw new HosError(503, `the ${transport.name} transport has no address yet (GET /api/doctor explains why)`);
        return { url };
      },
    ],
    [
      'POST',
      /^\/api\/setup\/brain$/,
      async (body) => {
        const setup = services?.setup;
        if (!setup || settingUp) throw new HosError(409, 'hos already has a brain; change it with --brain and a restart');
        settingUp = true;
        const { path: brain, lines } = await createBrain(
          {
            from: text(body, 'from') as BrainSource,
            path: text(body, 'path'),
            ...(optionalText(body, 'url') ? { url: optionalText(body, 'url')! } : {}),
            ...(optionalText(body, 'remote') ? { remote: optionalText(body, 'remote')! } : {}),
            ...(optionalText(body, 'name') ? { name: optionalText(body, 'name')! } : {}),
            ...(optionalText(body, 'timezone') ? { timezone: optionalText(body, 'timezone')! } : {}),
          },
          setup,
        ).finally(() => (settingUp = false));
        settingUp = true;
        setTimeout(() => setup.onBrain(brain), 50);
        return { brain, lines };
      },
    ],
    ['GET', /^\/api\/governor$/, async () => hos.governorStatus()],
    ['GET', /^\/api\/schedules$/, async () => hos.listSchedules()],
    ['GET', /^\/api\/profiles$/, async () => hos.listProfiles()],
    ['POST', /^\/api\/schedules$/, async (body) => hos.saveSchedule(body as unknown as ScheduleInput)],
    ['POST', /^\/api\/schedules\/([^/]+)$/, async (body, [id]) => hos.saveSchedule(body as unknown as ScheduleInput, decodeURIComponent(id!))],
    ['POST', /^\/api\/schedules\/([^/]+)\/pause$/, async (body, [id]) => hos.pauseSchedule(decodeURIComponent(id!), body.paused !== false)],
    ['POST', /^\/api\/schedules\/([^/]+)\/delete$/, async (_, [id]) => hos.deleteSchedule(decodeURIComponent(id!))],
    ['POST', /^\/api\/schedules\/([^/]+)\/run$/, (_, [id], identity) => hos.runSchedule(decodeURIComponent(id!), !identity.computer)],
    ['GET', /^\/api\/health$/, async () => hos.health(await transport.doctor(port()))],
    [
      'GET',
      /^\/api\/doctor\/checks$/,
      async () => {
        const checks = await hos.doctor(await transport.doctor(port()));
        const codeView = services?.codeView.doctorItem();
        const harnesses = (await services?.harnessChecks?.()) ?? [];
        return [...checks, ...harnesses, ...(codeView ? [codeView] : []), ...(services?.pluginChecks?.() ?? []), ...(services?.computers?.doctorItems() ?? [])];
      },
    ],
    ['GET', /^\/api\/snapshot$/, async () => hos.uiSnapshot()],
    ['GET', /^\/api\/projects$/, async () => hos.listProjects()],
    ['POST', /^\/api\/projects$/, (body) => hos.createProject(text(body, 'path'))],
    ['POST', /^\/api\/projects\/([^/]+)\/rename$/, (body, [projectId]) => hos.renameProject(decodeURIComponent(projectId!), text(body, 'name'))],
    ['POST', /^\/api\/projects\/([^/]+)\/pin$/, (body, [projectId]) => hos.setProjectPinned(decodeURIComponent(projectId!), body.pinned === true)],
    ['POST', /^\/api\/projects\/([^/]+)\/hide$/, (body, [projectId]) => hos.setProjectHidden(decodeURIComponent(projectId!), body.hidden === true)],
    ['POST', /^\/api\/projects\/([^/]+)\/remove$/, (_body, [projectId]) => hos.removeProject(decodeURIComponent(projectId!))],
    [
      'POST',
      /^\/api\/refresh$/,
      async () => {
        await hos.refresh();
        return { ok: true };
      },
    ],
    [
      'POST',
      /^\/api\/projects\/([^/]+)\/worktrees$/,
      (body, [projectId]) =>
        hos.createWorktree(decodeURIComponent(projectId!), {
          branch: text(body, 'branch'),
          baseRef: text(body, 'baseRef'),
          chatId: optionalText(body, 'chatId'),
        }),
    ],
    ['POST', /^\/api\/worktrees\/remove$/, (body) => hos.removeWorktree(text(body, 'path'), body.force === true)],
    ['GET', /^\/api\/topics$/, async () => hos.listTopics()],
    ['GET', /^\/api\/computer\/topics$/, async () => hos.computerTopics()],
    ['GET', /^\/api\/topics\/history$/, async () => hos.topicHistory()],
    [
      'POST',
      /^\/api\/topics$/,
      (body) =>
        hos.createTopic({
          title: text(body, 'title'),
          statusTopic: optionalText(body, 'statusTopic'),
          area: optionalText(body, 'area'),
          workspaceId: optionalText(body, 'workspaceId'),
          chatId: optionalText(body, 'chatId'),
        }),
    ],
    [
      'POST',
      /^\/api\/topics\/start$/,
      (body) =>
        hos.startTopic({
          text: text(body, 'text'),
          model: optionalText(body, 'model'),
          effort: optionalText(body, 'effort') as Effort | undefined,
          agent: optionalText(body, 'agent'),
          chrome: typeof body.chrome === 'boolean' ? body.chrome : undefined,
          desk: body.desk === true,
          profile: optionalText(body, 'profile'),
          computer: optionalText(body, 'computer'),
          files: Array.isArray(body.files)
            ? (body.files as Array<Record<string, unknown>>).map((file) => ({ name: String(file?.name ?? ''), data: typeof file?.data === 'string' ? file.data : '' }))
            : [],
        }),
    ],
    [
      'POST',
      /^\/api\/topics\/seen$/,
      async () => {
        hos.markAllTopicsSeen();
        return { ok: true };
      },
    ],
    ['POST', /^\/api\/topics\/([^/]+)\/rename$/, async (body, [topicId]) => hos.renameTopic(decodeURIComponent(topicId!), text(body, 'title'))],
    ['POST', /^\/api\/topics\/([^/]+)\/seen$/, async (_, [topicId]) => hos.markTopicSeen(decodeURIComponent(topicId!))],
    ['POST', /^\/api\/topics\/([^/]+)\/workspaces$/, async (body, [topicId]) => hos.attachWorkspace(decodeURIComponent(topicId!), text(body, 'workspaceId'))],
    [
      'POST',
      /^\/api\/topics\/([^/]+)\/workspaces\/([^/]+)\/detach$/,
      async (_, [topicId, workspaceId]) => hos.detachWorkspace(decodeURIComponent(topicId!), decodeURIComponent(workspaceId!)),
    ],
    [
      'POST',
      /^\/api\/topics\/([^/]+)\/workspaces\/([^/]+)\/remove$/,
      async (body, [topicId, workspaceId]) => hos.removeTopicWorkspace(decodeURIComponent(topicId!), decodeURIComponent(workspaceId!), body.force === true),
    ],
    ['GET', /^\/api\/workspaces$/, async (_, __, ___, { query }) => hos.listWorkspaces({ archived: query.get('archived') === '1' })],
    [
      'POST',
      /^\/api\/workspaces$/,
      (body) =>
        hos.createWorkspace({
          projectId: text(body, 'projectId'),
          kind: text(body, 'kind') as WorkspaceKind,
          branch: optionalText(body, 'branch'),
          baseRef: optionalText(body, 'baseRef'),
          path: optionalText(body, 'path'),
          chatId: optionalText(body, 'chatId'),
        }),
    ],
    ['POST', /^\/api\/topics\/([^/]+)\/tabs$/, async (body, [topicId]) => hos.setTabOrder(decodeURIComponent(topicId!), body.order)],
    ['POST', /^\/api\/topics\/([^/]+)\/state$/, (body, [topicId]) => hos.setTopicState(decodeURIComponent(topicId!), text(body, 'state') as TopicState)],
    ['POST', /^\/api\/topics\/([^/]+)\/archive$/, (_, [topicId]) => hos.archiveTopic(decodeURIComponent(topicId!))],
    ['POST', /^\/api\/chats\/([^/]+)\/handoff$/, async (body, [chatId]) => hos.triggerHandoff(decodeURIComponent(chatId!), handoffMode(body))],
    [
      'POST',
      /^\/api\/chats$/,
      (body) =>
        hos.createChat(text(body, 'topicId'), optionalText(body, 'role') as Role | undefined, {
          model: optionalText(body, 'model'),
          effort: optionalText(body, 'effort'),
          agent: optionalText(body, 'agent'),
        }),
    ],
    ['GET', /^\/api\/chats\/([^/]+)\/lineage$/, async (_, [chatId]) => hos.getLineage(decodeURIComponent(chatId!))],
    [
      'POST',
      /^\/api\/chats\/([^/]+)\/messages$/,
      async (body, [chatId]) => {
        await hos.sendMessage(decodeURIComponent(chatId!), text(body, 'text'), Array.isArray(body.attachments) ? (body.attachments as string[]) : []);
        return { ok: true };
      },
    ],
    [
      'GET',
      /^\/api\/chats\/([^/]+)\/diff\/(start|turn)$/,
      (_, [chatId, since]) => hos.getDiff({ chatId: decodeURIComponent(chatId!), since: since as 'start' | 'turn' }),
    ],
    [
      'GET',
      /^\/api\/workspaces\/([^/]+)\/diff(?:\/([^/]+))?$/,
      (_, [workspaceId, ref]) =>
        hos.getDiff({ workspaceId: decodeURIComponent(workspaceId!), ...(ref ? { ref: decodeURIComponent(ref) } : {}) }),
    ],
    ['POST', /^\/api\/workspaces\/([^/]+)\/discard$/, (body, [workspaceId]) => hos.discardFile(decodeURIComponent(workspaceId!), text(body, 'path'))],
    [
      'POST',
      /^\/api\/workspaces\/([^/]+)\/commit$/,
      (body, [workspaceId]) => hos.commit(decodeURIComponent(workspaceId!), typeof body.message === 'string' ? body.message : ''),
    ],
    ['POST', /^\/api\/workspaces\/([^/]+)\/pull-request$/, (_, [workspaceId]) => hos.openPullRequest(decodeURIComponent(workspaceId!))],
    [
      'POST',
      /^\/api\/chats\/([^/]+)\/review$/,
      async (body, [chatId]) => {
        await hos.sendReview(decodeURIComponent(chatId!), reviewComments(body));
        return { ok: true };
      },
    ],
    ['POST', /^\/api\/chats\/([^/]+)\/merge$/, (_, [chatId]) => hos.mergeBack(decodeURIComponent(chatId!))],
    ['POST', /^\/api\/chats\/([^/]+)\/takeover$/, (_, [chatId]) => hos.takeOver(decodeURIComponent(chatId!))],
    [
      'POST',
      /^\/api\/chats\/([^/]+)\/handback$/,
      async (_, [chatId]) => {
        await hos.handBack(decodeURIComponent(chatId!));
        return { ok: true };
      },
    ],
    [
      'GET',
      /^\/api\/topics\/([^/]+)\/search$/,
      (_, [topicId], _who, { query }) => hos.search(decodeURIComponent(topicId!), query.get('q') ?? ''),
    ],
    ['GET', /^\/api\/topics\/([^/]+)\/canvases\/(C\d+)$/, async (_, [topicId, ref]) => hos.canvases.card(decodeURIComponent(topicId!), ref!)],
    ['PUT', /^\/api\/topics\/([^/]+)\/canvases\/(C\d+)\/draft$/, async (body, [topicId, ref]) => hos.canvases.saveDraft(decodeURIComponent(topicId!), ref!, body)],
    ['POST', /^\/api\/topics\/([^/]+)\/canvases\/(C\d+)\/submit$/, (body, [topicId, ref]) => hos.canvases.submit(decodeURIComponent(topicId!), ref!, body)],
    ['POST', /^\/api\/topics\/([^/]+)\/canvases\/(C\d+)\/show$/, async (_, [topicId, ref]) => hos.canvases.show(decodeURIComponent(topicId!), ref!)],
    ['GET', /^\/api\/topics\/([^/]+)\/tasks$/, async (_, [topicId]) => hos.listTasks(decodeURIComponent(topicId!))],
    ['POST', /^\/api\/topics\/([^/]+)\/tasks$/, async (body, [topicId]) => hos.addTask(decodeURIComponent(topicId!), taskInput(body))],
    [
      'PUT',
      /^\/api\/topics\/([^/]+)\/tasks\/([^/]+)$/,
      async (body, [topicId, ref]) => hos.patchTask(decodeURIComponent(topicId!), decodeURIComponent(ref!), taskPatch(body)),
    ],
    [
      'POST',
      /^\/api\/topics\/([^/]+)\/tasks\/([^/]+)\/mirror$/,
      (body, [topicId, ref]) => hos.linkTask(decodeURIComponent(topicId!), decodeURIComponent(ref!), (body as { link?: unknown } | null)?.link !== false),
    ],
    ['GET', /^\/api\/topics\/([^/]+)\/locks$/, async (_, [topicId]) => hos.listLocks(decodeURIComponent(topicId!))],
    ['GET', /^\/api\/workspaces\/([^/]+)\/actions$/, async (_, [workspaceId]) => hos.listActions(decodeURIComponent(workspaceId!))],
    [
      'POST',
      /^\/api\/workspaces\/([^/]+)\/actions\/([^/]+)\/run$/,
      (body, [workspaceId, name], identity) =>
        hos.runCustomAction(decodeURIComponent(workspaceId!), decodeURIComponent(name!), {
          args: actionArgs(body),
          confirmed: body.confirmed === true,
          user: identity.user,
        }),
    ],
    ['GET', /^\/api\/action-runs\/([^/]+)$/, async (_, [runId]) => hos.getActionRun(decodeURIComponent(runId!))],
    ['GET', /^\/api\/chats\/([^/]+)\/transcript$/, (_, [chatId]) => hos.getTranscript(decodeURIComponent(chatId!))],
    ['GET', /^\/api\/chats\/([^/]+)\/timeline$/, async (_, [chatId]) => hos.chatTimeline(decodeURIComponent(chatId!))],
    ['GET', /^\/api\/terminals$/, (_, __, ___, { query }) => hos.listTerminals(query.get('topic') ?? undefined)],
    ['POST', /^\/api\/terminals\/([^/]+)\/kill$/, async (_, [name]) => (await hos.killTerminal(decodeURIComponent(name!)), {})],
    ['GET', /^\/api\/servers$/, () => hos.servers.list()],
    [
      'POST',
      /^\/api\/servers\/([^/]+)\/stop$/,
      async (_, [name]) => {
        await hos.servers.stop(decodeURIComponent(name!));
        return { ok: true };
      },
    ],
    ['POST', /^\/api\/servers\/([^/]+)\/restart$/, (_, [name]) => hos.servers.restart(decodeURIComponent(name!))],
    [
      'GET',
      /^\/api\/servers\/([^/]+)\/tail$/,
      async (_, [name], __, { query }) => ({
        output: await hos.servers.tail(decodeURIComponent(name!), Number(query.get('lines') ?? undefined)),
      }),
    ],
    [
      'POST',
      /^\/api\/servers$/,
      (body) =>
        hos.servers.start({
          worktreePath: text(body, 'worktreePath'),
          app: text(body, 'app'),
          command: text(body, 'command'),
          ...(body.port === undefined || body.port === null || body.port === '' ? {} : { port: Number(body.port) }),
        }),
    ],
    ['POST', /^\/api\/terminals$/, (body) => hos.createTerminal(text(body, 'worktreePath'), optionalText(body, 'topicId'))],
    ['POST', /^\/api\/login$/, (body) => hos.loginTerminal(optionalText(body, 'harness'))],
    [
      'POST',
      /^\/api\/approvals\/([^/]+)$/,
      async (body, [approvalId], identity) => {
        hos.decideApproval(decodeURIComponent(approvalId!), text(body, 'decision'), origin(body, identity));
        return { ok: true };
      },
    ],
    ['GET', /^\/api\/approvals$/, async () => hos.listApprovals()],
    ['GET', /^\/api\/kill$/, async () => hos.listKillSwitches()],
    [
      'POST',
      /^\/api\/kill$/,
      (body) =>
        hos.kill(text(body, 'scope') as KillScope | 'subtree', {
          topicId: optionalText(body, 'topicId'),
          chatId: optionalText(body, 'chatId'),
        }),
    ],
    [
      'POST',
      /^\/api\/kill\/lift$/,
      async (body) => {
        hos.liftKillSwitch(text(body, 'scope') as KillScope, optionalText(body, 'topicId'));
        return { ok: true };
      },
    ],
    ['GET', /^\/api\/inbox$/, async () => hos.listInbox()],
    ['GET', /^\/api\/push$/, async () => push.status()],
    ['POST', /^\/api\/push\/subscriptions$/, async (body) => push.subscribe(pushTarget(body), optionalText(body, 'label') ?? 'device')],
    [
      'POST',
      /^\/api\/push\/subscriptions\/remove$/,
      async (body) => {
        push.unsubscribe(text(body, 'endpoint'));
        return { ok: true };
      },
    ],
    ['POST', /^\/api\/push\/test$/, () => push.test()],
    [
      'POST',
      /^\/api\/inbox\/([^/]+)\/answer$/,
      async (body, [itemId], identity) => {
        hos.answerQuestion(decodeURIComponent(itemId!), answers(body), origin(body, identity));
        return { ok: true };
      },
    ],
    [
      'POST',
      /^\/api\/inbox\/([^/]+)\/dismiss$/,
      async (_, [itemId]) => {
        hos.dismissInboxItem(decodeURIComponent(itemId!));
        return { ok: true };
      },
    ],
    ...configRoutes(hos),
    ...(services ? serviceRoutes(services, hos) : []),
    ['GET', /^\/api\/workspaces\/([^/]+)\/setup-log$/, (_, [workspaceId]) => hos.workspaces.setupLog(decodeURIComponent(workspaceId!))],
    ['POST', /^\/api\/workspaces\/([^/]+)\/setup$/, async (_, [workspaceId]) => hos.workspaces.rerunSetup(decodeURIComponent(workspaceId!))],
    ['POST', /^\/api\/workspaces\/([^/]+)\/rename$/, (body, [workspaceId]) => hos.workspaces.rename(decodeURIComponent(workspaceId!), text(body, 'branch'))],
    [
      'POST',
      /^\/api\/workspaces\/([^/]+)\/archive$/,
      (body, [workspaceId]) => {
        const id = decodeURIComponent(workspaceId!);
        hos.workspaces.assertWorktree(id);
        return hos.workspaces.archive(id, body.force === true);
      },
    ],
    [
      'POST',
      /^\/api\/workspaces\/([^/]+)\/delete$/,
      (_, [workspaceId]) => {
        const id = decodeURIComponent(workspaceId!);
        hos.workspaces.assertWorktree(id);
        return hos.workspaces.delete(id);
      },
    ],
    ['POST', /^\/api\/workspaces\/([^/]+)\/terminal$/, (body, [workspaceId]) => hos.workspaces.terminal(decodeURIComponent(workspaceId!), optionalText(body, 'topicId'))],
    [
      'POST',
      /^\/api\/inbox\/([^/]+)\/pick$/,
      async (body, [itemId], identity) =>
        hos.pickWorkspace(decodeURIComponent(itemId!), text(body, 'choice'), typeof body.branch === 'string' ? body.branch : undefined, origin(body, identity)),
    ],
    [
      'POST',
      /^\/api\/inbox\/([^/]+)\/pick-remove$/,
      async (body, [itemId], identity) =>
        hos.removePickerWorktree(decodeURIComponent(itemId!), text(body, 'choice'), body.force === true, origin(body, identity)),
    ],
    ['GET', /^\/api\/topics\/([^/]+)\/panel$/, (_, [topicId]) => hos.topicPanel(decodeURIComponent(topicId!))],
    ['POST', /^\/api\/workspaces\/([^/]+)\/push$/, (_, [workspaceId]) => hos.pushWorkspace(decodeURIComponent(workspaceId!))],
    ['POST', /^\/api\/workspaces\/([^/]+)\/pull$/, (_, [workspaceId]) => hos.pullWorkspace(decodeURIComponent(workspaceId!))],
    ['POST', /^\/api\/workspaces\/([^/]+)\/fetch$/, (_, [workspaceId]) => hos.fetchWorkspace(decodeURIComponent(workspaceId!))],
    ['POST', /^\/api\/workspaces\/([^/]+)\/review$/, (_, [workspaceId]) => hos.reviewWorkspace(decodeURIComponent(workspaceId!))],
    [
      'POST',
      /^\/api\/inbox\/([^/]+)\/plan$/,
      async (body, [itemId], identity) => {
        await hos.decidePlan(decodeURIComponent(itemId!), text(body, 'decision'), optionalText(body, 'text'), origin(body, identity));
        return { ok: true };
      },
    ],
    ['POST', /^\/api\/chats\/([^/]+)\/stop$/, (_, [chatId]) => hos.stopChat(decodeURIComponent(chatId!))],
    ['POST', /^\/api\/chats\/([^/]+)\/context-refresh$/, async (_, [chatId]) => hos.refreshContext(decodeURIComponent(chatId!))],
    ['POST', /^\/api\/chats\/([^/]+)\/restart$/, (_, [chatId]) => hos.restartChat(decodeURIComponent(chatId!))],
    [
      'POST',
      /^\/api\/chats\/([^/]+)\/pick$/,
      async (body, [chatId]) => hos.setChatPick(decodeURIComponent(chatId!), { model: optionalText(body, 'model'), effort: optionalText(body, 'effort') }),
    ],
    ['POST', /^\/api\/chats\/([^/]+)\/tab$/, async (body, [chatId]) => hos.setChatTabClosed(decodeURIComponent(chatId!), body.closed === true)],
    ['POST', /^\/api\/chats\/([^/]+)\/load$/, async (_, [chatId]) => hos.loadRemoteChat(decodeURIComponent(chatId!))],
    ['POST', /^\/api\/chats\/([^/]+)\/notify$/, async (body, [chatId]) => hos.setChatNotify(decodeURIComponent(chatId!), body.notify)],
    [
      'POST',
      /^\/api\/chats\/([^/]+)\/links$/,
      (body, [chatId]) => hos.linkChat(decodeURIComponent(chatId!), { chatId: optionalText(body, 'chatId'), diagramId: optionalText(body, 'diagramId') }),
    ],
    ['DELETE', /^\/api\/chats\/([^/]+)\/links\/([^/]+)$/, async (_, [chatId, target]) => hos.unlinkChat(decodeURIComponent(chatId!), decodeURIComponent(target!))],
    [
      'POST',
      /^\/api\/topics\/([^/]+)\/chats$/,
      (body, [topicId]) =>
        hos.addTopicChat(
          decodeURIComponent(topicId!),
          {
            model: optionalText(body, 'model'),
            effort: optionalText(body, 'effort'),
            agent: optionalText(body, 'agent'),
            chrome: typeof body.chrome === 'boolean' ? body.chrome : undefined,
            profile: optionalText(body, 'profile'),
            computer: optionalText(body, 'computer'),
          },
          optionalText(body, 'diagramId'),
        ),
    ],
    [
      'POST',
      /^\/api\/topics\/([^/]+)\/attachments$/,
      (body, [topicId]) => hos.saveTopicAttachment(decodeURIComponent(topicId!), text(body, 'name'), typeof body.data === 'string' ? body.data : ''),
    ],
    ['GET', /^\/api\/topics\/([^/]+)\/diagrams$/, (_, [topicId]) => diagrams().list({ topicId: decodeURIComponent(topicId!) })],
    ['POST', /^\/api\/topics\/([^/]+)\/diagrams$/, (body, [topicId]) => hos.createDiagram(optionalText(body, 'title'), decodeURIComponent(topicId!))],
    ['GET', /^\/api\/diagrams$/, async (_, __, ___, { query }) => diagrams().list({ query: query.get('query') ?? undefined })],
    ['POST', /^\/api\/diagrams$/, (body) => hos.createDiagram(optionalText(body, 'title'))],
    ['GET', /^\/api\/diagrams\/([^/]+)$/, (_, [diagramId]) => diagrams().info(decodeURIComponent(diagramId!))],
    ['POST', /^\/api\/diagrams\/([^/]+)\/rename$/, (body, [diagramId]) => hos.renameDiagram(decodeURIComponent(diagramId!), text(body, 'title'))],
    ['GET', /^\/api\/diagrams\/([^/]+)\/scene$/, (_, [diagramId]) => diagrams().scene(decodeURIComponent(diagramId!))],
    ['GET', /^\/api\/diagrams\/([^/]+)\/versions$/, (_, [diagramId]) => diagrams().versions(decodeURIComponent(diagramId!))],
    ['POST', /^\/api\/diagrams\/([^/]+)\/restore$/, (body, [diagramId]) => diagrams().restore(decodeURIComponent(diagramId!), text(body, 'sha'))],
    [
      'POST',
      /^\/api\/diagrams\/([^/]+)\/applies\/([^/]+)\/undo$/,
      (_, [diagramId, applyId]) => diagrams().undo(decodeURIComponent(diagramId!), decodeURIComponent(applyId!)),
    ],
  ];
  const diagrams = () => {
    if (!hos.diagrams) throw new HosError(400, 'hos has no brain (start it with --brain), so there is nowhere to keep diagrams');
    return hos.diagrams;
  };

  const previewPort = async (req: IncomingMessage): Promise<{ port: number } | { refuse: number } | null> => {
    const target = transport.previewPort?.(req.headers.host) ?? null;
    if (target === null) return null;
    if (target < 1 || target > 65535 || target === port()) return { refuse: 404 };
    return (await transport.identify(req)) ? { port: target } : { refuse: 401 };
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://hos.local');
    const preview = await previewPort(req);
    if (preview && 'refuse' in preview) return sendJson(res, preview.refuse, { error: 'no such preview, or no valid Cloudflare Access token' });
    if (preview) return proxyPreview(preview.port, req, res);
    if (url.pathname === BUS_PATH) {
      if (cameThroughTransport(req)) return sendJson(res, 403, { error: 'the bus is for local agents only' });
      return handleBusRequest(hos, req, res, services?.snags).catch((error: unknown) => {
        console.error(error);
        if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      });
    }
    if (url.pathname === '/healthz') {
      if (cameThroughTransport(req) || !fromLoopback(req)) return sendJson(res, 403, { error: 'the health check is for this machine only' });
      return sendJson(res, 200, { ok: true, pid: process.pid });
    }
    const shared = /^\/files\/([0-9a-f]+)\/(.+)$/.exec(url.pathname);
    const localHandoff = /^\/local\/chats\/([^/]+)\/handoff$/.exec(url.pathname);
    if (localHandoff && services?.localOpsToken) {
      if (cameThroughTransport(req) || !fromLoopback(req)) return sendJson(res, 403, { error: 'local ops come from this Mac only' });
      if (bearer(req.headers.authorization) !== services.localOpsToken) return sendJson(res, 401, { error: 'unknown local-ops token' });
      try {
        const chatId = decodeURIComponent(localHandoff[1]!);
        if (req.method === 'GET') return sendJson(res, 200, hos.handoffStatus(chatId));
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'GET the status or POST a handoff' });
        return sendJson(res, 200, hos.triggerHandoff(chatId, handoffMode(await readJson(req))));
      } catch (error) {
        if (error instanceof HosError) return sendJson(res, error.status, { error: error.message });
        console.error(error);
        return sendJson(res, 500, { error: 'internal error' });
      }
    }
    if (url.pathname === '/local/locks' && services?.localOpsToken) {
      if (cameThroughTransport(req) || !fromLoopback(req)) return sendJson(res, 403, { error: 'local ops come from this Mac only' });
      if (bearer(req.headers.authorization) !== services.localOpsToken) return sendJson(res, 401, { error: 'unknown local-ops token' });
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'GET the holders of ?pattern=' });
      return sendJson(res, 200, { holders: hos.lockHolders(url.searchParams.get('pattern') ?? '') });
    }
    // Local-ops snag resolve, so the land-hos action's script can close snags once a branch lands (H6). Same loopback +
    // local-ops token gate as the other /local routes, and the same commit-ref-or-state rule as the bus (H9).
    const localSnag = /^\/local\/snags\/([^/]+)\/resolve$/.exec(url.pathname);
    if (localSnag && services?.snags && services.localOpsToken) {
      if (cameThroughTransport(req) || !fromLoopback(req)) return sendJson(res, 403, { error: 'local ops come from this Mac only' });
      if (bearer(req.headers.authorization) !== services.localOpsToken) return sendJson(res, 401, { error: 'unknown local-ops token' });
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST { note?, state? } to resolve a snag' });
      try {
        const body = await readJson(req);
        const note = typeof body.note === 'string' ? body.note : undefined;
        const state = body.state === 'wontfix' || body.state === 'not-reproduced' ? body.state : undefined;
        const snag = await services.snags.resolveChecked(decodeURIComponent(localSnag[1]!), 'you', note, state);
        return sendJson(res, 200, { ref: snag.ref, state: snag.state });
      } catch (error) {
        if (error instanceof HosError) return sendJson(res, error.status, { error: error.message });
        console.error(error);
        return sendJson(res, 500, { error: 'internal error' });
      }
    }
    if (CODE_VIEW_SNAGS_PATHS.includes(url.pathname) && services?.snags && services.codeViewToken) {
      if (cameThroughTransport(req) || !fromLoopback(req)) return sendJson(res, 403, { error: 'Code view snags come from the local hos-code only' });
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST a snag' });
      if (bearer(req.headers.authorization) !== services.codeViewToken) return sendJson(res, 401, { error: 'unknown hos-code token' });
      try {
        const body = await readJson(req);
        const snag = await services.snags.add(
          { kind: body.kind as NewSnag['kind'], text: typeof body.text === 'string' ? body.text : '', ...(Array.isArray(body.files) ? { files: body.files as NewSnag['files'] } : {}) },
          'you',
        );
        return sendJson(res, 201, { ref: snag.ref });
      } catch (error) {
        if (error instanceof HosError) return sendJson(res, error.status, { error: error.message });
        console.error(error);
        return sendJson(res, 500, { error: 'internal error' });
      }
    }
    if (CODE_VIEW_PR_PATHS.includes(url.pathname) && services) {
      if (req.method !== 'GET') return sendJson(res, 405, { error: `GET ${CODE_VIEW_PR_PATHS[0]}?url=<pull request>&topic=<topic id>` });
      if (!(await transport.identify(req))) return sendJson(res, 401, { error: `unauthenticated: open hos through ${transport.name}` });
      const pr = url.searchParams.get('url') ?? '';
      const topic = url.searchParams.get('topic') ?? '';
      // The viewer URL carries its login token, so only a passkey session gets it; a browser click goes through the web app's sign-in.
      if (!passkeys.isSignedIn(await webOrigin().catch(() => ''), bearer(req.headers.authorization))) {
        return void res.writeHead(302, { location: codePrHref(pr, topic), 'cache-control': 'no-store' }).end();
      }
      try {
        return void res.writeHead(302, { location: (await openPrLink(hos, services, pr, topic)).url, 'cache-control': 'no-store' }).end();
      } catch (error) {
        if (error instanceof HosError) return sendJson(res, error.status, { error: error.message });
        console.error(error);
        return sendJson(res, 500, { error: 'internal error' });
      }
    }
    if (CODE_VIEW_REVIEW_PATHS.includes(url.pathname) && services?.codeViewToken) {
      if (cameThroughTransport(req) || !fromLoopback(req)) return sendJson(res, 403, { error: 'Code view reviews come from the local hos-code only' });
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST { action: start | comment | end, pr, … }' });
      if (bearer(req.headers.authorization) !== services.codeViewToken) return sendJson(res, 401, { error: 'unknown hos-code token' });
      try {
        const body = await readJson(req);
        const pr = typeof body.pr === 'string' ? body.pr : '';
        if (body.action === 'start') return sendJson(res, 201, await hos.prReviews.start(pr, typeof body.head === 'string' ? body.head : '', body.chat === true));
        if (body.action === 'end') return sendJson(res, 201, await hos.prReviews.end(pr));
        if (body.action !== 'comment') throw new HosError(400, 'action must be start, comment or end');
        const comment = {
          path: typeof body.path === 'string' ? body.path : '',
          line: typeof body.line === 'number' ? body.line : 0,
          body: typeof body.body === 'string' ? body.body : '',
          ...(typeof body.side === 'string' ? { side: body.side } : {}),
        };
        return sendJson(res, 201, await hos.prReviews.comment(pr, comment));
      } catch (error) {
        if (error instanceof HosError) return sendJson(res, error.status, { error: error.message });
        console.error(error);
        return sendJson(res, 500, { error: 'internal error' });
      }
    }
    if (url.pathname === DESK_PATH && services?.desk && services.deskToken) {
      const origins = services.deskOrigins ?? [];
      if (req.method === 'OPTIONS') return void res.writeHead(204, deskCors(req.headers, true, origins)).end();
      const cors = deskCors(req.headers, false, origins);
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'GET the desk screen' }, cors);
      if (bearer(req.headers.authorization) !== services.deskToken) return sendJson(res, 401, { error: 'unknown desk token' }, cors);
      try {
        return sendJson(res, 200, await services.desk(), { ...cors, 'cache-control': 'no-store' });
      } catch (error) {
        console.error(error);
        return sendJson(res, 500, { error: 'internal error' }, cors);
      }
    }
    if (shared && services) {
      if (!(await transport.identify(req))) return sendJson(res, 401, { error: `unauthenticated: open hos through ${transport.name}` });
      return serveShared(services.files, shared[1]!, shared[2]!, res);
    }
    if (!url.pathname.startsWith('/api/')) return serveStatic(webRoot, url.pathname, res, services?.webHost);
    try {
      if (req.method === 'GET' && url.pathname === '/api/doctor') {
        return sendJson(res, 200, { ...(await transport.doctor(port())), passkeys: passkeys.registeredOrigins() });
      }
      const who = await transport.identify(req);
      if (!who) throw new HosError(401, `unauthenticated: open hos through ${transport.name} (GET /api/doctor explains how)`);
      const computer = fromComputer(req);
      if (computer && !COMPUTER_ROUTES.some(([method, pattern]) => req.method === method && pattern.test(url.pathname))) {
        throw new HosError(403, `${computer} may not do this here; act on this hos through its own URL`);
      }
      const scope = computer ? COMPUTER_SCOPES.find(([pattern]) => pattern.test(url.pathname)) : undefined;
      if (scope && !hos.sharedWithComputer(computer!, scope[1], decodeURIComponent(scope[0].exec(url.pathname)![1]!))) {
        throw new HosError(404, `nothing at ${url.pathname} is shared with ${computer}`);
      }
      const identity: Identity = computer ? { user: `${who.user} via ${computer}`, via: 'computer', computer } : who;
      const access = { origin: await webOrigin(), token: bearer(req.headers.authorization), query: url.searchParams };
      const route = async (table: Array<[string, RegExp, Handler]>) => {
        for (const [method, pattern, handler] of table) {
          const match = pattern.exec(url.pathname);
          if (match && req.method === method) {
            const out = await handler(await readJson(req), match.slice(1), identity, access);
            if (out instanceof RawBody) sendRaw(res, out);
            else sendJson(res, method === 'POST' ? 201 : 200, out);
            return true;
          }
        }
        return false;
      };
      if (await route(signInRoutes)) return;
      if (await route(computerOpenRoutes)) return;
      if (!computer && !passkeys.isSignedIn(access.origin, access.token)) throw new HosError(401, 'sign in with your hos passkey');
      const forwarded = req.method === 'POST' && !computer ? FORWARDED.find(([pattern]) => pattern.test(url.pathname)) : undefined;
      const owner = forwarded && hos.actsElsewhere(forwarded[1], decodeURIComponent(forwarded[0].exec(url.pathname)![1]!));
      if (owner && services?.computers) return sendJson(res, 201, await services.computers.post(owner, url.pathname, await readJson(req)));
      const acted = req.method === 'POST' ? /^\/api\/chats\/([^/]+)\/([^/]+)$/.exec(url.pathname) : null;
      const runsOn = acted && !STUB_ACTS.has(acted[2]!) ? hos.chatComputer(decodeURIComponent(acted[1]!)) : undefined;
      if (runsOn) throw new HosError(409, `this chat runs on ${runsOn}; act on it there`);
      if (await route(routes)) return;
      throw new HosError(404, `no route ${req.method} ${url.pathname}`);
    } catch (error) {
      if (error instanceof HosError) return sendJson(res, error.status, { error: error.message });
      console.error(error);
      sendJson(res, 500, { error: 'internal error' });
    }
  });

  const port = () => (server.address() as AddressInfo).port;
  const webOrigin = async () => {
    const found = await transport.webOrigin(port());
    if (!found) throw new HosError(503, `the ${transport.name} transport has no address yet (GET /api/doctor explains why)`);
    return found;
  };
  const sockets = new WebSocketServer({ noServer: true, handleProtocols: () => 'hos' });
  const previewSockets = new Set<Duplex>();
  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://hos.local');
    const refuse = (status: string) => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    const preview = await previewPort(req);
    if (preview && 'refuse' in preview) return void refuse(preview.refuse === 401 ? '401 Unauthorized' : '404 Not Found');
    if (preview) {
      previewSockets.add(socket);
      socket.once('close', () => previewSockets.delete(socket));
      return proxyPreviewUpgrade(preview.port, req, socket, head, () => refuse('502 Bad Gateway'));
    }
    if (!(await transport.identify(req))) return void refuse('401 Unauthorized');
    const computer = fromComputer(req);
    const token = bearer(req.headers.authorization) ?? protocolToken(req.headers['sec-websocket-protocol']);
    if (!computer && !passkeys.isSignedIn(await webOrigin().catch(() => ''), token)) return void refuse('401 Unauthorized');
    if (computer && url.pathname !== '/api/events') return void refuse('403 Forbidden');
    const terminal = /^\/api\/terminals\/([^/]+)\/attach$/.exec(url.pathname)?.[1];
    if (terminal) {
      const name = decodeURIComponent(terminal);
      if (!(await hos.hasTerminal(name))) return void refuse('404 Not Found');
      const size = { cols: Number(url.searchParams.get('cols')), rows: Number(url.searchParams.get('rows')) };
      return sockets.handleUpgrade(req, socket, head, (ws) => terminals.attach(name, size, ws));
    }
    const diagram = /^\/api\/diagrams\/([^/]+)\/live$/.exec(url.pathname)?.[1];
    if (diagram) {
      if (!hos.diagrams) return void refuse('403 Forbidden');
      const room = hos.diagrams;
      return sockets.handleUpgrade(req, socket, head, (ws) => room.attach(decodeURIComponent(diagram), ws));
    }
    if (url.pathname !== '/api/events') return void refuse('404 Not Found');
    sockets.handleUpgrade(req, socket, head, (ws) => {
      const asked = Number(url.searchParams.get('since') ?? 0) || 0;
      let caughtUp: HosEvent[] | null = [];
      const unsubscribe = hos.subscribe(computer ? hos.relaySince(asked) : asked, (event) => {
        if (computer && !hos.relayed(computer, event)) return;
        if (caughtUp) return void caughtUp.push(event);
        ws.send(JSON.stringify(event));
      });
      for (let at = 0; at < caughtUp.length; at += CATCH_UP_FRAME) ws.send(JSON.stringify(caughtUp.slice(at, at + CATCH_UP_FRAME)));
      caughtUp = null;
      const unwatch = computer && services?.computers ? services.computers.watchOutbox(computer, (outbox) => ws.send(JSON.stringify({ outbox }))) : () => {};
      ws.on('message', (data) => {
        const active = computer ? null : presenceOf(String(data));
        if (active !== null) push.presence(ws, active);
      });
      ws.on('close', () => {
        unsubscribe();
        unwatch();
        push.presence(ws, false);
      });
    });
  });
  return {
    server,
    async close() {
      for (const client of sockets.clients) client.terminate();
      for (const socket of previewSockets) socket.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function configRoutes(hos: Hos): Array<[string, RegExp, Handler]> {
  const vault = hos.config;
  return [
    ['GET', /^\/api\/config$/, () => vault.tree()],
    ['GET', /^\/api\/config\/file$/, (_, __, ___, { query }) => vault.read(query.get('repo') ?? '', query.get('path') ?? '')],
    ['POST', /^\/api\/config\/reveal$/, (body) => vault.reveal(text(body, 'repo'), text(body, 'path'), text(body, 'key'))],
    ['POST', /^\/api\/config\/save$/, (body) => vault.save(body as unknown as ConfigSave)],
    ['POST', /^\/api\/config\/remove$/, (body) => vault.remove(text(body, 'repo'), text(body, 'path'))],
    ['POST', /^\/api\/config\/preview$/, (body) => vault.preview(text(body, 'repo'), text(body, 'path'), body.targets)],
    ['POST', /^\/api\/config\/apply$/, (body) => vault.apply(text(body, 'repo'), text(body, 'path'), body.targets)],
    ['POST', /^\/api\/config\/restore$/, (body) => vault.restore(text(body, 'repo'), text(body, 'path'), body.target)],
    ['POST', /^\/api\/config\/import$/, (body) => vault.importRoot(text(body, 'repo'))],
  ];
}

async function openPrLink(hos: Hos, services: Services, pr: string, topic: string): Promise<{ url: string }> {
  const link = hos.prReviews.link(pr, topic);
  const opened = await services.codeView.openPr(link, await hos.prReviews.checkoutFor(link), link.port);
  hos.prReviews.setPort(link.url, opened.port);
  return { url: opened.url };
}

function serviceRoutes(services: Services, hos: Hos): Array<[string, RegExp, Handler]> {
  return [
    ['POST', /^\/api\/(?:code|px0)$/, (body) => (hos.requireReadyAt(text(body, 'path')), services.codeView.open(text(body, 'path'), optionalText(body, 'file')))],
    ['POST', /^\/api\/code\/pr$/, (body) => openPrLink(hos, services, text(body, 'url'), text(body, 'topic'))],
    ['POST', /^\/api\/files\/open$/, (body) => services.files.open(text(body, 'path'))],
    [
      'POST',
      /^\/api\/topics\/([^/]+)\/canvases\/(C\d+)\/html$/,
      async (body, [topicId, ref]) => services.files.open(await hos.canvases.htmlFile(decodeURIComponent(topicId!), ref!, text(body, 'block')), true),
    ],
    ['GET', /^\/api\/sources$/, async () => services.sourcesInfo()],
    ['GET', /^\/api\/me\/today$/, () => source(services.sources.tasks, 'tasks').today()],
    ['POST', /^\/api\/me\/tasks\/([^/]+)\/done$/, (_, [taskId]) => source(services.sources.tasks, 'tasks').done(decodeURIComponent(taskId!))],
    ['POST', /^\/api\/me\/capture$/, (body) => source(services.sources.capture, 'capture').capture(text(body, 'text'))],
    ['GET', /^\/api\/me\/calendar$/, () => source(services.sources.calendar, 'calendar').today()],
    [
      'GET',
      /^\/api\/me\/now$/,
      async () => {
        const calendar = source(services.sources.calendar, 'calendar');
        if (!calendar.now) throw new HosError(404, `${calendar.label} gives no time blocks`);
        return calendar.now();
      },
    ],
    ['GET', /^\/api\/home$/, async () => services.home()],
    ['GET', /^\/api\/settings$/, () => services.settings()],
    [
      'POST',
      /^\/api\/home\/alerts\/([^/]+)\/dismiss$/,
      async (_, [alertId]) => {
        services.dismissAlert(decodeURIComponent(alertId!));
        return { ok: true };
      },
    ],
    ['GET', /^\/api\/models$/, async () => services.models()],
    ['GET', /^\/api\/composer$/, async () => services.composer()],
    ['GET', /^\/api\/owner$/, async () => services.owner()],
    ['GET', /^\/api\/harnesses$/, async () => services.harnesses()],
    ['GET', /^\/api\/skills$/, async (_, __, ___, { query }) => services.skills(query.get('profile') ?? undefined)],
    ...(services.computers ? computerRoutes(services.computers, hos) : []),
    ...(services.snags ? snagRoutes(services.snags) : []),
  ];
}

function computerRoutes(computers: Computers, hos: Hos): Array<[string, RegExp, Handler]> {
  const caller =(identity: Identity) => {
    if (!identity.computer) throw new HosError(403, 'only a paired computer calls this');
    return identity.computer;
  };
  return [
    [
      'POST',
      /^\/api\/computer\/chats$/,
      async (body, _, identity) => {
        const from = caller(identity);
        const input = body as unknown as RemoteChatInput;
        if (input.pick?.chrome && !(await computers.caps()).browser) throw new HosError(409, 'no Chrome here, so no browser chat');
        return hos.acceptRemoteChat(input, from);
      },
    ],
    [
      'POST',
      /^\/api\/computer\/deliver$/,
      async (body, _, identity) => ({ outcome: await hos.deliverFromComputer(caller(identity), text(body, 'chatId'), text(body, 'text'), optionalText(body, 'fromChatId')) }),
    ],
    [
      'POST',
      /^\/api\/computer\/outbox\/ack$/,
      async (body, _, identity) => {
        computers.ack(caller(identity), Number(body.seq));
        return { ok: true };
      },
    ],
    ['POST', /^\/api\/computer\/topics\/([^/]+)\/open$/, async (_, [id], identity) => hos.openForComputer(caller(identity), decodeURIComponent(id!))],
    [
      'GET',
      /^\/api\/computer\/chats\/([^/]+)\/events$/,
      async (_, [id], identity, { query }) => hos.chatHistoryForComputer(caller(identity), decodeURIComponent(id!), Number(query.get('after')), Number(query.get('limit'))),
    ],
    ['GET', /^\/api\/computer\/schedules$/, async (_, __, identity) => (caller(identity), hos.ownSchedules())],
    [
      'POST',
      /^\/api\/computer\/sync$/,
      async (body, _, identity) => {
        caller(identity);
        await hos.syncBrainTo(text(body, 'sha'));
        return hos.ownSchedules();
      },
    ],
    [
      'POST',
      /^\/api\/computers\/([^/]+)\/topics\/([^/]+)\/open$/,
      (_, [name, id]) => hos.openComputerTopic(decodeURIComponent(name!), decodeURIComponent(id!)),
    ],
    [
      'GET',
      /^\/api\/computers$/,
      async (_, __, ___, { query }) => {
        if (query.get('poll') === '1') await computers.poll();
        return computers.view();
      },
    ],
    ['POST', /^\/api\/computers$/, (body) => computers.add(text(body, 'url'), text(body, 'code'))],
    [
      'DELETE',
      /^\/api\/computers\/([^/]+)$/,
      async (_, [name]) => {
        computers.remove(decodeURIComponent(name!));
        return { ok: true };
      },
    ],
    ['POST', /^\/api\/computer\/pair-code$/, async () => computers.pairCode()],
    ['GET', /^\/api\/computer\/caps$/, () => computers.caps()],
  ];
}

function previewHeaders(req: IncomingMessage): IncomingHttpHeaders {
  const { 'cf-access-jwt-assertion': _token, cookie, ...headers } = req.headers;
  const kept = cookie
    ?.split(';')
    .map((c) => c.trim())
    .filter((c) => c && !c.startsWith('CF_Authorization='))
    .join('; ');
  return kept ? { ...headers, cookie: kept } : headers;
}

function proxyPreview(port: number, req: IncomingMessage, res: ServerResponse): void {
  const upstream = request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers: previewHeaders(req) }, (answer) => {
    res.writeHead(answer.statusCode ?? 502, answer.headers);
    answer.pipe(res);
  });
  upstream.on('error', () => (res.headersSent ? res.destroy() : sendJson(res, 502, { error: `nothing answers on port ${port}` })));
  req.pipe(upstream);
}

function proxyPreviewUpgrade(port: number, req: IncomingMessage, socket: Duplex, head: Buffer, refuse: () => void): void {
  let connected = false;
  const upstream = connect(port, '127.0.0.1', () => {
    connected = true;
    const lines = Object.entries(previewHeaders(req)).flatMap(([name, value]) =>
      (Array.isArray(value) ? value : [value]).map((v) => `${name}: ${v}`),
    );
    upstream.write([`${req.method} ${req.url} HTTP/1.1`, ...lines, '', ''].join('\r\n'));
    if (head.length) upstream.write(head);
    upstream.pipe(socket).pipe(upstream);
  });
  upstream.on('error', () => (connected ? socket.destroy() : refuse()));
  socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy());
}

function cameThroughTransport(req: IncomingMessage): boolean {
  return ['tailscale-user-login', 'x-forwarded-for', 'cf-access-jwt-assertion'].some((header) => header in req.headers);
}

function bearer(header: string | undefined): string | undefined {
  return /^Bearer (\S+)$/.exec(header ?? '')?.[1];
}

function protocolToken(header: string | undefined): string | undefined {
  return header
    ?.split(',')
    .map((p) => p.trim())
    .find((p) => p.startsWith(SESSION_PROTOCOL))
    ?.slice(SESSION_PROTOCOL.length);
}

function credential(body: Record<string, unknown>): Record<string, unknown> {
  const value = body.response;
  if (!value || typeof value !== 'object') throw new HosError(400, 'response must be the passkey credential');
  return value as Record<string, unknown>;
}

function text(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || !value.trim()) throw new HosError(400, `${key} is required`);
  return value;
}

function handoffMode(body: Record<string, unknown>): 'write' | 'salvage' {
  const mode = body.mode ?? 'write';
  if (mode !== 'write' && mode !== 'salvage') throw new HosError(400, 'mode is write or salvage');
  return mode;
}

function taskPriority(value: unknown): TaskPriority | undefined {
  if (value === undefined) return undefined;
  if (value !== 1 && value !== 2 && value !== 3) throw new HosError(400, 'priority is 1, 2 or 3');
  return value;
}

function taskInput(body: Record<string, unknown>): { title?: string; priority?: TaskPriority; criteria?: string[] } {
  const priority = taskPriority(body.priority);
  const criteria = Array.isArray(body.criteria) ? body.criteria.filter((c): c is string => typeof c === 'string') : undefined;
  return { title: text(body, 'title'), ...(priority ? { priority } : {}), ...(criteria ? { criteria } : {}) };
}

const PATCH_STATES = ['open', 'claimed', 'review', 'blocked', 'done', 'dropped'] as const;

function taskPatch(body: Record<string, unknown>): TaskPatch {
  const patch: TaskPatch = {};
  const priority = taskPriority(body.priority);
  if (priority) patch.priority = priority;
  if (body.move !== undefined) {
    if (body.move !== 'up' && body.move !== 'down') throw new HosError(400, 'move is up or down');
    patch.move = body.move;
  }
  if (body.state !== undefined) {
    if (!PATCH_STATES.includes(body.state as TaskPatch['state'] & string)) throw new HosError(400, `state is one of ${PATCH_STATES.join(', ')}`);
    patch.state = body.state as TaskPatch['state'];
  }
  if (body.check !== undefined) {
    const check = body.check as { index?: unknown; met?: unknown } | null;
    if (!check || !Number.isInteger(check.index) || typeof check.met !== 'boolean') throw new HosError(400, 'check is { index, met }');
    patch.check = { index: check.index as number, met: check.met };
  }
  for (const key of ['evidence', 'question', 'reason'] as const) {
    if (body[key] !== undefined) patch[key] = text(body, key);
  }
  return patch;
}

function source<T>(found: T | null, kind: string): T {
  if (!found) throw new HosError(404, `hos has no ${kind} source`);
  return found;
}

function optionalText(body: Record<string, unknown>, key: string): string | undefined {
  return body[key] === undefined || body[key] === '' ? undefined : text(body, key);
}

const SURFACES: Surface[] = ['mac', 'phone'];

function origin(body: Record<string, unknown>, identity: Identity): { via: Surface; user: string; chatId?: string } {
  const via = optionalText(body, 'via') ?? 'mac';
  if (!SURFACES.includes(via as Surface)) throw new HosError(400, `via must be one of ${SURFACES.join(', ')}`);
  const chatId = optionalText(body, 'chatId');
  return { via: via as Surface, user: identity.user, ...(chatId ? { chatId } : {}) };
}

function pushTarget(body: Record<string, unknown>): PushTarget {
  const value = body.subscription as Partial<PushTarget> | undefined;
  const endpoint = typeof value?.endpoint === 'string' ? URL.parse(value.endpoint) : null;
  const keys = value?.keys;
  if (endpoint?.protocol !== 'https:' || typeof keys?.p256dh !== 'string' || typeof keys.auth !== 'string' || !keys.p256dh || !keys.auth) {
    throw new HosError(400, 'subscription must be a push subscription with an https endpoint and p256dh and auth keys');
  }
  return { endpoint: value!.endpoint!, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

function presenceOf(text: string): boolean | null {
  try {
    const message = JSON.parse(text) as { type?: unknown; visible?: unknown; focused?: unknown } | null;
    return message?.type === 'presence' ? message.visible === true && message.focused === true : null;
  } catch {
    return null;
  }
}

function answers(body: Record<string, unknown>): Record<string, string> {
  const value = body.answers;
  if (!value || typeof value !== 'object' || Object.values(value).some((v) => typeof v !== 'string')) {
    throw new HosError(400, 'answers must map each question to a string');
  }
  return value as Record<string, string>;
}

function actionArgs(body: Record<string, unknown>): Record<string, unknown> {
  const value = body.args ?? {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new HosError(400, 'args must map each argument name to a string');
  return value as Record<string, unknown>;
}

function reviewComments(body: Record<string, unknown>): ReviewComment[] {
  const value = body.comments;
  const valid = (c: Partial<ReviewComment>) =>
    typeof c.path === 'string' &&
    c.path.length > 0 &&
    Number.isInteger(c.line) &&
    c.line! > 0 &&
    (c.side === 'additions' || c.side === 'deletions') &&
    typeof c.text === 'string' &&
    c.text.trim().length > 0;
  if (!Array.isArray(value) || !value.every((c) => c && typeof c === 'object' && valid(c as Partial<ReviewComment>))) {
    throw new HosError(400, 'comments must be a list of {path, line, side, text}');
  }
  return (value as ReviewComment[]).map(({ path, line, side, text }) => ({ path, line, side, text }));
}

export const MAX_BODY_BYTES = Math.ceil((ATTACHMENT_MAX_BYTES * 4) / 3) + 1024 * 1024;

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks = await new Promise<Buffer[]>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const tooBig = () => new HosError(413, `request bodies are at most ${Math.round(MAX_BODY_BYTES / 1024 / 1024)} MB`);
    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) {
      req.resume();
      return reject(tooBig());
    }
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) return void chunks.push(chunk);
      req.off('data', onData);
      req.resume();
      reject(tooBig());
    };
    req.on('data', onData);
    req.on('end', () => resolve(chunks));
    req.on('error', reject);
  });
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new HosError(400, 'invalid JSON body');
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { ...headers, 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function sendRaw(res: ServerResponse, body: RawBody): void {
  res.writeHead(200, {
    'content-type': body.type,
    'content-security-policy': 'sandbox',
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, max-age=86400',
  });
  res.end(body.data);
}

async function serveShared(files: HtmlFiles, token: string, rest: string, res: ServerResponse): Promise<void> {
  let path: string;
  try {
    path = decodeURIComponent(rest);
  } catch {
    return void res.writeHead(400).end();
  }
  const file = await files.resolve(token, path);
  if (!file) return void res.writeHead(404).end();
  const canvas = files.isCanvas(token);
  res.writeHead(200, {
    'content-type': FILE_TYPES[extname(file).toLowerCase()]!,
    // Opaque origin: the page's scripts can't read the hos session in localStorage or call the API as the user.
    'content-security-policy': canvas ? CANVAS_CSP : 'sandbox allow-scripts allow-popups allow-forms allow-modals',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  });
  if (canvas && /\.html?$/i.test(file)) return void res.end(withBridge(await readFile(file, 'utf8')));
  createReadStream(file).pipe(res);
}

async function serveStatic(webRoot: string | undefined, pathname: string, res: ServerResponse, host = hostname().split('.')[0]!): Promise<void> {
  if (!webRoot) return void res.writeHead(404).end();
  const root = normalize(webRoot + sep);
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return void res.writeHead(400).end();
  }
  let file = normalize(join(root, decoded));
  if (!file.startsWith(root)) return void res.writeHead(403).end();
  const ext = extname(file);
  const hostFile = `${file.slice(0, file.length - ext.length)}.${host}${ext}`;
  if ((await stat(hostFile).catch(() => null))?.isFile()) file = hostFile;
  const found = await stat(file).catch(() => null);
  if (!found?.isFile()) file = join(root, 'index.html');
  if (!(await stat(file).catch(() => null))?.isFile()) return void res.writeHead(404).end();
  res.writeHead(200, { 'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}
