-- Allow 'twitch' as an OAuth provider. Recreates the table to change the CHECK constraint (see 0008).

PRAGMA foreign_keys = OFF;

CREATE TABLE oauth_accounts_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'github', 'discord', 'twitch')),
  provider_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(provider, provider_user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

INSERT INTO oauth_accounts_new (id, user_id, provider, provider_user_id, created_at)
SELECT id, user_id, provider, provider_user_id, created_at FROM oauth_accounts;

DROP TABLE oauth_accounts;
ALTER TABLE oauth_accounts_new RENAME TO oauth_accounts;

PRAGMA foreign_keys = ON;
