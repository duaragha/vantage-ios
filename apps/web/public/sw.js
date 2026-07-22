/* global self, URL */

/* Vantage Web Push service worker. Deliberately no asset caching: the hosted
 * app should always load the newest Railway deployment. */

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : '' };
  }

  const title = typeof payload.title === 'string' ? payload.title : 'Vantage';
  const body =
    typeof payload.body === 'string' && payload.body.length > 0
      ? payload.body
      : 'A new Vantage insight is ready.';
  const url =
    typeof payload.url === 'string' && payload.url.startsWith('/') ? payload.url : '/insights';
  const tag = typeof payload.tag === 'string' ? payload.tag : undefined;

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/icon-512.png',
      badge: '/icon-512.png',
      tag,
      renotify: Boolean(tag),
      data: { url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetPath = event.notification.data?.url ?? '/insights';
  const targetUrl = new URL(targetPath, self.location.origin).href;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) {
          if ('navigate' in client) {
            return client.navigate(targetUrl).then(() => client.focus());
          }
          return client.focus();
        }
      }
      return self.clients.openWindow ? self.clients.openWindow(targetUrl) : undefined;
    }),
  );
});
