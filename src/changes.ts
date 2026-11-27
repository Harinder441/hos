import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Clock } from './adapters/clock.js';
import { brainActionsFile, readActionsFile, REPO_ACTIONS_FILE } from './actions.js';
import type { PanelAction, PanelChanged, PanelGit, PanelTouchedFile, PanelWorkspace, Topic, Workspace } from './api/types.js';
import { EDIT_TOOL_FIELDS } from './harnesses/tools.js';
import {
  changedFiles,
  compareRef,
  countCommits,
  currentBranch,
  EMPTY_TREE,
  mergeBase,
  openPullRequestNumber,
  resolveCommit,
  snapshotTree,
  worktreeStatus,
} from './git.js';
import type { Store } from './store.js';

const PR_CACHE_MS = 60_000;
const EDIT_TOOLS = EDIT_TOOL_FIELDS;

export interface ChangesDeps {
  store: Store;
  clock: Clock;
  brainDir: string | undefined;
  ghBin: string;
}

export class Changes {
  private readonly prs = new Map<string, { at: number; pr: number | null }>();

  constructor(private readonly deps: ChangesDeps) {}

  // Write / Edit / MultiEdit / NotebookEdit calls name their target; shell writes can't be attributed (D22).
  touch(topic: Topic, chatId: string, cwd: string, tool: string, input: unknown): void {
    const field = EDIT_TOOLS[tool];
    if (!field) return;
    const value = (input as Record<string, unknown> | null | undefined)?.[field];
    if (typeof value !== 'string' || !value.trim()) return;
    const file = isAbsolute(value) ? resolve(value) : resolve(cwd, value);
    for (const workspaceId of topic.workspaceIds) {
      const workspace = this.deps.store.getWorkspace(workspaceId);
      const path = workspace && inside(workspace.path, file);
      if (!path) continue;
      this.deps.store.touchFile({ topicId: topic.id, workspaceId, path, chatId, firstAt: this.deps.clock.now() });
      return;
    }
  }

  panel(topic: Topic): Promise<PanelWorkspace[]> {
    const workspaces = topic.workspaceIds.flatMap((id) => {
      const workspace = this.deps.store.getWorkspace(id);
      return workspace && workspace.archivedAt === null ? [workspace] : [];
    });
    return Promise.all(workspaces.map((workspace) => this.workspacePanel(topic, workspace)));
  }

  async workspacePanel(topic: Topic, workspace: Workspace): Promise<PanelWorkspace> {
    const repo = this.deps.store.getProject(workspace.projectId)?.name ?? workspace.name;
    const scripts = this.scriptActions(workspace);
    const head: Omit<PanelWorkspace, 'git' | 'changed' | 'touched' | 'actions' | 'against'> = {
      workspaceId: workspace.id,
      repo,
      kind: workspace.kind,
      branch: workspace.branch,
      base: workspace.base,
      path: workspace.path,
      setup: workspace.setup,
      errors: scripts.errors,
    };
    const gone = { ...head, against: null, git: NO_GIT, changed: { files: [], additions: 0, deletions: 0 }, touched: [], actions: [] };
    if (!existsSync(workspace.path)) return gone;
    try {
      const { git, from, against } = await this.gitState(workspace);
      const changed = await this.changed(workspace, from);
      const touched = this.touched(topic, workspace, changed);
      return { ...head, against, git, changed, touched, actions: [...gitActions(workspace, git, changed), ...scripts.actions] };
    } catch (error) {
      // An archive can remove the folder while git is still reading it.
      if (!existsSync(workspace.path)) return gone;
      throw error;
    }
  }

  async gitState(workspace: Workspace): Promise<{ git: PanelGit; from: string; against: string | null }> {
    const path = workspace.path;
    const branch = workspace.branch ?? (await currentBranch(path).catch(() => null));
    const status = await worktreeStatus(path, branch);
    const head = (await resolveCommit(path, 'HEAD')) ?? EMPTY_TREE;
    const base = workspace.kind === 'worktree' && workspace.base && workspace.base !== branch ? await compareRef(path, workspace.base) : null;
    let from = head;
    let ahead = status.upstream ? (status.ahead ?? 0) : 0;
    if (base) {
      const forked = await mergeBase(path, 'HEAD', base);
      if (forked) {
        from = forked;
        if (!status.upstream) ahead = await countCommits(path, forked, head).catch(() => 0);
      }
    } else if (status.upstream) {
      from = (await mergeBase(path, 'HEAD', '@{upstream}')) ?? head;
    }
    const pr = status.upstream && branch ? await this.openPr(path, branch) : null;
    return { git: { dirty: status.dirty, ahead, behind: status.upstream ? (status.behind ?? 0) : 0, upstream: status.upstream, pr }, from, against: base };
  }

