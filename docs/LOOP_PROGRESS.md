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

- [x] Audit chain, checkpoints, verify, append-only triggers, DB roles (`test:pg`)
- [x] Grant service + command signer (cloud mirror of hub grants, checks before signing, sweeps)
- [x] Notifications: in-app, Web Push, SMTP; failure scenarios; real SMTP check (Mailpit)
- [x] Audit export to S3 with Object Lock; offline `verify-export` (real S3-compatible server; see note on MinIO)
- [x] End-to-end cloud + hub lifecycle test; `test:brokers` (native Mosquitto + EMQX container)
- [x] Config/startup wiring for broker, broker-auth API, SMTP, VAPID, S3, audit key; CLI (`migrate`, `audit-verify`, `audit-export`, `audit-bucket-create`, `verify-export`, `gen-audit-key`, `gen-vapid-keys`)
- [x] Docs: [security/audit-threat-model.md](security/audit-threat-model.md), [security/data-classification.md](security/data-classification.md); retention sweep for sessions and setup links

Evidence (P5), 2026-10-28 16:12:
- `npm test` → contracts 15, hub 86, cloud 243 passed + 11 skipped (the skipped ones need real
  PostgreSQL or Docker services and run in the suites below), web 10. `npm run typecheck` clean,
  `npm run build` clean, `npm audit --omit=dev` → 0 vulnerabilities.
- `npm run test:pg` (throwaway PostgreSQL **18.6** cluster: temp dir, own port, 127.0.0.1, trust,
  deleted afterwards) → 11 files, **250 passed**, 4 skipped (Docker-only). Includes
  `pg-roles.test.ts`: the app role can append but cannot UPDATE/DELETE/TRUNCATE or disable
  triggers on `audit_log`, `hub_audit`, `audit_checkpoints`; even the owner hits the triggers; the
  reader role reads audit tables only; 200 concurrent appends over 12 connections keep one chain;
  the whole cloud runs as `voltax_app` with migrations off. `cli.test.ts` on PG: `migrate` refused
  for the app role and applied as owner, `bootstrap-admin` once only, `audit-verify` ok.
- Race found by `test:pg` and fixed: a grant could read as ended while its waiting commands were
  still `sent`. Status change and failing of waiting commands are now one transaction with the
  grant row locked (`FOR UPDATE`), so a sweep and a hub message cannot end a grant twice.
- `npm run test:brokers` → **PASS mosquitto, PASS emqx** (9/9 each), plus 9/9 on the in-process
  broker in `npm test`. `e2e.test.ts` uses the real cloud and the real hub; only the ESP32 is
  simulated. Covered: telemetry with ids/online flags only; request pending on the hub, nothing
  works before approval; owner approves on the hub; command executes on the device; diagnostics
  contain no states; owner revokes with one command in flight and one queued (queued fails
  `grant revoked`, in-flight reported); a correctly signed envelope for a revoked grant is refused
  by the hub; hub audit copy intact in the cloud; a neighbour hub's credential receives nothing
  for another hub and cannot fake its status; wrong passwords refused.
  - Mosquitto: native `mosquitto.exe` 2.x as separate processes on free ports with generated config,
    `mosquitto_passwd`-hashed users and ACL files. The cloud broker uses an ACL equivalent of
    `brokerAllows`; the hub's **local** broker uses `deploy/pi/mosquitto/acl.template` rendered
    for the test hub, and the simulated ESP32 logs in with its own credential. The Mosquitto Windows
    service was not touched. Mosquitto accepts a SUBSCRIBE to a forbidden topic and enforces read
    access per message; the test asserts that nothing is delivered.
  - EMQX `emqx/emqx:5.8.6` in Docker with HTTP authentication and authorisation against the cloud's
    internal API (`/broker/authn`, `/broker/authz`, shared-secret header), `no_match = deny`.
- `npm run test:services` → 4/4: owner start notice delivered through real SMTP (Mailpit
  `axllent/mailpit:v1.27`) and read back from its API, then control allowed; a recipient refused
  with 550 fails permanently and control stays blocked; an SMTP server that never answers times
  out (new bounded SMTP timeouts) and stays pending, control blocked; audit export to an
  S3-compatible server with Object Lock: COMPLIANCE retention set, deleting the locked version →
  403, the locked version still reads back after a delete marker, chain and checkpoint verify, the
  next export links to the previous one.
  - **MinIO note:** MinIO no longer publishes images (`docker pull minio/minio` and `quay.io/minio`
    both refused), so the S3 check uses Versity Gateway `versity/versitygw:v1.10.0` (Apache-2.0,
    S3 API with versioning and Object Lock). The production bucket stays Blocked on your account.
