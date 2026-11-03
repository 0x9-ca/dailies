-- Aggregated client-side JS errors reported by browsers (POST /api/client-errors); pruned after 30 days.
CREATE TABLE client_errors (
  fingerprint TEXT PRIMARY KEY,
  message TEXT NOT NULL,
  source TEXT,
  line INTEGER,
  col INTEGER,
  stack TEXT,
  page TEXT,
  version TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_client_errors_last_seen ON client_errors(last_seen);
