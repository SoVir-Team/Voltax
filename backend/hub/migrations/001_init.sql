-- All timestamps are epoch milliseconds.

CREATE TABLE hub_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE devices (
  device_id  TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  online     INTEGER NOT NULL DEFAULT 0,
  last_seen  INTEGER
);

CREATE TABLE entities (
  entity_id     TEXT PRIMARY KEY,
  device_id     TEXT NOT NULL REFERENCES devices(device_id),
  component     TEXT NOT NULL CHECK (component IN ('switch', 'binary_sensor')),
  name          TEXT NOT NULL,
  state         INTEGER,            -- last REPORTED state (0/1), NULL until reported
  state_version INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER
);

CREATE TABLE commands (
  command_id TEXT PRIMARY KEY,
  entity_id  TEXT NOT NULL,
  value      INTEGER NOT NULL,
  source     TEXT NOT NULL,
  status     TEXT NOT NULL,
  reason     TEXT,
  issued_at  INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  sent_at    INTEGER,
  done_at    INTEGER
);
CREATE INDEX commands_issued_at ON commands(issued_at);

CREATE TABLE events (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  id              TEXT NOT NULL UNIQUE,
  type            TEXT NOT NULL,
  payload         TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  cloud_synced_at INTEGER
);
CREATE INDEX events_created_at ON events(created_at);

CREATE TABLE clients (
  client_id  TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE pairing_codes (
  code_hash  TEXT PRIMARY KEY,
  role       TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  expires_at INTEGER,               -- NULL = valid until used (factory/first-boot code)
  used_at    INTEGER
);

CREATE TABLE schedules (
  schedule_id TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  cron        TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  value       INTEGER NOT NULL,
  enabled     INTEGER NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE automations (
  automation_id TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  enabled       INTEGER NOT NULL,
  definition    TEXT NOT NULL,      -- JSON: { trigger, action }
  version       INTEGER NOT NULL DEFAULT 1,
  updated_at    INTEGER NOT NULL
);
