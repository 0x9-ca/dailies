-- Migration 0012 renamed games -> games_old then recreated games and dropped games_old.
-- SQLite auto-rewrote FK clauses in dependent tables to point at games_old, which no
-- longer exists. This rebuilds each affected table with FKs restored to games(id).

PRAGMA foreign_keys = OFF;

ALTER TABLE game_categories RENAME TO game_categories_old;
CREATE TABLE game_categories (
  game_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  assigned_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (game_id, category_id),
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE,
  FOREIGN KEY (assigned_by_user_id) REFERENCES users(id)
);
INSERT INTO game_categories (game_id, category_id, assigned_by_user_id, created_at)
  SELECT game_id, category_id, assigned_by_user_id, created_at FROM game_categories_old;
DROP TABLE game_categories_old;
CREATE INDEX idx_game_categories_category ON game_categories(category_id, game_id);

ALTER TABLE votes RENAME TO votes_old;
CREATE TABLE votes (
  user_id TEXT NOT NULL,
  game_id TEXT NOT NULL,
  value INTEGER NOT NULL CHECK (value IN (-1, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, game_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
);
INSERT INTO votes (user_id, game_id, value, created_at, updated_at)
  SELECT user_id, game_id, value, created_at, updated_at FROM votes_old;
DROP TABLE votes_old;
CREATE INDEX idx_votes_game ON votes(game_id);

ALTER TABLE favorites RENAME TO favorites_old;
CREATE TABLE favorites (
  user_id TEXT NOT NULL,
  game_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  weekday_mask INTEGER NOT NULL DEFAULT 127,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, game_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
);
INSERT INTO favorites (user_id, game_id, position, weekday_mask, created_at, updated_at)
  SELECT user_id, game_id, position, weekday_mask, created_at, updated_at FROM favorites_old;
DROP TABLE favorites_old;
CREATE UNIQUE INDEX idx_favorites_user_position ON favorites(user_id, position);

ALTER TABLE reports RENAME TO reports_old;
CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  reported_by_user_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('broken', 'not_daily', 'spam', 'other')),
  note TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  resolved_by_user_id TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
  FOREIGN KEY (reported_by_user_id) REFERENCES users(id),
  FOREIGN KEY (resolved_by_user_id) REFERENCES users(id)
);
INSERT INTO reports (id, game_id, reported_by_user_id, reason, note, status, resolved_by_user_id, resolved_at, created_at)
  SELECT id, game_id, reported_by_user_id, reason, note, status, resolved_by_user_id, resolved_at, created_at FROM reports_old;
DROP TABLE reports_old;
CREATE INDEX idx_reports_status_created ON reports(status, created_at DESC);

ALTER TABLE curated_list_items RENAME TO curated_list_items_old;
CREATE TABLE curated_list_items (
  curated_list_id TEXT NOT NULL,
  game_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  added_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (curated_list_id, game_id),
  FOREIGN KEY (curated_list_id) REFERENCES curated_lists(id) ON DELETE CASCADE,
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
  FOREIGN KEY (added_by_user_id) REFERENCES users(id)
);
INSERT INTO curated_list_items (curated_list_id, game_id, position, added_by_user_id, created_at)
  SELECT curated_list_id, game_id, position, added_by_user_id, created_at FROM curated_list_items_old;
DROP TABLE curated_list_items_old;
CREATE UNIQUE INDEX idx_curated_list_position ON curated_list_items(curated_list_id, position);

ALTER TABLE anonymous_favorites RENAME TO anonymous_favorites_old;
CREATE TABLE anonymous_favorites (
  anon_id TEXT NOT NULL,
  game_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (anon_id, game_id),
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
);
INSERT INTO anonymous_favorites (anon_id, game_id, created_at)
  SELECT anon_id, game_id, created_at FROM anonymous_favorites_old;
DROP TABLE anonymous_favorites_old;
CREATE INDEX idx_anonymous_favorites_game ON anonymous_favorites(game_id);

ALTER TABLE anonymous_votes RENAME TO anonymous_votes_old;
CREATE TABLE anonymous_votes (
  anon_ip_hash TEXT NOT NULL,
  game_id TEXT NOT NULL,
  value INTEGER NOT NULL CHECK (value IN (-1, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (anon_ip_hash, game_id),
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
);
INSERT INTO anonymous_votes (anon_ip_hash, game_id, value, created_at, updated_at)
  SELECT anon_ip_hash, game_id, value, created_at, updated_at FROM anonymous_votes_old;
DROP TABLE anonymous_votes_old;
CREATE INDEX idx_anonymous_votes_game ON anonymous_votes(game_id);

PRAGMA foreign_keys = ON;
