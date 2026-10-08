-- Games signed-in visitors suggest for a curated list, and who agrees with each suggestion (the suggester's own
-- agreement is the first vote). Editors, admins and the list's Twitch owner move suggestions onto the list or
-- dismiss them.
CREATE TABLE list_suggestions (
  curated_list_id TEXT NOT NULL,
  game_id TEXT NOT NULL,
  suggested_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (curated_list_id, game_id),
  FOREIGN KEY (curated_list_id) REFERENCES curated_lists(id) ON DELETE CASCADE,
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
  FOREIGN KEY (suggested_by_user_id) REFERENCES users(id)
);

CREATE TABLE list_suggestion_votes (
  curated_list_id TEXT NOT NULL,
  game_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (curated_list_id, game_id, user_id),
  FOREIGN KEY (curated_list_id, game_id) REFERENCES list_suggestions(curated_list_id, game_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Games that can't be suggested for a list again: removed from the list ('removed') or a dismissed suggestion
-- ('dismissed'). Adding the game to the list directly clears it.
CREATE TABLE list_blocked_games (
  curated_list_id TEXT NOT NULL,
  game_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('removed', 'dismissed')),
  blocked_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (curated_list_id, game_id),
  FOREIGN KEY (curated_list_id) REFERENCES curated_lists(id) ON DELETE CASCADE,
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
  FOREIGN KEY (blocked_by_user_id) REFERENCES users(id)
);
