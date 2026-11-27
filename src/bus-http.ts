import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { z } from 'zod';
import { PROFILE_ID } from './profiles.js';
import { EFFORTS } from './api/types.js';
import type { BusReply } from './bus.js';
import { registerCanvasTools } from './canvas/bus.js';
import { registerConfigTools } from './config-bus.js';
import type { Hos } from './core.js';
import type { LayoutSpec } from './diagram-layout.js';
import { diagramReply, type DiagramOp } from './diagrams.js';
import { owner, ownerStart } from './owner.js';
import { registerSnagTools } from './snags/bus.js';
import type { Snags } from './snags/snags.js';
import { SECTIONS } from './work.js';

const PROGRESS_SECTIONS = SECTIONS.filter((section) => section !== 'Log');

export type BusReplyFn = (
  tool: string,
  args: Record<string, unknown>,
  run: () => BusReply | Promise<BusReply>,
) => Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>;

// Tools every hos chat uses on almost every turn. Marked so the agent SDK loads them into the turn-1 prompt instead
// of deferring them behind a ToolSearch call; the ~40 rarer bus tools stay deferred, so context is not blown (H5).
const ALWAYS_LOAD = { 'anthropic/alwaysLoad': true } as const;

export async function handleBusRequest(hos: Hos, req: IncomingMessage, res: ServerResponse, snags?: Snags): Promise<void> {
  const token = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
  const chatId = hos.bus.chatForToken(token);
  if (!chatId) {
    res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unknown bus token' }));
    return;
  }
  const server = busServer(hos, chatId, snags);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}

