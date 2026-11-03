-- Daily play clicks per game, bucketed by US/Eastern date (YYYY-MM-DD).
CREATE TABLE game_click_days (
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  clicks INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (game_id, day)
);
