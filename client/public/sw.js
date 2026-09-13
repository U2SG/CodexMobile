/* CodexMobile Service Worker — Web Push only.
 * Vanilla JS, served as-is at /sw.js (no bundling).
 */

self.addEventListener('install', (event) => {
  // Activate the new SW as soon as installation finishes so that
  // push subscriptions stay tied to a live worker.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Take control of any already-open pages immediately.
  event.waitUntil(self.clients.claim());
});

function parsePayload(event) {
  if (!event.data) return {};
  try {
    return event.data.json();
  } catch (_) {
    try {
      return { body: event.data.text() };
    } catch (__) {
      return {};
    }
  }
}

self.addEventListener('push', (event) => {
  const payload = parsePayload(event) || {};
  const title = payload.title || 'CodexMobile';
  const options = {
    body: payload.body || '',
    icon: payload.icon || '/codex-icon-192.png',
    badge: payload.badge || '/codex-icon-192.png',
    tag: payload.tag || undefined,
    data: {
      url: payload.url || '/',
      level: payload.level || 'info'
    }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true
      });
      // Try to focus an already-open window that shares our origin.
      for (const client of allClients) {
        try {
          const clientUrl = new URL(client.url);
          if (clientUrl.origin === self.location.origin) {
            await client.focus();
            // Best-effort: navigate the focused tab to the target path.
            if ('navigate' in client && targetUrl) {
              try {
                await client.navigate(targetUrl);
              } catch (_) {
                /* navigation can fail across cross-document boundaries; ignore */
              }
            }
            return;
          }
        } catch (_) {
          /* malformed client.url — skip */
        }
      }
      if (self.clients.openWindow) {
        await self.clients.openWindow(targetUrl);
      }
    })()
  );
});

self.addEventListener('pushsubscriptionchange', (event) => {
  // Best-effort re-subscribe and re-register with the backend.
  event.waitUntil(
    (async () => {
      try {
        const oldEndpoint =
          (event.oldSubscription && event.oldSubscription.endpoint) || null;
        const applicationServerKey =
          (event.oldSubscription &&
            event.oldSubscription.options &&
            event.oldSubscription.options.applicationServerKey) ||
          undefined;

        if (!applicationServerKey) {
          // Without the original key we cannot resubscribe silently.
          return;
        }

        const fresh = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey
        });

        await fetch('/api/notifications/subscribe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(fresh.toJSON())
        }).catch(() => {});

        if (oldEndpoint) {
          await fetch('/api/notifications/unsubscribe', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ endpoint: oldEndpoint })
          }).catch(() => {});
        }
      } catch (_) {
        // Silent re-subscribe is best-effort — the UI can recover on next visit.
      }
    })()
  );
});
