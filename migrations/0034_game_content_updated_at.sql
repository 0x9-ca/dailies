-- When a game's visible content last changed (sitemap lastmod). updated_at also moves on the daily
-- score and link-check runs, so it can't be used for that.
ALTER TABLE games ADD COLUMN content_updated_at TEXT;
UPDATE games SET content_updated_at = COALESCE(approved_at, created_at);
