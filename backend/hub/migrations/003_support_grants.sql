-- Support grants: the home owner approves, on this hub, exactly what a VOLTEX staff member may do,
-- on which devices, for how long. The hub is the authority; the cloud only mirrors.
CREATE TABLE support_grants (
  grant_id            TEXT PRIMARY KEY,
  staff_id            TEXT NOT NULL,
  staff_role          TEXT NOT NULL,
  staff_name          TEXT NOT NULL,
  device_ids          TEXT NOT NULL,   -- JSON array
  actions             TEXT NOT NULL,   -- JSON array
  reason              TEXT NOT NULL,
  ticket_ref          TEXT,
  starts_at           INTEGER NOT NULL,
  ends_at             INTEGER NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('pending', 'active', 'rejected', 'revoked', 'expired', 'completed')),
  requested_at        INTEGER NOT NULL,
  request_envelope_id TEXT NOT NULL UNIQUE,
  decided_by          TEXT,            -- owner client id that approved or rejected
  decided_at          INTEGER,
  start_notice_at     INTEGER,         -- in-app "support session started" notice recorded
  ended_at            INTEGER,
  end_reason          TEXT
);
CREATE INDEX support_grants_status ON support_grants(status);

-- Single-use cloud envelope ids (replay protection), kept until they could no longer be valid.
CREATE TABLE cloud_nonces (
  envelope_id TEXT PRIMARY KEY,
  expires_at  INTEGER NOT NULL
);

ALTER TABLE commands ADD COLUMN grant_id TEXT;
CREATE INDEX commands_grant_id ON commands(grant_id);
