-- Stream history: every game set as Now playing on a list (kept 90 days).
CREATE TABLE list_play_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  list_id TEXT NOT NULL REFERENCES curated_lists(id) ON DELETE CASCADE,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL
);
CREATE INDEX idx_list_play_history_list_started ON list_play_history(list_id, started_at);
