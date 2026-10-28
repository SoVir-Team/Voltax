-- Support access (mirror of the hub, which is the authority), owner notifications, hub audit copies,
-- signed audit checkpoints, staff push subscriptions.

-- What the cloud asked for and what the hub last reported. The cloud never decides approval.
CREATE TABLE grants (
  grant_id         uuid PRIMARY KEY,
  home_id          uuid NOT NULL REFERENCES homes(id),
  hub_id           text NOT NULL,
  staff_id         uuid NOT NULL REFERENCES staff(id),
  staff_role       text NOT NULL,
  device_ids       text NOT NULL,          -- JSON array
  actions          text NOT NULL,          -- JSON array
  reason           text NOT NULL,
  ticket_ref       text,
  starts_at        bigint NOT NULL,
  ends_at          bigint NOT NULL,
  status           text NOT NULL CHECK (status IN ('pending', 'active', 'rejected', 'revoked', 'expired', 'completed')),
  requested_at     bigint NOT NULL,
  request_envelope_id uuid NOT NULL UNIQUE,
  hub_updated_at   bigint,
  start_notice_at  bigint,                 -- hub confirmed the owner's app was told
  ended_at         bigint,
  end_reason       text
);
CREATE INDEX grants_home ON grants (home_id, requested_at DESC);
CREATE INDEX grants_staff ON grants (staff_id, requested_at DESC);

CREATE TABLE grant_commands (
  command_id    uuid PRIMARY KEY,
  grant_id      uuid NOT NULL REFERENCES grants(grant_id),
  entity_id     text NOT NULL,
  value         boolean NOT NULL,
  status        text NOT NULL,             -- sent, then whatever the hub reports (pending/sent/confirmed/failed/expired) or refused
  reason        text,
  requested_by  uuid NOT NULL,
  requested_at  bigint NOT NULL,
  updated_at    bigint NOT NULL,
  envelope_id   uuid NOT NULL UNIQUE
);
CREATE INDEX grant_commands_grant ON grant_commands (grant_id, requested_at);

-- Owner notices. Control actions need every start notice for the grant delivered (fail-closed).
-- recipient holds the delivery address only while needed and is never written to the audit log.
CREATE TABLE notifications (
  id               uuid PRIMARY KEY,
  grant_id         uuid NOT NULL REFERENCES grants(grant_id),
  home_id          uuid NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('support.started', 'support.ended')),
  channel          text NOT NULL CHECK (channel IN ('in_app', 'email')),
  recipient        text,
  status           text NOT NULL CHECK (status IN ('pending', 'delivered', 'failed', 'cancelled')),
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  bigint,
  last_error       text,
  created_at       bigint NOT NULL,
  delivered_at     bigint,
  UNIQUE (grant_id, kind, channel)
);
CREATE INDEX notifications_due ON notifications (status, next_attempt_at);

-- Off-device copy of each hub's own audit chain (exported by the hub). Append-only.
CREATE TABLE hub_audit (
  hub_id       text NOT NULL,
  seq          bigint NOT NULL,
  id           uuid NOT NULL,
  at           bigint NOT NULL,
  actor        text NOT NULL,
  action       text NOT NULL,
  outcome      text NOT NULL,
  target       text,
  details      text NOT NULL,
  prev_hash    text NOT NULL,
  hash         text NOT NULL,
  chain_ok     boolean NOT NULL,           -- links to the previous stored record and its hash recomputes
  received_at  bigint NOT NULL,
  PRIMARY KEY (hub_id, seq)
);
CREATE TRIGGER hub_audit_no_update BEFORE UPDATE OR DELETE ON hub_audit FOR EACH ROW EXECUTE FUNCTION voltax_append_only();
CREATE TRIGGER hub_audit_no_truncate BEFORE TRUNCATE ON hub_audit FOR EACH STATEMENT EXECUTE FUNCTION voltax_append_only();

-- Signed statements "the cloud audit chain had N records ending in hash H at time T".
CREATE TABLE audit_checkpoints (
  id          bigserial PRIMARY KEY,
  at          bigint NOT NULL,
  last_seq    bigint NOT NULL,
  head_hash   text NOT NULL,
  key_id      text NOT NULL,
  signature   text NOT NULL
);
CREATE TRIGGER audit_checkpoints_no_update BEFORE UPDATE OR DELETE ON audit_checkpoints FOR EACH ROW EXECUTE FUNCTION voltax_append_only();
CREATE TRIGGER audit_checkpoints_no_truncate BEFORE TRUNCATE ON audit_checkpoints FOR EACH STATEMENT EXECUTE FUNCTION voltax_append_only();

-- Where the cloud audit export has got to (off-device copy).
INSERT INTO cloud_meta (key, value) VALUES ('audit_exported_seq', '0');

-- Staff browsers that opted in to Web Push (portal alerts: grant approved, rejected, ended).
CREATE TABLE push_subscriptions (
  endpoint    text PRIMARY KEY,
  staff_id    uuid NOT NULL REFERENCES staff(id),
  p256dh      text NOT NULL,
  auth        text NOT NULL,
  created_at  bigint NOT NULL
);
