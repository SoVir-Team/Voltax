-- Members only see and control devices the owner granted them. '*' = every device (explicit grant).
CREATE TABLE client_devices (
  client_id TEXT NOT NULL REFERENCES clients(client_id),
  device_id TEXT NOT NULL,
  PRIMARY KEY (client_id, device_id)
);
-- Existing members keep what they had before this migration (every device), now as an explicit grant.
INSERT INTO client_devices (client_id, device_id) SELECT client_id, '*' FROM clients WHERE role = 'member';

-- Device scope chosen when the invite was created: JSON array of device ids, or '*'.
ALTER TABLE pairing_codes ADD COLUMN device_scope TEXT;

-- Append-only, hash-chained security audit log. hash = sha256(prev_hash || canonical record).
CREATE TABLE audit_log (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  id        TEXT NOT NULL UNIQUE,
  at        INTEGER NOT NULL,
  actor     TEXT NOT NULL,
  action    TEXT NOT NULL,
  outcome   TEXT NOT NULL CHECK (outcome IN ('allowed', 'denied', 'ok', 'error')),
  target    TEXT,
  details   TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash      TEXT NOT NULL
);
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
