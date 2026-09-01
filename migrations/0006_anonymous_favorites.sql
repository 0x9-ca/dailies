CREATE TABLE anonymous_favorites (
  anon_id TEXT NOT NULL,
  game_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (anon_id, game_id),
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
);

CREATE INDEX idx_anonymous_favorites_game ON anonymous_favorites(game_id);
