import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const profiles = sqliteTable("profiles", {
  ownerId: text("owner_id").primaryKey(),
  data: text("data", { mode: "json" }).notNull(),
  updatedAt: text("updated_at").notNull(),
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

export const trainingSessionSources = sqliteTable("training_session_sources", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  trainingSessionId: text("training_session_id").notNull(),
  source: text("source").notNull(),
  externalId: text("external_id").notNull(),
  localDate: text("local_date").notNull(),
  startAt: text("start_at").notNull(),
  data: text("data", { mode: "json" }).notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("session_sources_owner_source_external").on(table.ownerId, table.source, table.externalId),
  index("session_sources_owner_date").on(table.ownerId, table.localDate),
  index("session_sources_canonical").on(table.trainingSessionId),
]);

export const planWorkoutMatches = sqliteTable("plan_workout_matches", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  plannedSessionId: text("planned_session_id").notNull(),
  trainingSessionId: text("training_session_id").notNull(),
  method: text("method").notNull(),
  confidence: integer("confidence").notNull(),
  algorithmVersion: text("algorithm_version").notNull(),
  evidence: text("evidence", { mode: "json" }).notNull(),
  matchedAt: text("matched_at").notNull(),
}, (table) => [
  uniqueIndex("plan_matches_owner_plan").on(table.ownerId, table.plannedSessionId),
  uniqueIndex("plan_matches_owner_workout").on(table.ownerId, table.trainingSessionId),
]);

export const workoutPlanExclusions = sqliteTable("workout_plan_exclusions", {
  ownerId: text("owner_id").notNull(),
  trainingSessionId: text("training_session_id").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("workout_plan_exclusions_owner_workout").on(table.ownerId, table.trainingSessionId)]);

export const plannedSessionEvents = sqliteTable("planned_session_events", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  plannedSessionId: text("planned_session_id").notNull(),
  action: text("action").notNull(),
  fromDate: text("from_date"),
  toDate: text("to_date"),
  reasonCode: text("reason_code"),
  reasonNote: text("reason_note"),
  revisionBefore: integer("revision_before").notNull(),
  revisionAfter: integer("revision_after").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [index("planned_session_events_owner_session").on(table.ownerId, table.plannedSessionId)]);

export const wellness = sqliteTable("wellness", {
  ownerId: text("owner_id").notNull(),
  day: text("day").notNull(),
  data: text("data", { mode: "json" }).notNull(),
  updatedAt: text("updated_at").notNull(),
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

// One database is one local Athria user and therefore owns exactly one vault
// identity. The UUID is an identifier, never encryption key material.
export const vaultMeta = sqliteTable("vault_meta", {
  id: integer("id").primaryKey(),
  databaseUuid: text("database_uuid").notNull().unique(),
  formatVersion: integer("format_version").notNull(),
  kdfAlgorithm: text("kdf_algorithm"),
  kdfMemoryKib: integer("kdf_memory_kib"),
  kdfIterations: integer("kdf_iterations"),
  kdfParallelism: integer("kdf_parallelism"),
  salt: text("salt"),
  wrapNonce: text("wrap_nonce"),
  wrappedMasterKey: text("wrapped_master_key"),
  checkNonce: text("check_nonce"),
  checkCiphertext: text("check_ciphertext"),
  updatedAt: text("updated_at").notNull(),
});

export const connectionSecrets = sqliteTable("connection_secrets", {
  source: text("source").primaryKey(),
  config: text("config", { mode: "json" }).notNull(),
  cipherVersion: integer("cipher_version").notNull(),
  nonce: text("nonce").notNull(),
  ciphertext: text("ciphertext").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// Created by the v23 migration for an early credential-export design that
// wrote plaintext credentials into backup files. The v24 connection vault
// superseded it: this table is never written and stays empty, and connection
// keys only ever exist as ciphertext in connection_secrets.
export const connectionCredentials = sqliteTable("connection_credentials", {
  ownerId: text("owner_id").notNull(),
  source: text("source").notNull(),
  data: text("data", { mode: "json" }).notNull(),
  exportedAt: text("exported_at").notNull(),
}, (table) => [uniqueIndex("connection_credentials_owner_source").on(table.ownerId, table.source)]);

export const sessionTemplates = sqliteTable("session_templates", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  data: text("data", { mode: "json" }).notNull(),
  revision: integer("revision").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [uniqueIndex("templates_owner_id").on(table.ownerId, table.id)]);

export const templateDismissals = sqliteTable("template_dismissals", {
  ownerId: text("owner_id").notNull(),
  templateId: text("template_id").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("template_dismissals_owner_template").on(table.ownerId, table.templateId)]);

export const currentMesocycles = sqliteTable("current_mesocycles", {
  ownerId: text("owner_id").primaryKey(),
  data: text("data", { mode: "json" }).notNull(),
  revision: integer("revision").notNull(),
  updatedAt: text("updated_at").notNull(),
});

