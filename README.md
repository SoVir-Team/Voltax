# VOLTEX Home Automation

Local-first smart home platform by VOLTEX. Each home has a Raspberry Pi hub that runs
everything locally and keeps working with the internet down. ESP32 switches talk to it over MQTT.
The cloud (later milestones) adds remote access and fleet management.

[![CI](https://github.com/SoVir-Team/Voltax/actions/workflows/ci.yml/badge.svg)](https://github.com/SoVir-Team/Voltax/actions/workflows/ci.yml)

## Repository layout

```
.
├── frontend/
│   └── web/                  Web app + PWA: Next.js + TypeScript, static export served by the hub
├── backend/
│   └── hub/                  Pi home server: REST + WebSocket API, MQTT, SQLite, schedules, automations
├── shared/
│   └── contracts/            API schemas (zod), types and MQTT topics shared by backend and frontend
├── firmware/
│   └── esphome/              ESP32 device firmware (ESPHome)
├── deploy/
│   └── pi/                   Pi provisioning, Docker Compose, Mosquitto, systemd, updates, TLS, tests
├── docs/
│   ├── architecture.md       How it fits together
│   ├── adr/                  Architecture Decision Records
│   └── runbooks/             Setup, update/rollback, recovery, acceptance results
├── .github/                  CI workflow, pull request template
├── package.json              npm workspaces root
├── CONTRIBUTING.md
└── SECURITY.md
```

Planned: `backend/cloud/` (cloud API, Milestone 2/4) and the Capacitor Android/iOS wrapper for
`frontend/web` (Milestone 3).

## Tech stack

| Part | Language / tech |
|---|---|
| Web app (`frontend/web`) | **TypeScript, Next.js 16 (App Router), React 19**, CSS; PWA with a service worker |
| Hub (`backend/hub`) | **TypeScript**, Node.js 24, Fastify, mqtt.js, better-sqlite3, croner, zod |
| Shared contracts | TypeScript, zod |
| Devices | ESPHome (YAML) on ESP32 |
| Pi deployment | Docker Compose, Mosquitto, systemd, Bash |
| Tests | Vitest (in-process MQTT broker, temp SQLite) |

## Quick start

```bash
npm install
npm run dev          # http://localhost:8080 : dev hub + 3 simulated devices + the web app
npm run typecheck
npm test
```

`npm run dev` prints a one-time pairing code. More in [CONTRIBUTING.md](CONTRIBUTING.md);
installing a real hub: [docs/runbooks/pi-setup.md](docs/runbooks/pi-setup.md).

## Status

Milestone 1 software is built and tested on a PC. **No Raspberry Pi or ESP32 test has been run yet**:
see [docs/runbooks/milestone-1-results.md](docs/runbooks/milestone-1-results.md).
