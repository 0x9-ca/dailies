-- Add discord to the list of allowed OAuth providers
-- SQLite doesn't support ALTER TABLE to modify CHECK constraints directly,
-- so we need to recreate the table

PRAGMA foreign_keys = OFF;

-- Create new table with updated constraint
CREATE TABLE oauth_accounts_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'github', 'discord')),
  provider_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(provider, provider_user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Copy data from old table
INSERT INTO oauth_accounts_new (id, user_id, provider, provider_user_id, created_at)
SELECT id, user_id, provider, provider_user_id, created_at FROM oauth_accounts;

-- Drop old table and rename new one
DROP TABLE oauth_accounts;
ALTER TABLE oauth_accounts_new RENAME TO oauth_accounts;

PRAGMA foreign_keys = ON;