function busServer(hos: Hos, chatId: string, snags?: Snags): McpServer {
  const { bus } = hos;
  const server = new McpServer({ name: 'hos', version: '0.1.0' });
  const hidden = new Set(hos.hiddenBusTools(chatId));
  if (hidden.size) {
    const register = server.registerTool.bind(server) as (name: string, ...rest: unknown[]) => RegisteredTool;
    server.registerTool = ((name: string, ...rest: unknown[]) => {
      const tool = register(name, ...rest);
      if (hidden.has(name)) tool.remove();
      return tool;
    }) as typeof server.registerTool;
  }
  const reply: BusReplyFn = async (tool, args, run) => {
    const { text, outcome } = await bus.call(chatId, tool, args, run);
    return { content: [{ type: 'text' as const, text }], ...(outcome === 'ok' ? {} : { isError: true }) };
  };
  if (snags) registerSnagTools(server, snags, chatId, reply);
  if (hos.canvasTools(chatId)) registerCanvasTools(server, hos.canvases, chatId, reply);
  registerConfigTools(server, hos.config, reply);
  server.registerTool(
    'whoami',
    { description: 'Who you are on the hos bus: your chat id, topic, and the workspaces (folders) it works in.' },
    () => reply('whoami', {}, () => bus.whoami(chatId)),
  );
  server.registerTool(
    'roster',
    { description: 'The live chats in your topic (at most 15 rows). You also get this at the start of every turn.' },
    () => reply('roster', {}, () => bus.roster(chatId)),
  );
  server.registerTool(
    'update_card',
    {
      description:
        'Replace your card: your short self-summary other chats read (doing, done, blocked on, files touched, next). At most 300 tokens.',
      inputSchema: { text: z.string() },
      _meta: ALWAYS_LOAD,
    },
    ({ text }) => reply('update_card', { text }, () => bus.updateCard(chatId, text)),
  );
  server.registerTool(
    'card',
    {
      description: "Read another chat's card. Counts against your cross-chat budget.",
      inputSchema: { chat: z.string().describe('chat id or its first 8 characters, from the roster') },
    },
    ({ chat }) => reply('card', { chat }, () => bus.card(chatId, chat)),
  );
  server.registerTool(
    'tail',
    {
      description:
        "The last n event summaries of another chat in your topic (never its full transcript). Counts against your cross-chat budget.",
      inputSchema: {
        chat: z.string().describe('chat id or its first 8 characters, from the roster'),
        n: z.number().int().min(1).max(30).default(10),
      },
    },
    ({ chat, n }) => reply('tail', { chat, n }, () => bus.tail(chatId, chat, n)),
  );
  server.registerTool(
    'chat_history',
    {
      description:
        "Another chat's user and assistant messages in full (any topic), newest first, paged with before. Counts against your cross-chat budget.",
      inputSchema: {
        chat: z.string().describe('chat id or its first 8 characters'),
        before: z.number().int().min(1).optional().describe('the #number from the previous page, to read older messages'),
        limit: z.number().int().min(1).max(30).default(10),
      },
    },
    ({ chat, before, limit }) => reply('chat_history', { chat, before, limit }, () => bus.chatHistory(chat, before, limit)),
  );
  server.registerTool(
    'search',
    {
      description:
        "Full-text search over other chats' event summaries in your topic; returns up to 10 snippets. Counts against your cross-chat budget.",
      inputSchema: { query: z.string() },
    },
    ({ query }) => reply('search', { query }, () => bus.search(chatId, query)),
  );
  server.registerTool(
    'handoff_ready',
    {
      description:
        "Report that your continue-mode handoff is in your topic's PROGRESS.md (updated with progress_update). hos checks it (required sections filled, no template hints or placeholders, under 20,000 characters, the Where path and branch exist, and a Log line from you that updated Next step since the handoff was asked for), then starts your successor from it. You get one correction round.",
      inputSchema: { path: z.string().optional().describe("leave out: it defaults to <WORK_DIR>/PROGRESS.md; Desk chats give the PROGRESS.md they updated") },
      _meta: ALWAYS_LOAD,
    },
    ({ path }) => reply('handoff_ready', { path }, () => hos.handoffReady(chatId, path)),
  );
  server.registerTool(
    'refresh_ready',
    {
      description:
        "Report that this chat's PROGRESS.md is true now after hos asked for a context refresh. hos checks it as it checks a handoff (no placeholders, under the cap, a Log line from you since the ask), then clears this chat's context and starts it again from PROGRESS.md. Same chat, not a handoff. You get one correction round.",
      inputSchema: {},
    },
    () => reply('refresh_ready', {}, () => hos.refreshReady(chatId)),
  );
  server.registerTool(
    'spawn',
    {
      description:
        `Start another chat in your topic when work splits: by default a normal chat (role main) that ${owner()} can talk to, or a worker (edits code), reviewer (reads diffs, reports findings), scout (read-only research, returns a short summary). Use your own subagents first; about 2 extra chats per task is a guide, not a limit. The governor decides: max depth 2, a spawn-rate brake, and dedup (the same intent joins the existing chat). Retrying with the same client_request_id never starts a second chat. Workers share one worktree: split the work by files_owned so they run in parallel. A child always gets the hos tools, and the Chrome tools only with browser: true.`,
      inputSchema: {
        role: z.enum(['main', 'worker', 'reviewer', 'scout']).default('main'),
        intent: z.string().min(1).max(200).describe('one line; the dedup key'),
        prompt: z.string().min(1).max(3000).describe('the work packet, or a path to one'),
        files_owned: z.array(z.string()).max(50).default([]).describe("paths or globs relative to the child's workspace; locks clash only with locks in the same workspace"),
        workspace: z
          .string()
          .min(1)
          .max(300)
          .optional()
          .describe("workspace the child works in (id, branch or repo name, as in workspace_list); default: your topic's first workspace"),
        own_worktree: z
          .boolean()
          .default(false)
          .describe('main or worker only: give it its own sub-worktree that merges back after review; only when the work cannot be split by files (the same files, a branch switch, installs that would break the other workers)'),
        return_contract: z
          .object({
            artifact: z.string().optional(),
            summary_tokens: z.number().int().min(50).max(2000).default(1500),
          })
          .optional(),
        ttl_minutes: z.number().int().min(1).max(2880).optional().describe('only when the work must stop by a deadline: told to complete when it passes, stopped 10 minutes later; default: no time limit'),
        client_request_id: z.string().min(1).max(100),
        confirm_similar: z.boolean().default(false).describe('main chats and workers: spawn although a live chat has a very similar intent'),
        batch: z.boolean().default(false).describe('P4 batch work: runs last, deferred in peak hours and paused near the Claude limits'),
        agent: z.string().min(1).max(40).optional().describe("harness the child runs on: claude or the id of an installed ACP or plug-in harness; default: the child profile's harness, else your own harness"),
        model: z.string().min(1).max(60).optional().describe("model id for the child, as in that harness's model list; default: the child profile's model for that harness, else on the claude harness the brain's models.default (the cheaper-models brake can lower either); on another harness: your own on your harness, else that harness's default"),
        effort: z.enum(EFFORTS).optional().describe("effort for the child; default: the child profile's effort for that harness, else on the claude harness the brain's models.effort; on another harness: your own on your harness, else that harness's default"),
        browser: z.boolean().optional().describe("the child gets the mcp__claude-in-chrome__* tools (Browser on); default: the child profile's browser setting, else off"),
        notify: z.boolean().default(false).describe(`${ownerStart()} gets a push each time the child finishes a turn; only when they asked to be notified about it`),
        profile: z.string().regex(PROFILE_ID).optional().describe("the child's profile, a folder profiles/<id>/ in the brain (PROFILE.md with skills, instructions and limits, plus its SOUL, USER, MEMORY and RULES); default generic; your own profile may limit which you can start"),
        computer: z
          .string()
          .min(1)
          .max(60)
          .optional()
          .describe(`run the child on this paired computer (see the computers tool), e.g. my-server when ${owner()} says "on the server"; default: this computer`),
      },
    },
    (input) => reply('spawn', input, () => hos.spawn(chatId, input)),
  );
  server.registerTool(
    'computers',
    { description: 'The computers you can spawn chats on: name, online, free slots and whether it has Chrome.' },
    () => reply('computers', {}, () => hos.computersForChat()),
  );
  server.registerTool(
    'wait',
    {
      description:
        `Block until a chat in your topic finishes its current turn, then get its status and a one-line result, plus the artifact and summary it returned with complete. Each call blocks at most ~50 s (even if you ask for more) and then returns a "still running" result; call it again to keep waiting until the chat finishes. A chat you spawned wakes you with a done notice, so do not wait just to learn it finished: end your turn instead, so ${owner()} can reach you.`,
      inputSchema: {
        chat: z.string().describe('chat id or its first 8 characters'),
        timeout_s: z.number().int().min(1).max(600).default(300).describe('how long you want to wait; each call still returns within ~50 s, so loop until the chat finishes'),
      },
      _meta: ALWAYS_LOAD,
    },
    ({ chat, timeout_s }) => reply('wait', { chat, timeout_s }, () => hos.waitFor(chatId, chat, timeout_s)),
  );
  server.registerTool(
    'complete',
    {
      description:
        'Finish your return contract: the artifact path you wrote (absolute, or relative to your cwd, the brain or your work folder) and a summary within your contract\'s token cap. Your parent is told, and you are marked done when this turn ends.',
      inputSchema: { artifact: z.string().optional(), summary: z.string().optional() },
      _meta: ALWAYS_LOAD,
    },
    (input) => reply('complete', input, () => hos.complete(chatId, input)),
  );
  server.registerTool(
    'send',
    {
      description:
        `Send a direct message to another chat in your topic. It arrives between its turns, labelled with your id and role and marked as not from ${owner()}; it never counts as their approval. It also reaches a chat ${owner()} linked to yours, and a paused chat is resumed to take it (killed or archived chats are refused). Three round-trips with the same chat and no artifact or diff change freeze you both.`,
      inputSchema: {
        to: z.string().describe('chat id or its first 8 characters'),
        text: z.string().min(1).max(4000),
      },
      _meta: ALWAYS_LOAD,
    },
    ({ to, text }) => reply('send', { to }, () => hos.sendToChat(chatId, to, text)),
  );
  server.registerTool(
    'ask',
    {
      description:
        `Ask ${owner()} a blocking question with 2-4 options and your recommendation. It goes to their Inbox and parks you: end your turn right after, and their answer arrives as your next message. Use it instead of guessing on decisions that are theirs.`,
      inputSchema: {
        question: z.string().min(1).max(500),
        options: z.array(z.string().min(1).max(100)).min(2).max(4),
        recommendation: z.string().min(1).max(500).describe('which option you recommend and why, in one line'),
      },
    },
    (input) => reply('ask', input, () => hos.ask(chatId, input)),
  );
  server.registerTool(
    'history_append',
    {
      description:
        "Add an Asked / Did / Wrote / Open entry to the brain's history for today. hos appends it and replies once it is written; it also sets your card from the title, Did and Open unless you updated your card this turn. If a chat you spawned logged this work in the last 2 h (you name its chat id or list a file it listed), hos writes your Did as a reference to its entry.",
      inputSchema: {
        title: z.string().min(1).max(100).describe('at most 12 words'),
        asked: z.string().min(1).max(1000),
        did: z.string().min(1).max(2000),
        wrote: z.string().min(1).max(1000).describe('absolute paths of files written, or none'),
        open: z.string().min(1).max(1000).describe('what is left, or none'),
      },
      _meta: ALWAYS_LOAD,
    },
    (input) => reply('history_append', input, () => hos.historyAppendForChat(chatId, input)),
  );
  const folder = z.string().min(1).max(300).optional().describe('another existing work folder (work/<area>/<YYYY-MM-DD>-<slug>/); leave out for your topic’s own');
  server.registerTool(
    'progress_read',
    {
      description: `Read a work folder's PROGRESS.md (your topic's by default), each section with its rev. Pass a section's rev back to progress_update when you replace it.`,
      inputSchema: { folder },
      _meta: ALWAYS_LOAD,
    },
    (input) => reply('progress_read', input, () => hos.progressReadForChat(chatId, input)),
  );
  server.registerTool(
    'progress_update',
    {
      description: `Update a work folder's PROGRESS.md (your topic's by default; direct edits are refused). Give only the sections you change (${PROGRESS_SECTIONS.join(', ')}), each with the rev progress_read gave you; a stale rev is refused with the current text, so merge and retry once. close/add_open change Open items without a rev. hos stamps State, writes the Log line from note, keeps 20 Log lines, refuses past 20,000 characters and commits. The first write creates the file and must fill Goal, State, Where (- Path: and - Branch: lines) and Next step.`,
      inputSchema: {
        folder,
        sections: z.record(z.string(), z.string().max(20_000)).optional().describe('section name → its full new text, without the ## heading; empty text deletes an optional section'),
        revs: z.record(z.string(), z.string()).optional().describe('section name → the rev you read'),
        close: z.array(z.string().min(1).max(20)).optional().describe('Open item ids to close, e.g. ["O3"]'),
        add_open: z.array(z.string().min(1).max(500)).optional().describe('new Open items; hos numbers them'),
        note: z.string().min(1).max(300).describe('one line for the Log: what changed'),
      },
      _meta: ALWAYS_LOAD,
    },
    (input) =>
      reply('progress_update', { folder: input.folder, sections: Object.keys(input.sections ?? {}), close: input.close, add_open: input.add_open, note: input.note }, () =>
        hos.progressUpdateForChat(chatId, input),
      ),
  );
  server.registerTool(
    'task_create',
    {
      description:
        `Add a task to your topic's task list, when ${owner()} asks for tasks or a plan is approved. A task is one outcome you can check, usually one landing that fits one chat; a rename or a one-line fix is a step inside a task, not a task. Write criteria as outcomes, not steps. Work you find while doing another task: pass found_while, and it stays proposed until ${owner()} or a main chat accepts it. depends_on lists tasks that must be done first. A claim older than limit_minutes, when given, is flagged.`,
      inputSchema: {
        title: z.string().min(1).max(1200),
        criteria: z.array(z.string().min(1).max(300)).max(20).default([]).describe('acceptance criteria, each an outcome you can check'),
        priority: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2).describe('1 high, 2 normal, 3 low'),
        depends_on: z.array(z.string()).max(20).default([]).describe('task refs, e.g. ["T1", "T2"]'),
        found_while: z.string().optional().describe('the task you were doing when you found this work; makes it proposed'),
        from_snag: z.string().optional().describe('the snag this task fixes, e.g. S225'),
        limit_minutes: z.number().int().min(1).max(2880).optional().describe('flag a claim older than this; default: no limit, never flagged'),
      },
    },
    (input) => reply('task_create', input, () => hos.createTask(chatId, input)),
  );
  server.registerTool(
    'task_claim',
    {
      description:
        'Claim an open task so nobody else works on it: the given ref, or the highest-priority open task whose dependencies are all done. You may also name a claimed, review or blocked task whose holder is done, failed, killed or archived (a main chat: also paused), and take it over.',
      inputSchema: { task: z.string().optional().describe('task ref, e.g. T3') },
    },
    ({ task }) => reply('task_claim', task ? { task } : {}, () => hos.claimTask(chatId, task)),
  );
  server.registerTool(
    'task_complete',
    {
      description:
        'Mark a task you hold as done. Refused until every criterion is met (pass their numbers in met) and evidence names a commit sha, a test run or a file path; tasks waiting on it become claimable. You may also close a task whose holder is done, failed, killed or archived (a main chat: also paused); the evidence then records whose task it closed.',
      inputSchema: {
        task: z.string(),
        evidence: z.string().max(500).optional(),
        met: z.array(z.number().int().min(1)).max(20).default([]).describe('numbers of the criteria now met, e.g. [1, 2]'),
      },
    },
    ({ task, evidence, met }) => reply('task_complete', { task, ...(evidence ? { evidence } : {}), met }, () => hos.completeTask(chatId, task, evidence, met)),
  );
  server.registerTool(
    'task_update',
    {
      description:
        `Change a task: priority, tick a criterion, or move it. state review = waits for ${owner()} to look; blocked = waits for their answer (give question); claimed = back to work after review or an answer; open = accept a proposed task (${owner()} or a main chat) or release your claim; dropped needs a reason. You may change a task whose holder is done, failed, killed or archived (a main chat: also paused), and claimed then moves the task to you.`,
      inputSchema: {
        task: z.string(),
        priority: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
        state: z.enum(['open', 'claimed', 'review', 'blocked', 'dropped']).optional(),
        met: z.number().int().min(1).optional().describe('number of a criterion that is now met'),
        question: z.string().max(500).optional(),
        reason: z.string().max(300).optional(),
      },
    },
    ({ task, met, ...rest }) =>
      reply('task_update', { task, ...(met ? { met } : {}), ...rest }, () =>
        hos.updateTaskForChat(chatId, task, { ...rest, ...(met ? { check: { index: met - 1, met: true } } : {}) }),
      ),
  );
  server.registerTool(
    'tasks',
    { description: "Your topic's task list in priority order: each task's priority, state, claimer, dependencies, criteria met and whether it is past its time limit." },
    () => reply('tasks', {}, () => hos.tasksForChat(chatId)),
  );
  server.registerTool(
    'lock',
    {
      description:
        "Take advisory locks on paths or globs (relative to your worktree) so no other chat in your topic edits them; edits inside another chat's lock are refused. A spawned worker already holds locks on its owned files and may only lock inside them. Locks expire after ttl_minutes with no tool or bus call from you; calling lock again renews them.",
      inputSchema: {
        paths: z.array(z.string().min(1).max(300)).min(1).max(50),
        ttl_minutes: z.number().int().min(1).max(120).default(15),
      },
    },
    ({ paths, ttl_minutes }) => reply('lock', { paths, ttl_minutes }, () => hos.lockForChat(chatId, paths, ttl_minutes)),
  );
  server.registerTool(
    'unlock',
    {
      description: 'Release your locks: the given paths, or all of them when paths is left out.',
      inputSchema: { paths: z.array(z.string().min(1).max(300)).max(50).optional() },
    },
    ({ paths }) => reply('unlock', paths ? { paths } : {}, () => hos.unlockForChat(chatId, paths)),
  );
  server.registerTool(
    'locks',
    { description: 'The live locks in your topic and who holds each one.' },
    () => reply('locks', {}, () => hos.locksForChat(chatId)),
  );
  server.registerTool(
    'actions',
    { description: `The actions of every workspace in your topic: named commands ${owner()} defined, with where each runs, whether it needs their approval, and which workspaces have it when the first one doesn't.` },
    () => reply('actions', {}, () => hos.listActionsForChat(chatId)),
  );
  server.registerTool(
    'run_action',
    {
      description:
        `Run one of your topic workspaces' actions. Plain ones run at once and return their output (tmux ones return their session to check later); gated ones wait for ${owner()} in the Inbox. Use action_run to check a run.`,
      inputSchema: {
        name: z.string(),
        args: z.record(z.string(), z.string()).optional().describe('values for the action\'s declared args'),
        workspace: z
          .string()
          .optional()
          .describe('workspace to run it in (id, branch or repo name, as in workspace_list); default: the first of your topic\'s workspaces that has the action'),
      },
    },
    ({ name, args, workspace }) =>
      reply('run_action', { name, ...(args ? { args } : {}), ...(workspace ? { workspace } : {}) }, () => hos.runActionForChat(chatId, name, args ?? {}, workspace)),
  );
  server.registerTool(
    'action_run',
    {
      description: 'The state and latest output of an action run in your topic.',
      inputSchema: { run: z.string().describe('the run id run_action gave you') },
    },
    ({ run }) => reply('action_run', { run }, () => hos.actionRunForChat(chatId, run)),
  );
  server.registerTool(
    'servers',
    { description: 'Every dev server hos sees: tmux session, state, ports and worktree, plus unmanaged listeners.' },
    () => reply('servers', {}, () => hos.servers.listForChat()),
  );
  const serverName = z.string().describe('the tmux session name from the servers tool');
  server.registerTool(
    'server_start',
    {
      description:
        `Start a dev server in your worktree, in a tmux session named <worktree>-<app>-<port> with PORT set. The command goes through ${owner()}'s approval policy like a Bash call. Port defaults to your worktree's stable port.`,
      inputSchema: {
        app: z.string().describe('short app name, e.g. web or api'),
        command: z.string().describe('the shell command that runs the server, e.g. npm run dev'),
        port: z.number().int().optional(),
      },
    },
    (input) => reply('server_start', input, () => hos.servers.startForChat(chatId, input)),
  );
  server.registerTool(
    'server_stop',
    { description: "Stop a dev server in your worktree or any of your topic's workspaces (kills its tmux session).", inputSchema: { name: serverName } },
    ({ name }) => reply('server_stop', { name }, () => hos.servers.stopForChat(chatId, name)),
  );
  server.registerTool(
    'server_restart',
    { description: "Restart a dev server in your worktree or any of your topic's workspaces by re-running its command.", inputSchema: { name: serverName } },
    ({ name }) => reply('server_restart', { name }, () => hos.servers.restartForChat(chatId, name)),
  );
  server.registerTool(
    'server_tail',
    {
      description: "The last lines of a dev server's output.",
      inputSchema: { name: serverName, lines: z.number().int().min(1).max(200).default(40) },
    },
    ({ name, lines }) => reply('server_tail', { name, lines }, () => hos.servers.tailForChat(name, lines)),
  );
  const workspaceRef = z.string().min(1).max(300).describe('workspace id (or its first 8 characters), branch, or repo name when that is unambiguous in your topic');
  const { workspaces } = hos;
  server.registerTool(
    'workspace_list',
    { description: "Your topic's workspaces plus every registered workspace of the repos it uses: kind, path, branch, base, setup state and the topics using each." },
    () => reply('workspace_list', {}, () => workspaces.list(chatId)),
  );
  server.registerTool(
    'workspace_create',
    {
      description:
        `Create a workspace. With path: register a brand-new repo you just made with git init as a root workspace. Without: add a worktree (branch default hos/<topic>) of a repo your topic already uses. Any other repo needs workspace_choose so ${owner()} picks. Setup runs in the background; call workspace_wait before using it.`,
      inputSchema: {
        repo: z.string().min(1).max(200).describe('repo name of a workspace your topic uses (or the new repo name with path)'),
        branch: z.string().min(1).max(200).optional(),
        base: z.string().min(1).max(200).optional().describe('branch or ref to cut the worktree from; default the root checkout branch'),
        path: z.string().min(1).max(1000).optional().describe('absolute path of a new repo you created with git init'),
      },
    },
    (input) => reply('workspace_create', input, () => workspaces.createForChat(chatId, input)),
  );
  server.registerTool(
    'workspace_rename',
    {
      description: "Rename a workspace's branch (git branch -m); a worktree's folder moves to match. Refused while it has uncommitted changes.",
      inputSchema: { workspace: workspaceRef, branch: z.string().min(1).max(200) },
    },
    ({ workspace, branch }) => reply('workspace_rename', { workspace, branch }, () => workspaces.renameForChat(chatId, workspace, branch)),
  );
  server.registerTool(
    'workspace_archive',
    {
      description: `Archive a worktree: removes its folder, keeps its branch and record, detaches it from every topic. Uncommitted or unpushed work waits for ${owner()}. Root workspaces are never archived.`,
      inputSchema: { workspace: workspaceRef },
    },
    ({ workspace }) => reply('workspace_archive', { workspace }, () => workspaces.archiveForChat(chatId, workspace)),
  );
  server.registerTool(
    'workspace_delete',
    {
      description: `Delete a worktree: always asks ${owner()}, then removes its folder, deletes its branch and drops its record. Root workspaces are never deleted.`,
      inputSchema: { workspace: workspaceRef },
    },
    ({ workspace }) => reply('workspace_delete', { workspace }, () => workspaces.deleteForChat(chatId, workspace)),
  );
  server.registerTool(
    'workspace_path',
    { description: 'The absolute path of a workspace.', inputSchema: { workspace: workspaceRef } },
    ({ workspace }) => reply('workspace_path', { workspace }, () => workspaces.pathForChat(chatId, workspace)),
  );
  server.registerTool(
    'workspace_wait',
    {
      description: "Block until a workspace's setup is ready or failed. Each call blocks at most ~50 s and then returns a \"still setting up\" result; call it again to keep waiting.",
      inputSchema: { workspace: workspaceRef, timeout_s: z.number().int().min(1).max(600).default(300).describe('how long you want to wait; each call still returns within ~50 s, so loop until setup ends') },
    },
    ({ workspace, timeout_s }) => reply('workspace_wait', { workspace, timeout_s }, () => workspaces.waitForChat(chatId, workspace, timeout_s)),
  );
  server.registerTool(
    'workspace_terminal',
    { description: 'Start a terminal (tmux session) in a workspace and get its name.', inputSchema: { workspace: workspaceRef } },
    ({ workspace }) => reply('workspace_terminal', { workspace }, () => workspaces.terminalForChat(chatId, workspace)),
  );
  server.registerTool(
    'workspace_server',
    {
      description:
        `Start a dev server in a workspace, in a tmux session named <workspace>-<app>-<port> with PORT set; returns its name and preview URL. The command goes through ${owner()}'s approval policy like a Bash call. Port defaults to the workspace's stable port.`,
      inputSchema: {
        workspace: workspaceRef,
        app: z.string().describe('short app name, e.g. web or api'),
        command: z.string().describe('the shell command that runs the server, e.g. npm run dev'),
        port: z.number().int().optional(),
      },
    },
    (input) => reply('workspace_server', input, () => workspaces.serverForChat(chatId, input)),
  );
  server.registerTool(
    'workspace_choose',
    {
      description:
        `Call this before you read or edit a repo your topic doesn't use yet. purpose read (research, onboarding, answering questions): hos attaches the repo's root checkout at once and lists it in the topic's workspaces; read only there, never in other checkouts (Conductor workspaces, other topics' worktrees). purpose edit (default): if ${owner()}'s own message to you already names the checkout ("use a new worktree", "work in the root folder", a branch), pass their exact words as said and the checkout as suggest; hos checks their messages and attaches it with no picker. Otherwise never pick one yourself: hos shows them a picker (root checkout, every worktree, or a new worktree) and parks you: end your turn, their pick arrives as your next message. A brain rule may answer at once instead.`,
      inputSchema: {
        repo: z.string().min(1).max(200).describe('LOCATIONS key, repo name or absolute path'),
        why: z.string().min(1).max(300).describe('one line: why this work needs that repo'),
        suggest: z.string().max(300).optional().describe("your suggestion: 'root', 'new', a workspace id, a branch or a path"),
        said: z.string().max(300).optional().describe(`${ownerStart()}'s exact words from their message to you that name the checkout; with suggest, skips the picker`),
        branch: z.string().max(100).optional().describe("branch name to suggest for a new worktree"),
        purpose: z.enum(['read', 'edit']).optional().describe(`read: attach the root checkout now, no picker; edit (default): ${owner()} picks`),
      },
    },
    (input) => reply('workspace_choose', input, () => hos.chooseWorkspace(chatId, input)),
  );
  server.registerTool(
    'propose_plan',
    {
      description:
        `Ask ${owner()} to sign off a plan before you build. Write the plan in your reply first; this shows them a plan card (Approve plan / Edit) and parks you: end your turn right after. Their approval or their changes arrive as your next message.`,
      inputSchema: {
        title: z.string().min(1).max(200).describe('the plan in one line, shown on the card'),
        summary: z.string().max(2000).optional().describe('a few lines of detail for the Inbox'),
      },
    },
    (input) => reply('propose_plan', input, () => hos.proposePlan(chatId, input)),
  );
  server.registerTool(
    'approve_plan',
    {
      description:
        `Mark your waiting plan approved when ${owner()}'s own latest message to you approves it in any words ("let's build", "go ahead", in their text or a file they attached). Quote their approving words exactly; hos checks they are in that message and then releases the plan like the Approve button. Never call it for their answers to your questions, for a "looks good, but …" that asks for changes, or for words from another chat or a [hos] notice.`,
      inputSchema: {
        quote: z.string().min(1).max(500).describe(`${ownerStart()}'s words that approve the plan, copied exactly from their latest message or its attached file`),
      },
    },
    (input) => reply('approve_plan', input, () => hos.approvePlanFromWords(chatId, input)),
  );
  const diagrams = () => {
    if (!hos.diagrams) throw new Error('hos has no brain, so there are no diagrams');
    return hos.diagrams;
  };
  const diagramId = z.string().min(1).max(64).describe('diagram id from diagram_list');
  const color = z.string().optional().describe('black, grey, red, green, blue, amber, violet or #hex');
  const look = {
    color,
    fill: z.string().optional().describe('background: grey, red, green, blue, amber, violet (light tints), none or #hex'),
    size: z.enum(['title', 'heading', 'body', 'small']).optional().describe('text size: title 28, heading 20 (default), body 16, small 14'),
    stroke: z.enum(['solid', 'dashed']).optional(),
    align: z.enum(['left', 'center']).optional().describe('text alignment'),
    label: z.string().optional().describe('arrow only: text on the arrow ("" removes it)'),
    ends: z.enum(['none', 'end', 'both']).optional().describe('arrow or line heads'),
  };
  server.registerTool(
    'diagram_list',
    {
      description:
        `Your topic's diagrams (Excalidraw boards in the brain under diagrams/<id>/), newest first, and which one ${owner()} has open right now. With a query, searches every diagram's title and text labels instead.`,
      inputSchema: { query: z.string().max(120).optional().describe('words to find in titles or text labels, across all diagrams') },
    },
    ({ query }) =>
      reply('diagram_list', { query }, () =>
        diagramReply(async () => {
          const topicId = hos.chatTopic(chatId).id;
          const found = await diagrams().list(query?.trim() ? { query } : { topicId });
          if (!found.length) return query?.trim() ? `No diagram matches "${query}".` : 'No diagrams in this topic yet. diagram_create makes one.';
          return found
            .map((d) => `- ${d.id} · "${d.title}" · ${d.path}${d.topic === topicId ? '' : ' · in another topic'}${d.open ? ` · OPEN in ${owner()}’s browser` : ''}`)
            .join('\n');
        }),
      ),
  );
  server.registerTool(
    'diagram_create',
    {
      description: `Create an empty diagram in your topic. ${ownerStart()} sees it as a new tab in the topic.`,
      inputSchema: { title: z.string().min(1).max(120) },
    },
    ({ title }) =>
      reply('diagram_create', { title }, () =>
        diagramReply(async () => {
          const made = await hos.createDiagram(title, hos.chatTopic(chatId).id);
          return `Created diagram ${made.id} at ${made.path} in your topic.`;
        }),
      ),
  );
  server.registerTool(
    'diagram_read',
    {
      description:
        "Read a diagram's live elements as compact JSON lines (id, type, position, size, text, arrow ends). Pen ink is type freedraw; call diagram_screenshot to see it.",
      inputSchema: { id: diagramId },
    },
    ({ id }) => reply('diagram_read', { id }, () => diagramReply(() => diagrams().read(id))),
  );
  server.registerTool(
    'diagram_apply',
    {
      description:
        `Edit a diagram live: add shapes (rectangle, ellipse, diamond, text, note = amber sticky with text, arrow or line from→to element ids or x,y + width,height, frame around children ids), update them, fit labels, or delete elements (an add that reuses a deleted id brings it back; a live id is refused). hos wraps each label and grows its box to fit, moves labels and arrows with their shape, and ends the result with a Check line (label overflow, overlaps, arrows through shapes, orphans): fix what it lists. Keep box labels to a few words and put detail in a text beside the box; place with near ("right of n2") instead of computing x,y; for boxes-and-arrows graphs or sequences use diagram_layout. ${ownerStart()} sees it at once, and one Undo in their tab (or the chat card's Undo, by the apply id in the result) reverts the whole call. To tidy pen ink (only when they ask): read and screenshot, add clean shapes, delete the freedraw ids, all in ONE call.`,
      inputSchema: {
        id: diagramId,
        ops: z
          .array(
            z.discriminatedUnion('op', [
              z.object({
                op: z.literal('add'),
                id: z.string().optional().describe('your own id, so later ops in this call can point at it'),
                type: z.enum(['rectangle', 'ellipse', 'diamond', 'text', 'arrow', 'note', 'frame', 'line']),
                x: z.number().optional(),
                y: z.number().optional(),
                width: z.number().optional(),
                height: z.number().optional(),
                text: z.string().optional().describe('label inside a shape or note, the text of a text element, or a frame name'),
                from: z.string().optional().describe('arrow or line start element id'),
                to: z.string().optional().describe('arrow or line end element id'),
                children: z.array(z.string()).optional().describe('frame only: element ids to put in the frame (it sizes itself around them)'),
                near: z
                  .object({ id: z.string(), side: z.enum(['right', 'below', 'left', 'above']), gap: z.number().optional().describe('default 60') })
                  .optional()
                  .describe('place beside this element instead of giving x,y'),
                ...look,
              }),
              z.object({
                op: z.literal('update'),
                id: z.string(),
                x: z.number().optional(),
                y: z.number().optional(),
                width: z.number().optional(),
                height: z.number().optional(),
                text: z.string().optional(),
                ...look,
              }),
              z.object({ op: z.literal('fit'), ids: z.array(z.string()).optional().describe('shapes to re-fit to their labels; omit for every labelled shape') }),
              z.object({ op: z.literal('delete'), ids: z.array(z.string()).min(1) }),
            ]),
          )
          .min(1)
          .max(200),
      },
    },
    ({ id, ops }) => reply('diagram_apply', { id, ops: ops.length }, () => diagramReply(() => diagrams().apply(id, ops as DiagramOp[]))),
  );
  server.registerTool(
    'diagram_import_mermaid',
    {
      description:
        `Draw a Mermaid diagram (flowchart, sequence, class…) into a diagram as editable shapes, placed to the right of what is there. ${ownerStart()}'s open tab converts it, so it needs the diagram open in a browser. One Undo reverts it, like diagram_apply.`,
      inputSchema: { id: diagramId, mermaid: z.string().min(1).max(20_000).describe('Mermaid source text') },
    },
    ({ id, mermaid }) => reply('diagram_import_mermaid', { id }, () => diagramReply(() => diagrams().importMermaid(id, mermaid))),
  );
  const short = z.string().min(1).max(200);
  server.registerTool(
    'diagram_layout',
    {
      description:
        `Draw a boxes-and-arrows diagram without coordinates: send the structure, hos lays it out (labels fitted, no overlaps, arrows routed around boxes) and draws it live as one undoable apply, to the right of what is there. kind graph = architecture, flows, state machines (nodes, edges, optional groups drawn as frames; direction LR or TD); kind sequence = actors with messages top to bottom (reply = dashed). Keep labels to a few words and a diagram to about 12 boxes; split bigger ones. To change a drawn layout, call again with its layout id and the full new spec: boxes keep their ids and ${owner()}'s colour changes. No open tab needed.`,
      inputSchema: {
        id: diagramId,
        layout: z.string().max(64).optional().describe('id of an earlier layout on this diagram to redraw in place'),
        kind: z.enum(['graph', 'sequence']),
        title: z.string().max(120).optional(),
        direction: z.enum(['LR', 'TD']).optional().describe('graph only; default LR'),
        at: z.object({ x: z.number(), y: z.number() }).optional().describe('top-left corner; default right of existing content'),
        nodes: z
          .array(
            z.object({
              id: short,
              label: short,
              shape: z.enum(['rectangle', 'ellipse', 'diamond', 'note']).optional().describe('ellipse = start/end, diamond = decision'),
              group: z.string().optional().describe('id of a group in groups'),
              color,
              fill: look.fill,
              focal: z.boolean().optional().describe('the one or two boxes the diagram is about: thicker border'),
            }),
          )
          .max(60)
          .optional()
          .describe('graph only'),
        groups: z.array(z.object({ id: short, label: short })).max(12).optional().describe('graph only; one level, drawn as frames'),
        edges: z
          .array(z.object({ from: short, to: short, label: z.string().max(80).optional(), dashed: z.boolean().optional() }))
          .max(120)
          .optional()
          .describe('graph only'),
        actors: z.array(z.object({ id: short, label: short, color, fill: look.fill })).max(12).optional().describe('sequence only'),
        messages: z
          .array(z.object({ from: short, to: short, label: z.string().max(80).optional(), reply: z.boolean().optional() }))
          .max(60)
          .optional()
          .describe('sequence only, in order'),
      },
    },
    ({ id, layout, at, ...spec }) =>
      reply('diagram_layout', { id, kind: spec.kind }, () => diagramReply(() => diagrams().layout(id, spec as LayoutSpec, { ...(layout ? { layout } : {}), ...(at ? { at } : {}) }))),
  );
  server.registerTool(
    'diagram_screenshot',
    {
      description: `Save a PNG of a diagram from ${owner()}'s open tab and return its path; Read the file to see it (pen ink included). Needs the diagram open in a browser.`,
      inputSchema: { id: diagramId },
    },
    ({ id }) =>
      reply('diagram_screenshot', { id }, () =>
        diagramReply(async () => {
          if (!hos.bus.brainDir) throw new Error('hos has no brain');
          const topic = hos.chatTopic(chatId);
          const file = join(hos.bus.brainDir, '.context/topics', topic.statusTopic, 'scratch', `diagram-${id}.png`);
          return `Saved ${await diagrams().screenshot(id, file)}. Read it to see the diagram.`;
        }),
      ),
  );
  return server;
}
