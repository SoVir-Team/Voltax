# Milestone 2 loop progress

Persistent checklist for the Milestone 2 build loop (platform, support access, fleet, production
gate). Each iteration takes the next unchecked item in phase order, runs the checks, and records
evidence here.

Status values: `[x]` Done (with evidence) · `[~]` In progress · `[ ]` Not started · `[!]` Blocked.

**Done needs executed evidence:** a test name, a command and its real output. Hardware behaviour
(Raspberry Pi, ESP32, relays, real networks) is never marked Done here; it lives in
[runbooks/milestone-1-results.md](runbooks/milestone-1-results.md) and
[production-gate.md](production-gate.md).

## P0. Foundation

- [x] Progress checklist (this file)
- [x] Company name in README/SECURITY prose is VOLTEX
- [x] Permission matrix: [security/permission-matrix.md](security/permission-matrix.md) + `shared/contracts/src/permissions.ts`
- [x] Cloud protocol schemas: `shared/contracts/src/cloud.ts` (signed envelopes, grant request, hub messages, telemetry allow-list)
- [x] Threat model: [security/threat-model.md](security/threat-model.md)

Evidence (P0): `npm test -w shared/contracts` → 2 files, 15 tests passed (`permissions.test.ts`:
deny-by-default, no grant scope for super admin, device control only via grant, local-only actions,
audit read restricted, member limits, envelope and telemetry allow-list validation).

## P1. Hub authorisation

- [x] Deny-by-default route guard: `onRoute` refuses any `/api` route without a `HomeAction` guard; one `preHandler` checks the permission matrix (`backend/hub/src/api.ts`)
- [x] Member device permissions: migration `002_member_devices_audit.sql` (existing members migrated to explicit `*`), invites must name devices, `PUT /api/v1/clients/:id/devices`, REST + WebSocket filtering re-read per request/event
- [x] Hub audit log (`backend/hub/src/audit.ts`): append-only triggers, sha256 chain, redaction, `verify()`, `GET /api/v1/audit` (owner), CLI `audit-verify`; CLI actions audited as `installer-cli`
- [x] Negative tests (`backend/hub/test/authz.test.ts`, 12 tests): route enumeration, unguarded/wrongly-public route refused, no/bad/revoked token, client-claimed role ignored, ungranted device indistinguishable from missing, commands/events/schedules/automations of other devices hidden, every owner-only action 403 for members, live scope change on open WebSocket, owner scope cannot be narrowed, audit without secrets, UPDATE/DELETE refused, tampering detected

Evidence (P1): `npx vitest run` in `backend/hub` → 5 files, 51 tests passed (run twice, no unhandled
errors after adding `CommandManager.stop()` for clean shutdown); `npm run typecheck` clean.

## P2. Hub support grants

- [ ] Migration 003: `support_grants`, `cloud_nonces`
- [ ] Grant service: request intake, owner approve/reject/revoke, expiry sweeper, start/end notices
- [ ] Envelope verifier with one test per rejection reason
- [ ] CommandManager pre-dispatch re-check; cancel queued on revoke; in-flight race flagged

## P3. Hub cloud-link

- [ ] `cloud-link.ts` (off unless `CLOUD_URL`), telemetry allow-list, audit export
- [ ] Update request file + host path unit + root script re-verifying signature
- [ ] Tests with in-process broker

## P4. Cloud core

- [ ] `backend/cloud` workspace, DB adapter (pg / PGlite), migrations
- [ ] Staff auth: scrypt, TOTP, sessions, bootstrap CLI
- [ ] Homes, hubs, assignments; deny-by-default route guard
- [ ] Matrix-generated negative tests, cross-home isolation, manipulated IDs, replay

## P5. Cloud grants, audit, notifications

- [ ] Audit chain, checkpoints, verify, append-only triggers (`test:pg`)
- [ ] Grant service + command signer
- [ ] Notifications: in-app, Web Push, SMTP; failure scenarios; Mailpit check
- [ ] Audit export to S3 (MinIO check)
- [ ] End-to-end cloud + hub lifecycle test; `test:brokers` (Mosquitto + EMQX)

## P6. Fleet

- [ ] Telemetry ingestion (metadata only)
- [ ] Rollout state machine (canary, thresholds, halt, rollback)
- [ ] Firmware registry, minisign verification, compatibility checks

## P7. Web apps (PWAs)

- [ ] Admin portal (`frontend/admin`): all screens, PWA, Web Push
- [ ] Customer app: support access, member devices, promote/demote, push opt-in, update approval, dark theme, search/rooms
- [ ] Hub fixes: reference validation, optimistic concurrency, revert-timer cancel, `.gitignore` device secrets
- [ ] Browser verification of every screen

## P8. Quality

- [ ] ESLint, `npm audit --omit=dev`, CI jobs
- [ ] Security review and fixes

## P9. Load test

- [ ] Spec with thresholds committed before the run
- [ ] Simulator
- [ ] 60-minute run, results committed

## P10. Deploy and report

- [ ] `deploy/cloud` stack run locally + smoke test; hub image build
- [ ] Runbooks (cloud deploy, hub cloud-link enablement)
- [ ] [production-gate.md](production-gate.md)
- [ ] Implementation report

## Workflows and skills

| Workflow | Status | Used for |
|---|---|---|
| superpowers | used | test-driven development, verification before completion |
| ponytail | used | smallest complete change |
| ECC (`D:\workspace\repos\ecc`) | planned | `security-reviewer`, `tdd-guide`, `database-reviewer` checklists |
| Agentic Awesome Skills | planned | `auth-implementation-patterns`, `audit-logging`, `api-security-testing` |
| find-skills | planned | start of each phase |
| REA (MCP) | planned | SQLite audit inspection where it adds evidence |
| Ruflo | **unavailable** | MCP tools not loaded in this session; repo used as a playbook only |
