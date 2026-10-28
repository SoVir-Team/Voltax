# @voltax/hub

The home server that runs on each Raspberry Pi. **TypeScript on Node.js 24.**

## Structure

```
hub/
├── src/
│   ├── main.ts          Process entry: HTTPS server, graceful shutdown
│   ├── hub.ts           Wires every module together (createHub)
│   ├── config.ts        Environment variables (validated with zod)
│   ├── api.ts           REST routes + WebSocket + serves the web app
│   ├── auth.ts          Pairing codes, client tokens, roles, revocation
│   ├── commands.ts      Command manager: idempotent, TTL/410, per-entity queue, confirm-by-state
│   ├── mqtt-link.ts     MQTT connection to Mosquitto, state/status ingestion
│   ├── scheduler.ts     Daily/cron schedules (croner)
│   ├── automations.ts   "When X then Y" rules on live state changes
│   ├── store.ts         Devices and entities in SQLite
│   ├── events.ts        Event log with sequence numbers (WebSocket resume, future cloud sync)
│   ├── db.ts            SQLite (WAL, synchronous=FULL), migrations with automatic backup
│   ├── healthcheck.ts   Docker health check (HTTPS to itself)
│   └── cli.ts           Installer CLI (pairing codes, clients, revoke, remove device)
├── migrations/          Forward-only SQL migrations
├── test/                Vitest: in-process MQTT broker (aedes) + temp SQLite
├── dev/dev-hub.mjs      Local dev hub with 3 simulated devices (repo root: npm run dev)
└── Dockerfile           linux/arm64 image (also builds and bundles frontend/web)
```

## Commands

```bash
npm run build
npm test
npm run dev        # from the repo root this also builds the web app first
```

Configuration: `deploy/pi/hub.env.example`. API contract: `shared/contracts/src/api.ts`.
