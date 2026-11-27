import type { PushNotification, PushTarget } from '../api/types.js';

export type { PushNotification, PushTarget };

export type Delivery = 'sent' | 'gone' | 'failed';

export interface Notifier {
  readonly publicKey: string | null;
  send(target: PushTarget, notification: PushNotification): Promise<Delivery>;
}
