-- Game pages look up which public lists played a game recently.
CREATE INDEX idx_list_play_history_game_started ON list_play_history(game_id, started_at);
