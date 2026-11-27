import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';
import type { Clock } from './adapters/clock.js';
import type { Chat, Workspace } from './api/types.js';
import { HosError } from './core.js';
import { owner, ownerStart } from './owner.js';
import type { PrLink, Store } from './store.js';

const BATCH = 3;
const PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?:[/?#].*)?$/;

export interface PrRef {
  url: string;
  owner: string;
  repo: string;
  number: number;
}

export function parsePrUrl(raw: string): PrRef {
  const match = PR_URL.exec(raw.trim());
  if (!match) throw new HosError(400, 'url must be a GitHub pull request, like https://github.com/owner/repo/pull/123');
  const [, owner, repo, number] = match;
  return { url: `https://github.com/${owner}/${repo}/pull/${number}`, owner: owner!, repo: repo!, number: Number(number) };
}

export interface ReviewComment {
  path: string;
  line: number;
  side?: string;
  body: string;
}

export interface PrReviewDeps {
  store: Store;
  clock: Clock;
  brainDir: string | undefined;
  workDir(topicId: string): string | null;
  topicWorkspaces(topicId: string): Workspace[];
  checkouts(): string[];
  fallbackDir: string;
  busy(chat: Chat): boolean;
  startChat(topicId: string): Promise<Chat>;
  send(chatId: string, text: string): Promise<void>;
  commit?(paths: string[], subject: string): void;
}

export class PrReviews {
  private flushing: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: PrReviewDeps) {}

  link(raw: string, topicId: string): PrLink & { owner: string } {
    const pr = parsePrUrl(raw);
    if (!this.deps.store.getTopic(topicId)) throw new HosError(404, `no topic ${topicId}`);
    return { ...this.deps.store.linkPr({ url: pr.url, topicId, repo: pr.repo, number: pr.number }, this.deps.clock.now()), owner: pr.owner };
  }

  setPort(url: string, port: number): void {
    this.deps.store.setPrPort(url, port);
  }

  async checkoutFor(link: PrLink & { owner: string }): Promise<string> {
    const want = `${link.owner}/${link.repo}`.toLowerCase();
    const paths = [...this.deps.topicWorkspaces(link.topicId).map((w) => w.path), ...this.deps.checkouts()];
    for (const path of paths) {
      const origin = await promisify(execFile)('git', ['-C', path, 'remote', 'get-url', 'origin']).then(
        ({ stdout }) => stdout.trim().toLowerCase().replace(/\.git$/, ''),
        () => '',
      );
      if (origin.endsWith(`/${want}`) || origin.endsWith(`:${want}`)) return path;
    }
    await mkdir(this.deps.fallbackDir, { recursive: true });
    return this.deps.fallbackDir;
  }

  async start(raw: string, head: string, withChat: boolean): Promise<{ topicId: string; chatId: string | null; file: string }> {
    const link = this.linked(raw);
    const file = this.file(link);
    await this.append(link, file, `\n## Session ${new Date(this.deps.clock.now()).toISOString().slice(0, 16).replace('T', ' ')}\n\n`);
    if (!withChat) {
      this.deps.store.setPrReview(link.url, null, 'open');
      return { topicId: link.topicId, chatId: null, file };
    }
    const chat = await this.deps.startChat(link.topicId);
    this.deps.store.setPrReview(link.url, chat.id, 'open');
    await this.deps.send(chat.id, this.intro(link, head, file));
    return { topicId: link.topicId, chatId: chat.id, file };
  }

  async comment(raw: string, comment: ReviewComment): Promise<{ ref: string }> {
    const link = this.linked(raw);
    const body = comment.body?.trim();
    if (!body || !comment.path || !(comment.line > 0)) throw new HosError(400, 'a comment needs path, line and body');
    const where = `${comment.path}:${comment.line}${comment.side === 'LEFT' ? ' (removed line)' : ''}`;
    const text = `${where} · ${body.replace(/\n/g, '\n  ')}`;
    const chatId = link.reviewState ? link.reviewChatId : null;
    const ref = this.deps.store.addPrComment(link.url, chatId, text, this.deps.clock.now());
    await this.append(link, this.file(link), `- [ ] ${ref} · ${text}\n`);
    if (chatId) await this.flush(link.url);
    return { ref };
  }

  async end(raw: string): Promise<{ ended: true }> {
    const link = this.linked(raw);
    if (!link.reviewState) return { ended: true };
    if (!link.reviewChatId) this.deps.store.setPrReview(link.url, null, null);
    else {
      this.deps.store.setPrReview(link.url, link.reviewChatId, 'ending');
      await this.flush(link.url);
    }
    return { ended: true };
  }

  turnEnded(chat: Chat): void {
    for (const link of this.deps.store.prLinksReviewedBy(chat.id)) {
      void this.flush(link.url).catch((error) => console.error('pr review flush failed', error));
    }
  }

  private flush(url: string): Promise<void> {
    const run = this.flushing.then(() => this.flushNow(url));
    this.flushing = run.catch(() => {});
    return run;
  }

  private async flushNow(url: string): Promise<void> {
    const link = this.deps.store.prLink(url);
    if (!link?.reviewChatId || !link.reviewState) return;
    const chat = this.deps.store.getChat(link.reviewChatId);
    if (!chat || this.deps.busy(chat)) return;
    const ending = link.reviewState === 'ending';
    const pending = this.deps.store.unsentPrComments(url, chat.id);
    const batch = ending ? pending : pending.length >= BATCH ? pending.slice(0, BATCH) : [];
    if (ending) this.deps.store.setPrReview(url, chat.id, null);
    if (!batch.length) return;
    this.deps.store.markPrCommentsSent(batch.map((c) => c.id), this.deps.clock.now());
    const file = this.file(link);
    const lines = batch.map((c) => `- ${c.ref} · ${c.text}`);
    const head = ending ? `Last review comments from ${owner()} (they ended the review)` : `Review comments from ${owner()}`;
    await this.deps.send(
      chat.id,
      [`${head} on ${link.url}:`, '', ...lines, '', `Fix each one, then mark it done in ${file} ([ ] → [x], plus a few words on what changed).`].join('\n'),
    );
  }

  private intro(link: PrLink, head: string, file: string): string {
    const onBranch = this.deps.topicWorkspaces(link.topicId).find((w) => w.branch === head);
    const where = onBranch
      ? `Edit the topic's workspace on the PR's head branch: ${onBranch.path} (branch ${head}).`
      : `This topic has no workspace on the PR's head branch ${head}; call workspace_choose with branch ${head} before you edit.`;
    return [
      `Review session for ${link.url}.`,
      `Read the topic's PROGRESS.md first.`,
      where,
      `${ownerStart()} is reviewing in Code view. Their comments arrive here three at a time and are kept in ${file}; nothing goes to GitHub.`,
      'Wait for them: reply that you are ready, nothing else yet.',
    ].join('\n');
  }

  private linked(raw: string): PrLink {
    const link = this.deps.store.prLink(parsePrUrl(raw).url);
    if (!link) throw new HosError(404, 'that PR is not linked to a topic yet; open it through its Code view link first');
    return link;
  }

  private file(link: PrLink): string {
    const workDir = this.deps.workDir(link.topicId);
    if (!workDir) throw new HosError(409, 'this topic has no work folder, so its review has nowhere to go');
    return join(workDir, 'reviews', `PR-${link.number}.md`);
  }

  private async append(link: PrLink, file: string, text: string): Promise<void> {
    await mkdir(dirname(file), { recursive: true });
    const header = existsSync(file)
      ? ''
      : `# PR #${link.number} review · ${link.repo}\n\nGitHub: ${link.url}\n\nComments from ${owner()}'s Code view review; the review chat ticks each one ([ ] → [x]) when it is done.\n`;
    await appendFile(file, header + text);
    if (this.deps.brainDir && this.deps.commit) this.deps.commit([relative(this.deps.brainDir, file)], `hos: PR #${link.number} review`);
  }
}