- New unit tests: `config.test.ts` (4: pairs required together, errors never echo secret values,
  broker-auth API needs a 32+ character secret); `cli.test.ts` (built CLI: signing keys
  private-only and never overwritten, VAPID keys, `verify-export` passes an intact copy and fails
  an edited record or a wrong public key); `homes.test.ts` the cloud service broker name cannot be
  a hub id; `auth.test.ts` retention sweep deletes ended sessions and used/expired setup links.
- Per-file cloud counts: authz-matrix 153, auth 18, grants 16, homes 12, audit-extras 11,
  notifications 9, e2e 9, crypto 7, pg-roles 6, cli 5, config 4, services 4.

Not verified here (needs your accounts or production hosting, see production gate): a real email
provider, a real S3 bucket and credential policy, real browser push delivery through
Google/Mozilla/Apple push services (encryption and VAPID are checked by decrypting the payload in
`audit-extras.test.ts`), EMQX with TLS on the public internet.

## P6. Fleet

- [x] Telemetry ingestion (metadata only): allow-listed telemetry (P3/P4) now feeds
  `GET /api/v1/fleet/summary` (hub count, online, version and update-state counts, active
  rollout; no device ids or household data, asserted in `fleet.test.ts`).
- [x] Rollout state machine (canary, thresholds, halt, rollback)
- [x] Firmware registry, minisign verification, compatibility checks
- [x] Disruptive actions gated: hub restart only through an owner-approved grant (P2/P5); hub
  updates only under the owner's local update policy (default: owner approves on the hub);
  factory reset and owner promotion are `LOCAL_ONLY_ACTIONS` with no cloud route (the authz-matrix
  coverage test fails on any unlisted cloud route).

How it works:
- **Release registry** (`backend/cloud/src/fleet.ts`, `routes-fleet.ts`, migration `003_fleet.sql`):
  a release is accepted only with a valid minisign signature from the configured VOLTEX release
  public key (`RELEASE_PUBKEY_FILE`). `src/minisign.ts` verifies in Node: Ed25519, BLAKE2b-512
  prehash (`ED`) and legacy (`Ed`), key id, and the trusted-comment global signature. Fixtures were
  produced by the real `minisign 0.11` in a throwaway container (`test/fixtures/minisign/README.md`;
  the throwaway private key was discarded). The hub manifest must pin images by digest. Duplicates
  → 409. Withdrawing a release halts its rollout. Every outcome is audited.
- **Compatibility:** eligible only when the hub runs a release version older than the release and
  at least `minFromVersion`; otherwise a stated reason.
- **Rollouts:** stage 0 is one canary hub, then cumulative percentages (default 10/50/100) of
  eligible hubs in a fixed per-rollout hash order. Each step:
  - re-checks the acting admin (creator, or whoever resumed it) is still an active super admin, or
    halts;
  - halts on any canary failure, or when failed + rolled back exceed `maxFailureRate`;
  - advances only after the health window, with nothing in progress, at least one healthy update,
    and every `done` hub reporting the new version in telemetry (otherwise it counts as failed);
  - owners who decline or have not decided do not block and are not failures.
  Halt and cancel withdraw offers the owners have not decided (`hub.update.withdraw`). An offer
  that cannot be delivered stays pending and is retried; unanswered offers are re-sent after
  10 minutes. Only hubs actually offered a rollout can report status for it (a found-by-test fix).
- **Hub side** (`backend/hub/src/updates.ts`, migration `004_update_offers.sql`): verifies the
  signed `hub.update` (super admin only, release version, strictly newer, one version per rollout),
  then applies the owner policy: `approve` (default) waits for the owner
  (`POST /api/v1/updates/:rolloutId/approve|decline`, `update.manage`), `auto` requests at once.
  Only then is the update request written for the root `voltax-update`, which re-verifies the
  minisign signature and refuses downgrades itself. Results are reported once per state.
- **ESP32 firmware:** registered and signature-checked with its board; a rollout is refused (409)
  until OTA delivery is validated on hardware.

Evidence (2026-10-28):
- `npx vitest run test/fleet.test.ts` → 17/17 (registry, wrong key, edited manifest, unpinned
  image, duplicate, roles, ESP32 blocked, compatibility reasons, canary, stage-by-stage to
  completion with 3 `rollout.stage` audits, canary failure halt, threshold halt + withdraw,
  decline not a failure, done-but-old-version, offline hub retried, demoted creator halts,
  halt/resume/cancel audited, withdrawn release, foreign status ignored, summary minimal).
