CREATE TABLE IF NOT EXISTS domain_progression_v7_reset_backups (
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  data TEXT NOT NULL,
  backed_up_at TEXT NOT NULL,
  PRIMARY KEY(table_name, row_id)
);

INSERT OR IGNORE INTO domain_progression_v7_reset_backups(table_name,row_id,data,backed_up_at)
  SELECT 'current_mesocycles', owner_id, data, CURRENT_TIMESTAMP FROM current_mesocycles;
INSERT OR IGNORE INTO domain_progression_v7_reset_backups(table_name,row_id,data,backed_up_at)
  SELECT 'planned_sessions', id, data, CURRENT_TIMESTAMP FROM planned_sessions;
INSERT OR IGNORE INTO domain_progression_v7_reset_backups(table_name,row_id,data,backed_up_at)
  SELECT 'planned_session_changes', id, json_object('beforeData',before_data,'afterData',after_data), CURRENT_TIMESTAMP FROM planned_session_changes;

DELETE FROM current_mesocycles;
DELETE FROM planned_sessions;
DELETE FROM planned_session_changes;
INSERT INTO athria_migrations(version, applied_at) VALUES (9, CURRENT_TIMESTAMP);
