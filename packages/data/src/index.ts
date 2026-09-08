import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { and, desc, eq, gte, notInArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
  PLAN_SCHEMA_VERSION,
  TAXONOMY_VERSION,
  athleteProfileSchema,
  currentPlanSchema,
  defaultPreference,
  defaultProfile,
  exerciseDefinitionSchema,
  planDraftSchema,
  plannedSessionSchema,
  planValidationSchema,
  planVersionSchema,
  sessionTemplateSchema,
  storedSessionTemplateSchema,
  trainingPreferenceSchema,
  trainingSessionSchema,
  type AthleteProfile,
  type CurrentPlan,
  type ExerciseDefinition,
  type PlanDraft,
  type PlanValidation,
  type PlanVersion,
  type PlannedSession,
  type SessionTemplate,
  type StoredSessionTemplate,
  type TrainingPreference,
  type TrainingSession,
} from "@athria/schemas";
import * as schema from "./schema";

export const INITIAL_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS profiles (owner_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS preferences (owner_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS exercises (key TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS training_sessions (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, source TEXT NOT NULL, external_id TEXT NOT NULL, modality TEXT NOT NULL, start_at TEXT NOT NULL, data TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS sessions_owner_source_external ON training_sessions(owner_id, source, external_id);
CREATE INDEX IF NOT EXISTS sessions_owner_start ON training_sessions(owner_id, start_at);
CREATE TABLE IF NOT EXISTS wellness_daily (owner_id TEXT NOT NULL, day TEXT NOT NULL, data TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS wellness_owner_day ON wellness_daily(owner_id, day);
CREATE TABLE IF NOT EXISTS import_batches (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, source TEXT NOT NULL, content_hash TEXT NOT NULL, file_name TEXT NOT NULL, parser_version TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS imports_owner_source_hash ON import_batches(owner_id, source, content_hash);
CREATE TABLE IF NOT EXISTS raw_records (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, source TEXT NOT NULL, external_key TEXT NOT NULL, content_hash TEXT NOT NULL, payload TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS raw_owner_source_key ON raw_records(owner_id, source, external_key);
CREATE TABLE IF NOT EXISTS plan_drafts (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, client_request_id TEXT NOT NULL, data TEXT NOT NULL, validation TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS drafts_owner_request ON plan_drafts(owner_id, client_request_id);
CREATE TABLE IF NOT EXISTS plan_versions (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, parent_version_id TEXT, version_number INTEGER NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS versions_owner_number ON plan_versions(owner_id, version_number);
CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, approved_by TEXT NOT NULL, approved_at TEXT NOT NULL, snapshot_hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS profile_update_proposals (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, client_request_id TEXT NOT NULL, patch TEXT NOT NULL, rationale TEXT NOT NULL, base_snapshot_hash TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS profile_updates_owner_request ON profile_update_proposals(owner_id, client_request_id);
CREATE TABLE IF NOT EXISTS athria_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
INSERT OR IGNORE INTO athria_migrations(version, applied_at) VALUES (1, CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS connection_sync_state (owner_id TEXT NOT NULL, source TEXT NOT NULL, last_attempt_at TEXT NOT NULL, last_success_at TEXT, range_start TEXT NOT NULL, range_end TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS connection_sync_owner_source ON connection_sync_state(owner_id, source);
INSERT OR IGNORE INTO athria_migrations(version, applied_at) VALUES (2, CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS plan_activations (plan_version_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, effective_start_date TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS planned_sessions (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, plan_version_id TEXT NOT NULL, scheduled_date TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS planned_sessions_owner_plan_date ON planned_sessions(owner_id, plan_version_id, scheduled_date);
CREATE TABLE IF NOT EXISTS planned_session_changes (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, client_request_id TEXT NOT NULL, plan_version_id TEXT NOT NULL, scheduled_date TEXT NOT NULL, mode TEXT NOT NULL, before_data TEXT NOT NULL, after_data TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS planned_changes_owner_request ON planned_session_changes(owner_id, client_request_id);
INSERT OR IGNORE INTO athria_migrations(version, applied_at) VALUES (3, CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS plan_schema_migration_backups (table_name TEXT NOT NULL, row_id TEXT NOT NULL, data TEXT NOT NULL, validation TEXT, migrated_at TEXT NOT NULL, PRIMARY KEY(table_name, row_id));
`;

const parseJson = (value: unknown): unknown => typeof value === "string" ? JSON.parse(value) : value;
const contentHash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function inferPhaseType(name: string): "foundation" | "progression" | "deload" | "peak" | "test" | "recovery" {
  const value = name.toLowerCase();
  if (/deload|减量/.test(value)) return "deload";
  if (/peak|巅峰/.test(value)) return "peak";
  if (/test|测试/.test(value)) return "test";
  if (/recovery|恢复/.test(value)) return "recovery";
  if (/base|baseline|基础|基线/.test(value)) return "foundation";
  return "progression";
}

const movements = new Set(["squat", "hinge", "lunge", "horizontal_push", "vertical_push", "horizontal_pull", "vertical_pull", "carry", "rotation", "anti_rotation", "flexion", "extension", "abduction", "adduction", "calf_raise", "isolation", "other"]);
const muscles = new Set(["chest", "upper_back", "back", "lats", "shoulders", "biceps", "triceps", "forearms", "quadriceps", "hamstrings", "glutes", "calves", "core", "spinal_erectors", "hip_flexors", "adductors", "abductors", "full_body", "other"]);
const equipment = new Set(["bodyweight", "barbell", "dumbbell", "kettlebell", "cable", "machine", "band", "smith_machine", "trap_bar", "ez_bar", "bench", "pull_up_bar", "rings", "suspension", "medicine_ball", "landmine", "sled", "other"]);
const fact = (value: unknown, known: boolean, evidence: string) => ({ value, source: known ? "catalog" : "migration", confidence: known ? 1 : 0, evidence, taxonomyVersion: TAXONOMY_VERSION });
const normalizedList = (values: unknown, allowed: Set<string>) => Array.isArray(values) ? values.map(String).filter((item) => allowed.has(item)) : [];
const migratedEquipment = (values: unknown) => Array.isArray(values) ? [...new Set(values.map(String).map((item) => equipment.has(item) ? item : "other"))] : [];

function migrateExercise(value: Record<string, unknown>, catalog: Map<string, ExerciseDefinition>) {
  const canonicalKey = String(value.canonicalKey ?? value.exerciseKey ?? "") || null;
  const definition = canonicalKey ? catalog.get(canonicalKey) : undefined;
  const source = definition ? `Catalog ${definition.key}` : "Legacy plan did not contain a trusted classification";
  return {
    id: String(value.id ?? value.exerciseKey ?? crypto.randomUUID()), displayName: String(value.displayName ?? value.name ?? canonicalKey ?? "Migrated exercise"), canonicalKey,
    classification: {
      primaryMovement: fact(definition && movements.has(definition.movement) ? definition.movement : null, Boolean(definition), source),
      primaryMuscles: fact(definition ? normalizedList(definition.primaryMuscles, muscles) : [], Boolean(definition), source),
      secondaryMuscles: fact(definition ? normalizedList(definition.secondaryMuscles, muscles) : [], Boolean(definition), source),
      equipment: fact(definition ? normalizedList(definition.equipment, equipment) : [], Boolean(definition), source),
      impact: fact(null, false, "Legacy plan did not record impact"), laterality: fact(definition ? (definition.unilateral ? "unilateral" : "bilateral") : null, Boolean(definition), source),
    },
    sets: Number(value.sets ?? 1), repsMin: Number(value.repsMin ?? 1), repsMax: Number(value.repsMax ?? value.repsMin ?? 1), targetRpe: value.targetRpe ?? null, restSeconds: Number(value.restSeconds ?? 90), referenceLoad: value.referenceLoad ?? null, referenceLoadUnit: value.referenceLoadUnit ?? null, notes: String(value.notes ?? ""),
  };
}

function migrateTemplate(value: Record<string, unknown>, catalog: Map<string, ExerciseDefinition>) {
  if (Array.isArray(value.components)) return value;
  const id = String(value.id ?? crypto.randomUUID());
  const modality = String(value.modality ?? "unknown");
  const oldExercises = Array.isArray(value.exercises) ? value.exercises as Array<Record<string, unknown>> : [];
  const hasEndurance = value.endurance != null || value.enduranceDetails != null;
  const components: unknown[] = [];
  if (oldExercises.length) components.push({ id: `${id}-strength`, name: "Strength", domain: fact("strength", true, "Migrated from legacy strength exercises"), prescription: { kind: "strength", exercises: oldExercises.map((exercise) => migrateExercise(exercise, catalog)) } });
  if (hasEndurance || modality === "endurance") components.push({ id: `${id}-endurance`, name: "Endurance", domain: fact("endurance", true, hasEndurance ? "Migrated from structured endurance details" : "Migrated from legacy endurance modality"), prescription: { kind: "duration_only", notes: String(value.notes ?? value.intent ?? "") } });
  if (modality === "recovery") components.push({ id: `${id}-recovery`, name: "Recovery", domain: fact("recovery", true, "Migrated from legacy recovery modality"), prescription: { kind: "duration_only", notes: String(value.notes ?? value.intent ?? "") } });
  const needsUnclassified = components.length === 0 || (modality === "mixed" && !hasEndurance && String(value.notes ?? value.intent ?? "").trim().length > 0);
  if (needsUnclassified) components.push({ id: `${id}-unclassified`, name: "Unclassified component", domain: fact(null, false, `Legacy ${modality} content could not be assigned reliably`), prescription: { kind: "duration_only", notes: String(value.notes ?? value.intent ?? "") } });
  return { id, name: String(value.name ?? "Migrated session"), intent: String(value.intent ?? "Migrated training"), durationMinutes: Number(value.durationMinutes ?? 1), recoveryDemand: value.recoveryDemand ?? (value.hard ? "high" : "normal"), notes: String(value.notes ?? ""), components };
}

function localWeekday(startAt: string, timezone: string): number {
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }).format(new Date(startAt));
  return ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(weekday);
}

function localDate(startAt: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(startAt));
}

function legacySessionSignature(session: Record<string, unknown>): string {
  return JSON.stringify({ modality: session.modality ?? null, name: session.name ?? null, durationMinutes: session.durationMinutes ?? null, exercises: session.exercises ?? [], endurance: session.endurance ?? session.enduranceDetails ?? null });
}

function migrateDraft(value: unknown, catalog: Map<string, ExerciseDefinition>, timezone: string): unknown {
  if (!value || typeof value !== "object") return value;
  const draft = structuredClone(value) as Record<string, unknown>;
  if (draft.planSchemaVersion === "3.0") return draft;
  const mesocycle = draft.mesocycle as Record<string, unknown> | null | undefined;
  let reviewRequired = false;
  let sourceSessions: unknown[] = [];
  if (mesocycle) {
    const templates = ((mesocycle.sessionTemplates as Array<Record<string, unknown>> | undefined) ?? []).map((template) => migrateTemplate(template, catalog));
    reviewRequired = templates.some((template) => (template as { components: Array<{ domain: { value: unknown } }> }).components.some((component) => component.domain.value === null));
    mesocycle.weeklyStructure = ((mesocycle.weeklyStructure as Array<Record<string, unknown>> | undefined) ?? []).map((day) => ({ dayOfWeek: day.dayOfWeek, templateIds: Array.isArray(day.templateIds) ? day.templateIds : day.templateId == null ? [] : [day.templateId] })).filter((day) => day.templateIds.length);
    mesocycle.sessionTemplates = templates;
    mesocycle.phases = ((mesocycle.phases as Array<Record<string, unknown>> | undefined) ?? []).map((phase) => ({ ...phase, phaseType: phase.phaseType ?? inferPhaseType(String(phase.name ?? "")) }));
    if (!(mesocycle.weeklyStructure as unknown[]).length) { draft.mesocycle = null; reviewRequired = true; }
  } else if (Array.isArray(draft.sessions) && draft.sessions.length) {
    sourceSessions = structuredClone(draft.sessions);
    const sessions = draft.sessions as Array<Record<string, unknown>>;
    const ordered = [...sessions].sort((left, right) => String(left.startAt).localeCompare(String(right.startAt)));
    const ordinalByDate = new Map<string, number>();
    const templatesBySignature = new Map<string, ReturnType<typeof migrateTemplate>>();
    const templateMeta = new Map<string, { day: number; ordinal: number }>();
    for (const [index, session] of ordered.entries()) {
      const date = localDate(String(session.startAt), timezone);
      const ordinal = ordinalByDate.get(date) ?? 0;
      ordinalByDate.set(date, ordinal + 1);
      const day = localWeekday(String(session.startAt), timezone);
      const signature = `${legacySessionSignature(session)}|${day}|${ordinal}`;
      if (!templatesBySignature.has(signature)) {
        const template = migrateTemplate({ ...session, id: `migrated-${day}-${ordinal}-${index}` }, catalog);
        templatesBySignature.set(signature, template);
        templateMeta.set((template as { id: string }).id, { day, ordinal });
      }
    }
    const templates = [...templatesBySignature.values()];
    const byDay = new Map<number, Array<{ id: string; ordinal: number }>>();
    for (const template of templates) { const id = (template as { id: string }).id; const meta = templateMeta.get(id)!; byDay.set(meta.day, [...(byDay.get(meta.day) ?? []), { id, ordinal: meta.ordinal }]); }
    const dates = ordered.map((session) => localDate(String(session.startAt), timezone)).sort();
    const spanDays = Math.floor((Date.parse(`${dates.at(-1)}T00:00:00Z`) - Date.parse(`${dates[0]}T00:00:00Z`)) / 86_400_000) + 1;
    const durationWeeks = Math.min(52, Math.max(1, Math.ceil(spanDays / 7)));
    draft.mesocycle = { durationWeeks, weeklyStructure: [...byDay].sort(([a], [b]) => a - b).map(([dayOfWeek, entries]) => ({ dayOfWeek, templateIds: entries.sort((a, b) => a.ordinal - b.ordinal).map((entry) => entry.id) })), sessionTemplates: templates, phases: [{ id: "migration-review", phaseType: "foundation", name: "Migration review", startWeek: 1, endWeek: durationWeeks, focus: "Review the schedule inferred from dated legacy sessions", progression: [] }], adjustmentRules: [] };
    reviewRequired = true;
  }
  delete draft.sessions;
  draft.planSchemaVersion = "3.0";
  draft.migration = { reviewRequired, sourceSchema: "legacy", sourceSessions };
  return draft;
}

const emptyCoverage = { hardChecksResolved: 0, hardChecksTotal: 0, movementFactsResolved: 0, movementFactsTotal: 0, muscleFactsResolved: 0, muscleFactsTotal: 0, equipmentFactsResolved: 0, equipmentFactsTotal: 0 };
function migrateValidation(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const validation = structuredClone(value) as Record<string, unknown>;
  if (validation.coverage) return validation;
  validation.results = ((validation.results as Array<Record<string, unknown>> | undefined) ?? []).map((result) => ({ status: result.passed === false ? "fail" : "pass", enforcement: result.severity === "hard" ? "blocker" : result.severity === "soft" ? "advisory" : "info", reasonCode: String(result.reasonCode ?? "LEGACY_RULE"), rulePackId: "legacy", ruleVersion: String(result.ruleVersion ?? "legacy"), subjectRefs: result.sessionIds ?? [], evidence: result.evidence ?? {}, missingFacts: [], confidenceLimit: null }));
  validation.dataGaps = ((validation.dataGaps as unknown[] | undefined) ?? []).map((gap) => ({ code: "LEGACY_DATA_GAP", subjectRef: "plan", factPath: String(gap), requiredByRuleCodes: [], blocking: false, resolution: "agent_infer" }));
  validation.coverage = emptyCoverage;
  return validation;
}

function migratePlannedSession(value: unknown, catalog: Map<string, ExerciseDefinition>): unknown {
  if (!value || typeof value !== "object") return value;
  const session = structuredClone(value) as Record<string, unknown>;
  if (!Array.isArray(session.components)) {
    const template = migrateTemplate(session, catalog) as { components: unknown[] };
    delete session.modality; delete session.exercises;
    session.components = template.components;
  }
  delete session.planVersionId;
  session.planRevision ??= 1;
  session.exerciseOverrides ??= [];
  session.legacySnapshot ??= true;
  return session;
}

export class AthriaRepository {
  readonly sqlite: Database;
  readonly db: ReturnType<typeof drizzle<typeof schema>>;

  constructor(path: string) {
    this.sqlite = new Database(path, { create: true });
    this.sqlite.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    const hasMigrationTable = Boolean(this.sqlite.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'athria_migrations'").get());
    const isCurrentSchema = hasMigrationTable && Boolean(this.sqlite.query("SELECT version FROM athria_migrations WHERE version = 5").get());
    if (!isCurrentSchema) this.sqlite.exec(INITIAL_MIGRATION_SQL);
    this.db = drizzle({ client: this.sqlite, schema });
    try {
      this.migratePlanSchemaV3();
      this.migratePlanSchemaV4();
    } catch (error) {
      this.sqlite.close();
      throw error;
    }
  }

  private migratePlanSchemaV3(): void {
    if (this.sqlite.query("SELECT version FROM athria_migrations WHERE version = 4").get()) return;
    const catalog = new Map(this.sqlite.query("SELECT key, data FROM exercises").all().map((row) => [String((row as { key: unknown }).key), exerciseDefinitionSchema.parse(parseJson((row as { data: unknown }).data))]));
    const profiles = new Map(this.sqlite.query("SELECT owner_id, data FROM profiles").all().map((row) => [String((row as { owner_id: unknown }).owner_id), parseJson((row as { data: unknown }).data) as Record<string, unknown>]));
    this.sqlite.transaction(() => {
      for (const [ownerId, profile] of profiles) {
        const migrated: Record<string, unknown> = { ...profile, strengthConstraints: [
          ...((profile.strengthConstraints as unknown[] | undefined) ?? []),
          ...((profile.excludedExercises as string[] | undefined) ?? []).map((canonicalKey, index) => ({ id: `migrated-exclusion-${index}`, type: "exclude_exercise", canonicalKey })),
        ], constraintNotes: profile.constraintNotes ?? profile.constraints ?? [], equipment: migratedEquipment(profile.equipment ?? []) };
        migrated.trainingDays ??= [];
        delete migrated.excludedExercises; delete migrated.constraints; delete migrated.availability; delete migrated.maxHeartRate;
        this.sqlite.query("UPDATE profiles SET data = ? WHERE owner_id = ?").run(JSON.stringify(athleteProfileSchema.parse(migrated)), ownerId);
      }
      for (const row of this.sqlite.query("SELECT id, owner_id, data, validation FROM plan_drafts").all() as Array<{ id: string; owner_id: string; data: string; validation: string }>) {
        this.sqlite.query("INSERT INTO plan_schema_migration_backups(table_name,row_id,data,validation,migrated_at) VALUES ('plan_drafts',?,?,?,CURRENT_TIMESTAMP)").run(row.id, row.data, row.validation);
        const timezone = String(profiles.get(row.owner_id)?.timezone ?? "UTC");
        const draft = planDraftSchema.parse(migrateDraft(parseJson(row.data), catalog, timezone));
        const validation = planValidationSchema.parse(migrateValidation(parseJson(row.validation)));
        this.sqlite.query("UPDATE plan_drafts SET data = ?, validation = ? WHERE id = ?").run(JSON.stringify(draft), JSON.stringify(validation), row.id);
      }
      for (const row of this.sqlite.query("SELECT id, owner_id, data FROM plan_versions").all() as Array<{ id: string; owner_id: string; data: string }>) {
        this.sqlite.query("INSERT INTO plan_schema_migration_backups(table_name,row_id,data,validation,migrated_at) VALUES ('plan_versions',?,?,NULL,CURRENT_TIMESTAMP)").run(row.id, row.data);
        const version = parseJson(row.data) as Record<string, unknown>;
        version.plan = migrateDraft(version.plan, catalog, String(profiles.get(row.owner_id)?.timezone ?? "UTC")); version.validation = migrateValidation(version.validation);
        this.sqlite.query("UPDATE plan_versions SET data = ? WHERE id = ?").run(JSON.stringify(planVersionSchema.parse(version)), row.id);
      }
      for (const row of this.sqlite.query("SELECT id, data FROM planned_sessions").all() as Array<{ id: string; data: string }>) {
        this.sqlite.query("INSERT INTO plan_schema_migration_backups(table_name,row_id,data,validation,migrated_at) VALUES ('planned_sessions',?,?,NULL,CURRENT_TIMESTAMP)").run(row.id, row.data);
        const session = plannedSessionSchema.parse(migratePlannedSession(parseJson(row.data), catalog));
        this.sqlite.query("UPDATE planned_sessions SET data = ? WHERE id = ?").run(JSON.stringify(session), row.id);
      }
      for (const row of this.sqlite.query("SELECT id, before_data, after_data FROM planned_session_changes").all() as Array<{ id: string; before_data: string; after_data: string }>) {
        this.sqlite.query("INSERT INTO plan_schema_migration_backups(table_name,row_id,data,validation,migrated_at) VALUES ('planned_session_changes',?,?,NULL,CURRENT_TIMESTAMP)").run(row.id, JSON.stringify({ beforeData: row.before_data, afterData: row.after_data }));
        const before = (parseJson(row.before_data) as unknown[]).map((item) => plannedSessionSchema.parse(migratePlannedSession(item, catalog)));
        const after = (parseJson(row.after_data) as unknown[]).map((item) => plannedSessionSchema.parse(migratePlannedSession(item, catalog)));
        this.sqlite.query("UPDATE planned_session_changes SET before_data = ?, after_data = ? WHERE id = ?").run(JSON.stringify(before), JSON.stringify(after), row.id);
      }
      this.sqlite.query("INSERT INTO athria_migrations(version, applied_at) VALUES (4, CURRENT_TIMESTAMP)").run();
    })();
  }

  private migratePlanSchemaV4(): void {
    if (this.sqlite.query("SELECT version FROM athria_migrations WHERE version = 5").get()) return;
    this.sqlite.transaction(() => {
      this.sqlite.exec(`
        CREATE TABLE session_templates (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, data TEXT NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE UNIQUE INDEX templates_owner_id ON session_templates(owner_id, id);
        CREATE TABLE current_mesocycles (owner_id TEXT PRIMARY KEY, data TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL);
      `);
      const profiles = new Map(this.sqlite.query("SELECT owner_id, data FROM profiles").all().map((row) => [String((row as { owner_id: unknown }).owner_id), parseJson((row as { data: unknown }).data) as AthleteProfile]));
      const seen = new Set<string>();
      for (const row of this.sqlite.query("SELECT id, owner_id, data FROM plan_versions ORDER BY owner_id, version_number DESC").all() as Array<{ id: string; owner_id: string; data: string }>) {
        if (seen.has(row.owner_id)) continue;
        seen.add(row.owner_id);
        const version = planVersionSchema.parse(parseJson(row.data));
        if (!version.plan.mesocycle) continue;
        const timestamp = version.approvedAt;
        for (const template of version.plan.mesocycle.sessionTemplates) {
          const stored = storedSessionTemplateSchema.parse({ ...template, ownerId: row.owner_id, revision: 1, createdAt: timestamp, updatedAt: timestamp });
          this.sqlite.query("INSERT OR REPLACE INTO session_templates(id,owner_id,data,revision,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(stored.id, row.owner_id, JSON.stringify(stored), 1, timestamp, timestamp);
        }
        const activation = this.sqlite.query("SELECT effective_start_date FROM plan_activations WHERE plan_version_id = ?").get(row.id) as { effective_start_date: string } | null;
        const profile = profiles.get(row.owner_id);
        const effectiveStartDate = activation?.effective_start_date ?? localDate(new Date().toISOString(), profile?.timezone ?? "UTC");
        const { sessionTemplates: _templates, ...mesocycle } = version.plan.mesocycle;
        const current = currentPlanSchema.parse({ planSchemaVersion: PLAN_SCHEMA_VERSION, ownerId: row.owner_id, title: version.plan.title, summary: version.plan.summary, effectiveStartDate, mesocycle, revision: 1, sourceAgent: version.plan.sourceAgent, model: version.plan.model, skillVersion: version.plan.skillVersion, inputSnapshotHash: version.plan.inputSnapshotHash, updatedAt: timestamp });
        this.sqlite.query("INSERT INTO current_mesocycles(owner_id,data,revision,updated_at) VALUES (?,?,1,?)").run(row.owner_id, JSON.stringify(current), timestamp);
      }
      for (const row of this.sqlite.query("SELECT id, owner_id, data, updated_at FROM plan_drafts ORDER BY owner_id, updated_at DESC").all() as Array<{ id: string; owner_id: string; data: string; updated_at: string }>) {
        if (seen.has(row.owner_id)) continue;
        seen.add(row.owner_id);
        const draft = planDraftSchema.parse(parseJson(row.data));
        if (!draft.mesocycle) continue;
        const timestamp = row.updated_at || draft.updatedAt;
        for (const template of draft.mesocycle.sessionTemplates) {
          const stored = storedSessionTemplateSchema.parse({ ...template, ownerId: row.owner_id, revision: 1, createdAt: timestamp, updatedAt: timestamp });
          this.sqlite.query("INSERT OR REPLACE INTO session_templates(id,owner_id,data,revision,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(stored.id, row.owner_id, JSON.stringify(stored), 1, timestamp, timestamp);
        }
        const profile = profiles.get(row.owner_id);
        const effectiveStartDate = localDate(new Date().toISOString(), profile?.timezone ?? "UTC");
        const { sessionTemplates: _templates, ...mesocycle } = draft.mesocycle;
        const current = currentPlanSchema.parse({ planSchemaVersion: PLAN_SCHEMA_VERSION, ownerId: row.owner_id, title: draft.title, summary: draft.summary, effectiveStartDate, mesocycle, revision: 1, sourceAgent: draft.sourceAgent, model: draft.model, skillVersion: draft.skillVersion, inputSnapshotHash: draft.inputSnapshotHash, updatedAt: timestamp });
        this.sqlite.query("INSERT INTO current_mesocycles(owner_id,data,revision,updated_at) VALUES (?,?,1,?)").run(row.owner_id, JSON.stringify(current), timestamp);
      }
      this.sqlite.exec(`
        CREATE TABLE planned_sessions_v5 (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, plan_version_id TEXT, scheduled_date TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
        CREATE INDEX planned_sessions_owner_date ON planned_sessions_v5(owner_id, scheduled_date);
      `);
      for (const row of this.sqlite.query("SELECT id, owner_id, scheduled_date, status, data FROM planned_sessions").all() as Array<{ id: string; owner_id: string; scheduled_date: string; status: string; data: string }>) {
        const session = plannedSessionSchema.parse(migratePlannedSession(parseJson(row.data), new Map()));
        this.sqlite.query("INSERT INTO planned_sessions_v5 VALUES (?,?,?,?,?,?)").run(row.id, row.owner_id, null, row.scheduled_date, row.status, JSON.stringify(session));
      }
      this.sqlite.exec(`
        DROP TABLE planned_sessions;
        ALTER TABLE planned_sessions_v5 RENAME TO planned_sessions;
        CREATE TABLE planned_session_changes_v5 (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, client_request_id TEXT NOT NULL, plan_version_id TEXT, scheduled_date TEXT NOT NULL, mode TEXT NOT NULL, before_data TEXT NOT NULL, after_data TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE UNIQUE INDEX planned_changes_owner_request_v5 ON planned_session_changes_v5(owner_id, client_request_id);
      `);
      for (const row of this.sqlite.query("SELECT id, owner_id, client_request_id, scheduled_date, mode, before_data, after_data, created_at FROM planned_session_changes").all() as Array<{ id: string; owner_id: string; client_request_id: string; scheduled_date: string; mode: string; before_data: string; after_data: string; created_at: string }>) {
        this.sqlite.query("INSERT INTO planned_session_changes_v5 VALUES (?,?,?,?,?,?,?,?,?)").run(row.id, row.owner_id, row.client_request_id, null, row.scheduled_date, row.mode, row.before_data, row.after_data, row.created_at);
      }
      this.sqlite.exec(`
        DROP TABLE planned_session_changes;
        ALTER TABLE planned_session_changes_v5 RENAME TO planned_session_changes;
        DELETE FROM approvals WHERE subject_type = 'plan_draft';
        DROP TABLE plan_activations;
        DROP TABLE plan_drafts;
        DROP TABLE plan_versions;
        DROP TABLE plan_schema_migration_backups;
        INSERT INTO athria_migrations(version, applied_at) VALUES (5, CURRENT_TIMESTAMP);
      `);
    })();
  }

  close(): void { this.sqlite.close(); }

  getProfile(ownerId = "local-user"): AthleteProfile {
    const row = this.db.select().from(schema.profiles).where(eq(schema.profiles.ownerId, ownerId)).get();
    if (!row) return defaultProfile();
    return athleteProfileSchema.parse(parseJson(row.data));
  }

  saveProfile(profile: AthleteProfile): AthleteProfile {
    const parsed = athleteProfileSchema.parse(profile);
    this.db.insert(schema.profiles).values({ ownerId: parsed.ownerId, data: parsed, updatedAt: new Date().toISOString() }).onConflictDoUpdate({ target: schema.profiles.ownerId, set: { data: parsed, updatedAt: new Date().toISOString() } }).run();
    return parsed;
  }

  getPreference(ownerId = "local-user"): TrainingPreference {
    const row = this.db.select().from(schema.preferences).where(eq(schema.preferences.ownerId, ownerId)).get();
    return row ? trainingPreferenceSchema.parse(parseJson(row.data)) : defaultPreference();
  }

  savePreference(preference: TrainingPreference): TrainingPreference {
    const parsed = trainingPreferenceSchema.parse(preference);
    this.db.insert(schema.preferences).values({ ownerId: parsed.ownerId, data: parsed, updatedAt: new Date().toISOString() }).onConflictDoUpdate({ target: schema.preferences.ownerId, set: { data: parsed, updatedAt: new Date().toISOString() } }).run();
    return parsed;
  }

  listExercises(): ExerciseDefinition[] {
    return this.db.select().from(schema.exercises).all().map((row) => exerciseDefinitionSchema.parse(parseJson(row.data)));
  }

  seedExercises(exercises: ExerciseDefinition[]): void {
    this.sqlite.transaction(() => {
      for (const exercise of exercises) this.db.insert(schema.exercises).values({ key: exercise.key, data: exercise }).onConflictDoUpdate({ target: schema.exercises.key, set: { data: exercise } }).run();
    })();
  }

  listSessions(ownerId = "local-user", since?: string): TrainingSession[] {
    const condition = since ? and(eq(schema.trainingSessions.ownerId, ownerId), gte(schema.trainingSessions.startAt, since)) : eq(schema.trainingSessions.ownerId, ownerId);
    return this.db.select().from(schema.trainingSessions).where(condition).orderBy(desc(schema.trainingSessions.startAt)).all().map((row) => trainingSessionSchema.parse(parseJson(row.data)));
  }

  listSessionsBySource(source: string, ownerId = "local-user", since?: string): TrainingSession[] {
    const condition = since
      ? and(eq(schema.trainingSessions.ownerId, ownerId), eq(schema.trainingSessions.source, source), gte(schema.trainingSessions.startAt, since))
      : and(eq(schema.trainingSessions.ownerId, ownerId), eq(schema.trainingSessions.source, source));
    return this.db.select().from(schema.trainingSessions).where(condition).orderBy(desc(schema.trainingSessions.startAt)).all().map((row) => trainingSessionSchema.parse(parseJson(row.data)));
  }

  upsertSessions(sessions: TrainingSession[]): { added: number; updated: number } {
    const counts = { added: 0, updated: 0 };
    this.sqlite.transaction(() => {
      for (const value of sessions.map((item) => trainingSessionSchema.parse(item))) {
        const existing = this.db.select({ id: schema.trainingSessions.id }).from(schema.trainingSessions).where(and(eq(schema.trainingSessions.ownerId, value.ownerId), eq(schema.trainingSessions.source, value.source), eq(schema.trainingSessions.externalId, value.externalId))).get();
        if (existing) counts.updated += 1; else counts.added += 1;
        this.db.insert(schema.trainingSessions).values({ id: value.id, ownerId: value.ownerId, source: value.source, externalId: value.externalId, modality: value.modality, startAt: value.startAt, data: value }).onConflictDoUpdate({ target: [schema.trainingSessions.ownerId, schema.trainingSessions.source, schema.trainingSessions.externalId], set: { modality: value.modality, startAt: value.startAt, data: value } }).run();
      }
    })();
    return counts;
  }

  recordImportBatch(input: { ownerId: string; source: string; contentHash: string; fileName: string; parserVersion: string; status: string; data: unknown }) {
    const existing = this.db.select().from(schema.importBatches).where(and(eq(schema.importBatches.ownerId, input.ownerId), eq(schema.importBatches.source, input.source), eq(schema.importBatches.contentHash, input.contentHash))).get();
    if (existing) return existing;
    const row = { id: crypto.randomUUID(), ...input, createdAt: new Date().toISOString() };
    this.db.insert(schema.importBatches).values(row).run();
    return row;
  }

  latestImportBatch(ownerId = "local-user", source = "hevy") {
    return this.db.select().from(schema.importBatches).where(and(eq(schema.importBatches.ownerId, ownerId), eq(schema.importBatches.source, source))).orderBy(desc(schema.importBatches.createdAt)).get() ?? null;
  }

  upsertRawRecords(ownerId: string, source: string, records: unknown[]): number {
    let stored = 0;
    this.sqlite.transaction(() => {
      records.forEach((payload) => {
        const hash = contentHash(payload);
        const externalKey = typeof payload === "object" && payload !== null
          ? String((payload as Record<string, unknown>).id ?? (payload as Record<string, unknown>).localid ?? (payload as Record<string, unknown>).external_id ?? (payload as Record<string, unknown>).workout_id ?? (payload as Record<string, unknown>).set_id ?? hash)
          : hash;
        this.db.insert(schema.rawRecords).values({ id: crypto.randomUUID(), ownerId, source, externalKey, contentHash: hash, payload }).onConflictDoUpdate({ target: [schema.rawRecords.ownerId, schema.rawRecords.source, schema.rawRecords.externalKey], set: { contentHash: hash, payload } }).run();
        stored += 1;
      });
    })();
    return stored;
  }

  getConnectionSyncState(source: string, ownerId = "local-user") {
    const row = this.db.select().from(schema.connectionSyncState).where(and(eq(schema.connectionSyncState.ownerId, ownerId), eq(schema.connectionSyncState.source, source))).get();
    return row ? { ...row, data: parseJson(row.data) as Record<string, unknown> } : null;
  }

  saveConnectionSyncState(input: { ownerId?: string; source: string; lastAttemptAt: string; lastSuccessAt: string | null; rangeStart: string; rangeEnd: string; status: "success" | "partial" | "failed"; data: Record<string, unknown> }) {
    const value = { ownerId: input.ownerId ?? "local-user", ...input };
    this.db.insert(schema.connectionSyncState).values(value).onConflictDoUpdate({
      target: [schema.connectionSyncState.ownerId, schema.connectionSyncState.source],
      set: { lastAttemptAt: value.lastAttemptAt, lastSuccessAt: value.lastSuccessAt, rangeStart: value.rangeStart, rangeEnd: value.rangeEnd, status: value.status, data: value.data },
    }).run();
    return this.getConnectionSyncState(value.source, value.ownerId)!;
  }

  upsertWellness(ownerId: string, records: unknown[]): number {
    let stored = 0;
    this.sqlite.transaction(() => {
      for (const payload of records) {
        if (typeof payload !== "object" || payload === null) continue;
        const value = payload as Record<string, unknown>;
        const day = String(value.id ?? value.day ?? value.date ?? "").slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
        this.db.insert(schema.wellnessDaily).values({ ownerId, day, data: value }).onConflictDoUpdate({ target: [schema.wellnessDaily.ownerId, schema.wellnessDaily.day], set: { data: value } }).run();
        stored += 1;
      }
    })();
    return stored;
  }

  listTemplates(ownerId = "local-user"): StoredSessionTemplate[] {
    return this.db.select().from(schema.sessionTemplates).where(eq(schema.sessionTemplates.ownerId, ownerId)).orderBy(desc(schema.sessionTemplates.updatedAt)).all().map((row) => storedSessionTemplateSchema.parse(parseJson(row.data)));
  }

  getTemplate(id: string, ownerId = "local-user"): StoredSessionTemplate | null {
    const row = this.db.select().from(schema.sessionTemplates).where(and(eq(schema.sessionTemplates.id, id), eq(schema.sessionTemplates.ownerId, ownerId))).get();
    return row ? storedSessionTemplateSchema.parse(parseJson(row.data)) : null;
  }

  createTemplate(template: SessionTemplate, ownerId = "local-user"): StoredSessionTemplate {
    if (this.getTemplate(template.id, ownerId)) throw new Error("TEMPLATE_ALREADY_EXISTS");
    const now = new Date().toISOString();
    const stored = storedSessionTemplateSchema.parse({ ...sessionTemplateSchema.parse(template), ownerId, revision: 1, createdAt: now, updatedAt: now });
    this.db.insert(schema.sessionTemplates).values({ id: stored.id, ownerId, data: stored, revision: stored.revision, createdAt: now, updatedAt: now }).run();
    return stored;
  }

  updateTemplate(template: SessionTemplate, expectedRevision: number, ownerId = "local-user", sessions: PlannedSession[] = []): StoredSessionTemplate {
    return this.sqlite.transaction(() => {
      const current = this.getTemplate(template.id, ownerId);
      if (!current) throw new Error("TEMPLATE_NOT_FOUND");
      if (current.revision !== expectedRevision) throw new Error("REVISION_CONFLICT");
      const now = new Date().toISOString();
      const stored = storedSessionTemplateSchema.parse({ ...sessionTemplateSchema.parse(template), ownerId, revision: current.revision + 1, createdAt: current.createdAt, updatedAt: now });
      this.db.update(schema.sessionTemplates).set({ data: stored, revision: stored.revision, updatedAt: now }).where(and(eq(schema.sessionTemplates.id, stored.id), eq(schema.sessionTemplates.ownerId, ownerId))).run();
      for (const session of sessions) this.db.update(schema.plannedSessions).set({ data: session, status: session.status }).where(and(eq(schema.plannedSessions.id, session.id), eq(schema.plannedSessions.ownerId, ownerId))).run();
      return stored;
    })();
  }

  deleteTemplate(id: string, expectedRevision: number, ownerId = "local-user"): void {
    const current = this.getTemplate(id, ownerId);
    if (!current) throw new Error("TEMPLATE_NOT_FOUND");
    if (current.revision !== expectedRevision) throw new Error("REVISION_CONFLICT");
    this.db.delete(schema.sessionTemplates).where(and(eq(schema.sessionTemplates.id, id), eq(schema.sessionTemplates.ownerId, ownerId))).run();
  }

  getCurrentPlan(ownerId = "local-user"): CurrentPlan | null {
    const row = this.db.select().from(schema.currentMesocycles).where(eq(schema.currentMesocycles.ownerId, ownerId)).get();
    return row ? currentPlanSchema.parse(parseJson(row.data)) : null;
  }

  saveCurrentPlan(plan: CurrentPlan, expectedRevision: number, deletedSessionIds: string[] = [], updatedSessions: PlannedSession[] = []): CurrentPlan {
    return this.sqlite.transaction(() => {
      if ((this.getCurrentPlan(plan.ownerId)?.revision ?? 0) !== expectedRevision) throw new Error("REVISION_CONFLICT");
      this.db.insert(schema.currentMesocycles).values({ ownerId: plan.ownerId, data: plan, revision: plan.revision, updatedAt: plan.updatedAt }).onConflictDoUpdate({ target: schema.currentMesocycles.ownerId, set: { data: plan, revision: plan.revision, updatedAt: plan.updatedAt } }).run();
      for (const id of deletedSessionIds) this.db.delete(schema.plannedSessions).where(and(eq(schema.plannedSessions.id, id), eq(schema.plannedSessions.ownerId, plan.ownerId))).run();
      for (const session of updatedSessions) this.db.update(schema.plannedSessions).set({ data: session, status: session.status }).where(and(eq(schema.plannedSessions.id, session.id), eq(schema.plannedSessions.ownerId, plan.ownerId))).run();
      return plan;
    })();
  }

  listCurrentPlannedSessions(ownerId = "local-user", scheduledDate?: string): PlannedSession[] {
    const condition = scheduledDate ? and(eq(schema.plannedSessions.ownerId, ownerId), eq(schema.plannedSessions.scheduledDate, scheduledDate)) : eq(schema.plannedSessions.ownerId, ownerId);
    return this.db.select().from(schema.plannedSessions).where(condition).orderBy(schema.plannedSessions.scheduledDate).all().map((row) => plannedSessionSchema.parse(parseJson(row.data)));
  }

  scheduleRevision(ownerId = "local-user"): number { return Number((this.sqlite.query("SELECT COUNT(*) AS count FROM planned_session_changes WHERE owner_id = ?").get(ownerId) as { count: number }).count); }

  saveCurrentPlannedSessions(input: { ownerId: string; clientRequestId: string; scheduledDate: string; expectedRevision: number; mode: "append" | "replace"; sessions: PlannedSession[] }) {
    return this.sqlite.transaction(() => {
      const prior = this.db.select().from(schema.plannedSessionChanges).where(and(eq(schema.plannedSessionChanges.ownerId, input.ownerId), eq(schema.plannedSessionChanges.clientRequestId, input.clientRequestId))).get();
      if (prior) return { sessions: (parseJson(prior.afterData) as unknown[]).map((item) => plannedSessionSchema.parse(item)), revision: this.scheduleRevision(input.ownerId), idempotentReplay: true };
      const revision = this.scheduleRevision(input.ownerId);
      if (revision !== input.expectedRevision) throw new Error("PLANNED_SESSION_REVISION_CONFLICT");
      const before = this.listCurrentPlannedSessions(input.ownerId, input.scheduledDate);
      if (input.mode === "replace" && before.some((item) => item.status !== "planned")) throw new Error("COMPLETED_SESSION_CANNOT_BE_REPLACED");
      if (input.mode === "replace") this.db.delete(schema.plannedSessions).where(and(eq(schema.plannedSessions.ownerId, input.ownerId), eq(schema.plannedSessions.scheduledDate, input.scheduledDate))).run();
      for (const session of input.sessions) this.db.insert(schema.plannedSessions).values({ id: session.id, ownerId: session.ownerId, planVersionId: null, scheduledDate: session.scheduledDate, status: session.status, data: session }).run();
      const after = this.listCurrentPlannedSessions(input.ownerId, input.scheduledDate);
      this.db.insert(schema.plannedSessionChanges).values({ id: crypto.randomUUID(), ownerId: input.ownerId, clientRequestId: input.clientRequestId, planVersionId: null, scheduledDate: input.scheduledDate, mode: input.mode, beforeData: before, afterData: after, createdAt: new Date().toISOString() }).run();
      return { sessions: after, revision: revision + 1, idempotentReplay: false };
    })();
  }

  saveDraft(draft: PlanDraft, validation: PlanValidation): { draft: PlanDraft; validation: PlanValidation } {
    const parsedDraft = planDraftSchema.parse(draft);
    const parsedValidation = planValidationSchema.parse(validation);
    return this.sqlite.transaction(() => {
      const existing = this.db.select().from(schema.planDrafts).where(and(eq(schema.planDrafts.ownerId, parsedDraft.ownerId), eq(schema.planDrafts.clientRequestId, parsedDraft.clientRequestId))).get();
      if (existing) return { draft: planDraftSchema.parse(parseJson(existing.data)), validation: planValidationSchema.parse(parseJson(existing.validation)) };
      this.db.insert(schema.planDrafts).values({ id: parsedDraft.id, ownerId: parsedDraft.ownerId, clientRequestId: parsedDraft.clientRequestId, data: parsedDraft, validation: parsedValidation, updatedAt: parsedDraft.updatedAt }).run();
      this.prunePendingDrafts(parsedDraft.ownerId, parsedDraft.id);
      return { draft: parsedDraft, validation: parsedValidation };
    })();
  }

  private prunePendingDrafts(ownerId: string, keepDraftId: string): void {
    const approved = this.db.select({ subjectId: schema.approvals.subjectId }).from(schema.approvals).where(and(eq(schema.approvals.ownerId, ownerId), eq(schema.approvals.subjectType, "plan_draft"))).all().map((row) => row.subjectId);
    this.db.delete(schema.planDrafts).where(and(eq(schema.planDrafts.ownerId, ownerId), notInArray(schema.planDrafts.id, [...approved, keepDraftId]))).run();
  }

  getDraft(id: string, ownerId = "local-user"): { draft: PlanDraft; validation: PlanValidation } | null {
    const row = this.db.select().from(schema.planDrafts).where(and(eq(schema.planDrafts.id, id), eq(schema.planDrafts.ownerId, ownerId))).get();
    return row ? { draft: planDraftSchema.parse(parseJson(row.data)), validation: planValidationSchema.parse(parseJson(row.validation)) } : null;
  }

  listDrafts(ownerId = "local-user"): Array<{ draft: PlanDraft; validation: PlanValidation }> {
    return this.db.select().from(schema.planDrafts).where(eq(schema.planDrafts.ownerId, ownerId)).orderBy(desc(schema.planDrafts.updatedAt)).all().map((row) => ({ draft: planDraftSchema.parse(parseJson(row.data)), validation: planValidationSchema.parse(parseJson(row.validation)) }));
  }

  listVersions(ownerId = "local-user"): PlanVersion[] {
    return this.db.select().from(schema.planVersions).where(eq(schema.planVersions.ownerId, ownerId)).orderBy(desc(schema.planVersions.versionNumber)).all().map((row) => {
      const value = parseJson(row.data) as Record<string, unknown>;
      return planVersionSchema.parse(value);
    });
  }

  getPlanActivation(planVersionId: string, ownerId = "local-user") {
    return this.db.select().from(schema.planActivations).where(and(eq(schema.planActivations.planVersionId, planVersionId), eq(schema.planActivations.ownerId, ownerId))).get() ?? null;
  }

  listPlannedSessions(planVersionId: string, ownerId = "local-user", scheduledDate?: string): PlannedSession[] {
    const condition = scheduledDate
      ? and(eq(schema.plannedSessions.ownerId, ownerId), eq(schema.plannedSessions.planVersionId, planVersionId), eq(schema.plannedSessions.scheduledDate, scheduledDate))
      : and(eq(schema.plannedSessions.ownerId, ownerId), eq(schema.plannedSessions.planVersionId, planVersionId));
    return this.db.select().from(schema.plannedSessions).where(condition).orderBy(schema.plannedSessions.scheduledDate).all().map((row) => plannedSessionSchema.parse(parseJson(row.data)));
  }

  replayPlannedSessions(input: { ownerId: string; clientRequestId: string; planVersionId: string; expectedRevision: number }) {
    const priorChange = this.db.select().from(schema.plannedSessionChanges).where(and(eq(schema.plannedSessionChanges.ownerId, input.ownerId), eq(schema.plannedSessionChanges.clientRequestId, input.clientRequestId))).get();
    if (!priorChange) return null;
    return { sessions: (parseJson(priorChange.afterData) as unknown[]).map((item) => plannedSessionSchema.parse(item)), revision: this.getPlanActivation(input.planVersionId, input.ownerId)?.revision ?? input.expectedRevision, idempotentReplay: true };
  }

  savePlannedSessions(input: { ownerId: string; clientRequestId: string; planVersionId: string; scheduledDate: string; expectedRevision: number; mode: "append" | "replace"; effectiveStartDate: string; sessions: PlannedSession[] }) {
    return this.sqlite.transaction(() => {
      const replay = this.replayPlannedSessions(input);
      if (replay) return replay;
      const activation = this.getPlanActivation(input.planVersionId, input.ownerId);
      const revision = activation?.revision ?? 0;
      if (revision !== input.expectedRevision) throw new Error("PLANNED_SESSION_REVISION_CONFLICT");
      const before = this.listPlannedSessions(input.planVersionId, input.ownerId, input.scheduledDate);
      if (input.mode === "replace" && before.some((item) => item.status !== "planned")) throw new Error("COMPLETED_SESSION_CANNOT_BE_REPLACED");
      if (input.mode === "replace") this.db.delete(schema.plannedSessions).where(and(eq(schema.plannedSessions.ownerId, input.ownerId), eq(schema.plannedSessions.planVersionId, input.planVersionId), eq(schema.plannedSessions.scheduledDate, input.scheduledDate))).run();
      for (const session of input.sessions) this.db.insert(schema.plannedSessions).values({ id: session.id, ownerId: session.ownerId, planVersionId: input.planVersionId, scheduledDate: session.scheduledDate, status: session.status, data: session }).run();
      const after = this.listPlannedSessions(input.planVersionId, input.ownerId, input.scheduledDate);
      const nextRevision = revision + 1;
      this.db.insert(schema.planActivations).values({ planVersionId: input.planVersionId, ownerId: input.ownerId, effectiveStartDate: activation?.effectiveStartDate ?? input.effectiveStartDate, revision: nextRevision }).onConflictDoUpdate({ target: schema.planActivations.planVersionId, set: { revision: nextRevision } }).run();
      this.db.insert(schema.plannedSessionChanges).values({ id: crypto.randomUUID(), ownerId: input.ownerId, clientRequestId: input.clientRequestId, planVersionId: input.planVersionId, scheduledDate: input.scheduledDate, mode: input.mode, beforeData: before, afterData: after, createdAt: new Date().toISOString() }).run();
      return { sessions: after, revision: nextRevision, idempotentReplay: false };
    })();
  }

  completePlannedSession(plannedSessionId: string, trainingSessionId: string, ownerId = "local-user"): PlannedSession | null {
    return this.sqlite.transaction(() => {
      const row = this.db.select().from(schema.plannedSessions).where(and(eq(schema.plannedSessions.id, plannedSessionId), eq(schema.plannedSessions.ownerId, ownerId))).get();
      if (!row) return null;
      const current = plannedSessionSchema.parse(parseJson(row.data));
      if (current.status !== "planned") return current;
      const updated = plannedSessionSchema.parse({ ...current, status: "completed", completedTrainingSessionId: trainingSessionId, updatedAt: new Date().toISOString() });
      this.db.update(schema.plannedSessions).set({ status: updated.status, data: updated }).where(eq(schema.plannedSessions.id, plannedSessionId)).run();
      return updated;
    })();
  }

  hasApproval(ownerId: string, subjectType: string, subjectId: string): boolean {
    return Boolean(this.db.select({ id: schema.approvals.id }).from(schema.approvals).where(and(eq(schema.approvals.ownerId, ownerId), eq(schema.approvals.subjectType, subjectType), eq(schema.approvals.subjectId, subjectId))).get());
  }

  createApprovedVersion(input: { draft: PlanDraft; validation: PlanValidation; approvedBy: string; changeReason: string }): PlanVersion {
    return this.sqlite.transaction(() => {
      const previous = this.db.select().from(schema.planVersions).where(eq(schema.planVersions.ownerId, input.draft.ownerId)).orderBy(desc(schema.planVersions.versionNumber)).get();
      const approvedAt = new Date().toISOString();
      const version: PlanVersion = planVersionSchema.parse({ id: crypto.randomUUID(), parentVersionId: previous?.id ?? null, versionNumber: (previous?.versionNumber ?? 0) + 1, plan: input.draft, validation: input.validation, approvedAt, approvedBy: input.approvedBy, changeReason: input.changeReason });
      this.db.insert(schema.approvals).values({ id: crypto.randomUUID(), ownerId: input.draft.ownerId, subjectType: "plan_draft", subjectId: input.draft.id, approvedBy: input.approvedBy, approvedAt, snapshotHash: input.validation.inputHash }).run();
      this.db.insert(schema.planVersions).values({ id: version.id, ownerId: input.draft.ownerId, parentVersionId: version.parentVersionId, versionNumber: version.versionNumber, data: version, createdAt: approvedAt }).run();
      return version;
    })();
  }

  saveProfileUpdateProposal(input: { id: string; ownerId: string; clientRequestId: string; patch: Record<string, unknown>; rationale: string; baseSnapshotHash: string; createdAt: string }) {
    const existing = this.db.select().from(schema.profileUpdateProposals).where(and(eq(schema.profileUpdateProposals.ownerId, input.ownerId), eq(schema.profileUpdateProposals.clientRequestId, input.clientRequestId))).get();
    if (existing) return { ...existing, patch: parseJson(existing.patch) };
    this.db.insert(schema.profileUpdateProposals).values({ ...input, status: "pending" }).run();
    return { ...input, status: "pending" };
  }

  listProfileUpdateProposals(ownerId = "local-user") {
    return this.db.select().from(schema.profileUpdateProposals).where(eq(schema.profileUpdateProposals.ownerId, ownerId)).orderBy(desc(schema.profileUpdateProposals.createdAt)).all().map((row) => ({ ...row, patch: parseJson(row.patch) as Record<string, unknown> }));
  }

  approveProfileUpdate(input: { proposalId: string; ownerId: string; profile: AthleteProfile; approvedBy: string; snapshotHash: string }): AthleteProfile {
    return this.sqlite.transaction(() => {
      const proposal = this.db.select().from(schema.profileUpdateProposals).where(and(eq(schema.profileUpdateProposals.id, input.proposalId), eq(schema.profileUpdateProposals.ownerId, input.ownerId))).get();
      if (!proposal || proposal.status !== "pending") throw new Error("PROFILE_PROPOSAL_NOT_PENDING");
      const approvedAt = new Date().toISOString();
      this.db.insert(schema.profiles).values({ ownerId: input.ownerId, data: input.profile, updatedAt: approvedAt }).onConflictDoUpdate({ target: schema.profiles.ownerId, set: { data: input.profile, updatedAt: approvedAt } }).run();
      this.db.update(schema.profileUpdateProposals).set({ status: "approved" }).where(eq(schema.profileUpdateProposals.id, input.proposalId)).run();
      this.db.insert(schema.approvals).values({ id: crypto.randomUUID(), ownerId: input.ownerId, subjectType: "profile_update", subjectId: input.proposalId, approvedBy: input.approvedBy, approvedAt, snapshotHash: input.snapshotHash }).run();
      return input.profile;
    })();
  }

  counts(): Record<string, number> {
    const names = ["profiles", "preferences", "exercises", "training_sessions", "wellness_daily", "import_batches", "raw_records", "connection_sync_state", "session_templates", "current_mesocycles", "approvals", "planned_sessions", "planned_session_changes"];
    return Object.fromEntries(names.map((name) => [name, Number((this.sqlite.query(`SELECT COUNT(*) AS count FROM ${name}`).get() as { count: number }).count)]));
  }

  checkpoint(): void { this.sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)"); }
}

export { schema };
