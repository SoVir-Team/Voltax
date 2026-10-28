-- Rooms: a label the owner sets per device (null = shown under the device name, as before).
ALTER TABLE devices ADD COLUMN room TEXT;

-- Browser push subscriptions, one row per browser. Opt-in per client; removed when the client is
-- revoked or the push service reports the subscription gone. Notifications are a convenience only:
-- the in-app event log stays the record, and nothing is ever authorised by a push.
CREATE TABLE push_subscriptions (
  endpoint    TEXT PRIMARY KEY,
  client_id   TEXT NOT NULL REFERENCES clients(client_id),
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX push_subscriptions_client ON push_subscriptions (client_id);
