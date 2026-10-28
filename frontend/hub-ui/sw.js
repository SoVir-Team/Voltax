// VOLTEX service worker.
// - App shell: cached, so the app opens instantly and works offline.
// - API (/api/...): NEVER cached. Device state must always be live from the hub,
//   so the app can never show a stale "on" for a light that is off.
const CACHE = 'voltax-shell-v3'; // bump on every UI release so installed apps refresh
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'logo.svg',
  'logo-wordmark.svg',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
  'apple-touch-icon.png',
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
