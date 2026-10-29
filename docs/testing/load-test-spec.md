# Load test specification, v1

Status: **fixed before the first run.** This file was committed before any load-test run, and the
acceptance criteria below are not changed afterwards. If a run fails a criterion, the failure is
investigated and reported in the results file. A later spec version may add criteria but never
relaxes these, and v1 results stay reported.

Requirement (Milestone 2): a reproducible load test of 120 homes × 10 devices, 300 users and
telemetry every 30 s, run for 60 min, with API p95 < 300 ms, p99 < 1 s and errors < 0.1%.

## What runs (system under test)

All of it is the real code from this repository, built (`npm run build`), on one machine:

| Part | What | Notes |
|---|---|---|
| Cloud | `backend/cloud/dist/main.js`, one process | production config path: env file, `MIGRATE_ON_START=false`, production scrypt cost, `LOG_LEVEL=info` to a file, `TRUST_PROXY=127.0.0.1` (see users) |
| Database | PostgreSQL 18, throwaway cluster | `initdb` in a temp folder, own port, 127.0.0.1 only; migrations applied as `voltax_owner` with `cli migrate`; the cloud connects as `voltax_app` (the production privilege model) |
| Cloud broker | EMQX (`emqx/emqx:5.8.6`, Docker) | every hub authenticated and authorised through the cloud's internal `/broker/authn` + `/broker/authz` (production arrangement) |
| Owner email | Mailpit (Docker), SMTP | the start notice must be delivered before remote control works (fail-closed), so it is on the measured path |
| Hubs | 120 × `createHub()` from `backend/hub/dist` | the complete hub (SQLite file database, audit chain, grants, envelope verifier, command manager, cloud link), spread over 4 worker processes; `TELEMETRY_INTERVAL_MS=30000`; only the HTTP listener is not opened (owner calls use the same Fastify routes via inject) |
| Home brokers | one in-process MQTT broker (aedes) per worker process | topics are per hub (`voltax/<hubId>/…`), as on each Pi's Mosquitto |
| Devices | 1,200 simulated ESPHome relays | each speaks the ESPHome MQTT protocol (status, retained state, command topic) |
| Users | load generator process | real HTTP over TCP to the cloud |

Not in the run: TLS (Caddy in front of the cloud, `mqtts` to EMQX), real Pi and ESP32 hardware,
real network latency. Everything shares one machine, so the generator, the simulated hubs and the
containers compete with the cloud for CPU (a pessimistic arrangement for the cloud).

## Topology and workload

- **Homes and devices:** 120 homes. Each has a registered hub with 10 devices (one relay switch
  each), so 1,200 devices.
- **Device telemetry:** every device publishes its state every 30 s (1,200 / 30 s = 40 messages/s
  into the hubs). Every hub sends its allow-listed cloud telemetry every 30 s (4 messages/s
  through EMQX into the cloud and PostgreSQL).
- **Users.** In this design, household members talk only to their own hub on the home network and
  never to the cloud. The shared, multi-tenant service is the company cloud, so the 300 users are
  300 concurrent company portal users:
  - **Mix:** 10 `PLATFORM_SUPER_ADMIN`, 200 `PLATFORM_SUPPORT` and 90 `INSTALLER`.
  - **Assignments:** each support user is assigned to 6 homes and each installer to 4.
  - **Accounts:** every user has its own account (email + password), signs in through the API and
    keeps its session.
  - **Client address:** each user has its own client address, given in `X-Forwarded-For` the way
    Caddy passes it in production (`TRUST_PROXY`). Per-address limits therefore apply per user.
- **Home owners:** every home has one paired owner client on its hub, the real household approver.
  It approves each support request 2–5 s after the request arrives on the hub.
