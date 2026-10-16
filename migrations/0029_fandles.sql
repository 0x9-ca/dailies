-- Fan-dles: games made by a streamer's community, shown on the streamer's creator list. A verified developer joins a
-- streamer's Fan-dles by proving (with a one-time Twitch check) that they subscribe to the streamer, or have followed
-- them for over a week. Only the result is kept, never a Twitch token. Membership lapses after expires_at and is
-- renewed by checking again.
CREATE TABLE fandle_members (
  list_id TEXT NOT NULL REFERENCES curated_lists(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('follow', 'sub')),
  followed_at TEXT,
  verified_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  PRIMARY KEY (list_id, user_id)
);
CREATE INDEX idx_fandle_members_user ON fandle_members(user_id);

-- Games the streamer (or staff) has hidden from their Fan-dles.
CREATE TABLE fandle_hidden (
  list_id TEXT NOT NULL REFERENCES curated_lists(id) ON DELETE CASCADE,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  hidden_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (list_id, game_id)
);

ALTER TABLE curated_lists ADD COLUMN fandles_enabled INTEGER NOT NULL DEFAULT 1;
