-- VOLTEX cloud core: staff, sessions, homes, hubs, assignments, audit.
-- Times are epoch milliseconds (bigint), matching the hub and the API.
-- The cloud stores operational metadata only: no device states, history, schedules or routines.

CREATE TABLE staff (
  id              uuid PRIMARY KEY,
  email           text NOT NULL UNIQUE CHECK (email = lower(email)),
  display_name    text NOT NULL,
  role            text NOT NULL CHECK (role IN ('PLATFORM_SUPER_ADMIN', 'PLATFORM_SUPPORT', 'INSTALLER')),
  password_hash   text,                -- scrypt; NULL until the staff member completes setup
  totp_secret     text,                -- AES-256-GCM sealed with CLOUD_DATA_KEY; NULL until enrolled
  totp_pending    text,                -- sealed secret offered during enrolment, not yet confirmed
  totp_last_step  bigint,              -- last accepted TOTP time step: a code is never accepted twice
  failed_logins   integer NOT NULL DEFAULT 0,
  locked_until    bigint,
  disabled_at     bigint,
  created_at      bigint NOT NULL,
  created_by      uuid
);

-- One-time setup links (new staff, MFA reset). Stored hashed; the token itself is shown once.
CREATE TABLE staff_setup_tokens (
  token_hash  text PRIMARY KEY,
  staff_id    uuid NOT NULL REFERENCES staff(id),
  expires_at  bigint NOT NULL,
  used_at     bigint
);

-- Opaque session tokens, stored hashed. mfa = TOTP verified for this session.
CREATE TABLE sessions (
  token_hash    text PRIMARY KEY,
  staff_id      uuid NOT NULL REFERENCES staff(id),
  mfa           boolean NOT NULL,
  created_at    bigint NOT NULL,
  expires_at    bigint NOT NULL,
  last_seen_at  bigint NOT NULL,
  revoked_at    bigint
);
CREATE INDEX sessions_staff ON sessions (staff_id);

CREATE TABLE homes (
  id             uuid PRIMARY KEY,
  name           text NOT NULL,
  owner_contact  text,               -- where owner notices go (email); visible only to assigned staff
  created_at     bigint NOT NULL,
  created_by     uuid NOT NULL
);

-- One hub per home. The broker secret is 32 random bytes, so a SHA-256 hash is enough to store it.
CREATE TABLE hubs (
  hub_id              text PRIMARY KEY,
  home_id             uuid NOT NULL UNIQUE REFERENCES homes(id),
  broker_secret_hash  text NOT NULL,
  registered_at       bigint NOT NULL,
  registered_by       uuid NOT NULL,
  last_seen_at        bigint,
  telemetry           text              -- last telemetry message (allow-listed fields only), JSON
);

-- Staff may only see or act on homes they are assigned to (support and installers).
CREATE TABLE assignments (
  id          uuid PRIMARY KEY,
  staff_id    uuid NOT NULL REFERENCES staff(id),
  home_id     uuid NOT NULL REFERENCES homes(id),
  created_by  uuid NOT NULL,
  created_at  bigint NOT NULL,
  expires_at  bigint,
  revoked_at  bigint
);
CREATE UNIQUE INDEX assignments_one_active ON assignments (staff_id, home_id) WHERE revoked_at IS NULL;

-- Append-only, hash-chained security audit log. details is stored as the exact JSON text that was
-- hashed (jsonb would reorder keys and break verification).
CREATE TABLE audit_log (
  seq        bigserial PRIMARY KEY,
  id         uuid NOT NULL UNIQUE,
  at         bigint NOT NULL,
  actor      text NOT NULL,
  action     text NOT NULL,
  outcome    text NOT NULL CHECK (outcome IN ('allowed', 'denied', 'ok', 'error')),
  target     text,
  home_id    uuid,
  details    text NOT NULL,
  prev_hash  text NOT NULL,
  hash       text NOT NULL UNIQUE
);
CREATE INDEX audit_log_home ON audit_log (home_id, seq);

CREATE FUNCTION voltax_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END
$$;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION voltax_append_only();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION voltax_append_only();

CREATE TABLE cloud_meta (
  key    text PRIMARY KEY,
  value  text NOT NULL
);