- `minisign.test.ts` 4/4 (real minisign fixtures, prehashed and legacy, tamper and wrong key);
  `shared/contracts` `updates.test.ts` 3/3; hub `update-offers.test.ts` 9/9.
- `authz-matrix.test.ts` 189/189 (12 new fleet routes × 3 roles: super admin 2xx, support reads
  only, installer reads releases only).
- `npm run typecheck` clean; `npm test`: contracts 18, hub 95, cloud 300 + 11 skipped, web 10.
- `npm run test:pg` (throwaway PostgreSQL 18 cluster): 307 passed + 4 skipped.

Not verified here (hardware): an update applied on a real Pi through `voltax-update`, and any
ESP32 OTA or secure boot.

## P7. Web apps (PWAs)

- [x] Admin portal (`frontend/admin`): all screens, PWA, Web Push
- [x] Customer app: support access, member devices, promote/demote, push opt-in, update approval, dark theme, search/rooms
- [x] Hub fixes: reference validation, optimistic concurrency, revert-timer cancel, `.gitignore` device secrets
- [x] Browser verification of every screen (push delivery itself: not verified, see below)

- **Hub** (`0897333`): schedules and automations must point at an existing switch (400 otherwise);
  `PUT` carries the `version` it edited and gets 409 when stale; any accepted automation edit clears
  its revert timer; `secrets.*.yaml` ignored. New: device rooms, `PUT /clients/:id/role` with the
  last-owner rule (409), `GET /me`, Web Push (VAPID keys made on the hub, host allow-list, owner and
  member topics, subscriptions dropped on revoke and on 404/410).
- **Customer app** (`89f2ed1`): approve/reject/end support cards with history and a live banner on
  every screen, member device choice at invite and later, promote/demote, update offers with the
  owner policy, push opt-in (with the iPhone home-screen rule), light/dark/automatic theme, search,
  filters and rooms.
- **Admin portal** (`frontend/admin`, Next static export served by the cloud on its own origin):
  sign-in (email + password + authenticator code), first-time setup from a one-time link (password,
  then authenticator enrolment; the token is removed from the address bar), overview, homes and
  home detail (hub facts, hub registration with the credential shown once, online/offline devices,
  owner contact on request, assignments, hub audit copy), support access (request; requester-only
  tools limited to the owner-approved actions: switch, diagnostics, activity, restart; finish and
  revoke with a reason; command and owner-notice history), fleet and rollout detail
  (halt/resume/cancel with reasons), releases (upload manifest + .minisig, verified by the cloud;
  compatibility; withdraw), audit (records, chain + checkpoint verify, signed checkpoints), staff
  (create with setup link shown once, role, disable, reset), settings (password, push, theme).
  Menus and buttons follow the permission matrix; the cloud enforces it regardless. Service worker
  precaches the app shell only; `/api` is never cached, and offline the portal says it cannot reach
  the cloud instead of showing old data.
- **Cloud:** `ADMIN_UI_DIR` serves the portal with a strict CSP (`default-src 'self'`,
  `frame-ancestors 'none'`, ...); unknown `/api` paths stay JSON 404s. Staff push links open the
  portal's home page. `backend/cloud/dev/dev-cloud.mjs --demo` runs the real cloud on PGlite with
  throwaway keys and simulated hubs for local clicking (dev only; owner approval is simulated there).

Evidence (2026-10-29):
- Hub: `test/home-features.test.ts` 6/6 and 4 new `local-engine.test.ts` cases; hub 105/105.
- Web: `format.test.ts` 14/14. Admin: `nav.test.ts` 3/3 (menus per role).
- Cloud: `test/admin-ui.test.ts` 4/4 (pages with CSP, trailing-slash redirect, `/api` 404 stays
  JSON, no path traversal); written first and seen failing (2/4) before the change.
- `npm run typecheck` clean; `npm test`: contracts 18, hub 105, cloud 304 + 11 skipped, web 14,
  admin 3. `npm run test:pg` (throwaway PostgreSQL 18): 311 passed + 4 skipped.
