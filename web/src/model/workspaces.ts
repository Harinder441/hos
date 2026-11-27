import { client } from '../lib.js';
import { dockTerminal } from '../topic/dock.js';
import type { State } from '../state.js';

export interface WorkspaceRow {
  id: string;
  repo: string;
  projectId: string;
  kind: 'root' | 'worktree';
  branch: string | null;
  path: string;
  setup: 'pending' | 'running' | 'ready' | 'failed';
  usedBy: Array<{ topicId: string; title: string }>;
}

export function workspaceRows(state: State): WorkspaceRow[] {
  const topics = Object.values(state.topics).filter((topic) => topic.state !== 'archived');
  return Object.values(state.workspaces)
    .filter((workspace) => workspace.archivedAt === null)
    .map((workspace) => ({
      id: workspace.id,
      repo: state.projects.find((p) => p.id === workspace.projectId)?.name ?? workspace.name,
      projectId: workspace.projectId,
      kind: workspace.kind,
      branch: workspace.branch,
      path: workspace.path,
      setup: workspace.setup,
      usedBy: topics.filter((topic) => topic.workspaceIds.includes(workspace.id)).map((topic) => ({ topicId: topic.id, title: topic.title })),
    }))
    .sort(
      (a, b) =>
        a.repo.localeCompare(b.repo) ||
        Number(b.kind === 'root') - Number(a.kind === 'root') ||
        (a.branch ?? '').localeCompare(b.branch ?? ''),
    );
}

export function copyPath(path: string): Promise<void> {
  return navigator.clipboard.writeText(path);
}

export async function openInCodeView(path: string): Promise<string> {
  const { url } = await client.openCodeView(path);
  open(url, '_blank', 'noopener');
  return url;
}

export async function openWorkspaceTerminal(workspaceId: string, topicId?: string, inDock = false): Promise<string> {
  const { name } = await client.openWorkspaceTerminal(workspaceId, topicId);
  if (topicId && inDock) dockTerminal(topicId, name);
  else location.hash = `#/terminal/${encodeURIComponent(name)}`;
  return name;
}

export function renameWorkspace(workspaceId: string, branch: string): Promise<unknown> {
  return client.renameWorkspace(workspaceId, branch);
}

export function archiveWorkspace(workspaceId: string, force: boolean): Promise<unknown> {
  return client.archiveWorkspace(workspaceId, { force });
}

export function deleteWorkspace(workspaceId: string): Promise<unknown> {
  return client.deleteWorkspace(workspaceId);
}

export async function setupLog(workspaceId: string): Promise<string> {
  return (await client.workspaceSetupLog(workspaceId)).text;
}

export function rerunSetup(workspaceId: string): Promise<unknown> {
  return client.rerunSetup(workspaceId);
}
