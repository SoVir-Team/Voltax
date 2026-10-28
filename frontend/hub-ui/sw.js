// VOLTEX service worker.
// - App shell: cached, so the app opens instantly and works offline.
// - API (/api/...): NEVER cached. Device state must always be live from the hub,
//   so the app can never show a stale "on" for a light that is off.
const CACHE = 'voltax-shell-v4'; // bump on every UI release so installed apps refresh
// Every file the app needs to open offline. Add new files here (see README.md).
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/styles.css',
  'js/main.js',
  'js/router.js',
  'js/pwa.js',
  'js/core/api.js',
  'js/core/dom.js',
  'js/core/format.js',
  'js/core/state.js',
  'js/services/live.js',
  'js/services/session.js',
  'js/components/controls.js',
  'js/views/access.js',
  'js/views/automations.js',
  'js/views/device.js',
  'js/views/home.js',
  'js/views/hub.js',
  'js/views/pair.js',
  'js/views/schedules.js',
  'assets/brand/logo.svg',
  'assets/brand/logo-wordmark.svg',
  'assets/icons/icon-192.png',
  'assets/icons/icon-512.png',
  'assets/icons/icon-maskable-512.png',
  'assets/icons/apple-touch-icon.png',
];

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
    // Network first so updates show up; fall back to the cached shell offline.
    event.respondWith(fetch(event.request).catch(() => caches.match('index.html')));
    return;
  }

  // Static files: serve from cache immediately, refresh in the background.
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(event.request);
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
