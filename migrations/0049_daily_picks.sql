-- Recorded Games of the day, so past picks stay put when the game pool changes.
CREATE TABLE daily_picks (
  day TEXT PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  picked_at TEXT NOT NULL
);
