-- Twitch streamers an editor/admin has verified by hand, for those who aren't affiliates or partners (or haven't
-- signed in yet). When the streamer signs in with Twitch, or if their account already exists, they become a verified
-- creator (creator_type 'manual') with a list of their own, as an affiliate or partner would.
CREATE TABLE creator_allowlist (
  twitch_user_id TEXT PRIMARY KEY,
  twitch_login TEXT NOT NULL,
  added_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
