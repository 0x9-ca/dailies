-- Curated lists can be tagged with a Twitch channel. twitch_user_id (stable numeric id) is what grants
-- edit rights to the matching Twitch login; twitch_login is only for display and linking.
ALTER TABLE curated_lists ADD COLUMN twitch_login TEXT;
ALTER TABLE curated_lists ADD COLUMN twitch_user_id TEXT;
