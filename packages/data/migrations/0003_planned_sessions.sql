CREATE TABLE IF NOT EXISTS plan_activations (
  plan_version_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  effective_start_date TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS planned_sessions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  plan_version_id TEXT NOT NULL,
  scheduled_date TEXT NOT NULL,
  status TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS planned_sessions_owner_plan_date ON planned_sessions(owner_id, plan_version_id, scheduled_date);
CREATE TABLE IF NOT EXISTS planned_session_changes (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  client_request_id TEXT NOT NULL,
  plan_version_id TEXT NOT NULL,
  scheduled_date TEXT NOT NULL,
  mode TEXT NOT NULL,
  before_data TEXT NOT NULL,
  after_data TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS planned_changes_owner_request ON planned_session_changes(owner_id, client_request_id);
INSERT OR IGNORE INTO athria_migrations(version, applied_at) VALUES (3, CURRENT_TIMESTAMP);
