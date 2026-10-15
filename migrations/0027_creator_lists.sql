-- Verified content creators. users.creator_type is 'affiliate' or 'partner' (from Twitch's broadcaster_type, refreshed at
-- every Twitch sign-in) or 'manual' (granted by an editor/admin). A creator gets one public list of their own
-- (curated_lists.kind = 'creator', owned by them), created automatically and open to suggestions by default.
ALTER TABLE users ADD COLUMN creator_type TEXT;
ALTER TABLE curated_lists ADD COLUMN kind TEXT NOT NULL DEFAULT 'curated' CHECK (kind IN ('curated', 'creator'));
CREATE UNIQUE INDEX idx_curated_lists_one_creator ON curated_lists(owner_user_id) WHERE kind = 'creator';
