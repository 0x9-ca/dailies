-- "Now playing": the game a creator is on right now, shown on their list, in stream mode and in the OBS overlay.
-- Treated as unset once now_playing_at is over 6 hours old.
ALTER TABLE curated_lists ADD COLUMN now_playing_game_id TEXT REFERENCES games(id) ON DELETE SET NULL;
ALTER TABLE curated_lists ADD COLUMN now_playing_at TEXT;
