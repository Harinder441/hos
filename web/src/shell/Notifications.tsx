import { useEffect, useState } from 'react';
import type { PushStatus } from '../../../src/api/types.js';
import { client, plural, surface, useAction } from '../lib.js';

type PushTarget = Parameters<typeof client.subscribePush>[0];

export function Notifications({ details = false }: { details?: boolean }) {
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const [endpoint, setEndpoint] = useState<string | null>();
  const [status, setStatus] = useState<PushStatus>();
  const [permission, setPermission] = useState(supported ? Notification.permission : 'default');
  const [note, setNote] = useState<string>();
  const { error, busy, run } = useAction();
  const refresh = () => client.pushStatus().then(setStatus, () => setStatus((had) => had ?? { publicKey: null, devices: [], kinds: [] }));
  useEffect(() => {
    if (!supported) return;
    void refresh();
    void navigator.serviceWorker
      .getRegistration()
      .then((registration) => registration?.pushManager.getSubscription() ?? null)
      .then(
        (subscription) => setEndpoint(subscription?.endpoint ?? null),
        () => setEndpoint(null),
      );
  }, []);
  if (!supported) {
    return (
      <p className="home-notify" aria-label="Notifications" role="group">
        {/iPhone|iPad/.test(navigator.userAgent)
          ? 'For notifications, add hos to the Home Screen (Share → Add to Home Screen), open it from there and turn them on here.'
          : 'This browser can’t receive hos notifications.'}
      </p>
    );
  }
  const turnOn = () =>
    run(async () => {
      const asked = await Notification.requestPermission();
      setPermission(asked);
      if (asked !== 'granted') throw new Error(blockedText());
      const { publicKey } = await client.pushStatus();
      if (!publicKey) throw new Error('Push isn’t set up on the hos daemon.');
      await navigator.serviceWorker.register('/sw.js');
      const registration = await navigator.serviceWorker.ready;
      const key = base64Url(publicKey);
      let subscription = await registration.pushManager.getSubscription();
      if (subscription && !sameKey(subscription.options.applicationServerKey, key)) {
        await subscription.unsubscribe();
        subscription = null;
      }
      subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      await client.subscribePush(subscription.toJSON() as PushTarget, deviceLabel());
      setEndpoint(subscription.endpoint);
      await refresh();
    });
  const turnOff = () =>
    run(async () => {
      const subscription = await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription();
      await subscription?.unsubscribe();
      if (endpoint) await client.unsubscribePush(endpoint);
      setEndpoint(null);
      await refresh();
    });
  const remove = (other: string) =>
    run(async () => {
      await client.unsubscribePush(other);
      await refresh();
    });
  const test = () =>
    run(async () => {
      const result = await client.testPush();
      setNote(`Sent to ${plural(result.sent, 'device')}${result.gone ? `, ${result.gone} gone` : ''}${result.failed ? `, ${result.failed} failed` : ''}.`);
      await refresh();
    });
  if (endpoint === undefined || !status) return null;
  const known = endpoint ? status.devices.find((d) => d.endpoint === endpoint) : undefined;
  const state = known
    ? `Notifications are on for this device (${known.label}).`
    : permission === 'denied'
      ? blockedText()
      : endpoint
        ? 'This browser is subscribed, but hos no longer has it on its list, so nothing reaches it. Turn it on again.'
        : `Notifications are off for this device (${deviceLabel()}).`;
  return (
    <>
      <div className="home-notify" aria-label="Notifications" role="group">
        <span>{state}</span>
        {known ? (
          <>
            <button type="button" className="btn quiet" disabled={busy} onClick={test}>
              Send a test
            </button>
            <button type="button" className="btn quiet" disabled={busy} onClick={turnOff}>
              Turn off
            </button>
          </>
        ) : (
          <button type="button" className="btn" disabled={busy} onClick={turnOn}>
            Turn on notifications for this device
          </button>
        )}
        {note && <span role="status">{note}</span>}
        {error && <p className="error-text">{error}</p>}
      </div>
      {details && (
        <div className="notify-details">
          <h3>Devices getting notifications</h3>
          {status.devices.length === 0 ? (
            <p className="muted">No device is subscribed yet.</p>
          ) : (
            <ul className="notify-list" aria-label="Devices getting notifications">
              {status.devices.map((device) => (
                <li key={device.endpoint} aria-label={device.label}>
                  <span>
                    {device.label}
                    {device.endpoint === endpoint && <span className="tag">this device</span>}
                  </span>
                  <span className="muted">since {new Date(device.createdAt).toLocaleDateString()}</span>
                  {device.endpoint !== endpoint && (
                    <button type="button" className="btn quiet" disabled={busy} onClick={() => remove(device.endpoint)}>
                      Remove
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <h3>What hos notifies about</h3>
          <p className="muted">No pushes while hos is open and focused (60 s).</p>
          <ul className="notify-list" aria-label="Notification kinds">
            {status.kinds.map((kind) => (
              <li key={kind.kind} aria-label={kind.title}>
                <strong>{kind.title}</strong>
                <span className="tag">{kind.push ? 'push' : 'Inbox only'}</span>
                <span className="muted">when {kind.when}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function browserName(): string {
  const agent = navigator.userAgent;
  if (/Edg\//.test(agent)) return 'Edge';
  if (/Firefox\//.test(agent)) return 'Firefox';
  if (/Chrome\/|CriOS\//.test(agent)) return 'Chrome';
  if (/Safari\//.test(agent)) return 'Safari';
  return 'Browser';
}

function deviceLabel(): string {
  return `${browserName()} · ${surface() === 'phone' ? 'phone' : 'Mac'}`;
}

function blockedText(): string {
  const browser = browserName();
  const unblock =
    browser === 'Chrome' || browser === 'Edge'
      ? 'click the icon left of the address, open Site settings and set Notifications to Allow, then reload'
      : 'allow notifications for this site in the browser’s settings, then reload';
  return `Notifications are blocked for hos in ${browser}: ${unblock}. On a Mac, also check System Settings → Notifications → ${browser === 'Chrome' ? 'Google Chrome' : browser}.`;
}

function sameKey(current: ArrayBuffer | null, wanted: Uint8Array): boolean {
  if (!current) return false;
  const bytes = new Uint8Array(current);
  return bytes.length === wanted.length && bytes.every((b, i) => b === wanted[i]);
}

function base64Url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