- **User actions:** each user acts, then waits a random 5–15 s (mean 10 s), so the 300 users
  produce about 30 actions/s. Users start over the first 2 minutes of the warm-up.
  - **Support and installer users with no open session:**
    - 80% browse one of: `GET /auth/me`, `/homes`, `/homes/:id`, `/homes/:id/hub`,
      `/homes/:id/devices`, `/homes/:id/grants`, `/grants`. Support users can also browse
      `/fleet/summary`.
    - 10% start a support session: `POST /homes/:id/grants` for 2 devices with
      `device.command` + `diagnostics.read`, lasting 15 min. The user then polls the grant every
      5 s (as the portal does) until the hub owner has approved it and it is active.
    - 5% isolation probe: a read or a grant request on a home they are not assigned to.
    - 5% invalid-grant probe: a command on an ended or unknown grant.
  - **Support and installer users during an active session:** 6 to 10 actions, each of them:
    - 50%: `POST …/commands` (switch a granted relay), then `GET …/commands`.
    - 20%: `POST …/diagnostics` (a synchronous round trip through EMQX to the hub and back).
    - 30%: a browse request.
    - After the last action, the user ends the session (`POST …/revoke`).
  - **Super admins:** browse `/homes`, `/fleet/summary`, `/staff`, `/audit` (100 records),
    `/grants`, `/rollouts`, `/releases` and `/audit/checkpoints`. With probability 1/60 per action
    they run `POST /audit/verify`, which checks the whole chain.
- **Hub-side adversarial load:**
  - **Forged and replayed envelopes:** every 10 s per worker process, one hub is given an envelope
    signed with a wrong key, and one hub is given a replay of a real envelope it already executed.
  - **Broker isolation probe:** every 60 s per worker process, one hub's own broker credential
    tries to read and to write another hub's cloud topics. Marker messages, sent through the
    cloud service account and through the probing credential, show whether anything crossed
    between hubs.

## Measurements

- **API latency:** for every portal request, the time from sending it to the complete response, measured
  by the generator. Only requests sent during the 60-minute measured window count toward the
  thresholds. Reported overall and per endpoint (route template): count, p50, p95, p99 and max.
- **Expected and unexpected outcomes:** each request type has a set of expected statuses.
  - **Normal requests** expect 2xx. A grant command expects 202, or 409 if the grant has just ended.
  - **Isolation probes** expect 403 or 404.
  - **Invalid-grant probes** expect 403, 404 or 409.
  - **Unexpected:** anything else counts as an unexpected error: other statuses, 5xx, timeouts
    (10 s) and connection errors.
- **Command-acknowledgement latency** (reported, separately from API latency): for each command,
  the cloud's own `updatedAt − requestedAt` once it is `confirmed`. The path is cloud → EMQX →
  hub verification → home broker → device → state back → hub → EMQX → cloud. Also reported: how
  many commands ended in each state.
- **Telemetry freshness:** once a minute, a super admin reads `/fleet/summary` and records how
  many hubs are online.
- **Resources:**
  - every 10 s: the cloud process's memory and CPU, sampled;
  - at the end: the PostgreSQL database size, the audit-chain length and the result of
    `POST /audit/verify`.

## Acceptance criteria (v1)

All are measured over the 60-minute window after a 5-minute warm-up.

| # | Criterion | Threshold |
|---|---|---|
| G1 | API latency p95, all portal requests | **< 300 ms** |
| G2 | API latency p99, all portal requests | **< 1,000 ms** |
| G3 | Unexpected errors, share of all portal requests | **< 0.1%** |
| G4 | Isolation violations: an isolation probe that succeeds (2xx), or any marker message crossing between hubs on the broker | **0** |
| G5 | Accepted invalid commands: an invalid-grant probe answered 2xx, or a forged or replayed envelope a hub did not refuse | **0** |
| G6 | Hubs online at every 1-minute telemetry sample | **120 of 120** |

The run passes only if all six hold. The results file reports every number above, whether or not it
passes.

## Environment recorded with each run

- Git commit.
- OS and version, CPU model with core and thread count, RAM.
- Node, PostgreSQL, EMQX, Mailpit and Docker versions.
- Start and end times.
- Number of hub worker processes.

## Procedure

```bash
npm ci && npm run build
node tools/loadtest/run.mjs --minutes 60 --warmup 5
```

The script starts every part listed above, waits until all 120 hubs report telemetry, ramps up the
users, runs the warm-up and then the measured window, and stops everything. It writes:
- `docs/testing/load-test-results-<date>.json` (all the numbers);
- `docs/testing/load-test-results-<date>.md` (the summary against G1–G6).

Short runs (for example `--minutes 2 --warmup 1`) are smoke tests of the simulator. They never
count as the result.
