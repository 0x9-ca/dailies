-- Editors, admins and a list's Twitch owner can turn suggestions off for that list. Existing suggestions are kept
-- (hidden) while they're off and come back when they're turned on again.
ALTER TABLE curated_lists ADD COLUMN suggestions_enabled INTEGER NOT NULL DEFAULT 1;
