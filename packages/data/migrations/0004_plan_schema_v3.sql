CREATE TABLE IF NOT EXISTS plan_schema_migration_backups (
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  data TEXT NOT NULL,
  validation TEXT,
  migrated_at TEXT NOT NULL,
  PRIMARY KEY(table_name, row_id)
);
