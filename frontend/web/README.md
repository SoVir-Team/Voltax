# @voltax/web

The VOLTEX web app + PWA. **Next.js 16 (App Router) + TypeScript + React 19**, built as a static
export (`out/`) that the hub serves itself, so it loads on the home network with no internet.
Why: [ADR 0002](../../docs/adr/0002-web-app-nextjs-static-export.md).

## Structure

```
web/
├── public/                   Static files copied as-is
│   ├── manifest.webmanifest  PWA manifest
│   ├── brand/                Logos (SVG)
│   └── icons/                App and home-screen icons
├── scripts/
│   ├── sw.template.js        Service worker source (app shell cached, /api never cached)
│   └── postbuild.mjs         After `next build`: writes out/sw.js, maps prefetch files
└── src/
    ├── app/                  Routes only (thin): /, /device/?id=, /schedules/, /automations/, /access/, /hub/
    │   ├── layout.tsx        <html>, metadata, providers, app shell
    │   └── globals.css       Design tokens + styles (white theme, Apple-style)
    ├── features/             One folder per feature; screens and their parts
    │   ├── pairing/          PairScreen
    │   ├── devices/          HomeScreen, DeviceScreen, DeviceTile, PowerSwitch, RenameForm
    │   ├── schedules/        SchedulesScreen, ScheduleList (+ form)
    │   ├── automations/      AutomationsScreen (+ form)
    │   ├── access/           AccessScreen: members, invites, revoke
    │   └── hub/              HubScreen: health, add-device help, sign out
    ├── components/           Shared UI: AppShell (top bar + tab bar), Icon, TimePicker12, EntitySelect, InstallCard
    ├── providers/            React context: HubProvider (session, live WebSocket, commands), Toast, Pwa
    └── lib/                  No React: api.ts (REST client), format.ts (12-hour time, names), types.ts, uuid.ts
```

Rules:
- Show only the state a device **reported**; a command just marks the switch as pending.
- Hub API types come from `@voltax/contracts`; never redefine them here.
- No server features (SSR, API routes, middleware): the output must stay plain static files.

## Commands

```bash
npm run build      # next build + postbuild -> out/
npm run dev        # next dev on :3000 with hot reload; needs the dev hub (repo root: npm run dev)
npm run typecheck
npm test           # Vitest (lib/)
```
