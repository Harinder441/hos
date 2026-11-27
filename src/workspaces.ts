import { constants, createWriteStream, existsSync } from 'node:fs';
import { access, copyFile, mkdir, open, readdir, stat } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { brainActionsFile, readActionsFile, runOnHost, type Execution } from './actions.js';
import type { Clock } from './adapters/clock.js';
import type { Creator, EventBody, Project, Terminal, Topic, Workspace, Worktree } from './api/types.js';
import type { BusReply } from './bus.js';
import { HosError, WAIT_CLAMP_S, type WorkspaceInput } from './core.js';
import { commitAll, currentBranch, deleteBranch, listWorktrees, moveWorktree, pushBranch, removeWorktree, renameBranch, worktreeStatus } from './git.js';
import { owner, ownerStart } from './owner.js';
import type { Servers } from './servers.js';
import { workspaceName, type Store } from './store.js';

export const SETUP_LIMIT_MS = 5 * 60_000;
const LOG_TAIL_BYTES = 64 * 1024;
const WAIT_DEFAULT_S = 300;

export interface WorkspaceDeps {
  store: Store;
  clock: Clock;
  dataDir: string;
  brainDir?: string;
  servers: Servers;
  record(body: EventBody, write?: () => void): void;
  exclusive<T>(fn: () => Promise<T>): Promise<T>;
  refreshProject(project: Project): Promise<void>;
  topicChanged(topic: Topic): void;
  creator(chatId: string | undefined): { createdBy: Creator; createdByChat: string | null };
  createWorktree(projectId: string, request: { branch: string; baseRef: string; chatId?: string }): Promise<Worktree>;
  defaultBase(project: Project): Promise<string>;
  freshBaseRef(project: Project, base: string): Promise<string>;
  registerRepo(path: string): Promise<Project>;
  worktreePathFor(project: Project, branch: string): string;
  freeBranch(project: Project, wanted: string): Promise<string>;
  askOwner(chatId: string, command: string, title: string): Promise<boolean>;
  approveBash(chatId: string, command: string, title: string): Promise<boolean>;
  createTerminal(path: string, topicId?: string): Promise<Terminal>;
  previewUrl(port: number): Promise<string | null>;
}

export class WorkspaceLifecycle {
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly runs = new Map<string, Execution>();

  constructor(private readonly deps: WorkspaceDeps) {
    for (const workspace of deps.store.workspacesInSetup()) {
      void this.appendLog(workspace, 'hos stopped while setup was running\n');
      this.setSetup(workspace, 'failed');
    }
  }

