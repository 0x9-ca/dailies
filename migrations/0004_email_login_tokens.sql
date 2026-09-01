CREATE TABLE email_login_tokens (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  user_id TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  magic_token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  request_ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_email_login_tokens_email ON email_login_tokens(email, created_at DESC);
CREATE INDEX idx_email_login_tokens_expiry ON email_login_tokens(expires_at);
