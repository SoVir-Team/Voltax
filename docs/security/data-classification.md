# Data classification, minimisation and retention

Which data VOLTEX handles, where it lives, who can see it, how long it is kept, and how it is
exported or deleted. Principle: **household data stays in the home.** The cloud gets only what it
needs to run the fleet and support, and never device states, history or routines unless the owner
approves a specific grant, and even then they pass through without being stored.

## Classes

| Class | Meaning | Examples |
|---|---|---|
| **Secret** | Grants access if leaked | Passwords, TOTP secrets, session and setup tokens, broker passwords, signing keys, SMTP/S3/VAPID credentials |
| **Household (private)** | Reveals life in the home | Device states, on/off history, schedules, automations, activity timeline |
| **Personal** | Identifies a person | Staff email and name, home owner's contact address, home name |
| **Operational** | Needed to run the fleet; no household content | Hub and app versions, uptime, online/offline flags per device id, sync health, update state |
| **Security record** | Evidence of who did what | Cloud audit log, hub audit log and its cloud copy, checkpoints |

## Where each class lives

### On the hub (in the home)

| Data | Class | Retention |
|---|---|---|
| Devices, entities, current states | Household | While the device is installed |
| Event history (state changes, commands) | Household | 30 days (`events.prune`, daily) |
| Command records | Household | 24 h after they finish (`commands.prune`) |
| Schedules, automations | Household | Until the owner deletes them |
| Paired clients (token hashes), member device scopes | Secret / Personal | Until revoked; pairing codes deleted 24 h after expiry |
| Support grants, cloud nonces | Security record / Secret | Grants kept; nonces deleted when expired |
| Hub audit log | Security record | Kept on the hub; append-only |

### In the cloud

| Data | Class | Why it is there | Retention |
|---|---|---|---|
| Staff: email, name, role | Personal | Sign-in, assignments | While employed; disabling ends access at once |
| Staff password hash (scrypt), TOTP secret (AES-256-GCM sealed with `CLOUD_DATA_KEY`) | Secret | Sign-in | Replaced on reset |
| Sessions, setup links (SHA-256 hashes only) | Secret | Sign-in | **Deleted hourly** once ended, idle or expired, or once a setup link is used (`StaffService.purgeExpired`, test *retention: ended sessions…*) |
| Homes: name, owner contact | Personal | Support, owner notices | Until the home is removed. The contact is visible only through the audited `home.contact.read` |
| Hubs: id, broker password hash, **last** telemetry | Secret / Operational | Fleet view, broker login | Telemetry is overwritten, never accumulated |
| Telemetry fields | Operational | Fleet health | Allow-list enforced by `telemetrySchema` (strict): version, uptime, db/mqtt up, time synced, `{deviceId, online}` per device, update state. **No states, names, history or routines** (end-to-end test checks the cloud sees only ids and flags) |
| Assignments | Operational | Who may support which home | Kept (history of access) |
| Support grants and commands | Security record | Mirror of the hub's grant; what support asked for | Kept as part of the support record |
| Diagnostics responses | Operational | Answer to a support request | **Not stored**: passed through to the requesting staff member, access audited |
| Activity history | Household | Only with an owner-approved `activity.read` grant | **Not stored**: passed through, device-filtered by the hub, every access audited on hub and cloud |
| Notifications | Personal (briefly) | Owner start/end notices | The recipient address is **cleared** as soon as the notice is delivered, fails or is cancelled; error texts are sanitised |
| Staff push subscriptions | Personal | Portal alerts | Deleted on unsubscribe or when the push service says the browser is gone (404/410) |
| Cloud audit log, hub audit copies, checkpoints | Security record | Accountability | Life of the service; exported copy locked `S3_LOCK_DAYS` (default 365). See [audit-threat-model.md](audit-threat-model.md) |

Audit records are redacted before hashing: keys that look like secrets are replaced by
`[redacted]`, and the cloud audit stores ids, not names or device states.

## Rules for code

1. New telemetry fields need a schema change in `shared/contracts` **and** a reason in this table.
   The schema is `.strict()`, so an unlisted field is a validation error, not a silent leak.
2. Household data may only reach the cloud inside a grant result (`diagnostics`, `activity`), and
   is never written to the database or logs.
3. Logs carry ids and outcomes, never request bodies, tokens or contact addresses. Configuration
   errors name the setting, never the value (test: *settings that only work together…*).
4. Secrets come from the environment or mounted files, never from git. `.secrets/` and device
   `secrets.yaml` files are ignored.

## Export and deletion requests

- **Home owner, own data:** everything household lives on their hub. The owner app's backup and
  the hub `cli` give a full export. Removing the hub (or factory reset) deletes it.
- **Home owner, cloud data:** the cloud holds the home name, contact address, last telemetry, grants
  and audit records about the home. On a deletion request: remove the contact and name (set
  them to null / a placeholder), unregister the hub, and remove assignments. **Audit records and
  support records are kept** because they are security evidence. They contain ids, not household
  content. This exception must be stated in the customer privacy notice.
- **Staff member leaving:** disable the account (ends sessions at once); the name and email stay
  in audit records as the actor.

## Status

| Item | Status |
|---|---|
| Telemetry allow-list, pass-through diagnostics/activity, notification recipient clearing, audit redaction | Done, tested (P3, P5) |
| Session and setup-link retention sweep | Done, tested (P5) |
| Hub event/command pruning | Done (Milestone 1/P2) |
| Owner deletion request as a portal action (with audit) | Not built: done by an operator today; candidate for the admin portal (P7) |
| Customer privacy notice text | **Your decision / legal review**: not a software item |
