import type { HosClient } from '../src/api/client.js';
import type { Topic, Workspace } from '../src/api/types.js';

export interface TopicOptions {
  worktreePath?: string;
  statusTopic?: string;
  byChat?: string;
}

export type TestTopic = Topic & { folder: Workspace };

export async function newTopic(client: HosClient, projectId: string, title: string, options: TopicOptions = {}): Promise<TestTopic> {
  const folder = await client.createWorkspace({
    projectId,
    kind: options.worktreePath ? 'worktree' : 'root',
    ...(options.worktreePath ? { path: options.worktreePath } : {}),
    ...(options.byChat ? { chatId: options.byChat } : {}),
  });
  const topic = await client.createTopic({
    title,
    workspaceId: folder.id,
    ...(options.statusTopic ? { statusTopic: options.statusTopic } : {}),
    ...(options.byChat ? { chatId: options.byChat } : {}),
  });
  return { ...topic, folder };
}
