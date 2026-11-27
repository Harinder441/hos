import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import webpush from 'web-push';
import type { Delivery, Notifier, PushNotification, PushTarget } from './notifier.js';

const TTL_SECONDS = 24 * 60 * 60;
const SEND_TIMEOUT_MS = 15_000;

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export class WebPushNotifier implements Notifier {
  readonly publicKey: string;
  private readonly privateKey: string;

  constructor(
    keyFile: string,
    private readonly subject: () => Promise<string>,
  ) {
    const keys = loadOrCreateKeys(keyFile);
    this.publicKey = keys.publicKey;
    this.privateKey = keys.privateKey;
  }

  async send(target: PushTarget, notification: PushNotification): Promise<Delivery> {
    const request = webpush.generateRequestDetails(target, JSON.stringify(notification), {
      vapidDetails: { subject: await this.subject(), publicKey: this.publicKey, privateKey: this.privateKey },
      TTL: TTL_SECONDS,
      urgency: 'high',
    });
    const response = await fetch(request.endpoint, {
      method: request.method,
      headers: request.headers,
      body: new Uint8Array(request.body),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (response.status === 404 || response.status === 410) return 'gone';
    if (!response.ok) {
      console.error(`push to ${new URL(request.endpoint).host} failed: ${response.status} ${(await response.text()).slice(0, 200)}`);
      return 'failed';
    }
    return 'sent';
  }
}

function loadOrCreateKeys(file: string): VapidKeys {
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as VapidKeys;
  const keys = webpush.generateVAPIDKeys();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(keys), { mode: 0o600 });
  return keys;
}
