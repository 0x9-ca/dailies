-- "Skip today" synced across a signed-in user's devices. day is the viewer-local YYYY-MM-DD; rows older than 3 days are pruned on write.
CREATE TABLE user_skips (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, day, game_id)
);
