-- Fan-dles members an admin adds by hand (no Twitch check). SQLite can't change a CHECK constraint, so the table is
-- rebuilt with source 'manual' allowed and a record of which admin added them.
CREATE TABLE fandle_members_new (
  list_id TEXT NOT NULL REFERENCES curated_lists(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('follow', 'sub', 'manual')),
  followed_at TEXT,
  verified_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  added_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (list_id, user_id)
);
INSERT INTO fandle_members_new (list_id, user_id, source, followed_at, verified_at, expires_at)
  SELECT list_id, user_id, source, followed_at, verified_at, expires_at FROM fandle_members;
DROP TABLE fandle_members;
ALTER TABLE fandle_members_new RENAME TO fandle_members;
CREATE INDEX idx_fandle_members_user ON fandle_members(user_id);
