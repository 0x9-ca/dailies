-- Web Push subscriptions for reset reminders (payload-less VAPID push, see src/lib/push.ts).
CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_sent_day TEXT,
  lead_minutes INTEGER NOT NULL DEFAULT 60,
  tz TEXT NOT NULL
);
CREATE INDEX idx_push_subscriptions_user ON push_subscriptions(user_id);

-- One row per subscription, game and reset (day = the reset's date in the subscription's time zone), so a game is
-- announced once per reset even though the cron runs every 15 minutes. Pruned after 3 days.
CREATE TABLE push_sent (
  subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  game_id TEXT NOT NULL,
  day TEXT NOT NULL,
  PRIMARY KEY (subscription_id, game_id, day)
);
