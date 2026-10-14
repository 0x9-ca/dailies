-- Opt-in public profiles at /u/<handle>. Nothing is public until profile_public = 1 (and a handle is set).
-- profile_avatar_provider says which linked account's picture to show; oauth_accounts.avatar_url holds the
-- provider's public CDN image URL, refreshed on every sign-in or link (it is not a token).
ALTER TABLE users ADD COLUMN profile_handle TEXT;
ALTER TABLE users ADD COLUMN profile_public INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN profile_show_rotation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN profile_show_twitch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN profile_avatar_provider TEXT;
CREATE UNIQUE INDEX idx_users_profile_handle ON users(profile_handle) WHERE profile_handle IS NOT NULL;
ALTER TABLE oauth_accounts ADD COLUMN avatar_url TEXT;
