-- Indexes for lookups that the primary keys can't serve (they lead with the other column).
-- Trending/popular sorts and the activity stats read game_click_days by day range.
CREATE INDEX IF NOT EXISTS idx_game_click_days_day ON game_click_days(day, game_id, clicks);
-- "Players also play" joins favorites by game_id.
CREATE INDEX IF NOT EXISTS idx_favorites_game ON favorites(game_id, user_id);
-- Game pages list the public lists a game is on.
CREATE INDEX IF NOT EXISTS idx_curated_list_items_game ON curated_list_items(game_id);
-- Activity stats read stream history by time range across lists.
CREATE INDEX IF NOT EXISTS idx_list_play_history_started ON list_play_history(started_at);