- `npm run build -w frontend/admin`: 13 static routes, `sw.js` precaches 114 files; added to CI.
- Browser (built-in preview, production builds):
  - customer app against `dev-hub.mjs --demo`: support banner, approve, live session, end
    session, update install (request file written), theme switch, rooms, search and offline
    filter, member device edit, promote/demote; no console errors.
  - admin portal against `dev-cloud.mjs --demo`: sign-in as support, request access, simulated
    owner approval, diagnostics and a command reaching the hub; sign-in as super admin, register a
    signed release through the form, compatibility (0.9.0 hub excluded by the minimum version),
    rollout to the canary hub (done), audit chain verify (35 records, 1 checkpoint), staff reset and
    first-time setup from the new link through to the signed-in overview; service worker active,
    offline shell shown with the cloud stopped. Bugs found and fixed on the way: audit verify
    response shape (crashed the page), rollout stage labels, desktop menu button, cramped tables.

Not verified: real Web Push delivery to a phone or browser (needs HTTPS and a real push service;
the preview had notifications blocked), and anything on a real Pi or ESP32.

## P8. Quality

- [x] ESLint, `npm audit --omit=dev`, CI jobs
- [x] Security review and fixes

ESLint: one flat config ([eslint.config.mjs](../eslint.config.mjs)) over every workspace:
`@eslint/js` + `typescript-eslint` recommended, `no-eval`/`no-implied-eval`/`no-new-func`, the Next
plugin (recommended + core web vitals) and the classic React hook rules (`rules-of-hooks`,
`exhaustive-deps`) as errors. The React Compiler rules of `eslint-plugin-react-hooks` v7 are not
enabled: the apps are not built with the React Compiler (reasoning in the config). Fixed on the way:
an unused import, three dead initial assignments, an over-wide `let`, a test `any` (now an explained
disable).

Dependencies: `npm audit --omit=dev` was already 0. The full audit had 3 moderate advisories (`uuid`
via `aedes` 0.51, the in-process test broker, dev only); `aedes` upgraded to 1.2 (async
`Aedes.createBroker()` in the 3 call sites), so `npm audit` is now 0 too.

CI ([ci.yml](../.github/workflows/ci.yml)): `npm run lint` before typecheck; a "Production dependency
audit" job; a "Cloud tests on PostgreSQL 18" job (PGDG `postgresql-18` binaries, the same
`npm run test:pg` throwaway cluster: triggers, GRANTs, roles). The runner now puts the cluster's Unix
socket in its temp folder (the packaged `/var/run/postgresql` is not writable by the CI user) and
prints `server.log` if the server does not start.

