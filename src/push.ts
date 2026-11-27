import type { Clock } from './adapters/clock.js';
import type { Notifier } from './adapters/notifier.js';
import type { HosEvent, InboxItem, InboxKind, PushDevice, PushKind, PushNotification, PushStatus, PushTarget, PushTestResult } from './api/types.js';
import { HosError } from './core.js';
import { SCHEDULED_RUN_FINISHED } from './schedules.js';
import type { Store } from './store.js';

const TITLES: Record<InboxKind, string> = {
  approval: 'Approval needed',
  question: 'Question',
  completion: 'Chat finished',
  failure: 'Chat failed',
  alert: 'hos alert',
  keeper: 'hos keeper',
  plan: 'Plan to review',
};
const KINDS: PushKind[] = [
  { kind: 'approval', title: TITLES.approval, when: 'a chat asks before running a tool', push: true },
  { kind: 'question', title: TITLES.question, when: 'a chat asks you something', push: true },
  { kind: 'plan', title: TITLES.plan, when: 'a chat proposes a plan', push: true },
  { kind: 'completion', title: TITLES.completion, when: 'a chat with its bell on, or a scheduled run, finishes its turn', push: true },
  { kind: 'failure', title: TITLES.failure, when: 'a chat fails', push: true },
  { kind: 'alert', title: TITLES.alert, when: 'hos flags a problem, such as a ping-pong between chats or paused batch work', push: false },
  { kind: 'keeper', title: TITLES.keeper, when: 'hos restarted after a crash or the battery is critical; other keeper reports stay in the Inbox', push: true },
  { kind: 'test', title: 'hos', when: 'you press Send a test', push: true },
];
const PUSHED_TITLES: Partial<Record<InboxKind, string[]>> = {
  alert: [],
  keeper: ['hos restarted after a crash', 'Battery critical'],
};
const MUTE_MS = 60_000;
const HOME_URL = '/#/';
const LABEL_CHARS = 40;
const EXCERPT_CHARS = 120;
const SECRET_SHAPED = /[A-Za-z0-9_\-+/=.]{20,}|\b(?:sk|pk|rk|ghp|gho|ghs|xox[abp]|AKIA)[-_A-Za-z0-9]*/g;

export class Push {
  private readonly activeClients = new Set<object>();
  private lastActiveAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly store: Store,
    private readonly notifier: Notifier,
    private readonly clock: Clock,
    private readonly muteMs = MUTE_MS,
  ) {}

  status(): PushStatus {
    return {
      publicKey: this.notifier.publicKey,
      devices: this.store.pushSubscriptions().map(({ endpoint, label, createdAt }) => ({ endpoint, label, createdAt })),
      kinds: KINDS,
    };
  }

  subscribe(target: PushTarget, label: string): PushDevice {
    if (!this.notifier.publicKey) throw new HosError(503, 'push is not set up on this daemon');
    this.store.savePushSubscription(target, label, this.clock.now());
    return this.status().devices.find((d) => d.endpoint === target.endpoint)!;
  }

  unsubscribe(endpoint: string): void {
    this.store.deletePushSubscription(endpoint);
  }

  test(): Promise<PushTestResult> {
    return this.broadcast({ title: 'hos', body: 'Test notification', url: HOME_URL, tag: 'test' });
  }

  presence(client: object, active: boolean): void {
    if (active || this.activeClients.has(client)) this.lastActiveAt = this.clock.now();
    if (active) this.activeClients.add(client);
    else this.activeClients.delete(client);
  }

  onEvent(event: HosEvent): void {
    if (this.clock.now() - this.lastActiveAt < this.muteMs) return;
    const notification = this.notificationFor(event);
    if (notification) void this.broadcast(notification).catch((error) => console.error('push failed', error));
  }

  private notificationFor(event: HosEvent): PushNotification | null {
    if (event.type === 'approval.requested') {
      return this.notification('approval', event.approvalId, event.chatId, event.topicId, event.actionClass ?? 'unclassified');
    }
    if (event.type !== 'inbox.added' || !pushes(event.item.kind, event.item.title)) return null;
    if (event.item.kind === 'completion' && event.item.title !== SCHEDULED_RUN_FINISHED) return this.finished(event.item);
    if (event.item.kind === 'keeper') {
      return { title: TITLES.keeper, body: event.item.title, url: HOME_URL, tag: event.item.id };
    }
    return this.notification(event.item.kind, event.item.id, event.item.chatId, event.item.topicId);
  }

  private finished(item: InboxItem): PushNotification | null {
    const chat = item.chatId ? this.store.getChat(item.chatId) : undefined;
    if (!chat?.notify) return null;
    const topic = this.store.getTopic(chat.topicId);
    const label = chat.title ?? `${topic?.title ?? 'topic'} · Chat ${this.store.chatsInTopic(chat.topicId).findIndex((c) => c.id === chat.id) + 1}`;
    const line = item.detail.split('\n').find((l) => l.trim()) ?? TITLES.completion;
    return { title: safeLabel(label), body: safeLabel(line, EXCERPT_CHARS), url: `/#/chat/${encodeURIComponent(chat.id)}`, tag: item.id };
  }

  private notification(kind: InboxKind, tag: string, chatId: string | null, topicId?: string, actionClass?: string): PushNotification {
    const chat = chatId ? this.store.getChat(chatId) : undefined;
    const topic = this.store.getTopic(chat?.topicId ?? topicId ?? '');
    const chatLabel = chat ? `Chat ${this.store.chatsInTopic(chat.topicId).findIndex((c) => c.id === chat.id) + 1}` : 'diff';
    const parts = [safeLabel(topic?.title ?? 'topic'), chatLabel, ...(actionClass ? [actionClass] : [])];
    const url = chat ? `/#/chat/${encodeURIComponent(chat.id)}` : topic ? `/#/topic/${encodeURIComponent(topic.id)}` : HOME_URL;
    return { title: TITLES[kind], body: parts.join(' · '), url, tag };
  }

  private async broadcast(notification: PushNotification): Promise<PushTestResult> {
    const result: PushTestResult = { sent: 0, gone: 0, failed: 0 };
    await Promise.all(
      this.store.pushSubscriptions().map(async (target) => {
        const delivery = await this.notifier.send(target, notification).catch(() => 'failed' as const);
        result[delivery] += 1;
        if (delivery === 'gone') this.store.deletePushSubscription(target.endpoint);
      }),
    );
    return result;
  }
}

function pushes(kind: InboxKind, title: string): boolean {
  return kind !== 'approval' && (PUSHED_TITLES[kind]?.includes(title) ?? true);
}

function safeLabel(text: string, chars = LABEL_CHARS): string {
  const cleaned = text.replace(SECRET_SHAPED, '…').replace(/\s+/g, ' ').trim();
  return cleaned.length > chars ? `${cleaned.slice(0, chars - 1)}…` : cleaned;
}
