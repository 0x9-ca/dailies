-- Played games synced across a signed-in user's devices. One row per play (ISO UTC instant); about 120 days are kept
-- (pruned on write). user_streaks holds the day streak and the per-day play counts behind the rotation heatmap.
CREATE TABLE user_plays (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  played_at TEXT NOT NULL,
  PRIMARY KEY (user_id, game_id, played_at)
);
CREATE INDEX idx_user_plays_user_played ON user_plays(user_id, played_at);

-- last = viewer-local "YYYY-MM-DD" of the last day the whole rotation was played; day_log = JSON { "YYYY-MM-DD": games }.
CREATE TABLE user_streaks (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last TEXT NOT NULL DEFAULT '',
  count INTEGER NOT NULL DEFAULT 0,
  day_log TEXT NOT NULL DEFAULT '{}'
);