Security review (ECC `security-reviewer` checklist, AAS `api-security-testing` kept read-only and
in-process, the `/security-review` skill on the P8 diff):
- **Fixed (medium): the hub served the customer web app with no security headers.** A hostile page
  could frame the app and trick an owner into tapping "Approve" on a support request (clickjacking).
  The hub now sends `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer` and, on pages, a CSP matching the cloud portal's (`frame-ancestors
  'none'`, `object-src 'none'`, `base-uri 'none'`, same-origin connect plus the hub's own
  `ws:`/`wss:` origin; a malformed Host header is never reflected). Test first:
  `backend/hub/test/web-ui.test.ts` 3/3 (seen failing 3/3 before the change).
- Checked, no change needed: no shell execution in servers; every SQL statement parameterised; no
  `eval`; the only `dangerouslySetInnerHTML` is the constant theme snippet; push endpoints restricted
  to known push-service hosts on hub and cloud (no SSRF); secret comparisons timing-safe; passwords
  scrypt; sessions HttpOnly + SameSite=Strict (+ Secure); cross-origin writes refused; login per-IP
  limit + account lockout; pairing codes hashed with per-IP and global lockout; body limits; generic
  500s; audit details redacted; no secrets in logs; the hub WebSocket authenticates by token in its
  first message (no ambient credentials, so no cross-site WebSocket hijack).
- `/security-review` on the P8 diff: no findings (the Host-derived CSP value, the envelope
  signature check after the lint change, the CI jobs and the test runner were each examined).
- Carried to P10 (deployment): behind Caddy the cloud must run with `TRUST_PROXY` set to the
  proxy's address, or every login shares the proxy's IP for the per-IP limit.

Evidence (2026-10-29):
- `npm run lint`: clean. `npm run typecheck`: clean.
- `npm test`: contracts 18, hub 108, cloud 304 + 11 skipped, web 14, admin 3.
- `npm run test:pg` (throwaway PostgreSQL 18, runner change included): 311 passed + 4 skipped.
- `npm audit --omit=dev`: 0. `npm audit`: 0.
- `npm run test:brokers` (aedes 1.2 helpers): mosquitto PASS, emqx PASS.
- `npm run build -w frontend/web` and `-w frontend/admin`: ok.
- Browser (built-in preview, `dev-hub.mjs --demo`, production web build): pages arrive with the new
  CSP (checked with `curl -I`), pair, live WebSocket ("Local · Live"), client-side navigation; no
  `securitypolicyviolation` events and no console errors.

## P9. Load test

- [x] Spec with thresholds committed before the run ([load-test-spec.md](testing/load-test-spec.md) v1, `6b505fa`, before any run)
- [x] Simulator (`tools/loadtest/`, `afd6aec`)
- [x] 60-minute run, results committed: **PASS on all six gates**
  ([results](testing/load-test-results-2026-10-29.md), [JSON](testing/load-test-results-2026-10-29.json))

- **Setup:** the real cloud (`dist`) on a throwaway PostgreSQL 18.6 cluster, EMQX 5.8.6 and Mailpit in
  Docker, 120 real hubs (`createHub`) × 10 simulated ESPHome relays in 4 worker processes, 300 staff
  users over HTTP. Everything ran on one laptop (i7-1065G7, 16 GB), so the cloud shared the CPU with
  all of it.
- **Command:** `node tools/loadtest/run.mjs --minutes 60 --warmup 5`, from commit `afd6aec`. Measured
  06:15:57 to 07:15:57 UTC on 2026-10-29.

Evidence (official run):

| Gate | Threshold | Measured |
|---|---|---|
| G1 p95 | < 300 ms | 41.5 ms |
| G2 p99 | < 1,000 ms | 84.6 ms |
| G3 unexpected errors | < 0.1% | 0 of 136,211 |
| G4 isolation violations | 0 | 0 API; 0 broker (260 probes, 0 control failures) |
| G5 invalid commands accepted | 0 | 0 API; 0 of 1,564 forged; 0 of 1,549 replayed |
| G6 hubs online | 120 at every sample | 120 at all 60 samples |

- **Sessions:** 5,889 support sessions, all approved, active and finished.
- **Commands:** 21,895, all confirmed; acknowledgement p50 36 ms, p99 364 ms.
- **Notices:** 17,667 owner notices delivered through Mailpit.
- **Cloud process:** average CPU 11% of one core; memory p50 225 MB, max 471 MB.
- **Database:** 98 MB at the end.

Product bugs the load test found, each fixed test-first before the official run:

- `13064f3`: the cloud exited if the broker was not up in time, could stay connected but subscribed
  to nothing, and logged broker events nowhere.
- `a869081`: one SMTP connection per notice capped owner notices near 1/s. Support sessions stayed
  blocked (fail-closed) for minutes.
- `55db509`: a hub refusing a replayed envelope relabelled the original, already-confirmed command
  as refused in the cloud.

Reported, not hidden (see the results notes):

- The harness's own final audit verify got 401 because its admin session sat idle past the cloud's
  60-minute limit. That is a harness fault: the 55 verifies run under load all passed.
- `POST /audit/verify` is the slowest endpoint (max 2,038 ms). Its cost grows with the chain, so
  production needs incremental, checkpoint-based verification.
- 3 diagnostics requests went unanswered in a pre-fix smoke run. The cause was not found and it did
  not recur in the 60-minute run, which had hub-side traces on.

Not verified: real hardware, production hosting, and real email or push providers. Also not
verified: a load test with the cloud on its own machine.

## P10. Deploy and report

- [ ] `deploy/cloud` stack run locally + smoke test; hub image build
- [ ] Runbooks (cloud deploy, hub cloud-link enablement)
- [ ] [production-gate.md](production-gate.md)
- [ ] Implementation report

## Workflows and skills

| Workflow | Status | Used for |
|---|---|---|
| superpowers | used | test-driven development, verification before completion, systematic debugging (P5 grant race on real PostgreSQL) |
| apple-design | used | P7 portal and app UI: press states, materials, reduced motion/transparency, typography |
| ponytail | used | smallest complete change |
| ECC (`D:\workspace\repos\ecc`) | used | P8 `security-reviewer` checklist (`tdd-guide`, `database-reviewer` still planned) |
| Agentic Awesome Skills | used | P8 `api-security-testing` (read-only, own code, in-process tests); `auth-implementation-patterns`, `audit-logging` planned |
| `/security-review` skill | used | P8 diff review |
| find-skills | planned | start of each phase |
| REA (MCP) | planned | SQLite audit inspection where it adds evidence |
| Ruflo | **unavailable** | MCP tools not loaded in this session; repo used as a playbook only |
