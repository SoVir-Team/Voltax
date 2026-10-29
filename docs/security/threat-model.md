# Threat model (Milestone 2)

Scope: the cloud platform, the cloud-to-hub link, support access and fleet operations. The local hub
model from Milestone 1 is described in [architecture.md](../architecture.md) and
[ADR 0003](../adr/0003-private-hub-ca.md).

## Assets

| Asset | Why it matters |
|---|---|
| Control of devices in a home | Physical effect: power to loads, possibly safety-relevant |
| Household activity data | Reveals occupancy and routines: privacy and burglary risk |
| Hub identity and broker credentials | Impersonating a hub, or reaching other homes |
| Cloud command-signing key | Can create envelopes the hubs will check |
| Release / firmware signing keys | Can create updates the fleet will install |
| Audit trail | Evidence of who did what; must survive insiders |

## Trust boundaries

1. **Each home's hub is the final authority for its home.** The cloud may be compromised or
   misconfigured, and hubs are built to stay safe when it is.
2. Cloud API ↔ staff browsers: TLS, staff sessions with email/password login, scrypt hashing, account lockout and rate limits. Authenticator codes are not required; theft of a valid password can therefore open a staff session.
3. Cloud ↔ hubs: outbound MQTT/TLS from the hub. A per-hub broker credential with an ACL limited
   to `voltax-cloud/<hubId>/#`, plus signed envelopes cloud → hub.
4. Hub ↔ ESP32: home broker, per-device credentials and ACL (Milestone 1).

## Main threats and controls

| Threat | Control | Evidence |
|---|---|---|
| Staff member controls a home without consent | Device control only via a grant approved by the owner **on the hub**. The cloud cannot mark a grant approved; the hub ignores cloud-side status for authorisation | Hub grant tests (P2), end-to-end test (P5) |
| Compromised cloud sends commands | The hub verifies: Ed25519 signature with the pinned key; its own hubId; single-use nonce; issued/expiry window ≤ 30 s; trusted clock; its **local** grant record; device and action scope; that the actor is the grantee; the start notice. A stolen signing key still cannot use a grant the owner did not approve, or act outside its scope and window | Envelope verifier tests (P2) |
| Replay of a captured envelope | Nonce table with expiry plus a short lifetime. Replays are rejected and audited | P2 tests |
| Hub clock wrong after a power cut (no RTC) | Cloud envelopes are refused while `timeSynced` is false (fail-closed). Local control still works | P2 test "clock untrusted" |
| Grant revoked while commands are in flight | Queued commands are cancelled; grant re-checked right before the MQTT publish; an already-published command cannot be undone (see below) | P2 race tests |
| One home reads another home's data | Cloud queries are scoped by assignment in SQL; broker ACL per hub; telemetry allow-list carries no household data | P4 negative tests, `test:brokers` |
| Admin enumerates homes or devices they are not assigned to | Scope filters applied in queries (not after loading); IDs from the client are never trusted for scope | P4 tests |
| Insider edits or deletes audit records | Append-only triggers; app DB role has no UPDATE/DELETE; hash chain; signed checkpoints; off-device copy | P5 tests, `test:pg`; see [audit-threat-model.md](audit-threat-model.md) |
| Malicious or broken update | minisign signatures verified on the host by root (not by the hub process); staged rollout with health thresholds; automatic rollback; owner update policy | P6 tests; release workflow |
| Notification outage hides a support session | Control requires a recorded start notice. A notification failure never enables or widens access | P5 notification tests |
| Secrets leak into logs or audit | Redaction allow-list; tests assert tokens, passwords and keys never appear | P1/P5 tests |

## In-flight commands and revocation (execution race)

| Command state when revoked | What happens |
|---|---|
| Not yet accepted by the hub | Rejected: the grant is no longer active |
| Queued on the hub | Cancelled: `failed`, reason `grant revoked` |
| Being dispatched | The grant is re-checked immediately before publish. If revoked, it is not published |
| Published to the ESP32 | **Cannot be recalled.** The ESP32 may already have switched. The hub tracks the outcome (`confirmed`/`failed`), raises `support.revoked_in_flight` to the owner with the device and target value, and records it in the audit log |

**Compensating action:** the owner sees the reported state in the app and can switch it back. The
platform never claims that revocation undid a physical action that already happened. No further
commands under that grant are accepted from the moment of revocation.

## Break-glass

There is **no** emergency override, universal company access or authentication bypass. Any future
emergency mechanism needs explicit policy approval first. Requirements it would have to meet:
- narrow scope;
- strong authentication;
- time-limited and justified;
- independently audited;
- revocable;
- post-incident review;
- never across arbitrary homes, never bypassing hub checks.

## Residual risks (accepted or open)

- **Hub compromise:** someone with root on a hub, or physical access to it, controls that home.
  Production mitigations: disk encryption and secure boot are hardware and production work.
- **Local broker in plaintext:** port 1883 on the LAN is unencrypted (Milestone 1 limitation).
  Moving it to TLS on 8883 is required before production.
- **ESP32 flash:** device credentials can be read from flash until flash encryption and secure boot
  are enabled (needs hardware).
- **Owner device compromise:** a stolen, unlocked owner phone can approve grants. The approval card
  shows the requester, scope and duration, so the owner sees what they are approving.
