-- When a user last cleared their play history. Other devices wipe their local play data once when they see a newer value.
CREATE TABLE user_plays_reset (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  reset_at TEXT NOT NULL
);