  async diffAgainstBase(workspace: Workspace): Promise<{ from: string; changed: PanelChanged }> {
    const { from } = await this.gitState(workspace);
    return { from, changed: await this.changed(workspace, from) };
  }

  private async changed(workspace: Workspace, from: string): Promise<PanelChanged> {
    const files = await changedFiles(workspace.path, from, await snapshotTree(workspace.path));
    return {
      files: files.map(({ path, status, additions, deletions }) => ({ path, status, additions, deletions })),
      additions: files.reduce((total, file) => total + file.additions, 0),
      deletions: files.reduce((total, file) => total + file.deletions, 0),
    };
  }

  private touched(topic: Topic, workspace: Workspace, changed: PanelChanged): PanelTouchedFile[] {
    const inDiff = new Set(changed.files.map((file) => file.path));
    return this.deps.store.touchedFiles(topic.id, workspace.id).map((row) => ({ path: row.path, inDiff: inDiff.has(row.path) }));
  }

  private async openPr(path: string, branch: string): Promise<number | null> {
    const key = `${path}\u0000${branch}`;
    const known = this.prs.get(key);
    const now = this.deps.clock.now();
    if (known && now - known.at < PR_CACHE_MS) return known.pr;
    const pr = await openPullRequestNumber(path, branch, this.deps.ghBin);
    this.prs.set(key, { at: now, pr });
    return pr;
  }

  private scriptActions(workspace: Workspace): { actions: PanelAction[]; errors: string[] } {
    const project = this.deps.store.getProject(workspace.projectId);
    const repos = [project?.key, project?.name].filter((name): name is string => Boolean(name));
    const errors: string[] = [];
    const byName = new Map<string, PanelAction>();
    const read = (file: string) => {
      const { content, error } = readActionsFile(file);
      if (error) errors.push(error);
      for (const action of content?.actions ?? []) {
        if (action.applies_to !== 'all' && !action.applies_to.some((name) => repos.includes(name))) continue;
        byName.set(action.name, {
          kind: 'script',
          name: action.name,
          label: action.label ?? action.name,
          title: action.run,
          args: action.args,
          confirm: action.confirm,
        });
      }
    };
    if (this.deps.brainDir) read(brainActionsFile(this.deps.brainDir));
    read(join(workspace.path, REPO_ACTIONS_FILE));
    return { actions: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), errors };
  }
}

const NO_GIT: PanelGit = { dirty: false, ahead: 0, behind: 0, upstream: null, pr: null };

function gitActions(workspace: Workspace, git: PanelGit, changed: PanelChanged): PanelAction[] {
  const branch = workspace.branch ?? 'HEAD';
  const base = workspace.base ?? 'its base';
  const action = (name: PanelAction['name'], label: string, title: string): PanelAction => ({
    kind: 'git',
    name,
    label,
    title,
    args: [],
    confirm: false,
  });
  return [
    ...(git.dirty ? [action('commit', 'Commit', 'Commit the uncommitted changes')] : []),
    ...(git.ahead > 0
      ? [action('push', 'Push', git.upstream ? `${git.ahead} commits ahead of ${git.upstream}` : `${git.ahead} commits to push to origin/${branch}`)]
      : []),
    ...(git.behind > 0 ? [action('pull', 'Pull', `${git.behind} commits behind ${git.upstream}`)] : []),
    ...(git.upstream && git.ahead === 0 && changed.files.length > 0 && git.pr === null
      ? [action('pull-request', 'Open PR', `Open a PR from ${branch} into ${base}`)]
      : []),
    ...(changed.files.length > 0 ? [action('review', 'Review', `Start a reviewer on the diff against ${base}`)] : []),
  ];
}

function inside(root: string, file: string): string | null {
  const path = relative(root, file);
  if (!path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) return null;
  return path.split(sep).join('/');
}
