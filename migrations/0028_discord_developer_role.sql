-- Which verified developers should get the "Dle Developer" Discord role, and whether they have it yet.
--
-- One row per user who has a verified game claim and a linked Discord account (kept in step by
-- syncGrantRows in src/lib/developer-role.ts). granted_at is when the role was confirmed on their member in our
-- server; NULL means still waiting, typically because they have not joined the server yet. next_check_at spaces
-- out the checks for those who are waiting. The role is never taken away automatically.

CREATE TABLE discord_role_grants (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  discord_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  granted_at TEXT,
  checked_at TEXT,
  next_check_at TEXT
);

CREATE INDEX idx_discord_role_grants_pending ON discord_role_grants(granted_at, next_check_at);
