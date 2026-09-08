CREATE TABLE IF NOT EXISTS connection_sync_state (
  owner_id TEXT NOT NULL,
  source TEXT NOT NULL,
  last_attempt_at TEXT NOT NULL,
  last_success_at TEXT,
  range_start TEXT NOT NULL,
  range_end TEXT NOT NULL,
  status TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS connection_sync_owner_source ON connection_sync_state(owner_id, source);
INSERT OR IGNORE INTO athria_migrations(version, applied_at) VALUES (2, CURRENT_TIMESTAMP);
