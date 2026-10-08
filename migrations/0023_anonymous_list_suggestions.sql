-- Logged-out visitors can suggest and vote too, identified like anonymous game votes (hashed IP). Votes now carry
-- a voter key ('user:<id>' or 'anon:<hash>') instead of a user id, and a suggestion records either suggester.
-- Both tables were still empty when this ran (0022 had only just shipped), so they are recreated.
DROP TABLE list_suggestion_votes;
DROP TABLE list_suggestions;

CREATE TABLE list_suggestions (
  curated_list_id TEXT NOT NULL,
  game_id TEXT NOT NULL,
  suggested_by_user_id TEXT,
  suggested_by_anon_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (curated_list_id, game_id),
  FOREIGN KEY (curated_list_id) REFERENCES curated_lists(id) ON DELETE CASCADE,
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
  FOREIGN KEY (suggested_by_user_id) REFERENCES users(id)
);

CREATE TABLE list_suggestion_votes (
  curated_list_id TEXT NOT NULL,
  game_id TEXT NOT NULL,
  voter_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (curated_list_id, game_id, voter_key),
  FOREIGN KEY (curated_list_id, game_id) REFERENCES list_suggestions(curated_list_id, game_id) ON DELETE CASCADE
);
