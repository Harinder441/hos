import { execFileSync } from 'node:child_process';
import { createPrivateKey } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { HosClient } from '../src/api/client.js';
import { FakeAuthenticator } from '../src/fakes/fake-authenticator.js';

const port = Number(process.env.HOS_E2E_PORT ?? 47317);

export function tempGitRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hos-e2e-repo-')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), '# e2e\n');
  git('add', '.');
  git('-c', 'user.name=hos-e2e', '-c', 'user.email=hos@test.invalid', 'commit', '-q', '-m', 'init');
  return dir;
}

let signedIn: Promise<HosClient> | undefined;

export function api(): Promise<HosClient> {
  signedIn ??= (async () => {
    const shared = JSON.parse(readFileSync(join(process.env.HOS_E2E_DATA_DIR!, 'passkey.json'), 'utf8'));
    const passkey = new FakeAuthenticator(`http://localhost:${port}`, [
      {
        id: Buffer.from(shared.credentialId, 'base64'),
        rpId: shared.rpId,
        userHandle: Buffer.from(shared.userHandle, 'base64').toString('base64url'),
        privateKey: createPrivateKey({ key: Buffer.from(shared.privateKey, 'base64'), format: 'der', type: 'pkcs8' }),
      },
    ]);
    const client = new HosClient(`http://127.0.0.1:${port}`, { authenticator: passkey });
    await client.signIn();
    return client;
  })();
  return signedIn;
}

export interface TopicFixture {
  topicId: string;
  chatId: string;
  workspaceId: string | null;
}

const openTopics: string[] = [];

// The shared daemon polls git for every active topic's workspaces every 300 ms, so finished tests' topics are set done.
export async function closeTopics(): Promise<void> {
  const client = await api();
  for (const topicId of openTopics.splice(0)) await client.setTopicState(topicId, 'done').catch(() => {});
}

export async function newTopic(options: { title: string; repo?: string }): Promise<TopicFixture> {
  const client = await api();
  const workspace = options.repo ? await client.createWorkspace({ projectId: (await client.createProject(options.repo)).id, kind: 'root' }) : undefined;
  const topic = await client.createTopic({ title: options.title, ...(workspace ? { workspaceId: workspace.id } : {}) });
  openTopics.push(topic.id);
  const chatId = (await client.createChat(topic.id)).id;
  return { topicId: topic.id, chatId, workspaceId: workspace?.id ?? null };
}

export function topicHash(topicId: string, chatId?: string): string {
  return chatId ? `#/topic/${topicId}/chat/${chatId}` : `#/topic/${topicId}`;
}

export function topicSign(page: Page, topicId: string): Locator {
  const link = page.locator(`a[href="${topicHash(topicId)}"]`);
  return page.getByRole('list', { name: 'Topics' }).getByRole('listitem').filter({ has: link }).locator('svg.sign').first();
}
