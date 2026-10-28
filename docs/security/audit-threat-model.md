# Audit trail: threat model

What the VOLTEX audit trail is meant to prove, who it protects against, and where its limits are.
It covers both logs: the **cloud audit** (staff and platform actions) and each **hub audit** (what
happened in a home, including every support action). The general model is in
[threat-model.md](threat-model.md).

## What it must show

- Who did what, to which home or device, when, and whether it was allowed, denied or failed.
  Denials are recorded too: a refused cross-home request or a forged envelope leaves a trace.
- That no record was changed, removed or inserted afterwards, by anyone, including VOLTEX staff
  with database access.
- For each home: every support request, approval, rejection, revocation, command and result, kept
  on the hub itself **and** copied off the hub.

## Building blocks

| Block | Where | What it gives |
|---|---|---|
| Append-only tables | Cloud: `audit_log`, `hub_audit`, `audit_checkpoints` have triggers that refuse UPDATE, DELETE and TRUNCATE (`voltax_append_only()`). Hub: SQLite triggers on `audit_log` | Ordinary code paths and SQL mistakes cannot change history. The triggers stop even the table owner |
| Least-privilege roles | Cloud runs as `voltax_app`, which has INSERT and SELECT only on the audit tables and no ownership, so it cannot drop or disable the triggers. `voltax_audit_reader` can only read. Migrations run separately as `voltax_owner` (`cli migrate`) | A compromised cloud process cannot rewrite audit rows through the database |
| Hash chain | Each record stores `hash = sha256(prevHash + "\n" + JSON[id, at, actor, action, outcome, target, homeId, details])`. A transaction-level advisory lock serialises appends, so concurrent cloud processes never fork the chain | Any edit, deletion or insertion breaks the chain at that point |
| Signed checkpoints | Every 5 minutes (and with every export) the cloud signs `voltax-audit-checkpoint:v1:<lastSeq>:<headHash>:<at>` with an Ed25519 key kept **outside the database** (`AUDIT_KEY_FILE`) | Someone who rewrites the database **and** recomputes every hash still cannot make matching signatures. Every checkpointed head must still be the stored hash at that sequence |
| Off-device copy (cloud) | `AuditExport` writes consecutive batches with the latest signed checkpoint to an S3 bucket with **Object Lock in COMPLIANCE mode** (default 365 days). The export cursor only advances after the object is stored | The copy is out of reach of the cloud host and of VOLTEX admins until retention ends |
| Off-device copy (hub) | Each hub sends its own chained records to the cloud (`audit.batch`). The cloud stores them in `hub_audit` (append-only), rechecks each link (`chain_ok`), and records a conflict if a hub ever re-sends a different record for a known sequence number | A hub that is wiped, replaced or tampered with locally cannot erase what it already reported |
| Redaction | Before hashing, `details` pass through an allow-by-shape redactor: keys that look like tokens, passwords, TOTP codes, cookies, keys, signatures or sessions become `[redacted]`. Depth and size are bounded. The cloud audit stores no device states, names or household data | The audit log cannot become a store of secrets or private data |
| Verification tools | `cli audit-verify` (cloud: chain + every checkpoint signature + checkpointed heads); `POST /api/v1/audit/verify` (role `audit.verify`); hub `cli audit-verify`; `cli verify-export --file --pubkey` (offline check of one exported object, no database needed) | Anyone with the public checkpoint key can check an exported copy independently |

## Attackers and outcomes

| Attacker | Can they… | Result |
|---|---|---|
| Staff member using the portal | Change or delete audit records? | No: there is no route for it. Audit reads need `audit.read` and are scoped like every other read |
| Bug or SQL injection in the cloud app | UPDATE/DELETE/TRUNCATE audit rows? | No: the app role has no such privilege, and the triggers refuse anyway (`test:pg`: *the app role can append audit records but cannot change, delete, truncate or unprotect them*) |
| Database administrator (owner or superuser) | Disable the triggers and rewrite rows? | **Yes, they can rewrite the database.** Detected: the chain breaks; if they recompute every hash, the signed checkpoints no longer match (test: *a full rewrite that re-hashes the whole chain is still caught by the checkpoints*). The copies already in the locked bucket are unaffected |
| DBA who also holds the checkpoint private key | Rewrite and re-sign the database? | Detectable only against the **off-device copy**: the locked objects still hold the original records and checkpoints. This is why the key lives outside the database host and the bucket uses COMPLIANCE retention |
| Holder of the S3 credential | Destroy exported objects? | No: deleting a locked version is refused (`403 AccessDenied`, checked against a real S3-compatible server in `test:services`). A plain DELETE only adds a delete marker; the locked version stays readable. **Production:** give the cloud's S3 credential only `s3:PutObject` and `s3:GetObject`, no delete, and keep bucket administration with a different account |
| Someone with physical access to a hub | Edit the hub's SQLite audit file? | Locally yes (root on the Pi). Records already exported stay in the cloud copy; a re-sent record with different content is flagged as a conflict and audited in the cloud |
| A hub impersonating another hub | Inject audit records for another home? | No: the broker ACL binds each hub credential to its own topics (tested on aedes, Mosquitto and EMQX in `test:brokers`), and the cloud takes the hub id from the topic, never from the message |

## What a hash chain does NOT do

- It does not **prevent** a privileged attacker from rewriting the database. It makes rewriting
  **detectable**. Prevention relies on the signing key staying off the database host and on the
  locked off-device copy.
- It does not prove a record is **true**, only that it has not changed since it was written. A
  compromised cloud could write false records about its own actions. The hub's independent audit
  (written by the hub, about what the hub actually executed) is the check on that for anything
  that touches a home.
- Records written between the last export and a compromise are only as safe as the database.
  The export interval (default 5 minutes) bounds that window.

## Operations

- Keys: generate with `cli gen-audit-key --out <file>` on a machine you trust. Mount the private
  key read-only into the cloud container (`AUDIT_KEY_FILE`); give the `.pub` file to auditors.
  Never commit either. Changing the key is fine: old checkpoints keep verifying with the old public
  key, so keep the old `.pub`.
- Bucket: `cli audit-bucket-create` once (Object Lock can only be enabled at creation), then set
  the bucket's default retention in the provider console as a second safety net.
- Checks: run `cli audit-verify` daily from cron or monitoring, and alert on a non-zero exit. Spot
  check exported objects with `cli verify-export`.
- Retention: the cloud keeps the audit log for the life of the service; the locked copy keeps each
  object for `S3_LOCK_DAYS` (default 365). Data classification and deletion rules are in
  `data-classification.md`.

## Status

| Item | Status | Evidence |
|---|---|---|
| Append-only triggers, role privileges, concurrent chain | Done | `npm run test:pg -w backend/cloud` on PostgreSQL 18.6 |
| Chain, checkpoints, full-rewrite detection | Done | `test/audit-extras.test.ts`, `test/homes.test.ts` |
| Hub copies: ingest, chain check, conflicts | Done | `test/audit-extras.test.ts`, `test/e2e.test.ts` (real hub) |
| Export to S3 with Object Lock, delete refused, offline verification | Done against a local S3-compatible server (Versity Gateway) | `npm run test:services -w backend/cloud`, `test/cli.test.ts` |
| Production bucket (provider, account, retention policy, credential scope) | **Blocked: needs your account** | Create the bucket and a put/get-only credential, then set `S3_*` |
| Production checkpoint key | **Blocked: you generate it** | `cli gen-audit-key` on a trusted machine |
