import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const profiles = sqliteTable("profiles", {
  ownerId: text("owner_id").primaryKey(),
  data: text("data", { mode: "json" }).notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const preferences = sqliteTable("preferences", {
  ownerId: text("owner_id").primaryKey(),
  data: text("data", { mode: "json" }).notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const exercises = sqliteTable("exercises", {
  key: text("key").primaryKey(),
  data: text("data", { mode: "json" }).notNull(),
});

export const trainingSessions = sqliteTable("training_sessions", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  source: text("source").notNull(),
  externalId: text("external_id").notNull(),
  modality: text("modality").notNull(),
  startAt: text("start_at").notNull(),
  data: text("data", { mode: "json" }).notNull(),
}, (table) => [
  uniqueIndex("sessions_owner_source_external").on(table.ownerId, table.source, table.externalId),
  index("sessions_owner_start").on(table.ownerId, table.startAt),
]);

export const wellnessDaily = sqliteTable("wellness_daily", {
  ownerId: text("owner_id").notNull(),
  day: text("day").notNull(),
  data: text("data", { mode: "json" }).notNull(),
}, (table) => [uniqueIndex("wellness_owner_day").on(table.ownerId, table.day)]);

export const importBatches = sqliteTable("import_batches", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  source: text("source").notNull(),
  contentHash: text("content_hash").notNull(),
  fileName: text("file_name").notNull(),
  parserVersion: text("parser_version").notNull(),
  status: text("status").notNull(),
  data: text("data", { mode: "json" }).notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("imports_owner_source_hash").on(table.ownerId, table.source, table.contentHash)]);

export const rawRecords = sqliteTable("raw_records", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  source: text("source").notNull(),
  externalKey: text("external_key").notNull(),
  contentHash: text("content_hash").notNull(),
  payload: text("payload", { mode: "json" }).notNull(),
}, (table) => [uniqueIndex("raw_owner_source_key").on(table.ownerId, table.source, table.externalKey)]);

export const connectionSyncState = sqliteTable("connection_sync_state", {
  ownerId: text("owner_id").notNull(),
  source: text("source").notNull(),
  lastAttemptAt: text("last_attempt_at").notNull(),
  lastSuccessAt: text("last_success_at"),
  rangeStart: text("range_start").notNull(),
  rangeEnd: text("range_end").notNull(),
  status: text("status").notNull(),
  data: text("data", { mode: "json" }).notNull(),
}, (table) => [uniqueIndex("connection_sync_owner_source").on(table.ownerId, table.source)]);

export const sessionTemplates = sqliteTable("session_templates", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  data: text("data", { mode: "json" }).notNull(),
  revision: integer("revision").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [uniqueIndex("templates_owner_id").on(table.ownerId, table.id)]);

export const currentMesocycles = sqliteTable("current_mesocycles", {
  ownerId: text("owner_id").primaryKey(),
  data: text("data", { mode: "json" }).notNull(),
  revision: integer("revision").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// Legacy tables are declared only so the upgrade reader can access v3 databases.
export const planDrafts = sqliteTable("plan_drafts", { id: text("id").primaryKey(), ownerId: text("owner_id").notNull(), clientRequestId: text("client_request_id").notNull(), data: text("data", { mode: "json" }).notNull(), validation: text("validation", { mode: "json" }).notNull(), updatedAt: text("updated_at").notNull() });
export const planVersions = sqliteTable("plan_versions", { id: text("id").primaryKey(), ownerId: text("owner_id").notNull(), parentVersionId: text("parent_version_id"), versionNumber: integer("version_number").notNull(), data: text("data", { mode: "json" }).notNull(), createdAt: text("created_at").notNull() });
export const planActivations = sqliteTable("plan_activations", { planVersionId: text("plan_version_id").primaryKey(), ownerId: text("owner_id").notNull(), effectiveStartDate: text("effective_start_date").notNull(), revision: integer("revision").notNull() });

export const approvals = sqliteTable("approvals", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  subjectType: text("subject_type").notNull(),
  subjectId: text("subject_id").notNull(),
  approvedBy: text("approved_by").notNull(),
  approvedAt: text("approved_at").notNull(),
  snapshotHash: text("snapshot_hash").notNull(),
});

export const profileUpdateProposals = sqliteTable("profile_update_proposals", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  clientRequestId: text("client_request_id").notNull(),
  patch: text("patch", { mode: "json" }).notNull(),
  rationale: text("rationale").notNull(),
  baseSnapshotHash: text("base_snapshot_hash").notNull(),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("profile_updates_owner_request").on(table.ownerId, table.clientRequestId)]);

export const plannedSessions = sqliteTable("planned_sessions", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  planVersionId: text("plan_version_id"),
  scheduledDate: text("scheduled_date").notNull(),
  status: text("status").notNull(),
  data: text("data", { mode: "json" }).notNull(),
}, (table) => [index("planned_sessions_owner_date").on(table.ownerId, table.scheduledDate)]);

export const plannedSessionChanges = sqliteTable("planned_session_changes", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  clientRequestId: text("client_request_id").notNull(),
  planVersionId: text("plan_version_id"),
  scheduledDate: text("scheduled_date").notNull(),
  mode: text("mode").notNull(),
  beforeData: text("before_data", { mode: "json" }).notNull(),
  afterData: text("after_data", { mode: "json" }).notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("planned_changes_owner_request").on(table.ownerId, table.clientRequestId)]);

export const planSchemaMigrationBackups = sqliteTable("plan_schema_migration_backups", {
  tableName: text("table_name").notNull(),
  rowId: text("row_id").notNull(),
  data: text("data").notNull(),
  validation: text("validation"),
  migratedAt: text("migrated_at").notNull(),
}, (table) => [uniqueIndex("plan_schema_migration_backup_row").on(table.tableName, table.rowId)]);
