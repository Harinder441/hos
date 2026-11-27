import { randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';
import type { Clock } from './adapters/clock.js';
import type { Chat, Lock, LockRelease } from './api/types.js';
import type { BusReply, Recorder } from './bus.js';
import type { Store } from './store.js';

export const DEFAULT_LOCK_MINUTES = 15;

export class Locks {
  constructor(
    private readonly store: Store,
    private readonly record: Recorder,
    private readonly clock: Clock,
    private readonly rootOf: (chatId: string) => string,
  ) {}

  live(topicId: string): Lock[] {
    const now = this.clock.now();
    return this.store.topicLocks(topicId).filter((lock) => lock.expiresAt > now);
  }

  acquire(chat: Chat, paths: string[], ttlMinutes = DEFAULT_LOCK_MINUTES): BusReply {
    const patterns = paths.map(normalizePattern);
    const bad = paths.filter((_, i) => !patterns[i]);
    if (bad.length) return { outcome: 'refused', text: `Refused: lock paths are relative to your worktree, without "..": ${bad.join(', ')}.` };
    const wanted = [...new Set(patterns as string[])];
    if (editsOnlyOwned(chat)) {
      const outside = wanted.filter((p) => !covered(p, chat.ownedFiles));
      if (outside.length) {
        return { outcome: 'refused', text: `Refused: ${outside.join(', ')} ${outside.length === 1 ? 'is' : 'are'} outside your owned files (${ownedText(chat)}).` };
      }
    }
    const conflicts = this.conflicts(chat.topicId, wanted, this.rootOf(chat.id), chat.id);
    if (conflicts.length) {
      return { outcome: 'refused', text: `Refused: ${conflicts.join('; ')}. Message the owner with send, or wait for it to unlock.` };
    }
    const now = this.clock.now();
    const ttlMs = ttlMinutes * MINUTE;
    const held = this.store.chatLocks(chat.id);
    for (const pattern of wanted) {
      const existing = held.find((lock) => lock.pattern === pattern);
      if (existing && existing.expiresAt > now) {
        this.store.setLockTtl(existing.id, ttlMs, now + ttlMs);
        continue;
      }
      if (existing) this.release(existing, 'expired');
      const lock: Lock = { id: randomUUID(), topicId: chat.topicId, chatId: chat.id, pattern, acquiredAt: now, expiresAt: now + ttlMs };
      this.record({ type: 'lock.acquired', lock }, () => this.store.insertLock(lock, ttlMs));
    }
    return {
      outcome: 'ok',
      text: `Locked ${wanted.join(', ')} for ${ttlMinutes} minutes. Every tool or bus call you make renews your locks; unlock when you are done.`,
    };
  }

  conflicts(topicId: string, patterns: string[], root: string, exceptChatId?: string): string[] {
    return patterns.flatMap((pattern) =>
      this.live(topicId)
        .filter((lock) => lock.chatId !== exceptChatId && this.rootOf(lock.chatId) === root && overlaps(pattern, lock.pattern))
        .map((lock) => `${pattern} overlaps ${this.describe(lock)}`),
    );
  }

  unlock(chat: Chat, paths: string[] | undefined): BusReply {
    const wanted = paths?.map((p) => normalizePattern(p) ?? p);
    const mine = this.store.chatLocks(chat.id).filter((lock) => !wanted || wanted.includes(lock.pattern));
    if (!mine.length) return { outcome: 'ok', text: 'You hold no matching locks.' };
    for (const lock of mine) this.release(lock, 'unlock');
    return { outcome: 'ok', text: `Unlocked ${mine.map((lock) => lock.pattern).join(', ')}.` };
  }

  list(chat: Chat): BusReply {
    const locks = this.live(chat.topicId);
    if (!locks.length) return { outcome: 'ok', text: 'No locks are held in your topic.' };
    return { outcome: 'ok', text: locks.map((lock) => `- ${lock.pattern}: ${lock.chatId === chat.id ? 'you' : this.describe(lock)}`).join('\n') };
  }

  holder(chat: Chat, path: string): Lock | undefined {
    const root = this.rootOf(chat.id);
    return this.live(chat.topicId).find((lock) => lock.chatId !== chat.id && this.rootOf(lock.chatId) === root && matches(lock.pattern, path));
  }

  holders(pattern: string): Array<{ holder: string; root: string }> {
    return this.store.liveLocksOn(pattern, this.clock.now()).map((lock) => ({ holder: this.describe(lock), root: this.rootOf(lock.chatId) }));
  }

  releaseChat(chatId: string, reason: LockRelease): void {
    for (const lock of this.store.chatLocks(chatId)) this.release(lock, reason);
  }

  transfer(fromChatId: string, toChatId: string): void {
    for (const lock of this.store.chatLocks(fromChatId)) {
      this.record({ type: 'lock.released', lock, reason: 'ended' });
      this.record({ type: 'lock.acquired', lock: { ...lock, chatId: toChatId } }, () => this.store.moveLock(lock.id, toChatId));
    }
  }

  expire(): Lock[] {
    const expired = this.store.expiredLocks(this.clock.now());
    for (const lock of expired) this.release(lock, 'expired');
    return expired;
  }

  describe(lock: Lock): string {
    const owner = this.store.getChat(lock.chatId);
    if (!owner) return `${lock.pattern} locked by chat ${lock.chatId.slice(0, 8)}`;
    return `${lock.pattern} locked by ${chatLabel(owner)}`;
  }

  private release(lock: Lock, reason: LockRelease): void {
    this.record({ type: 'lock.released', lock, reason }, () => this.store.deleteLock(lock.id));
  }
}

export function chatLabel(chat: Chat): string {
  return `chat ${chat.id.slice(0, 8)} (${chat.role}, ${chat.state}${chat.intent ? `; intent: ${chat.intent}` : ''})`;
}

export function ownedText(chat: Chat): string {
  return chat.ownedFiles.length ? chat.ownedFiles.join(', ') : 'none: you are read-only';
}

export function repoPath(root: string, cwd: string, path: string): string | null {
  if (!path) return null;
  const rel = relative(root, resolve(cwd, path));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.split('\\').join('/');
}

export function editsOnlyOwned(chat: Chat): chat is Chat & { parentId: string } {
  return chat.parentId !== null && chat.role !== 'worker' && chat.role !== 'main';
}

export function owns(chat: Chat, path: string): boolean {
  return chat.ownedFiles.some((pattern) => matches(normalizePattern(pattern) ?? pattern, path));
}

export function normalizePattern(path: string): string | null {
  const pattern = path.trim().replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  if (!pattern || isAbsolute(pattern) || pattern.split('/').includes('..')) return null;
  return pattern;
}

export function matches(pattern: string, path: string): boolean {
  const regex = globRegex(pattern);
  const parts = path.split('/');
  return parts.some((_, i) => regex.test(parts.slice(0, i + 1).join('/')));
}

function covered(pattern: string, owned: string[]): boolean {
  return owned.some((o) => {
    const own = normalizePattern(o) ?? o;
    return own === pattern || matches(own, pattern);
  });
}

function overlaps(a: string, b: string): boolean {
  if (!hasGlob(a) && !hasGlob(b)) return a === b || under(a, b) || under(b, a);
  if (!hasGlob(a)) return matches(b, a) || under(staticPrefix(b), a);
  if (!hasGlob(b)) return matches(a, b) || under(staticPrefix(a), b);
  const [pa, pb] = [staticPrefix(a), staticPrefix(b)];
  return !pa || !pb || pa === pb || under(pa, pb) || under(pb, pa);
}

function under(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

function hasGlob(pattern: string): boolean {
  return /[*?]/.test(pattern);
}

function staticPrefix(pattern: string): string {
  const parts = pattern.split('/');
  const first = parts.findIndex(hasGlob);
  return parts.slice(0, first === -1 ? parts.length : first).join('/');
}

function globRegex(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '*' && pattern[i + 1] === '*') {
      const slash = pattern[i + 2] === '/';
      source += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (c === '*') source += '[^/]*';
    else if (c === '?') source += '[^/]';
    else source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

const MINUTE = 60_000;
