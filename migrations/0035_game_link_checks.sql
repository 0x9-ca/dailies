-- Admin link-health checks: last result of the daily play-URL check (link_status 0 = network error/timeout)
-- and consecutive failures. Separate from link_fail_count/last_checked_at, which drive the auto-report.
ALTER TABLE games ADD COLUMN link_checked_at TEXT;
ALTER TABLE games ADD COLUMN link_status INTEGER;
ALTER TABLE games ADD COLUMN link_failures INTEGER NOT NULL DEFAULT 0;
