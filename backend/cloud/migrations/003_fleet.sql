-- Fleet operations: signed release registry and staged hub rollouts.

-- Every release is accepted only with a valid minisign signature from the VOLTEX release key; the
-- exact signed bytes are kept so anyone can re-verify them later.
CREATE TABLE releases (
  id               uuid PRIMARY KEY,
  kind             text NOT NULL CHECK (kind IN ('hub', 'esp32')),
  version          text NOT NULL,
  manifest         text NOT NULL,
  signature        text NOT NULL,
  key_id           text NOT NULL,
  trusted_comment  text NOT NULL,
  min_from_version text,
  board            text,
  notes            text,
  created_at       bigint NOT NULL,
  created_by       uuid NOT NULL REFERENCES staff(id),
  withdrawn_at     bigint,
  UNIQUE (kind, version)
);

-- Staged hub rollouts: stage 0 = one canary hub, then cumulative percentages. One active at a time.
CREATE TABLE rollouts (
  id                uuid PRIMARY KEY,
  kind              text NOT NULL DEFAULT 'hub' CHECK (kind = 'hub'),
  release_id        uuid NOT NULL REFERENCES releases(id),
  status            text NOT NULL CHECK (status IN ('running', 'halted', 'completed', 'cancelled')),
  stages            text NOT NULL,
  stage             integer NOT NULL,
  max_failure_rate  double precision NOT NULL,
  health_window_ms  bigint NOT NULL,
  stage_started_at  bigint NOT NULL,
  halt_reason       text,
  created_at        bigint NOT NULL,
  created_by        uuid NOT NULL REFERENCES staff(id),
  -- The super admin in whose name offers are signed: the creator, or whoever resumed it last.
  -- Re-checked before every step; the rollout halts if they are no longer an active super admin.
  acting_admin      uuid NOT NULL REFERENCES staff(id),
  updated_at        bigint NOT NULL
);
CREATE UNIQUE INDEX rollouts_one_active ON rollouts (kind) WHERE status IN ('running', 'halted');

CREATE TABLE rollout_targets (
  rollout_id    uuid NOT NULL REFERENCES rollouts(id),
  hub_id        text NOT NULL REFERENCES hubs(hub_id),
  stage         integer NOT NULL,
  state         text NOT NULL CHECK (state IN ('pending', 'offered', 'skipped', 'idle', 'awaiting_approval', 'declined', 'withdrawn',
                                                'requested', 'applying', 'done', 'failed', 'rolled_back')),
  from_version  text,
  offered_at    bigint,
  updated_at    bigint NOT NULL,
  detail        text,
  PRIMARY KEY (rollout_id, hub_id)
);
CREATE INDEX rollout_targets_hub ON rollout_targets (hub_id);
