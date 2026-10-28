# Frontend

| Folder | What it is | Tech | Status |
|---|---|---|---|
| `hub-ui/` | Web app + PWA served **by the Pi hub itself**, used on the home network | HTML, CSS, JavaScript (ES modules), no build step | Built (Milestone 1) |
| `app/` | Customer app: same screens, plus remote access through the cloud | Next.js + TypeScript, wrapped with Capacitor for Android/iOS | Planned (Milestone 3) |

## `hub-ui/` structure

```
hub-ui/
├── index.html              App shell (top bar, view outlet, tab bar)
├── manifest.webmanifest    PWA manifest (name, icons, shortcuts)
├── sw.js                   Service worker: caches the app shell, never caches /api/
├── css/
│   └── styles.css          Design tokens + all styles (white theme, Apple-style)
├── assets/
│   ├── brand/              VOLTEX logos (SVG)
│   └── icons/              PWA / home-screen icons (PNG)
└── js/
    ├── main.js             Entry point: boot, PWA, router
    ├── router.js           Hash routes -> views; live re-render rules
    ├── pwa.js              Install card + service worker registration
    ├── core/               No UI: state.js, api.js (REST client), dom.js (safe h() helper, icons, toast), format.js (12-hour time, names)
    ├── services/           live.js (WebSocket, commands, refresh), session.js (pair / sign out)
    ├── components/         Shared controls: switch, 12-hour time picker, device picker
    └── views/              One file per screen: pair, home, device, schedules, automations, access, hub
```

Rules:
- The UI shows only the state a device **reported**, never the state it asked for.
- Build DOM with `h()` from `core/dom.js`; never put data into `innerHTML`.
- When you add or rename a file, add it to `SHELL` in `sw.js` and bump `CACHE`, or installed apps won't work offline.
- Try it locally: `npm run dev -w backend/hub`, then open http://localhost:8080.
