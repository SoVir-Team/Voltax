CREATE TABLE customer_accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  client_id TEXT NOT NULL UNIQUE REFERENCES clients(client_id),
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE customer_sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES customer_accounts(id),
  expires_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE INDEX customer_sessions_account ON customer_sessions(account_id);
CREATE TABLE customer_invitations (
  id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL COLLATE NOCASE,
  role TEXT NOT NULL CHECK(role IN ('owner','member')),
  devices TEXT NOT NULL,
  created_by TEXT,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  claim_hash TEXT UNIQUE,
  claim_expires INTEGER
);
CREATE TABLE customer_recovery (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  sent_at INTEGER NOT NULL
);
