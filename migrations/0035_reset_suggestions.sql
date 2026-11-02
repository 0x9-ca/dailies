-- Crowdsourced reset-time suggestions from signed-in users, reviewed at /admin/resets.
CREATE TABLE reset_suggestions (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reset_basis TEXT NOT NULL CHECK (reset_basis IN ('local', 'server')),
  reset_time_minutes INTEGER NOT NULL CHECK (reset_time_minutes BETWEEN 0 AND 1439),
  reset_timezone TEXT,
  note TEXT CHECK (note IS NULL OR length(note) <= 200),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'applied', 'dismissed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  resolved_by TEXT REFERENCES users(id)
);

-- One open suggestion per user per game; a new one replaces it.
CREATE UNIQUE INDEX idx_reset_suggestions_open_user_game ON reset_suggestions(game_id, user_id) WHERE status = 'open';
CREATE INDEX idx_reset_suggestions_open ON reset_suggestions(status, game_id);
