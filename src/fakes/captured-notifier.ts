import type { Delivery, Notifier, PushNotification, PushTarget } from '../adapters/notifier.js';

export class CapturedNotifier implements Notifier {
  readonly publicKey = 'BFakeVapidPublicKeyForTests';
  readonly sent: Array<{ endpoint: string; notification: PushNotification }> = [];
  readonly gone = new Set<string>();

  async send(target: PushTarget, notification: PushNotification): Promise<Delivery> {
    if (this.gone.has(target.endpoint)) return 'gone';
    this.sent.push({ endpoint: target.endpoint, notification });
    return 'sent';
  }
}
