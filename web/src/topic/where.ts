import type { Chat } from '../../../src/api/types.js';
import type { State } from '../state.js';

const LEADING_CD = /^\s*cd\s+(['"]?)(\/[^'";&|\s]+)\1/;

export function shortPath(path: string, roots: string[] = []): string {
  if (!path.startsWith('/')) return path;
  const root = roots.find((r) => path.startsWith(`${r}/`));
  if (root) return path.slice(root.length + 1);
  const parts = path.split('/').filter(Boolean);
  return parts.length > 3 ? parts.slice(-3).join('/') : parts.join('/');
}

export function approvalWhere(state: State, chat: Chat, input: string): string {
  const topic = state.topics[chat.topicId];
  const workspaces = (topic?.workspaceIds ?? []).flatMap((id) => (state.workspaces[id] ? [state.workspaces[id]] : []));
  let path = '';
  try {
    const args = JSON.parse(input) as Record<string, unknown>;
    path =
      [args.file_path, args.notebook_path, args.path].find((v): v is string => typeof v === 'string' && v.startsWith('/')) ??
      (typeof args.command === 'string' ? (LEADING_CD.exec(args.command)?.[2] ?? '') : '');
  } catch {
    path = '';
  }
  const dir = path || chat.worktreePath || '';
  const inside = (root: string) => dir === root || dir.startsWith(`${root}/`);
  const workspace = workspaces.find((w) => inside(w.path));
  if (!workspace) return chat.worktreePath && inside(chat.worktreePath) ? `in ${shortPath(chat.worktreePath)}` : 'in the brain';
  const repo = state.projects.find((p) => p.id === workspace.projectId)?.name ?? workspace.name;
  return `in ${repo}, ${workspace.branch ?? workspace.name}`;
}
