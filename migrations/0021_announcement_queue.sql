-- Newly approved games waiting to be announced in Discord. The every-minute cron posts them as one message once
-- approvals have been quiet for a few minutes (see flushAnnouncementQueue), then removes the rows.
CREATE TABLE announcement_queue (
  game_id TEXT PRIMARY KEY,
  queued_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
);
