CREATE TABLE anonymous_votes (
  anon_ip_hash TEXT NOT NULL,
  game_id TEXT NOT NULL,
  value INTEGER NOT NULL CHECK (value IN (-1, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (anon_ip_hash, game_id),
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
);

CREATE INDEX idx_anonymous_votes_game ON anonymous_votes(game_id);
