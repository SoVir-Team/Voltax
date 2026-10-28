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

- [x] Migration `003_support_grants.sql`: `support_grants`, `cloud_nonces`, `commands.grant_id`
- [x] Grant service (`backend/hub/src/grants.ts`):
  - signed request intake, with role and per-action limits; devices must exist;
  - owner approve/reject/revoke API (`/api/v1/support/grants/...`);
  - cloud revoke/complete (grantee or super admin);
  - expiry sweeper, in-app start/end notices, status reported to the cloud
- [x] Envelope verifier (`backend/hub/src/envelope.ts`):
  - Ed25519 signature over the received bytes;
  - hubId;
  - trusted clock (fail-closed);
  - skew, expiry and lifetime;
  - single-use nonce
- [x] CommandManager pre-dispatch re-check; queued commands cancelled on revoke; already-published commands reported as `support.inflight`

Evidence (P2): `backend/hub/test/grants.test.ts`, 30 tests:
- full lifecycle; reject; members cannot approve; no remote approval; expiry and delayed start;
- one test per refusal: bad signature, tampered payload, other hub, expired, issued in the future,
  lifetime, malformed, unknown grant, not the grantee ×2, admin role, device not granted, action not
  granted, replay, unsynced clock, no key, missing notice;
- a duplicate commandId runs once; super admin and installer request limits;
- revocation: queued command cancelled, in-flight command reported, nothing published after revoke;
  pre-dispatch re-check;
- diagnostics allow-list; activity needs its own grant, is device-filtered and audited; audit chain intact.

`npx vitest run` in `backend/hub` → 6 files, 81 tests passed.

## P3. Hub cloud-link

- [x] `cloud-link.ts` (off unless `CLOUD_URL`), telemetry allow-list, audit export
- [x] Update request file + host path unit + root script (root side runs `voltax-update`, which checks the minisign signature before installing; the hub never holds the key or runs the updater)
- [x] Tests with in-process broker

Evidence (P3): `npm test -w backend/hub` → 7 files, 86 tests passed (2026-10-28 14:38), including
`cloud-link.test.ts`: link off by default, telemetry carries only allow-listed fields, signed envelopes
arrive on `voltax-cloud/<hubId>/down` and results go out on `/up`, the audit chain is exported once
with a persisted cursor, an owner-approved update writes `request.json`. `npm run typecheck` clean.
`bash -n` on every `deploy/pi` script clean. `npm run test:host` (new; Debian 12 container on
Docker 29.2.1) → 17 passed, 0 failed: version injection refused and not executed, garbage refused,
request consumed, same version is a no-op, downgrade refused with reason, rollout id reported back,
upgrade switches `current`, result file 10001/644, failed update reported `rolled_back` and still on
the old version. Not covered here: systemd path activation and a real signed release on a Pi
(hardware, see production gate).

## P4. Cloud core

- [x] `backend/cloud` workspace, DB adapter (pg / PGlite), migrations
- [x] Staff auth: scrypt, TOTP, sessions, bootstrap CLI
- [x] Homes, hubs, assignments; deny-by-default route guard
- [x] Matrix-generated negative tests, cross-home isolation, manipulated IDs, replay

Evidence (P4): `npm test -w backend/cloud` → 4 files, 116 tests passed (2026-10-28 14:57) on PGlite
(real Postgres SQL, plpgsql triggers, advisory locks). Real PostgreSQL 18 run is `test:pg` in P5.
- `authz-matrix.test.ts` (81): every action route x every platform role x assigned/unassigned
  home, expected result computed from `permissions.ts`; a coverage test fails if a registered route
  has no matrix entry; every non-public route is 401 without a session; forged cookies 401;
  random/malformed/injection home ids 404 for every role; a home id in body or query cannot widen
  the URL scope; support lists only assigned homes; owner contact only via the audited
  `home.contact.read`; denials audited with role and reason; a setup-only (no TOTP) session is 403
  on every action route.
- `auth.test.ts` (17): single-use setup links; password alone never opens a session; TOTP code
  replay refused; lockout after 5 failures; same answer for unknown account and wrong password;
  logout then cookie replay 401; expired and idle sessions 401; disabling kills sessions at once;
  role change applies on the next request; no self-demotion, last super admin protected;
  `bootstrap-admin` refused once an admin exists; credential reset; cross-origin POST 403 and
  `text/plain` 415; audit never contains passwords, TOTP secrets or session tokens; per-IP login
  rate limit (10/min); security headers and `no-store`.
- `homes.test.ts` (10): assignment revoke and expiry take effect immediately; super admins cannot be
  assigned; role change drops assignments; hub broker password returned once, stored as SHA-256 only,
  rotation invalidates the old one; hub ids cannot move homes; devices expose id + online only;
  audit UPDATE/DELETE/TRUNCATE refused by triggers; a trigger-bypassing edit is detected by verify.
- `crypto.test.ts` (8): TOTP matches RFC 6238 SHA-1 vectors; drift window ±1 step; AES-GCM sealed
  TOTP secrets fail with wrong key or tampering; scrypt salted; redaction; guard registration refuses
  unguarded routes, unlisted public routes, and scoped actions without a home resolver.
- `npm run typecheck` clean; `npm run build -w backend/cloud` clean; full `npm test` green
  (contracts 15, hub 86, cloud 116, web 10).

Note: npm 11.6.0 drops platform optional packages from the lockfile when it changes; the lockfile was
regenerated with npm 10.9.4 (`npx npm@10.9.4 install --package-lock-only`), then `npm ci`.

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
