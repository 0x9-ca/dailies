ALTER TABLE games RENAME TO games_old;

CREATE TABLE games (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  url TEXT NOT NULL,
  canonical_url TEXT NOT NULL UNIQUE,
  description TEXT,
  source_name TEXT,
  source_url TEXT,
  submitted_by_user_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'disabled')),
  moderation_note TEXT,
  score REAL NOT NULL DEFAULT 0,
  vote_up_count INTEGER NOT NULL DEFAULT 0,
  vote_down_count INTEGER NOT NULL DEFAULT 0,
  report_count INTEGER NOT NULL DEFAULT 0,
  link_fail_count INTEGER NOT NULL DEFAULT 0,
  last_checked_at TEXT,
  approved_at TEXT,
  approved_by_user_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (submitted_by_user_id) REFERENCES users(id),
  FOREIGN KEY (approved_by_user_id) REFERENCES users(id)
);

INSERT INTO games (id, title, slug, url, canonical_url, description, source_name, source_url, submitted_by_user_id, status, moderation_note, score, vote_up_count, vote_down_count, report_count, link_fail_count, last_checked_at, approved_at, approved_by_user_id, created_at, updated_at)
  SELECT id, title, slug, url, canonical_url, description, source_name, source_url, submitted_by_user_id, status, moderation_note, score, vote_up_count, vote_down_count, report_count, link_fail_count, last_checked_at, approved_at, approved_by_user_id, created_at, updated_at
  FROM games_old;

DROP TABLE games_old;

CREATE INDEX idx_games_status_created ON games(status, created_at DESC);
CREATE INDEX idx_games_status_score ON games(status, score DESC);
