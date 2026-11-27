self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

const RESTARTING = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>hos is restarting</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; display: grid; place-items: center; min-height: 100vh; margin: 0; }
  main { text-align: center; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { margin: 0; opacity: 0.7; }
</style>
<main role="status">
  <h1>hos is restarting</h1>
  <p>Checking every 5 seconds; this page reloads when hos is back.</p>
</main>
<script>
  setInterval(() => {
    fetch('/api/doctor', { cache: 'no-store' }).then((res) => res.ok && location.reload(), () => {});
  }, 5000);
</script>
</html>`;

const restarting = () => new Response(RESTARTING, { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });

self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(
    fetch(event.request).then(
      (res) => (res.status === 502 || res.status === 503 || res.status === 504 ? restarting() : res),
      () => restarting(),
    ),
  );
});

self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : { title: 'hos', body: '', url: '/#/', tag: 'hos' };
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: data.tag,
      data: { url: data.url },
      icon: '/icon-192.png',
      badge: '/icon-192.png',
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url ?? '/#/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (windows) => {
      const mine = windows.filter((w) => new URL(w.url).origin === self.location.origin);
      const open = mine.find((w) => w.focused) ?? mine.find((w) => w.visibilityState === 'visible') ?? mine[0];
      if (!open) return self.clients.openWindow(url);
      await open.focus();
      open.postMessage({ type: 'open', url });
    }),
  );
});