  async create(input: WorkspaceInput): Promise<Workspace> {
    const { store } = this.deps;
    const project = this.requireProject(input.projectId);
    if (input.kind !== 'root' && input.kind !== 'worktree') throw new HosError(400, 'kind must be root or worktree');
    const creator = this.deps.creator(input.chatId);
    let path = input.path ?? (input.kind === 'root' ? project.path : undefined);
    const madeByHos = !input.path && input.kind === 'worktree';
    const base = input.baseRef ?? (input.kind === 'worktree' ? await this.deps.defaultBase(project) : undefined);
    if (!path) {
      const branch = input.branch?.trim();
      if (!branch) throw new HosError(400, 'a new worktree needs a branch');
      const from = await this.deps.freshBaseRef(project, base!);
      path = (await this.deps.createWorktree(project.id, { branch, baseRef: from, chatId: input.chatId })).path;
    }
    const known = store.workspaceByPath(path);
    if (known) return known;
    const isOwnWorktree = () => store.getWorktree(path)?.snapshot?.projectId === project.id;
    if (!isOwnWorktree()) await this.deps.exclusive(() => this.deps.refreshProject(project));
    if (!isOwnWorktree()) throw new HosError(400, `${path} is not a worktree of ${project.name}`);
    const root = path === project.path;
    if (input.kind === 'root' && !root) throw new HosError(400, `${path} is not the main checkout of ${project.name}`);
    const branch = (await currentBranch(path).catch(() => null)) ?? store.getWorktree(path)?.snapshot?.branch ?? null;
    const id = randomUUID();
    const setup = root || madeByHos ? this.initialSetup(project, root) : 'ready';
    const workspace: Workspace = {
      id,
      projectId: project.id,
      kind: root ? 'root' : 'worktree',
      name: root ? basename(project.path) : workspaceName(branch),
      path,
      branch,
      base: root ? branch : base && !/^[0-9a-f]{40}$/.test(base) && base !== 'HEAD' ? base.replace(/^origin\//, '') : await currentBranch(project.path).catch(() => null),
      setup,
      setupLog: setup === 'pending' ? this.logPath(id) : null,
      archivedAt: null,
      ...creator,
      createdAt: this.deps.clock.now(),
    };
    this.deps.record({ type: 'workspace.created', workspace }, () => store.insertWorkspace(workspace));
    if (setup === 'pending') void this.runSetup(workspace.id);
    return workspace;
  }

  attach(topicId: string, workspaceId: string): Topic {
    const topic = this.requireTopic(topicId);
    const workspace = this.requireWorkspace(workspaceId);
    if (topic.workspaceIds.includes(workspace.id)) return topic;
    const updated = { ...topic, workspaceIds: [...topic.workspaceIds, workspace.id] };
    this.deps.record({ type: 'topic.updated', topic: updated }, () => this.deps.store.attachWorkspace(topic.id, workspace.id, this.deps.clock.now()));
    this.deps.topicChanged(updated);
    return updated;
  }

  detach(topicId: string, workspaceId: string): Topic {
    const topic = this.requireTopic(topicId);
    if (!topic.workspaceIds.includes(workspaceId)) return topic;
    const updated = { ...topic, workspaceIds: topic.workspaceIds.filter((id) => id !== workspaceId) };
    this.deps.record({ type: 'topic.updated', topic: updated }, () => this.deps.store.detachWorkspace(topic.id, workspaceId));
    this.deps.topicChanged(updated);
    return updated;
  }

  async setupLog(workspaceId: string): Promise<{ text: string }> {
    const workspace = this.requireWorkspace(workspaceId);
    if (!workspace.setupLog) return { text: '' };
    const file = await open(workspace.setupLog, 'r').catch(() => null);
    if (!file) return { text: '' };
    try {
      const { size } = await file.stat();
      const start = Math.max(0, size - LOG_TAIL_BYTES);
      const buffer = Buffer.alloc(size - start);
      await file.read(buffer, 0, buffer.length, start);
      return { text: buffer.toString('utf8') };
    } finally {
      await file.close();
    }
  }

  rerunSetup(workspaceId: string): Workspace {
    const workspace = this.requireWorkspace(workspaceId);
    if (workspace.archivedAt !== null) throw new HosError(409, `${workspace.name} is archived`);
    if (workspace.setup !== 'failed') throw new HosError(409, `setup of ${workspace.name} is ${workspace.setup}; only a failed setup can be re-run`);
    const updated = this.setSetup(workspace, 'pending', this.logPath(workspace.id));
    void this.runSetup(workspace.id);
    return updated;
  }

  async rename(workspaceId: string, wanted: string): Promise<Workspace> {
    const branch = wanted.trim();
    if (!branch) throw new HosError(400, 'branch is required');
    return this.deps.exclusive(async () => {
      const workspace = this.requireLive(workspaceId);
      if (!workspace.branch) throw new HosError(409, `${workspace.name} is not on a branch, so there is nothing to rename`);
      if (branch === workspace.branch) return workspace;
      if ((await worktreeStatus(workspace.path, workspace.branch)).dirty) {
        throw new HosError(409, `${workspace.name} has uncommitted changes; commit or discard them before renaming`);
      }
      const project = this.requireProject(workspace.projectId);
      const path = workspace.kind === 'worktree' ? this.deps.worktreePathFor(project, branch) : workspace.path;
      if (path !== workspace.path && existsSync(path)) throw new HosError(409, `${path} already exists`);
      try {
        await renameBranch(workspace.path, workspace.branch, branch);
      } catch (error) {
        throw new HosError(400, (error as Error).message);
      }
      if (path !== workspace.path) {
        try {
          await moveWorktree(project.path, workspace.path, path);
        } catch (error) {
          await renameBranch(workspace.path, branch, workspace.branch).catch(() => {});
          throw new HosError(400, (error as Error).message);
        }
      }
      await this.deps.refreshProject(project);
      const updated: Workspace = {
        ...workspace,
        branch,
        path,
        name: workspace.kind === 'root' ? workspace.name : workspaceName(branch),
        base: workspace.kind === 'root' ? branch : workspace.base,
      };
      this.save(updated);
      for (const topic of this.deps.store.topicsUsing(workspace.id)) this.deps.topicChanged(topic);
      return updated;
    });
  }

  async syncBranch(workspaceId: string): Promise<void> {
    const before = this.deps.store.getWorkspace(workspaceId);
    if (!before || before.archivedAt !== null) return;
    const branch = await currentBranch(before.path).catch(() => null);
    const workspace = this.deps.store.getWorkspace(workspaceId);
    if (!workspace || !branch || branch === 'HEAD' || branch === workspace.branch) return;
    this.save({
      ...workspace,
      branch,
      name: workspace.kind === 'root' ? workspace.name : workspaceName(branch),
      base: workspace.kind === 'root' ? branch : workspace.base,
    });
    for (const topic of this.deps.store.topicsUsing(workspace.id)) this.deps.topicChanged(topic);
  }

  async syncTopic(topic: Topic): Promise<void> {
    await Promise.all(topic.workspaceIds.map((id) => this.syncBranch(id)));
  }

  async archive(workspaceId: string, force: boolean): Promise<Workspace> {
    const workspace = this.requireLive(workspaceId);
    this.requireWorktree(workspace);
    const warnings = await this.warnings(workspace);
    if (warnings.length && !force) throw new HosError(409, `${workspace.name} has ${warnings.join(' and ')}; confirm to archive it anyway`);
    return this.archiveNow(workspace, warnings.length > 0);
  }

  async clearArchivedTopic(topic: Topic): Promise<{ workspace: Workspace; error: string }[]> {
    const failed: { workspace: Workspace; error: string }[] = [];
    for (const id of topic.workspaceIds) {
      const workspace = this.deps.store.getWorkspace(id);
      if (!workspace || workspace.kind !== 'worktree' || workspace.archivedAt !== null || !existsSync(workspace.path)) continue;
      if (this.deps.store.topicsUsing(id).some((t) => t.id !== topic.id && t.state !== 'archived')) continue;
      try {
        const branch = workspace.branch ?? (await currentBranch(workspace.path));
        if (branch === 'HEAD') throw new Error('it is on a detached HEAD, so there is no branch to push');
        if ((await worktreeStatus(workspace.path, branch)).dirty) await commitAll(workspace.path, `wip: ${topic.title} (archived in hos)`);
        await pushBranch(workspace.path, branch);
        await this.archiveNow(workspace, true);
      } catch (error) {
        failed.push({ workspace, error: (error as Error).message });
      }
    }
    return failed;
  }

  async delete(workspaceId: string): Promise<{ deleted: string }> {
    const workspace = this.requireWorkspace(workspaceId);
    this.requireWorktree(workspace);
    await this.deps.exclusive(async () => {
      const project = this.requireProject(workspace.projectId);
      if (existsSync(workspace.path)) await this.git(() => removeWorktree(project.path, workspace.path, true));
      if (workspace.branch) await this.git(() => deleteBranch(project.path, workspace.branch!));
      await this.deps.refreshProject(project);
    });
    this.detachEverywhere(workspace.id);
    this.runs.get(workspace.id)?.stop();
    this.deps.record({ type: 'workspace.deleted', workspaceId: workspace.id }, () => this.deps.store.deleteWorkspace(workspace.id));
    return { deleted: workspace.id };
  }

  assertWorktree(workspaceId: string): void {
    this.requireWorktree(this.requireWorkspace(workspaceId));
  }

  async terminal(workspaceId: string, topicId?: string): Promise<{ name: string }> {
    const workspace = this.requireLive(workspaceId);
    return { name: (await this.deps.createTerminal(workspace.path, topicId)).name };
  }

  async list(chatId: string): Promise<BusReply> {
    await Promise.all(this.scope(chatId).workspaces.map((w) => this.syncBranch(w.id)));
    const { topic, workspaces } = this.scope(chatId);
    if (!workspaces.length) {
      return { outcome: 'ok', text: `Topic "${topic.title}" uses no workspace yet; call workspace_choose to ask ${owner()} which checkout to work in.` };
    }
    const lines = workspaces.map((w) => {
      const used = this.deps.store.topicsUsing(w.id).map((t) => `"${t.title}"`);
      const attached = topic.workspaceIds.includes(w.id) ? ' (attached to your topic)' : '';
      return `- ${w.id.slice(0, 8)} ${w.kind} of ${this.repoName(w)} on ${w.branch ?? 'no branch'}${w.kind === 'worktree' && w.base ? ` from ${w.base}` : ''}${attached}: ${w.path}; setup ${w.setup}; used by ${used.length ? used.join(', ') : 'no topic'}.`;
    });
    return { outcome: 'ok', text: `Topic "${topic.title}" can use ${workspaces.length} workspace${workspaces.length === 1 ? '' : 's'}:\n${lines.join('\n')}` };
  }

  async createForChat(chatId: string, input: { repo: string; branch?: string; base?: string; path?: string }): Promise<BusReply> {
    const { topic } = this.scope(chatId);
    const used = this.topicProjects(topic);
    if (input.path) {
      if (!isAbsolute(input.path)) return refused('path must be absolute.');
      const main = (await listWorktrees(input.path))?.[0]?.path;
      if (main !== input.path) return refused(`${input.path} is not the main checkout of a git repository; run git init there first.`);
      const existing = this.deps.store.findProjectByPath(main);
      if (existing && !used.some((p) => p.id === existing.id)) {
        return refused(`${existing.name} is a repo hos already knows and your topic doesn't use it; call workspace_choose so ${owner()} picks.`);
      }
      const project = existing ?? (await this.deps.registerRepo(main));
      const workspace = await this.create({ projectId: project.id, kind: 'root', chatId });
      this.attach(topic.id, workspace.id);
      return { outcome: 'ok', text: `Registered ${project.name} at ${workspace.path} as a root workspace and attached it to your topic; setup is ${workspace.setup}.` };
    }
    const project = used.find((p) => repoNames(p).includes(input.repo));
    if (!project) {
      return refused(`Your topic doesn't use a repo named ${input.repo}; call workspace_choose so ${owner()} picks.`);
    }
    const branch = input.branch?.trim() || (await this.deps.freeBranch(project, `hos/${topic.statusTopic}`));
    const workspace = await this.create({ projectId: project.id, kind: 'worktree', branch, ...(input.base ? { baseRef: input.base } : {}), chatId });
    this.attach(topic.id, workspace.id);
    return {
      outcome: 'ok',
      text: `Created worktree ${workspace.id.slice(0, 8)} of ${project.name} on ${branch} from ${workspace.base ?? 'HEAD'} at ${workspace.path} and attached it to your topic. Setup is ${workspace.setup}${workspace.setup === 'ready' ? '' : '; call workspace_wait before you build or run anything there'}.`,
    };
  }

  async renameForChat(chatId: string, ref: string, branch: string): Promise<BusReply> {
    const workspace = this.resolve(chatId, ref);
    const before = workspace.path;
    const updated = await this.rename(workspace.id, branch).catch(asRefusal);
    if ('outcome' in updated) return updated;
    return { outcome: 'ok', text: `Renamed the branch to ${updated.branch}${updated.path !== before ? ` and moved the folder to ${updated.path}` : ''}.` };
  }

  async archiveForChat(chatId: string, ref: string): Promise<BusReply> {
    const workspace = this.resolve(chatId, ref);
    if (workspace.kind === 'root') return refused(`${workspace.name} is a root checkout; root workspaces are never archived.`);
    const warnings = await this.warnings(workspace);
    if (warnings.length && !(await this.deps.askOwner(chatId, `git worktree remove --force ${workspace.path}`, `Archive ${workspace.name} (${warnings.join(' and ')})`))) {
      return refused(`${ownerStart()} said no to archiving ${workspace.name}, which has ${warnings.join(' and ')}.`);
    }
    const done = await this.archiveNow(this.requireLive(workspace.id), warnings.length > 0).catch(asRefusal);
    if ('outcome' in done) return done;
    return { outcome: 'ok', text: `Archived ${workspace.name}: removed ${workspace.path}, kept branch ${workspace.branch ?? '(none)'}, and detached it from every topic.` };
  }

  async deleteForChat(chatId: string, ref: string): Promise<BusReply> {
    const workspace = this.resolve(chatId, ref);
    if (workspace.kind === 'root') return refused(`${workspace.name} is a root checkout; root workspaces are never deleted.`);
    const warnings = await this.warnings(workspace);
    const what = warnings.length ? ` (${warnings.join(' and ')})` : '';
    if (!(await this.deps.askOwner(chatId, `git worktree remove --force ${workspace.path} && git branch -D ${workspace.branch ?? ''}`, `Delete ${workspace.name}${what}`))) {
      return refused(`${ownerStart()} said no to deleting ${workspace.name}.`);
    }
    const done = await this.delete(workspace.id).catch(asRefusal);
    if ('outcome' in done) return done;
    return { outcome: 'ok', text: `Deleted ${workspace.name}: removed ${workspace.path}, deleted branch ${workspace.branch ?? '(none)'} and dropped the record.` };
  }

  workspaceForChat(chatId: string, ref: string): Workspace {
    return this.resolve(chatId, ref);
  }

  pathForChat(chatId: string, ref: string): BusReply {
    return { outcome: 'ok', text: this.resolve(chatId, ref).path };
  }

  async waitForChat(chatId: string, ref: string, timeoutS = WAIT_DEFAULT_S): Promise<BusReply> {
    // Cap below the MCP client's ~60 s cut-off so a long wait returns "still setting up, wait again"
    // rather than surfacing as a client-side timeout (H2).
    const waitS = Math.min(timeoutS, WAIT_CLAMP_S);
    const workspace = await this.waitSetup(this.resolve(chatId, ref).id, waitS * 1000);
    if (workspace.setup === 'ready') return { outcome: 'ok', text: `Setup of ${workspace.name} is ready; work in ${workspace.path}.` };
    if (workspace.setup === 'failed') {
      const tail = (await this.setupLog(workspace.id)).text.trim().split('\n').slice(-5).join('\n');
      return { outcome: 'ok', text: `Setup of ${workspace.name} failed. The last lines of its log:\n${tail || '(empty log)'}` };
    }
    return { outcome: 'ok', text: `Setup of ${workspace.name} is still ${workspace.setup} after ${waitS} s; call workspace_wait again.` };
  }

  async terminalForChat(chatId: string, ref: string): Promise<BusReply> {
    const workspace = this.resolve(chatId, ref);
    const { name } = await this.terminal(workspace.id, this.deps.store.getChat(chatId)!.topicId);
    return { outcome: 'ok', text: `Started terminal ${name} in ${workspace.path}; ${owner()} can open it at #/terminal/${encodeURIComponent(name)}.` };
  }

  async serverForChat(chatId: string, input: { workspace: string; app: string; command: string; port?: number }): Promise<BusReply> {
    const workspace = this.resolve(chatId, input.workspace);
    const port = input.port ?? this.deps.store.getWorktree(workspace.path)?.snapshot?.port;
    if (!(await this.deps.approveBash(chatId, input.command, `Start server ${input.app} in ${workspace.name}`))) {
      return refused(`${ownerStart()} denied starting ${input.app} in ${workspace.name}.`);
    }
    const server = await this.deps.servers.start({ worktreePath: workspace.path, app: input.app, command: input.command, ...(port ? { port } : {}) });
    const used = server.ports[0] ?? port;
    const preview = server.previewUrl ?? (used ? await this.deps.previewUrl(used) : null);
    return { outcome: 'ok', text: `Started ${server.name} (${server.state}) in ${workspace.path} with PORT=${used}. Preview: ${preview ?? 'none yet'}.` };
  }

  private initialSetup(project: Project, root: boolean): Workspace['setup'] {
    const config = this.setupConfig();
    if (config && config.skip.some((name) => repoNames(project).includes(name))) return 'ready';
    if (!config && root) return 'ready';
    return 'pending';
  }

  private setupConfig() {
    const { brainDir } = this.deps;
    return brainDir ? (readActionsFile(brainActionsFile(brainDir)).content?.setup ?? null) : null;
  }

  private async runSetup(workspaceId: string): Promise<void> {
    let workspace = this.requireWorkspace(workspaceId);
    const project = this.requireProject(workspace.projectId);
    await mkdir(join(this.deps.dataDir, 'setup'), { recursive: true });
    const log = createWriteStream(this.logPath(workspace.id), { flags: 'w' });
    const write = (text: string) => void log.write(text);
    const started = this.deps.clock.now();
    workspace = this.setSetup(workspace, 'running', this.logPath(workspace.id));
    let ok = false;
    try {
      const config = this.setupConfig();
      if (!config) {
        write(`copy .env* from ${project.path}\n`);
        ok = await copyEnvFiles(project.path, workspace.path, write);
      } else {
        const command = await this.setupCommand(config.run);
        write(`$ ${config.run}\n`);
        const env = {
          ...process.env,
          HOS_WORKSPACE_PATH: workspace.path,
          HOS_ROOT_PATH: project.path,
          HOS_REPO: project.key ?? basename(project.path),
          HOS_BRANCH: workspace.branch ?? '',
          HOS_BASE: workspace.base ?? '',
          ...(this.deps.brainDir ? { HOS_BRAIN: this.deps.brainDir } : {}),
        };
        const run = runOnHost(command, workspace.path, env, write);
        this.runs.set(workspace.id, run);
        let timedOut = false;
        const cancel = this.deps.clock.setTimeout(() => {
          timedOut = true;
          run.stop();
        }, SETUP_LIMIT_MS);
        const code = await run.done;
        cancel();
        this.runs.delete(workspace.id);
        if (timedOut) write(`setup stopped after ${SETUP_LIMIT_MS / 60_000} minutes\n`);
        else write(`setup exited with code ${code ?? 'none'} after ${((this.deps.clock.now() - started) / 1000).toFixed(1)}s\n`);
        ok = code === 0 && !timedOut;
      }
    } catch (error) {
      write(`${(error as Error).message}\n`);
    }
    await new Promise<void>((resolve) => log.end(resolve));
    const current = this.deps.store.getWorkspace(workspace.id);
    if (current) this.setSetup(current, ok ? 'ready' : 'failed');
  }

  private async setupCommand(run: string): Promise<string> {
    const { brainDir } = this.deps;
    if (!brainDir || isAbsolute(run)) return run;
    const file = join(brainDir, run);
    if (!(await stat(file).catch(() => null))?.isFile()) return run;
    const quoted = `'${file.replaceAll("'", `'\\''`)}'`;
    return (await access(file, constants.X_OK).then(() => true, () => false)) ? quoted : `/bin/bash ${quoted}`;
  }

  private setSetup(workspace: Workspace, setup: Workspace['setup'], setupLog = workspace.setupLog): Workspace {
    const updated = { ...workspace, setup, setupLog };
    this.save(updated);
    for (const topic of this.deps.store.topicsUsing(workspace.id)) this.deps.topicChanged(topic);
    if (setup === 'ready' || setup === 'failed') {
      for (const wake of this.waiters.get(workspace.id) ?? []) wake();
      this.waiters.delete(workspace.id);
    }
    return updated;
  }

  private waitSetup(workspaceId: string, timeoutMs: number): Promise<Workspace> {
    const now = () => this.requireWorkspace(workspaceId);
    const workspace = now();
    if (workspace.setup === 'ready' || workspace.setup === 'failed') return Promise.resolve(workspace);
    return new Promise((resolve) => {
      const waiters = this.waiters.get(workspaceId) ?? new Set<() => void>();
      this.waiters.set(workspaceId, waiters);
      const done = () => {
        cancel();
        waiters.delete(done);
        resolve(this.deps.store.getWorkspace(workspaceId) ?? workspace);
      };
      const cancel = this.deps.clock.setTimeout(done, timeoutMs);
      waiters.add(done);
    });
  }

  private async appendLog(workspace: Workspace, text: string): Promise<void> {
    if (!workspace.setupLog) return;
    await mkdir(join(this.deps.dataDir, 'setup'), { recursive: true });
    const file = await open(workspace.setupLog, 'a');
    await file.write(text);
    await file.close();
  }

  private logPath(workspaceId: string): string {
    return join(this.deps.dataDir, 'setup', `${workspaceId}.log`);
  }

  private async archiveNow(workspace: Workspace, force: boolean): Promise<Workspace> {
    await this.deps.exclusive(async () => {
      const project = this.requireProject(workspace.projectId);
      if (existsSync(workspace.path)) await this.git(() => removeWorktree(project.path, workspace.path, force));
      await this.deps.refreshProject(project);
    });
    this.runs.get(workspace.id)?.stop();
    this.detachEverywhere(workspace.id);
    const updated = { ...(this.deps.store.getWorkspace(workspace.id) ?? workspace), archivedAt: this.deps.clock.now() };
    this.save(updated);
    return updated;
  }

  private detachEverywhere(workspaceId: string): void {
    for (const topic of this.deps.store.topicsUsing(workspaceId)) this.detach(topic.id, workspaceId);
  }

  private async warnings(workspace: Workspace): Promise<string[]> {
    if (!existsSync(workspace.path)) return [];
    const status = await worktreeStatus(workspace.path, workspace.branch);
    return [
      ...(status.dirty ? ['uncommitted changes'] : []),
      ...(status.unpushed ? [`${status.unpushed} unpushed commit${status.unpushed === 1 ? '' : 's'}`] : []),
    ];
  }

  private async git(run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      throw new HosError(400, (error as Error).message);
    }
  }

  private save(workspace: Workspace): void {
    this.deps.record({ type: 'workspace.updated', workspace }, () => this.deps.store.updateWorkspace(workspace));
  }

  private scope(chatId: string): { topic: Topic; workspaces: Workspace[] } {
    const chat = this.deps.store.getChat(chatId);
    if (!chat) throw new HosError(404, `no chat ${chatId}`);
    const topic = this.requireTopic(chat.topicId);
    const projects = new Set(this.topicProjects(topic).map((p) => p.id));
    const attached = topic.workspaceIds.map((id) => this.deps.store.getWorkspace(id)).filter((w): w is Workspace => !!w && w.archivedAt === null);
    const others = this.deps.store.listWorkspaces().filter((w) => projects.has(w.projectId) && !topic.workspaceIds.includes(w.id));
    return { topic, workspaces: [...attached, ...others] };
  }

  private resolve(chatId: string, ref: string): Workspace {
    const { topic, workspaces } = this.scope(chatId);
    const wanted = ref.trim();
    const pick = (matches: Workspace[]): Workspace | undefined => {
      if (matches.length <= 1) return matches[0];
      const attached = matches.filter((w) => topic.workspaceIds.includes(w.id));
      if (attached.length === 1) return attached[0];
      throw new Error(`"${wanted}" matches ${matches.length} workspaces (${matches.map((w) => `${w.id.slice(0, 8)} ${w.branch ?? w.name}`).join(', ')}); name one by id.`);
    };
    const found =
      workspaces.find((w) => w.id === wanted || (wanted.length >= 8 && w.id.startsWith(wanted))) ??
      pick(workspaces.filter((w) => w.branch === wanted || (w.kind === 'worktree' && w.name === wanted))) ??
      pick(workspaces.filter((w) => repoNames(this.requireProject(w.projectId)).includes(wanted)));
    if (!found) throw new Error(`Your topic has no workspace "${wanted}"; workspace_list shows the ones you can use.`);
    return found;
  }

  private topicProjects(topic: Topic): Project[] {
    const ids = new Set(topic.workspaceIds.map((id) => this.deps.store.getWorkspace(id)?.projectId).filter((id): id is string => !!id));
    return [...ids].map((id) => this.deps.store.getProject(id)).filter((p): p is Project => !!p);
  }

  private repoName(workspace: Workspace): string {
    return this.deps.store.getProject(workspace.projectId)?.name ?? workspace.name;
  }

  private requireWorktree(workspace: Workspace): void {
    if (workspace.kind === 'root') throw new HosError(400, `${workspace.name} is a root checkout; only worktrees can be archived or deleted`);
  }

  private requireLive(workspaceId: string): Workspace {
    const workspace = this.requireWorkspace(workspaceId);
    if (workspace.archivedAt !== null) throw new HosError(409, `${workspace.name} is archived`);
    return workspace;
  }

  private requireWorkspace(workspaceId: string): Workspace {
    const workspace = this.deps.store.getWorkspace(workspaceId);
    if (!workspace) throw new HosError(404, `no workspace ${workspaceId}`);
    return workspace;
  }

  private requireTopic(topicId: string): Topic {
    const topic = this.deps.store.getTopic(topicId);
    if (!topic) throw new HosError(404, `no topic ${topicId}`);
    return topic;
  }

  private requireProject(projectId: string): Project {
    const project = this.deps.store.getProject(projectId);
    if (!project) throw new HosError(404, `no project ${projectId}`);
    return project;
  }
}

function repoNames(project: Project): string[] {
  return [project.name, basename(project.path), ...(project.key ? [project.key] : [])];
}

function refused(text: string): BusReply {
  return { outcome: 'refused', text: `Refused: ${text}` };
}

function asRefusal(error: unknown): BusReply {
  if (error instanceof HosError && error.status < 500) return refused(error.message);
  throw error;
}

async function copyEnvFiles(root: string, workspace: string, write: (text: string) => void): Promise<boolean> {
  if (root === workspace) {
    write('workspace is the root checkout; nothing to copy\n');
    return true;
  }
  let copied = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith('.env')) continue;
    try {
      await copyFile(join(root, entry.name), join(workspace, entry.name), constants.COPYFILE_EXCL);
      write(`copied ${entry.name}\n`);
      copied++;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      write(`kept ${entry.name} (already in the workspace)\n`);
    }
  }
  if (!copied) write('no .env* files to copy\n');
  return true;
}
