# Contributing

## Setup

Node.js 24 (see `.nvmrc`) and npm. From the repository root:

```bash
npm install
npm run dev        # builds the web app, starts a dev hub + 3 simulated devices on http://localhost:8080
```

The dev hub prints a one-time owner pairing code. For hot reload while editing the UI, keep
`npm run dev` running and start `npm run dev:web` in a second terminal (http://localhost:3000).

## Before you push

```bash
npm run typecheck
npm test
```

CI runs the same checks plus the web build and `bash -n` on every shell script.

## Conventions

- **Branches:** `feat/...`, `fix/...`, `docs/...`, `chore/...` off `main`; merge through a pull request.
- **Commits:** imperative subject line under 72 characters ("Add schedule editing"), body explains why.
- **API changes** start in `shared/contracts`, so the hub and the web app stay in sync.
- **Database changes** are new forward-only files in `backend/hub/migrations/`; never edit an applied one.
- **Device state:** the UI shows only what a device reported, never what was requested.
- **Hardware:** never mark a Pi/ESP32 test as passed unless it was run on real hardware and the output
  is recorded in `docs/runbooks/milestone-1-results.md`.
- **Secrets:** see [SECURITY.md](SECURITY.md).

## Where things go

See the layout in [README.md](README.md). Architecture decisions are recorded in
[docs/adr/](docs/adr/); add a new numbered ADR for any decision that is hard to reverse.
