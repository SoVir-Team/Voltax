-- Fleet update offers from the cloud. The owner's policy (hub_meta 'update_policy': approve | auto)
-- decides; an approved offer becomes a request for the root updater (UpdateDropbox).
CREATE TABLE update_offers (
  rollout_id  TEXT PRIMARY KEY,
  version     TEXT NOT NULL,
  offered_at  INTEGER NOT NULL,
  offered_by  TEXT NOT NULL,  -- display name of the VOLTEX super admin
  status      TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'declined', 'withdrawn')),
  decided_at  INTEGER,
  decided_by  TEXT            -- client id, 'policy:auto' or 'cloud' (withdrawn)
);
