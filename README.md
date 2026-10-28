# VOLTEX Home Automation

Local-first smart home platform by SoVir Technologies. Each home has a Raspberry Pi hub that runs
everything locally (works with the internet down); ESP32 switches talk to it over MQTT. The cloud
(later milestones) only adds remote access and fleet management.

## Repository layout

```
.
├── backend/
│   └── hub/                  Pi home server: REST + WebSocket API, MQTT, SQLite, schedules, automations
│       ├── src/              TypeScript source (one module per concern: api, commands, auth, scheduler, ...)
│       ├── test/             Vitest tests (in-process MQTT broker, temp SQLite)
│       ├── migrations/       Forward-only SQL migrations
│       ├── dev/              Local dev hub with simulated devices (npm run dev)
│       └── Dockerfile        linux/arm64 image for the Pi
├── frontend/
│   └── hub-ui/               Web app + PWA served by the hub itself (see frontend/README.md)
├── shared/
│   └── contracts/            API schemas (zod) and MQTT topic helpers shared by backend and frontend
├── deploy/
│   └── pi/                   Pi provisioning, Docker Compose, Mosquitto, systemd, update/rollback, TLS, tests
└── package.json              npm workspaces root
```

Planned (not built yet): `firmware/esphome/` (ESP32 firmware), `frontend/app/` (customer app,
Next.js + TypeScript), `backend/cloud/` (cloud API), `docs/` (architecture and runbooks),
`.github/workflows/` (CI and signed releases).

## Languages

| Part | Language / tech |
|---|---|
| Hub backend | TypeScript on Node.js 24 (Fastify, mqtt.js, better-sqlite3, zod) |
| Shared contracts | TypeScript |
| Hub web UI | HTML, CSS, JavaScript (ES modules, no build step) |
| Pi deployment | Bash, Docker Compose (YAML), systemd units |
| ESP32 firmware | ESPHome (YAML) |

## Develop

```bash
npm install
npm run typecheck
npm test
npm run dev -w backend/hub   # hub + simulated devices on http://localhost:8080
```
