-- Executed transactionally by AthriaRepository.migratePlanSchemaV4 because it
-- extracts the latest v3 plan JSON before removing the legacy tables.
CREATE TABLE session_templates (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  data TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX templates_owner_id ON session_templates(owner_id, id);
CREATE TABLE current_mesocycles (
  owner_id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  revision INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
-- planned_sessions and planned_session_changes are rebuilt without a required
-- plan-version relationship. Legacy plan tables and plan approvals are removed.
INSERT INTO athria_migrations(version, applied_at) VALUES (5, CURRENT_TIMESTAMP);
