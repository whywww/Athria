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

