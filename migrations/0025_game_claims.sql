-- Developer claims: a signed-in user proves they run a game, either by putting a token on the game's page or site
-- (method meta/file, checked automatically) or with evidence an editor reviews (method manual).
--   pending  = token issued, not proven yet (also what a verified claim drops back to when the game's URL changes)
--   review   = manual evidence submitted, waiting for an editor
--   verified = the user may edit the game; at most one per game
--   rejected / revoked = closed by an editor, or the token disappeared from the site
CREATE TABLE game_claims (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'review', 'verified', 'rejected', 'revoked')),
  method TEXT CHECK (method IN ('meta', 'file', 'manual')),
  evidence TEXT,
  verified_url TEXT,
  fail_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  verified_at TEXT,
  last_checked_at TEXT,
  UNIQUE (game_id, user_id)
);
CREATE UNIQUE INDEX idx_game_claims_one_verified ON game_claims(game_id) WHERE status = 'verified';
CREATE INDEX idx_game_claims_user ON game_claims(user_id);
CREATE INDEX idx_game_claims_status ON game_claims(status, last_checked_at);
