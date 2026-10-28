// VOLTEX service worker. Generated into out/sw.js by scripts/postbuild.mjs at build time.
// - App shell (every built file): precached, so the app opens instantly and works offline.
// - API (/api/...): NEVER cached. Device state must always be live from the hub,
//   so the app can never show a stale "on" for a light that is off.
const CACHE = '__CACHE__'; // content hash of the build: a new build replaces the old cache
const SHELL = [/* __SHELL__ */];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // network only

  if (event.request.mode === 'navigate') {
    // Network first so updates show up; offline, serve the cached page (ignoring ?id=...).
    event.respondWith(
      fetch(event.request).catch(async () => (await caches.match(event.request, { ignoreSearch: true })) ?? caches.match('/')),
    );
    return;
  }

  // Static files: serve from cache immediately, refresh in the background.
  // ignoreSearch: Next.js adds ?_rsc=... to the same static payload files.
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(event.request, { ignoreSearch: true });
      const fresh = fetch(event.request)
        .then((res) => {
          if (res.ok) cache.put(event.request, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached ?? fresh;
    }),
  );
});

// Notifications from the hub (support access, offline devices, update offers). The payload is
// plain text the hub chose; tapping it opens the matching screen of this app.
self.addEventListener('push', (event) => {
  let msg = { title: 'VOLTEX', body: '', url: '/' };
  try {
    msg = { ...msg, ...event.data.json() };
  } catch {
    /* not JSON: keep the default */
  }
  event.waitUntil(self.registration.showNotification(msg.title, { body: msg.body, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', data: { url: msg.url } }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url ?? '/', location.origin);
  if (url.origin !== location.origin) return; // only ever open this app
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      const open = wins.find((w) => new URL(w.url).origin === location.origin);
      return open ? open.navigate(url.href).then((w) => w?.focus()) : self.clients.openWindow(url.href);
    }),
  );
});
